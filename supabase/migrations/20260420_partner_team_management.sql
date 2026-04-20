-- =============================================
-- Partner team management — RLS + schema
-- =============================================
-- Vanaf 2026-04-20: partners mogen eigen team uitbreiden en permissies beheren
-- binnen hun eigen platform. Data-isolatie via partner_id + RLS.
--
-- Scope:
--  1. techniekers krijgt partner_id (nullable; NULL = Flancco-intern).
--  2. user_roles RLS: partner kan eigen team lezen/updaten (nooit admin-rijen).
--  3. techniekers RLS: partner kan eigen team lezen/schrijven.
--  4. Seed manage_users=true op bestaande partner-eigenaars zodat ze deze
--     feature meteen kunnen gebruiken.
-- =============================================

-- 1) Schema: partner_id op techniekers
ALTER TABLE techniekers
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_techniekers_partner_id ON techniekers(partner_id);

COMMENT ON COLUMN techniekers.partner_id IS
  'NULL = Flancco-intern personeel. Niet-NULL = teamlid van betreffende partner (tenant-isolatie via RLS).';

-- 2) user_roles — partner SELECT/UPDATE van eigen team
DROP POLICY IF EXISTS user_roles_partner_select ON user_roles;
CREATE POLICY user_roles_partner_select ON user_roles
  FOR SELECT TO authenticated
  USING (
    partner_id IS NOT NULL
    AND is_partner_of(partner_id)
    AND role <> 'admin'
  );

-- Partner mag permissies toggle-en op eigen teamleden, maar:
--   • role mag niet 'admin' worden of zijn
--   • manage_partners mag niet true worden (super-admin recht)
DROP POLICY IF EXISTS user_roles_partner_update ON user_roles;
CREATE POLICY user_roles_partner_update ON user_roles
  FOR UPDATE TO authenticated
  USING (
    partner_id IS NOT NULL
    AND is_partner_of(partner_id)
    AND role <> 'admin'
  )
  WITH CHECK (
    is_partner_of(partner_id)
    AND role <> 'admin'
    AND COALESCE((permissions->>'manage_partners')::boolean, false) = false
  );

-- 3) techniekers — partner full CRUD op eigen team
DROP POLICY IF EXISTS techniekers_partner_select ON techniekers;
CREATE POLICY techniekers_partner_select ON techniekers
  FOR SELECT TO authenticated
  USING (partner_id IS NOT NULL AND is_partner_of(partner_id));

DROP POLICY IF EXISTS techniekers_partner_insert ON techniekers;
CREATE POLICY techniekers_partner_insert ON techniekers
  FOR INSERT TO authenticated
  WITH CHECK (partner_id IS NOT NULL AND is_partner_of(partner_id));

DROP POLICY IF EXISTS techniekers_partner_update ON techniekers;
CREATE POLICY techniekers_partner_update ON techniekers
  FOR UPDATE TO authenticated
  USING (partner_id IS NOT NULL AND is_partner_of(partner_id))
  WITH CHECK (partner_id IS NOT NULL AND is_partner_of(partner_id));

DROP POLICY IF EXISTS techniekers_partner_delete ON techniekers;
CREATE POLICY techniekers_partner_delete ON techniekers
  FOR DELETE TO authenticated
  USING (partner_id IS NOT NULL AND is_partner_of(partner_id));

-- 4) Seed: bestaande partner-eigenaars krijgen manage_users permissie
UPDATE user_roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || jsonb_build_object('manage_users', true)
WHERE role = 'partner'
  AND partner_id IS NOT NULL
  AND COALESCE((permissions->>'manage_users')::boolean, false) = false;
