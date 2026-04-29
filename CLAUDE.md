# Flancco Partner Platform

## Werkstijl-directive (geldt voor élke nieuwe taak)

**Default: parallel agents, niet seriëel.**

Wanneer een nieuwe taak meerdere onafhankelijke onderdelen heeft (research + bouw, of meerdere file-disjoint wijzigingen), launch dan meerdere agents in **één bericht** (multiple `Agent` tool-calls in één assistant turn) zodat ze écht parallel draaien. Doel: minimale wachttijd voor de gebruiker.

Alleen seriëel als:
- Onderdelen raken dezelfde file in overlappende regio's
- Eén onderdeel is dependency van een ander
- Schema-migraties die elkaar's effect nodig hebben

Voor uitvoeren: kondig kort het parallel-plan aan ("ik launch X agents tegelijk voor Y/Z") en ga meteen door zonder te wachten op bevestiging.

## Project Overview
Commercial SaaS-platform voor Flancco BV (droogijsstralen + HVAC/technisch onderhoud + reiniging zonnepanelen) om partnercontracten voor zonnepaneelreiniging te beheren. Gehost op **Cloudflare Pages** (repo: `Extanore/Flancco-tools`), backend via **Supabase**.

## Tech Stack
- **Frontend**: Vanilla HTML/CSS/JS (single-file per page, geen build tooling)
- **Backend**: Supabase (PostgreSQL + Auth + RLS)
- **Hosting**: Cloudflare Pages
  - App + portal: `https://app.flancco-platform.be`
  - Calculator:   `https://calculator.flancco-platform.be` (partner-slug in path of query)
  - Apex `https://flancco-platform.be` → 301 naar app
  - Legacy fallback (90 dagen post-cutover): `https://extanore.github.io/Flancco-tools/`
- **Supabase JS**: CDN via `@supabase/supabase-js@2` (UMD bundle)

## Bestandsstructuur
```
Flancco-tools/
├── admin/index.html               — Admin dashboard (login, contracten, partners, pricing, winstgevendheid, instellingen)
├── admin/planning.html            — Planning + agenda (week/dag/maand views, QuickAdd, Interventie-modal)
├── admin/contracten-wizard.html   — Multi-step contract-wizard (klantkeuze → sector → pricing → onderteken)
├── admin/shared/                  — Shared componenten (gedeeld door admin/*.html)
│   ├── client-combobox.js         — Searchable klant-picker (vervangt native <select>, bedrijven-grouping)
│   ├── client-combobox.css        — Styles voor de combobox (.fcb- prefix)
│   ├── client-combobox-items.js   — Helper: clients-array → combobox-items (DRY voor 4 call-sites)
│   ├── client-combobox-resolver.js — Slot T: parser voor value-prefixes 'bedrijf:UUID' / 'contact:UUID' / 'contract:UUID' / '__new'
│   ├── client-combobox-demo.html  — Standalone test-pagina met 3 scenario's
│   ├── werklocatie-picker.js      — Slot T C2: kaarten-grid voor multi-locatie klanten (auto-select primary bij single)
│   ├── werklocatie-picker.css     — Styles (.fwp- prefix)
│   └── werklocatie-picker-demo.html — Standalone test 3 scenarios
├── novectra/index.html            — Calculator voor partner Novectra
├── cwsolar/index.html             — Calculator voor partner CW Solar
├── DEPLOY.sh                      — Git deploy script
└── CLAUDE.md                      — Dit bestand
```

Alle bestanden zijn **single-file HTML** met inline CSS en JS — behalve `admin/shared/` waar gedeelde componenten in afzonderlijke `.js`/`.css` files leven (geladen via `<script src>` + `<link>` in elke host-page). Geen npm, geen bundler.

### Shared component: FlanccoClientCombobox
Searchable klant-picker met bedrijven gegroepeerd, contactpersonen ingesprongen onder hun bedrijf, particulieren in eigen sectie. Vervangt native `<select>` op alle plaatsen waar een klant uit `clients`-tabel gekozen wordt:
- `qa-client` (Losse opdracht in `planning.html`)
- `ni-klant` (Nieuwe interventie in `planning.html`, met legacy-contracten als extra sectie)
- `uitgeef-client` (Bouwdroger uitgeven in `index.html`)
- `wiz-client` (Contract-wizard, partner-gefilterd, met magic `__new`-item bovenaan)

