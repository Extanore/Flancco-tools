-- Slot H v2 — audit_log forensische trail (ip + user_agent) + GDPR-alignment
-- ----------------------------------------------------------------------------
-- Sluit de spec-gap tussen oorspronkelijke audit-implementatie (commit f8d1474,
-- pre-plan, Apr 23) en de plan-specificatie uit valiant-petting-pretzel.md
-- Slot H. Voegt twee forensische velden toe:
--   - ip          INET (cf-connecting-ip / x-forwarded-for first hop / x-real-ip)
--   - user_agent  TEXT (max 500 chars)
--
-- Velden worden auto-gestempeld via een BEFORE INSERT trigger uit
-- `current_setting('request.headers', true)` (PostgREST GUC). Voor service-role
-- inserts (edge functions, pg_cron) zijn deze headers niet beschikbaar →
-- NULL, wat een correct onderscheid is tussen end-user en system-acties.
--
-- GDPR overwegingen:
--   - IP is borderline-PII; we slaan 'm op voor security-forensics. Audit-log
--     valt onder de 7-jarige boekhoudkundige bewaarplicht en kan niet
--     selectief gepurged worden. Documentatie in slot-doc.
--   - user_agent is geen PII per se (geen unieke koppeling) maar capped op 500
--     chars om logbloat te voorkomen.
--   - Alle PII-redactie van klant-velden in oude_waarde/nieuwe_waarde gebeurt
--     CLIENT-SIDE in de auditLog() helper (admin/index.html) vóór INSERT.
--     Hier is geen DB-trigger nodig omdat de helper een vertrouwde gateway is
--     (geen RLS-write-policy laat anonymous user_id-spoofing toe).

BEGIN;

-- 1) Kolommen toevoegen (idempotent).
ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS ip         INET,
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

-- 2) Partial index op ip (NULLs uitgesloten — de meerderheid van service-role
--    inserts heeft NULL, dus partial index spaart aanzienlijk in ruimte).
CREATE INDEX IF NOT EXISTS audit_log_ip_idx
  ON public.audit_log (ip)
  WHERE ip IS NOT NULL;

-- 3) Trigger-functie: stempel ip + user_agent uit request-headers indien NULL.
CREATE OR REPLACE FUNCTION public.audit_log_stamp_request_meta()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  hdrs   JSONB;
  hdr_ip TEXT;
  ua     TEXT;
BEGIN
  -- Headers JSON ophalen; missing GUC of niet-PostgREST context → '{}'.
  BEGIN
    hdrs := COALESCE(current_setting('request.headers', true), '{}')::jsonb;
  EXCEPTION WHEN others THEN
    hdrs := '{}'::jsonb;
  END;

  -- IP: alleen overschrijven als nog niet expliciet meegegeven door caller.
  -- Voorkeursvolgorde: Cloudflare proxy → reverse-proxy → directe header.
  IF NEW.ip IS NULL THEN
    hdr_ip := COALESCE(
      hdrs->>'cf-connecting-ip',
      split_part(hdrs->>'x-forwarded-for', ',', 1),
      hdrs->>'x-real-ip'
    );
    IF hdr_ip IS NOT NULL AND length(trim(hdr_ip)) > 0 THEN
      BEGIN
        NEW.ip := trim(hdr_ip)::inet;
      EXCEPTION WHEN others THEN
        -- Malformed IP (zou niet mogen) → NULL i.p.v. trigger-fail.
        NEW.ip := NULL;
      END;
    END IF;
  END IF;

  -- user_agent: cap op 500 chars (logbloat-prevention).
  IF NEW.user_agent IS NULL THEN
    ua := substr(COALESCE(hdrs->>'user-agent', ''), 1, 500);
    IF length(ua) > 0 THEN
      NEW.user_agent := ua;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 4) Trigger registreren (idempotent via DROP IF EXISTS).
DROP TRIGGER IF EXISTS trg_audit_log_stamp_request_meta ON public.audit_log;
CREATE TRIGGER trg_audit_log_stamp_request_meta
  BEFORE INSERT ON public.audit_log
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_log_stamp_request_meta();

-- 5) Documentatie op kolommen — verschijnt in Supabase Studio + introspectie.
COMMENT ON COLUMN public.audit_log.ip IS
  'Slot H v2: client IP gestempeld via BEFORE INSERT trigger uit cf-connecting-ip / x-forwarded-for first hop / x-real-ip. NULL voor service-role en pg_cron inserts (geen browser-context). Onder 7-jarige bewaarplicht — niet selectief purgeable.';

COMMENT ON COLUMN public.audit_log.user_agent IS
  'Slot H v2: User-Agent header (max 500 chars). NULL voor service-role en pg_cron inserts. Bedoeld voor browser/device-troubleshooting bij incident-onderzoek.';

COMMENT ON FUNCTION public.audit_log_stamp_request_meta() IS
  'Slot H v2: BEFORE INSERT trigger op audit_log — stempelt ip + user_agent uit current_setting(''request.headers''). Geen SECURITY DEFINER nodig; leest enkel session-GUC en muteert NEW. Faalt-stil bij malformed IP (NULL i.p.v. row-reject).';

COMMIT;
