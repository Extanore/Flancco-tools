-- Slot V Toolkit-2 hardening: REVOKE EXECUTE op trigger-only function
-- Reden: SECURITY DEFINER trigger-functie hoort niet via RPC/PostgREST aanroepbaar te zijn.
-- Trigger fires zelfstandig vanuit DB-engine; expliciete EXECUTE op anon/authenticated is overbodig + security-advisor-flagged.
REVOKE EXECUTE ON FUNCTION public.fn_onderhoudsbeurten_dispatch_log_transitie() FROM anon, authenticated, public;

-- Idem voor audit-stempel trigger uit Toolkit-1 (zelfde patroon)
REVOKE EXECUTE ON FUNCTION public.fn_onderhoudsbeurten_audit_stempel() FROM anon, authenticated, public;
