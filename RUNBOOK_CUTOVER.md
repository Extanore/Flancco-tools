# Runbook — Productie-cutover naar `flancco-platform.be`

**Doel:** platform van GitHub Pages (`extanore.github.io/Flancco-tools/`) verhuizen naar Cloudflare Pages op `flancco-platform.be` met minimale downtime en directe rollback.

**Status voorbereiding** (afgerond in nacht 20→21 april 2026):
- Code-basis klaar op feature-branch `deploy/flancco-platform-be`
- `_headers` + `_redirects` geconfigureerd
- Security-headers, CSP, Sentry, cookie-banner, legal-pages allemaal live
- Edge-function `send-contract-link` v3 deployed (leest `CALCULATOR_BASE_URL` env-var)
- Resend-domein `flancco-platform.be` geregistreerd — DNS-records hieronder

**Niet gewijzigd in deze nacht (bewust):**
- DNS nameservers van `flancco-platform.be` blijven bij registrar
- Supabase Auth Site URL + Redirect URLs onveranderd
- Geen productie-cutover uitgevoerd

---

## Deel 1 — Pre-flight checklist (10 min)

Voor je één actie onderneemt:

- [ ] **Backup-bevestiging Supabase**: Dashboard → Database → Backups → controleer dat de laatste daily-backup < 24u oud is. PITR-window 7 dagen zichtbaar.
- [ ] **Cloudflare-account actief**: log in op `dash.cloudflare.com`. Als er nog geen account is: signup-free-account met `gillian.geernaert@flancco.be`.
- [ ] **Registrar-toegang**: weet waar `flancco-platform.be` geregistreerd staat (Combell / Versio / andere). Je hebt nameserver-wijzigingsrechten nodig.
- [ ] **Preview-URL getest**: open de `.pages.dev` preview-URL (zie onderaan dit document) en doorloop minimaal login → klant aanmaken → contract calculator-flow → PDF download. Als iets faalt: stop en diagnose.

---

## Deel 2 — Cloudflare Pages GitHub-integratie (5 min)

De preview-deploy uit nacht liep via wrangler direct-upload (geen auto-rebuild op git-push). Voor continue deploys link je nu GitHub:

1. Cloudflare Dashboard → **Workers & Pages** → selecteer project `flancco-tools`.
2. **Settings → Builds & deployments → Source → Connect to Git**.
3. OAuth-prompt voor Extanore GitHub-account → autoriseer repo `Extanore/Flancco-tools`.
4. **Production branch**: `main`.
5. **Preview deployments**: `All non-production branches` (zo krijgt elke feature-branch een preview).
6. **Build configuration**:
   - Framework preset: `None`
   - Build command: *(leeg)*
   - Build output directory: `/`
   - Root directory: `/`
7. Save. Cloudflare triggert nu automatisch een build van `deploy/flancco-platform-be` (actieve preview) én klaar voor de `main`-merge straks.

---

## Deel 3 — DNS switch (15 min, het "point of no return")

> **Belangrijk:** verlaag eerst de TTL bij je registrar naar 300s (5 min) minimaal 1 uur vóór je de switch doet, zodat rollback snel mogelijk is. Als je dat vergeten bent: wacht gewoon tot de huidige TTL (meestal 3600s = 1u) verlopen is alvorens rollback te overwegen.

### 3.A Nameservers verhuizen naar Cloudflare

1. Cloudflare Dashboard → **Websites → Add a site** → `flancco-platform.be` → Free plan.
2. Cloudflare scant bestaande DNS-records (waarschijnlijk geen — domein is nieuw). Bevestig import.
3. Cloudflare toont 2 nameservers, bijvoorbeeld:
   - `something.ns.cloudflare.com`
   - `other.ns.cloudflare.com`
4. Log in bij registrar (Combell / Versio / …) → domein-beheer → **Nameservers wijzigen** → vervang beide met Cloudflare-waarden.
5. Save bij registrar. DNS-propagatie: meestal 5–30 min, max 24u.

### 3.B DNS-records in Cloudflare toevoegen

Cloudflare DNS → **Add record** voor elk onderstaand:

