# Email deliverability — Flancco Platform

**Doel:** alle outbound mails (`noreply@flancco-platform.be`, branded partner-mails, klant-notificaties) belanden in de inbox, niet in spam. Score-floor: **≥9/10 op [mail-tester.com](https://www.mail-tester.com)** vóór elke nieuwe email-template live gaat.

> **Status DNS-records (per 25-04-2026):** SPF + DKIM + DMARC moeten geverifieerd worden. Onderstaande tabel = soll-zustand. Loop alle records na in de Cloudflare DNS-zone of `dig`/`nslookup` vóór go-live.

---

## 1. DNS-records — `flancco-platform.be`

Alle records ingesteld in de Cloudflare DNS-zone (proxy = **uit** voor mail-records — het zijn TXT/CNAME, geen HTTP-traffic).

### 1.1 SPF — wie mag mailen namens dit domein

| Type | Naam | Waarde | TTL |
|---|---|---|---|
| TXT | `@` (apex) | `v=spf1 include:_spf.resend.com include:_spf.google.com ~all` | Auto |

Toelichting:
- `include:_spf.resend.com` — Resend (transactional mail uit edge functions)
- `include:_spf.google.com` — alleen indien Gillian via Google Workspace mailt vanaf `@flancco-platform.be`. Anders verwijderen.
- `~all` — softfail (begin voorzichtig). Switch naar `-all` (hardfail) zodra deliverability stabiel is gemeten over 30 dagen.

### 1.2 DKIM — cryptografische ondertekening per provider

Resend genereert per domain twee DKIM-keys (rotatable). Voeg toe als CNAME (geen TXT, Resend host de keys):

| Type | Naam | Waarde | TTL |
|---|---|---|---|
| CNAME | `resend._domainkey` | `resend._domainkey.flancco-platform.be.dkim.resend.com` | Auto |
| CNAME | `resend2._domainkey` | `resend2._domainkey.flancco-platform.be.dkim.resend.com` | Auto |

Verifieer via Resend dashboard → Domains → flancco-platform.be → "Verified" badge groen.

### 1.3 DMARC — beleid bij SPF/DKIM-falen

| Type | Naam | Waarde | TTL |
|---|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@flancco-platform.be; ruf=mailto:dmarc@flancco-platform.be; pct=100; adkim=s; aspf=s; sp=quarantine` | Auto |

Toelichting:
- `p=quarantine` — verdachte mails naar spam (begin hier; switch naar `p=reject` na 60 dagen schone DMARC-rapporten)
- `rua` + `ruf` — aggregate + forensic rapporten naar `dmarc@flancco-platform.be`. **Maak dit mailbox aan** of route door naar `gillian.geernaert@flancco.be`.
- `pct=100` — beleid op alle berichten, niet steekproef
- `adkim=s` + `aspf=s` — strict alignment (subdomain matchen exact)
- `sp=quarantine` — zelfde beleid voor subdomains

### 1.4 BIMI (optioneel, brand impressie)

Zodra DMARC op `p=quarantine` of strenger staat ≥30 dagen:

| Type | Naam | Waarde | TTL |
|---|---|---|---|
| TXT | `default._bimi` | `v=BIMI1; l=https://flancco-platform.be/brand/logo.svg; a=https://flancco-platform.be/brand/vmc.pem` | Auto |

Vereist:
- Vierkant SVG-logo (Tiny SVG 1.2, geen scripts) op `/brand/logo.svg`
- Verified Mark Certificate (VMC) — €1500–2000/jaar via Entrust of DigiCert. **Pas activeren als marketing-budget toelaat.**

---

## 2. Per-partner branded mail-setup

Wanneer een partner (bv. Novectra, CW Solar) eigen branded transactional mails wil sturen vanaf `noreply@<partner-domain>`:

### 2.1 Onboarding-checklist per partner

1. Partner registreert eigen domain in Resend (eigen account of sub-account onder Flancco)
2. Partner publiceert SPF + DKIM + DMARC volgens [§1](#1-dns-records--flancco-platformbe), aangepast aan eigen domain
3. Partner-record in `partners` tabel krijgt extra kolommen (toekomstige migratie):
   - `mail_from_address` (default: `noreply@<partner-slug>.flancco-platform.be` als fallback)
   - `mail_reply_to` (default: partner contact_email)
   - `resend_api_key_secret_ref` — verwijzing naar Supabase Vault entry, **nooit plain-text in DB**
4. Edge function `send-confirmation` (en latere notif-functions) lezen partner-context en schakelen API-key + sender per partner
5. Run mail-tester.com test → ≥9/10 vereist vóór go-live met die partner

### 2.2 Fallback — geen branded setup

Partner zonder eigen domain → mail gaat uit vanaf `noreply@flancco-platform.be` met `Reply-To: <partner contact_email>`. Acceptabel, maar verlaagt klant-perceptie van "directe partner-communicatie".

---

## 3. Test-procedure per nieuwe template

**Verplicht voor élke nieuwe email-template** (transactional én marketing):

1. **mail-tester.com** — stuur testversie naar het wegwerp-adres dat mail-tester.com toont. Score moet ≥9/10. Veelvoorkomende issues:
   - Missende `List-Unsubscribe` header (toevoegen voor marketing)
   - `text/html` zonder `text/plain` fallback (Resend doet dit automatisch indien `text` veld meegestuurd)
   - Logo of afbeelding buiten domain (host op `flancco-platform.be`, niet hotlinken)
2. **Litmus / Email-on-Acid** (optioneel) — render-check over 30+ clients (Outlook 2016, Gmail iOS, etc.). Free trials beschikbaar.
3. **GlockApps** (optioneel) — inbox-placement test over Gmail/Outlook/Yahoo/iCloud spam-filters.
4. **Eigen smoke-test** — verstuur naar `gillian.geernaert@flancco.be` + 1 Gmail + 1 Outlook + 1 iCloud (privé-adres). Verifieer:
   - Inbox-plaatsing (geen spam, geen Promotions-tab voor transactionals)
   - From-naam correct ("Flancco" of partner-naam, niet `noreply`)
   - Subject-line render OK (geen `???` of UTF-8 mojibake)
   - Links werken + UTM-params correct (indien marketing)
   - Mobiele rendering (iPhone Mail + Gmail Android)

---

## 4. Monitoring — deliverability over tijd

| Tool | Wat | Frequentie |
|---|---|---|
| **Resend Dashboard → Domains → DKIM/SPF/DMARC** | Auth-status per record | Wekelijks scannen |
| **DMARC-aggregate (rua)** | Wie probeert namens ons te mailen | Wekelijks parsen — gebruik [Postmark DMARC Digest](https://dmarc.postmarkapp.com/) (gratis, NL/EN), levert weekly digest |
| **Resend Dashboard → Activity** | Bounce-rate, complaint-rate per template | Per release; alert bij bounce >2% of complaint >0.1% |
| **Google Postmaster Tools** | Reputatie bij Gmail (IP + domain) | Maandelijks; vereist DNS-verificatie van het domain |
| **mail-tester.com** | Spam-score per template | Per nieuwe of gewijzigde template |

---

## 5. Cost monitoring — externe APIs

> Verbonden aan Slot R: voorkomen dat de platform-kosten ontsporen + alerts vóór quota-blokkade.

### 5.1 Supabase

- **Budget alert:** dashboard → Project Settings → Billing → Budget. Drempel: **$50/maand**, mail-alert naar `gillian.geernaert@flancco.be`.
- **Database egress:** monitor weekly. Spike bij grote contracten-export = trigger om SQL-views te optimaliseren.
- **Storage egress:** signed-URL TTL = 7 dagen (niet 30) om herhaaldelijke fetches te beperken.
- **Edge function invocations:** gratis tier = 500K/maand. Bij stijging boven 200K/maand → review caching-pattern.

### 5.2 Resend (email)

- **Pricing:** gratis tier = 3K mails/maand + 100/dag. Pro = $20/maand voor 50K.
- **Weekly digest:** Resend stuurt automatisch wekelijkse usage-samenvatting. Configureer in `gillian.geernaert@flancco.be`.
- **Hard cap-alert:** Resend dashboard → Settings → Billing → Spending limit op **$30/maand** (default Pro = $20).

### 5.3 Twilio (SMS — Slot F live moment)

- **Cost-cap per maand:** Twilio Console → Account → Settings → General → Spending Limit op **€25/maand** (≈ 250 BE-SMS aan €0.10/stuk).
- **Alert bij 80%:** `gillian.geernaert@flancco.be` + `info@extanore.be`.
- **Per-bericht logging:** insert in `audit_log` (Slot H) zodra die live is, voorlopig in `console.log` van edge function.

### 5.4 WhatsApp Business API (Slot F live moment)

- **Pricing per land:** template messages = €0.07–0.15/stuk in BE. Service-conversaties (binnen 24u na klant-reply) = gratis.
- **Cost-cap:** zelfde principe als Twilio — **€25/maand** met 80%-alert.

### 5.5 Google Maps (Slot E — gedefereerd)

- **Daily quota cap:** Google Cloud Console → Quotas & System Limits → Maps JavaScript API + Distance Matrix API → **€5/dag harde limiet**.
- **Reden:** als Slot E ooit wordt geactiveerd, mag een script-bug nooit > €150/maand draaien.

---

## 6. Rate limiting — preventie misbruik + cost-overrun

### 6.1 Edge functions die externe APIs callen

| Endpoint | Limiet | Mechanisme |
|---|---|---|
| `send-confirmation` | 30/min per IP | In-memory teller in edge function (reset op cold start = OK voor dit volume) |
| `send-contract-link` | 10/min per IP | Idem |
| `generate-pdf` (Slot P) | 30/min per IP | Idem |
| `validate-vat` (Slot O1) | 60/min per IP | VIES eigen quota = ~30/sec, dus ruim |
| `send-notification-*` (Slot F) | 50/min per IP | Idem |

Bij volume-stijging migreren naar **Cloudflare Workers KV** voor cross-region rate limiting (gratis tier dekt nodig volume).

### 6.2 Calculator submit (anti-spam)

- **Max 5 contracten per IP per uur** — implementeer in `calculator/index.html` submit-handler via edge function `rate-limit-check` (toekomst, momenteel ontbreekt; track als opvolg-item).
- Bij overschrijding: tonen "Limiet bereikt — neem contact op via gillian.geernaert@flancco.be".

### 6.3 Captcha-trigger

- **Drempel:** > 50 calculator-submits/dag waarvan > 30% niet leidt tot signature-completion = mogelijk spam-bot-activiteit.
- **Tooling:** Cloudflare Turnstile (gratis, privacy-vriendelijk, geen GDPR-cookie). Voeg toe aan calculator stap 1 als drempel triggert.
- **Implementatie:** opvolg-slot (geen scope nu).

### 6.4 Login-pogingen (admin/partner)

- Supabase Auth ingebouwde brute-force-detectie staat **aan** (verifiëren in dashboard).
- Lockout-policy: 5 mislukte pogingen → 15 min cooldown (Supabase default).
- Audit-log entry bij elke mislukte login (Slot H).

---

## 7. Verificatie-checklist (eenmalig + na elke DNS-mutatie)

```bash
# SPF
dig TXT flancco-platform.be +short | grep spf

# DKIM
dig CNAME resend._domainkey.flancco-platform.be +short
dig CNAME resend2._domainkey.flancco-platform.be +short

# DMARC
dig TXT _dmarc.flancco-platform.be +short
```

Of via online tools:
- [MXToolbox](https://mxtoolbox.com/) — `SuperTool` → SPF/DKIM/DMARC check
- [DMARC Analyzer](https://www.dmarcanalyzer.com/) — parse aggregate reports

---

## 8. Open follow-ups

- [ ] DNS-records (§1) verifiëren in Cloudflare DNS-zone — eigenaarscontact bij Combell of waar de zone staat
- [ ] `dmarc@flancco-platform.be` mailbox aanmaken (of route naar `gillian.geernaert@flancco.be`)
- [ ] Resend domain `flancco-platform.be` "Verified" status checken
- [ ] mail-tester.com smoke-test op huidige `send-confirmation` template
- [ ] Supabase budget-alert configureren ($50/maand)
- [ ] Resend spending-limit configureren ($30/maand)
- [ ] Per-partner mail-onboarding doc opnemen in `docs/onboarding/<partner>.md` zodra eerste partner branded mails wil
