-- Slot F — Multi-kanaal klant-notificaties
-- ============================================================
-- Doel: klant-facing reminders (24u vooraf, dagvan, rapport-klaar) per
-- email/SMS/WhatsApp, gestuurd via pg_cron + dispatcher edge function.
-- Strikt gescheiden van de bestaande `notifications`-tabel die admin/partner
-- INTERN aanstuurt — Slot F is uitsluitend voor de eindklant.
--
-- Architectuur:
--   pg_cron (07:15 UTC daily)
--     → public.dispatch_klant_notifications_via_http()  (deze migratie)
--       → POST /functions/v1/dispatch-klant-notifications  (edge fn)
--         → loop over morgen/vandaag-beurten
--         → invoke send-klant-notification-{email,sms,whatsapp}
--           → consent-check via v_klant_consent_actief
--           → write-back timestamp op onderhoudsbeurten
--           → INSERT klant_notification_log
--
-- Idempotentie: per (beurt_id, event_type, kanaal) is er één timestamp-veld
-- op `onderhoudsbeurten`. Eens ingevuld → skipped tenzij `force=true`. Ook
-- bij dubbele cron-fires kan dezelfde beurt geen twee mails krijgen.
--
-- Security:
--   - SQL helper SECURITY DEFINER + SET search_path
--   - REVOKE ALL FROM PUBLIC, GRANT EXECUTE TO postgres only
--   - pg_cron job draait als de jobowner (postgres) → veilige call
--   - Dispatcher edge fn vereist Bearer = SERVICE_ROLE_KEY (geen public)
--   - klant_notification_log RLS: admin full, partner SELECT only own
--
-- Vault-secrets:
--   `slot_f_supabase_url`           — bv. https://dhuqpxwwavqyxaelxuzl.supabase.co
--   `slot_f_service_role_key`       — Supabase service-role JWT (kort: eyJ...)
--   Beiden moeten ná deze migratie aangevuld worden via SQL Editor:
--     SELECT vault.create_secret('eyJ...', 'slot_f_service_role_key',
--                                'Slot F dispatcher: SUPABASE_SERVICE_ROLE_KEY');
--     SELECT vault.create_secret('https://<ref>.supabase.co', 'slot_f_supabase_url',
--                                'Slot F dispatcher: project URL');
-- ============================================================

-- ----------------------------------------------------------------
-- 1. NIEUWE KOLOMMEN op onderhoudsbeurten — timestamp per kanaal/event
-- ----------------------------------------------------------------
ALTER TABLE public.onderhoudsbeurten
  ADD COLUMN IF NOT EXISTS reminder_24h_email_ts      timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_day_email_ts      timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_24h_sms_ts        timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_day_sms_ts        timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_24h_whatsapp_ts   timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_day_whatsapp_ts   timestamptz,
  ADD COLUMN IF NOT EXISTS rapport_klaar_email_ts     timestamptz;

COMMENT ON COLUMN public.onderhoudsbeurten.reminder_24h_email_ts
  IS 'Slot F: tijdstip waarop de 24u-vooraf reminder via email is verstuurd. NULL = nog niet verzonden.';
COMMENT ON COLUMN public.onderhoudsbeurten.reminder_day_email_ts
  IS 'Slot F: tijdstip waarop de dag-van reminder via email is verstuurd.';
COMMENT ON COLUMN public.onderhoudsbeurten.rapport_klaar_email_ts
  IS 'Slot F: tijdstip waarop de rapport-klaar mail is verstuurd.';

-- Partial-index voor snelle dispatcher-query (alleen actieve, geplande beurten)
CREATE INDEX IF NOT EXISTS idx_onderhoudsbeurten_dispatch_plan
  ON public.onderhoudsbeurten (plan_datum)
  WHERE status IN ('ingepland', 'toekomstig');

-- ----------------------------------------------------------------
-- 2. NIEUWE TABEL — klant_notification_log
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.klant_notification_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beurt_id            uuid REFERENCES public.onderhoudsbeurten(id) ON DELETE SET NULL,
  contract_id         uuid REFERENCES public.contracten(id)         ON DELETE SET NULL,
  partner_id          uuid REFERENCES public.partners(id)           ON DELETE SET NULL,
  kanaal              text NOT NULL CHECK (kanaal IN ('email', 'sms', 'whatsapp')),
  event_type          text NOT NULL CHECK (event_type IN ('reminder_24h', 'reminder_day', 'rapport_klaar', 'test')),
  recipient           text NOT NULL,
  status              text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped_no_consent', 'skipped_already_sent', 'skipped_missing_contact', 'skipped_daily_cap')),
  provider_message_id text,
  error_detail        text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.klant_notification_log
  IS 'Slot F: audit-log van elke poging tot klant-notificatie (sent/failed/skipped).';
COMMENT ON COLUMN public.klant_notification_log.recipient
  IS 'Email-adres of telefoonnummer waarnaar verstuurd is. Bewust geen FK — recipient kan ook test-payload zijn.';
COMMENT ON COLUMN public.klant_notification_log.status
  IS 'sent = succesvol; failed = provider-error; skipped_* = niet verstuurd om regel-redenen (consent, idempotency, missing contact, daily cap).';

CREATE INDEX IF NOT EXISTS idx_klant_notif_log_beurt
  ON public.klant_notification_log (beurt_id, event_type, kanaal);
CREATE INDEX IF NOT EXISTS idx_klant_notif_log_partner_date
  ON public.klant_notification_log (partner_id, created_at DESC);
