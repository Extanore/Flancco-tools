-- =====================================================================
-- Migratie: Security advisor fixes
-- Datum   : 2026-04-25
-- Scope   : Resolve 5 pre-existing Supabase security-advisor findings
--           (2 ERRORS + 3 WARNINGS) — niet-gerelateerd aan Bundel 2/3.
--
-- Refs:
--   https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view
--   https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. ERRORS — SECURITY DEFINER views → security_invoker
--
--    Reden: SECURITY DEFINER views runnen RLS met de eigenaar-rol,
--    waardoor partner-RLS / aggregatie-scoping kan worden omzeild.
--    security_invoker = true forceert RLS-evaluatie met de aanroeper-rol,
--    zodat partner-scoping op v_kalender_beurten en aggregatie-zichtbaarheid
--    op v_ew_maand_stats correct blijft.
--
--    De onderliggende RLS op `onderhoudsbeurten` (partner_id-scoping via
--    contracten → partners) en `technieker_afwezigheden` (admin-only voor
--    EW-aggregaten) blijft daardoor authoritatief.
-- ---------------------------------------------------------------------
ALTER VIEW public.v_ew_maand_stats   SET (security_invoker = true);
ALTER VIEW public.v_kalender_beurten SET (security_invoker = true);

-- ---------------------------------------------------------------------
-- B. WARNINGS — trigger functions zonder explicit search_path
--
--    Reden: zonder vastgepind search_path kan een aanroeper via
--    `SET search_path` schaduw-objecten (bv. `public.now()`) injecteren
--    en de trigger compromitteren. `public, pg_temp` is de Supabase-
--    aanbevolen pin voor functions die alleen in `public` werken.
-- ---------------------------------------------------------------------
ALTER FUNCTION public.bouwdrogers_set_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.bpd_touch_updated_at()       SET search_path = public, pg_temp;
ALTER FUNCTION public.set_updated_at()             SET search_path = public, pg_temp;

-- ---------------------------------------------------------------------
-- C. Verificatie-hint (manueel uit te voeren door admin)
-- ---------------------------------------------------------------------
--   1. Re-run Supabase advisors → alle 5 findings moeten weg zijn.
--   2. Smoke-tests in admin UI:
--      • Planning-view → kalender laadt onderhoudsbeurten correct
--        (controleert v_kalender_beurten partner-scoping).
--      • Verlof → EW-tab → maand-stats laden correct
--        (controleert v_ew_maand_stats aggregatie-zichtbaarheid).
-- ---------------------------------------------------------------------
