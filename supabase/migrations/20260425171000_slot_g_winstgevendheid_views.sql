-- =============================================================================
-- Slot G — Winstgevendheid (drie aggregatie-views)
-- =============================================================================
-- Vervangt de vroegere "forecast"-pagina door drie analytische views die
-- brutomarge tonen per partner, per sector en per technieker, met YTD-periode
-- (lopend kalenderjaar t/m vandaag) als default-filter.
--
-- Berekening (per beurt, status='afgerond'):
--   brutomarge = forfait_bedrag
--                - (totaal_arbeidskost + totaal_reiskost + totaal_materiaalkost
--                   + planning_fee_van_partner)
--
-- Multi-tech allocatie:
--   Voor beurten met `extra_technieker_ids` worden omzet, kost en uren gelijk
--   verdeeld over (1 hoofd-tech + n extra-techs). v1 = equal-share. Een
--   uren-gewogen variant kan in v2 worden toegevoegd via een join op
--   beurt_uren_per_tech (zie follow-ups in /docs/slots/slot-G-winstgevendheid.md).
--
-- Sector-normalisatie:
--   Free-text `sector` kolom wordt in v_winstgevendheid_per_sector
--   genormaliseerd: alle `warmtepomp_*`-varianten → 'warmtepomp'.
--   Bekende basis-sectoren blijven zichzelf; rest valt in 'overig'.
--
-- Bezettingsgraad-simplificatie (v1):
--   gewerkte_uren YTD / (contract_uren_week × ISO-weeknummer-vandaag) × 100
--   Trekt verlof, EW-dagen of feestdagen NIET af. Dit is bewust een eerste
--   indicator; v2 koppelt aan `verlof_aanvragen`, `ew_dagen` en `feestdagen`
--   tabellen voor exacte beschikbaarheid (zie follow-ups).
--
-- Veiligheid:
--   Alle views draaien met security_invoker = on, zodat de bestaande
--   RLS-policies op `onderhoudsbeurten`, `contracten`, `partners` en
--   `techniekers` automatisch de zichtbaarheid filteren:
--     - admin → ziet alle data
--     - partner → ziet alleen beurten van eigen contracten
--     - anon → SELECT geweigerd (geen GRANT)
-- =============================================================================

-- 1) Drop vroegere views indien ze bestaan (idempotent, geen oude state).
DROP VIEW IF EXISTS public.v_winstgevendheid_per_partner CASCADE;
DROP VIEW IF EXISTS public.v_winstgevendheid_per_sector CASCADE;
DROP VIEW IF EXISTS public.v_winstgevendheid_per_technieker CASCADE;

-- =============================================================================
-- 2) v_winstgevendheid_per_partner
-- =============================================================================
-- Aggregatie per actieve partner, YTD-periode (van 1 januari lopend jaar t/m
-- vandaag). Toont aantal afgewerkte beurten, omzet, kost-componenten en
-- brutomarge. Periode-kolommen worden meegegeven zodat de frontend ze kan
-- visualiseren (bv. "YTD: 1 jan – 25 apr 2026").
-- =============================================================================
CREATE VIEW public.v_winstgevendheid_per_partner
WITH (security_invoker = on)
AS
SELECT
  p.id                                                                AS partner_id,
  p.naam                                                              AS partner_naam,
  p.slug                                                              AS partner_slug,
  p.kleur_primair                                                     AS kleur_primair,
  COUNT(b.id) FILTER (WHERE b.status = 'afgerond')                    AS aantal_beurten_afgerond,
  COALESCE(SUM(b.forfait_bedrag) FILTER (WHERE b.status = 'afgerond'), 0)::numeric
                                                                      AS omzet_excl_btw,
  COALESCE(SUM(p.planning_fee)   FILTER (WHERE b.status = 'afgerond'), 0)::numeric
                                                                      AS planning_fee_kost,
  COALESCE(SUM(b.totaal_arbeidskost)   FILTER (WHERE b.status = 'afgerond'), 0)::numeric
                                                                      AS arbeidskost,
  COALESCE(SUM(b.totaal_reiskost)      FILTER (WHERE b.status = 'afgerond'), 0)::numeric
                                                                      AS reiskost,
  COALESCE(SUM(b.totaal_materiaalkost) FILTER (WHERE b.status = 'afgerond'), 0)::numeric
                                                                      AS materiaalkost,
  (
    COALESCE(SUM(b.forfait_bedrag) FILTER (WHERE b.status = 'afgerond'), 0)::numeric
    -
    COALESCE(SUM(
      COALESCE(b.totaal_arbeidskost, 0)
      + COALESCE(b.totaal_reiskost, 0)
      + COALESCE(b.totaal_materiaalkost, 0)
      + COALESCE(p.planning_fee, 0)
    ) FILTER (WHERE b.status = 'afgerond'), 0)::numeric
  )                                                                   AS brutomarge,
  date_trunc('year', CURRENT_DATE)::date                              AS periode_start,
  CURRENT_DATE                                                        AS periode_eind
FROM public.partners p
LEFT JOIN public.contracten c
       ON c.partner_id = p.id
