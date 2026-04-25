# Slot A4 — Werkplanning per-dag export

**Status:** Productieklaar. Continuous release — geen feature-flag, direct live op `admin/planning.html`.

## Intent

Per technieker per dag een nette PDF-werkplanning kunnen genereren en optioneel via WhatsApp delen, zodat:

1. Dispatchers vóór de start van de werkdag een fysiek/digitaal overzicht naar de tech kunnen sturen (in plaats van losse berichten met klant-adressen).
2. De tech een offline-bruikbaar A4-document heeft met klant + adres + tijd + scope + speciale instructies.
3. Geen handmatig knip-en-plak meer in WhatsApp — één klik, één pre-filled bericht met signed link (7 dagen geldig).

Bouwt op **Slot P** (`generate-pdf` Edge Function, template `werkplanning`). Geen nieuwe edge-function, geen nieuwe DB-objecten, geen nieuwe migratie.

## Architectuur

### Eén pagina, drie integratiepunten

| Locatie | View | Trigger | Zichtbaarheid |
|---|---|---|---|
| Week-view tech×dag-cel | `renderWeekView` | hover-action top-right (naast eventuele route-btn) | enkel als de cel ≥ 1 beurt heeft |
| Day-view tech-header | `renderDayView` | inline knop in `<th>` naast tech-naam | enkel als de tech die dag minstens 1 beurt heeft |
| Maand-view | `renderMonthView` | **niet beschikbaar** (zie keuze-rationale) | n.v.t. |

**Maand-view rationale:** maand-cellen aggregeren per dag over alle techs (één cell = totaal aantal beurten + sector-dots). Er is geen per-tech cel-granulariteit, dus een per-tech-export-knop heeft geen logische plaats. Eventuele toekomstige uitbreiding kan een dag-detail-popover toevoegen — uit scope voor A4.

### Files touched

| Path | Wijziging | Δ regels |
|---|---|---|
| `admin/planning.html` | + CSS (`btn-werkplanning-export*`, modal-stijlen, spinner) | ~140 |
|  | + modal HTML (`#modal-werkplanning-export`) | ~35 |
|  | + week-cell knop-injectie in `renderWeekView` | ~12 |
|  | + day-header knop-injectie in `renderDayView` | ~16 |
|  | + JS-blok (data-mapping, fetch, WhatsApp, error/loading) | ~480 |
| `calculator/i18n/nl.json.js` | + `planning.werkplanningExport.*` (23 keys) | ~30 |
| `calculator/i18n/fr.json.js` | + `planning.werkplanningExport.*` (23 keys) | ~30 |
| `docs/slots/slot-A4-werkplanning-export.md` | nieuw (deze doc) | — |

Geen Supabase-migraties. Geen edge-function-wijzigingen. Geen wijzigingen aan andere admin-paginas of de calculator.

## API-call shape

Slot P endpoint, template `werkplanning`. Volledig contract zie
[`supabase/functions/generate-pdf/README.md`](../../supabase/functions/generate-pdf/README.md).

```javascript
POST https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/generate-pdf
Headers:
  Content-Type: application/json
  apikey: <SUPABASE_ANON_KEY>
  Authorization: Bearer <admin_session_jwt>      // defense-in-depth, zie hieronder
Body:
  {
    "template": "werkplanning",
    "partner_slug": "flancco",                   // altijd default-branding voor admin-export
    "lang": "nl",                                // of "fr" via window.flanccoI18n.getLang()
    "data": {
      "datum": "YYYY-MM-DD",
      "technieker_naam": "Voornaam Naam",
      "technieker_telefoon": "+32 470 ...",      // optioneel
      "beurten": [
        {
          "id": "<uuid>",
          "klant_naam": "...",
          "klant_telefoon": "...",               // optioneel
          "klant_adres": "...",                  // optioneel
          "klant_postcode": "9080",              // optioneel
          "klant_gemeente": "...",               // optioneel
          "tijd_slot": "08:00 – 10:00",          // of "Hele dag" / start-only
          "start_tijd": "08:00",                 // optioneel
          "eind_tijd": "10:00",                  // optioneel
          "scope_samenvatting": "Zonnepanelen · 18 panelen", // optioneel
          "special_instructions": "Hond aanwezig — even bellen.",
          "aantal_panelen": 18,                  // alleen sector zonnepanelen
          "sector": "zonnepanelen",
          "geschatte_duur_min": 120
        }
      ]
    }
  }
```

