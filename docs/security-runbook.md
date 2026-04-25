# Security runbook — Flancco Platform

**Doel:** snelle, gestructureerde response bij vermoede security-incidenten. Geen paniek, geen ad-hoc beslissingen — volg de stappen, log alles, communiceer transparant.

> **Gold rule:** als er twijfel is over scope, behandel het als **wel** een incident. Beter een keer onnodig rotaten dan een lek niet dichten.

---

## 0. Contact-flow (eerste 15 minuten)

| Rol | Contact | Bereikbaarheid |
|---|---|---|
| Primair (eigenaar) | Gillian Geernaert | `gillian.geernaert@flancco.be` |
| Backup (technisch) | Extanore | `info@extanore.be` |
| Hosting (Cloudflare) | Cloudflare Support | dashboard → Support, account-eigenaar via primaire mail |
| Backend (Supabase) | Supabase Support | dashboard → Support, Pro-plan = 24u SLA |
| Email (Resend) | Resend Support | `support@resend.com` |

**Eerste actie altijd:** WhatsApp of bel Gillian. Geen mail-only tijdens vermoed lek (mail-systeem zelf kan gecompromitteerd zijn).

---

## 1. Detectie — hoe weten we dat er iets mis is

### 1.1 Automatische signalen

- **Supabase Advisors** (`get_advisors` MCP) — security-advisors > 0 na deploy
- **Sentry** — error-rate spike (>1%/uur) of nieuwe error-class met security-relevante stack-trace
- **Cloudflare WAF** — blocked-request rate spike, of nieuwe attack-pattern in dashboard
- **Resend** — bounce-rate spike (>5% = mogelijk gecompromitteerde sender of hijack-attempt)
- **Plausible** — onverklaarde traffic-spike op gevoelige paths (`/admin/*`)
- **Failed RLS-violations** — log-entry in `audit_log` (Slot H, when live)

### 1.2 Externe signalen

- Gebruiker meldt verdachte mail / login-poging
- Klant meldt dat data verschenen is die ze niet zelf invulden
- HaveIBeenPwned of vergelijkbare meldingen voor `*@flancco-platform.be` adressen
- Security-researcher contact (responsible disclosure)

---

## 2. Triage — eerste 30 minuten

### 2.1 Bepaal scope

Beantwoord deze 5 vragen, **schriftelijk in een tijdgestempeld document** (Notion/Google Docs/eigen incident-log):

1. **Wanneer begon het?** (eerste detectie-tijdstip + best-guess startpunt)
2. **Welke systemen zijn betrokken?** (Cloudflare Pages? Supabase DB? Specific edge function? Email?)
3. **Welke data is mogelijk geraakt?** (PII van klanten? Partner-credentials? Service-role key?)
4. **Is de aanval nog actief?** (Cloudflare-logs check op laatste 5 min)
5. **Wie heeft hier zicht op?** (alleen ik? Externe partij?)

### 2.2 Containment-beslissing

| Scenario | Eerste actie |
|---|---|
| Service-role key gelekt | Rotate **NU** (zie §3.1). Blok alle edge-functions tot rotation klaar. |
| Admin-account gecompromitteerd | Reset wachtwoord + log uit alle sessies (zie §3.2). |
| Klant-data lek (zichtbaar voor verkeerde rol) | Disable RLS-policies gerelateerd aan endpoint. Pas policy aan. Re-enable. (Zie §3.3) |
| Defacement van publieke page | Cloudflare Pages → Deployments → Rollback naar laatste schone deploy. |
| DDoS / abnormaal volume | Cloudflare → Security → "Under Attack Mode" toggle aan. |
| Gecompromitteerde edge function (code-injectie via dependency) | Pin alle CDN-deps op exacte versies; redeploy. (Zie §3.5) |
| Email-spoofing namens ons domain | DMARC `p=quarantine` → `p=reject` (zie `deliverability.md` §1.3). |

---

## 3. Containment-procedures