Pattern: native hidden input behoudt waarde voor backwards-compat met bestaande save-handlers. Initialisatie via `window.FlanccoClientCombobox.attach(wrapperEl, {items, onChange, ...})`. Items-shape gebouwd door `window.FlanccoClientItems.build(allClients, options)`. ARIA combobox pattern, keyboard-navigatie, accent-insensitive search, XSS-defensief.

**Slot T value-prefix conventie** (vanaf 2026-04-28): combobox emits prefixed values zodat save-handlers bedrijf-vs-persoon kunnen onderscheiden:
- `bedrijf:<client_id>` → "het bedrijf zelf, geen specifieke contactpersoon" → save met `client_contact_id = NULL`
- `contact:<client_contact_id>` → specifieke persoon binnen bedrijf → resolver lookt `client_id` op via cache, save met beide
- `contract:<contract_id>` → legacy ni-klant flow voor contracten zonder client_id
- `__new` → contract-wizard magic item ("+ Nieuwe klant aanmaken")
- `<UUID>` zonder prefix → legacy mode (default behavior)

Resolver-helper: `window.FlanccoClientResolver.resolve(value, allClientContacts)` returns `{client_id, client_contact_id, contract_id, isNew, raw}`. Items-builder ontvangt `{selectableHeaders: true, clientContacts: <array>}` om bedrijf-headers selectable te maken + multi-contact rendering.

### Shared component: FlanccoWerklocatiePicker
Kaarten-grid radiogroup voor werklocatie-keuze bij multi-locatie klanten. Single-locatie klanten: auto-select primary, geen UI-prompt. Multi-locatie: 2-column kaarten met label + adres + "Primair"-badge. Init via `window.FlanccoWerklocatiePicker.attach(wrapperEl, {clientId, allClientLocations, onChange, autoSelectIfSingle, allowNew, onAddNew})`. Verschijnt onder klant-keuze in: losse opdracht (`qa-locatie`), interventie (`ni-locatie`), contract-wizard (`wiz-werklocatie-card`), bouwdroger uitgeven (`uitgeef-locatie-fwp`). ARIA radiogroup, keyboard-nav, XSS-defensief.

### Shared component: FlanccoPipeline (Slot V/W)
5-fase pipeline-engine die zowel "Onderhoud" (Slot V, partner-recurrent) als "Flancco-werk" (Slot W, ad-hoc Flancco-interne klussen) aandrijft. Files: `admin/shared/pipeline-components.js` (1278 regels) + `pipeline-components.css` (803, prefix `.flp-`). Demo: `pipeline-components-demo.html` met 3 mock-records. Mode bepaalt fase-gedrag:
- `mode='onderhoud'` — 5 fases (In te plannen → Ingepland → Uitgevoerd → Rapportage → Uitgestuurd ter facturatie), fase 4 verplicht
- `mode='flancco'` — 5 fases met optionele rapport-fase (skipbaar bij interne klussen zonder rapport-eis)

Public API onder `window.FlanccoPipeline`:
- `computeFase(record)` → numerieke fase (1-5) op basis van status + timestamps
- `computeAging(record, now)` → uren sinds fase-entry
- `computeSlaBreach(record, partner, fase)` → boolean obv `partners.sla_fase_X_uren`
- `attachPage(wrapperEl, {mode, records, partners, onAction, ...})` — hoofd-mount
- `renderTabBar`, `renderAgingStrip`, `renderDispatcherCard`, `renderScheduleCard`, `renderActionCard`, `renderEmptyState` — losse render-helpers
- `constants` — fase-labels, kleuren, SLA-defaults

Auto-rendering placeholders via data-slot attributen (`data-slot="activity-log|klant-context|runbook-tip"`) — toolkit hooks zich in via MutationObserver. Pages live in `admin/index.html` als `#page-onderhoud` (wrapper `#onderhoud-pipeline-wrapper`) en `#page-flancco-werk` (wrapper `#flancco-werk-pipeline-wrapper`). Fase 4→5 transition gebruikt modal `modal-uren-controle` voor uren goedkeuren + facturatie-trigger.

