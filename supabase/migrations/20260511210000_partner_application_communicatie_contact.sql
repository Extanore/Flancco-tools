-- ─── Partner-applications: aparte klant-communicatie contactgegevens ─────────
-- Partner kan tijdens onboarding-signing nu reeds een dedicated klant-mail en
-- telefoon opgeven (apart van zijn account/login-contact). Bij activatie
-- worden deze waarden gekopieerd naar partners.communicatie_email/telefoon
-- door register-partner. Backward-compat: kolommen nullable, lege payload =
-- geen override (COALESCE-pattern in RPC + fallback in display-points).

ALTER TABLE public.partner_applications
  ADD COLUMN IF NOT EXISTS communicatie_email TEXT NULL,
  ADD COLUMN IF NOT EXISTS communicatie_telefoon TEXT NULL;

COMMENT ON COLUMN public.partner_applications.communicatie_email IS
  'Optionele klant-communicatie e-mail die partner tijdens onboarding instelt. Wordt bij activatie naar partners.communicatie_email gekopieerd.';

COMMENT ON COLUMN public.partner_applications.communicatie_telefoon IS
  'Optionele klant-communicatie telefoon die partner tijdens onboarding instelt. Wordt bij activatie naar partners.communicatie_telefoon gekopieerd.';

-- ── RPC uitbreiden met 2 nieuwe params ─────────────────────────────────────
DROP FUNCTION IF EXISTS public.public_record_remote_signing(
  text, text, text, text, text, text, text, text, text, text, text, integer, jsonb, text, text
);

CREATE OR REPLACE FUNCTION public.public_record_remote_signing(
  p_token text,
  p_handtekening_base64 text,
  p_bedrijfsnaam text DEFAULT NULL,
  p_btw_nummer text DEFAULT NULL,
  p_adres text DEFAULT NULL,
  p_postcode text DEFAULT NULL,
  p_gemeente text DEFAULT NULL,
  p_contactpersoon_voornaam text DEFAULT NULL,
  p_contactpersoon_naam text DEFAULT NULL,
  p_contactpersoon_telefoon text DEFAULT NULL,
  p_website text DEFAULT NULL,
  p_marge_pct integer DEFAULT NULL,
  p_sectoren jsonb DEFAULT NULL,
  p_ip text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_communicatie_email text DEFAULT NULL,
  p_communicatie_telefoon text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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
BEGIN
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

  SELECT id,
         signing_token_expires_at,
         signing_token_used_count,
         signing_token_max_uses,
         confidentiality_ack_ts,
         contract_signed_at,
         bedrijfsnaam,
         contactpersoon_email,
         sectoren,
         marge_pct
    INTO v_app_id,
         v_expires_at,
         v_used_count,
         v_max_uses,
         v_nda_ack_ts,
         v_signed_at,
         v_existing_bedrijfsnaam,
         v_existing_email,
         v_existing_sectoren,
         v_existing_marge_pct
  FROM public.partner_applications
  WHERE signing_token = p_token
  LIMIT 1;

  IF v_app_id IS NULL THEN RAISE EXCEPTION 'token_not_found'; END IF;
  IF v_expires_at IS NULL OR v_expires_at < NOW() THEN RAISE EXCEPTION 'token_expired'; END IF;
  IF v_used_count > v_max_uses THEN RAISE EXCEPTION 'token_max_uses_reached'; END IF;
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
  IF v_final_sectoren IS NULL
     OR jsonb_typeof(v_final_sectoren) <> 'array'
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
    signing_ip = NULLIF(p_ip, '')::INET,
    signing_user_agent = LEFT(COALESCE(p_user_agent, ''), 500),
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
$function$;

REVOKE EXECUTE ON FUNCTION public.public_record_remote_signing(
  text, text, text, text, text, text, text, text, text, text, text, integer, jsonb, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_record_remote_signing(
  text, text, text, text, text, text, text, text, text, text, text, integer, jsonb, text, text, text, text
) TO anon, authenticated;
