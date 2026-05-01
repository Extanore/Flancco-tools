-- Slot X: fix RPC contract_signed_at default
-- ============================================
-- Bug: COALESCE((payload->>'contract_signed_at')::timestamptz, now()) zette ALTIJD een waarde,
-- waardoor lead-status zonder handtekening de check_partner_application_signing_consistent CHECK schond.
-- Fix: alleen now() defaulten als status='contract_signed', anders payload-waarde of NULL.

CREATE OR REPLACE FUNCTION public.anon_create_partner_application(payload JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_ip INET;
  v_window TIMESTAMPTZ;
  v_count INT;
  v_id UUID;
  v_btw TEXT;
  v_sectoren JSONB;
  v_marge INT;
  v_lang TEXT;
  v_status TEXT;
  v_signed_at TIMESTAMPTZ;
BEGIN
  -- Extract IP from request headers (set door pg_net of Supabase Gateway)
  BEGIN
    v_ip := current_setting('request.headers', true)::jsonb ->> 'cf-connecting-ip';
    IF v_ip IS NULL THEN
      v_ip := split_part(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', ',', 1)::INET;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;

  -- Rate-limit check: 5 INSERTs per IP per uur
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

  -- Validate critical fields
  v_btw := payload ->> 'btw_nummer';
  v_sectoren := payload -> 'sectoren';
  v_marge := (payload ->> 'marge_pct')::INT;
  v_lang := COALESCE(payload ->> 'lang', 'nl');
  v_status := COALESCE(payload ->> 'status', 'contract_signed');

  IF v_marge IS NULL OR v_marge < 10 OR v_marge > 20 THEN
    RAISE EXCEPTION 'invalid_marge_pct' USING ERRCODE = 'P0001';
  END IF;

  IF v_sectoren IS NULL OR jsonb_array_length(v_sectoren) = 0 THEN
    RAISE EXCEPTION 'sectors_required' USING ERRCODE = 'P0001';
  END IF;

  -- contract_signed_at: alleen default now() voor contract_signed status; anders payload of NULL
  IF v_status = 'contract_signed' THEN
    v_signed_at := COALESCE((payload ->> 'contract_signed_at')::TIMESTAMPTZ, now());
  ELSE
    v_signed_at := (payload ->> 'contract_signed_at')::TIMESTAMPTZ;
  END IF;

  -- Insert application
  INSERT INTO partner_applications(
    status, bedrijfsnaam, btw_nummer, btw_validated_payload,
    contactpersoon_voornaam, contactpersoon_naam, contactpersoon_email, contactpersoon_telefoon,
    website, adres, postcode, gemeente,
    sectoren, marge_pct,
    contract_signed_at, signing_ip, signing_user_agent,
    contract_pdf_url, contract_handtekening_base64,
    lang
  ) VALUES (
    v_status,
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
    v_signed_at,
    v_ip,
    payload ->> 'signing_user_agent',
    payload ->> 'contract_pdf_url',
    payload ->> 'contract_handtekening_base64',
    v_lang
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.anon_create_partner_application(JSONB) TO anon, authenticated;