### Shared component: FlanccoPipelineToolkit (Sarah-resilient)
Continuity-toolkit voor planner hand-off: 5 sub-componenten gebundeld in `admin/shared/pipeline-toolkit.js` (1584 regels). API onder `window.FlanccoPipelineToolkit`. Sub-componenten:
- `activity-log` — render `beurt_dispatch_log` rijen per beurt, supports manual entries via input
- `klant-context` — toont `clients.planner_notitie` + mini-historiek (laatste N beurten van klant)
- `runbook-tip` — contextuele tooltip uit `runbook_tooltips` per (fase, action_key) — admin kan in-place editen
- `handoff-banner` — body-class `handoff-mode` + dashboard-tegel als modus actief is

Auto-attach pattern: MutationObserver luistert op `data-slot` attributen (`activity-log`, `klant-context`, `runbook-tip`, `handoff-banner`) zodat host-pages enkel placeholder-elementen renderen — toolkit injecteert UI lazy. Module-level cache: `runbook_tooltips` permanent (admin-mutaties broadcasten via custom event), user-role 5min TTL (vermijdt RLS round-trips per render).

**Hand-off modus**: toggle in admin-instellingen (`#handoff-mode-card`, admin-only). Persisteert via `localStorage['flancco_handoff_mode_since']` (timestamp). Wanneer actief: tooltips, activity-log en klant-notitie worden default uitgeklapt op pipeline-pages — minimaliseert klikken voor vervangende planner.

## Supabase Configuratie
- **Project URL**: `https://dhuqpxwwavqyxaelxuzl.supabase.co`
- **Anon key**: staat in elk HTML-bestand als `SUPA_KEY`
- **Auth**: Email/password login (geen public signup — registratie is uitgeschakeld)

### Database Tabellen
- `partners` — id, naam, slug, marge_pct, planning_fee, kleur_primair, kleur_secundair, logo_url, contact_email, contact_telefoon, website, contract_getekend
- `pricing` — id, partner_id, staffel_min, staffel_max, label, flancco_forfait
- `contracten` — id, partner_id, klant_naam, klant_adres, klant_postcode, klant_gemeente, klant_email, klant_telefoon, aantal_panelen, frequentie, contractduur, forfait_per_beurt, totaal_excl_btw, totaal_incl_btw, handtekening (base64), datum_ondertekening, status
- `user_roles` — id, user_id (FK auth.users), role ('admin'|'partner'), partner_id (nullable FK partners)
- `klant_consents` (Slot Q) — GDPR consent-trail per klant per kanaal: id, contract_id (FK), klant_email, kanaal ('email_service'|'email_marketing'|'sms'|'whatsapp'), opt_in, opt_in_ts/bron/ip/ua, opt_out_ts/bron/ip, opt_out_token (UNIQUE), notitie. View `v_klant_consent_actief` toont laatste status per email/kanaal voor send-* functions.
- `klant_notification_log` (Slot F) — append-only audit-trail voor elke klant-notificatie poging: id, beurt_id (FK), contract_id (FK), partner_id (FK), kanaal ('email'|'sms'|'whatsapp'), event_type ('reminder_24h'|'reminder_day'|'rapport_klaar'|'test'), recipient (gemaskeerd), status ('sent'|'failed'|'skipped_no_consent'|'skipped_already_sent'|'skipped_missing_contact'|'skipped_daily_cap'), provider_message_id, error_detail, created_at. RLS: admin full SELECT, partner SELECT enkel eigen `partner_id`. Idempotency wordt afgedwongen via 7 timestamp-kolommen op `onderhoudsbeurten` (`reminder_24h_email_ts`, `reminder_day_email_ts`, `_sms_ts` × 2, `_whatsapp_ts` × 2, `rapport_klaar_email_ts`).
- `audit_log` (Slot H + v2) — business-kritieke mutatie-trail voor compliance, incidentonderzoek, klacht-verdediging: id, tabel, record_id, actie, oude_waarde (TEXT, JSON-string of scalar), nieuwe_waarde (TEXT, idem), user_id (nullable), created_at, **ip (INET)**, **user_agent (TEXT, max 500)**. Slot H v2 voegt `ip` + `user_agent` toe via `BEFORE INSERT` trigger `trg_audit_log_stamp_request_meta` die `current_setting('request.headers')` parst (cf-connecting-ip → x-forwarded-for first hop → x-real-ip). Service-role + pg_cron inserts → NULL (correcte system-vs-end-user-onderscheiding). Client-side helper `auditLog()` in `admin/index.html` past **PII-redactie** toe via `_auditSerializeSnapshot` + `AUDIT_PII_KEYS` whitelist (email/naam/adres/telefoon/handtekening/tokens → `[REDACTED:str:<len>]`, type-hint behouden voor zinvolle diff). Onder 7-jarige boekhoudkundige bewaarplicht — niet selectief purgeable. Partial index `audit_log_ip_idx WHERE ip IS NOT NULL` voor security-forensics.
- `beurt_dispatch_log` (Slot V/W Toolkit-2) — append-only activity-log per onderhoudsbeurt voor planner hand-off + incident-reconstructie: id, beurt_id (FK onderhoudsbeurten), type CHECK (`manual`|`snooze`|`system`|`transitie`|`mail`), text, user_id (nullable), created_at. Index `(beurt_id, created_at DESC)`. RLS: 3 policies — admin/bediende SELECT+INSERT; partner SELECT enkel eigen via JOIN op `onderhoudsbeurten → contracten.partner_id`. Status-transition trigger op `onderhoudsbeurten` schrijft auto rij bij elke status-wijziging (type=`transitie`).
- `runbook_tooltips` (Slot V/W Toolkit-5) — admin-bewerkbare contextuele tooltips per pipeline-fase + action_key voor planner-onboarding/hand-off: id, fase (1-5), action_key TEXT, text TEXT, updated_at. UNIQUE (fase, action_key). RLS: 4 policies — alle authenticated SELECT, admin INSERT/UPDATE/DELETE. 10 NL pre-seed defaults dekken kern-acties per fase.