| Type  | Name                | Content / Target                                      | Proxy  | TTL  |
|-------|---------------------|-------------------------------------------------------|--------|------|
| CNAME | `@`                 | `flancco-tools.pages.dev`                             | Proxy  | Auto |
| CNAME | `www`               | `flancco-tools.pages.dev`                             | Proxy  | Auto |
| CNAME | `app`               | `flancco-tools.pages.dev`                             | Proxy  | Auto |
| CNAME | `calculator`        | `flancco-tools.pages.dev`                             | Proxy  | Auto |
| TXT   | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDzdNMRvxtmnwQ6YLfsE+pHskpYPYxbDvf0gJ2xHSkSyVYOB95pKLL55Qu9wxvTDmDzG8BcvCVNhnmn60Y587N+2KDDtFNEBLlBLfmbnp+ZbFTn/tOzi7+AIxg5HQFmq9CM6DoakpqgZ/AAM9Zy5RuMMApd3mZ+nVHn/3llHeGg4QIDAQAB` | DNS-only | Auto |
| MX    | `send`              | `feedback-smtp.eu-west-1.amazonses.com` (priority 10) | DNS-only | Auto |
| TXT   | `send`              | `v=spf1 include:amazonses.com ~all`                   | DNS-only | Auto |
| TXT   | `_dmarc`            | `v=DMARC1; p=quarantine; rua=mailto:dmarc@flancco-platform.be; adkim=s; aspf=s` | DNS-only | Auto |

**Tips:**
- "Proxy" = oranje-wolkje (Cloudflare CDN + WAF) voor de hostnames die HTTP/S traffic ontvangen; "DNS only" (grijs-wolkje) voor e-mailrecords.
- De echte `pages.dev`-hostname krijg je zodra Cloudflare Pages GitHub gelinkt heeft (zie deel 2). Tot dan wijst elk CNAME naar de wrangler-preview-URL (staat onderaan dit document).
- DMARC-adres `dmarc@flancco-platform.be` hoeft (nog) niet te bestaan; feedback-rapporten worden door Resend intern gecapteerd.

### 3.C Custom domains koppelen in Cloudflare Pages

Cloudflare Pages project `flancco-tools` → **Custom domains → Set up a custom domain** voor elk:

1. `app.flancco-platform.be`
2. `calculator.flancco-platform.be`
3. `flancco-platform.be` (apex)
4. `www.flancco-platform.be`

Cloudflare doet automatisch certificaat-provisioning via Let's Encrypt (1–3 min per domein). Status wordt "Active" zodra klaar.

### 3.D Resend-domein verifiëren

Resend Dashboard → Domains → `flancco-platform.be` → **Verify DNS records**. Alle 3 records (DKIM, SPF MX, SPF TXT) moeten groen worden. Als ze rood blijven na 10 min: DNS-propagatie afwachten en opnieuw proberen.

---

## Deel 4 — Supabase configuratie (5 min)

### 4.A Auth URL Configuration

Supabase Dashboard → project `dhuqpxwwavqyxaelxuzl` → **Authentication → URL Configuration**:

- **Site URL**: `https://app.flancco-platform.be`
- **Redirect URLs** (comma- of newline-gescheiden):
  ```
  https://app.flancco-platform.be/**
  https://calculator.flancco-platform.be/**
  https://flancco-platform.be/**
  https://www.flancco-platform.be/**
  ```
- **Behoud** tijdelijk de oude GitHub Pages URLs in de Redirect-lijst (fallback-safety 90 dagen):
  ```
  https://extanore.github.io/**
  ```

Save. Verwacht: alle partner-logins blijven werken, zowel op oud als nieuw domein.

### 4.B Edge-function env-var

Supabase Dashboard → **Edge Functions → Settings → Secrets**:

| Naam                    | Waarde                                       |
|-------------------------|----------------------------------------------|
| `CALCULATOR_BASE_URL`   | `https://calculator.flancco-platform.be`     |
| `APP_BASE_URL`          | `https://app.flancco-platform.be`            |

> De edge-function `send-contract-link` heeft al een hard-coded fallback op `calculator.flancco-platform.be` — deze env-var override is optioneel maar aanbevolen voor consistente configuratie tussen functions.

### 4.C Storage bucket CORS (verificatie only, geen actie tenzij falende)

Supabase Dashboard → **Storage → Settings** voor buckets `partner-logos`, `handtekeningen`, `rapporten`:
- `Access-Control-Allow-Origin`: `*` (public buckets) of whitelist `https://*.flancco-platform.be`
- Als je CORS-errors ziet bij PDF-generatie → whitelist specifiek voor alle drie buckets.

---

## Deel 5 — Smoke-test checklist (10 min, post-cutover)

Binnen 15 min na DNS-switch + Cloudflare certs actief:

### 5.A HTTP-validatie

