-- Meerjaren-tier architectuur 2026-05-13
-- Vervangt "5% korting bij meerjaren" door "vaste prijs eerste X jaren":
--   - 3-jaar contract → vaste prijs tot eind jaar 2 → 1e indexering = contract_start + 2y
--   - 5-jaar contract → vaste prijs tot eind jaar 3 → 1e indexering = contract_start + 3y
--   - 1-jaar / eenmalig → standaard (1e indexering op verjaardag jaar 2)
--
-- Flancco-forfait blijft 100% intact ongeacht klantkorting (geen meerjaren-discount meer).
-- Klantvoordeel komt nu uit "vaste prijs" (uitstel van jaarlijkse indexering) i.p.v.
-- procentuele korting die de marge zou aantasten.

-- ─── 1. Nieuwe kolom: datum eerste indexering ─────────────────────────
ALTER TABLE public.contracten
  ADD COLUMN IF NOT EXISTS indexering_eerste_aanpassing_op DATE NULL;

COMMENT ON COLUMN public.contracten.indexering_eerste_aanpassing_op IS
  'Datum waarop de eerste jaarlijkse indexering volgens gezondheidsindex toegepast mag worden. Bij meerjaren-contracten (3j/5j) is dit vooruitgeschoven om "vaste prijs" tier-voordeel te garanderen. NULL = geen indexering (eenmalig of indexering_type=geen).';

-- ─── 2. Trigger-functie: bereken eerste aanpassing op basis van duur ─
CREATE OR REPLACE FUNCTION public.set_indexering_eerste_aanpassing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_duur_jaren INT;
BEGIN
  -- Skip indien geen capped-indexering of geen startdatum
  IF NEW.indexering_type <> 'gezondheidsindex_capped' OR NEW.contract_start IS NULL THEN
    NEW.indexering_eerste_aanpassing_op := NULL;
    RETURN NEW;
  END IF;

  -- Parse duur uit text-veld ('3 jaar' → 3, '5 jaar' → 5, 'eenmalig' / '' → 0)
  v_duur_jaren := COALESCE((substring(NEW.contractduur FROM '^([0-9]+)'))::INT, 0);

  -- Meerjaren-tier vaste-prijs:
  --   3 jaar → 1e indexering pas in jaar 3 (= start + 2 jaar)
  --   5 jaar → 1e indexering pas in jaar 4 (= start + 3 jaar)
  --   1 jaar → standaard (= start + 1 jaar)
  --   eenmalig / 0 → geen indexering (NULL)
  IF v_duur_jaren = 5 THEN
    NEW.indexering_eerste_aanpassing_op := NEW.contract_start + INTERVAL '3 year';
  ELSIF v_duur_jaren = 3 THEN
    NEW.indexering_eerste_aanpassing_op := NEW.contract_start + INTERVAL '2 year';
  ELSIF v_duur_jaren = 1 THEN
    NEW.indexering_eerste_aanpassing_op := NEW.contract_start + INTERVAL '1 year';
  ELSE
    NEW.indexering_eerste_aanpassing_op := NULL;
  END IF;

  RETURN NEW;
END;
$func$;

-- Defense-in-depth: enkel via trigger-pad
REVOKE EXECUTE ON FUNCTION public.set_indexering_eerste_aanpassing() FROM PUBLIC, anon, authenticated;

-- ─── 3. Trigger op contracten (INSERT + UPDATE van relevante velden) ─
DROP TRIGGER IF EXISTS trg_contracten_set_indexering_eerste_aanpassing ON public.contracten;
CREATE TRIGGER trg_contracten_set_indexering_eerste_aanpassing
  BEFORE INSERT OR UPDATE OF contract_start, contractduur, indexering_type
  ON public.contracten
  FOR EACH ROW EXECUTE FUNCTION public.set_indexering_eerste_aanpassing();

