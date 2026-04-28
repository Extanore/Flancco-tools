-- Slot U U1 — Technieker uit dienst (soft-delete met historiek-bewaring)
-- ----------------------------------------------------------------------------
-- Vervang het hard-delete-patroon op techniekers door een soft-delete met
-- datum-context. Een technieker met uit_dienst_sinds <= today wordt
-- automatisch inactief (actief=false) via BEFORE INSERT/UPDATE trigger,
-- maar de rij blijft bestaan voor historische referenties:
--   - onderhoudsbeurten + beurt_uren_registraties (FK behouden)
--   - winstgevendheid-view (YTD-aggregaten over ex-collega's)
--   - audit_log uitvoerder-filter
--   - contract-PDF + werkbon-PDF (technieker-naam blijft resolvable)
--
-- Backward-compat: alle bestaande filter-queries (.eq('actief', true) /
-- .filter(t => t.actief !== false) — 9+ call-sites) blijven werken zonder
-- wijziging dankzij trigger-sync.

-- 1. Voeg uit_dienst_sinds toe (idempotent)
ALTER TABLE public.techniekers
  ADD COLUMN IF NOT EXISTS uit_dienst_sinds DATE;

-- 2. Trigger-functie: synct actief uit uit_dienst_sinds
CREATE OR REPLACE FUNCTION public.techniekers_sync_actief_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $func$
BEGIN
  -- Sync actief: true tenzij uit_dienst_sinds ingevuld én vandaag/eerder bereikt
  NEW.actief := (NEW.uit_dienst_sinds IS NULL OR NEW.uit_dienst_sinds > CURRENT_DATE);
  RETURN NEW;
END;
$func$;

-- 3. Trigger registreren (idempotent via DROP IF EXISTS)
DROP TRIGGER IF EXISTS trg_techniekers_sync_actief ON public.techniekers;
CREATE TRIGGER trg_techniekers_sync_actief
  BEFORE INSERT OR UPDATE ON public.techniekers
  FOR EACH ROW
  EXECUTE FUNCTION public.techniekers_sync_actief_status();

-- 4. Daily-sync functie + cron-job: techs met uit_dienst_sinds=today worden
--    automatisch inactief (zonder dat iemand de rij touched). Trigger-only is
--    onvoldoende voor toekomstige uit-dienst-data — deze cron pakt dat op.
CREATE OR REPLACE FUNCTION public.techniekers_daily_actief_sync()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  affected INTEGER := 0;
BEGIN
  -- Triggert de BEFORE UPDATE trigger via no-op assignment, die actief recalculeert
  UPDATE public.techniekers
  SET uit_dienst_sinds = uit_dienst_sinds
  WHERE uit_dienst_sinds IS NOT NULL
    AND ((uit_dienst_sinds <= CURRENT_DATE AND actief = true)
      OR (uit_dienst_sinds > CURRENT_DATE AND actief = false));
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$func$;

-- 5. Schedule via pg_cron (00:05 UTC dagelijks). Vereist pg_cron extension.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Verwijder bestaande job indien aanwezig (idempotent re-apply)
    PERFORM cron.unschedule('slot_u_techniekers_actief_daily')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'slot_u_techniekers_actief_daily');
    PERFORM cron.schedule(
      'slot_u_techniekers_actief_daily',
      '5 0 * * *',
      'SELECT public.techniekers_daily_actief_sync();'
    );
  END IF;
END $$;

-- 6. Partial index op uit_dienst_sinds (sparse — meerderheid is NULL voor active)
CREATE INDEX IF NOT EXISTS techniekers_uit_dienst_idx
  ON public.techniekers (uit_dienst_sinds) WHERE uit_dienst_sinds IS NOT NULL;

-- 7. Documentatie
COMMENT ON COLUMN public.techniekers.uit_dienst_sinds IS
  'Slot U: datum waarop technieker uit dienst is gegaan. NULL = actief. Trigger trg_techniekers_sync_actief synct kolom "actief" automatisch op basis van deze datum. Cron-job slot_u_techniekers_actief_daily (00:05 UTC) deactiveert toekomstige uit-dienst-techs. Hard-delete vermeden om historische FK-referenties (onderhoudsbeurten, audit_log, contract-PDFs) intact te houden.';

COMMENT ON FUNCTION public.techniekers_sync_actief_status() IS
  'Slot U: BEFORE INSERT/UPDATE trigger op techniekers — sync NEW.actief = (uit_dienst_sinds IS NULL OR > today). Geen SECURITY DEFINER nodig (muteert enkel NEW).';

COMMENT ON FUNCTION public.techniekers_daily_actief_sync() IS
  'Slot U: dagelijkse cron-functie (00:05 UTC) die actief-flag herberekent voor techs met toekomstige uit_dienst_sinds die vandaag bereikt is. SECURITY DEFINER zodat pg_cron kan executeren ongeacht caller-rol.';
