-- Slot O1 — Particulier/bedrijf-toggle + VIES BTW-validatie
-- ─────────────────────────────────────────────────────────────────────
-- Naamgeving: `klant_subtype` (NIET `klant_type`) — die kolom bestaat al
-- met waarden 'eindklant'/'partner' (semantisch een ander concept:
-- wie de eindbestemmeling van het contract is, niet de juridische
-- entiteitsvorm van de klant). De B2C/B2B-classificatie krijgt
-- daarom een eigen, expliciet andere kolomnaam.
--
-- Audit-trail: bij elke succesvolle VIES-call slaan we de raw response
-- op in `btw_validated_payload` zodat we later (in geval van BTW-controle)
-- kunnen bewijzen wat het VIES-register op het moment van afsluiting
-- bevestigde. Geen PII van de bediende-die-valideerde — alleen API-output.

ALTER TABLE public.contracten
  ADD COLUMN IF NOT EXISTS klant_subtype text NOT NULL DEFAULT 'particulier'
    CHECK (klant_subtype IN ('particulier', 'bedrijf')),
  ADD COLUMN IF NOT EXISTS bedrijfsnaam text,
  ADD COLUMN IF NOT EXISTS btw_nummer_validated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS btw_validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS btw_validated_payload jsonb;

COMMENT ON COLUMN public.contracten.klant_subtype IS
  'Slot O1 — Juridische klant-vorm: ''particulier'' (B2C, default) of ''bedrijf'' (B2B met BTW-nr). NIET te verwarren met kolom klant_type (eindklant|partner) die het commerciële kanaal aangeeft.';
COMMENT ON COLUMN public.contracten.bedrijfsnaam IS
  'Slot O1 — Officiële bedrijfsnaam (alleen ingevuld als klant_subtype=''bedrijf''). Bij particulier blijft NULL.';
COMMENT ON COLUMN public.contracten.btw_nummer_validated IS
  'Slot O1 — TRUE alleen als VIES (of vatcomply) een geldig antwoord teruggaf bij submit. Default false.';
COMMENT ON COLUMN public.contracten.btw_validated_at IS
  'Slot O1 — Tijdstip van succesvolle VIES-call. NULL als geen validatie of als validatie faalde.';
COMMENT ON COLUMN public.contracten.btw_validated_payload IS
  'Slot O1 — Raw VIES-response (naam, adres, valid-flag, ts, source). Audit-trail voor B2B-tarief-keuze. Geen PII van bediende.';

-- Performance-index voor admin-rapportage per klant-subtype.
-- Partial-index op subset waar bedrijfsnaam ingevuld is — kleinere index.
CREATE INDEX IF NOT EXISTS idx_contracten_klant_subtype
  ON public.contracten (klant_subtype)
  WHERE klant_subtype = 'bedrijf';