Response (200): `{ success, url, path, expires_at, bytes, ... }` — `url` is een 7-dagen geldige signed Storage-URL.

### Auth-header policy

De `werkplanning`-template heeft `requiresAuth: false` in de Slot P-registry — een tech zonder admin-sessie zou de PDF in principe kunnen genereren. **Vanuit admin/planning.html sturen we tóch altijd de admin-session JWT mee** (`Authorization: Bearer <jwt>`), om twee redenen:

1. **Defense-in-depth.** Als de policy ooit gewijzigd wordt naar `requiresAuth: true` (bv. om misbruik tegen te gaan), breekt deze flow niet — het token zit er al.
2. **Sessie-validatie aan de bron.** We doen `sb.auth.getSession()` als pre-flight. Een ge-revoked of verlopen sessie wordt zo onmiddellijk gedetecteerd in de UI in plaats van pas bij een latere admin-actie. Bij ontbrekend token tonen we `errorMissingSession` en stoppen.

### Rate-limit & timeout

- Slot P: 30 requests/min per IP (default `GEN_PDF_RATE_LIMIT_PER_MIN`). Bij 429 → toont `errorRate` met retry-suggestie.
- Client-side: `AbortController` + 30 s timeout. Bij abort → toont `errorTimeout`.
- Debounce: 300 ms tussen klikken op dezelfde knop om accidental double-fire te voorkomen.

### `partner_slug` keuze

We sturen altijd `partner_slug: 'flancco'` (default-branding), ook als alle beurten van die dag van één enkele partner zijn. Reden: een tech-werkdag kan beurten van meerdere partners bevatten (mixed Novectra + CW Solar + direct Flancco), en partner-branding op een werkplanning waar maar één van die partners op staat is misleidend voor zowel de tech als de andere partners. De werkplanning is een **intern werkdocument**, niet een klantgericht artefact — Flancco-default-branding is de juiste keuze.

## UX-keuzes

### Modal vs popover

Gekozen voor **modal** (zelfde `modal-overlay` pattern als alle andere planning-modals) i.p.v. floating popover. Redenen:

- Consistent UX met de rest van de pagina (alle acties die buiten een cel-context vallen krijgen een modal — dagplus-kiezer, werkbon, plan-interventie, …).
- Loading-, success- en error-states hebben voldoende ruimte zonder layout-druk op de onderliggende kalender.
- Toegankelijkheid: focus-trap-gedrag is in de bestaande modal-class al geregeld; popover-flow zou eigen tab-trap-implementatie nodig hebben.
- Mobiel-vriendelijk (geen positionering t.o.v. anchor-element nodig).

De modal is bewust **smal** (`max-width:460px`) en bevat slechts twee primaire acties + een meta-strip — visueel een "action sheet", niet een formulier.

### Single-tech-per-dag vs gemixt

We exporteren **één tech voor één dag**. Bulk-export (alle techs van een week, of meerdere techs samen) is uit scope (Phase 2 in het plan). Dit houdt de UX fundamenteel simpel: de gebruiker kiest een specifieke cel, krijgt een PDF die exact die cel beschrijft.

### Hover-only vs always-visible

- **Week-view**: knop is `opacity:0` standaard, `opacity:0.7` bij `td:hover`, `opacity:1` op directe hover. Hetzelfde pattern als de bestaande route-btn — voorkomt visuele ruis op een dichte week-grid.
- **Day-view**: knop is `always visible` in de tech-header. De header is een lage-density zone (een kolomtitel) en heeft geen hover-context die de gebruiker zou activeren. Verbergen daar zou ontdekbaarheid breken.

### WhatsApp share-mechanisme