### Slot T schema-additions (2026-04-28)
- `clients.contact_person` is **nullable** geworden — bedrijf-only-klanten (geen vaste contactpersoon). `client_type='bedrijf' AND contact_person IS NULL` = bedrijf-only mode.
- `clients` werkt al samen met aparte tabel `client_contacts` (id, client_id FK, first_name, last_name, email, phone, role, is_primary). Multi-contact per bedrijf wordt ondersteund.
- **Nieuwe FK-kolommen** op child-tabellen, allen UUID nullable, FK → `client_contacts(id)` ON DELETE SET NULL:
  - `onderhoudsbeurten.client_contact_id`
  - `contracten.client_contact_id`
  - `bouwdrogers.huidige_client_contact_id`
- Semantiek: `client_id NOT NULL + client_contact_id NULL` = "het bedrijf zelf, geen specifieke persoon"; `client_contact_id NOT NULL` = specifieke persoon binnen bedrijf
- Backfill: bestaande rijen krijgen `client_contact_id` van primary contact (is_primary=true)
- Partial indexen `WHERE client_contact_id IS NOT NULL` (sparse-friendly)
- Aanvullend: `bouwdrogers.client_location_id` UUID FK → `client_locations(id)` ON DELETE SET NULL — werklocatie-uitgifte i.p.v. alleen huidige_locatie-string
- `klant_consents.opt_out_door` TEXT (vrije input, "Naam X namens [bedrijf]") — voor bedrijf-only opt-out audit-trail

### Slot U schema-additions (2026-04-28)
- `techniekers.uit_dienst_sinds` DATE nullable. Trigger `trg_techniekers_sync_actief` synct `actief = (uit_dienst_sinds IS NULL OR > today)`. Cron-job `slot_u_techniekers_actief_daily` (00:05 UTC) deactiveert toekomstige uit-dienst-techs.
- `actief` boolean blijft bestaan voor backward-compat — alle 9+ filter-queries werken zonder code-wijziging
- View `v_winstgevendheid_per_technieker` herwerkt: filter `WHERE t.actief = true` weggehaald → ex-techs blijven zichtbaar in YTD-aggregaten met `uit_dienst_sinds`-suffix
- Hard-delete-pad enkel beschikbaar na 7 jaar bewaarplicht (boekhoudkundige eis); default flow is soft-delete via `uit_dienst_sinds`

### Slot V/W schema-additions (2026-04-29)
Slot V (Onderhoud) en Slot W (Flancco-werk) zijn twee nieuwe pipeline-pagina's in het admin-dashboard die dezelfde 5-fase pipeline-logica delen maar verschillende werk-types behandelen. Slot V toont partner-recurrent onderhoud (filter `contract.is_eenmalig=false`) met fase 4 (rapportage) verplicht; Slot W toont ad-hoc Flancco-interne klussen (filter `contract.is_eenmalig=true OR contract_id IS NULL`) met optionele rapport-fase. Beide pages delen één shared component (`FlanccoPipeline`) plus de Sarah-resilient continuity-toolkit (`FlanccoPipelineToolkit`) — gebouwd om bus factor 1 (één planner) te mitigeren via audit-stempels, activity-logs, klant-notities, hand-off modus en SLA-runbooks.

