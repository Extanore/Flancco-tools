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

- `shared/analytics.js` — helper met `flanccoTrack()` en `flanccoTrackPageView()`
- `docs/slots/slot-0-event-logging.md` — dit bestand

Aangepast (Plausible-snippet in `<head>`):

- `admin/index.html`
- `admin/planning.html`
- `admin/contracten-wizard.html`
- `admin/rapport.html`
- `admin/opmaat-calculator.html`
- `calculator/index.html`
- `portal/index.html`
- `flancco/index.html`

CSP uitgebreid in `_headers` (zowel enforcing als Report-Only):

- `script-src` += `https://plausible.io https://analytics.flancco-platform.be`
- `connect-src` += `https://plausible.io https://analytics.flancco-platform.be`

## DNS / externe setup (manueel — niet in repo)

1. Maak een Plausible-account op `https://plausible.io`.
2. Voeg `flancco-platform.be` toe als site (exact die naam — `data-domain`
   in de snippet moet identiek zijn, anders worden events verworpen).
3. Optioneel (toekomstige hardening tegen adblockers): zet een
   CNAME-record `analytics.flancco-platform.be` → `custom.plausible.io`,
   activeer custom-domain in Plausible-dashboard, en swap `data-api` +
   script-`src` in alle 8 HTML-pagina's. CSP staat hier al klaar.
4. Geen API-keys, geen secrets — Plausible werkt enkel met het publieke
   `data-domain` attribuut.

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

## Geïnstrumenteerde events

Slot 0 levert geen `flanccoTrack()`-calls in productiecode. Onderstaande
tabel houdt bij welke events wáár worden gevuurd zodra latere slots
landen. Hou eventnamen consistent (Engels, Title Case) zodat ze in
Plausible groeperen.

| Event | Trigger | Pagina | Slot |
|---|---|---|---|
| _(reserved)_ `Page View` | automatisch via Plausible | alle | 0 |
| _(reserved)_ `Calculator Started` | calculator-pagina mount | `calculator/` | volgend |
| _(reserved)_ `Calculator Step Completed` | wizard-stap voltooid | `calculator/`, `admin/contracten-wizard` | volgend |
| _(reserved)_ `Contract Signed` | succesvolle insert in `contracten` | `admin/contracten-wizard`, `calculator/` | volgend |
| _(reserved)_ `Partner CTA Click` | klik op partner-branded CTA | `calculator/` | volgend |
| _(reserved)_ `Report Generated` | succesvolle PDF-render rapport | `admin/rapport` | volgend |
| _(reserved)_ `Portal Login` | succesvolle magic-link sessie | `portal/` | volgend |

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
