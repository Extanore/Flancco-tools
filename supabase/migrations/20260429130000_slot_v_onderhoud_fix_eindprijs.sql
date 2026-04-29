-- Slot V fix: voeg eindprijs als GENERATED kolom toe op beurt_uren_registraties.
-- Reden: code in Onderhoud-pipeline (admin/index.html) selecteert deze kolom in
-- _PIPELINE_SELECT (loadOnderhoudData/loadFlanccoWerkData), maar de kolom werd nooit
-- aangemaakt. Resultaat: Supabase 400 "column beurt_uren_registraties_1.eindprijs
-- does not exist" → blokkeert het laden van de Onderhoud-pagina.
--
-- Schema-keuze: de tabel werkt met duur_minuten (integer) + uurtarief_facturatie_snapshot
-- (numeric snapshot at-time-of-registration). Eindprijs is dus afgeleid van die twee
-- velden — een GENERATED ALWAYS kolom is de juiste vorm: altijd consistent, niet
-- handmatig schrijfbaar, zero-maintenance bij updates van duur of tarief.
--
-- Conventie: uren = (eind_tijd - start_tijd) in uren (NUMERIC-deling, niet truncated).
--            eindprijs = uren × uurtarief_facturatie_snapshot.
-- We kunnen NIET refereren naar duur_minuten omdat dat zelf een GENERATED kolom is
-- (Postgres restrictie: generated col mag geen andere generated col bevatten).
-- Dus we dupliceren de duur-berekening rechtstreeks vanuit start_tijd/eind_tijd.
-- COALESCE op tarief geeft 0.00 als veilige fallback bij ontbrekend snapshot.

ALTER TABLE beurt_uren_registraties
  ADD COLUMN IF NOT EXISTS eindprijs NUMERIC(12,2)
  GENERATED ALWAYS AS (
    ROUND(
      GREATEST(0, EXTRACT(epoch FROM (eind_tijd - start_tijd)) / 3600.0)
      * COALESCE(uurtarief_facturatie_snapshot, 0)
    , 2)
  ) STORED;

COMMENT ON COLUMN beurt_uren_registraties.eindprijs IS
  'Slot V: berekend totaal in euro = ((eind_tijd - start_tijd) in uren) × uurtarief_facturatie_snapshot. GENERATED ALWAYS STORED — niet handmatig schrijfbaar, blijft automatisch consistent.';
