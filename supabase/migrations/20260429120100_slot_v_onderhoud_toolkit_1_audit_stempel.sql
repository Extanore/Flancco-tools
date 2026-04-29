-- Slot V Toolkit-1: audit-stempel (last_modified_by/at) op onderhoudsbeurten
ALTER TABLE onderhoudsbeurten
  ADD COLUMN IF NOT EXISTS last_modified_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_modified_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN onderhoudsbeurten.last_modified_by IS
  'Slot V Toolkit-1: laatste user die record wijzigde. NULL = nooit gewijzigd via authenticated client (bv. service-role/cron).';
COMMENT ON COLUMN onderhoudsbeurten.last_modified_at IS
  'Slot V Toolkit-1: timestamp van laatste wijziging.';

CREATE OR REPLACE FUNCTION fn_onderhoudsbeurten_audit_stempel()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- auth.uid() returns NULL voor service-role/cron — dat is gewenst gedrag
  NEW.last_modified_by := auth.uid();
  NEW.last_modified_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_onderhoudsbeurten_audit_stempel ON onderhoudsbeurten;
CREATE TRIGGER trg_onderhoudsbeurten_audit_stempel
  BEFORE UPDATE ON onderhoudsbeurten
  FOR EACH ROW EXECUTE FUNCTION fn_onderhoudsbeurten_audit_stempel();

CREATE INDEX IF NOT EXISTS idx_onderhoudsbeurten_last_modified
  ON onderhoudsbeurten (last_modified_by, last_modified_at DESC)
  WHERE last_modified_by IS NOT NULL;
