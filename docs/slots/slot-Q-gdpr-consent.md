# Slot Q — GDPR consent-management

**Status:** Foundation. Audit-trail + opt-out infrastructuur per kanaal per klant. Voorwaarde voor élke nieuwe communicatie-feature (Slot F notificaties).

## Intent

Wettelijk volledig dichttimmeren: AVG (art. 6.1.a expliciete consent + art. 7.3 recht op intrekking + art. 33 meldplicht) en ePrivacy-richtlijn (SMS/WhatsApp opt-in). Géén feature mag een klant bereiken zonder dat we per kanaal een geldige consent-rij kunnen aantonen.

## Architectuur

| Laag | Component | File |
|---|---|---|
| **DB** | Tabel `klant_consents` (4 kanalen, append-only via RLS) | `supabase/migrations/20260425100000_create_klant_consents.sql` |
| **DB** | View `v_klant_consent_actief` (laatste status per email/kanaal) | idem |
| **DB** | Triggers `tg_klant_consents_set_bijgewerkt` + `tg_klant_consents_set_token` | idem |
| **UI** | 4 checkboxes step 2 calculator (na privacy-card) | `calculator/index.html` |
| **UI** | Submit-handler insert van 4 consent-rijen | `calculator/index.html` (`submitContract()`) |
| **i18n** | NL + FR keys `consent.*` + `optOut.*` | `calculator/i18n/nl.json.js` + `fr.json.js` |
| **API** | Public edge function `handle-opt-out` (POST + GET) | `supabase/functions/handle-opt-out/index.ts` |
| **UI** | Public confirmatie-pagina `/opt-out/?token=xxx` | `opt-out/index.html` |

## Wettelijke basis per kanaal

| Kanaal | Basis | Default | Opt-out gevolgen |
|---|---|---|---|
| `email_service` | Art. 6.1.b WER (uitvoering overeenkomst) | aan | Klant ontvangt geen service-mails meer; admin moet manueel contact opnemen voor afspraken |
| `email_marketing` | Art. 6.1.a (expliciete opt-in) | uit | Geen nieuwsbrief, geen promo |
| `sms` | ePrivacy + AVG | uit | Geen SMS-reminders |
| `whatsapp` | ePrivacy + AVG + WhatsApp Business policies | uit | Geen WhatsApp-berichten |

**Cruciale detail:** `email_service` staat default-aan omdat het juridisch noodzakelijk is voor uitvoering van het contract (art. 6.1.b). Dit is géén "consent" in de strikte zin — het is *gerechtvaardigd belang*. We registreren het wel om audit-completeness te garanderen + om opt-out-mechanisme te ondersteunen (klant moet altijd uit alle communicatie kunnen).

## Datamodel

```
klant_consents
├── id                    uuid PK
├── contract_id           FK contracten(id) ON DELETE CASCADE
├── klant_email           text NOT NULL ← redundant opgeslagen, blijft werken na contract-anonymisering
├── kanaal                CHECK email_service|email_marketing|sms|whatsapp
├── opt_in                bool DEFAULT false
├── opt_in_ts             timestamptz
├── opt_in_bron           CHECK calculator|portal|admin|import
├── opt_in_ip             inet
├── opt_in_user_agent     text
├── opt_out_ts            timestamptz nullable
├── opt_out_bron          CHECK email_link|sms_keyword|portal|admin|klantverzoek
├── opt_out_ip            inet
├── opt_out_token         text UNIQUE ← per-row, 32-char URL-safe base64
├── notitie               text ← vrije tekst voor uitzonderlijke gevallen
├── aangemaakt_op         timestamptz
└── bijgewerkt_op         timestamptz ← auto-update via trigger
```

**Append-only-pattern:** geen DELETE-policy. Alleen UPDATE op opt_out_* velden (admin) of via edge function (klant). Inzet: een opt-out wist nooit de oorspronkelijke opt-in — beide staan in de rij + tijdslijn klopt voor compliance-audits.

