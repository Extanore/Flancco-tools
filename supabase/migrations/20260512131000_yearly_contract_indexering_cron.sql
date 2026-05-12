-- ============================================================
-- Yearly contract-indexering (gezondheidsindex_capped)
-- ============================================================
-- Op de contract-verjaardag worden alle prijs-velden van een actief
-- contract aangepast op basis van de Belgische gezondheidsindex, met
-- een cap tussen contract.indexering_min_pct (default 1.5%) en
-- contract.indexering_max_pct (default 4.0%).
--
-- Formule:
--   raw_pct  = (huidige_index / indexering_start_index - 1) * 100
--   pct_used = LEAST(GREATEST(raw_pct, min_pct), max_pct)
--   nieuw    = ROUND(oud * (1 + pct_used/100), 2)
--
-- Geïndexeerde kolommen:
--   - forfait_bedrag                (klant-prijs excl. btw, per beurt)
--   - flancco_forfait_per_beurt     (snapshot Flancco-basis)
--   - planning_fee_snapshot         (snapshot partner planning fee)
--   - supplement_vervuiling
--   - supplement_transport
--   - supplement_hoogte
--   - totaal_incl_btw
--   + indexering_laatste_datum = CURRENT_DATE (markering)
--
-- Filters:
--   - indexering_type = 'gezondheidsindex_capped'
--   - status IN ('actief','getekend')
--   - contract_start IS NOT NULL en EXTRACT(MONTH/DAY) = today
--   - EXTRACT(YEAR FROM contract_start) < EXTRACT(YEAR FROM CURRENT_DATE)
--     (geen contract dat vandaag start)
--   - indexering_laatste_datum IS DISTINCT FROM CURRENT_DATE
--   - indexering_start_index IS NOT NULL
--
-- Audit:
--   - INSERT in contract_indexering_log met (oude_*, nieuwe_*, pct_toegepast,
--     basis_index = start_index, toegepaste_index = huidige_index, uitgevoerd_door='cron')
--
-- Cron: 01:30 UTC dagelijks ('30 1 * * *'). Job-naam: apply_yearly_contract_indexering_daily.
--
-- Dry-run: `SELECT public.apply_yearly_contract_indexering(TRUE);` voert geen UPDATE
-- of INSERT uit; alleen het JSON-resultaat met "would-be-effects".
-- ============================================================

CREATE OR REPLACE FUNCTION public.apply_yearly_contract_indexering(p_dry_run boolean DEFAULT FALSE)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_huidig_index    numeric;
  v_huidig_jaar     int;
  v_huidig_maand    int;
  v_contract        RECORD;
  v_raw_pct         numeric;
  v_pct_used        numeric;
  v_factor          numeric;
  v_count_proc      int := 0;
  v_count_appl      int := 0;
  v_count_fail      int := 0;
  v_count_skip      int := 0;
  v_errors          jsonb := '[]'::jsonb;
  v_results         jsonb := '[]'::jsonb;
  v_oud_forfait     numeric;
  v_oud_flancco     numeric;
  v_oud_planfee     numeric;
  v_oud_vervuil     numeric;
  v_oud_transp      numeric;
  v_oud_hoog        numeric;
  v_oud_totaal      numeric;
  v_new_forfait     numeric;
  v_new_flancco     numeric;
  v_new_planfee     numeric;
  v_new_vervuil     numeric;
  v_new_transp      numeric;
  v_new_hoog        numeric;
  v_new_totaal      numeric;