- `onderhoudsbeurten.snooze_tot DATE NULL` — Slot V fase-1 snooze
- `onderhoudsbeurten.last_modified_by/at` (Toolkit-1) — audit-stempel via BEFORE UPDATE trigger; cron/service-role updates → NULL (correct gedrag)
- `beurt_dispatch_log` (Toolkit-2) — append-only activity-log per beurt; types: `manual`/`snooze`/`system`/`transitie`/`mail`. Status-transition trigger op `onderhoudsbeurten` schrijft auto bij elke status-wijziging. RLS partner-tenant via JOIN.
- `clients.planner_notitie TEXT NULL` (Toolkit-3) — vrije tekst voor klant-preferences (geen GDPR-gevoelige content)
- `partners.sla_fase_{1,2,4,5}_uren INT NULL` (Toolkit-5) — per partner SLA per fase
- `runbook_tooltips` (Toolkit-5) — admin-bewerkbare tooltips, UNIQUE (fase, action_key), 10 NL pre-seed defaults

### Database Views
- `v_winstgevendheid_per_partner` (Slot G) — YTD-aggregatie per actieve partner: aantal afgewerkte beurten, omzet_excl_btw, planning_fee_kost, arbeids-/reis-/materiaalkost, brutomarge. `security_invoker=on`; admin ziet alle rijen, partner enkel eigen contracten via RLS.
- `v_winstgevendheid_per_sector` (Slot G) — Idem per genormaliseerde sector (`warmtepomp_*` → `warmtepomp`, whitelist of `overig`).
- `v_winstgevendheid_per_technieker` (Slot G) — Per-tech equal-share allocatie via `UNNEST(extra_technieker_ids)`; bevat `bezettingsgraad_pct` (v1: trekt verlof/feestdagen NIET af). Voedt de Winstgevendheid-pagina (voormalig forecast).

### Storage buckets
- `contracten-pdf` — getekende contracten (publiek voor klant-link)
- `handtekeningen` — handtekening PNG's (publiek)
- `gen-pdf` (Slot P) — privé bucket voor `generate-pdf` Edge Function output. 5 MB cap, PDF-only MIME. Path-vorm `<partner_slug>/<YYYY-MM-DD>/<filename>.pdf`. RLS: service_role full, admin read all, partner+bediende read alleen eigen slug-prefix.
- `partner-logos` — partner branding-logo's

### Edge Functions
- `send-confirmation` — bevestigingsmail post-signing met contract-PDF + herroepingsformulier (verify_jwt=false, public)
- `send-contract-link` — contract-link mail (verify_jwt=true)
- `generate-pdf` (Slot P) — generieke PDF-engine: templates `werkplanning|rapport_branded|contract_signed|facturatie_overzicht`. Auth-gating per template; werkplanning is public, rest vereist JWT + rol-check. Output naar bucket `gen-pdf` met signed URL TTL 7 dagen. (verify_jwt=false, custom auth in handler)
- `handle-opt-out` (Slot Q) — public GDPR opt-out endpoint. POST {token, confirm:true} → muteert `klant_consents` rij. Idempotent + rate-limited 10/min. (verify_jwt=false)
- `send-klant-notification-email` (Slot F) — klant-facing transactionele mail via Resend. Events: `reminder_24h`, `reminder_day`, `rapport_klaar`, `test`. Auth: service-role bearer OF user-JWT met admin/partner-owner. Idempotency via `${event_type}_email_ts`-kolommen. Consent-check op `v_klant_consent_actief` (kanaal=`email_service`). GDPR opt-out footer met token. (verify_jwt=false, custom auth)
- `send-klant-notification-sms` (Slot F) — Twilio Programmable SMS. E.164-normalisatie (BE shortform `04XX` → `+324XX`). Daily-cap via `TWILIO_DAILY_CAP` (default 100). Returns 503 `twilio_not_configured` zonder beurt-ts update bij ontbrekende secrets. `rapport_klaar` geweigerd via SMS. Consent vereist expliciete opt-in (kanaal=`sms`). (verify_jwt=false, custom auth)
- `send-klant-notification-whatsapp` (Slot F) — Meta WhatsApp Cloud API. Template-first payload `klant_${event_type}_${lang}` met components (header/body/button). Freeform fallback enkel via admin-JWT in 24h-venster. Daily-cap via `WHATSAPP_DAILY_CAP`. (verify_jwt=false, custom auth)
- `dispatch-klant-notifications` (Slot F) — pg_cron orchestrator (07:15 UTC dagelijks). Service-role bearer enforced (constant-time). Selecteert beurten met `plan_datum=tomorrow` (reminder_24h) en `plan_datum=today AND status='ingepland'` (reminder_day), vuurt parallel 3 kanalen via `Promise.allSettled`. `DISPATCH_MAX_BATCH=500`, channel-toggles via `DISPATCH_ENABLE_EMAIL/SMS/WHATSAPP`. (verify_jwt=false, service-role only)
- `invite-partner`, `invite-partner-member`, `create-bediende` — gebruikers-invites (admin-only)