### 3.1 Rotate Supabase keys

**Anon key (CLIENT-side, in elke HTML):**

1. Supabase Dashboard → Project Settings → API → Anon key → "Roll key"
2. Update **alle** HTML-files met de nieuwe key (search-replace `SUPA_KEY = '...'`)
3. Commit + push → Cloudflare Pages deploy. Verifieer via preview eerst.
4. Oude key blijft 24u geldig (overlap-window) — daarna invalid. Plan deploy binnen dit window.

**Service-role key (SERVER-side, in edge function env-vars):**

1. Supabase Dashboard → API → service_role key → "Roll key"
2. Edge functions → elk function → Settings → Environment variables → update `SUPABASE_SERVICE_ROLE_KEY`
3. Trigger redeploy van elke edge function (via dashboard of `supabase functions deploy <name>`)
4. Verifieer met test-curl op één function dat het werkt
5. **NOOIT service-role key in client-side code, ooit. Als die ergens in een HTML-file staat: emergency-rotate + zoek hoe het daar kwam.**

### 3.2 Reset admin / partner wachtwoord

1. Supabase Dashboard → Authentication → Users → zoek user
2. Click user → "Send password reset" of "Reset password" (admin-action)
3. Force log-out alle sessies: Authentication → User → "Sign out user"
4. Log in `audit_log` met reden (Slot H)
5. Communiceer met user via 2FA-kanaal (telefoon, NIET email tot mail-veiligheid bevestigd)

### 3.3 RLS-policy fix

1. Identificeer de leaky policy via `pg_policies` view in SQL editor
2. **Disable**: `ALTER TABLE <tabel> DISABLE ROW LEVEL SECURITY` — tijdelijk; betekent niemand mag iets via API
3. Patch policy: `DROP POLICY ...; CREATE POLICY ...;`
4. Test als anon, partner, admin via SQL editor `SET LOCAL ROLE`
5. **Re-enable**: `ALTER TABLE <tabel> ENABLE ROW LEVEL SECURITY`
6. Run `get_advisors` (MCP) → moet 0 security-issues teruggeven

### 3.4 Cloudflare Pages rollback

1. Dashboard → Workers & Pages → Flancco-tools → Deployments
2. Vind laatste schone deploy (vóór incident-tijdstip)
3. Click "..." → "Rollback to this deployment"
4. Live binnen ~30 sec
5. Document in incident-log: timestamp van rollback + commit-hash van schone versie

### 3.5 CDN-dependency pinning (post-Polyfill.io-style attacks)

1. Open `_headers` → CSP `script-src` → check welke CDN-bronnen toegelaten zijn
2. Voor elke CDN-script in HTML-files: voeg `integrity="sha384-..."` (SRI-hash) toe als nog niet aanwezig
3. Pin op exacte versie, geen `@latest`. Bijvoorbeeld `@supabase/supabase-js@2.39.7` ipv `@2`
4. Generate SRI-hashes via `https://www.srihash.org/` of `openssl dgst -sha384 -binary <file> | openssl base64 -A`
5. Test in preview, dan deploy

---

## 4. Eradication — root cause + permanente fix

Niet stoppen bij containment. Voor élke incident:

1. **Root cause analyse** — schriftelijk, blameless. Vraag "5x waarom" tot je echt onderaan zit.
2. **Permanente fix** — patch in code + tests + monitoring zodat zelfde issue niet opnieuw kan
3. **Detectie verbeteren** — als incident X niet automatisch werd gedetecteerd, voeg detectie toe (Sentry rule, Supabase-trigger, log-pattern)

---

## 5. Recovery — terug naar normaal

1. Verifieer alle systemen werken (smoke-test alle top-3 user-flows uit plan §5.1)
2. Re-enable features die uit-stonden tijdens incident
3. Communiceer met betrokken users (klanten, partners) — zie §6
4. Sluit het incident-log af met:
   - Tijdslijn (detect → contain → eradicate → recover)
   - Wat is geraakt (data, users, downtime)
   - Wat is gedaan
   - Lessen + opvolg-actiepunten

