-- Slot Z: partner-rol kan operationele/commerciele kolommen op partners-tabel
-- niet meer wijzigen. Bestaande protect_partner_commercial_fields trigger uitgebreid
-- met SLA-velden + array-stijl errors voor multi-col updates.
-- Backend-verdedigingslinie naast frontend disabled inputs.
-- Beschermde kolommen: slug, marge_pct, planning_fee, transport_gratis_km,
-- akkoord_flancco_inzage, akkoord_datum, contract_getekend, contract_datum,
-- actief, sla_fase_1/2/4/5_uren.

CREATE OR REPLACE FUNCTION public.protect_partner_commercial_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_locked TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- Admin / service-role / pg_cron (auth.uid() = NULL) → toelaten
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT role INTO v_role FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;

  IF v_role IS NULL OR v_role = 'admin' THEN
    RETURN NEW;
  END IF;

  -- Partner-rol: verzamel beschermde kolommen die wijzigen
  IF NEW.marge_pct IS DISTINCT FROM OLD.marge_pct THEN v_locked := array_append(v_locked, 'marge_pct'); END IF;
  IF NEW.planning_fee IS DISTINCT FROM OLD.planning_fee THEN v_locked := array_append(v_locked, 'planning_fee'); END IF;
  IF NEW.transport_gratis_km IS DISTINCT FROM OLD.transport_gratis_km THEN v_locked := array_append(v_locked, 'transport_gratis_km'); END IF;
  IF NEW.akkoord_flancco_inzage IS DISTINCT FROM OLD.akkoord_flancco_inzage THEN v_locked := array_append(v_locked, 'akkoord_flancco_inzage'); END IF;
  IF NEW.akkoord_datum IS DISTINCT FROM OLD.akkoord_datum THEN v_locked := array_append(v_locked, 'akkoord_datum'); END IF;
  IF NEW.contract_getekend IS DISTINCT FROM OLD.contract_getekend THEN v_locked := array_append(v_locked, 'contract_getekend'); END IF;
  IF NEW.contract_datum IS DISTINCT FROM OLD.contract_datum THEN v_locked := array_append(v_locked, 'contract_datum'); END IF;
  IF NEW.actief IS DISTINCT FROM OLD.actief THEN v_locked := array_append(v_locked, 'actief'); END IF;
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN v_locked := array_append(v_locked, 'slug'); END IF;
  -- Slot Z uitbreiding: SLA-velden zijn Flancco-operationeel (sla per partner per fase)
  IF NEW.sla_fase_1_uren IS DISTINCT FROM OLD.sla_fase_1_uren THEN v_locked := array_append(v_locked, 'sla_fase_1_uren'); END IF;
  IF NEW.sla_fase_2_uren IS DISTINCT FROM OLD.sla_fase_2_uren THEN v_locked := array_append(v_locked, 'sla_fase_2_uren'); END IF;
  IF NEW.sla_fase_4_uren IS DISTINCT FROM OLD.sla_fase_4_uren THEN v_locked := array_append(v_locked, 'sla_fase_4_uren'); END IF;
  IF NEW.sla_fase_5_uren IS DISTINCT FROM OLD.sla_fase_5_uren THEN v_locked := array_append(v_locked, 'sla_fase_5_uren'); END IF;

  IF array_length(v_locked, 1) > 0 THEN
    RAISE EXCEPTION 'Partners kunnen deze velden niet aanpassen: %', array_to_string(v_locked, ', ')
      USING ERRCODE = '42501', HINT = 'Deze instellingen worden door Flancco beheerd. Neem contact op om wijzigingen aan te vragen.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.protect_partner_commercial_fields() FROM anon, authenticated, PUBLIC;

COMMENT ON FUNCTION public.protect_partner_commercial_fields() IS
  'Slot Z (uitgebreid): blokkeert partner-rol wijziging van operationele/commerciele kolommen op partners-tabel. Admin + service-role mogen alles. Backend-verdedigingslinie naast frontend disabled inputs. Gerapporteerd in array-stijl voor multi-col updates.';