### Scheduled Jobs (pg_cron)
- `slot_f_klant_dispatch_daily` (Slot F) — `'15 7 * * *'` (07:15 UTC dagelijks). Roept `SELECT dispatch_klant_notifications_via_http()` aan, een SECURITY DEFINER functie die `pg_net.http_post` gebruikt om `dispatch-klant-notifications` te invoken met service-role bearer. Vereist twee Vault-secrets: `slot_f_supabase_url` en `slot_f_service_role_key`.

### RLS Policies
- **Admin**: volledige CRUD op alle tabellen
- **Partner**: SELECT op eigen contracten (partner_id match), UPDATE op eigen partner-record (branding/instellingen), SELECT op `klant_consents` van eigen contracten, SELECT op `klant_notification_log` van eigen contracten
- **Anon**: INSERT op contracten + SELECT op pricing en partners (nodig voor calculatoren); INSERT op `klant_consents` met `opt_in_bron='calculator'`

### Edge Function Secrets vereist (Slot F)
- `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_REPLY_TO` — voor `send-klant-notification-email`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, optioneel `TWILIO_DAILY_CAP` — voor `send-klant-notification-sms`
- `WHATSAPP_PHONE_ID`, `WHATSAPP_ACCESS_TOKEN`, optioneel `WHATSAPP_API_VERSION` (default `v18.0`), `WHATSAPP_DAILY_CAP` — voor `send-klant-notification-whatsapp`
- `APP_BASE_URL` — basis voor opt-out links (default `https://flancco-platform.be/`)
- Optioneel: `DISPATCH_ENABLE_EMAIL`, `DISPATCH_ENABLE_SMS`, `DISPATCH_ENABLE_WHATSAPP` (default `true`) — staged rollout flags

### Partners in Database
| Naam | ID | Slug | Marge | Planning fee |
|------|-----|------|-------|-------------|
| Novectra | `7791bfc4-7923-4eec-936a-a4acdb09c718` | novectra | 15% | €25 |
| CW Solar | `50c2f3c8-10f5-491a-bcfb-73c23ac38a1a` | cwsolar | 15% | €25 |
| Flancco Direct | `93679849-afb0-4a69-8bd5-b74afdf22cad` | flancco | 0% | €0 |

### Admin User
- Email: `gillian.geernaert@flancco.be`
- Auth ID: `5b9821fa-fe3b-42a1-bcf1-6d3866dcf613`
- Role: admin (in `user_roles` tabel)

## Architectuur Admin Dashboard

### Rol-systeem
Na login wordt `user_roles` gecheckt. De body krijgt class `role-admin` of `role-partner`.
- CSS: `.admin-only` en `.partner-only` classes tonen/verbergen elementen per rol
- Admin ziet: Dashboard, Contracten (met filter + "Nieuw contract"), Partners, Prijsbeheer, Winstgevendheid (Slot G — voormalig Forecast), **Onderhoud** (Slot V — partner-recurrent pipeline), **Flancco-werk** (Slot W — ad-hoc pipeline), Instellingen (incl. hand-off modus toggle)
- Partner ziet: Dashboard (eigen stats), Contracten (alleen eigen klanten), Instellingen (branding)
- Dashboard bevat tegel **"Pipeline-status vandaag"** (admin-only, 5 buckets: SLA-breach, overdue, vandaag plan, vandaag uitvoering, wacht rapport) — klikbaar voor pre-filter naar Onderhoud/Flancco-werk pages

