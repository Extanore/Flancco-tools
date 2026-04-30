-- Wave: security advisor sweep — anon_security_definer_function_executable
-- Revokes EXECUTE FROM anon (and PUBLIC) on SECURITY DEFINER functions that are
-- not part of the public-facing token RPC surface (anon_*/portal_*) and not
-- referenced by RLS policies whose roles include {public}/{anon}.
--
-- KEPT (intentionally callable by anon):
--   - anon_*  : token-validated public RPCs (calculator + signing)
--   - portal_*: token-validated klant portal RPCs
--   - is_admin / is_partner_of / is_super_admin / is_partner_admin_of /
--     can_manage_planning : referenced from {public}-role RLS policies, must
--     be EXECUTEable by anon (anonymous evaluation returns FALSE / NULL safely).
--
-- REVOKED (admin-only / cron-only / trigger-only — no anon need):
--   - check_afwezigheid_conflict     : admin-side scheduling helper
--   - generate_ref_nummer_losse      : trigger-only (runs as definer regardless)
--   - generate_ref_nummer_onderhoud  : trigger-only
--   - restore_beurt                  : admin-only RPC
--   - soft_delete_beurt              : admin-only RPC
--   - techniekers_daily_actief_sync  : pg_cron-only

BEGIN;

-- check_afwezigheid_conflict
REVOKE EXECUTE ON FUNCTION public.check_afwezigheid_conflict(uuid, date, text, uuid)
  FROM PUBLIC, anon;

-- generate_ref_nummer_losse / _onderhoud (no-arg)
REVOKE EXECUTE ON FUNCTION public.generate_ref_nummer_losse()
  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.generate_ref_nummer_onderhoud()
  FROM PUBLIC, anon;

-- restore_beurt / soft_delete_beurt (admin RPCs)
REVOKE EXECUTE ON FUNCTION public.restore_beurt(uuid, text)
  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.soft_delete_beurt(uuid, text)
  FROM PUBLIC, anon;

-- techniekers_daily_actief_sync (cron)
REVOKE EXECUTE ON FUNCTION public.techniekers_daily_actief_sync()
  FROM PUBLIC, anon;

COMMIT;
