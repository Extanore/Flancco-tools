-- =====================================================================
-- Migratie: EW (Economische Werkloosheid) extensies
-- Datum   : 2026-04-23
-- Scope   : Uitbreiding technieker_afwezigheden + helpers voor EW-flow
-- Beslissing: EW is een subtype van verlof via verlof_type_id;
--             geen aparte economische_werkloosheid-tabel.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. Kolom-uitbreidingen technieker_afwezigheden
-- ---------------------------------------------------------------------
ALTER TABLE technieker_afwezigheden
  ADD COLUMN IF NOT EXISTS verwijderd_op timestamptz,
  ADD COLUMN IF NOT EXISTS verwijderd_door uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS verwijder_reden text,
  ADD COLUMN IF NOT EXISTS ew_sub_reden text,
  ADD COLUMN IF NOT EXISTS ew_sector text,
  ADD COLUMN IF NOT EXISTS dimona_gemeld boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dimona_melding_datum timestamptz,
  ADD COLUMN IF NOT EXISTS opmerking text;

-- ---------------------------------------------------------------------
-- B. CHECK-constraint op ew_sub_reden
-- ---------------------------------------------------------------------
ALTER TABLE technieker_afwezigheden
  DROP CONSTRAINT IF EXISTS technieker_afwezigheden_ew_sub_reden_check;

ALTER TABLE technieker_afwezigheden
  ADD CONSTRAINT technieker_afwezigheden_ew_sub_reden_check
  CHECK (ew_sub_reden IS NULL OR ew_sub_reden IN (
    'gebrek_aan_werk',
    'seizoensschommeling',
    'weersomstandigheden',
    'technische_stoornis',
    'overige'
  ));

-- ---------------------------------------------------------------------
-- C. Indexen voor EW-queries (performance)
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_afwezigheden_verlof_type_datum
  ON technieker_afwezigheden(verlof_type_id, van_datum)
  WHERE verwijderd_op IS NULL;

CREATE INDEX IF NOT EXISTS idx_afwezigheden_dimona_niet_gemeld
  ON technieker_afwezigheden(dimona_gemeld, van_datum)
  WHERE verwijderd_op IS NULL AND dimona_gemeld = false;

-- ---------------------------------------------------------------------
-- D. Kolom-uitbreiding techniekers (geboortedatum)
-- ---------------------------------------------------------------------
ALTER TABLE techniekers
  ADD COLUMN IF NOT EXISTS geboortedatum date;

-- ---------------------------------------------------------------------
-- E. Helper-function can_manage_planning() — SECURITY DEFINER
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_manage_planning()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = auth.uid()
      AND (
        ur.role = 'admin'
        OR (ur.role = 'bediende' AND (ur.permissions->>'manage_planning')::boolean = true)
      )
  );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_planning() TO authenticated;

-- ---------------------------------------------------------------------
-- F. RLS-policies op technieker_afwezigheden voor planners
--    (bestaande admin_all_technieker_afwezigheden policy blijft intact)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS afwez_planner_select ON technieker_afwezigheden;
CREATE POLICY afwez_planner_select ON technieker_afwezigheden
  FOR SELECT TO authenticated
  USING (can_manage_planning());

DROP POLICY IF EXISTS afwez_planner_insert ON technieker_afwezigheden;
CREATE POLICY afwez_planner_insert ON technieker_afwezigheden
  FOR INSERT TO authenticated
  WITH CHECK (can_manage_planning());

DROP POLICY IF EXISTS afwez_planner_update ON technieker_afwezigheden;
CREATE POLICY afwez_planner_update ON technieker_afwezigheden
  FOR UPDATE TO authenticated
  USING (can_manage_planning())
  WITH CHECK (can_manage_planning());

-- Bewuste keuze: geen DELETE policy voor planners.
-- Soft-delete verloopt via UPDATE verwijderd_op.