```bash
# Verwacht: HTTP/2 200 met 7 security-headers
curl -sSI https://app.flancco-platform.be | head -30
curl -sSI https://calculator.flancco-platform.be | head -30

# Verwacht: 301 redirect → app.flancco-platform.be
curl -sSI https://flancco-platform.be | head -5
curl -sSI https://www.flancco-platform.be | head -5
```

### 5.B Externe scanners

- **SSL Labs**: https://www.ssllabs.com/ssltest/analyze.html?d=app.flancco-platform.be → **A+** rating
- **Security Headers**: https://securityheaders.com/?q=app.flancco-platform.be → **A+** rating
- **Mail-tester**: stuur test-email via Supabase edge-function → forward naar test-adres op https://www.mail-tester.com → **10/10** score

### 5.C End-to-end functional test

- [ ] Open `https://app.flancco-platform.be` → login-scherm toont, Flancco-branding zichtbaar, cookie-banner onderaan.
- [ ] Login als Gillian → dashboard laadt, partner-lijst/klanten/contracten renderen correct.
- [ ] Open `https://calculator.flancco-platform.be/?partner=cwsolar` → CW Solar calculator toont met CW Solar-huisstijl.
- [ ] Open `https://calculator.flancco-platform.be/?partner=novectra` → Novectra calculator met Novectra-huisstijl.
- [ ] Voltooi een test-contract via de calculator-link → teken → submit → bevestig:
  - PDF auto-download met branded layout
  - Notification verschijnt in admin-sidebar
  - Email arriveert in inbox (niet spam-folder) vanuit `noreply@flancco-platform.be` (of `platform@flancco-platform.be`)
- [ ] Contract-detail in admin toont handtekening correct
- [ ] Sentry-dashboard: nul nieuwe fatal errors

### 5.D Rollback-trigger (als iets kritiek breekt)

Als binnen de eerste 30 min:
- >10% van auth-login-pogingen faalt, OF
- Calculator-submit faalt voor > 2 opeenvolgende pogingen, OF
- SSL cert niet provisioneert (blijft "Pending" > 20 min)

Dan: zie Deel 7 (Rollback).

---

## Deel 6 — Post-cutover hardening (eerste week)

### Dag 1–3

- [ ] Sentry-dashboard dagelijks checken op onverwachte error-patterns.
- [ ] Cloudflare Analytics dagelijks: verificeer WAF-rules blokkeren geen legit users.
- [ ] Supabase Auth-logs: geen spike in failed-login-attempts.

### Dag 4–7

- [ ] Service-role-key rotatie (security hygiene na major infra-wijziging):
  ```sql
  -- In Supabase SQL Editor (als admin):
  -- 1. Genereer nieuwe service role key via Dashboard → Settings → API → Regenerate
  -- 2. Update app_settings:
  UPDATE app_settings SET value = to_jsonb('<NIEUWE_KEY>'::text) WHERE key='service_role_key';
  ```
- [ ] Admin 2FA: Supabase Auth → `gillian.geernaert@flancco.be` → Enforce MFA via authenticator-app.
- [ ] RLS penetration-test uitvoeren (anon SELECT op `user_roles`, `contracten`, `rapporten` etc.) — alle moeten 0 rows teruggeven.

---

## Deel 7 — Rollback-procedure (emergency only)

### 7.A Snelle rollback (DNS, < 5 min impact)

Scenario: nieuwe site heeft kritieke bug, oude GitHub Pages werkt nog.

1. Cloudflare DNS → verwijder alle `A/CNAME` records voor `app.*`, `calculator.*`, apex, `www`.
2. Of: zet Proxy OFF op alle records → verkeer gaat niet meer via Cloudflare.
3. Optioneel: restore oude DNS-configuratie bij registrar (nameservers terug naar oude provider).
4. Supabase Auth URL Configuration → **Site URL** terug naar `https://extanore.github.io`.

Impact: partners op nieuwe URL krijgen timeout tot DNS TTL verloopt (300s als je die verlaagd had); oude URL blijft werken.

### 7.B Volledige rollback (> 5 min impact)

Scenario: data-corruptie of Supabase-migratie-issue — moet alles terug naar exacte staat pre-cutover.

1. Stap 7.A uitvoeren.
2. Supabase Dashboard → **Database → Backups → Point-in-Time Recovery** → restore naar timestamp **vóór** cutover.
3. Bevestig restore (kost 2–5 min).
4. Alle users opnieuw laten inloggen (sessions invalid na restore).

Let op: 7.B overschrijft alle data vanaf cutover. Gebruik alleen bij data-integriteit-issues.

