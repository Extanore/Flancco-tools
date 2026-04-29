-- Slot V — Onderhoud-pipeline: snooze_tot voor fase 1 (In te plannen)
ALTER TABLE onderhoudsbeurten
  ADD COLUMN IF NOT EXISTS snooze_tot DATE NULL;
COMMENT ON COLUMN onderhoudsbeurten.snooze_tot IS
  'Slot V: tot wanneer record verborgen uit fase 1 lijst. NULL = niet gesnoozed.';
