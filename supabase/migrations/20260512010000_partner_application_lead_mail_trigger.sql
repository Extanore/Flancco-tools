-- WF-001: automatische admin-mail bij nieuwe LEAD in partner_applications
--
-- Context:
--   - Trigger trg_partner_application_notify (PR #35) maakt al een in-app
--     notification-rij aan, maar verstuurt GEEN externe mail. Admin moet de
--     bell live zien om de lead te merken.
--   - Edge function send-partner-application-confirmation (v5) ondersteunt
--     event-type 'lead' (PR #46), maar wordt enkel aangeroepen vanuit de
--     frontend success-pane via fetch — die call faalt stilletjes bij
--     network drop, ad-blocker of tab-close vóór success-render.
--   - Deze migration sluit dat gat: een AFTER INSERT trigger op
--     partner_applications doet via pg_net een HTTP-call naar de edge
--     function, gebruikmakend van dezelfde Vault-secrets als de bestaande
--     slot_f_klant_dispatch_daily cron (slot_f_supabase_url +
--     slot_f_service_role_key).
--
-- Idempotency-strategie:
--   - De edge function wordt enkel ingevuurd voor NEW.status = 'lead'.
--   - UPDATE-pad is uitdrukkelijk niet aanwezig — status-transities naar
--     contract_signed worden door de bestaande frontend-flow én door de
--     in-app notify-trigger afgehandeld. Eén pad per event-type voorkomt
--     dubbel-mailen.
--   - Op functie-niveau check we of er reeds een notifications-rij met
--     email_sent = true bestaat voor (partner_id, dedup_key) =
--     ('flancco', 'partner_application_lead_<NEW.id>'). Zo ja, skip.
--   - Bij een succesvolle HTTP-dispatch (request_id > 0) updaten we die
--     notifications-rij naar email_sent = true. Mocht de trigger ooit
--     opnieuw vuren voor dezelfde rij (bv. via een replay), dan zorgt
--     die marker dat we niet dubbel posten.
--
-- Failure-mode:
--   - Vault-secrets ontbreken: log WARNING, geen exception, INSERT slaagt.
--   - HTTP-dispatch faalt (net.http_post throwt): EXCEPTION wordt gevangen,
--     WARNING gelogd, INSERT slaagt. Een lead mag nooit verloren gaan door
--     een externe mail-storing — de in-app notification blijft de baseline.

BEGIN;

-- 1. pg_net moet actief zijn. Idempotent: doet niets als reeds aanwezig.
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. SECURITY DEFINER functie die de edge function invoket.
--    Pattern volgt dispatch_klant_notifications_via_http() (Slot F):
--    Vault-secrets lezen, jsonb-body bouwen, net.http_post() met bearer-auth.
CREATE OR REPLACE FUNCTION public.fn_partner_application_invoke_mail(p_application_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_url         text;
  v_key         text;
  v_request_id  bigint;
  v_dedup_key   text;
  v_flancco_id  uuid;
  v_already_sent boolean;
BEGIN
  IF p_application_id IS NULL THEN
    RETURN -1;
  END IF;

  SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'slot_f_supabase_url' LIMIT 1;
  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets WHERE name = 'slot_f_service_role_key' LIMIT 1;

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE WARNING 'fn_partner_application_invoke_mail: vault-secrets ontbreken (slot_f_supabase_url / slot_f_service_role_key) - skip lead-mail voor application %', p_application_id;
    RETURN -1;
  END IF;

  -- Idempotency-check: bestaat er reeds een verstuurde mail voor deze
  -- (Flancco-partner, lead-dedup_key)? Zo ja, skip silent.
  SELECT id INTO v_flancco_id FROM partners WHERE slug = 'flancco' LIMIT 1;
  v_dedup_key := 'partner_application_lead_' || p_application_id::text;

  IF v_flancco_id IS NOT NULL THEN
    SELECT email_sent INTO v_already_sent
      FROM notifications
     WHERE partner_id = v_flancco_id AND dedup_key = v_dedup_key
     LIMIT 1;

    IF COALESCE(v_already_sent, false) IS TRUE THEN
      RETURN 0;
    END IF;
  END IF;

  BEGIN
    v_request_id := net.http_post(
      url     := rtrim(v_url, '/') || '/functions/v1/send-partner-application-confirmation',
      body    := jsonb_build_object(
        'application_id', p_application_id,
        'event_type',     'lead',
        'source',         'db_trigger'
      ),
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      timeout_milliseconds := 30000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_partner_application_invoke_mail: net.http_post faalde voor application % (sqlstate %, msg %)',
      p_application_id, SQLSTATE, SQLERRM;
    RETURN -1;
  END;

  -- Mark de bijhorende in-app notification als email_sent zodra HTTP-call
  -- werd ingequeued. pg_net is fire-and-forget — een succesvolle queueing
  -- garandeert geen aflevering, maar voorkomt wel re-fire bij replay.
  IF v_request_id IS NOT NULL AND v_request_id > 0 AND v_flancco_id IS NOT NULL THEN
    UPDATE notifications
       SET email_sent = true
     WHERE partner_id = v_flancco_id
       AND dedup_key  = v_dedup_key
       AND email_sent IS DISTINCT FROM true;
  END IF;

  RETURN v_request_id;
END;
$$;

COMMENT ON FUNCTION public.fn_partner_application_invoke_mail(uuid) IS
  'WF-001: invoke send-partner-application-confirmation edge function via pg_net voor nieuwe leads. SECURITY DEFINER + Vault-secrets pattern (cf. dispatch_klant_notifications_via_http).';

-- Restrict execute zoals de andere SECURITY DEFINER-functies in dit schema
-- (security-hardening sweep, commit 9b97a3a):
REVOKE EXECUTE ON FUNCTION public.fn_partner_application_invoke_mail(uuid) FROM anon, authenticated, PUBLIC;

-- 3. AFTER INSERT trigger op partner_applications.
--    Vuurt ENKEL voor NEW.status = 'lead'. Andere statussen (demo_bekeken
--    via admin-wizard, contract_signed via signing-flow) hebben hun eigen
--    pad (admin-getriggerd of frontend-fetch).
--    PERFORM ipv RETURN omdat dit een AFTER-trigger is en de return-value
--    er niet toe doet voor row-mutatie.
CREATE OR REPLACE FUNCTION public.fn_partner_application_send_mail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'lead' THEN
    RETURN NEW;
  END IF;

  PERFORM public.fn_partner_application_invoke_mail(NEW.id);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_partner_application_send_mail() IS
  'WF-001: trigger-wrapper rond fn_partner_application_invoke_mail. AFTER INSERT op partner_applications, alleen voor status=lead.';

REVOKE EXECUTE ON FUNCTION public.fn_partner_application_send_mail() FROM anon, authenticated, PUBLIC;

DROP TRIGGER IF EXISTS trg_partner_application_send_mail ON public.partner_applications;
CREATE TRIGGER trg_partner_application_send_mail
  AFTER INSERT ON public.partner_applications
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_partner_application_send_mail();

COMMENT ON TRIGGER trg_partner_application_send_mail ON public.partner_applications IS
  'WF-001: stuurt admin-mail voor nieuwe leads via pg_net naar send-partner-application-confirmation edge function.';

COMMIT;
