-- Gezondheidsindex-metingen voor contract-indexering.
-- Admin voert maandelijks de officiële index in vanuit statbel.fgov.be.
-- Bij INSERT/UPDATE van een contract naar 'actief' of 'getekend' wordt
-- de meest recente gezondheidsindex automatisch als start-index gestempeld.

CREATE TABLE IF NOT EXISTS public.gezondheidsindex_metingen (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jaar INT NOT NULL,
  maand INT NOT NULL CHECK (maand BETWEEN 1 AND 12),
  waarde NUMERIC NOT NULL CHECK (waarde > 0),
  bron TEXT NOT NULL DEFAULT 'statbel.fgov.be',
  notitie TEXT NULL,
  ingevoerd_door UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (jaar, maand)
);

CREATE INDEX IF NOT EXISTS idx_gezondheidsindex_jaar_maand
  ON public.gezondheidsindex_metingen(jaar DESC, maand DESC);

COMMENT ON TABLE public.gezondheidsindex_metingen IS
  'Maandelijkse Belgische gezondheidsindex (FOD Economie). Voedt contract-indexerings-berekening en snapshot bij signing.';

ALTER TABLE public.gezondheidsindex_metingen ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gezondheidsindex_admin_all ON public.gezondheidsindex_metingen;
CREATE POLICY gezondheidsindex_admin_all
  ON public.gezondheidsindex_metingen FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS gezondheidsindex_authenticated_select ON public.gezondheidsindex_metingen;
CREATE POLICY gezondheidsindex_authenticated_select
  ON public.gezondheidsindex_metingen FOR SELECT
  TO authenticated
  USING (true);

CREATE OR REPLACE FUNCTION public.touch_gezondheidsindex_updated_at()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gezondheidsindex_touch_updated_at ON public.gezondheidsindex_metingen;
CREATE TRIGGER trg_gezondheidsindex_touch_updated_at
  BEFORE UPDATE ON public.gezondheidsindex_metingen
  FOR EACH ROW EXECUTE FUNCTION public.touch_gezondheidsindex_updated_at();

CREATE OR REPLACE FUNCTION public.get_current_gezondheidsindex()
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT waarde
    FROM public.gezondheidsindex_metingen
   ORDER BY jaar DESC, maand DESC
   LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION public.get_current_gezondheidsindex() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_current_gezondheidsindex() TO authenticated;

-- Trigger: stempel indexering_start_index bij signing-transitie
CREATE OR REPLACE FUNCTION public.set_indexering_start_index()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_idx NUMERIC;
BEGIN
  IF NEW.status IN ('actief','getekend')
     AND NEW.indexering_start_index IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    SELECT waarde INTO v_idx
      FROM public.gezondheidsindex_metingen
     ORDER BY jaar DESC, maand DESC
     LIMIT 1;
    NEW.indexering_start_index := v_idx;
  END IF;
  RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION public.set_indexering_start_index() FROM anon, authenticated, PUBLIC;

DROP TRIGGER IF EXISTS trg_contracten_set_indexering_start_index ON public.contracten;
CREATE TRIGGER trg_contracten_set_indexering_start_index
  BEFORE INSERT OR UPDATE OF status, indexering_start_index
  ON public.contracten
  FOR EACH ROW
  EXECUTE FUNCTION public.set_indexering_start_index();

INSERT INTO public.gezondheidsindex_metingen (jaar, maand, waarde, bron, notitie)
VALUES (2026, 5, 134.50, 'statbel.fgov.be', 'Initial seed — admin moet bij eerste echte contract de actuele waarde verifiëren')
ON CONFLICT (jaar, maand) DO NOTHING;
