-- Sprint 2.2 — duur_instellingen: herbouw tabel met partner-override support
-- Bestaande tabel verwijderen (was leeg en schema voldeed niet aan spec)
DROP TABLE IF EXISTS duur_instellingen CASCADE;

-- Helper trigger-function (idempotent, mag al bestaan elders in schema)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Nieuwe tabel volgens spec
CREATE TABLE duur_instellingen (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sector text NOT NULL,
  grootte_min integer NOT NULL,
  grootte_max integer,
  duur_minuten integer NOT NULL CHECK (duur_minuten > 0 AND duur_minuten <= 1440),
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  CHECK (grootte_max IS NULL OR grootte_max >= grootte_min)
);

CREATE INDEX idx_duur_instellingen_sector ON duur_instellingen(sector);
CREATE INDEX idx_duur_instellingen_partner ON duur_instellingen(partner_id) WHERE partner_id IS NOT NULL;

ALTER TABLE duur_instellingen ENABLE ROW LEVEL SECURITY;

-- Admin: volledige CRUD
CREATE POLICY "Admin full access duur" ON duur_instellingen
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin'));

-- Partner: read-only (eigen overrides + defaults)
CREATE POLICY "Partner read duur" ON duur_instellingen
  FOR SELECT TO authenticated
  USING (
    partner_id IS NULL
    OR EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid() AND partner_id = duur_instellingen.partner_id
    )
  );

-- Anon: read-only (calculator heeft anon-access nodig)
CREATE POLICY "Anon read duur" ON duur_instellingen
  FOR SELECT TO anon USING (true);

-- Updated-at trigger
CREATE TRIGGER set_duur_updated_at
  BEFORE UPDATE ON duur_instellingen
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SEED: defaults per sector (partner_id = NULL)
-- Grootte-metriek is sector-specifiek:
--   zonnepanelen      -> aantal panelen
--   warmtepomp_*      -> aantal binnenunits
--   ventilatie        -> aantal ventielen
--   verwarming        -> aantal ketels/toestellen
--   airco             -> aantal splits/binnenunits
--   ic / klussen      -> niet grootte-afhankelijk (1 default)
-- ============================================================
INSERT INTO duur_instellingen (sector, grootte_min, grootte_max, duur_minuten, partner_id) VALUES
  -- ZONNEPANELEN
  ('zonnepanelen', 1,  10,  60,  NULL),
  ('zonnepanelen', 11, 20,  90,  NULL),
  ('zonnepanelen', 21, 40,  120, NULL),
  ('zonnepanelen', 41, 60,  180, NULL),
  ('zonnepanelen', 61, NULL, 240, NULL),

  -- WARMTEPOMP LUCHT-LUCHT (estimated_hours 1.5u basis)
  ('warmtepomp_lucht_lucht', 1, 1,    90,  NULL),
  ('warmtepomp_lucht_lucht', 2, 3,    120, NULL),
  ('warmtepomp_lucht_lucht', 4, NULL, 180, NULL),

  -- WARMTEPOMP LUCHT-WATER (estimated_hours 2u basis)
  ('warmtepomp_lucht_water', 1, 1,    120, NULL),
  ('warmtepomp_lucht_water', 2, NULL, 180, NULL),

  -- WARMTEPOMP GEOTHERMIE/BODEM (estimated_hours 2.5u basis)
  ('warmtepomp_geothermie_water', 1, NULL, 150, NULL),

  -- VENTILATIE
  ('ventilatie', 1,  10,  60,  NULL),
  ('ventilatie', 11, 20,  90,  NULL),
  ('ventilatie', 21, NULL, 120, NULL),

  -- VERWARMING
  ('verwarming', 1, NULL, 60, NULL),

  -- AIRCO (losstaand)
  ('airco', 1, 1,    60,  NULL),
  ('airco', 2, 3,    90,  NULL),
  ('airco', 4, NULL, 120, NULL),

  -- IC — default hele dag (456 min = 7,6u = 38u/week / 5)
  ('ic', 1, NULL, 456, NULL),

  -- KLUSSEN — default 60 min
  ('klussen', 1, NULL, 60, NULL);
