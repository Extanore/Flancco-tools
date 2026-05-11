-- ─── audit_log.user_id: SET NULL bij user-delete ────────────────────────────
-- Voorheen NO ACTION: delete van auth.users werd geblokkeerd zodra er één
-- audit-entry naar de user wees. In de praktijk maakte dit user-cleanup (na
-- test-flow, na ex-werknemer-offboarding) onmogelijk zonder manuele audit-
-- log opruim.
--
-- Compliance-overweging: audit_log heeft 7-jarige boekhoud bewaarplicht voor
-- de INHOUD van de mutatie (tabel, actie, oude/nieuwe waarde, IP, user_agent,
-- timestamp). De user_id-attribution is helpful maar niet strikt vereist door
-- de Belgische wetgeving — IP + user_agent geven al een forensische trail bij
-- security-incidenten. Bij user-delete vervalt de naam-attribution maar blijft
-- elke andere audit-info intact.
--
-- Drop oude constraint + recreate met ON DELETE SET NULL.

ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_user_id_fkey;

ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
