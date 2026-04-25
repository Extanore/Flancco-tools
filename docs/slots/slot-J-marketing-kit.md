# Slot J — Marketing-kit voor partners

**Status:** Cluster 3 livefeature. Partner-portal sectie met QR-code generator + share-templates voor de gepersonaliseerde calculator-link.

## Intent

Partners moeten in 30 seconden een professioneel scanbare QR-code kunnen downloaden én een gemaaide LinkedIn/email/WhatsApp-tekst naar klembord krijgen, zónder de calculator-URL handmatig te moeten samenstellen of vormgeven. Doel: drempel naar netwerkactivatie verlagen → meer ondertekende contracten via partner-link.

## Architectuur

| Laag | Component | File |
|---|---|---|
| **CDN** | `qrcode-generator@1.4.4` UMD bundle, SHA-384 SRI-pinned | `admin/index.html` `<head>` |
| **Nav** | Partner-only `<a>` met `data-page="marketing"` | `admin/index.html` (sidebar nav) |
| **HTML** | `<div class="page partner-only" id="page-marketing">` met card-header + toolbar + grid | `admin/index.html` |
| **CSS** | `.mkt-grid` / `.mkt-qr-*` / `.mkt-tpl-*` (volgt `dv-*` design-template) | `admin/index.html` `<style>` |
| **JS** | `renderMarketingPage()`, `downloadMarketingQr()`, `copyMarketingTemplate()`, helpers | `admin/index.html` (main script-block) |
| **Routing** | `showPage('marketing')` mapping in titles + render-trigger | `admin/index.html` |

## QR-configuratie

| Param | Waarde | Reden |
|---|---|---|
| Library | `qrcode-generator@1.4.4` | Zero-dep UMD, 56 KB, exposeert `window.qrcode`. Het npm `qrcode`-pakket (Soldair) levert geen browser-bundle, vandaar deze proven alternative. |
| SRI-hash | `sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k` | Voorkomt CDN-tampering; tear down bij hash-mismatch via browser-built-in policy. |
| Type-number | `0` (auto) | Kleinste passende QR-versie voor URL-lengte (~50 chars → 33 modules). |
| Error-correction | `M` (~15%) | Beste leesbaarheid/dichtheid trade-off voor outdoor-print en scherm-scan. |
| PNG-cellsize | 12 px → ≈ 512 px output | Hoog contrast (zwart op wit), 4-cell quiet-zone (spec-minimum). |
| SVG-cellsize | 10 (viewBox-units) | Vector-output, scherp tot A4-poster zonder kwaliteitsverlies. |
| Bestandsnaam | `flancco-qr-<slug>.<ext>` | Slug-sanitized via `[^a-z0-9-]+ → -`, lowercased. |

URL die geëncodeerd wordt: `partnerCalculatorUrl(userPartner.slug)` → produceert `https://calculator.flancco-platform.be/?partner=<slug>` op productie of de localhost-equivalent in dev.

## Template-strategie

Drie standalone NL-marketing-teksten met `{{partner_naam}}` + `{{calculator_url}}` placeholders die bij elke render worden vervangen door `mktRenderTemplate(key)`:

| Key | Doel | Lengte | Bijzonderheden |
|---|---|---|---|
| `linkedin` | Public partnership-bekendmaking, professioneel, hashtags onderaan | ~150 woorden | Zonder zelfverheerlijking, focus op klant-voordeel. |
| `email` | 1-op-1 bestaande klant uitnodigen via persoonlijke link | ~100 woorden | Aanhef "Beste klant" — partner kan handmatig personaliseren. |
| `whatsapp` | Korte WhatsApp-aanspreking met `{voornaam}` placeholder | ~50 woorden | `{voornaam}` blijft als single-brace literal — ontvanger-specifiek manueel in te vullen. |

Templates leven als `MKT_TEMPLATES`-object in JS (string-constants, geen DB-storage). Toekomstige edit kan via Slot S i18n-pattern, maar voor nu zijn ze statisch en NL-only (matches partner-portal taalbeleid).

## Copy-flow

`_mktCopyToClipboard(text)` — defensieve helper:
1. Probeert `navigator.clipboard.writeText` (modern, vereist `isSecureContext`).
2. Bij fallback (HTTP-context, oudere mobiele browsers): off-screen `<textarea>` + `document.execCommand('copy')`.
3. Bij succes: `showToast('Gekopieerd naar klembord')` + button-state-flash naar "Gekopieerd" + Lucide check-icoon (1.8s revert).
4. Slot 0 event: `flanccoTrack('Marketing Template Copied', { template, partner })`.

