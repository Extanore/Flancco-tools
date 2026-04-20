-- =============================================
-- Sectie K: notificatie bij contract-ondertekening
-- =============================================
-- Triggert op contracten.status = 'getekend' / 'actief' (via INSERT of transitie via UPDATE).
-- Creeert automatisch een rij in notifications zodat partner + admin een in-app
-- melding zien (sidebar-badge + notif-lijst via bestaande realtime-listener).
--
-- Dedup: dedup_key = 'contract_signed_' || contract_id. Dankzij bestaande UNIQUE
-- index notifications_partner_dedup_key (partner_id, dedup_key) voorkomt ON CONFLICT
-- dubbele inserts bij status-flip-flop of herhaalde updates.
--
-- Toegepast: 2026-04-20
-- =============================================

-- Functie: UPDATE-pad (transitie concept -> getekend/actief)
CREATE OR REPLACE FUNCTION notify_partner_on_contract_signed() RETURNS trigger AS $$
DECLARE
  klant_label text;
BEGIN
  IF NEW.status IN ('getekend', 'actief')
     AND (OLD.status IS DISTINCT FROM NEW.status)
     AND (OLD.status NOT IN ('getekend', 'actief') OR OLD.status IS NULL) THEN
    klant_label := COALESCE(NEW.klant_naam, 'Onbekende klant');

    INSERT INTO notifications (
      partner_id, type, title, body, link_url,
      related_type, related_id, dedup_key, is_read, created_at
    )
    VALUES (
      NEW.partner_id,
      'contract_getekend',
      'Nieuw getekend contract',
      klant_label || ' heeft het contract ondertekend.',
      '/admin/#contract-' || NEW.id,
      'contract',
      NEW.id,
      'contract_signed_' || NEW.id,
      false,
      now()
    )
    ON CONFLICT (partner_id, dedup_key) DO NOTHING;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

-- Functie: INSERT-pad (calculator-signing doet direct INSERT met status='getekend'
-- of status='actief'; admin-contracten beginnen als concept).
CREATE OR REPLACE FUNCTION notify_partner_on_contract_inserted_signed() RETURNS trigger AS $$
DECLARE
  klant_label text;
BEGIN
  IF NEW.status IN ('getekend', 'actief') THEN
    klant_label := COALESCE(NEW.klant_naam, 'Onbekende klant');

    INSERT INTO notifications (
      partner_id, type, title, body, link_url,
      related_type, related_id, dedup_key, is_read, created_at
    )
    VALUES (
      NEW.partner_id,
      'contract_getekend',
      'Nieuw getekend contract',
      klant_label || ' heeft het contract ondertekend.',
      '/admin/#contract-' || NEW.id,
      'contract',
      NEW.id,
      'contract_signed_' || NEW.id,
      false,
      now()
    )
    ON CONFLICT (partner_id, dedup_key) DO NOTHING;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger: UPDATE
DROP TRIGGER IF EXISTS trg_notify_contract_signed_update ON contracten;
CREATE TRIGGER trg_notify_contract_signed_update
  AFTER UPDATE ON contracten
  FOR EACH ROW EXECUTE FUNCTION notify_partner_on_contract_signed();

-- Trigger: INSERT
DROP TRIGGER IF EXISTS trg_notify_contract_signed_insert ON contracten;
CREATE TRIGGER trg_notify_contract_signed_insert
  AFTER INSERT ON contracten
  FOR EACH ROW EXECUTE FUNCTION notify_partner_on_contract_inserted_signed();

-- =============================================
-- RLS & permissions
-- =============================================
-- SECURITY DEFINER draait met eigenaar-rechten (postgres/supabase_admin), dus
-- bypass RLS bij de INSERT. Dit is correct: de trigger representeert een
-- systeem-event, niet een gebruikersactie.
--
-- Lees-RLS op notifications zorgt dat:
--   - partner ziet eigen meldingen (partner_id = auth_partner_id())
--   - admin ziet alle meldingen (is_admin() bypass)
--
-- Realtime-listener in admin/index.html (.on 'postgres_changes' op notifications)
-- pusht nieuwe rij automatisch naar sidebar-badge zonder code-change.
