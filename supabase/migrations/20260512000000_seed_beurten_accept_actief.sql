-- ─── Fix: seed_onderhoudsbeurten_on_sign() accepteert ook status='actief' ─────
-- Calculator schrijft bij signing status='actief' (zie calculator/index.html
-- regel ~4517). De trigger checkte enkel 'getekend' — onderhoud-beurten werden
-- daardoor nooit auto-aangemaakt voor productie-signed contracts. Zelfde
-- patroon als notify_partner_on_contract_signed (PR #38).
--
-- Idempotency-check (IF NOT EXISTS WHERE contract_id) blijft ongewijzigd.

CREATE OR REPLACE FUNCTION public.seed_onderhoudsbeurten_on_sign()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  freq_per_jaar   integer;
  interval_months numeric;
  jaren           integer;
  num_beurten     integer;
  start_date      date;
  i               integer;
  computed_due    date;
  v_was_signed    boolean;
  v_is_signed     boolean;
BEGIN
  -- "Signed" = status IN ('actief', 'getekend'). 'actief' is huidige schrijfpad,
  -- 'getekend' is legacy maar nog steeds in CHECK-constraint toegestaan.
  v_is_signed := NEW.status IN ('actief', 'getekend');
  v_was_signed := (TG_OP = 'UPDATE') AND (OLD.status IN ('actief', 'getekend'));

  IF v_is_signed AND (TG_OP = 'INSERT' OR NOT v_was_signed) THEN
    IF NOT EXISTS (SELECT 1 FROM onderhoudsbeurten WHERE contract_id = NEW.id) THEN
      freq_per_jaar := CASE lower(COALESCE(NEW.frequentie, ''))
        WHEN 'jaarlijks'     THEN 1
        WHEN 'halfjaarlijks' THEN 2
        WHEN 'kwartaal'      THEN 4
        WHEN 'maandelijks'   THEN 12
        WHEN 'tweejaarlijks' THEN 1
        ELSE 1
      END;

      interval_months := CASE lower(COALESCE(NEW.frequentie, ''))
        WHEN 'halfjaarlijks' THEN 6
        WHEN 'kwartaal'      THEN 3
        WHEN 'maandelijks'   THEN 1
        WHEN 'tweejaarlijks' THEN 24
        ELSE 12
      END;

      jaren := COALESCE(
        NULLIF(regexp_replace(COALESCE(NEW.contractduur, ''), '[^0-9]', '', 'g'), '')::integer,
        1
      );

      IF COALESCE(NEW.is_eenmalig, false) = true
         OR lower(COALESCE(NEW.frequentie, '')) = 'eenmalig'
         OR lower(COALESCE(NEW.contractduur, '')) = 'eenmalig' THEN
        num_beurten := 1;
      ELSE
        IF lower(COALESCE(NEW.frequentie, '')) = 'tweejaarlijks' THEN
          num_beurten := GREATEST(1, CEIL(jaren::numeric / 2)::integer);
        ELSE
          num_beurten := GREATEST(1, freq_per_jaar * jaren);
        END IF;
      END IF;

      start_date := COALESCE(
        NEW.eerste_uitvoering_datum,
        NEW.datum_ondertekening,
        NEW.contract_start,
        CURRENT_DATE
      );

      FOR i IN 1..num_beurten LOOP
        computed_due := (start_date + (make_interval(months => ((i - 1) * interval_months)::integer)))::date;

        INSERT INTO onderhoudsbeurten (
          contract_id, client_id, client_location_id,
          status, sector, duur_minuten, opdracht_type,
          volgnummer, due_date
        ) VALUES (
          NEW.id,
          NEW.client_id,
          NEW.client_location_id,
          'in_te_plannen',
          NEW.sector,
          120,
          'contract',
          i,
          computed_due
        );
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
