-- ═══════════════════════════════════════════════════════════════════════
-- Security audit critical fixes — 2026-05-12 audit-rapport
-- ═══════════════════════════════════════════════════════════════════════
--
-- Adresseert 4 CRITICAL + 2 HIGH items uit security-audit:
--
--  C1: anon_create_partner_application accepteerde status='contract_signed'
--      met fake handtekening → forceer 'lead', strip alle signing-velden
--  C2: signing_ip/user_agent in 3 RPC's was client-controlled → server-side
--      capture via current_setting('request.headers')
--  C3: off-by-one in public_record_remote_signing token-max-uses
--      ( > moet >= zijn, conform public_consume_signing_token)
--  H4: NDA-versie ongevalideerd → whitelist alleen erkende versies
--  H2: test-noop-deploy edge function obsoleet (verwijder via dashboard)
--      [N.B. edge function delete kan niet via SQL, manuele cleanup]
--  M2: REVOKE EXECUTE FROM anon op admin_* RPC's (defense-in-depth, niet
--      direct uitbuitbaar want auth.uid()-check is al aanwezig in body)

-- ─────────────────────────────────────────────────────────────────────
-- 1. Helper: server-side capture van client IP + User-Agent
-- ─────────────────────────────────────────────────────────────────────
--
-- Returnt JSONB met geldige IP (priority: cf-connecting-ip → x-forwarded-for
-- first hop → x-real-ip → NULL) en truncated user-agent (max 500 chars).
-- Bij parse-failure of ontbrekende headers: NULL-velden.
-- Single source of truth voor signing-audit-trail: vervangt client-input.

CREATE OR REPLACE FUNCTION public._request_client_meta()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  BEGIN
    v_headers := current_setting('request.headers', true)::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ip', NULL, 'user_agent', NULL);
  END;

  IF v_headers IS NULL THEN
    RETURN jsonb_build_object('ip', NULL, 'user_agent', NULL);
  END IF;

  -- Priority order voor IP
  v_ip := v_headers ->> 'cf-connecting-ip';
  IF v_ip IS NULL OR v_ip = '' THEN
    v_ip := split_part(COALESCE(v_headers ->> 'x-forwarded-for', ''), ',', 1);
    v_ip := NULLIF(TRIM(v_ip), '');
  END IF;
  IF v_ip IS NULL THEN
    v_ip := NULLIF(v_headers ->> 'x-real-ip', '');
  END IF;

  -- User-agent truncated
  v_ua := LEFT(COALESCE(v_headers ->> 'user-agent', ''), 500);
  IF v_ua = '' THEN v_ua := NULL; END IF;

  RETURN jsonb_build_object('ip', v_ip, 'user_agent', v_ua);
END;
$$;

REVOKE EXECUTE ON FUNCTION public._request_client_meta() FROM anon, authenticated, PUBLIC;

COMMENT ON FUNCTION public._request_client_meta() IS
  'Server-side capture van client IP + User-Agent uit PostgREST request.headers. Returnt jsonb({ip, user_agent}). Voor gebruik in signing-RPC''s zodat audit-trail niet vervalsbaar is.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. SEC-C1: anon_create_partner_application — forceer lead-only flow
-- ─────────────────────────────────────────────────────────────────────
--
-- Wijzigingen vs vorige versie:
--  - status wordt ALTIJD 'lead' (negeer payload-status, signing gaat via
--    public_record_remote_signing flow met token)
--  - contract_signed_at, contract_handtekening_base64, contract_pdf_url
--    worden gestript uit payload (kunnen niet meer via deze RPC gezet)
--  - signing_ip + signing_user_agent worden niet meer geaccepteerd
--    (server-side capture in _request_client_meta enkel voor rate-limit-tracking,
--    NIET als signing-audit)

