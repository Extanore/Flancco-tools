-- Slot V Toolkit-2: beurt_dispatch_log (activity-log per record)
CREATE TABLE IF NOT EXISTS beurt_dispatch_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beurt_id UUID NOT NULL REFERENCES onderhoudsbeurten(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('manual','snooze','system','transitie','mail')),
  text TEXT NOT NULL,
  user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_beurt_dispatch_log_beurt_created
  ON beurt_dispatch_log (beurt_id, created_at DESC);

ALTER TABLE beurt_dispatch_log ENABLE ROW LEVEL SECURITY;

-- Admin/bediende mogen alles lezen + invoegen
DROP POLICY IF EXISTS "Admin/bediende SELECT dispatch_log" ON beurt_dispatch_log;
CREATE POLICY "Admin/bediende SELECT dispatch_log"
  ON beurt_dispatch_log FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role IN ('admin','bediende'))
  );

DROP POLICY IF EXISTS "Admin/bediende INSERT dispatch_log" ON beurt_dispatch_log;
CREATE POLICY "Admin/bediende INSERT dispatch_log"
  ON beurt_dispatch_log FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role IN ('admin','bediende'))
  );

-- Partner SELECT enkel eigen partner_id via JOIN onderhoudsbeurten -> contracten
DROP POLICY IF EXISTS "Partner SELECT eigen dispatch_log" ON beurt_dispatch_log;
CREATE POLICY "Partner SELECT eigen dispatch_log"
  ON beurt_dispatch_log FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM onderhoudsbeurten ob
      JOIN contracten c ON c.id = ob.contract_id
      JOIN user_roles ur ON ur.user_id = auth.uid()
      WHERE ob.id = beurt_dispatch_log.beurt_id
        AND ur.role = 'partner'
        AND ur.partner_id = c.partner_id
    )
  );

-- Status-transition trigger: schrijf 'transitie' rij bij elke status-wijziging
CREATE OR REPLACE FUNCTION fn_onderhoudsbeurten_dispatch_log_transitie()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO beurt_dispatch_log (beurt_id, type, text, user_id)
    VALUES (
      NEW.id,
      'transitie',
      format('Status: %s → %s', COALESCE(OLD.status,'(geen)'), COALESCE(NEW.status,'(geen)')),
      auth.uid()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_onderhoudsbeurten_dispatch_log_transitie ON onderhoudsbeurten;
CREATE TRIGGER trg_onderhoudsbeurten_dispatch_log_transitie
  AFTER UPDATE ON onderhoudsbeurten
  FOR EACH ROW EXECUTE FUNCTION fn_onderhoudsbeurten_dispatch_log_transitie();

COMMENT ON TABLE beurt_dispatch_log IS
  'Slot V Toolkit-2: append-only activity-log per onderhoudsbeurt. Dekt manuele notities, snoozes, status-transities, system-events, mail-events.';
