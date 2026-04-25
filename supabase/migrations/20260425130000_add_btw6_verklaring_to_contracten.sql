-- Slot O2 — Verklaring op eer voor 6% BTW (KB nr. 20 / AR n° 20)
-- ----------------------------------------------------------------
-- Bij het verlaagd BTW-tarief van 6% voor renovatie van een privéwoning
-- ouder dan 10 jaar moet de eindverbruiker twee verklaringen ondertekenen:
--   1. Het is een privéwoning (hoofdzakelijk privégebruik)
--   2. De woning is meer dan 10 jaar in gebruik
--
-- Deze migratie legt beide checkboxen + tijdstempel vast in `contracten`
-- en dwingt via een CHECK constraint af dat ze beide TRUE zijn én een
-- datum bevatten zodra `btw_type` op 6% staat.
--
-- Toegepast: 2026-04-25 via mcp__apply_migration (project dhuqpxwwavqyxaelxuzl).

ALTER TABLE public.contracten
  ADD COLUMN IF NOT EXISTS verklaring_6btw_privewoning_aangevinkt boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verklaring_6btw_ouderdan10j_aangevinkt boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verklaring_6btw_datum                  timestamptz NULL;

ALTER TABLE public.contracten
  DROP CONSTRAINT IF EXISTS chk_btw6_verklaring_consistent;

-- LIKE '6%' matcht zowel '6' als '6%' (calculator stuurt '6%', wizard '21').
-- Wanneer btw_type leeg of niet-6 is, mogen de verklaringen vrij zijn.
ALTER TABLE public.contracten
  ADD CONSTRAINT chk_btw6_verklaring_consistent
  CHECK (
    btw_type IS NULL
    OR btw_type NOT LIKE '6%'
    OR (
      verklaring_6btw_privewoning_aangevinkt = true
      AND verklaring_6btw_ouderdan10j_aangevinkt = true
      AND verklaring_6btw_datum IS NOT NULL
    )
  );

COMMENT ON COLUMN public.contracten.verklaring_6btw_privewoning_aangevinkt IS
  'Slot O2 — Klant verklaart op eer dat de woning een privéwoning is (KB nr. 20).';
COMMENT ON COLUMN public.contracten.verklaring_6btw_ouderdan10j_aangevinkt IS
  'Slot O2 — Klant verklaart op eer dat de woning > 10 jaar in gebruik is (KB nr. 20).';
COMMENT ON COLUMN public.contracten.verklaring_6btw_datum IS
  'Slot O2 — Tijdstip waarop de twee 6% verklaringen werden aangevinkt.';
