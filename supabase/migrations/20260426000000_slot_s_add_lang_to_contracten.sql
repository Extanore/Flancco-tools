-- Slot S — Persist taal-keuze (NL/FR) op contract
-- ----------------------------------------------------------------
-- Reden: de calculator detecteert de taal van de klant (postcode-heuristiek
-- + manuele override) en gebruikt die taal voor PDF-rendering, e-mails en
-- latere outbound-communicatie (reminders, rapporten). Zonder ground-truth
-- op het contract zou een latere taal-switch in de UI of een ander device
-- niet meer reproduceerbaar zijn.
--
-- CHECK forceert whitelist 'nl' | 'fr'. Default 'nl' zodat bestaande rijen
-- (vóór i18n-rollout) een veilige fallback krijgen — die taalkeuze is
-- correct voor 95%+ van de bestaande Vlaamse partner-base.

ALTER TABLE public.contracten
  ADD COLUMN IF NOT EXISTS lang text NOT NULL DEFAULT 'nl'
    CHECK (lang IN ('nl', 'fr'));

COMMENT ON COLUMN public.contracten.lang IS
  'Slot S — Taal van de klant (nl|fr). Ground-truth voor PDF-rendering en outbound communicatie. Vastgelegd op moment van ondertekening.';
