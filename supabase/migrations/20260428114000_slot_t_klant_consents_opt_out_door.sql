-- Slot T CC2 — Bedrijfs-email als opt-out-koppel + audit van wie opt-out doet
-- ----------------------------------------------------------------------------
-- Bedrijf-only-klanten hebben geen specifieke persoon-email; we gebruiken
-- clients.email als opt-out-koppel. Dit veld bestaat al in klant_consents
-- (kolom 'klant_email'). De UNIEKE addition voor Slot T: 'opt_out_door' veld
-- om te tracken wie binnen het bedrijf de opt-out triggered (vrije text input
-- bij opt-out-form).
--
-- Note: 'klant_consents' is gedefinieerd in Slot Q (migratie
-- 20260425100000_create_klant_consents.sql). Die migratie is op deploy-moment
-- van Slot T mogelijk nog niet toegepast op prod (volgorde-afhankelijk). Deze
-- migratie is daarom defensief: enkel ALTER als de tabel bestaat. Wanneer
-- Slot Q later landt zonder dit veld, moet deze migratie opnieuw gedraaid worden
-- (of het veld toegevoegd in de Slot Q migratie). Idempotent dankzij IF NOT EXISTS.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'klant_consents'
  ) THEN
    ALTER TABLE public.klant_consents
      ADD COLUMN IF NOT EXISTS opt_out_door TEXT;

    COMMENT ON COLUMN public.klant_consents.opt_out_door IS
      'Slot T: vrije tekst — naam van wie de opt-out heeft uitgevoerd. Bij bedrijf-klanten typisch "Naam X namens [bedrijfsnaam]". Optioneel; bij persoon-klanten meestal NULL.';
  ELSE
    RAISE NOTICE 'Skipping opt_out_door column add: klant_consents table does not yet exist (Slot Q not deployed). Re-run after Slot Q migration.';
  END IF;
END
$$;