BEGIN
  -- 1) Meest recente gezondheidsindex-meting ophalen
  SELECT waarde, jaar, maand
    INTO v_huidig_index, v_huidig_jaar, v_huidig_maand
    FROM public.gezondheidsindex_metingen
   ORDER BY jaar DESC, maand DESC
   LIMIT 1;

  IF v_huidig_index IS NULL THEN
    RAISE WARNING 'apply_yearly_contract_indexering: geen gezondheidsindex_metingen aanwezig — skip.';
    RETURN jsonb_build_object(
      'error', 'no_index_meting',
      'count_processed', 0,
      'count_applied',   0,
      'count_failed',    0,
      'count_skipped',   0
    );
  END IF;

  -- 2) Loop alle eligible contracten waarvan vandaag de verjaardag is
  FOR v_contract IN
    SELECT
      id, partner_id, contract_start,
      indexering_min_pct, indexering_max_pct, indexering_start_index,
      forfait_bedrag, flancco_forfait_per_beurt, planning_fee_snapshot,
      supplement_vervuiling, supplement_transport, supplement_hoogte,
      totaal_incl_btw, btw_type
      FROM public.contracten
     WHERE indexering_type = 'gezondheidsindex_capped'
       AND status IN ('actief','getekend')
       AND contract_start IS NOT NULL
       AND EXTRACT(MONTH FROM contract_start) = EXTRACT(MONTH FROM CURRENT_DATE)
       AND EXTRACT(DAY   FROM contract_start) = EXTRACT(DAY   FROM CURRENT_DATE)
       AND EXTRACT(YEAR  FROM contract_start) < EXTRACT(YEAR  FROM CURRENT_DATE)
       AND (indexering_laatste_datum IS DISTINCT FROM CURRENT_DATE)
       AND indexering_start_index IS NOT NULL
       AND indexering_start_index > 0
  LOOP
    v_count_proc := v_count_proc + 1;

    BEGIN
      -- Bereken raw + capped pct
      v_raw_pct  := (v_huidig_index / v_contract.indexering_start_index - 1) * 100;
      v_pct_used := LEAST(
                      GREATEST(v_raw_pct, COALESCE(v_contract.indexering_min_pct, 1.5)),
                      COALESCE(v_contract.indexering_max_pct, 4.0)
                    );
      v_factor   := 1 + (v_pct_used / 100.0);

      v_oud_forfait := v_contract.forfait_bedrag;
      v_oud_flancco := v_contract.flancco_forfait_per_beurt;
      v_oud_planfee := v_contract.planning_fee_snapshot;
      v_oud_vervuil := v_contract.supplement_vervuiling;
      v_oud_transp  := v_contract.supplement_transport;
      v_oud_hoog    := v_contract.supplement_hoogte;
      v_oud_totaal  := v_contract.totaal_incl_btw;

      v_new_forfait := CASE WHEN v_oud_forfait IS NULL THEN NULL ELSE ROUND(v_oud_forfait * v_factor, 2) END;
      v_new_flancco := CASE WHEN v_oud_flancco IS NULL THEN NULL ELSE ROUND(v_oud_flancco * v_factor, 2) END;
      v_new_planfee := CASE WHEN v_oud_planfee IS NULL THEN NULL ELSE ROUND(v_oud_planfee * v_factor, 2) END;
      v_new_vervuil := CASE WHEN v_oud_vervuil IS NULL THEN NULL ELSE ROUND(v_oud_vervuil * v_factor, 2) END;
      v_new_transp  := CASE WHEN v_oud_transp  IS NULL THEN NULL ELSE ROUND(v_oud_transp  * v_factor, 2) END;
      v_new_hoog    := CASE WHEN v_oud_hoog    IS NULL THEN NULL ELSE ROUND(v_oud_hoog    * v_factor, 2) END;
      v_new_totaal  := CASE WHEN v_oud_totaal  IS NULL THEN NULL ELSE ROUND(v_oud_totaal  * v_factor, 2) END;

      IF NOT p_dry_run THEN
        UPDATE public.contracten
           SET forfait_bedrag           = COALESCE(v_new_forfait, forfait_bedrag),
               flancco_forfait_per_beurt = COALESCE(v_new_flancco, flancco_forfait_per_beurt),
               planning_fee_snapshot    = COALESCE(v_new_planfee, planning_fee_snapshot),
               supplement_vervuiling    = COALESCE(v_new_vervuil, supplement_vervuiling),
               supplement_transport     = COALESCE(v_new_transp,  supplement_transport),
               supplement_hoogte        = COALESCE(v_new_hoog,    supplement_hoogte),
               totaal_incl_btw          = COALESCE(v_new_totaal,  totaal_incl_btw),
               indexering_laatste_datum = CURRENT_DATE,
               updated_at               = NOW()
         WHERE id = v_contract.id;

        INSERT INTO public.contract_indexering_log (
          contract_id, toegepast_op,
          oude_forfait, nieuwe_forfait,
          oude_flancco_forfait, nieuwe_flancco_forfait,
          pct_toegepast, basis_index, toegepaste_index, uitgevoerd_door
        ) VALUES (
          v_contract.id, CURRENT_DATE,
          COALESCE(v_oud_forfait, 0), COALESCE(v_new_forfait, COALESCE(v_oud_forfait, 0)),
          v_oud_flancco, v_new_flancco,
          v_pct_used, v_contract.indexering_start_index, v_huidig_index, 'cron'
        );
      END IF;

      v_count_appl := v_count_appl + 1;

      v_results := v_results || jsonb_build_object(
        'contract_id',     v_contract.id,
        'partner_id',      v_contract.partner_id,
        'raw_pct',         v_raw_pct,
        'pct_used',        v_pct_used,
        'oud_forfait',     v_oud_forfait,
        'nieuw_forfait',   v_new_forfait,
        'oud_totaal',      v_oud_totaal,
        'nieuw_totaal',    v_new_totaal,
        'dry_run',         p_dry_run
      );

    EXCEPTION WHEN OTHERS THEN
      v_count_fail := v_count_fail + 1;
      v_errors := v_errors || jsonb_build_object(
        'contract_id', v_contract.id,
        'sqlstate', SQLSTATE,
        'message',  SQLERRM
      );
      RAISE WARNING 'apply_yearly_contract_indexering: contract_id=% failed: % %', v_contract.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE 'apply_yearly_contract_indexering: dry_run=% processed=% applied=% failed=% skipped=%',
    p_dry_run, v_count_proc, v_count_appl, v_count_fail, v_count_skip;

  RETURN jsonb_build_object(
    'dry_run',         p_dry_run,
    'index_used',      v_huidig_index,
    'index_jaar',      v_huidig_jaar,
    'index_maand',     v_huidig_maand,
    'count_processed', v_count_proc,
    'count_applied',   v_count_appl,
    'count_failed',    v_count_fail,
    'count_skipped',   v_count_skip,
    'errors',          v_errors,
    'details',         v_results
  );