-- ─── 4. Update cron-function: respecteer uitgestelde indexering ──────
-- Nieuwe WHERE-clause: `(indexering_eerste_aanpassing_op IS NULL OR <= CURRENT_DATE)`
-- Bestaande Wave 5 logica blijft intact (verjaardag-check, last_datum-deduplicatie).
CREATE OR REPLACE FUNCTION public.apply_yearly_contract_indexering(p_dry_run BOOLEAN DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_contract RECORD; v_current_idx NUMERIC; v_raw_pct NUMERIC; v_capped_pct NUMERIC;
  v_new_forfait NUMERIC; v_new_flancco NUMERIC; v_new_plan_fee NUMERIC;
  v_count_processed INT := 0; v_count_applied INT := 0; v_errors jsonb := '[]'::jsonb;
BEGIN
  SELECT waarde INTO v_current_idx FROM public.gezondheidsindex_metingen ORDER BY jaar DESC, maand DESC LIMIT 1;
  IF v_current_idx IS NULL THEN RETURN jsonb_build_object('error', 'no_gezondheidsindex_available'); END IF;

  FOR v_contract IN
    SELECT id, partner_id, forfait_bedrag, flancco_forfait_per_beurt, planning_fee_snapshot,
           indexering_start_index, indexering_min_pct, indexering_max_pct, contract_start
      FROM public.contracten
     WHERE indexering_type = 'gezondheidsindex_capped'
       AND status IN ('actief','getekend')
       AND contract_start IS NOT NULL
       AND indexering_start_index IS NOT NULL
       AND EXTRACT(MONTH FROM contract_start) = EXTRACT(MONTH FROM CURRENT_DATE)
       AND EXTRACT(DAY   FROM contract_start) = EXTRACT(DAY   FROM CURRENT_DATE)
       AND EXTRACT(YEAR  FROM contract_start) <  EXTRACT(YEAR  FROM CURRENT_DATE)
       AND (indexering_laatste_datum IS NULL OR indexering_laatste_datum <> CURRENT_DATE)
       -- Meerjaren-tier check: bij 3j/5j wordt eerste indexering uitgesteld
       AND (indexering_eerste_aanpassing_op IS NULL OR indexering_eerste_aanpassing_op <= CURRENT_DATE)
  LOOP
    v_count_processed := v_count_processed + 1;
    BEGIN
      v_raw_pct := ((v_current_idx / v_contract.indexering_start_index) - 1) * 100;
      v_capped_pct := LEAST(GREATEST(v_raw_pct, v_contract.indexering_min_pct), v_contract.indexering_max_pct);
      v_new_forfait  := ROUND(v_contract.forfait_bedrag           * (1 + v_capped_pct / 100), 2);
      v_new_flancco  := ROUND(v_contract.flancco_forfait_per_beurt * (1 + v_capped_pct / 100), 2);
      v_new_plan_fee := ROUND(v_contract.planning_fee_snapshot    * (1 + v_capped_pct / 100), 2);

      IF NOT p_dry_run THEN
        UPDATE public.contracten
           SET forfait_bedrag = v_new_forfait, flancco_forfait_per_beurt = v_new_flancco,
               planning_fee_snapshot = v_new_plan_fee, indexering_laatste_datum = CURRENT_DATE
         WHERE id = v_contract.id;

        INSERT INTO public.contract_indexering_log
          (contract_id, toegepast_op, oude_forfait, nieuwe_forfait, oude_flancco_forfait, nieuwe_flancco_forfait,
           pct_toegepast, basis_index, toegepaste_index, uitgevoerd_door)
        VALUES (v_contract.id, CURRENT_DATE, v_contract.forfait_bedrag, v_new_forfait,
                v_contract.flancco_forfait_per_beurt, v_new_flancco, v_capped_pct,
                v_contract.indexering_start_index, v_current_idx, 'cron');
      END IF;
      v_count_applied := v_count_applied + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_object('contract_id', v_contract.id, 'sqlstate', SQLSTATE, 'msg', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('count_processed', v_count_processed, 'count_applied', v_count_applied,
    'index_used', v_current_idx, 'dry_run', p_dry_run, 'errors', v_errors);
END;
$func$;
