-- Security hardening: zet 2 SECURITY DEFINER views terug naar security_invoker=on
-- zodat RLS van underlying tabellen correct toegepast wordt per call-user.
--
-- Bron: Supabase database-linter advisor (security) — 2 ERRORs:
--   - public.v_ew_maand_stats        (technieker_afwezigheden aggregate)
--   - public.v_kalender_beurten      (onderhoudsbeurten + interventies join)
--
-- Default Postgres views zijn SECURITY DEFINER (eigenaar-rechten). Voor
-- analytics-views over RLS-tabellen is dit een anti-pattern: het bypasst
-- de RLS-policies van de querying user en kan ongeautoriseerde data lekken
-- (admin ziet via partner-JWT alle rijen, of erger: anon bypasst RLS).
--
-- Met security_invoker=on volgen views de rechten + RLS van de aanroeper:
--   - admin           → alle rijen (RLS admin-policy match)
--   - partner-JWT     → enkel eigen rijen (RLS partner-tenant filter)
--   - anon            → permission denied of 0 rijen (RLS strikt)
--
-- v_winstgevendheid_per_technieker heeft deze flag al → niet aangeraakt.
-- Slot V/W follow-up — geen onderliggende business-logica wijziging.

ALTER VIEW public.v_ew_maand_stats   SET (security_invoker = on);
ALTER VIEW public.v_kalender_beurten SET (security_invoker = on);
