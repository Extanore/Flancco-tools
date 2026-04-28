-- Slot W — Calculator-config beheerbaar via admin
-- ─────────────────────────────────────────────────────────────────────
-- Reden: copy (USPs, motivatie-block, klant-vragen) en commerciële
-- knobs (frequentie-opties, contractduur, kortings-percentage) zaten
-- hardcoded in calculator/index.html. Gillian (business owner) wil ze
-- zelf beheren zonder dev-cyclus.
--
-- Architectuur:
--   1. `sector_config` — één jsonb-blob per (sector, partner_id NULL/UUID)
--      • partner_id NULL  → globale default voor de sector
--      • partner_id UUID  → partner-override (BEPERKT tot whitelisted keys
--        usps + motivatie; admin-UI handhaaft die scope. Backend laat
--        alle keys toe voor toekomstige uitbreiding.)
--   2. RPC `anon_get_calculator_config(partner_id)` — server-side merge
--      `globaal || partner-override` per sector, retourneert één jsonb met
--      alle 4 sectoren als top-level keys. Anon-callable (calculator
--      runt zonder auth).
--
-- Seed: LEEG — calculator behoudt code-defaults als fallback. Admin kan
-- per veld over-writen; alleen overschreven keys vervangen de fallback.
-- Veilige migratiestrategie: niets verandert tot iemand iets aanpast.

-- ─────────────────────────────────────────────────────────────────────
-- 1. sector_config tabel
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sector_config (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sector      text        NOT NULL CHECK (sector IN ('zonnepanelen','warmtepomp','ventilatie','verwarming')),
  partner_id  uuid        NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  config      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by  uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sector_config IS
  'Slot W — Per-sector calculator-config (USPs, motivatie, frequentie, contractduur, klant-vragen). Globaal (partner_id NULL) of partner-override.';

-- Unieke (sector) op globale rijen, unieke (sector, partner_id) op overrides.
-- Twee partial indexes voorkomen NULL-mismatches in unique constraints.
CREATE UNIQUE INDEX IF NOT EXISTS sector_config_global_uq
  ON public.sector_config (sector)
  WHERE partner_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sector_config_partner_uq
  ON public.sector_config (sector, partner_id)
  WHERE partner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sector_config_partner_id_idx
  ON public.sector_config (partner_id)
  WHERE partner_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 2. updated_at trigger
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sector_config_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  -- Stamp updated_by uit JWT-claim (admin/partner-edits via PostgREST).
  -- Service-role inserts → NULL (system-edit, geen end-user actie).
  IF auth.uid() IS NOT NULL THEN
    NEW.updated_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sector_config_updated_at ON public.sector_config;
CREATE TRIGGER trg_sector_config_updated_at
  BEFORE INSERT OR UPDATE ON public.sector_config
  FOR EACH ROW EXECUTE FUNCTION public.sector_config_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- 3. RLS — admin full CRUD, partner write op eigen rijen,
--    anon read voor calculator
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.sector_config ENABLE ROW LEVEL SECURITY;

-- Admin: alles
DROP POLICY IF EXISTS "sector_config_admin_all" ON public.sector_config;
CREATE POLICY "sector_config_admin_all" ON public.sector_config
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = (SELECT auth.uid())
        AND ur.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = (SELECT auth.uid())
        AND ur.role = 'admin'
    )
  );

-- Partner: read eigen overrides + globaal
DROP POLICY IF EXISTS "sector_config_partner_read" ON public.sector_config;
CREATE POLICY "sector_config_partner_read" ON public.sector_config
  FOR SELECT
  TO authenticated
  USING (
    partner_id IS NULL
    OR partner_id IN (
      SELECT ur.partner_id FROM public.user_roles ur
      WHERE ur.user_id = (SELECT auth.uid())
        AND ur.role = 'partner'
    )
  );

-- Anon read (voor calculator zonder auth)
DROP POLICY IF EXISTS "sector_config_anon_read" ON public.sector_config;
CREATE POLICY "sector_config_anon_read" ON public.sector_config
  FOR SELECT
  TO anon
  USING (true);

GRANT SELECT ON public.sector_config TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.sector_config TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 4. RPC anon_get_calculator_config — server-side merge
-- ─────────────────────────────────────────────────────────────────────
-- Voor elke sector: globaal jsonb || partner-override jsonb (top-level
-- key merge). Lege keys / lege rijen → '{}'. Calculator merge't dit
-- vervolgens met code-defaults op de client.
CREATE OR REPLACE FUNCTION public.anon_get_calculator_config(p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_sector text;
  v_global jsonb;
  v_override jsonb;
BEGIN
  FOR v_sector IN
    SELECT unnest(ARRAY['zonnepanelen','warmtepomp','ventilatie','verwarming'])
  LOOP
    SELECT config INTO v_global
    FROM public.sector_config
    WHERE sector = v_sector AND partner_id IS NULL;

    IF p_partner_id IS NOT NULL THEN
      SELECT config INTO v_override
      FROM public.sector_config
      WHERE sector = v_sector AND partner_id = p_partner_id;
    ELSE
      v_override := NULL;
    END IF;

    v_result := v_result || jsonb_build_object(
      v_sector,
      coalesce(v_global, '{}'::jsonb) || coalesce(v_override, '{}'::jsonb)
    );
  END LOOP;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.anon_get_calculator_config(uuid) IS
  'Slot W — Merged calculator-config voor één partner (globaal || override per sector). Anon-callable.';

GRANT EXECUTE ON FUNCTION public.anon_get_calculator_config(uuid)
  TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 5. PostgREST schema-cache reload
-- ─────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