END;
$$;

COMMENT ON FUNCTION public.apply_yearly_contract_indexering(boolean)
  IS 'Past gezondheidsindex_capped indexering toe op contracten waarvan vandaag de verjaardag is. p_dry_run=TRUE → bereken alleen, geen UPDATE/INSERT.';

REVOKE ALL ON FUNCTION public.apply_yearly_contract_indexering(boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_yearly_contract_indexering(boolean) FROM anon;
REVOKE ALL ON FUNCTION public.apply_yearly_contract_indexering(boolean) FROM authenticated;
-- postgres (job-owner) behoudt EXECUTE.

-- Optioneel: admin-only GRANT zodat een admin via PostgREST/RPC dry-run kan triggeren.
-- We laten dit voorlopig dicht — admin kan via SQL Editor de functie aanroepen.

-- ----------------------------------------------------------------
-- PG_CRON JOB — 01:30 UTC dagelijks
-- ----------------------------------------------------------------
DO $$
DECLARE
  v_existing_jobid bigint;
BEGIN
  SELECT jobid INTO v_existing_jobid FROM cron.job WHERE jobname = 'apply_yearly_contract_indexering_daily';
  IF v_existing_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_existing_jobid);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'apply_yearly_contract_indexering_daily unschedule fout: %', SQLERRM;
END $$;

SELECT cron.schedule(
  'apply_yearly_contract_indexering_daily',
  '30 1 * * *',
  $$SELECT public.apply_yearly_contract_indexering(FALSE);$$
);

-- ----------------------------------------------------------------
-- ROLLBACK (handmatig)
-- ----------------------------------------------------------------
-- SELECT cron.unschedule((SELECT jobid FROM cron.job WHERE jobname='apply_yearly_contract_indexering_daily'));
-- DROP FUNCTION IF EXISTS public.apply_yearly_contract_indexering(boolean);