`wa.me/?text=<encoded>` met fallback op `wa.me/<E.164>?text=<encoded>` als `tech.telefoon` een geldige E.164 (of normaliseerbare BE-) waarde is. De normalize-helper accepteert `+32 470 12 34 56`, `0032470123456`, `0470/12.34.56`, `09 123 45 67`, …

Het bericht is **niet getekend** met enige PII van de klant — alleen tech-voornaam + datum + signed URL. De ontvanger (WhatsApp Web of mobiel) krijgt dan een share-sheet om het naar de juiste contact te sturen.

## Slot 0 events

Drie events worden gevuurd via `window.flanccoTrack(name, props)` (no-op als Plausible geblokkeerd is):

| Event | Wanneer | Props |
|---|---|---|
| `Werkplanning Export Opened` | modal-open | `beurten_count`, `lang` |
| `Werkplanning Generated` | succesvolle PDF-render | `tech_id`, `datum`, `beurten_count`, `lang`, `duration_ms` |
| `Werkplanning Shared` | klik op WhatsApp-knop | `via: 'whatsapp'`, `tech_id`, `has_phone`, `lang` |
| `Werkplanning Failed` | 4xx/5xx of timeout/abort | `error_type`, `lang` (geen PII), `duration_ms` indien beschikbaar |

Geen klant-PII in props (geen `klant_naam`, `klant_email`, geen telefoon-strings) — consistent met Slot 0 baseline.

Vergeet niet de event-tabel in `docs/slots/slot-0-event-logging.md` aan te vullen wanneer A4 in productie zit. Opvolger-PR.

## Testing

### JS-syntax

Vier `<script>`-blokken in `admin/planning.html` parsen cleanly via `new Function(code)` (Node 20):

```
block 1 OK    106 chars   (Sentry init)
block 2 OK    845 chars   (Sentry config)
block 3 OK    359305 chars (main app + Slot A4)
block 4 OK    456 chars   (cookie-consent)
```

Beide i18n-dictionaries parsen via `node -e "require('./nl.json.js')"` met +23 nieuwe leaf-keys, identiek tussen NL en FR.

### Phone-normalisatie unit-test

12/12 cases pass: `+32 470 12 34 56` → `+32470123456`, `0032470123456` → `+32470123456`, `0470/12.34.56` → `+32470123456`, `09 123 45 67` → `+3291234567`, `+33612345678` → pass-through (FR), `''/null/'abc'/'12345'` → `null`.

### Mentaal scenario walk-through

1. **Happy path week-view (NL).** Admin opent planning op week-view, ziet bij Jens op woensdag 5 beurten, hovert, ziet de download-icon top-right (29px van de rechterrand omdat de route-btn al rechts staat), klikt → modal opent met `Jens De Vos — woensdag 6 mei 2026 / 5 beurten vandaag` → klikt `PDF downloaden` → spinner → 2-3 s later → toast `Werkplanning gegenereerd`, browser opent download-tab, knop wijzigt naar `Open PDF in nieuw tabblad / Link 7 dagen geldig.`, WhatsApp-knop wordt enabled → klikt WhatsApp → nieuwe tab opent `wa.me/32470...?text=Hoi Jens, hier je werkplanning voor woensdag 6 mei 2026: https://dhuqpxwwavqyxaelxuzl.supabase.co/storage/...`.

2. **Day-view (FR).** Admin met taal=FR opent day-view voor 6 mei, in de `<th>` voor Jens staat een download-icon naast de naam, klikt → modal opent in FR (`Exporter le planning de travail`), de meta-strip toont `5 missions aujourd'hui`, klikt `Télécharger le PDF` → request gaat met `lang: 'fr'` → PDF in FR.

3. **Tech zonder beurten.** In day-view heeft Marc geen beurten op 6 mei → de knop in de `<th>` rendert niet (controle `techHasBeurten`). In week-view rendert de cel-knop niet (`exportTotal === 0`).

4. **Tech afwezig.** Cel toont `absent-cell` met verlof-stripe; export-knop wordt niet geïnjecteerd (controle `if (absent) {...} else { ...injecteer... }`). Day-view: `<th>` knop wordt onderdrukt door `if (!isTechAbsent(...))`.

