-- Slot A2 — Contract-terms tab in admin/rapport.html
-- ----------------------------------------------------------------
-- Voegt drie kolommen toe aan `contracten` om de scope-akkoord-flow
-- vanuit de rapport-pagina te ondersteunen:
--   - speciale_instructies_technieker: vrije tekst (max 1000 chars,
--     enforce client-side; geen DB-CHECK om migratie eenvoudig te houden
--     en latere uitbreiding van de limiet zonder migratie mogelijk te maken)
--   - scope_akkoord_handtekening: bool flag
--   - scope_akkoord_handtekening_base64: data:image/png;base64,... payload
--   - scope_akkoord_handtekening_datum: tijdstip van akkoord
--
-- CHECK-constraint dwingt af dat als de bool TRUE is, beide andere velden
-- ingevuld zijn — voorkomt half-getekende toestanden.
--
-- RLS: bestaande policies (`contracten_write_admin` voor admin-ALL,
-- `contracten_partner_write` voor partner-ALL op eigen partner_id,
-- `contracten_anon_insert` voor publieke calculator-INSERT) dekken
-- de nieuwe kolommen automatisch — geen nieuwe policies nodig.
--
-- Toegepast: 2026-04-25 via mcp__apply_migration (project dhuqpxwwavqyxaelxuzl).

ALTER TABLE public.contracten
  ADD COLUMN IF NOT EXISTS speciale_instructies_technieker        text NULL,
  ADD COLUMN IF NOT EXISTS scope_akkoord_handtekening             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scope_akkoord_handtekening_base64      text NULL,
  ADD COLUMN IF NOT EXISTS scope_akkoord_handtekening_datum       timestamptz NULL;

ALTER TABLE public.contracten
  DROP CONSTRAINT IF EXISTS chk_scope_handtekening_consistent;

ALTER TABLE public.contracten
  ADD CONSTRAINT chk_scope_handtekening_consistent
  CHECK (
    scope_akkoord_handtekening = false OR (
      scope_akkoord_handtekening_base64 IS NOT NULL
      AND scope_akkoord_handtekening_datum IS NOT NULL
    )
  );

COMMENT ON COLUMN public.contracten.speciale_instructies_technieker IS
  'Slot A2 — Vrije tekst (max 1000 chars, client-side enforce). Wordt op werkbon getoond zodat de technieker ter plekke kan checken of er bijzondere afspraken zijn.';
COMMENT ON COLUMN public.contracten.scope_akkoord_handtekening IS
  'Slot A2 — TRUE als de klant ter plekke akkoord heeft gegeven met de scope vóór start van de werken.';
COMMENT ON COLUMN public.contracten.scope_akkoord_handtekening_base64 IS
  'Slot A2 — PNG data-URL (data:image/png;base64,...) van de scope-akkoord-handtekening. NULL als nog niet getekend.';
COMMENT ON COLUMN public.contracten.scope_akkoord_handtekening_datum IS
  'Slot A2 — Tijdstip waarop de scope-akkoord-handtekening is gezet. NULL als nog niet getekend.';