-- ---------------------------------------------------------------------
-- G. SQL-function check_afwezigheid_conflict
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_afwezigheid_conflict(
  p_technieker_id uuid,
  p_datum date,
  p_halve_dag text DEFAULT NULL,
  p_exclude_id uuid DEFAULT NULL
)
RETURNS TABLE(conflict_type text, conflict_id uuid, detail text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT 'afwezigheid'::text AS conflict_type,
         a.id AS conflict_id,
         COALESCE(vt.naam, 'Onbekend') || ' (' || a.van_datum::text ||
           CASE WHEN a.van_datum <> a.tot_datum THEN ' tot ' || a.tot_datum::text ELSE '' END ||
           ')' AS detail
  FROM technieker_afwezigheden a
  LEFT JOIN verlof_types vt ON vt.id = a.verlof_type_id
  WHERE a.technieker_id = p_technieker_id
    AND a.verwijderd_op IS NULL
    AND (p_exclude_id IS NULL OR a.id <> p_exclude_id)
    AND p_datum BETWEEN a.van_datum AND a.tot_datum
    AND (
      p_halve_dag IS NULL
      OR a.halve_dag IS NULL
      OR a.halve_dag = p_halve_dag
    )
  UNION ALL
  SELECT 'planning'::text,
         b.id,
         'Gepland: ' || COALESCE(NULLIF(b.status, ''), 'onderhoudsbeurt') ||
           COALESCE(' om ' || b.start_tijd::text, '')
  FROM onderhoudsbeurten b
  WHERE b.plan_datum = p_datum
    AND b.status NOT IN ('afgelast','geannuleerd')
    AND (b.technieker_id = p_technieker_id
         OR p_technieker_id = ANY(COALESCE(b.extra_technieker_ids, ARRAY[]::uuid[])))
  UNION ALL
  SELECT 'interventie'::text,
         itd.id,
         'Ingepland op interventie'
  FROM interventie_technieker_dag itd
  WHERE itd.datum = p_datum
    AND itd.technieker_id = p_technieker_id
  UNION ALL
  SELECT 'feestdag'::text,
         NULL::uuid,
         f.naam || ' (' || p_datum::text || ')'
  FROM feestdagen f
  WHERE f.datum = p_datum
  UNION ALL
  SELECT 'weekend'::text,
         NULL::uuid,
         'Zaterdag/zondag is geen werkdag'
  WHERE EXTRACT(DOW FROM p_datum) IN (0, 6);
$$;

GRANT EXECUTE ON FUNCTION public.check_afwezigheid_conflict(uuid, date, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- H. View voor EW dashboard-tegel (laatste 12 maanden)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_ew_maand_stats AS
SELECT
  date_trunc('month', gs.maand)::date AS maand,
  COUNT(DISTINCT a.id) FILTER (
    WHERE a.verlof_type_id = 'd5d9687d-d480-4ec1-b3c8-94bb26114e95'::uuid
      AND a.verwijderd_op IS NULL
  ) AS ew_registraties,
  COALESCE(SUM(
    CASE
      WHEN a.verlof_type_id <> 'd5d9687d-d480-4ec1-b3c8-94bb26114e95'::uuid THEN 0
      WHEN a.verwijderd_op IS NOT NULL THEN 0
      WHEN a.halve_dag IS NOT NULL THEN 0.5
      ELSE (a.tot_datum - a.van_datum + 1)
    END
  ), 0) AS ew_dagen_equiv,
  COUNT(*) FILTER (
    WHERE a.verlof_type_id = 'd5d9687d-d480-4ec1-b3c8-94bb26114e95'::uuid
      AND a.verwijderd_op IS NULL
      AND a.dimona_gemeld = false
  ) AS dimona_todo
FROM generate_series(
  date_trunc('month', current_date - interval '11 months')::date,
  date_trunc('month', current_date)::date,
  interval '1 month'
) AS gs(maand)
LEFT JOIN technieker_afwezigheden a
  ON date_trunc('month', a.van_datum) = date_trunc('month', gs.maand)
GROUP BY gs.maand
ORDER BY gs.maand;

GRANT SELECT ON v_ew_maand_stats TO authenticated;

-- ---------------------------------------------------------------------
-- I. Commentaar op kolommen en functies
-- ---------------------------------------------------------------------
COMMENT ON COLUMN technieker_afwezigheden.ew_sub_reden IS 'Sub-reden voor EW-registraties. NULL voor niet-EW verlof.';
COMMENT ON COLUMN technieker_afwezigheden.ew_sector IS 'Optionele sector-slug voor EW (voor sector-P&L rapportage).';
COMMENT ON COLUMN technieker_afwezigheden.dimona_gemeld IS 'TRUE zodra EW-dag via Dimona C3.2A is doorgegeven aan RVA/sociaal secretariaat.';
COMMENT ON COLUMN technieker_afwezigheden.verwijderd_op IS 'Soft-delete timestamp. NULL = actief record.';
COMMENT ON FUNCTION can_manage_planning() IS 'TRUE als user admin is of bediende met manage_planning-permission.';
COMMENT ON FUNCTION check_afwezigheid_conflict(uuid, date, text, uuid) IS 'Returnt overlappende afwezigheid/planning/interventie/feestdag/weekend voor conflict-checks bij EW-registratie.';