LEFT JOIN public.onderhoudsbeurten b
       ON b.contract_id    = c.id
      AND b.uitvoer_datum >= date_trunc('year', CURRENT_DATE)::date
      AND b.uitvoer_datum <= CURRENT_DATE
WHERE p.actief = true
GROUP BY p.id, p.naam, p.slug, p.kleur_primair;

COMMENT ON VIEW public.v_winstgevendheid_per_partner IS
  'Slot G — YTD aggregatie per actieve partner: omzet, planning-fee-kost, arbeids-/reis-/materiaalkost en brutomarge op basis van afgewerkte onderhoudsbeurten. security_invoker=on zodat RLS van onderhoudsbeurten geldt.';

-- =============================================================================
-- 3) v_winstgevendheid_per_sector
-- =============================================================================
-- Aggregatie per genormaliseerde sector. `b.sector` is free-text in de DB
-- (alleen `ic` aanwezig op moment van schrijven), dus we vangen toekomstige
-- waarden af in een whitelist en bundelen warmtepomp-varianten.
-- =============================================================================
CREATE VIEW public.v_winstgevendheid_per_sector
WITH (security_invoker = on)
AS
WITH beurten_norm AS (
  SELECT
    b.id,
    b.status,
    b.uitvoer_datum,
    b.forfait_bedrag,
    b.totaal_arbeidskost,
    b.totaal_reiskost,
    b.totaal_materiaalkost,
    p.planning_fee,
    CASE
      WHEN b.sector LIKE 'warmtepomp%'                                          THEN 'warmtepomp'
      WHEN b.sector IN (
        'zonnepanelen','warmtepomp','ventilatie','verwarming',
        'ic','klussen','airco','sanitair','elektriciteit'
      )                                                                          THEN b.sector
      ELSE COALESCE(b.sector, 'overig')
    END AS sector_normalized
  FROM public.onderhoudsbeurten b
  LEFT JOIN public.contracten c ON c.id = b.contract_id
  LEFT JOIN public.partners   p ON p.id = c.partner_id
  WHERE b.uitvoer_datum >= date_trunc('year', CURRENT_DATE)::date
    AND b.uitvoer_datum <= CURRENT_DATE
)
SELECT
  bn.sector_normalized                                              AS sector,
  COUNT(bn.id) FILTER (WHERE bn.status = 'afgerond')                AS aantal_beurten_afgerond,
  COALESCE(SUM(bn.forfait_bedrag) FILTER (WHERE bn.status = 'afgerond'), 0)::numeric
                                                                    AS omzet_excl_btw,
  COALESCE(SUM(bn.planning_fee)   FILTER (WHERE bn.status = 'afgerond'), 0)::numeric
                                                                    AS planning_fee_kost,
  COALESCE(SUM(bn.totaal_arbeidskost)   FILTER (WHERE bn.status = 'afgerond'), 0)::numeric
                                                                    AS arbeidskost,
  COALESCE(SUM(bn.totaal_reiskost)      FILTER (WHERE bn.status = 'afgerond'), 0)::numeric
                                                                    AS reiskost,
  COALESCE(SUM(bn.totaal_materiaalkost) FILTER (WHERE bn.status = 'afgerond'), 0)::numeric
                                                                    AS materiaalkost,
  (
    COALESCE(SUM(bn.forfait_bedrag) FILTER (WHERE bn.status = 'afgerond'), 0)::numeric
    -
    COALESCE(SUM(
      COALESCE(bn.totaal_arbeidskost, 0)
      + COALESCE(bn.totaal_reiskost, 0)
      + COALESCE(bn.totaal_materiaalkost, 0)
      + COALESCE(bn.planning_fee, 0)
    ) FILTER (WHERE bn.status = 'afgerond'), 0)::numeric
  )                                                                 AS brutomarge,
  date_trunc('year', CURRENT_DATE)::date                            AS periode_start,
  CURRENT_DATE                                                      AS periode_eind
FROM beurten_norm bn
GROUP BY bn.sector_normalized;

COMMENT ON VIEW public.v_winstgevendheid_per_sector IS
  'Slot G — YTD aggregatie per genormaliseerde sector. Free-text wordt gemapt op een whitelist + warmtepomp_* → warmtepomp, rest naar overig. security_invoker=on.';