5. **Sessie verlopen.** Pre-flight `sb.auth.getSession()` returnt `{session: null}` → modal toont `Geen actieve admin-sessie gevonden — herlaad de pagina.` → geen request afgevuurd.

6. **Server timeout (30 s).** AbortController vuurt na 30 s → `err.name === 'AbortError'` → `errorTimeout` (NL: "Het duurde te lang om de PDF te maken. Probeer opnieuw of contacteer support als dit blijft gebeuren.") + `Werkplanning Failed { error_type: 'timeout', lang }` event.

7. **HTTP 429 (rate-limit).** `errorRate` → `Te veel exports na elkaar. Wacht even en probeer opnieuw.` + event `Werkplanning Failed { error_type: 'http_429' }`.

8. **HTTP 401/403 (sessie revoked tijdens flow).** `errorAuth` → `Sessie verlopen. Log opnieuw in om de werkplanning te exporteren.`

9. **Modal sluiten tijdens render.** `closeWerkplanningExport()` aborteert het AbortController, maar het lopende request kan nog completen op de server (geen issue — orphan PDF in bucket vervalt na 7 dagen).

10. **Hergebruik laatste resultaat.** Na succes blijft `_wpeState.lastResult.url` aanwezig. Klik op `Open PDF in nieuw tabblad` triggert direct de download zonder nieuwe round-trip.

11. **Debounce.** Twee klikken binnen 300 ms op `PDF downloaden` → tweede klik = no-op (debounce), eerste klik bouwt request.

12. **Tech zonder telefoon.** WhatsApp-knop opent `wa.me/?text=...` zonder phone-prefix → user kiest contact in WhatsApp share-sheet.

## Rollback procedure

A4 is volledig additief. Geen DB-migratie, geen edge-function-wijzigingen, geen breaking changes aan bestaande UI-flows.

**Snelle rollback (1 commit revert):**

```bash
git revert <slot-a4-commit-sha>
```

Of, voor een **hot-toggle zonder revert**, plaats deze CSS-regel in een nieuw `<style>`-blok bovenaan `admin/planning.html`:

```css
.btn-werkplanning-export, .btn-werkplanning-export-th { display: none !important; }
```

De knoppen verdwijnen, het JS-blok blijft inert (geen call-sites). Modal-overlay is hidden by default (`display: none`).

**Geen partial-rollback nodig** voor de Slot P engine — A4 verbruikt enkel de bestaande publieke template `werkplanning` zoals gedocumenteerd. Geen edge-deployment.

## Bekende beperkingen / TODOs

- **Bulk-export (Phase 2):** alle techs voor een hele week in één PDF (of zip met N PDF's). Vraagt rate-limit-batching aan client-side.
- **SMS-share (Slot F territory):** Twilio-integratie voor `sms:` of API-call. Niet in A4 scope.
- **E-mail-share:** zou via Slot R-deliverability (SES) kunnen, maar de UX is meer overhead dan winst t.o.v. WhatsApp voor de tech-doelgroep. Geen prioriteit.
- **Print-fallback:** als generate-pdf langer dan 30 s onbereikbaar is, kan een toekomstige fallback de browser-print van de geselecteerde cel gebruiken. Vandaag: error + retry.
- **Bediende-rij in week-view:** bedienden hebben momenteel een aparte sectie zonder beurten-cellen — geen export-knop relevant. Niet getest, niet nodig.
- **i18n in admin/planning.html:** de calculator-i18n-runtime wordt op deze pagina niet geladen. Onze inline `wpeT()`-fallback dekt dit. Wanneer de admin-app i18n adopteert (Slot S-uitbreiding), kunnen de inline fallback-strings vervangen worden door pure `window.t(key)` calls — keys zijn al in beide dictionaries aanwezig.
- **PDF-cleanup:** Slot P bucket `gen-pdf` heeft nog geen scheduled cleanup-job (zie Slot P open follow-ups). A4 vergroot de bucket met ~20 KB per export-actie — niet kritisch op verwachte volumes (< 50 PDF/dag).