---

## 6. Communicatie — extern + intern

### 6.1 GDPR-meldplicht (Art. 33 AVG)

> **Datalek met risico voor betrokkenen** = melding aan **Gegevensbeschermingsautoriteit (GBA)** binnen **72 uur**.

- Online portal: https://www.gegevensbeschermingsautoriteit.be/burger/acties/melding-uit-hoofde-van-de-avg
- Vereist: aard van de inbreuk, categorieën + aantal betrokkenen, gevolgen, genomen maatregelen
- Registreer ELK datalek (ook zonder meldingsplicht) intern in een **datalek-register** — verplicht onder GDPR

### 6.2 Communicatie naar klanten

- **Bij confirmed lek van PII**: persoonlijke mail + telefoon binnen 24u na confirmation
- **Boodschap-structuur**: feiten + impact + genomen maatregelen + wat klant zelf moet doen + wie ze contacteren met vragen
- **Geen vakjargon**, geen excuses-taal die schuld minimaliseert
- Template ligt klaar in `docs/templates/datalek-melding-klant.md` (TODO — opstellen vóór eerste partner-onboarding)

### 6.3 Communicatie naar partners

- Apart kanaal (WhatsApp-groep of dedicated email-thread)
- Transparant over wat is gebeurd + impact op hun klanten
- Geen blamen van de gebruiker

---

## 7. Post-mortem — binnen 7 dagen

Verplicht document, blameless format:

1. **Samenvatting** (3-5 zinnen)
2. **Tijdslijn** (UTC-tijdstamps, 1 regel per event)
3. **Root cause**
4. **Wat liep goed** (snelle detectie? snelle containment?)
5. **Wat liep niet goed** (gemiste detectie? slow rollback?)
6. **Actiepunten** (concreet, met owner + deadline, niet "we moeten beter monitoren")

Opslag: `docs/incidents/<YYYY-MM-DD>-<korte-titel>.md`

---

## 8. Preventie — periodieke checks

| Check | Frequentie | Owner |
|---|---|---|
| Supabase `get_advisors` (security + performance) | Wekelijks + na elke migratie | Gillian / agent |
| Dependency CVE-scan (Snyk gratis tier) | Maandelijks | Gillian |
| DNS-records integriteit (SPF/DKIM/DMARC) | Maandelijks | Gillian |
| Backup-restore test (Supabase Point-in-Time) | Halfjaarlijks | Gillian |
| Permission-audit user_roles tabel | Kwartaal | Gillian |
| `_headers` CSP tightening review | Kwartaal | Gillian |
| Pen-test (extern, OWASP Top 10) | Jaarlijks (>50 partners moment) | Externe partij |

---

## 9. Tooling-overzicht

| Tool | URL | Toegang |
|---|---|---|
| Cloudflare Dashboard | https://dash.cloudflare.com | Gillian |
| Supabase Dashboard | https://supabase.com/dashboard | Gillian |
| Resend Dashboard | https://resend.com/login | Gillian |
| Sentry | (URL na setup) | Gillian + Extanore |
| Plausible | https://plausible.io/sites | Gillian |
| Twilio Console (Slot F) | https://console.twilio.com | Gillian |
| GitHub repo | https://github.com/Extanore/Flancco-tools | Gillian + Extanore |

---

## 10. Open follow-ups

- [ ] Datalek-melding-template opstellen (`docs/templates/datalek-melding-klant.md`)
- [ ] Datalek-register-template opstellen (`docs/templates/datalek-register.md`)
- [ ] Incident-log-template opstellen (`docs/templates/incident-log.md`)
- [ ] Backup-restore test inplannen (eerste keer + recurring 6-maandelijks)
- [ ] DPO-rol formaliseren (Data Protection Officer — niet wettelijk verplicht <250 medewerkers, wel best-practice voor datakritische B2B)