-- =============================================================================
-- 4) v_winstgevendheid_per_technieker
-- =============================================================================
-- Per-technieker toewijzing met equal-share allocatie voor multi-tech beurten.
-- UNNEST(hoofd_tech || extra_technieker_ids) genereert één rij per
-- (beurt, technieker)-combinatie; share_pct = 1 / aantal_techs.
-- Filtert op type_personeel='technieker' (bedienden hebben geen beurten in
-- het normaal flow). Bezettingsgraad volgens v1-formule (zie kop-comment).
-- =============================================================================
CREATE VIEW public.v_winstgevendheid_per_technieker
WITH (security_invoker = on)
AS
WITH tech_beurten AS (
  SELECT
    b.id,
    b.uitvoer_datum,
    b.status,
    b.sector,
    b.forfait_bedrag,
    b.totaal_uren,
    b.totaal_arbeidskost,
    b.totaal_reiskost,
    b.totaal_materiaalkost,
    p.planning_fee,
    UNNEST(
      ARRAY[b.technieker_id]
      || COALESCE(b.extra_technieker_ids, ARRAY[]::uuid[])
    )                                                                   AS tech_id,
    (
      1.0
      / GREATEST(
          1,
          1 + COALESCE(array_length(b.extra_technieker_ids, 1), 0)
        )
    )::numeric                                                          AS share_pct
  FROM public.onderhoudsbeurten b
  LEFT JOIN public.contracten c ON c.id = b.contract_id
  LEFT JOIN public.partners   p ON p.id = c.partner_id
  WHERE b.status = 'afgerond'
    AND b.uitvoer_datum >= date_trunc('year', CURRENT_DATE)::date
    AND b.uitvoer_datum <= CURRENT_DATE
    AND b.technieker_id IS NOT NULL
)
SELECT
  t.id                                                                AS technieker_id,
  t.naam                                                              AS technieker_naam,
  t.voornaam                                                          AS technieker_voornaam,
  t.uurtarief                                                         AS uurtarief,
  t.contract_uren_week                                                AS contract_uren_week,
  -- Slot U: ex-techs blijven zichtbaar voor historische YTD-aggregaten;
  -- frontend toont uit_dienst_sinds als suffix bij tab-naam.
  t.uit_dienst_sinds                                                  AS uit_dienst_sinds,
  COUNT(tb.id)                                                        AS aantal_beurten,
  COALESCE(SUM(tb.forfait_bedrag * tb.share_pct), 0)::numeric         AS omzet_aandeel,
  COALESCE(SUM(
    (
      COALESCE(tb.totaal_arbeidskost, 0)
      + COALESCE(tb.totaal_reiskost, 0)
      + COALESCE(tb.totaal_materiaalkost, 0)
      + COALESCE(tb.planning_fee, 0)
    ) * tb.share_pct
  ), 0)::numeric                                                      AS kost_aandeel,
  COALESCE(SUM(
    (
      COALESCE(tb.forfait_bedrag, 0)
      - (
        COALESCE(tb.totaal_arbeidskost, 0)
        + COALESCE(tb.totaal_reiskost, 0)
        + COALESCE(tb.totaal_materiaalkost, 0)
        + COALESCE(tb.planning_fee, 0)
      )
    ) * tb.share_pct
  ), 0)::numeric                                                      AS brutomarge_aandeel,
  COALESCE(SUM(COALESCE(tb.totaal_uren, 0) * tb.share_pct), 0)::numeric
                                                                      AS gewerkte_uren,
  -- Bezettingsgraad v1 — zie kop-comment voor simplificatie-disclaimer.
  CASE
    WHEN COALESCE(t.contract_uren_week, 38) > 0 THEN
      ROUND(
        (
          COALESCE(SUM(COALESCE(tb.totaal_uren, 0) * tb.share_pct), 0)
          / NULLIF(
              COALESCE(t.contract_uren_week, 38)
              * EXTRACT(WEEK FROM CURRENT_DATE)::numeric,
              0
            )
        ) * 100,
        1
      )
    ELSE NULL
  END                                                                 AS bezettingsgraad_pct,
  date_trunc('year', CURRENT_DATE)::date                              AS periode_start,
  CURRENT_DATE                                                        AS periode_eind
FROM public.techniekers t
LEFT JOIN tech_beurten tb ON tb.tech_id = t.id
-- Slot U: GEEN t.actief=true filter — ex-techs blijven zichtbaar voor
-- historische YTD-aggregaten (zie 20260428114500_slot_u_winstgevendheid_per_technieker_include_ex.sql).
WHERE COALESCE(t.type_personeel, 'technieker') = 'technieker'
GROUP BY
  t.id, t.naam, t.voornaam, t.uurtarief, t.contract_uren_week, t.uit_dienst_sinds
ORDER BY brutomarge_aandeel DESC;

COMMENT ON VIEW public.v_winstgevendheid_per_technieker IS
  'Slot G + Slot U — YTD per technieker met equal-share allocatie over multi-tech beurten. Bevat alle techs incl. uit-dienst voor historische completeness. Bezettingsgraad is v1-simplificatie: trekt verlof/feestdagen NOG niet af. security_invoker=on.';

-- =============================================================================
-- 5) GRANTS — least privilege
-- =============================================================================
-- Anon mag deze views niet zien (interne kost-data). Authenticated krijgt
-- SELECT; de onderliggende RLS doet de echte rij-filtering.
-- =============================================================================
REVOKE ALL ON public.v_winstgevendheid_per_partner    FROM PUBLIC, anon;
REVOKE ALL ON public.v_winstgevendheid_per_sector     FROM PUBLIC, anon;
REVOKE ALL ON public.v_winstgevendheid_per_technieker FROM PUBLIC, anon;

GRANT SELECT ON public.v_winstgevendheid_per_partner    TO authenticated;
GRANT SELECT ON public.v_winstgevendheid_per_sector     TO authenticated;
GRANT SELECT ON public.v_winstgevendheid_per_technieker TO authenticated;
