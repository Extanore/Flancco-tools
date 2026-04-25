# Slot O1 — Particulier/Bedrijf-toggle + VIES BTW-validatie

**Status:** Productieklaar. Continuous release — geen feature-flag, direct live op calculator + admin-wizard.

## Intent

- Klant kiest expliciet of hij **particulier** of **bedrijf** is, vóór hij contactgegevens invult.
- Bedrijf-flow vraagt extra **bedrijfsnaam**, **BTW-nummer** en **contactpersoon** — particulier-flow niet (anti-friction).
- BTW-nummer wordt **on blur** automatisch gevalideerd via VIES (EU-register) met soft-fail.
- Bij geldig BTW-nummer worden bedrijfsnaam + adres + postcode + gemeente automatisch ingevuld als die velden nog leeg zijn.
- Audit-trail in DB: per contract is bekend of het BTW-nummer extern geverifieerd is, wanneer en met welke payload.

## Naamgeving — afwijking van plan

Het plan vroeg een kolom `klant_type` met waarden `particulier|bedrijf`. Die naam was **al in gebruik** (waarden `eindklant|partner` — commercieel kanaal). Daarom: **`klant_subtype`** voor de juridische vorm, **`klant_type`** blijft bestaan voor het commerciële kanaal. Beide kolommen coexisteren.

## Datamodel

Migration: `supabase/migrations/20260425120000_add_klant_subtype_and_btw_validated_to_contracten.sql`

```sql
ALTER TABLE contracten
  ADD COLUMN IF NOT EXISTS klant_subtype           text NOT NULL DEFAULT 'particulier'
    CHECK (klant_subtype IN ('particulier','bedrijf')),
  ADD COLUMN IF NOT EXISTS bedrijfsnaam            text,
  ADD COLUMN IF NOT EXISTS btw_nummer_validated    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS btw_validated_at        timestamptz,
  ADD COLUMN IF NOT EXISTS btw_validated_payload   jsonb;

CREATE INDEX IF NOT EXISTS idx_contracten_klant_subtype
  ON contracten (klant_subtype) WHERE klant_subtype = 'bedrijf';
```

`clients`-tabel heeft al `client_type` (`particulier|bedrijf`) en `vat_number` — wizard slaat die nu mee op bij nieuwe klanten en gebruikt ze bij hergebruik.

## RLS

Geen nieuwe policies nodig — bestaande `contracten`-policies dekken automatisch nieuwe kolommen (admin full CRUD, partner SELECT op eigen contracten, anon INSERT vanuit calculator).

## VIES Edge Function

**Path:** `supabase/functions/validate-vat/index.ts`
**JWT:** `verify_jwt=false` (publiek aanroepbaar — anti-misbruik via rate-limit + CORS)
**Endpoint:** `POST {SUPABASE_URL}/functions/v1/validate-vat`

### Request

```json
{ "vat": "BE0400378485" }
```

Body capped op 1 KB. BTW wordt genormaliseerd: uppercase, spaties + punten verwijderd, `BE` voorvoegsel impliciet toegevoegd voor 10 cijfers.

### Response

| Status | Body | Betekenis |
|---|---|---|
| 200 | `{valid: true, naam, adres, postcode, gemeente, country, source: 'vatcomply'\|'vies_soap', raw, ts}` | BTW geldig en in register |
| 200 | `{valid: false, country, source, ts}` | Format ok, niet in register |
| 200 | `{valid: null, error: 'upstream_timeout'\|'upstream_error', ts}` | Soft-fail — calculator toont oranje warning, klant kan doorgaan |
| 400 | `{valid: false, error: 'invalid_format'\|'unsupported_country'}` | Format-check faalt |
| 405 | `{error: 'method_not_allowed'}` | Enkel POST |
| 413 | `{error: 'body_too_large'}` | > 1 KB |
| 429 | `{error: 'rate_limited'}` | > 30 req/min/IP |

### Strategie

1. Primair: `vatcomply.com/vat?vat_number=...` (REST, snel, JSON)
2. Fallback: VIES SOAP `ec.europa.eu/taxation_customs/vies/checkVatService` (XML, ~3-5s)
3. Beide met `AbortController` timeout 10s
4. Bij beide down → soft-fail 200 met `valid: null`

### Logging

Alleen SHA-256 hash van BTW-nummer + country + result-flag. **Plaintext BTW komt nooit in logs.** `console.log({hash: ..., country, valid, source})`.

### Rate-limit

In-memory map per `clientIp()` (afgeleid uit `x-forwarded-for` / `cf-connecting-ip`). Window 60s, 30 calls. Reset na cold-start (acceptabel — dit is geen replacement van Cloudflare-WAF).

## CORS

`ALLOWED_ORIGINS` env-var (komma-gescheiden). Ondersteunt:
- `https://calculator.flancco-platform.be`
- `https://app.flancco-platform.be`
- `http://localhost:8080` (dev)

Pre-flight `OPTIONS` returnt `Access-Control-Allow-Headers: content-type, authorization, apikey`.

## Files touched

