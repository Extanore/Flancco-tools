-- Wave: security advisor sweep — auth_rls_initplan
-- Wraps bare auth.uid() in (SELECT auth.uid()) for 10 policies on 5 tables to avoid
-- per-row re-evaluation. Pure performance fix; semantics unchanged. Idempotent via
-- DROP POLICY IF EXISTS … CREATE POLICY.

BEGIN;

-- ============================================================================
-- Table: beurt_dispatch_log (3 policies)
-- ============================================================================
DROP POLICY IF EXISTS "Admin/bediende SELECT dispatch_log" ON public.beurt_dispatch_log;
CREATE POLICY "Admin/bediende SELECT dispatch_log"
  ON public.beurt_dispatch_log
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.user_id = (SELECT auth.uid())
        AND user_roles.role = ANY (ARRAY['admin'::text, 'bediende'::text])
    )
  );

DROP POLICY IF EXISTS "Admin/bediende INSERT dispatch_log" ON public.beurt_dispatch_log;
CREATE POLICY "Admin/bediende INSERT dispatch_log"
  ON public.beurt_dispatch_log
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.user_id = (SELECT auth.uid())
        AND user_roles.role = ANY (ARRAY['admin'::text, 'bediende'::text])
    )
  );

DROP POLICY IF EXISTS "Partner SELECT eigen dispatch_log" ON public.beurt_dispatch_log;
CREATE POLICY "Partner SELECT eigen dispatch_log"
  ON public.beurt_dispatch_log
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM onderhoudsbeurten ob
      JOIN contracten c ON c.id = ob.contract_id
      JOIN user_roles ur ON ur.user_id = (SELECT auth.uid())
      WHERE ob.id = beurt_dispatch_log.beurt_id
        AND ur.role = 'partner'::text
        AND ur.partner_id = c.partner_id
    )
  );

-- ============================================================================
-- Table: runbook_tooltips (3 admin policies)
-- ============================================================================
DROP POLICY IF EXISTS "Admin INSERT runbook_tooltips" ON public.runbook_tooltips;
CREATE POLICY "Admin INSERT runbook_tooltips"
  ON public.runbook_tooltips
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.user_id = (SELECT auth.uid())
        AND user_roles.role = 'admin'::text
    )
  );

DROP POLICY IF EXISTS "Admin UPDATE runbook_tooltips" ON public.runbook_tooltips;
CREATE POLICY "Admin UPDATE runbook_tooltips"
  ON public.runbook_tooltips
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.user_id = (SELECT auth.uid())
        AND user_roles.role = 'admin'::text
    )
  );

DROP POLICY IF EXISTS "Admin DELETE runbook_tooltips" ON public.runbook_tooltips;
CREATE POLICY "Admin DELETE runbook_tooltips"
  ON public.runbook_tooltips
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.user_id = (SELECT auth.uid())
        AND user_roles.role = 'admin'::text
    )
  );

-- ============================================================================
-- Table: interventie_technieker_dag (1 policy: itd_tech_read_self)
-- ============================================================================
DROP POLICY IF EXISTS itd_tech_read_self ON public.interventie_technieker_dag;
CREATE POLICY itd_tech_read_self
  ON public.interventie_technieker_dag
  FOR SELECT
  TO authenticated
  USING (
    technieker_id IN (
      SELECT techniekers.id
      FROM techniekers
      WHERE techniekers.user_id = (SELECT auth.uid())
    )
  );

-- ============================================================================
-- Table: duur_instellingen (2 policies)
-- ============================================================================
DROP POLICY IF EXISTS "Admin full access duur" ON public.duur_instellingen;
CREATE POLICY "Admin full access duur"
  ON public.duur_instellingen
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.user_id = (SELECT auth.uid())
        AND user_roles.role = 'admin'::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.user_id = (SELECT auth.uid())
        AND user_roles.role = 'admin'::text
    )
  );

DROP POLICY IF EXISTS "Partner read duur" ON public.duur_instellingen;
CREATE POLICY "Partner read duur"
  ON public.duur_instellingen
  FOR SELECT
  TO authenticated
  USING (
    partner_id IS NULL
    OR EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.user_id = (SELECT auth.uid())
        AND user_roles.partner_id = duur_instellingen.partner_id
    )
  );

-- ============================================================================
-- Table: audit_log (1 policy: insert_audit_log)
-- ============================================================================
DROP POLICY IF EXISTS insert_audit_log ON public.audit_log;
CREATE POLICY insert_audit_log
  ON public.audit_log
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) OR user_id IS NULL);

COMMIT;