## RLS (default-deny)

| Rol | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `anon` | nee | ja, alleen `opt_in_bron='calculator'` + email gevuld + opt_out leeg | nee | nee |
| `authenticated` (admin) | ja | ja | ja | nee (geen DELETE-policy) |
| `authenticated` (partner) | ja, alleen consents van eigen partner-contracten | nee | nee | nee |
| service_role | volledig (gebruikt door `handle-opt-out` edge function) | | | |

**Anti-enumeration:** anon heeft géén SELECT. Dit voorkomt dat een aanvaller via opvolgende lookups kan checken welke email-adressen al consent gegeven hebben.

## Token-design

- 32 chars URL-safe base64, ~190 bit entropie (anti-bruteforce ruim voldoende)
- Per-row apart (niet per-klant) → token-hijack van één mail compromitteert nooit andere kanalen
- Server-side gegenereerd via `BEFORE INSERT` trigger (`gen_random_bytes(24)`)
- Geen reset-mechanisme (token is single-purpose, opt-out is idempotent)

## Edge function `handle-opt-out`

**Endpoint:** `POST /functions/v1/handle-opt-out` (ook GET ondersteund voor preview-mode)

**Public:** `verify_jwt = false` (link in mail moet werken zonder login)

**Flow:**
1. Lees `token` uit POST body of GET query
2. Valideer formaat (regex `/^[A-Za-z0-9\-_~]{30,50}$/`)
3. Lookup consent-row op token (UNIQUE)
4. Als al opt-out → idempotent success-response (bevat masked email + kanaal-info)
5. Als GET zonder `confirm: true` → preview-response (UI toont bevestig-knop)
6. Als POST + `confirm: true` → update `opt_out_ts = now()`, `opt_out_bron = 'email_link'`, `opt_out_ip = client-ip`

**Security-hardening:**
- Rate-limit 10 req/min per IP (in-memory bucket)
- Geen enumeration-leak: ongeldige + onbekende token retourneren beide `error: invalid_token`
- Geen PII in response — alleen masked email (`b***@***.be`) + kanaal-naam
- Structured JSON-logs zonder PII (alleen `consent_id` + `kanaal` + `ts`)

**Response shapes:**
```json
// Success na mutatie
{ "success": true, "kanaal": "email_marketing", "email_masked": "j***n@***.be" }

// Idempotent (al uitgeschreven)
{ "success": true, "already_opted_out": true, "kanaal": "sms", "email_masked": "..." }

// Preview (GET of POST zonder confirm)
{ "success": true, "preview": true, "kanaal": "email_service", "email_masked": "..." }

// Foutcodes
{ "success": false, "error": "invalid_token" | "rate_limited" | "lookup_failed" | "update_failed" | "internal_error" }
```

## Opt-out URL-pattern (voor mail-templates)

```
https://flancco-platform.be/opt-out/?token={{opt_out_token}}
```

Statische page op Cloudflare Workers Assets — geen DB-call vóór render, gebruikt Slot S i18n voor NL/FR. JS roept edge function aan met `confirm: true` en toont resultaat.

## Files touched

| File | Aard | Lines |
|---|---|---|
| `supabase/migrations/20260425100000_create_klant_consents.sql` | Nieuw | 188 |
| `supabase/functions/handle-opt-out/index.ts` | Nieuw | 198 |
| `opt-out/index.html` | Nieuw | 178 |
| `calculator/index.html` | Edit (consent-card + submit-handler) | +75 |
| `calculator/i18n/nl.json.js` | Edit (consent + optOut keys) | +28 |
| `calculator/i18n/fr.json.js` | Edit (consent + optOut keys) | +28 |
| `docs/slots/slot-Q-gdpr-consent.md` | Nieuw (deze) | ~110 |

## Deploy-stappen

