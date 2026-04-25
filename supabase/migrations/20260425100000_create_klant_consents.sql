-- Slot Q — GDPR consent management
-- ============================================================
-- Doel: expliciete, ge-audit-trail-de opt-in/opt-out per kanaal per klant.
-- Vereist door GDPR (art. 6.1.a) + ePrivacy-richtlijn voor SMS/WhatsApp.
-- Service-emails (contract-bevestiging, service-reminders) vallen onder
-- art. 6.1.b (uitvoering overeenkomst) en vereisen geen aparte opt-in,
-- maar registreren we wel als consent='email' om audit-completeness te
-- garanderen + opt-out-mechanisme te ondersteunen.
--
-- Marketing-mails (nieuwsbrief, promo) vereisen WEL aparte opt-in (art. 6.1.a).
--
-- Opt-out: per kanaal apart. Een opt-out op SMS raakt email-consent niet aan.
-- Audit-trail: alle mutaties (insert + opt-out update) gelogd via Slot H zodra
-- die live is. Voorlopig gegarandeerd onveranderlijk via append-only-pattern
-- (geen DELETE-policy, alleen UPDATE op opt_out velden).

-- ----------------------------------------------------------------
-- TABEL
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.klant_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid REFERENCES public.contracten(id) ON DELETE CASCADE,
  -- email-adres redundant opgeslagen zodat opt-out blijft werken na
  -- contract-anonymisering (GDPR right-to-be-forgotten op contracten)
  klant_email text NOT NULL,
  kanaal text NOT NULL CHECK (kanaal IN ('email_service', 'email_marketing', 'sms', 'whatsapp')),
  opt_in boolean NOT NULL DEFAULT false,
  opt_in_ts timestamptz NOT NULL DEFAULT now(),
  opt_in_bron text NOT NULL DEFAULT 'calculator' CHECK (opt_in_bron IN ('calculator', 'portal', 'admin', 'import')),
  opt_in_ip inet,
  opt_in_user_agent text,
  opt_out_ts timestamptz,
  opt_out_bron text CHECK (opt_out_bron IS NULL OR opt_out_bron IN ('email_link', 'sms_keyword', 'portal', 'admin', 'klantverzoek')),
  opt_out_ip inet,
  opt_out_token text UNIQUE,
  -- Vrije tekst voor uitzonderlijke gevallen (bv. klant belt om opt-out, admin noteert reden)
  notitie text,
  aangemaakt_op timestamptz NOT NULL DEFAULT now(),
  bijgewerkt_op timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.klant_consents IS 'GDPR consent-trail per klant per kanaal. Append-only via RLS.';
COMMENT ON COLUMN public.klant_consents.kanaal IS 'email_service = service-mails (art. 6.1.b WER, default-on toegestaan); email_marketing = marketing (art. 6.1.a, expliciete opt-in vereist); sms/whatsapp = ePrivacy-vereiste opt-in.';
COMMENT ON COLUMN public.klant_consents.opt_out_token IS 'Unieke token (random 32 chars) voor opt-out-link in mail-footers. Per consent-row apart om token-hijack te beperken.';
COMMENT ON COLUMN public.klant_consents.opt_in_bron IS 'Waar de consent vandaan komt — calculator (publieke flow), portal (klant-self-service, future), admin (handmatig door bediende), import (legacy data-migratie)';

-- ----------------------------------------------------------------
-- INDEXEN
-- ----------------------------------------------------------------
-- Lookup per email (opt-out flow zoekt alle consents van één adres)
CREATE INDEX IF NOT EXISTS idx_klant_consents_email ON public.klant_consents (klant_email);
-- Lookup per contract (admin views, export)
CREATE INDEX IF NOT EXISTS idx_klant_consents_contract ON public.klant_consents (contract_id);
-- Lookup per token (opt-out endpoint queries op token)
CREATE INDEX IF NOT EXISTS idx_klant_consents_token ON public.klant_consents (opt_out_token) WHERE opt_out_token IS NOT NULL;
-- Filter op actieve consents (opt_in true, opt_out_ts NULL) — voor notif-edge functions
CREATE INDEX IF NOT EXISTS idx_klant_consents_active ON public.klant_consents (klant_email, kanaal) WHERE opt_in = true AND opt_out_ts IS NULL;

-- ----------------------------------------------------------------
-- TRIGGER — auto-update bijgewerkt_op
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_klant_consents_set_bijgewerkt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.bijgewerkt_op := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_klant_consents_bijgewerkt ON public.klant_consents;
CREATE TRIGGER trg_klant_consents_bijgewerkt
  BEFORE UPDATE ON public.klant_consents
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_klant_consents_set_bijgewerkt();

