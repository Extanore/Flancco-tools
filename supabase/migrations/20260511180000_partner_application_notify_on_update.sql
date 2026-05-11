-- ─── Fix: partner_applications notify-trigger vuurt nu ook op status-UPDATE ─────
-- Voorheen: AFTER INSERT only → leads die later via UPDATE naar contract_signed
-- gingen (admin signing-link flow + remote signing flow) genereerden geen tweede
-- notification, dus admin miste het signing-event in de bell-dropdown.
-- Nu: AFTER INSERT OR UPDATE OF status, met DISTINCT-check zodat geen ruis bij
-- andere UPDATEs.

-- Function: TG_OP-aware, dedup_key per status zodat lead-notif en contract_signed-notif
-- niet collidiseren op dezelfde application_id.
CREATE OR REPLACE FUNCTION public.fn_partner_application_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_flancco_partner_id UUID;
  v_sectoren_tekst TEXT;
  v_titel TEXT;
  v_body TEXT;
BEGIN
  -- UPDATE-pad: enkel notify bij echte transitie naar contract_signed.
  -- Andere status-wijzigingen (lead → demo_bekeken, naar account_created, etc.)
  -- genereren geen melding — die zijn admin-gedreven en daar verwacht je geen alert.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
    IF NEW.status <> 'contract_signed' THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Flancco-partner-anchor (RLS-tenant). Zonder Flancco-record geen melding.
  SELECT id INTO v_flancco_partner_id FROM partners WHERE slug = 'flancco' LIMIT 1;
  IF v_flancco_partner_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_sectoren_tekst := COALESCE(
    (SELECT string_agg(value::text, ', ') FROM jsonb_array_elements_text(NEW.sectoren)),
    '—'
  );

  v_titel := CASE
    WHEN NEW.status = 'contract_signed' THEN 'Nieuw getekend partner-contract: ' || COALESCE(NEW.bedrijfsnaam, 'Onbekend')
    ELSE 'Nieuwe partner-aanvraag: ' || COALESCE(NEW.bedrijfsnaam, 'Onbekend')
  END;

  v_body := 'Sector(en): ' || v_sectoren_tekst || ' · Status: ' || COALESCE(NEW.status, '—');

  INSERT INTO notifications (
    partner_id, user_id, type, title, body, link_url,
    related_type, related_id, is_read, email_sent, email_opt_in, dedup_key
  ) VALUES (
    v_flancco_partner_id,
    NULL,
    'partner_application_new',
    v_titel,
    v_body,
    '/admin/index.html',
    'partner_application',
    NEW.id,
    false,
    false,
    true,
    -- Status-specifieke dedup_key zodat lead- en contract_signed-notif niet
    -- elkaar deduppen voor dezelfde application_id.
    'partner_application_' || COALESCE(NEW.status, 'unknown') || '_' || NEW.id::text
  );

  RETURN NEW;
END;
$function$;

-- Trigger drop + recreate met UPDATE OF status erbij
DROP TRIGGER IF EXISTS trg_partner_application_notify ON partner_applications;

CREATE TRIGGER trg_partner_application_notify
AFTER INSERT OR UPDATE OF status ON partner_applications
FOR EACH ROW
EXECUTE FUNCTION fn_partner_application_notify();

-- Backfill: handmatig één gemiste contract_signed notification voor de net-getekende
-- Extanore application (id zichtbaar in user-screenshot dd 2026-05-11 19:42).
-- Idempotent via WHERE NOT EXISTS check op dedup_key.
INSERT INTO notifications (
  partner_id, user_id, type, title, body, link_url,
  related_type, related_id, is_read, email_sent, email_opt_in, dedup_key, created_at
)
SELECT
  (SELECT id FROM partners WHERE slug = 'flancco' LIMIT 1),
  NULL,
  'partner_application_new',
  'Nieuw getekend partner-contract: ' || pa.bedrijfsnaam,
  'Sector(en): ' || COALESCE((SELECT string_agg(value::text, ', ') FROM jsonb_array_elements_text(pa.sectoren)), '—') || ' · Status: contract_signed',
  '/admin/index.html',
  'partner_application',
  pa.id,
  false,
  false,
  true,
  'partner_application_contract_signed_' || pa.id::text,
  pa.contract_signed_at
FROM partner_applications pa
WHERE pa.status = 'contract_signed'
  AND pa.contract_signed_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.dedup_key = 'partner_application_contract_signed_' || pa.id::text
  );
