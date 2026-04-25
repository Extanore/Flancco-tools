-- Slot K — Belgische feestdagen + sluitingsperiodes (soft-warning)
-- ============================================================
-- Doel: centraal register van wettelijke BE feestdagen + bedrijfs-sluitingsperiodes
-- (bv. bouwverlof) voor de planning-agenda. Soft-warning gedrag in front-end:
-- gebruiker wordt gewaarschuwd bij plannen op deze dagen, maar kan altijd doorduwen.
--
-- Migreert legacy v1-schema (datum PK, naam, land, type='wettelijk') naar v2:
-- uuid PK, label, datum_eind, recurring, aangemaakt_door/_op,
-- type 'feestdag'|'sluitingsperiode'. Behoudt bestaande data.
--
-- RLS:
--   - SELECT: alle authenticated users (planner + technieker zien markering)
--   - INSERT/UPDATE/DELETE: alleen admin
--
-- Auto-extend: edge function `seed-feestdagen-jaar` (cron 1 dec) voegt jaarlijks
-- volgend jaar toe via Computus-algoritme. Idempotent via ON CONFLICT op
-- (datum, label) UNIQUE-tuple.

-- ----------------------------------------------------------------
-- 1) DROP LEGACY CONSTRAINTS
-- ----------------------------------------------------------------
ALTER TABLE public.feestdagen DROP CONSTRAINT IF EXISTS feestdagen_pkey;
ALTER TABLE public.feestdagen DROP CONSTRAINT IF EXISTS feestdagen_type_check;

-- ----------------------------------------------------------------
-- 2) NIEUWE KOLOMMEN (NULLABLE / met default zodat backfill kan)
-- ----------------------------------------------------------------
ALTER TABLE public.feestdagen ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
ALTER TABLE public.feestdagen ADD COLUMN IF NOT EXISTS datum_eind date;
ALTER TABLE public.feestdagen ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE public.feestdagen ADD COLUMN IF NOT EXISTS recurring text DEFAULT 'eenmalig';
ALTER TABLE public.feestdagen ADD COLUMN IF NOT EXISTS aangemaakt_door uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.feestdagen ADD COLUMN IF NOT EXISTS aangemaakt_op timestamptz DEFAULT now();
ALTER TABLE public.feestdagen ADD COLUMN IF NOT EXISTS bijgewerkt_op timestamptz DEFAULT now();

-- ----------------------------------------------------------------
-- 3) BACKFILL legacy → v2
-- ----------------------------------------------------------------
UPDATE public.feestdagen SET label = naam WHERE label IS NULL AND naam IS NOT NULL;
UPDATE public.feestdagen SET recurring = 'jaarlijks' WHERE type = 'wettelijk';
UPDATE public.feestdagen SET aangemaakt_op = COALESCE(created_at, now())
  WHERE aangemaakt_op IS NULL OR aangemaakt_op = bijgewerkt_op;
UPDATE public.feestdagen SET bijgewerkt_op = COALESCE(created_at, now())
  WHERE bijgewerkt_op = aangemaakt_op AND created_at IS NOT NULL;

-- Map legacy type 'wettelijk'/'sector'/'bedrijf' → 'feestdag'/'sluitingsperiode'
UPDATE public.feestdagen SET type = 'feestdag' WHERE type IN ('wettelijk', 'sector');
UPDATE public.feestdagen SET type = 'sluitingsperiode' WHERE type = 'bedrijf';

-- ----------------------------------------------------------------
-- 4) DROP LEGACY KOLOMMEN
-- ----------------------------------------------------------------
ALTER TABLE public.feestdagen DROP COLUMN IF EXISTS naam;
ALTER TABLE public.feestdagen DROP COLUMN IF EXISTS land;
ALTER TABLE public.feestdagen DROP COLUMN IF EXISTS created_at;

-- ----------------------------------------------------------------
-- 5) NOT NULL + NIEUWE CONSTRAINTS
-- ----------------------------------------------------------------
ALTER TABLE public.feestdagen ALTER COLUMN id SET NOT NULL;
ALTER TABLE public.feestdagen ALTER COLUMN label SET NOT NULL;
ALTER TABLE public.feestdagen ALTER COLUMN recurring SET NOT NULL;
ALTER TABLE public.feestdagen ALTER COLUMN aangemaakt_op SET NOT NULL;
ALTER TABLE public.feestdagen ALTER COLUMN bijgewerkt_op SET NOT NULL;

ALTER TABLE public.feestdagen ADD CONSTRAINT feestdagen_pkey PRIMARY KEY (id);
ALTER TABLE public.feestdagen ADD CONSTRAINT feestdagen_type_check
  CHECK (type IN ('feestdag', 'sluitingsperiode'));
ALTER TABLE public.feestdagen ADD CONSTRAINT feestdagen_recurring_check
  CHECK (recurring IN ('jaarlijks', 'eenmalig'));
ALTER TABLE public.feestdagen ADD CONSTRAINT chk_sluitingsperiode_eind CHECK (
  (type = 'sluitingsperiode' AND datum_eind IS NOT NULL AND datum_eind >= datum)
  OR (type = 'feestdag' AND datum_eind IS NULL)
);
ALTER TABLE public.feestdagen ADD CONSTRAINT chk_label_min_length
  CHECK (length(trim(label)) >= 2);