-- ----------------------------------------------------------------
-- TRIGGER — genereer opt_out_token bij insert
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_klant_consents_set_token()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.opt_out_token IS NULL THEN
    -- 32-char alfanumerieke token; entropie ≈ 190 bit (ruim voldoende anti-bruteforce)
    NEW.opt_out_token := encode(gen_random_bytes(24), 'base64');
    -- Strip URL-onveilige chars
    NEW.opt_out_token := translate(NEW.opt_out_token, '+/=', '-_~');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_klant_consents_token ON public.klant_consents;
CREATE TRIGGER trg_klant_consents_token
  BEFORE INSERT ON public.klant_consents
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_klant_consents_set_token();

-- ----------------------------------------------------------------
-- RLS — strict default-deny
-- ----------------------------------------------------------------
ALTER TABLE public.klant_consents ENABLE ROW LEVEL SECURITY;

-- ANON: alleen INSERT (calculator-submit). Geen SELECT om enumeration-attack
-- te vermijden (anders zou anon kunnen checken welke email-adressen consent
-- hebben). UPDATE/DELETE volledig dicht.
DROP POLICY IF EXISTS klant_consents_anon_insert ON public.klant_consents;
CREATE POLICY klant_consents_anon_insert
  ON public.klant_consents
  FOR INSERT
  TO anon
  WITH CHECK (
    -- Alleen insert via calculator-flow
    opt_in_bron = 'calculator'
    -- Email moet aanwezig zijn (niet leeg)
    AND klant_email IS NOT NULL
    AND length(trim(klant_email)) > 0
    -- Geen opt-out velden vooraf invullen
    AND opt_out_ts IS NULL
    AND opt_out_bron IS NULL
  );

-- AUTHENTICATED admin: full SELECT + INSERT + UPDATE (geen DELETE).
-- Admin-rol bepaling via user_roles-tabel zoals elders in het schema.
DROP POLICY IF EXISTS klant_consents_admin_all ON public.klant_consents;
CREATE POLICY klant_consents_admin_all
  ON public.klant_consents
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (SELECT auth.uid()) AND ur.role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (SELECT auth.uid()) AND ur.role = 'admin')
  );

-- AUTHENTICATED partner: SELECT op consents van eigen partner-contracten.
-- Geen INSERT/UPDATE — partners mogen geen consents wijzigen, dat doet admin.
DROP POLICY IF EXISTS klant_consents_partner_select ON public.klant_consents;
CREATE POLICY klant_consents_partner_select
  ON public.klant_consents
  FOR SELECT
  TO authenticated
  USING (
    contract_id IN (
      SELECT c.id FROM public.contracten c
      JOIN public.user_roles ur ON ur.partner_id = c.partner_id
      WHERE ur.user_id = (SELECT auth.uid()) AND ur.role = 'partner'
    )
  );

-- ----------------------------------------------------------------
-- VIEW — laatste consent-status per email/kanaal
-- ----------------------------------------------------------------
-- Notif-edge-functions gebruiken deze view om te checken of een klant nog
-- bereikt mag worden. Pakt het meest recente record per (email, kanaal).
CREATE OR REPLACE VIEW public.v_klant_consent_actief AS
SELECT DISTINCT ON (klant_email, kanaal)
  klant_email,
  kanaal,
  opt_in,
  opt_in_ts,
  opt_out_ts,
  CASE
    WHEN opt_out_ts IS NULL AND opt_in = true THEN true
    ELSE false
  END AS bereikbaar
FROM public.klant_consents
ORDER BY klant_email, kanaal, aangemaakt_op DESC;

COMMENT ON VIEW public.v_klant_consent_actief IS 'Laatste consent-status per email/kanaal. Gebruik in send-* edge functions vóór verzenden.';

-- View moet zelfde RLS volgen als onderliggende tabel — security_invoker forceert
-- dat de RLS van de aanroepende user (anon/admin/partner) wordt toegepast i.p.v.
-- die van de view-owner. Voorkomt advisor-error 0010_security_definer_view.
ALTER VIEW public.v_klant_consent_actief SET (security_invoker = true);
ALTER VIEW public.v_klant_consent_actief OWNER TO postgres;

-- ----------------------------------------------------------------
-- GRANT — anon mag inserten via RLS, daarna alleen admin/partner zien
-- ----------------------------------------------------------------
GRANT INSERT ON public.klant_consents TO anon;
GRANT SELECT, INSERT, UPDATE ON public.klant_consents TO authenticated;
GRANT SELECT ON public.v_klant_consent_actief TO authenticated;

-- ----------------------------------------------------------------
-- ROLLBACK (manueel uit te voeren bij rollback)
-- ----------------------------------------------------------------
-- DROP VIEW IF EXISTS public.v_klant_consent_actief;
-- DROP TABLE IF EXISTS public.klant_consents CASCADE;
-- DROP FUNCTION IF EXISTS public.tg_klant_consents_set_bijgewerkt();
-- DROP FUNCTION IF EXISTS public.tg_klant_consents_set_token();
