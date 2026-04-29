-- Security hardening sweep: REVOKE EXECUTE op alle SECURITY DEFINER
-- trigger-functions die geen RPC-toegang nodig hebben.
--
-- Rationale: trigger-functions zijn alleen via INSERT/UPDATE/DELETE-events
-- bedoeld te draaien, NIET als RPC-callable endpoint. Postgres default geeft
-- EXECUTE aan PUBLIC bij CREATE FUNCTION; dat exposeert ze onnodig.
--
-- Slot V Toolkit-1 (fn_onderhoudsbeurten_audit_stempel) en Toolkit-2
-- (fn_onderhoudsbeurten_dispatch_log_transitie) zijn al gehardend in eerdere
-- migraties. Deze sweep dekt alle andere trigger-bound functions in public
-- en is idempotent — dubbele REVOKE op reeds-gerevokede grants is no-op.
--
-- Opzet:
--  1) DO-block dat dynamisch over alle trigger-functions itereert (vangt
--     ook toekomstige triggers op die per ongeluk default-PUBLIC krijgen)
--  2) Expliciete per-functie REVOKE-regels voor migratie-trail in version
--     control — zodat code-review precies ziet welke functies gehardend zijn

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT DISTINCT p.oid::regprocedure AS func_signature, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    JOIN pg_trigger t ON t.tgfoid = p.oid
    WHERE n.nspname = 'public'
      AND NOT t.tgisinternal
      AND p.prokind = 'f'
  LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', rec.func_signature);
      RAISE NOTICE 'Revoked EXECUTE on %', rec.func_signature;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Skip % (% — error: %)', rec.proname, rec.func_signature, SQLERRM;
    END;
  END LOOP;
END$$;

-- Expliciete per-functie REVOKE-regels (backup + audit-trail in VCS)
-- Lijst gegenereerd via:
--   SELECT format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated;',
--                 p.proname, pg_get_function_identity_arguments(p.oid))
--   FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
--   WHERE n.nspname='public' AND p.prokind='f'
--     AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid=p.oid AND NOT t.tgisinternal)
--   ORDER BY p.proname;

REVOKE EXECUTE ON FUNCTION public.bouwdrogers_set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bpd_sync_parent_beurt() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bpd_touch_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dispatch_notification_email() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_onderhoudsbeurten_audit_stempel() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_onderhoudsbeurten_dispatch_log_transitie() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.generate_contract_nummer() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_beurt_afgewerkt() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_interventie_event() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_partner_on_contract_inserted_signed() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_partner_on_contract_signed() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_rapport_klaar() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.protect_notification_fields() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.protect_partner_commercial_fields() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sector_config_set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.seed_onderhoudsbeurten_on_sign() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_bur_cao_categorie() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_client_contacts_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_pwc_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_ref_nummer_onderhoud() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_volgnummer_interventie() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_primary_contact_to_client() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.techniekers_sync_actief_status() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.touch_notification_preferences() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at() FROM PUBLIC, anon, authenticated;