-- Daily-cap-query gebruikt status='sent' + kanaal + datum → covering partial index
CREATE INDEX IF NOT EXISTS idx_klant_notif_log_daily_cap
  ON public.klant_notification_log (kanaal, created_at)
  WHERE status = 'sent';

-- ----------------------------------------------------------------
-- 3. RLS — klant_notification_log
-- ----------------------------------------------------------------
ALTER TABLE public.klant_notification_log ENABLE ROW LEVEL SECURITY;

-- Admin: full access
DROP POLICY IF EXISTS klant_notif_log_admin_all ON public.klant_notification_log;
CREATE POLICY klant_notif_log_admin_all
  ON public.klant_notification_log
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = (SELECT auth.uid()) AND ur.role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = (SELECT auth.uid()) AND ur.role = 'admin')
  );

-- Partner: SELECT alleen eigen log-rijen (via partner_id direct → snelle index-scan)
DROP POLICY IF EXISTS klant_notif_log_partner_select ON public.klant_notification_log;
CREATE POLICY klant_notif_log_partner_select
  ON public.klant_notification_log
  FOR SELECT
  TO authenticated
  USING (
    partner_id IN (
      SELECT ur.partner_id FROM public.user_roles ur
      WHERE ur.user_id = (SELECT auth.uid())
        AND ur.role = 'partner'
        AND ur.partner_id IS NOT NULL
    )
  );

-- Defense-in-depth: REVOKE alles, GRANT alleen wat nodig is
REVOKE ALL ON public.klant_notification_log FROM anon;
REVOKE ALL ON public.klant_notification_log FROM authenticated;
GRANT SELECT ON public.klant_notification_log TO authenticated;

-- ----------------------------------------------------------------
-- 4. SQL HELPER — dispatch_klant_notifications_via_http
-- ----------------------------------------------------------------
-- Aangeroepen door pg_cron. Leest URL+key uit vault.decrypted_secrets en
-- POST-t naar de dispatcher edge function. Geen body-payload nodig (de
-- dispatcher kent zelf de target-datums op basis van current_date).
--
-- Returns: bigint (net.http_post request_id) zodat de cron-log traceerbaar
-- blijft via select * from net._http_response where id = ...
CREATE OR REPLACE FUNCTION public.dispatch_klant_notifications_via_http()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_url       text;
  v_key       text;
  v_request_id bigint;
BEGIN
  -- Lookup vault-secrets. Indien niet ingevuld: log + RETURN -1.
  SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'slot_f_supabase_url' LIMIT 1;
  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets WHERE name = 'slot_f_service_role_key' LIMIT 1;

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE WARNING 'dispatch_klant_notifications_via_http: vault-secrets ontbreken (slot_f_supabase_url / slot_f_service_role_key) — skip cron run.';
    RETURN -1;
  END IF;

  v_request_id := net.http_post(
    url     := rtrim(v_url, '/') || '/functions/v1/dispatch-klant-notifications',
    body    := jsonb_build_object('source', 'pg_cron'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    timeout_milliseconds := 30000
  );

  RETURN v_request_id;
END;
$$;

COMMENT ON FUNCTION public.dispatch_klant_notifications_via_http()
  IS 'Slot F: pg_cron entrypoint. POST naar dispatch-klant-notifications edge fn met service-role bearer.';

-- Lock-down: alleen postgres (en dus pg_cron) mag dit aanroepen.
REVOKE ALL ON FUNCTION public.dispatch_klant_notifications_via_http() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_klant_notifications_via_http() FROM anon;
REVOKE ALL ON FUNCTION public.dispatch_klant_notifications_via_http() FROM authenticated;
-- postgres role behoudt automatisch EXECUTE als owner

-- ----------------------------------------------------------------
-- 5. PG_CRON JOB — daily 07:15 UTC
-- ----------------------------------------------------------------
-- Idempotent (re-)scheduling: unschedule first, suppress 'job not found'.
DO $$
DECLARE
  v_existing_jobid bigint;
BEGIN
  SELECT jobid INTO v_existing_jobid FROM cron.job WHERE jobname = 'slot_f_klant_dispatch_daily';
  IF v_existing_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_existing_jobid);
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Onverwachte error: log + continue (schedule call eronder zal opnieuw proberen)
  RAISE WARNING 'slot_f_klant_dispatch_daily unschedule fout: %', SQLERRM;
END $$;

SELECT cron.schedule(
  'slot_f_klant_dispatch_daily',
  '15 7 * * *',
  $$SELECT public.dispatch_klant_notifications_via_http();$$
);

-- ----------------------------------------------------------------
-- 6. ROLLBACK (handmatig)
-- ----------------------------------------------------------------
-- SELECT cron.unschedule((SELECT jobid FROM cron.job WHERE jobname='slot_f_klant_dispatch_daily'));
-- DROP FUNCTION IF EXISTS public.dispatch_klant_notifications_via_http();
-- DROP TABLE IF EXISTS public.klant_notification_log;
-- ALTER TABLE public.onderhoudsbeurten
--   DROP COLUMN IF EXISTS reminder_24h_email_ts,
--   DROP COLUMN IF EXISTS reminder_day_email_ts,
--   DROP COLUMN IF EXISTS reminder_24h_sms_ts,
--   DROP COLUMN IF EXISTS reminder_day_sms_ts,
--   DROP COLUMN IF EXISTS reminder_24h_whatsapp_ts,
--   DROP COLUMN IF EXISTS reminder_day_whatsapp_ts,
--   DROP COLUMN IF EXISTS rapport_klaar_email_ts;
-- DROP INDEX IF EXISTS idx_onderhoudsbeurten_dispatch_plan;