1. **Migratie toepassen:** `supabase db push` (via MCP `apply_migration`)
2. **Verifieer:** `mcp__supabase__get_advisors type=security` → 0 issues op nieuwe tabel
3. **Edge function deployen:** `supabase functions deploy handle-opt-out --no-verify-jwt`
4. **Set env vars** (Supabase dashboard):
   - `OPT_OUT_RATE_LIMIT` (optioneel, default 10)
   - `ALLOWED_ORIGINS` (optioneel, fallback hardcoded)
5. **Test edge function:**
   ```bash
   curl -X POST https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/handle-opt-out \
     -H 'Content-Type: application/json' \
     -d '{"token":"test_invalid"}'
   # Expected: { "success": false, "error": "invalid_token" }
   ```
6. **Smoke-test calculator:** insert test-contract → controleer 4 rijen in `klant_consents`
7. **Smoke-test opt-out flow:** kopieer token uit DB → open `/opt-out/?token=...` → verifieer success-state + DB-row gemuteerd

## Testing-checklist

| Test | Verwachte uitkomst |
|---|---|
| Calculator submit met alle vakjes aan | 4 rijen in `klant_consents` met `opt_in=true` |
| Calculator submit met enkel email_service | 4 rijen, 1 met `opt_in=true`, 3 met `opt_in=false` |
| Anon SELECT op `klant_consents` | RLS-deny (geen rows) |
| Edge function POST met invalid token | `400 invalid_token` |
| Edge function POST met geldig token, confirm=false | `200 preview: true` |
| Edge function POST met geldig token, confirm=true | `200 success: true`, DB row updated |
| Edge function POST met al-uitgeschreven token | `200 already_opted_out: true`, geen tweede mutatie |
| Edge function 11 requests/min vanaf zelfde IP | 11e request `429 rate_limited` |
| `/opt-out/?token=xxx` met geldig token | UI toont success-state + masked email |
| `/opt-out/?token=invalid` | UI toont fail-state + contact-hint |
| FR-browser → opt-out page | Strings in FR via Slot S |

## Bekende gaps + follow-ups

- **Audit-log koppeling (Slot H):** consent-mutaties moeten ook in `audit_log` schrijven zodra die tabel live is. Voorlopig staat de trail volledig in `klant_consents` zelf (append-only via RLS).
- **Admin-UI voor consent-beheer:** bediende moet handmatig opt-out kunnen registreren (telefonisch verzoek). Komt in Slot C admin-uitbreiding of separate mini-feature.
- **Marketing-mail consent UI buiten calculator:** klanten moeten via portal hun voorkeur kunnen aanpassen. Wacht op Slot C portal-pipeline.
- **Email-template opt-out-footer:** elke `send-*` edge function moet de footer-link met `{{opt_out_token}}` injecteren. Wordt geadresseerd in Slot F notificaties.
- **`reCAPTCHA / Turnstile` op opt-out endpoint:** bij vermoede misbruik. Niet nodig op moment van go-live (rate-limit dekt redelijke aanval-vectoren).
- **GDPR right-to-be-forgotten:** edge function `gdpr-delete-klant` (toekomst) moet `klant_consents.klant_email` anonymiseren maar `opt_out_token`-trail behouden.

## Rollback

1. `supabase functions delete handle-opt-out`
2. Verwijder consent-card block + submit-handler uit `calculator/index.html`
3. Verwijder `opt-out/` directory
4. Migratie-rollback: zie `-- ROLLBACK` sectie onderaan migratie-file (handmatig DROP VIEW + TABLE + FUNCTIONS)

## Open follow-ups

- [ ] Apply migration naar Supabase production
- [ ] Deploy `handle-opt-out` met `verify_jwt = false` flag in `supabase/config.toml`
- [ ] Slot H audit-log koppeling zodra die live is
- [ ] Mail-template-helper die opt-out-link genereert (voorbereiding Slot F)
- [ ] Admin-UI: lijst alle consents per klant + handmatige opt-out (in `admin/index.html`)