| File | Aard | Lines |
|---|---|---|
| `supabase/migrations/20260425120000_add_klant_subtype_and_btw_validated_to_contracten.sql` | Nieuw | 32 |
| `supabase/functions/validate-vat/index.ts` | Nieuw | ~330 |
| `supabase/functions/validate-vat/deno.json` | Nieuw | 8 |
| `calculator/i18n/nl.json.js` | Edit (`step2.naam`, nieuwe `klantType` sectie) | +20 |
| `calculator/i18n/fr.json.js` | Edit (`step2.naam`, nieuwe `klantType` sectie) | +20 |
| `calculator/index.html` | Edit (CSS toggle + bedrijf-fields, step 2 HTML, JS helpers, payload) | +180 |
| `admin/contracten-wizard.html` | Edit (CSS, new-client form HTML, JS helpers, payload) | +160 |

## Frontend gedrag

### Calculator (`calculator/index.html`)

- Radio-toggle `name="klant-subtype"` bovenaan stap 2 (Particulier default).
- Bedrijfsvelden in `<div class="bedrijf-fields">` — `display:none` toggle via `.is-open`. **Geen DOM-rebuild** — radio-state + ingevulde waarden persisteren bij stap-navigatie.
- BTW-input met `onblur="onBtwBlur()"`, debounced + dedupe (zelfde nummer wordt niet 2x bevraagd).
- `aria-live="polite"` status-region voor screen readers.
- Auto-fill: alleen lege velden worden ingevuld bij valid VIES (klant blijft baas over reeds-ingevulde data).
- Hidden legacy field `klant-btw` blijft in DOM voor backward-compat; `syncKlantSubtypeToFields()` mirrort waarde vóór submit.

### Admin wizard (`admin/contracten-wizard.html`)

- Identieke toggle binnen "Nieuwe klant"-sectie (verbergt zich automatisch als bestaande klant geselecteerd is).
- Bij existing-client read-out wordt `client.client_type` + `client.vat_number` gerespecteerd.
- Bij nieuwe klant in bedrijf-mode wordt `Voornaam/Achternaam` gerelabeled naar `Contactpersoon-voornaam/Contactpersoon-achternaam`.
- VIES-validatie identiek aan calculator (zelfde edge function).

## Analytics (Slot 0)

Twee events worden gelogd via `window.flanccoTrack`:

```js
flanccoTrack('Calculator Klant Type', { subtype: 'particulier'|'bedrijf' });
flanccoTrack('VIES Validation', { result: 'valid'|'invalid'|'error', country: 'BE' });
```

**Nooit het BTW-nummer zelf** — alleen result-flag + country.

## Deploy

```bash
# 1. Migration (al toegepast via mcp__apply_migration)
supabase migration up

# 2. Edge function
supabase functions deploy validate-vat --no-verify-jwt

# 3. Set env-var voor CORS
supabase secrets set ALLOWED_ORIGINS="https://calculator.flancco-platform.be,https://app.flancco-platform.be,http://localhost:8080"

# 4. Frontend (Cloudflare Pages auto-deploy via git push)
git push
```

## Test checklist

| # | Scenario | Verwacht |
|---|---|---|
| 1 | Calculator: klant kiest Particulier, vult naam/adres in | BTW-veld + bedrijfsnaam HIDDEN, submit OK, contract heeft `klant_subtype='particulier'`, `btw_nummer_validated=false` |
| 2 | Calculator: klant kiest Bedrijf, vult `BE0400378485` (Colruyt) | Status "Geverifieerd via VIES", naam + adres auto-ingevuld, submit OK, payload bevat `btw_validated_payload` |
| 3 | Calculator: klant vult ongeldig BTW `BE9999999999` | Status "Ongeldig BTW-nummer", veld krijgt rode border, klant kan corrigeren |
| 4 | Calculator: VIES upstream down (simulate via offline) | Status "Validatie tijdelijk niet beschikbaar", oranje warning, klant kan doorgaan, contract krijgt `btw_nummer_validated=false` |
| 5 | Calculator: 31e request binnen 60s vanaf zelfde IP | 429 rate_limited, status toont "Validatie tijdelijk niet beschikbaar" |
| 6 | Wizard: bestaande bedrijf-klant geselecteerd | Toggle hidden, contract krijgt `klant_subtype='bedrijf'` uit `clients.client_type` |
| 7 | Wizard: nieuwe klant bedrijf, BTW gevalideerd | `clients.client_type='bedrijf'` + `vat_number` saved, contract bevat alle 5 Slot O1 velden |
| 8 | Stap-navigatie heen-en-weer | Radio-keuze + alle ingevulde velden persisteren |

## Niet in scope (toekomst)

- Re-validatie BTW bij contract-renewal (manueel admin-trigger nodig)
- Lookup van adres bij valide BTW als gebruiker velden bewust leeg laat (huidig: alleen invullen indien leeg)
- BTW-validatie in custom contract-flow (`opmaat-calculator.html`)
- Cache van VIES-results (zou naar `contracten.btw_validated_payload` referenties moeten — premature optimization)
