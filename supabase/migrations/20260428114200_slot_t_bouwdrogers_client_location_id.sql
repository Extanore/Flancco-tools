-- Slot T C3 — bouwdrogers.client_location_id voor werklocatie-uitgifte
-- ----------------------------------------------------------------------------
-- De werklocatie-picker UI in admin/index.html (uitgeef-droger modal) toonde
-- al de werklocatie-keuze maar de waarde werd niet opgeslagen omdat de kolom
-- niet bestond. Deze migratie sluit dat gat.

ALTER TABLE public.bouwdrogers
  ADD COLUMN IF NOT EXISTS client_location_id UUID
    REFERENCES public.client_locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bouwdrogers_client_location_idx
  ON public.bouwdrogers (client_location_id)
  WHERE client_location_id IS NOT NULL;

COMMENT ON COLUMN public.bouwdrogers.client_location_id IS
  'Slot T C3: werklocatie waar de droger fysiek wordt uitgegeven. Kan verschillen van facturatie-adres bij multi-locatie bedrijven. NULL = niet gespecificeerd of niet-bedrijf-context.';
