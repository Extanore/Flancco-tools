# Slot S — i18n NL/FR baseline (publieke calculator)

**Status:** Foundation. Eerste-pass infrastructure + sleutel-keys voor publieke calculator. Migration-pad voor admin-pages bewust **niet** in scope.

## Intent

- Nederlands blijft default
- Frans automatisch voor Wallonië-postcodes (1300-1499 / 4xxx / 5xxx / 6xxx / 7xxx)
- Brussel-postcodes (1000-1299) krijgen eenmalige taalkeuze-prompt
- URL-trigger voor sharable links (`?lang=fr`, `/fr/...`, `#lang=fr`)
- Cookie persisteert keuze (1 jaar, SameSite=Lax)
- Klant kan altijd handmatig wisselen via switcher rechtsboven

## Architectuur

Geen build-stap. Geen runtime-fetch (CSP-impact 0). Drie scripts in `<head>`:

```
calculator/i18n/i18n.js        — runtime helper (~270 regels, IIFE, exposes window.flanccoI18n + window.t)
calculator/i18n/nl.json.js     — NL dictionary, registreert via flanccoI18n.registerDict('nl', {...})
calculator/i18n/fr.json.js     — FR dictionary (BASELINE — review door FR-native vereist vóór go-live)
```

Vertaling-strategie via DOM-attributen (incrementeel migreerbaar zonder JS-rewrite):

| Attribuut | Effect |
|---|---|
| `data-i18n="key"` | Vervangt `textContent` |
| `data-i18n-html="key"` | Vervangt `innerHTML` (alleen voor vertrouwde keys) |
| `data-i18n-attr="placeholder:key1,title:key2"` | Zet meerdere attributen per element |
| `window.t('key', { name: '...' })` | Programmatisch (voor JS-render) |

Detectie-prioriteit (van hoog naar laag):
1. Hash `#lang=fr` (sharable links override)
2. Cookie `flancco_lang`
3. Query `?lang=fr`
4. Path-prefix `/fr/`
5. Postcode-derived (via `setLangFromPostcode()` aangeroepen vanuit calculator postcode-input)
6. `navigator.languages` (eerste hit op `nl`/`fr`)
7. Default `nl`

## Files touched

| File | Aard | Lines |
|---|---|---|
| `calculator/i18n/i18n.js` | Nieuw | 273 |
| `calculator/i18n/nl.json.js` | Nieuw | 130 |
| `calculator/i18n/fr.json.js` | Nieuw | 130 |
| `calculator/index.html` | Edit (`<head>` 3 script-tags + data-i18n attrs op step 0/1/2/2b/3 + footer-script + switcher-UI) | +ca. 110 lines |
| `docs/slots/slot-S-i18n.md` | Nieuw (deze) | ~70 |

## Coverage per page-section (baseline)

| Sectie | Coverage |
|---|---|
| Step 0 (sector-keuze) | Volledig (titel, subtitle, CTA, hint) |
| Step 1 (configuratie) | Volledig voor titel + 4 cards (afstand, btw, freq, duur) + result-card + CTA. **Sector-specifieke usp/info-blokken nog niet gemigreerd.** |
| Step 2 (klantgegevens) | Volledig voor labels + placeholders (data-i18n-attr) |
| Step 2b (samenvatting) | Titel + CTAs |
| Step 3 (contract) | Titel + CTAs + submit-hint |
| Success-page | Niet in baseline (vereist afzonderlijke render-pass — opvolg-werk) |
| Sector-grid icons + labels | Niet in baseline (JS-rendered via TIERS — opvolg-werk) |

## Migratie-gids voor extra keys

1. Voeg key+waarde toe in `nl.json.js`
2. Voeg dezelfde key toe in `fr.json.js` (laat FR reviewen)
3. In HTML: vervang hardcoded tekst door `<element data-i18n="key">fallback NL</element>`
   - Fallback-NL blijft staan zodat de pagina ook werkt als JS faalt te laden
4. Voor JS-gerenderde content: gebruik `window.t('key')` in plaats van string-literal
5. Geen build, geen restart — refresh + zien

Voor JS-componenten die opnieuw moeten renderen bij taal-wissel:
```js
window.flanccoI18n.onLangChange(function() {
  renderSectorTabs(); // re-render with new strings
});
```

## Testing

| Test | Verwachte uitkomst |
|---|---|
| Open `/calculator/?partner=novectra` op desktop met NL browser | Pagina in NL, switcher toont NL active |
| Open met FR browser (Accept-Language: fr) | Pagina in FR (eerste bezoek), switcher toont FR active |
| Klik FR-knop in switcher | Pagina wisselt naar FR + cookie set |
| Refresh na FR-keuze | Blijft FR (cookie) |
| Open `/calculator/?lang=fr&partner=novectra` | FR (query > cookie precedence — actually cookie wint, dus expliciet bij eerste bezoek FR) |
| Vul postcode 4000 (Luik) bij Stap 2 → blur | Auto-switch naar FR |
| Vul postcode 1000 (Brussel) bij Stap 2 → blur | Modale taalkeuze-prompt verschijnt |
| Submit-knop "Onderteken & verstuur" in FR-modus | Toont "Signer & envoyer" |

## Bekende gaps

- **FR-vertaling is BASELINE** — moet door Belgisch FR-native gereviewd zijn vóór live op Wallonië-traffic
- **Sector-tabs + USP-blokken nog niet i18n-aware** — JS-gerenderde content vereist `onLangChange` hook in `renderSectorForms()` of vergelijkbare functies
- **Success-page (post-submit summary) nog niet vertaald** — opvolg-werk
- **Admin-pages blijven NL** — bewust uit scope (per plan)
- **Email-templates + PDF-content per taal** — komt via Slot P + later notif-functions; dictionaries kunnen daar serverside herbruikt worden via duplicatie (Edge Runtime kan deze JS-files inlezen)
- **Postcode-tabel voor gemeente-autofill** — slot O2, daarbij meegenomen

## Deploy

1. Commit + push (Cloudflare Pages auto-deploy)
2. Smoke-test op preview-URL: probeer NL/FR-toggle, verifieer cookie-persistentie, test postcode 4000 en 1000
3. mail-tester.com niet relevant (no email change)
4. Geen DB-migratie

## Rollback

Verwijder de 3 `<script src="/calculator/i18n/...">` regels uit `calculator/index.html` `<head>` en de `<script>`-block + `<style>`-block + `<div class="lang-switch">` aan einde van body. Hardgecodeerde NL-tekst blijft als fallback overal staan — pagina werkt nog steeds, alleen geen FR.

## Open follow-ups

- [ ] FR-vertaling laten reviewen door native FR-speaker (Belgisch register, formele 'vous')
- [ ] Sector-tabs + USP-render i18n-aware maken (incrementeel)
- [ ] Success-page + post-submit-summary vertalen
- [ ] Plausible event `language_switched` afvuren bij `setLang()` voor analytics-funnel
- [ ] Server-side i18n in Slot P PDF-engine (templates per taal)
- [ ] i18n voor `admin/contracten-wizard.html` (admin-flow voor partner-contracten — zelfde mechanisme, andere keys-set)
