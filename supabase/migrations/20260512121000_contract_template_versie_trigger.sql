-- Contract-template versie auto-stamper.
-- Bij signing van een partner_applications-rij of contracten-rij wordt
-- automatisch de actueel-geldende contract-tekst-versie geschreven naar
-- de contract_template_versie kolom. De versie-string staat in app_settings
-- en wordt enkel via migratie geüpdatet wanneer de contract-tekst wijzigt.
--
-- Dit zorgt dat:
--  - Geen frontend-pass-through nodig (RPC en wizard hoeven niets te doen)
--  - Versie is altijd consistent met de tekst die in de codebase staat
--  - Juridische traceerbaarheid: we kunnen reproduceren welk template
--    gold op signing-moment.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Seed huidige versies in app_settings
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO public.app_settings (key, value)
VALUES
  ('partner_contract_versie', '"v1.1-2026-05-12"'::jsonb),
  ('eindklant_contract_versie', '"v2.0-2026-05-12"'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- ─────────────────────────────────────────────────────────────────────
-- 2. Trigger function — zet versie bij signing-transitie
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_contract_template_versie()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_versie TEXT;
BEGIN
  IF TG_TABLE_NAME = 'partner_applications' THEN
    -- Zet bij signing-transitie (status naar contract_signed) of bij INSERT met die status
    IF NEW.status = 'contract_signed'
       AND NEW.contract_template_versie IS NULL
       AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'contract_signed') THEN
      SELECT value #>> '{}' INTO v_versie
        FROM public.app_settings
       WHERE key = 'partner_contract_versie'
       LIMIT 1;
      NEW.contract_template_versie := v_versie;
    END IF;
  ELSIF TG_TABLE_NAME = 'contracten' THEN
    -- Zet bij signing-transitie (status naar getekend/actief) of bij INSERT met die status
    IF NEW.status IN ('getekend','actief')
       AND NEW.contract_template_versie IS NULL
       AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
      SELECT value #>> '{}' INTO v_versie
        FROM public.app_settings
       WHERE key = 'eindklant_contract_versie'
       LIMIT 1;
      NEW.contract_template_versie := v_versie;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger-function is enkel bedoeld voor trigger-pad — niet aanroepbaar als gewone function
REVOKE EXECUTE ON FUNCTION public.set_contract_template_versie() FROM anon, authenticated, PUBLIC;

COMMENT ON FUNCTION public.set_contract_template_versie() IS
  'Auto-stamper voor contract_template_versie kolom bij signing-transitie. Versie-string komt uit app_settings (partner_contract_versie / eindklant_contract_versie).';

-- ─────────────────────────────────────────────────────────────────────
-- 3. Triggers attachen aan partner_applications + contracten
-- ─────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_partner_applications_set_template_versie ON public.partner_applications;
CREATE TRIGGER trg_partner_applications_set_template_versie
  BEFORE INSERT OR UPDATE OF status, contract_template_versie
  ON public.partner_applications
  FOR EACH ROW
  EXECUTE FUNCTION public.set_contract_template_versie();

DROP TRIGGER IF EXISTS trg_contracten_set_template_versie ON public.contracten;
CREATE TRIGGER trg_contracten_set_template_versie
  BEFORE INSERT OR UPDATE OF status, contract_template_versie
  ON public.contracten
  FOR EACH ROW
  EXECUTE FUNCTION public.set_contract_template_versie();
