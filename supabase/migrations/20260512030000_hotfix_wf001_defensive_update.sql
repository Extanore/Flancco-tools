-- HOTFIX WF-001: defensive UPDATE binnen fn_partner_application_invoke_mail
-- ----------------------------------------------------------------------
-- Bug: protect_notification_fields() BEFORE UPDATE trigger op `notifications`
-- blokkeerde de email_sent-update vanuit fn_partner_application_invoke_mail,
-- waardoor de hele AFTER INSERT trigger ketting faalde en partner_applications
-- INSERT werd gerolld back. Resultaat: onboard-form toonde "Verzenden lukte niet".
--
-- Fix: wrap de UPDATE in een EXCEPTION-block zodat blokkering door
-- protect_notification_fields() de lead-INSERT NIET rolt back. De email_sent-flag
-- is louter optimistische idempotency-tracking; bij failure raken we geen data
-- kwijt — alleen kans op dubbel-mail bij replay, wat alsnog door de
-- dedup_key + edge function-side check wordt afgevangen.
--
-- Niet-blokkerende RAISE WARNING zodat het verschijnt in postgres-logs voor
-- monitoring. Geen verandering aan de net.http_post-aanroep (al defensief).

CREATE OR REPLACE FUNCTION public.fn_partner_application_invoke_mail(p_application_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_url          text;
  v_key          text;
  v_request_id   bigint;
  v_dedup_key    text;
  v_flancco_id   uuid;
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
    RAISE WARNING 'fn_partner_application_invoke_mail: vault-secrets ontbreken — skip lead-mail voor application %', p_application_id;
    RETURN -1;
  END IF;

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

  -- Defensieve UPDATE: protect_notification_fields() BEFORE UPDATE trigger op
  -- notifications kan dit blokkeren wanneer current_user als partner gezien
  -- wordt. We willen NIET dat dat de lead-INSERT rolt back. Wrap in exception
  -- + log warning voor monitoring.
  IF v_request_id IS NOT NULL AND v_request_id > 0 AND v_flancco_id IS NOT NULL THEN
    BEGIN
      UPDATE notifications
         SET email_sent = true
       WHERE partner_id = v_flancco_id
         AND dedup_key  = v_dedup_key
         AND email_sent IS DISTINCT FROM true;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'fn_partner_application_invoke_mail: email_sent UPDATE geblokkeerd (sqlstate %, msg %) — niet kritiek, lead-INSERT gaat door',
        SQLSTATE, SQLERRM;
    END;
  END IF;

  RETURN v_request_id;
END;
$$;