---

## Deel 8 — Deprecate legacy (T+90 dagen)

Na 90 dagen stabiel productie op Cloudflare:

- [ ] Supabase Auth Redirect URLs: verwijder `https://extanore.github.io/**`.
- [ ] GitHub Pages setting: repo `Extanore/Flancco-tools` → Settings → Pages → Source → **Disable**.
- [ ] README.md bijwerken met "Hosted on Cloudflare Pages" + verwijzing naar runbook.
- [ ] DEPLOY.sh (al gedeprecieerd) kan verwijderd worden.

---

## Bijlage A — Credentials + tokens

> **Deze bijlage bevat geen geheimen**, alleen waar je ze kunt vinden.

- **Cloudflare API token** (voor toekomstige automation): ~/.config/cloudflare-api-token of 1Password
- **Resend API key**: Resend Dashboard → API Keys (huidige key `re_NLnAKhRX_Q7PtAjFkRWC29H6sMa2SMRMD` is actief)
- **Supabase service role key**: Dashboard → Settings → API (roteer post-cutover, zie Deel 6)
- **Sentry DSN**: public, reeds embedded in HTMLs — geen actie

## Bijlage B — Preview URL (gegenereerd in nacht 20→21 april)

**Cloudflare Pages project**: `flancco-tools` (account `89139283d98d1286c006c912b23e6cd9`)
**Production-URL** (nog leeg tot merge naar `main`): `https://flancco-tools.pages.dev`

**Preview-URLs van eerste upload** (branch `deploy/flancco-platform-be`, commit `39d92a6`):

| Type | URL | Doel |
|------|-----|------|
| Branch alias | `https://deploy-flancco-platform-be.flancco-tools.pages.dev` | Stabiel — verandert mee met elke nieuwe preview-deploy op deze branch |
| Unique deploy | `https://a025bd13.flancco-tools.pages.dev` | Pinned snapshot van deze specifieke deploy |

Gebruik bij voorkeur de **branch-alias URL** voor smoke-test want die update automatisch zodra je een fix pusht.

**Let op**: voor net-aangemaakte Pages-projecten provisioneert Cloudflare edge-SSL-certificaten in 5–15 minuten. Eerste smoke-test tijdens de nacht gaf TLS-handshake-fail om 21:46; verwacht dat curl/browser rond **22:00** (of zeker ochtend) 200 teruggeeft. Als het nog steeds faalt: log in op Cloudflare Dashboard → Workers & Pages → `flancco-tools` → controleer deployment-status.

**Smoke-test-paden** (plak in browser of via `curl -sSI`):
- `https://deploy-flancco-platform-be.flancco-tools.pages.dev/admin/` — admin-login-scherm
- `https://deploy-flancco-platform-be.flancco-tools.pages.dev/calculator/` — generic calculator
- `https://deploy-flancco-platform-be.flancco-tools.pages.dev/novectra/` — Novectra (via partner-slug in path)
- `https://deploy-flancco-platform-be.flancco-tools.pages.dev/cwsolar/` — CW Solar
- `https://deploy-flancco-platform-be.flancco-tools.pages.dev/privacy/` — GDPR privacyverklaring
- `https://deploy-flancco-platform-be.flancco-tools.pages.dev/voorwaarden/` — algemene voorwaarden
- `https://deploy-flancco-platform-be.flancco-tools.pages.dev/PLAN.md` — **moet 404** (defense-in-depth)

Volledige smoke-test:
1. Login-flow
2. Calculator-flow met `?partner=cwsolar` en `?partner=novectra` query params
3. PDF-generatie na ondertekening
4. Security-headers via `https://securityheaders.com/?q=deploy-flancco-platform-be.flancco-tools.pages.dev` → verwacht **A** (A+ vereist HSTS-preload na cutover naar flancco-platform.be)

Als iets faalt op de preview: fix op feature-branch `deploy/flancco-platform-be` → push → Cloudflare Pages herbuilt automatisch → her-test op dezelfde branch-alias URL. Pas daarna Deel 3 (DNS-switch) starten.

---

## Bijlage C — Contact bij problemen

- **Supabase support**: Dashboard → Help-icoon rechtsonder, Pro-plan prio-support binnen 24u
- **Cloudflare support**: Dashboard → Support, free-tier community forum
- **Resend support**: `support@resend.com` / Dashboard-chat
- **Claude (mij)**: nieuwe prompt met deze runbook + foutmelding — ik assisteer bij elke stap

---

**Einde runbook.**
