-- Partner-contract versie-bump 2026-05-13 — v1.1 → v1.2
-- Drie nieuwe artikelen toegevoegd in het partner-contract template
-- (onboard/sign/index.html → renderContractBody()) voor IP-bescherming:
--   1. Intellectuele eigendom & gebruiksrecht
--   2. Verbod op kopiëren, reverse-engineering en concurrentie
--   3. Vertrouwelijkheid, audit en schadebeding (€ 25.000 per inbreuk)
--
-- Geen officiële partners momenteel onder v1.1 → geen addendum-flow nodig.
-- Bestaande Flancco Direct test-partner blijft op v1.1 (zelf-contract, niet
-- afdwingbaar tegen zichzelf — geen risico).
--
-- Trigger trg_partner_applications_set_template_versie stempelt automatisch
-- de nieuwe versie op alle toekomstige partner_applications inserts/updates.
--
-- app_settings.value is JSONB — gebruik to_jsonb() om de string correct
-- te encoderen (anders SQLSTATE 22P02 invalid_text_representation).

UPDATE public.app_settings
SET value = to_jsonb('v1.2-2026-05-13'::text),
    updated_at = NOW()
WHERE key = 'partner_contract_versie';

INSERT INTO public.app_settings (key, value)
SELECT 'partner_contract_versie', to_jsonb('v1.2-2026-05-13'::text)
WHERE NOT EXISTS (
  SELECT 1 FROM public.app_settings WHERE key = 'partner_contract_versie'
);
