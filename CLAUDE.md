# Flancco Partner Platform

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
├── admin/index.html      — Admin dashboard (login, contracten, partners, pricing, winstgevendheid, instellingen)
├── novectra/index.html   — Calculator voor partner Novectra
├── cwsolar/index.html    — Calculator voor partner CW Solar
├── DEPLOY.sh             — Git deploy script
└── CLAUDE.md             — Dit bestand
```

Alle bestanden zijn **single-file HTML** met inline CSS en JS. Geen npm, geen bundler.

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
- Admin ziet: Dashboard, Contracten (met filter + "Nieuw contract"), Partners, Prijsbeheer, Winstgevendheid (Slot G — voormalig Forecast)
- Partner ziet: Dashboard (eigen stats), Contracten (alleen eigen klanten), Instellingen (branding)

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

## Openstaande Taken (TODO)

### Hoge prioriteit
1. **Git push**: Alle recente wijzigingen moeten nog gepusht worden naar GitHub
2. **Supabase email signup uitschakelen**: In Supabase Auth settings public signups disablen zodat niemand via de API een account kan aanmaken
3. **Test partner login flow**: Er bestaan nog geen partner user accounts om de partner-weergave te testen

### Medium prioriteit
4. **Dynamische pricing in calculatoren**: TIERS array is hardcoded — zou uit Supabase `pricing` tabel moeten laden
5. **renderContracten() partner-kolom**: Voor partners is de "Partner" kolom in de contractentabel overbodig (ze zien alleen eigen data)
6. **Responsive design**: Dashboard is nog niet geoptimaliseerd voor mobiel

### Laag prioriteit
7. **Contract detail view**: Klikbaar maken van contractrijen voor meer detail
8. **PDF export vanuit admin**: Contracten als PDF kunnen downloaden vanuit het dashboard
9. **Notificaties**: Email alerts bij nieuwe contracten

## Huisstijl Flancco
- Primaire kleur: navy `#1A1A2E`
- Accent: rood `#E74C3C` (rode O in logo)
- Achtergrond: wit/lichtgrijs `#F3F4F6`
- Font: system fonts (-apple-system, BlinkMacSystemFont, 'Segoe UI')
- Koppen: UPPERCASE

## Eigenaar
Gillian Geernaert — Business Development Flancco BV
Email: gillian.geernaert@flancco.be