-- ----------------------------------------------------------------
-- 6) COMMENTS
-- ----------------------------------------------------------------
COMMENT ON TABLE public.feestdagen IS
  'BE feestdagen + bedrijfs-sluitingsperiodes voor planning-soft-warning (Slot K).';
COMMENT ON COLUMN public.feestdagen.datum IS
  'Voor feestdag: de dag zelf. Voor sluitingsperiode: startdatum (incl).';
COMMENT ON COLUMN public.feestdagen.datum_eind IS
  'Verplicht bij type=sluitingsperiode (einddatum incl.). NULL bij feestdag.';
COMMENT ON COLUMN public.feestdagen.recurring IS
  'jaarlijks = wettelijke feestdag (auto-extend via edge function). eenmalig = ad-hoc.';

-- ----------------------------------------------------------------
-- 7) INDEXEN
-- ----------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_feestdagen_datum_label_uniq
  ON public.feestdagen (datum, label);
CREATE INDEX IF NOT EXISTS idx_feestdagen_datum
  ON public.feestdagen (datum);
CREATE INDEX IF NOT EXISTS idx_feestdagen_type_datum
  ON public.feestdagen (type, datum);

-- ----------------------------------------------------------------
-- 8) TRIGGER bijgewerkt_op
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.feestdagen_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.bijgewerkt_op := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_feestdagen_set_updated_at ON public.feestdagen;
CREATE TRIGGER trg_feestdagen_set_updated_at
  BEFORE UPDATE ON public.feestdagen
  FOR EACH ROW
  EXECUTE FUNCTION public.feestdagen_set_updated_at();

-- ----------------------------------------------------------------
-- 9) ROW LEVEL SECURITY
-- ----------------------------------------------------------------
ALTER TABLE public.feestdagen ENABLE ROW LEVEL SECURITY;

-- Cleanup legacy policies van v1-tabel (idempotent)
DROP POLICY IF EXISTS "feestdagen_admin_all" ON public.feestdagen;
DROP POLICY IF EXISTS "feestdagen_read_all" ON public.feestdagen;

DROP POLICY IF EXISTS "feestdagen_select_authenticated" ON public.feestdagen;
CREATE POLICY "feestdagen_select_authenticated"
  ON public.feestdagen
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "feestdagen_admin_write" ON public.feestdagen;
CREATE POLICY "feestdagen_admin_write"
  ON public.feestdagen
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = (SELECT auth.uid()) AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = (SELECT auth.uid()) AND role = 'admin')
  );

-- ----------------------------------------------------------------
-- 10) GRANTS — defense in depth
-- ----------------------------------------------------------------
REVOKE ALL ON public.feestdagen FROM anon;
REVOKE ALL ON public.feestdagen FROM authenticated;
GRANT SELECT ON public.feestdagen TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.feestdagen TO authenticated;

-- ----------------------------------------------------------------
-- 11) PRE-SEED 10 wettelijke BE feestdagen × 2026 + 2027
-- ----------------------------------------------------------------
-- Variabele data berekend via Computus (anonymous Gregorian algorithm):
--   Pasen 2026: 5 april   → Paasmaandag 6 april,  Hemelvaart 14 mei, Pinkstermaandag 25 mei
--   Pasen 2027: 28 maart  → Paasmaandag 29 maart, Hemelvaart  6 mei, Pinkstermaandag 17 mei
INSERT INTO public.feestdagen (datum, label, type, recurring) VALUES
  ('2026-01-01', 'Nieuwjaar',           'feestdag', 'jaarlijks'),
  ('2026-04-06', 'Paasmaandag',         'feestdag', 'jaarlijks'),
  ('2026-05-01', 'Dag van de Arbeid',   'feestdag', 'jaarlijks'),
  ('2026-05-14', 'O.L.H. Hemelvaart',   'feestdag', 'jaarlijks'),
  ('2026-05-25', 'Pinkstermaandag',     'feestdag', 'jaarlijks'),
  ('2026-07-21', 'Nationale Feestdag',  'feestdag', 'jaarlijks'),
  ('2026-08-15', 'O.L.V. Hemelvaart',   'feestdag', 'jaarlijks'),
  ('2026-11-01', 'Allerheiligen',       'feestdag', 'jaarlijks'),
  ('2026-11-11', 'Wapenstilstand',      'feestdag', 'jaarlijks'),
  ('2026-12-25', 'Kerstmis',            'feestdag', 'jaarlijks'),
  ('2027-01-01', 'Nieuwjaar',           'feestdag', 'jaarlijks'),
  ('2027-03-29', 'Paasmaandag',         'feestdag', 'jaarlijks'),
  ('2027-05-01', 'Dag van de Arbeid',   'feestdag', 'jaarlijks'),
  ('2027-05-06', 'O.L.H. Hemelvaart',   'feestdag', 'jaarlijks'),
  ('2027-05-17', 'Pinkstermaandag',     'feestdag', 'jaarlijks'),
  ('2027-07-21', 'Nationale Feestdag',  'feestdag', 'jaarlijks'),
  ('2027-08-15', 'O.L.V. Hemelvaart',   'feestdag', 'jaarlijks'),
  ('2027-11-01', 'Allerheiligen',       'feestdag', 'jaarlijks'),
  ('2027-11-11', 'Wapenstilstand',      'feestdag', 'jaarlijks'),
  ('2027-12-25', 'Kerstmis',            'feestdag', 'jaarlijks')
ON CONFLICT (datum, label) DO NOTHING;
