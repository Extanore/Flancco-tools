-- Slot X: publieke partner-onboarding-wizard tabellen + RLS + RPC + bucket
-- ====================================================================
-- Lead-tracking voor prospect-partners die wizard doorlopen.
-- Anon-INSERT via SECURITY DEFINER RPC met rate-limit (5/uur/IP).
-- Admin SELECT/UPDATE/DELETE; partner SELECT enkel eigen partner_id.

-- ===== TABEL =====
CREATE TABLE IF NOT EXISTS public.partner_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL CHECK (status IN ('lead','demo_bekeken','contract_signed','account_created','live','lost')) DEFAULT 'lead',
  bedrijfsnaam TEXT NOT NULL,
  btw_nummer TEXT,
  btw_validated_payload JSONB,
  contactpersoon_voornaam TEXT,
  contactpersoon_naam TEXT,
  contactpersoon_email TEXT NOT NULL,
  contactpersoon_telefoon TEXT,
  website TEXT,
  adres TEXT,
  postcode TEXT,
  gemeente TEXT,
  sectoren JSONB NOT NULL DEFAULT '[]'::jsonb,
  marge_pct INT NOT NULL CHECK (marge_pct BETWEEN 10 AND 20),
  contract_signed_at TIMESTAMPTZ,
  signing_ip INET,
  signing_user_agent TEXT,
  contract_pdf_url TEXT,
  contract_handtekening_base64 TEXT,
  partner_id UUID REFERENCES public.partners(id) ON DELETE SET NULL,
  notitie TEXT,
  lost_reden TEXT,
  lang TEXT NOT NULL DEFAULT 'nl' CHECK (lang IN ('nl','fr')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_partner_application_signing_consistent CHECK (
    (contract_signed_at IS NULL AND contract_handtekening_base64 IS NULL AND signing_ip IS NULL)
    OR (contract_signed_at IS NOT NULL AND contract_handtekening_base64 IS NOT NULL AND signing_ip IS NOT NULL)
  ),
  CONSTRAINT chk_partner_application_sectors_not_empty CHECK (
    jsonb_array_length(sectoren) > 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_apps_btw_uq
  ON partner_applications(btw_nummer)
  WHERE status NOT IN ('lost') AND btw_nummer IS NOT NULL;

CREATE INDEX IF NOT EXISTS partner_apps_status_created_idx
  ON partner_applications(status, created_at DESC);

CREATE INDEX IF NOT EXISTS partner_apps_partner_id_idx
  ON partner_applications(partner_id) WHERE partner_id IS NOT NULL;

-- ===== TRIGGER updated_at =====
CREATE OR REPLACE FUNCTION public.fn_partner_applications_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_applications_set_updated_at ON partner_applications;
CREATE TRIGGER trg_partner_applications_set_updated_at
  BEFORE UPDATE ON partner_applications
  FOR EACH ROW EXECUTE FUNCTION fn_partner_applications_set_updated_at();

-- Lock down trigger-function from anon/authenticated direct execute
REVOKE EXECUTE ON FUNCTION public.fn_partner_applications_set_updated_at() FROM anon, authenticated, PUBLIC;

-- ===== RATE-LIMIT TABEL =====
CREATE TABLE IF NOT EXISTS public.partner_application_rate (
  ip INET NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, window_start)
);

CREATE INDEX IF NOT EXISTS partner_application_rate_window_idx
  ON partner_application_rate(window_start);

-- Cleanup oude rate-limit-rijen (>2 uur oud)
CREATE OR REPLACE FUNCTION public.fn_cleanup_partner_application_rate()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM partner_application_rate WHERE window_start < now() - INTERVAL '2 hours';
END;
$$;
REVOKE EXECUTE ON FUNCTION public.fn_cleanup_partner_application_rate() FROM anon, authenticated, PUBLIC;

-- ===== RLS =====
ALTER TABLE partner_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_application_rate ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin full access partner_applications" ON partner_applications;
CREATE POLICY "Admin full access partner_applications"
  ON partner_applications FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Partner SELECT eigen partner_applications" ON partner_applications;
CREATE POLICY "Partner SELECT eigen partner_applications"
  ON partner_applications FOR SELECT TO authenticated
  USING (
    partner_id IS NOT NULL
    AND is_partner_of(partner_id)
  );

-- Anon NIET via direct INSERT — alleen via SECURITY DEFINER RPC hieronder

-- Rate-limit table: alleen via SECURITY DEFINER RPC bewerkbaar
DROP POLICY IF EXISTS "Admin SELECT partner_application_rate" ON partner_application_rate;
CREATE POLICY "Admin SELECT partner_application_rate"
  ON partner_application_rate FOR SELECT TO authenticated
  USING (is_admin());

-- ===== RPC ANON-CREATE =====
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

  IF v_marge IS NULL OR v_marge < 10 OR v_marge > 20 THEN
    RAISE EXCEPTION 'invalid_marge_pct' USING ERRCODE = 'P0001';
  END IF;

  IF v_sectoren IS NULL OR jsonb_array_length(v_sectoren) = 0 THEN
    RAISE EXCEPTION 'sectors_required' USING ERRCODE = 'P0001';
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
    COALESCE(payload ->> 'status', 'contract_signed'),
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
    COALESCE((payload ->> 'contract_signed_at')::TIMESTAMPTZ, now()),
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

-- ===== STORAGE BUCKET partner-contracts =====
INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('partner-contracts', 'partner-contracts', false, 5242880, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- RLS: service_role full, admin read all, anon INSERT via signed-url niet via direct
DROP POLICY IF EXISTS "Admin SELECT partner-contracts" ON storage.objects;
CREATE POLICY "Admin SELECT partner-contracts"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'partner-contracts' AND is_admin());

DROP POLICY IF EXISTS "Service role manage partner-contracts" ON storage.objects;
CREATE POLICY "Service role manage partner-contracts"
  ON storage.objects FOR ALL TO service_role
  USING (bucket_id = 'partner-contracts')
  WITH CHECK (bucket_id = 'partner-contracts');

-- Partner SELECT eigen contract via partner_applications join
DROP POLICY IF EXISTS "Partner SELECT eigen partner-contract PDF" ON storage.objects;
CREATE POLICY "Partner SELECT eigen partner-contract PDF"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'partner-contracts'
    AND EXISTS (
      SELECT 1 FROM partner_applications pa
      JOIN user_roles ur ON ur.partner_id = pa.partner_id
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'partner'
        AND pa.contract_pdf_url LIKE '%' || (storage.objects.name) || '%'
    )
  );

-- ===== COMMENTS =====
COMMENT ON TABLE partner_applications IS 'Slot X: prospect-partner aanvragen via publieke /onboard/ wizard';
COMMENT ON FUNCTION anon_create_partner_application IS 'Slot X: SECURITY DEFINER RPC voor anon-INSERT met rate-limit 5/u/IP';
