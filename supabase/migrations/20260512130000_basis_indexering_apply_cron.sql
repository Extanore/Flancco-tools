-- ============================================================
-- Basis-indexering apply (Flancco-basis pricing rows)
-- ============================================================
-- Doel: een door admin geplande `pricing_indexering_planned` rij op haar
-- effective_date automatisch toepassen op alle `pricing` rijen die de Flancco-
-- basisprijslijst vormen (partner_id IS NULL). Partner-specifieke prijslijsten
-- worden niet aangeraakt door deze flow (partners hebben hun eigen marge/override).
--
-- Scope:
--   - Selectie: `effective_date <= today AND applied_at IS NULL AND cancelled_at IS NULL`
--   - Verhoging: `flancco_forfait := ROUND(flancco_forfait * (1 + pct_increase/100), 2)`
--   - Filter sectoren: NULL `scope_sectoren` = alle sectoren; anders enkel rijen waarvan
--     `pricing.sector = ANY(scope_sectoren)`.
--   - Markering: `applied_at = now()` op de planned-rij.
--
-- Idempotent: één planned-rij wordt slechts één keer toegepast, want na update
-- valt ze buiten de WHERE-filter (applied_at IS NULL).
--
-- Cron: 01:00 UTC dagelijks ('0 1 * * *'). Job-naam: apply_pricing_indexering_daily.
--
-- Security:
--   - SECURITY DEFINER, SET search_path = public, pg_temp
--   - REVOKE FROM PUBLIC/anon/authenticated; postgres (jobowner) behoudt EXECUTE
--   - Per-planned-rij sub-block met EXCEPTION → één foute rij blokkeert batch niet
-- ============================================================

CREATE OR REPLACE FUNCTION public.apply_pending_pricing_indexering()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_planned      RECORD;
  v_updated_rows int;
  v_total_plans  int := 0;
  v_applied      int := 0;
  v_failed       int := 0;
  v_total_rows   int := 0;
  v_errors       jsonb := '[]'::jsonb;
BEGIN
  FOR v_planned IN
    SELECT id, effective_date, pct_increase, scope_sectoren, reden
      FROM public.pricing_indexering_planned
     WHERE effective_date <= CURRENT_DATE
       AND applied_at  IS NULL
       AND cancelled_at IS NULL
     ORDER BY effective_date ASC, created_at ASC
  LOOP
    v_total_plans := v_total_plans + 1;

    BEGIN
      -- Atomic update binnen de sub-block: pricing-rijen + planned-marker.
      -- Als één van beide faalt, rollback enkel deze planned-rij.
      IF v_planned.scope_sectoren IS NULL THEN
        UPDATE public.pricing
           SET flancco_forfait = ROUND(flancco_forfait * (1 + v_planned.pct_increase / 100.0), 2)
         WHERE partner_id IS NULL
           AND actief IS NOT FALSE;
      ELSE
        UPDATE public.pricing
           SET flancco_forfait = ROUND(flancco_forfait * (1 + v_planned.pct_increase / 100.0), 2)
         WHERE partner_id IS NULL
           AND actief IS NOT FALSE
           AND sector = ANY(v_planned.scope_sectoren);
      END IF;

      GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

      UPDATE public.pricing_indexering_planned
         SET applied_at = NOW()
       WHERE id = v_planned.id;

      v_applied   := v_applied + 1;
      v_total_rows := v_total_rows + v_updated_rows;

      RAISE NOTICE 'apply_pending_pricing_indexering: planned_id=% effective=% pct=% rows=%',
        v_planned.id, v_planned.effective_date, v_planned.pct_increase, v_updated_rows;

    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_errors := v_errors || jsonb_build_object(
        'planned_id', v_planned.id,
        'effective_date', v_planned.effective_date,
        'sqlstate', SQLSTATE,
        'message', SQLERRM
      );
      RAISE WARNING 'apply_pending_pricing_indexering: planned_id=% failed: % %', v_planned.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'plans_processed', v_total_plans,
    'plans_applied',   v_applied,
    'plans_failed',    v_failed,
    'pricing_rows_updated', v_total_rows,
    'errors', v_errors
  );
END;
$$;

COMMENT ON FUNCTION public.apply_pending_pricing_indexering()
  IS 'Past door admin geplande Flancco-basis pricing-indexering toe (pricing.partner_id IS NULL) op de effective_date. Cron-driven, idempotent via applied_at.';

REVOKE ALL ON FUNCTION public.apply_pending_pricing_indexering() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_pending_pricing_indexering() FROM anon;
REVOKE ALL ON FUNCTION public.apply_pending_pricing_indexering() FROM authenticated;
-- postgres (job-owner) behoudt EXECUTE als functie-owner.

-- ----------------------------------------------------------------
-- PG_CRON JOB — 01:00 UTC dagelijks
-- ----------------------------------------------------------------
DO $$
DECLARE
  v_existing_jobid bigint;
BEGIN
  SELECT jobid INTO v_existing_jobid FROM cron.job WHERE jobname = 'apply_pricing_indexering_daily';
  IF v_existing_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_existing_jobid);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'apply_pricing_indexering_daily unschedule fout: %', SQLERRM;
END $$;

SELECT cron.schedule(
  'apply_pricing_indexering_daily',
  '0 1 * * *',
  $$SELECT public.apply_pending_pricing_indexering();$$
);

-- ----------------------------------------------------------------
-- ROLLBACK (handmatig)
-- ----------------------------------------------------------------
-- SELECT cron.unschedule((SELECT jobid FROM cron.job WHERE jobname='apply_pricing_indexering_daily'));
-- DROP FUNCTION IF EXISTS public.apply_pending_pricing_indexering();
