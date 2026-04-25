-- =====================================================================
-- Soft-delete voor onderhoudsbeurten
-- =====================================================================
-- Doel: voorkomen dat een DELETE op onderhoudsbeurten via cascade
--       gerelateerde data (interventies, beurt_planning_dagen,
--       beurt_uren_registraties, rapporten, facturatie_regels,
--       materiaal_entries, werk_entries, klant_notification_log) wist.
--
-- Aanpak:
--   1. Tombstone-kolommen op onderhoudsbeurten (verwijderd_op,
--      verwijderd_door, verwijder_reden) + partial index voor actieve rijen.
--   2. RPC's soft_delete_beurt(uuid, text) en restore_beurt(uuid, text)
--      met SECURITY DEFINER en authorization via can_manage_planning().
--      Beide RPC's loggen naar audit_log met de hele rij als JSON.
--   3. View v_kalender_beurten gefilterd op verwijderd_op IS NULL zodat
--      tombstoned beurten niet meer in de kalender verschijnen.
--
-- Idempotent: gebruikt ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS
-- en CREATE OR REPLACE waar mogelijk.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Kolom-uitbreiding op onderhoudsbeurten
-- ---------------------------------------------------------------------
ALTER TABLE public.onderhoudsbeurten
  ADD COLUMN IF NOT EXISTS verwijderd_op    timestamptz,
  ADD COLUMN IF NOT EXISTS verwijderd_door  uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS verwijder_reden  text;

COMMENT ON COLUMN public.onderhoudsbeurten.verwijderd_op IS
  'Tijdstip van soft-delete. NULL = actieve beurt. Wordt gezet door RPC soft_delete_beurt.';
COMMENT ON COLUMN public.onderhoudsbeurten.verwijderd_door IS
  'auth.uid() van de gebruiker die de beurt soft-deleted heeft.';
COMMENT ON COLUMN public.onderhoudsbeurten.verwijder_reden IS
  'Vrije reden door operator opgegeven bij soft-delete (audittrail).';

-- Partial index: alle queries op actieve beurten gebruiken deze index;
-- soft-deleted rijen blijven leesbaar via aparte queries zonder filter.
CREATE INDEX IF NOT EXISTS idx_beurten_actief
  ON public.onderhoudsbeurten (plan_datum)
  WHERE verwijderd_op IS NULL;


-- ---------------------------------------------------------------------
-- 2a. RPC soft_delete_beurt
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.soft_delete_beurt(
  p_id     uuid,
  p_reden  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_oude_rij  text;
  v_user_id   uuid := auth.uid();
BEGIN
  -- Authorization: enkel admin of bediende met manage_planning permission.
  IF NOT public.can_manage_planning() THEN
    RAISE EXCEPTION 'Niet geautoriseerd om beurten te verwijderen'
      USING ERRCODE = '42501';
  END IF;

  -- Snapshot van de huidige rij voor audit-log.
  SELECT row_to_json(o.*)::text
    INTO v_oude_rij
    FROM public.onderhoudsbeurten AS o
   WHERE o.id = p_id
     AND o.verwijderd_op IS NULL;

  IF v_oude_rij IS NULL THEN
    RAISE EXCEPTION 'Beurt % bestaat niet of is reeds verwijderd', p_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Tombstone zetten (geen DELETE).
  UPDATE public.onderhoudsbeurten
     SET verwijderd_op   = now(),
         verwijderd_door = v_user_id,
         verwijder_reden = p_reden,
         updated_at      = now()
   WHERE id = p_id;

  -- Audit-log entry.
  INSERT INTO public.audit_log (
    tabel, record_id, actie, oude_waarde, nieuwe_waarde, user_id, created_at
  ) VALUES (
    'onderhoudsbeurten',
    p_id,
    'soft_delete',
    v_oude_rij,
    NULL,
    v_user_id,
    now()
  );
END;
$$;

COMMENT ON FUNCTION public.soft_delete_beurt(uuid, text) IS
  'Soft-delete een beurt door tombstone-kolommen te zetten i.p.v. DELETE. '
  'Vereist can_manage_planning(). Logt de oude rij naar audit_log.';


-- ---------------------------------------------------------------------
-- 2b. RPC restore_beurt
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restore_beurt(
  p_id     uuid,
  p_reden  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_oude_rij  text;
  v_user_id   uuid := auth.uid();
BEGIN
  -- Authorization: enkel admin of bediende met manage_planning permission.
  IF NOT public.can_manage_planning() THEN
    RAISE EXCEPTION 'Niet geautoriseerd om beurten te herstellen'
      USING ERRCODE = '42501';
  END IF;

  -- Snapshot van de tombstoned rij voor audit-log.
  SELECT row_to_json(o.*)::text
    INTO v_oude_rij
    FROM public.onderhoudsbeurten AS o
   WHERE o.id = p_id
     AND o.verwijderd_op IS NOT NULL;

  IF v_oude_rij IS NULL THEN
    RAISE EXCEPTION 'Beurt % bestaat niet of is niet verwijderd', p_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Tombstone weghalen (terug actief maken).
  UPDATE public.onderhoudsbeurten
     SET verwijderd_op   = NULL,
         verwijderd_door = NULL,
         verwijder_reden = NULL,
         updated_at      = now()
   WHERE id = p_id;

  -- Audit-log entry.
  INSERT INTO public.audit_log (
    tabel, record_id, actie, oude_waarde, nieuwe_waarde, user_id, created_at
  ) VALUES (
    'onderhoudsbeurten',
    p_id,
    'restore',
    v_oude_rij,
    p_reden,
    v_user_id,
    now()
  );
END;
$$;

COMMENT ON FUNCTION public.restore_beurt(uuid, text) IS
  'Herstelt een soft-deleted beurt door tombstone-kolommen op NULL te zetten. '
  'Vereist can_manage_planning(). Logt de actie naar audit_log met reden in nieuwe_waarde.';


-- ---------------------------------------------------------------------
-- 3. View v_kalender_beurten — filter soft-deleted beurten weg
-- ---------------------------------------------------------------------
-- Bestaande definitie verrijkt met o.verwijderd_op IS NULL filter.
CREATE OR REPLACE VIEW public.v_kalender_beurten AS
SELECT
  b.id,
  b.contract_id,
  b.sector,
  b.plan_datum,
  b.eind_datum,
  b.start_tijd,
  b.duur_minuten,
  b.hele_dag,
  b.status,
  b.technieker_id,
  b.extra_technieker_ids,
  b.parent_interventie_id,
  b.po_number,
  b.client_location_id,
  b.ref_nummer,
  b.notities,
  i.volgnummer    AS interventie_volgnummer,
  i.omschrijving  AS interventie_omschrijving,
  i.aantal_dagen  AS interventie_aantal_dagen,
  COALESCE(
    (
      SELECT array_agg(itd.technieker_id ORDER BY itd.rol)
        FROM public.interventie_technieker_dag itd
       WHERE itd.interventie_id = b.parent_interventie_id
         AND itd.datum = b.plan_datum
    ),
    ARRAY[]::uuid[]
  ) AS dag_technieker_ids
FROM public.onderhoudsbeurten b
LEFT JOIN public.interventies i ON i.id = b.parent_interventie_id
WHERE b.verwijderd_op IS NULL;

COMMENT ON VIEW public.v_kalender_beurten IS
  'Actieve onderhoudsbeurten voor de kalender-UI. Sluit soft-deleted beurten uit.';


-- ---------------------------------------------------------------------
-- 4. GRANTs
-- ---------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.soft_delete_beurt(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_beurt(uuid, text)     TO authenticated;
