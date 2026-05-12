-- Views voor Partner-afrekening pagina (admin + partner-portaal).
-- security_invoker=on → RLS van onderliggende tabellen wordt gerespecteerd:
-- admin ziet alle rijen, partner enkel eigen contracten via contracten RLS.

CREATE OR REPLACE VIEW public.v_partner_afrekening_per_beurt
WITH (security_invoker=on)
AS
SELECT
  b.id                                    AS beurt_id,
  b.contract_id,
  b.sector,
  b.volgnummer,
  b.plan_datum,
  b.eind_datum,
  b.status                                AS beurt_status,
  b.facturatie_status,
  b.gefactureerd_op,
  b.ref_nummer,
  c.partner_id,
  p.bedrijfsnaam                          AS partner_bedrijfsnaam,
  p.naam                                  AS partner_naam,
  p.slug                                  AS partner_slug,
  c.contract_nummer,
  c.klant_naam,
  c.klant_email,
  c.klant_gemeente,
  c.forfait_bedrag                        AS klant_forfait_per_beurt,
  c.flancco_forfait_per_beurt,
  c.planning_fee_snapshot,
  c.marge_pct_snapshot,
  COALESCE(c.flancco_forfait_per_beurt, 0)
    + COALESCE(c.planning_fee_snapshot, 0) AS te_betalen_aan_flancco,
  c.indexering_laatste_datum
FROM public.onderhoudsbeurten b
JOIN public.contracten c ON c.id = b.contract_id
JOIN public.partners   p ON p.id = c.partner_id
WHERE COALESCE(c.is_eenmalig, false) = false
  AND (b.status IN ('uitgevoerd','afgewerkt','ingepland','in_te_plannen'));

COMMENT ON VIEW public.v_partner_afrekening_per_beurt IS
  'Per onderhoudsbeurt de bevroren Flancco-portie + planning fee voor partner→Flancco settlement. RLS via security_invoker — admin ziet alles, partner enkel eigen beurten.';

CREATE OR REPLACE VIEW public.v_partner_afrekening_per_maand
WITH (security_invoker=on)
AS
SELECT
  partner_id,
  partner_bedrijfsnaam,
  partner_naam,
  partner_slug,
  date_trunc('month', COALESCE(eind_datum, plan_datum))::date AS maand,
  COUNT(*)                                AS aantal_beurten,
  COUNT(*) FILTER (WHERE beurt_status IN ('uitgevoerd','afgewerkt'))
                                          AS aantal_uitgevoerd,
  SUM(COALESCE(flancco_forfait_per_beurt,0)) AS totaal_flancco_forfait,
  SUM(COALESCE(planning_fee_snapshot,0))     AS totaal_planning_fee,
  SUM(te_betalen_aan_flancco)                AS totaal_te_betalen_aan_flancco,
  COUNT(*) FILTER (WHERE gefactureerd_op IS NOT NULL)
                                          AS aantal_gefactureerd,
  SUM(te_betalen_aan_flancco) FILTER (WHERE gefactureerd_op IS NULL)
                                          AS openstaand_te_factureren
FROM public.v_partner_afrekening_per_beurt
WHERE COALESCE(eind_datum, plan_datum) IS NOT NULL
GROUP BY partner_id, partner_bedrijfsnaam, partner_naam, partner_slug,
         date_trunc('month', COALESCE(eind_datum, plan_datum));

COMMENT ON VIEW public.v_partner_afrekening_per_maand IS
  'Maand-totalen per partner voor Flancco→Partner settlement. Aggregeert v_partner_afrekening_per_beurt. RLS via security_invoker.';
