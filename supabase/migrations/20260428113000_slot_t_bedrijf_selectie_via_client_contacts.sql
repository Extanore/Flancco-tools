-- Slot T A1 — Bedrijf-selectie via client_contacts pattern
-- ----------------------------------------------------------------------------
-- Maakt clients.contact_person nullable zodat bedrijf-only-klanten mogelijk zijn
-- (geen vaste contactpersoon). Voegt optionele client_contact_id-FK toe aan
-- child-tabellen die voorheen enkel client_id hadden.
--
-- Semantiek:
--   client_id NOT NULL + client_contact_id NULL → "het bedrijf zelf"
--   client_id NOT NULL + client_contact_id NOT NULL → specifieke persoon binnen bedrijf
--
-- Backward-compat: bestaande rijen krijgen automatisch primary-contact als
-- client_contact_id (backfill). Display-laag kan beide gevallen onderscheiden
-- om "Bedrijf" vs "Persoon · Bedrijf" te renderen.

-- 1. Cleanup testdata vóór nullable-conversie (id 'tgvtg/gvtgv', 0 FK-children)
DELETE FROM public.clients WHERE id = 'bcb674a7-0654-4674-b9b7-0b9baf749700';

-- 2. Maak contact_person nullable
ALTER TABLE public.clients ALTER COLUMN contact_person DROP NOT NULL;

-- 3. Voeg client_contact_id toe aan child-tables (idempotent)
ALTER TABLE public.onderhoudsbeurten
  ADD COLUMN IF NOT EXISTS client_contact_id UUID REFERENCES public.client_contacts(id) ON DELETE SET NULL;
ALTER TABLE public.contracten
  ADD COLUMN IF NOT EXISTS client_contact_id UUID REFERENCES public.client_contacts(id) ON DELETE SET NULL;
ALTER TABLE public.bouwdrogers
  ADD COLUMN IF NOT EXISTS huidige_client_contact_id UUID REFERENCES public.client_contacts(id) ON DELETE SET NULL;

-- 4. Backfill: bestaande rijen krijgen primary contact als client_contact_id
UPDATE public.onderhoudsbeurten ob
SET client_contact_id = cc.id
FROM public.client_contacts cc
WHERE ob.client_id = cc.client_id
  AND cc.is_primary = true
  AND ob.client_contact_id IS NULL;

UPDATE public.contracten c
SET client_contact_id = cc.id
FROM public.client_contacts cc
WHERE c.client_id = cc.client_id
  AND cc.is_primary = true
  AND c.client_contact_id IS NULL;

UPDATE public.bouwdrogers b
SET huidige_client_contact_id = cc.id
FROM public.client_contacts cc
WHERE b.huidige_client_id = cc.client_id
  AND cc.is_primary = true
  AND b.huidige_client_contact_id IS NULL;

-- 5. Partial indexen op client_contact_id (sparse — meerderheid kan NULL zijn voor bedrijf-only)
CREATE INDEX IF NOT EXISTS onderhoudsbeurten_client_contact_idx
  ON public.onderhoudsbeurten (client_contact_id) WHERE client_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contracten_client_contact_idx
  ON public.contracten (client_contact_id) WHERE client_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bouwdrogers_huidige_client_contact_idx
  ON public.bouwdrogers (huidige_client_contact_id) WHERE huidige_client_contact_id IS NOT NULL;

-- 6. Documentatie
COMMENT ON COLUMN public.clients.contact_person IS
  'Slot T: legacy denormalized snapshot. NULL voor bedrijf-only-klanten (geen specifieke contactpersoon). Volledige contactpersoon-data in client_contacts-tabel.';

COMMENT ON COLUMN public.onderhoudsbeurten.client_contact_id IS
  'Slot T: optionele FK naar specifieke contactpersoon binnen het bedrijf. NULL = "het bedrijf zelf". Backfilled met primary contact bij migratie.';

COMMENT ON COLUMN public.contracten.client_contact_id IS
  'Slot T: idem onderhoudsbeurten — specifieke contactpersoon voor dit contract. NULL = bedrijf-only.';

COMMENT ON COLUMN public.bouwdrogers.huidige_client_contact_id IS
  'Slot T: idem — specifieke contactpersoon waar de droger nu uitgegeven is. NULL = bedrijf-only.';
