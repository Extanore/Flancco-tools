-- ─── Partner: aparte klant-communicatie contactgegevens ─────────────────────
-- De bestaande `email` + `telefoon` kolommen op partners worden gebruikt voor
-- account-gegevens (admin-contact, partner-portaal notificaties). Klanten zien
-- echter dezelfde contactgegevens in contracten, calculator-bevestiging en
-- mails — soms wil een partner een dedicated mailbox of telefoonnummer voor
-- klant-communicatie gebruiken (bv. support@bedrijf.be ipv info@bedrijf.be).
--
-- Twee nieuwe nullable kolommen + fallback-pattern in alle customer-facing
-- display-points: `COALESCE(communicatie_email, email)`, idem voor telefoon.
-- Geen data-migration nodig: bestaande partners gebruiken automatisch de
-- account-gegevens tot ze de nieuwe velden invullen.

ALTER TABLE public.partners
  ADD COLUMN IF NOT EXISTS communicatie_email TEXT NULL,
  ADD COLUMN IF NOT EXISTS communicatie_telefoon TEXT NULL;

COMMENT ON COLUMN public.partners.communicatie_email IS
  'Optionele e-mail voor klant-communicatie (contracten, calculator-bevestiging, mailings). Fallback naar partners.email als NULL.';

COMMENT ON COLUMN public.partners.communicatie_telefoon IS
  'Optionele telefoon voor klant-communicatie (contracten, calculator-bevestiging, mailings). Fallback naar partners.telefoon als NULL.';

-- Slot Z (partner_commercial_lock trigger) beschermt commerciele kolommen tegen
-- partner-rol writes. Deze nieuwe kolommen ZIJN partner-bewerkbaar — geen
-- toevoeging aan de protected lijst.