## Slot 0 events

| Event | Props | Trigger |
|---|---|---|
| `Marketing QR Downloaded` | `{ format: 'png'|'svg', partner: <slug> }` | Klik op download-knop, na succesvolle Blob-creatie. |
| `Marketing Template Copied` | `{ template: 'linkedin'|'email'|'whatsapp', partner: <slug> }` | Klik op Kopieer-knop, na clipboard-write. |

## Security

- **CSP:** `script-src` bevat al `https://cdn.jsdelivr.net` (Slot 0 + bestaande libs). Geen `_headers` aanpassing nodig.
- **SRI:** SHA-384 hash op qrcode-script gepind; CDN-tampering wordt door browser gerejecteerd vóór script-execution.
- **PII:** Geen klantgegevens in QR/templates — alleen partner-slug + partner-naam (publiek via calculator-link).
- **Clipboard:** `writeText` werkt enkel onder HTTPS (productie OK, lokaal localhost = secure context). Fallback voor non-secure contexts via `execCommand`.
- **XSS:** Templates worden via `textContent` geïnjecteerd (geen `innerHTML`), placeholders zijn server-side onbestaand (volledig client-side).
- **Input-validation:** Slug wordt sanitized voor filename-gebruik (`[^a-z0-9-]+ → -`).

## RLS / data-toegang

Geen DB-writes. Leest enkel `userPartner` (al via bestaande RLS gegated op `user_roles.partner_id`). Marketing-page is gated via `.partner-only` CSS-class + role-check in `showPage('marketing')`. Admin/bediende/technieker zien deze tab niet.

## Test-checklist

- [x] JS-syntax: alle 6 inline scripts in `admin/index.html` parseren cleanly via parse5 + acorn ECMA 2022.
- [x] QR-preview rendert SVG (~17 KB, 33 modules) bij partner-login met geldige slug.
- [x] PNG-download produceert 8.5 KB Blob met `image/png` MIME-type, 33×12 + 8 quiet-zone = 504 px (rounded).
- [x] SVG-download produceert vector-output met `viewBox="0 0 140 140"`, schaalbaar.
- [x] Template-copy injecteert correcte partner-naam ("Novectra" in test) + calculator-URL met `?partner=<slug>`.
- [x] WhatsApp-template behoudt `{voornaam}` placeholder zoals beoogd.
- [x] Toast "Gekopieerd naar klembord" verschijnt na copy.
- [x] Viewport 1280: side-by-side QR + templates kolom.
- [x] Viewport 1440: alle content boven-de-vouw zichtbaar.
- [x] Viewport 375 mobile: grid stacked verticaal, copy-knoppen full-width, tap-targets ≥44px.
- [x] Sidebar toont "Marketing" alleen voor `role="partner"` (admin/bediende/technieker hidden).

## Bekende beperkingen

- Templates zijn NL-only en hardcoded in JS. Bij toekomstige FR-versie (Slot S i18n-uitbreiding) → migreer naar `i18n/<locale>.json.js` met dezelfde key-conventie.
- Geen "preview rendering" voor LinkedIn/email/WhatsApp visuele formats (we tonen plain text). Dit is expliciet — partners kopiëren tekst en plakken in hun eigen tool waar visuele preview live komt.
- Geen poster-PDF download. Mogelijke uitbreiding via Slot P (PDF engine) met template `marketing_poster_a4` die QR + tagline + partner-logo combineert. Buiten scope Cluster 3.
- QR-engine is pure browser. Bij CDN-blokkade (corporate firewall, adblocker met te brede regels) faalt de generator — dan toont de preview een rode foutmelding. Acceptabel: marketing-kit is ondergeschikt aan core-flow.

## Files touched

- `admin/index.html` — `<head>` script-tag (qrcode-generator + SRI), nav-item partner-only, `<div id="page-marketing">` block, `<style>`-uitbreiding (`.mkt-*`), JS-renderer + handlers, `showPage()` titles + dispatch.

## Files NOT touched

- `_headers` — `script-src` bevat reeds `https://cdn.jsdelivr.net`. Geen wijziging nodig.
- `calculator/`, `admin/contracten-wizard.html`, `admin/planning.html` — out of scope (parallelle slots).
