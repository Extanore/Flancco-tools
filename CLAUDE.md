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
├── admin/index.html      — Admin dashboard (login, contracten, partners, pricing, forecast, instellingen)
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
- `invite-partner`, `invite-partner-member`, `create-bediende` — gebruikers-invites (admin-only)

### RLS Policies
- **Admin**: volledige CRUD op alle tabellen
- **Partner**: SELECT op eigen contracten (partner_id match), UPDATE op eigen partner-record (branding/instellingen), SELECT op `klant_consents` van eigen contracten
- **Anon**: INSERT op contracten + SELECT op pricing en partners (nodig voor calculatoren); INSERT op `klant_consents` met `opt_in_bron='calculator'`

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
- Admin ziet: Dashboard, Contracten (met filter + "Nieuw contract"), Partners, Prijsbeheer, Forecast
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
