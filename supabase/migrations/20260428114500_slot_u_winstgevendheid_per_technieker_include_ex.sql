-- Slot U U4 — Winstgevendheid per technieker: include ex-techs
-- ----------------------------------------------------------------------------
-- De view filterde voorheen op t.actief = true. Voor historische YTD-aggregaten
-- moeten ex-techs (uit_dienst_sinds NOT NULL) ZICHTBAAR blijven, anders gaan
-- omzet/kost-cijfers verloren bij personeelsverloop. De frontend rendert
-- ex-techs met "(Uit dienst sinds <datum>)" suffix maar laat de cijfers wel zien.
--
-- Idempotentie: gebruikt DROP + CREATE zodat de view altijd in de Slot U-vorm
-- staat, ongeacht of de Slot G-migratie eerder werd toegepast. De Slot G
-- migratie-file is mee gepatcht zodat een latere apply de fix niet ongedaan
-- maakt (zelfde WHERE-clause).
-- ----------------------------------------------------------------------------

DROP VIEW IF EXISTS public.v_winstgevendheid_per_technieker CASCADE;

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
  -- Bezettingsgraad v1 — trekt verlof/feestdagen NOG niet af; v2 follow-up.
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
WHERE COALESCE(t.type_personeel, 'technieker') = 'technieker'
GROUP BY
  t.id, t.naam, t.voornaam, t.uurtarief, t.contract_uren_week, t.uit_dienst_sinds
ORDER BY brutomarge_aandeel DESC;

COMMENT ON VIEW public.v_winstgevendheid_per_technieker IS
  'Slot U: bevat alle techs incl. uit-dienst, zodat historische YTD-aggregaten compleet blijven. Frontend toont uit_dienst_sinds-suffix in tab-naam. security_invoker=on zodat RLS van onderhoudsbeurten/contracten/techniekers geldt.';

-- Grants — least privilege (anon mag deze view niet zien; auth via onderliggende RLS).
REVOKE ALL ON public.v_winstgevendheid_per_technieker FROM PUBLIC, anon;
GRANT SELECT ON public.v_winstgevendheid_per_technieker TO authenticated;
