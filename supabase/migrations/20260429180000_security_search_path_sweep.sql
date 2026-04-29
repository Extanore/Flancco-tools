-- Security hardening sweep: ALTER FUNCTION SET search_path op alle functies
-- in public schema die geen search_path config hebben.
--
-- Voorkomt schema-shadowing aanvallen via search_path-injection: een attacker
-- met CREATE-rechten in een ander schema kan namespace-collisions opzetten
-- die door functies (vooral SECURITY DEFINER) per ongeluk geresolved worden
-- naar de attacker-versie. Door search_path expliciet te pinnen op
-- `public, pg_temp` worden alleen vertrouwde objecten geresolved.
--
-- Scope (na audit 2026-04-29):
--   - 0 SECURITY DEFINER functies zonder search_path (eerdere sweeps hebben
--     fn_onderhoudsbeurten_audit_stempel + fn_onderhoudsbeurten_dispatch_log_transitie
--     reeds gefixt)
--   - 3 SECURITY INVOKER trigger-helpers gevlagd door Supabase advisor
--     `function_search_path_mutable`:
--       * public.bouwdrogers_set_updated_at()
--       * public.bpd_touch_updated_at()
--       * public.set_updated_at()
--
-- Deze fix is non-blocking voor function-execution: search_path config
-- is alleen een resolver-policy, geen permission-check.

-- ---------------------------------------------------------------------------
-- Per-functie expliciete ALTER (idempotent + audit-trail in version control)
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.bouwdrogers_set_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.bpd_touch_updated_at()       SET search_path = public, pg_temp;
ALTER FUNCTION public.set_updated_at()             SET search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- Defensieve sweep: vangt eventuele andere/nieuwe functies zonder search_path
-- die tussen audit-tijd en migration-apply-tijd zijn ontstaan, of die niet
-- in pg_proc.prosecdef = true staan maar wel het advisor warning triggeren.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT
      p.oid::regprocedure AS func_signature,
      p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND (p.proconfig IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'
      ))
  LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', rec.func_signature);
      RAISE NOTICE 'search_path set on %', rec.func_signature;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Skip % (% — error: %)', rec.proname, rec.func_signature, SQLERRM;
    END;
  END LOOP;
END$$;

-- ---------------------------------------------------------------------------
-- Verificatie binnen migration: count moet 0 zijn na apply.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  remaining INT;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND (p.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'
    ));

  IF remaining > 0 THEN
    RAISE WARNING 'search_path sweep incompleet — % functies onbeschermd', remaining;
  ELSE
    RAISE NOTICE 'search_path sweep OK — alle public functies hebben expliciete search_path';
  END IF;
END$$;