CREATE OR REPLACE FUNCTION public.anon_create_partner_application(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_meta JSONB;
  v_ip INET;
  v_window TIMESTAMPTZ;
  v_count INT;
  v_id UUID;
  v_btw TEXT;
  v_sectoren JSONB;
  v_marge INT;
  v_lang TEXT;
BEGIN
  -- Server-side IP-capture voor rate-limit (niet voor signing-audit)
  v_meta := public._request_client_meta();
  BEGIN
    v_ip := (v_meta ->> 'ip')::INET;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;

  -- Rate-limit: 5 calls/uur per IP
  IF v_ip IS NOT NULL THEN
    v_window := date_trunc('hour', now());
    SELECT COALESCE(count, 0) INTO v_count
      FROM partner_application_rate
      WHERE ip = v_ip AND window_start = v_window;
    IF v_count >= 5 THEN
      RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO partner_application_rate(ip, window_start, count)
      VALUES (v_ip, v_window, 1)
      ON CONFLICT (ip, window_start) DO UPDATE SET count = partner_application_rate.count + 1;
  END IF;

  -- Payload-validatie
  v_btw := payload ->> 'btw_nummer';
  v_sectoren := payload -> 'sectoren';
  v_marge := (payload ->> 'marge_pct')::INT;
  v_lang := COALESCE(payload ->> 'lang', 'nl');

  -- Marge-validatie: 10-15% (commercieel beleid)
  IF v_marge IS NULL OR v_marge < 10 OR v_marge > 15 THEN
    RAISE EXCEPTION 'invalid_marge_pct' USING ERRCODE = 'P0001';
  END IF;

  IF v_sectoren IS NULL OR jsonb_array_length(v_sectoren) = 0 THEN
    RAISE EXCEPTION 'sectors_required' USING ERRCODE = 'P0001';
  END IF;

  -- INSERT met hardgecodeerde lead-status; signing-velden zijn niet meer
  -- bereikbaar via deze RPC (signing flow loopt via public_record_remote_signing).
  INSERT INTO partner_applications(
    status, bedrijfsnaam, btw_nummer, btw_validated_payload,
    contactpersoon_voornaam, contactpersoon_naam, contactpersoon_email, contactpersoon_telefoon,
    website, adres, postcode, gemeente,
    sectoren, marge_pct,
    lang
  ) VALUES (
    'lead',  -- HARD-CODED, ignore payload.status
    payload ->> 'bedrijfsnaam',
    v_btw,
    payload -> 'btw_validated_payload',
    payload ->> 'contactpersoon_voornaam',
    payload ->> 'contactpersoon_naam',
    payload ->> 'contactpersoon_email',
    payload ->> 'contactpersoon_telefoon',
    payload ->> 'website',
    payload ->> 'adres',
    payload ->> 'postcode',
    payload ->> 'gemeente',
    v_sectoren,
    v_marge,
    v_lang
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

COMMENT ON FUNCTION public.anon_create_partner_application(jsonb) IS
  'Publieke /onboard/ lead-creatie. Status is hard-coded ''lead''. Signing-velden (contract_signed_at, handtekening, pdf_url, signing_ip/ua) zijn NIET meer via deze RPC zetbaar — signing loopt exclusief via public_record_remote_signing met token-auth.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. SEC-C2+C3: public_record_remote_signing — server-side IP/UA + fix off-by-one
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.public_record_remote_signing(
  p_token text,
  p_handtekening_base64 text,
  p_bedrijfsnaam text DEFAULT NULL::text,
  p_btw_nummer text DEFAULT NULL::text,
  p_adres text DEFAULT NULL::text,
  p_postcode text DEFAULT NULL::text,
  p_gemeente text DEFAULT NULL::text,
  p_contactpersoon_voornaam text DEFAULT NULL::text,
  p_contactpersoon_naam text DEFAULT NULL::text,
  p_contactpersoon_telefoon text DEFAULT NULL::text,
  p_website text DEFAULT NULL::text,
  p_marge_pct integer DEFAULT NULL::integer,
  p_sectoren jsonb DEFAULT NULL::jsonb,
  p_ip text DEFAULT NULL::text,        -- DEPRECATED, behouden voor backward compat (genegeerd)
  p_user_agent text DEFAULT NULL::text, -- DEPRECATED, behouden voor backward compat (genegeerd)
  p_communicatie_email text DEFAULT NULL::text,
  p_communicatie_telefoon text DEFAULT NULL::text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_app_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_used_count INT;
  v_max_uses INT;
  v_nda_ack_ts TIMESTAMPTZ;
  v_signed_at TIMESTAMPTZ;
  v_existing_bedrijfsnaam TEXT;
  v_existing_email TEXT;
  v_existing_sectoren JSONB;
  v_existing_marge_pct INT;
  v_new_bedrijfsnaam TEXT;
  v_final_sectoren JSONB;
  v_final_marge_pct INT;
  v_meta JSONB;
  v_server_ip INET;
  v_server_ua TEXT;
BEGIN
  -- Input-validatie
  IF p_token IS NULL OR length(p_token) < 30 THEN
    RAISE EXCEPTION 'invalid_token';
  END IF;
  IF p_handtekening_base64 IS NULL OR length(p_handtekening_base64) < 100 THEN
    RAISE EXCEPTION 'invalid_signature';
  END IF;
  IF p_marge_pct IS NOT NULL THEN
    IF p_marge_pct < 10 OR p_marge_pct > 15 THEN
      RAISE EXCEPTION 'invalid_marge_pct';
    END IF;
  END IF;
  IF p_sectoren IS NOT NULL THEN
    IF jsonb_typeof(p_sectoren) <> 'array' OR jsonb_array_length(p_sectoren) = 0 THEN
      RAISE EXCEPTION 'sectoren_required';
    END IF;
  END IF;

  -- Server-side capture IP + UA — vervangt p_ip/p_user_agent client-input
  v_meta := public._request_client_meta();
  BEGIN
    v_server_ip := NULLIF(v_meta ->> 'ip', '')::INET;
  EXCEPTION WHEN OTHERS THEN
    v_server_ip := NULL;
  END;
  v_server_ua := v_meta ->> 'user_agent';

  SELECT id, signing_token_expires_at, signing_token_used_count, signing_token_max_uses,
         confidentiality_ack_ts, contract_signed_at, bedrijfsnaam, contactpersoon_email,
         sectoren, marge_pct
    INTO v_app_id, v_expires_at, v_used_count, v_max_uses,
         v_nda_ack_ts, v_signed_at, v_existing_bedrijfsnaam, v_existing_email,
         v_existing_sectoren, v_existing_marge_pct
  FROM public.partner_applications
  WHERE signing_token = p_token
  LIMIT 1;

  IF v_app_id IS NULL THEN RAISE EXCEPTION 'token_not_found'; END IF;
  IF v_expires_at IS NULL OR v_expires_at < NOW() THEN RAISE EXCEPTION 'token_expired'; END IF;
  -- SEC-C3 fix: gebruik >= (was > → off-by-one liet 1 extra use toe)
  IF v_used_count >= v_max_uses THEN RAISE EXCEPTION 'token_max_uses_reached'; END IF;
  IF v_nda_ack_ts IS NULL THEN RAISE EXCEPTION 'nda_not_acknowledged'; END IF;
  IF v_signed_at IS NOT NULL THEN RAISE EXCEPTION 'already_signed'; END IF;

  v_new_bedrijfsnaam := NULLIF(TRIM(p_bedrijfsnaam), '');
  IF COALESCE(NULLIF(TRIM(v_existing_bedrijfsnaam), ''), v_new_bedrijfsnaam) IS NULL THEN
    RAISE EXCEPTION 'incomplete_company_details';
  END IF;
  IF NULLIF(TRIM(v_existing_email), '') IS NULL THEN
    RAISE EXCEPTION 'incomplete_company_details';
  END IF;

  v_final_sectoren := COALESCE(p_sectoren, v_existing_sectoren);
  IF v_final_sectoren IS NULL OR jsonb_typeof(v_final_sectoren) <> 'array'
     OR jsonb_array_length(v_final_sectoren) = 0 THEN
    RAISE EXCEPTION 'sectoren_required';
  END IF;

  v_final_marge_pct := COALESCE(p_marge_pct, v_existing_marge_pct);
  IF v_final_marge_pct IS NULL THEN
    RAISE EXCEPTION 'marge_required';
  END IF;

  UPDATE public.partner_applications
  SET
    contract_handtekening_base64 = p_handtekening_base64,
    contract_signed_at = NOW(),
    signing_ip = v_server_ip,         -- SEC-C2: server-side, niet p_ip
    signing_user_agent = v_server_ua,  -- SEC-C2: server-side, niet p_user_agent
    signing_mode = 'remote',
    status = 'contract_signed',
    bedrijfsnaam              = COALESCE(NULLIF(TRIM(p_bedrijfsnaam), ''), bedrijfsnaam),
    btw_nummer                = COALESCE(NULLIF(TRIM(p_btw_nummer), ''), btw_nummer),
    adres                     = COALESCE(NULLIF(TRIM(p_adres), ''), adres),
    postcode                  = COALESCE(NULLIF(TRIM(p_postcode), ''), postcode),
    gemeente                  = COALESCE(NULLIF(TRIM(p_gemeente), ''), gemeente),
    contactpersoon_voornaam   = COALESCE(NULLIF(TRIM(p_contactpersoon_voornaam), ''), contactpersoon_voornaam),
    contactpersoon_naam       = COALESCE(NULLIF(TRIM(p_contactpersoon_naam), ''), contactpersoon_naam),
    contactpersoon_telefoon   = COALESCE(NULLIF(TRIM(p_contactpersoon_telefoon), ''), contactpersoon_telefoon),
    website                   = COALESCE(NULLIF(TRIM(p_website), ''), website),
    marge_pct                 = COALESCE(p_marge_pct, marge_pct),
    sectoren                  = COALESCE(p_sectoren, sectoren),
    communicatie_email        = COALESCE(NULLIF(TRIM(p_communicatie_email), ''), communicatie_email),
    communicatie_telefoon     = COALESCE(NULLIF(TRIM(p_communicatie_telefoon), ''), communicatie_telefoon),
    updated_at = NOW()
  WHERE id = v_app_id;

  RETURN TRUE;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- 4. SEC-C2 + H4: public_acknowledge_confidentiality — server-side IP/UA + version whitelist
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.public_acknowledge_confidentiality(
  p_token text,
  p_ip text DEFAULT NULL::text,        -- DEPRECATED, genegeerd
  p_user_agent text DEFAULT NULL::text, -- DEPRECATED, genegeerd
  p_version text DEFAULT 'v1.0-nl'::text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_app_id UUID;
  v_meta JSONB;
  v_server_ip INET;
  v_server_ua TEXT;
BEGIN
  IF p_token IS NULL OR length(p_token) < 30 THEN
    RAISE EXCEPTION 'invalid_token';
  END IF;

  -- H4: whitelist erkende NDA-versies — voorkomt audit-vervalsing met
  -- onbestaande versie-strings.
  IF p_version NOT IN ('v1.0-nl', 'v1.0-fr', 'v1.0-en', 'v1.1-nl', 'v1.1-fr', 'v1.1-en') THEN
    RAISE EXCEPTION 'invalid_nda_version';
  END IF;

  -- Server-side IP/UA capture
  v_meta := public._request_client_meta();
  BEGIN
    v_server_ip := NULLIF(v_meta ->> 'ip', '')::INET;
  EXCEPTION WHEN OTHERS THEN
    v_server_ip := NULL;
  END;
  v_server_ua := v_meta ->> 'user_agent';

  SELECT id INTO v_app_id
  FROM public.partner_applications
  WHERE signing_token = p_token
    AND signing_token_expires_at >= NOW()
    AND signing_token_used_count <= signing_token_max_uses
    AND contract_signed_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'token_invalid_or_expired';
  END IF;

  UPDATE public.partner_applications
  SET
    confidentiality_ack_ts = COALESCE(confidentiality_ack_ts, NOW()),
    confidentiality_ack_ip = COALESCE(confidentiality_ack_ip, v_server_ip),       -- SEC-C2
    confidentiality_ack_user_agent = COALESCE(confidentiality_ack_user_agent, v_server_ua), -- SEC-C2
    confidentiality_ack_version = COALESCE(confidentiality_ack_version, p_version),
    pricing_shown_at = COALESCE(pricing_shown_at, NOW()),
    pricing_shown_ip = COALESCE(pricing_shown_ip, v_server_ip),
    updated_at = NOW()
  WHERE id = v_app_id;

  RETURN TRUE;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- 5. SEC-C2: anon_sign_contract_complete — server-side IP/UA
-- ─────────────────────────────────────────────────────────────────────
--
-- Behoud bestaande signature; alleen UPDATE-statement aanpassen om
-- _request_client_meta() te gebruiken in plaats van p_signing_ip/p_signing_user_agent.

CREATE OR REPLACE FUNCTION public.anon_sign_contract_complete(
  p_token uuid,
  p_handtekening_url text DEFAULT NULL::text,
  p_handtekening_data text DEFAULT NULL::text,
  p_signing_user_agent text DEFAULT NULL::text, -- DEPRECATED
  p_signing_ip text DEFAULT NULL::text,         -- DEPRECATED
  p_client_payload jsonb DEFAULT NULL::jsonb,
  p_lang text DEFAULT 'nl'::text,
  p_verklaring_6btw_privewoning boolean DEFAULT NULL::boolean,
  p_verklaring_6btw_ouderdan10j boolean DEFAULT NULL::boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contract_id uuid;
  v_partner_id  uuid;
  v_client_id   uuid;
  v_email       text;
  v_lang        text;
  v_btw_type    text;
  v_is_6btw     boolean;
  v_meta        JSONB;
  v_server_ip   INET;
  v_server_ua   TEXT;
BEGIN
  IF p_token IS NULL THEN
    RAISE EXCEPTION 'token_required';
  END IF;

  v_lang := CASE WHEN lower(coalesce(p_lang, 'nl')) IN ('nl','fr') THEN lower(p_lang) ELSE 'nl' END;

  -- Server-side capture vervangt p_signing_ip / p_signing_user_agent
  v_meta := public._request_client_meta();
  BEGIN
    v_server_ip := NULLIF(v_meta ->> 'ip', '')::INET;
  EXCEPTION WHEN OTHERS THEN
    v_server_ip := NULL;
  END;
  v_server_ua := v_meta ->> 'user_agent';

  SELECT id, partner_id, btw_type
    INTO v_contract_id, v_partner_id, v_btw_type
  FROM contracten
  WHERE teken_token = p_token
    AND status = 'concept'
    AND (verlopen_op IS NULL OR verlopen_op >= CURRENT_DATE)
  LIMIT 1;

  IF v_contract_id IS NULL THEN
    RAISE EXCEPTION 'contract_not_signable';
  END IF;

  v_is_6btw := (v_btw_type IS NOT NULL)
               AND (v_btw_type LIKE '6%%' OR btrim(v_btw_type) = '6');

  IF v_is_6btw THEN
    IF p_verklaring_6btw_privewoning IS NOT TRUE
       OR p_verklaring_6btw_ouderdan10j IS NOT TRUE THEN
      RAISE EXCEPTION 'verklaring_6btw_required' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_client_payload IS NOT NULL
     AND (p_client_payload ? 'contact_person')
     AND length(coalesce(p_client_payload->>'contact_person','')) > 0 THEN

    v_email := nullif(p_client_payload->>'email','');

    IF v_email IS NOT NULL THEN
      SELECT id INTO v_client_id
      FROM clients
      WHERE partner_id = v_partner_id AND lower(email) = lower(v_email)
      LIMIT 1;
    END IF;

    IF v_client_id IS NULL THEN
      INSERT INTO clients (
        partner_id, contact_person, email, phone, street, postal_code, city, notes
      )
      VALUES (
        v_partner_id,
        nullif(p_client_payload->>'contact_person',''),
        v_email,
        nullif(p_client_payload->>'phone',''),
        nullif(p_client_payload->>'street',''),
        nullif(p_client_payload->>'postal_code',''),
        nullif(p_client_payload->>'city',''),
        coalesce(nullif(p_client_payload->>'notes',''), 'Aangemaakt bij contractondertekening')
      )
      RETURNING id INTO v_client_id;
    END IF;
  END IF;

  UPDATE contracten
     SET status              = 'actief',
         handtekening_url    = p_handtekening_url,
         handtekening_data   = CASE WHEN p_handtekening_url IS NULL THEN p_handtekening_data ELSE NULL END,
         datum_ondertekening = CURRENT_DATE,
         signing_user_agent  = v_server_ua,  -- SEC-C2: server-side
         signing_timestamp   = now(),
         signing_methode     = 'op_afstand',
         signing_ip          = COALESCE(v_server_ip::TEXT, NULL), -- SEC-C2: server-side
         akkoord_voorwaarden = TRUE,
         privacy_akkoord     = TRUE,
         client_id           = COALESCE(v_client_id, client_id),
         lang                = v_lang,
         verklaring_6btw_privewoning_aangevinkt = CASE
           WHEN v_is_6btw THEN COALESCE(p_verklaring_6btw_privewoning, FALSE)
           ELSE FALSE
         END,
         verklaring_6btw_ouderdan10j_aangevinkt = CASE
           WHEN v_is_6btw THEN COALESCE(p_verklaring_6btw_ouderdan10j, FALSE)
           ELSE FALSE
         END,
         verklaring_6btw_datum = CASE
           WHEN v_is_6btw THEN now()
           ELSE NULL
         END
   WHERE id = v_contract_id;

  RETURN jsonb_build_object(
    'contract_id', v_contract_id,
    'client_id',   v_client_id,
    'signed_at',   now(),
    'lang',        v_lang,
    'btw_type',    v_btw_type,
    'is_6btw',     v_is_6btw
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- 6. M2 defense-in-depth: REVOKE EXECUTE FROM anon op admin_* RPC's
-- ─────────────────────────────────────────────────────────────────────
--
-- Deze functies hebben interne auth.uid()-check (al verified) maar het is
-- best-practice om de attack-surface ook op grant-niveau te beperken.

REVOKE EXECUTE ON FUNCTION public.admin_create_partner_application(text, text, text, text, text, text, jsonb, text, text, text, text, jsonb, integer, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_generate_signing_token(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_record_in_person_signing(uuid, text, text, text) FROM anon;
