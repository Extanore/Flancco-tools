# Slot 0 — Plausible event-logging baseline

## Intent

Een privacy-first, cookieless event-logging laag toevoegen die dient als
fundament voor latere slots (drop-off analyse, conversie-funnels,
partner-CTR). Plausible is gekozen boven PostHog/GA omdat:

- geen cookies — geen consent-banner nodig (GDPR-by-design)
- lichte payload (~1 KB) — geen impact op render-snelheid
- B2B-vriendelijk — eigenaar houdt dataverwerking onder EU-jurisdictie
- proxy-baar via subdomein voor adblocker-resistentie

Deze slot levert alleen de plumbing: script-tag, helper, CSP, doc. Concrete
event-calls volgen in latere slots.

## Files touched

Aangemaakt:

- `shared/analytics.js` — helper met `flanccoTrack()`, `flanccoTrackPageView()`
  en (sinds 2026-04-30 baseline-update) `flanccoTrackDropOff()`
- `docs/slots/slot-0-event-logging.md` — dit bestand

> **Locatie-noot.** De oorspronkelijke baseline-PR plaatste de helper in
> `shared/analytics.js` (root-level shared/), niet in `admin/shared/track.js`
> zoals een latere variant van het slot-plan voorstelde. We houden de
> bestaande locatie aan zodat de 8 reeds-geinjecteerde script-tags én alle
> bestaande `window.flanccoTrack`-call-sites blijven werken zonder breuk.

Aangepast (Plausible-snippet in `<head>`):

- `admin/index.html`
- `admin/planning.html`
- `admin/contracten-wizard.html`
- `admin/rapport.html`
- `admin/opmaat-calculator.html`
- `calculator/index.html`
- `portal/index.html`
- `flancco/index.html`
- `opt-out/index.html` (Slot Q)

CSP uitgebreid in `_headers` (zowel enforcing als Report-Only):

- `script-src` += `https://plausible.io https://analytics.flancco-platform.be`
- `connect-src` += `https://plausible.io https://analytics.flancco-platform.be`

## DNS / externe setup (manueel — niet in repo)

Wat Claude/agent niet zelf kan: account aanmaken bij Plausible, DNS-records
zetten in Cloudflare. Onderstaande stappen moet de eigenaar één keer doen
voor productie-data binnenkomt.

1. **Plausible-account.** Maak een account op `https://plausible.io`
   (Pro-plan ~€9/maand voor 10K events). Voeg `flancco-platform.be` toe
   als site — exact die naam, want `data-domain` in de snippet moet
   identiek zijn, anders worden events verworpen.
2. **Funnels per partner-slug.** Maak in het Plausible-dashboard funnels
   met properties-filter op `partner` zodat Novectra/CW Solar/Flancco
   apart leesbaar zijn (drop-off-analyse per partner is het hele punt).
3. **Adblocker-resistentie via CNAME-proxy** (aanbevolen vóór O3
   mobile-refactor live gaat — zonder dit verlies je ~25% van mobiele
   events aan adblockers/iOS-Safari-tracking-protection):
   - **Cloudflare DNS** (zone `flancco-platform.be`):
     - Type: `CNAME`
     - Name: `analytics`
     - Target: `custom.plausible.io` (Plausible noemt dit ook `cname.plausible.io`
       in nieuwe docs — exact volgen wat Plausible-dashboard "Custom domain"
       toont)
     - Proxy status: **proxied** (oranje wolk; verbergt origin van
       adblock-listen)
   - In Plausible-dashboard: **Site → Settings → Custom domain** →
     activeer `analytics.flancco-platform.be`.
   - Wacht op SSL-cert provisioning (~1-5 min) en TLS-handshake-check.
   - Swap dan in alle 9 HTML-pagina's:
     - `<script src="https://plausible.io/js/script.manual.tagged-events.js">`
       → `<script src="https://analytics.flancco-platform.be/js/script.manual.tagged-events.js">`
     - Voeg `data-api="https://analytics.flancco-platform.be/api/event"`
       toe aan dezelfde tag.
   - CSP in `_headers` is reeds voorbereid — geen extra wijziging nodig.
4. **Geen API-keys, geen secrets.** Plausible werkt enkel met het
   publieke `data-domain` attribuut; geen rotatie nodig.
5. **Verificatie** — open `https://app.flancco-platform.be/admin/` met
   DevTools open, Network-tab, filter op `plausible.io` of
   `analytics.flancco-platform.be`. Je moet een `200` of `202` zien op
   `/api/event` per relevante interactie.

## Deploy

Standaard pipeline volstaat:

```bash
./DEPLOY.sh
```

Cloudflare Pages picked up `shared/analytics.js` automatisch via Workers
Assets. Geen wrangler-aanpassingen nodig, geen DB-migratie.

## Rollback

Volledig stateloos — geen DB, geen Supabase-call, geen lokale storage.
Rollback in 1 commit:

1. Verwijder de drie `<script>`-regels uit de 8 HTML-pagina's.
2. Verwijder `shared/analytics.js`.
3. Herstel de CSP-regels in `_headers` naar de pre-Slot-0 versie.
4. Optioneel: archiveer/verwijder de site in Plausible-dashboard.

