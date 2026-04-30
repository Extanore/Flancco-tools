-- Wave: security advisor sweep (perf) — unindexed_foreign_keys
-- Adds covering partial indexes WHERE col IS NOT NULL on 10 nullable FK columns
-- flagged by the advisor. Sparse-friendly (most rows have NULL for these
-- audit/cascade columns), reduces bloat, satisfies cascading-check cost.
--
-- All indexes use IF NOT EXISTS for idempotent re-apply.

BEGIN;

CREATE INDEX IF NOT EXISTS beurt_dispatch_log_user_id_idx
  ON public.beurt_dispatch_log (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bouwdrogers_created_by_idx
  ON public.bouwdrogers (created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS duur_instellingen_created_by_idx
  ON public.duur_instellingen (created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS feestdagen_aangemaakt_door_idx
  ON public.feestdagen (aangemaakt_door)
  WHERE aangemaakt_door IS NOT NULL;

CREATE INDEX IF NOT EXISTS interventie_technieker_dag_created_by_idx
  ON public.interventie_technieker_dag (created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS klant_notification_log_contract_id_idx
  ON public.klant_notification_log (contract_id)
  WHERE contract_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS onderhoudsbeurten_verwijderd_door_idx
  ON public.onderhoudsbeurten (verwijderd_door)
  WHERE verwijderd_door IS NOT NULL;

CREATE INDEX IF NOT EXISTS runbook_tooltips_updated_by_idx
  ON public.runbook_tooltips (updated_by)
  WHERE updated_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS sector_config_updated_by_idx
  ON public.sector_config (updated_by)
  WHERE updated_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS technieker_afwezigheden_verwijderd_door_idx
  ON public.technieker_afwezigheden (verwijderd_door)
  WHERE verwijderd_door IS NOT NULL;

COMMIT;