### Partner Branding
Bij partner-login wordt `applyBranding(partner)` aangeroepen die sidebar-kleur, CSS custom properties en logo aanpast op basis van partner-record.

### Prijsberekening
`(flancco_forfait × (1 + marge_pct/100) + planning_fee) × 1.21 = eindklantprijs incl. btw`

### Calculatoren (novectra/ en cwsolar/)
Elke calculator is een standalone pagina met:
- Staffelprijzen (momenteel hardcoded in TIERS array)
- Klantgegevens formulier
- Handtekening canvas
- Na ondertekening: insert in `contracten` tabel via Supabase JS + PDF download optie

### Sarah-resilient continuity (concept)
Bus factor 1 mitigatie: het platform draait operationeel op één planner. Wanneer die wegvalt (vakantie, ziekte, rolwissel) moet een vervanger binnen één dag de pipeline kunnen overnemen zonder tribal knowledge te verliezen. De toolkit (`FlanccoPipelineToolkit`) levert daarvoor 5 elementen:
1. **Audit-stempel** (`onderhoudsbeurten.last_modified_by/at`) — wie wijzigde wat, wanneer; via BEFORE UPDATE trigger, geen client-side discipline nodig
2. **Activity-log per beurt** (`beurt_dispatch_log`) — append-only narrative van élke transitie + handmatige notes; vervangt "ik onthoud waarom" met "ik lees waarom"
3. **Klant-notitie + mini-historiek** (`clients.planner_notitie` + laatste N beurten) — preferences + context die normaal in een planner-hoofd zitten
4. **Hand-off modus** — toggle in instellingen die tooltips, activity-log en klant-notitie default uitklapt op pipeline-pages, plus dashboard-tegel "Pipeline-status vandaag" als triage-startpunt voor de vervanger
5. **SLA per partner + admin-bewerkbare runbook-tooltips** (`partners.sla_fase_X_uren` + `runbook_tooltips`) — wat moet wanneer gebeuren + hoe; tooltips zijn admin-editable, dus runbook kan groeien zonder code-deploy

Pattern voor hand-off modus: `localStorage['flancco_handoff_mode_since']` zet body-class `handoff-mode`; CSS-rules in `pipeline-components.css` openen toolkit-secties default. Geen feature-flag in DB — modus is browser-local zodat elke vervanger zelf kan togglen.

## Openstaande Taken (TODO)

### Hoge prioriteit
1. **Git push**: Alle recente wijzigingen moeten nog gepusht worden naar GitHub
2. **Supabase email signup uitschakelen**: In Supabase Auth settings public signups disablen zodat niemand via de API een account kan aanmaken
3. **Test partner login flow**: Er bestaan nog geen partner user accounts om de partner-weergave te testen

### Medium prioriteit
4. **Dynamische pricing in calculatoren**: TIERS array is hardcoded — zou uit Supabase `pricing` tabel moeten laden
5. **renderContracten() partner-kolom**: Voor partners is de "Partner" kolom in de contractentabel overbodig (ze zien alleen eigen data) — extra relevant nu Slot V fase 5 (Uitgestuurd ter facturatie) handoff naar partner triggert
6. **Responsive design**: Dashboard is nog niet geoptimaliseerd voor mobiel
7. **Runbook-tooltips uitbreiden**: 10 NL pre-seed defaults dekken kern-acties; uitbreiden naar volledige fase-coverage zodra planner edge-cases identificeert via hand-off modus

### Laag prioriteit
8. **Contract detail view**: Klikbaar maken van contractrijen voor meer detail
9. **PDF export vanuit admin**: Contracten als PDF kunnen downloaden vanuit het dashboard
10. **Notificaties**: Email alerts bij nieuwe contracten

## Huisstijl Flancco
- Primaire kleur: navy `#1A1A2E`
- Accent: rood `#E74C3C` (rode O in logo)
- Achtergrond: wit/lichtgrijs `#F3F4F6`
- Font: system fonts (-apple-system, BlinkMacSystemFont, 'Segoe UI')
- Koppen: UPPERCASE

## Eigenaar
Gillian Geernaert — Business Development Flancco BV
Email: gillian.geernaert@flancco.be