Geen verdere actie vereist — geen events in flight, geen historische data
om te migreren.

## Geïnstrumenteerde events (2026-04-30 baseline-uitbreiding)

Hou eventnamen consistent (Engels, Title Case) zodat ze in Plausible
groeperen. Geen PII in props — partner-slug, step-id, period-bucket en
booleaanse status mogen; e-mail/naam/adres/telefoon mogen nooit.

### Calculator-funnel (`calculator/index.html`)

| Event | Trigger | Props |
|---|---|---|
| `Calculator Step View` | bij elke `goToStep(n)` | `step`, `partner` |
| `Calculator Step Complete` | `goToStep` met hogere idx + bij signing-success voor stap `3` | `step`, `partner` |
| `Calculator BTW Keuze` | radio-change op stap 1 | `btw` (`6`/`21`), `partner` |
| `Calculator BTW6 Selected` | reeds bestaand — specifieke 6%-flow | _(geen)_ |
| `Calculator BTW6 Reverted To 21` | postcode buiten BE | `reason` |
| `Calculator Postcode Filled` | postcode-validatie BE+ | `country`, `deelgemeenten` |
| `Calculator Klant Type` | particulier/bedrijf radio | `type` |
| `Calculator Bedrijf Only Mode` | toggle bedrijf-only mode | `mode` |
| `Calculator Validation Error` | submit-validatie fail | `field` |
| `Calculator Signature Complete` | succesvolle handtekening (beide flows) | `partner`, optioneel `flow` |
| `Calculator Drop Off` | tab-close zonder sign | `step`, `partner` |
| `Contract Signed` | succesvolle insert in `contracten` | `partner`, `sectors`, `frequentie`, `duur_jaar`, `btw_pct`, `lang` |
| `VIES Validation` | BTW-check uitslag | `result`, `country` |
| `Language Switched` | i18n-pickup of postcode-trigger | `source`, `lang` |

### Admin planning (`admin/planning.html`)

| Event | Trigger | Props |
|---|---|---|
| `Planning View Change` | `switchView(view)` | `view` (`week`/`dag`/`maand`/`beschikbaarheid`/`rapportage`/`afgewerkt`/`interventies-tab`) |
| `Planning Feestdag Warning Shown` | feestdag-conflict modal opent | `feestdag_label`, `is_recurring` |
| `Planning Feestdag Warning Decision` | accept/reject modal | `decision` |
| `Werkplanning Export Opened` | werkplanning-export modal | _(meta)_ |
| `Werkplanning Generated` | succesvolle PDF | `aantal_beurten`, `lang` |
| `Werkplanning Failed` | error-pad | `error_type`, `lang` |
| `Werkplanning Shared` | share-link | `kanaal` |

### Admin partner-portal (`admin/index.html`)

| Event | Trigger | Props |
|---|---|---|
| `Partner Pipeline View` | `showPage('contracten')` voor `userRole === 'partner'` | `partner` |
| `Partner Facturatie Export` | umbrella bij CSV/PDF export | `partner`, `format` (`csv`/`pdf`), `period` |
| `Facturatie Export CSV` | reeds bestaand — detail | `partner_slug`, `periode_type`, `aantal_rijen`, `alleen_gefactureerd` |
| `Facturatie Export PDF` | reeds bestaand — detail | idem |
| `Facturatie Page View` | partner navigeert naar facturatie | `partner_slug`, `periode_type` |
| `Pipeline Tab Switched` | onderhoud/flancco-werk fase-tab | `tab` |
| `Pipeline Card Clicked` | beurt-card open | `status` |
| `Pipeline Action Bel Klant` / `Email Klant` / `Follow Up Toggled` | quick-actions per fase | n.v.t. / `new_value` |
| `Marketing Template Copied` | partner kopieert marketing-template | `template_id` |
| `Marketing QR Downloaded` | partner downloadt QR-PNG/SVG | `format`, `slug` |
| `Winstgevendheid Tab Switch` / `Period Change` | Slot G | `tab`, `period` |
| `Wizard Klant Type` / `Wizard VIES Validation` | contracten-wizard | `type`, `result`, `country` |

> **Decisie 2026-04-30:** umbrella-events (zoals `Partner Facturatie Export`)
> draaien naast detail-events (CSV/PDF) zodat we in Plausible zowel een
> grote-kop-funnel als een fijnmazige-breakdown houden zonder achteraf te
> moeten dedupliceren.

Wanneer een toekomstig slot een event toevoegt: vul deze tabel aan in
dezelfde PR — niet retroactief.

## Verificatie na deploy

1. Open `https://app.flancco-platform.be/admin/` met DevTools open.
2. Network-tab → filter op `plausible.io` → één request naar
   `script.manual.tagged-events.js` (200 OK) en één naar `/api/event`
   (202 Accepted) per pageview.
3. Console: `typeof window.flanccoTrack === 'function'` → `true`.
4. Plausible-dashboard ziet binnen ~30 seconden de pageview.

Adblocker-test: zet uBlock Origin actief, herlaad, controleer dat de
console géén errors toont en dat de app blijft functioneren.
