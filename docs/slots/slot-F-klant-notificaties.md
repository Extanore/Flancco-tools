# Slot F — Multi-kanaal klant-notificaties

**Status:** Klant-facing reminders en rapport-leveringen via e-mail (Resend), SMS (Twilio) en WhatsApp (Meta Cloud API). Volledig geïntegreerd met Slot Q (consent) en Slot R (deliverability). Dispatch via pg_cron 07:15 UTC dagelijks.

## Intent

Een klant moet weten wanneer Flancco of de partner langs komt — vóór de afspraak (24 u op voorhand én op de dag zelf) en zodra het rapport beschikbaar is. Het kanaalbeleid is consent-driven: enkel kanalen waarvoor de klant in Slot Q een actieve opt-in heeft, krijgen daadwerkelijk verkeer. SMS en WhatsApp zijn ePrivacy-pligtig; e-mail valt onder art. 6.1.b WER (uitvoering contract).

Idempotency, kostenplafonds en feature-flags zijn van bij dag één ingebouwd: één run mag nooit dubbel sturen, één provider-misconfiguratie mag nooit de andere kanalen blokkeren, één buggy klantenrij mag nooit de hele batch laten falen.

## Architectuur

| Laag | Component | File |
|---|---|---|
| **DB** | Idempotency-kolommen op `onderhoudsbeurten` (7 timestamps) | `supabase/migrations/20260425170000_slot_f_klant_notifications.sql` |
| **DB** | Tabel `klant_notification_log` (append-only audit) + RLS | idem |
| **DB** | Functie `dispatch_klant_notifications_via_http()` (SECURITY DEFINER) | idem |
| **DB** | pg_cron job `slot_f_klant_dispatch_daily` (07:15 UTC) | idem |
| **Edge** | `send-klant-notification-email` (Resend) | `supabase/functions/send-klant-notification-email/index.ts` |
| **Edge** | `send-klant-notification-sms` (Twilio) | `supabase/functions/send-klant-notification-sms/index.ts` |
| **Edge** | `send-klant-notification-whatsapp` (Meta Cloud API) | `supabase/functions/send-klant-notification-whatsapp/index.ts` |
| **Edge** | `dispatch-klant-notifications` (orchestrator) | `supabase/functions/dispatch-klant-notifications/index.ts` |
| **i18n** | NL + FR `notification.*` namespace (46 leaf-keys per taal) | `calculator/i18n/nl.json.js` + `fr.json.js` |
| **Templates** | WhatsApp templates `klant_${event}_${lang}` | te registreren in Meta Business Manager |

## Event-types

| Event | Trigger | Kanalen | Idempotency-kolom |
|---|---|---|---|
| `reminder_24h` | Dag-batch: `plan_datum = morgen` & status in (`ingepland`,`toekomstig`) | email, sms, whatsapp | `reminder_24h_email_ts`, `_sms_ts`, `_whatsapp_ts` |
| `reminder_day` | Dag-batch: `plan_datum = vandaag` & status = `ingepland` | email, sms, whatsapp | `reminder_day_email_ts`, `_sms_ts`, `_whatsapp_ts` |
| `rapport_klaar` | Manueel of post-rapport-publish (toekomstige hook) | email enkel | `rapport_klaar_email_ts` |
| `test` | Admin-trigger voor smoke-tests | email, sms, whatsapp | nooit ts gezet |

`rapport_klaar` valt **bewust** weg via SMS (te lange URL, te beperkte ruimte) en is per default disabled via WhatsApp templates (admin kan force=true forceren).

## Auth-model per edge function

| Function | Service-role | User-JWT (admin) | User-JWT (partner-owner) | Anoniem |
|---|---|---|---|---|
| `send-klant-notification-email` | OK (constant-time exact match) | OK | OK enkel als `manage_users=true` | 401 |
| `send-klant-notification-sms` | OK | OK | OK enkel als `manage_users=true` | 401 |
| `send-klant-notification-whatsapp` | OK | OK | OK enkel als `manage_users=true` | 401 |
| `dispatch-klant-notifications` | OK enkel | 401 | 401 | 401 |

Het `freeform=true`-pad in WhatsApp werkt **uitsluitend** via user-JWT (admin override) — service-role kan geen freeform sturen, om accidentele 24h-window-violations door cron te voorkomen.

## Idempotency-mechanisme

Per beurt × kanaal × event geldt: vóór elke send wordt de kolom `${event_type}_${kanaal}_ts` gelezen. Niet-NULL ⇒ skip met status `skipped_already_sent`. Na een succesvolle send wordt diezelfde kolom geüpdatet met `now()`. Race-veilig omdat:
- pg_cron triggert maar 1× per dag
- de orchestrator dispatcht beurten serieel binnen één run (`for` loop, niet `Promise.all`)
- per beurt worden de drie kanalen wel parallel afgevuurd (`Promise.allSettled`) maar elke kanaal-functie schrijft enkel zijn eigen kolom
- bij een retry binnen dezelfde dag (admin handmatig) faalt de tweede send dus stil met `skipped_already_sent` — tenzij `force=true` wordt meegegeven

`force=true` overschrijft de idempotency-check, NIET de consent-check of daily-cap.

## Consent-flow (Slot Q-integratie)

Vóór elke send queryt de functie `v_klant_consent_actief` met `klant_email = contract.klant_email` en `kanaal` overeenkomend met het transportkanaal (`email_service` voor email, `sms` voor sms, `whatsapp` voor whatsapp). Resultaten:

- Geen rij ⇒ `skipped_no_consent` (default-deny)
- Rij met `bereikbaar = false` (opt-out actief) ⇒ `skipped_no_consent`
- Rij met `bereikbaar = true` ⇒ doorgaan
- `event_type = 'test'` ⇒ consent-check overgeslagen (admin tool)

`email_service` is default-on bij contract-creatie omdat de calculator automatisch een rij inserts met `opt_in=true`. SMS en WhatsApp vereisen expliciete checkbox-opt-in. Geen consent-rij voor SMS/WhatsApp = nooit een SMS of WhatsApp.

## Daily-caps (kostenplafonds)

| Kanaal | Env var | Default | Telmechanisme |
|---|---|---|---|
| Email | géén | onbeperkt | Resend rate limit (3000/dag op standard plan) is de natuurlijke ceiling |
| SMS | `TWILIO_DAILY_CAP` | 100 | `count(klant_notification_log)` met `kanaal='sms' status='sent' created_at >= today_utc_start` |
| WhatsApp | `WHATSAPP_DAILY_CAP` | 100 | idem voor `kanaal='whatsapp'` |

Bij overschrijding ⇒ HTTP 429 + log met `status='skipped_daily_cap'`. Admin moet de cap manueel verhogen of wachten tot middernacht UTC.

## Feature-flags voor staged rollout

`dispatch-klant-notifications` honoreert drie env-vars:
- `DISPATCH_ENABLE_EMAIL` (default `true`)
- `DISPATCH_ENABLE_SMS` (default `true`)
- `DISPATCH_ENABLE_WHATSAPP` (default `true`)

Aanbevolen rollout-strategie:
1. **Week 1:** zet SMS en WhatsApp env op `false`. Enkel email actief. Monitor `klant_notification_log` op deliverability + spam-rapporten.
2. **Week 2:** Twilio configureren, `DISPATCH_ENABLE_SMS=true`. Daily cap eerst op 25 zetten, observeer kosten.
3. **Week 3:** Meta WhatsApp templates laten goedkeuren (kan 1-3 dagen duren). `DISPATCH_ENABLE_WHATSAPP=true` zodra templates ACCEPTED.

Een feature-flag op `false` betekent: dat kanaal wordt door de dispatcher **niet eens aangeroepen**. Manuele admin-trigger via UI blijft wel werken (functie weigert pas als provider-secrets ontbreken ⇒ 503).

## pg_cron + pg_net flow

```
07:15 UTC ─→ pg_cron triggert SELECT dispatch_klant_notifications_via_http()
              │
              ├─ Vault.decrypted_secrets ──→ slot_f_supabase_url
              │                              slot_f_service_role_key
              │
              └─ pg_net.http_post ──→ POST /functions/v1/dispatch-klant-notifications
                                         Authorization: Bearer <service_role_key>
                                         Body: {"trigger":"pg_cron"}
                                         │
                                         ↓
                              dispatch-klant-notifications (orchestrator)
                                         │
                                         ├─ SELECT onderhoudsbeurten WHERE plan_datum=tomorrow ─→ reminder_24h batch
                                         └─ SELECT onderhoudsbeurten WHERE plan_datum=today    ─→ reminder_day batch
                                                  │
                                                  └─ for each beurt ─→ Promise.allSettled([
                                                           fetch send-klant-notification-email,
                                                           fetch send-klant-notification-sms,
                                                           fetch send-klant-notification-whatsapp
                                                      ])
```

De SECURITY DEFINER-functie is REVOKE ALL FROM PUBLIC + GRANT EXECUTE TO postgres only — geen anon/authenticated/service_role kan ze rechtstreeks aanroepen, enkel pg_cron (die als postgres draait).

## Vault-secrets vereist

Na deploy van de migratie moet de admin twee secrets in Supabase Vault aanmaken:

```sql
-- Eenmalig vanuit SQL editor:
SELECT vault.create_secret('https://dhuqpxwwavqyxaelxuzl.supabase.co', 'slot_f_supabase_url');
SELECT vault.create_secret('<SERVICE_ROLE_KEY>', 'slot_f_service_role_key');
```

Updaten van de service-role key vereist `vault.update_secret()` of een drop-create cycle. **Nooit** in code of git committen.

## Edge function secrets

Alle vier de edge functions verwachten Supabase-runtime secrets via Project Settings → Functions → Secrets:

| Secret | Functie | Verplicht | Default |
|---|---|---|---|
| `RESEND_API_KEY` | email | ja | — |
| `EMAIL_FROM_ADDRESS` | email | ja | — |
| `EMAIL_REPLY_TO` | email | nee | gelijk aan FROM |
| `TWILIO_ACCOUNT_SID` | sms | ja | — |
| `TWILIO_AUTH_TOKEN` | sms | ja | — |
| `TWILIO_FROM_NUMBER` | sms | ja | — |
| `TWILIO_DAILY_CAP` | sms | nee | `100` |
| `WHATSAPP_PHONE_ID` | whatsapp | ja | — |
| `WHATSAPP_ACCESS_TOKEN` | whatsapp | ja | — |
| `WHATSAPP_API_VERSION` | whatsapp | nee | `v18.0` |
| `WHATSAPP_DAILY_CAP` | whatsapp | nee | `100` |
| `APP_BASE_URL` | email + sms | nee | `https://flancco-platform.be/` |
| `ALLOWED_ORIGINS` | alle | nee | `app.flancco-platform.be,flancco-platform.be,www.flancco-platform.be` |
| `DISPATCH_ENABLE_EMAIL` | dispatcher | nee | `true` |
| `DISPATCH_ENABLE_SMS` | dispatcher | nee | `true` |
| `DISPATCH_ENABLE_WHATSAPP` | dispatcher | nee | `true` |
| `DISPATCH_MAX_BATCH` | dispatcher | nee | `500` |

Bij ontbrekende provider-secrets:
- email zonder `RESEND_API_KEY` ⇒ 500 `server_misconfigured`
- sms zonder Twilio-trio ⇒ 503 `twilio_not_configured` + audit-log + **géén** beurt-ts update (zodat volgende run automatisch retried)
- whatsapp zonder `WHATSAPP_PHONE_ID` of `WHATSAPP_ACCESS_TOKEN` ⇒ 503 `whatsapp_not_configured` + idem retry-pattern

## Phone normalization (E.164)

`send-klant-notification-sms` en `-whatsapp` normaliseren ruwe telefoonnummers via een eenvoudige sequence:

1. Strip whitespace, dots, dashes, parens, slashes
2. `00xx…` ⇒ `+xx…`
3. Belgische shortform `04xxxxxxxx` ⇒ `+324xxxxxxxx`
4. Bare 8–14-digit ⇒ `+32` prefixen (assume BE)
5. Validate tegen `^\+[1-9]\d{6,14}$`

Falen ⇒ `skipped_missing_contact` met detail `phone_invalid_format`. WhatsApp Cloud API vereist géén leading `+` — dat wordt eraf gestript vlak voor de outbound call.

## CORS

Geen wildcards. `ALLOWED_ORIGINS` env-var bepaalt de toegelaten origins, default `https://app.flancco-platform.be`, `https://flancco-platform.be`, `https://www.flancco-platform.be`. `Vary: Origin` header altijd gezet.

`dispatch-klant-notifications` heeft een minimal CORS-header (allow `*` op OPTIONS) — die functie wordt enkel intern aangeroepen, dus dit is irrelevant voor browser-security; het is enkel om OPTIONS-preflights niet te doen mislukken bij eventuele admin-debugging.

## Logging

Alle functies loggen via `logJson({ fn, ts, event, ...meta })`:
- Geen telefoonnummers in plaintext (we maskeren `+324XXXXXX42` ⇒ `+324****42`)
- Geen e-mailadressen in events (enkel `event_type` + `recipient_masked`)
- Geen contract-content
- Wel: `event_type`, `kanaal`, `status`, `provider_message_id` (voor crisis debugging)

Dit wordt gevoed naar Supabase Functions logs (60 dagen retention default). Voor langere audit-trail: `klant_notification_log` tabel (geen retention policy, append-only).

## klant_notification_log schema

```
klant_notification_log
├── id                    uuid PK
├── beurt_id              FK onderhoudsbeurten(id) ON DELETE SET NULL
├── contract_id           FK contracten(id) ON DELETE SET NULL
├── partner_id            FK partners(id) ON DELETE SET NULL
├── kanaal                CHECK email|sms|whatsapp
├── event_type            CHECK reminder_24h|reminder_day|rapport_klaar|test
├── recipient             text (gemaskeerd voor phone, lowercase voor email)
├── status                CHECK sent|failed|skipped_no_consent|skipped_already_sent|skipped_missing_contact|skipped_daily_cap
├── provider_message_id   text nullable (Resend message_id, Twilio SID, WhatsApp wamid)
├── error_detail          text nullable (truncated 500 chars)
└── created_at            timestamptz default now()
```

RLS:
- Admin: full SELECT
- Partner: SELECT enkel rijen waar `partner_id = (SELECT partner_id FROM user_roles WHERE user_id = auth.uid())`
- Geen UPDATE/DELETE policies (append-only)

Indexen: `(created_at DESC)`, `(beurt_id, kanaal, event_type)`, `(partner_id, created_at DESC)`.

## i18n

Namespace `notification.*` (46 leaf-keys per taal):

```
notification.reminder_24h.{emailSubject, emailHeader, emailIntroNamed, emailIntroAnon,
                            emailDateLabel, emailTimeLabel, emailTimeFullDay, emailNote,
                            emailContactCta, smsBody, whatsappTemplateName}
notification.reminder_day.{emailSubject, emailHeader, emailIntroNamed, emailIntroAnon,
                            emailTimeLabel, emailTechnicianLabel, emailContactCta,
                            smsBody, whatsappTemplateName}
notification.rapport_klaar.{emailSubject, emailHeader, emailIntroNamed, emailIntroAnon,
                             emailCtaButton, emailExpiryNote, emailFollowupHint}
notification.common.{partnerSignature, optOutFooter, optOutLink, privacyLink, contactSupport}
notification.adminTrigger.{sectionTitle, btnReminder24h, btnReminderDay, btnRapportKlaar,
                            toastSent, toastSkipped, toastFailed, confirmForce}
notification.reasons.{no_consent, already_sent, missing_contact, daily_cap,
                      not_configured, send_failed}
```

Parity gevalideerd: NL = FR = 486 leaf-keys totaal, geen drift.

De edge functions gebruiken vandaag **inline NL/FR copy** voor de email-templates — de i18n-keys zijn voorbereid voor toekomstige adoptie zodra een admin-UI bouwt waar deze copy bewerkbaar wordt. Dit volgt het bestaande Slot K + Slot L pattern (i18n-strings inline gespiegeld in admin pagina's, runtime later).

## Manuele admin-trigger (toekomstige UI)

De edge functions accepteren al `force=true` en accepteren JWT-auth ⇒ zodra een admin-knop "Stuur reminder nu" toegevoegd wordt aan `admin/index.html` planning-pagina, vereist dat enkel:
```js
await supa.functions.invoke('send-klant-notification-email', {
  body: { beurt_id: '...', event_type: 'reminder_24h', force: true }
});
```
De functie hanteert dan: idempotency override + consent-check + daily-cap blijven actief.

## Veiligheid (OWASP-checklist)

| Risico | Mitigatie |
|---|---|
| **A01 Broken access control** | Service-role bearer is constant-time vergeleken. User-JWT check via `admin.auth.getUser()` + role-lookup. Partner-owner enkel met `manage_users=true` permission. |
| **A02 Cryptographic failures** | Service-role key in Supabase Vault (encrypted at rest). Resend/Twilio/WhatsApp tokens als runtime secrets, nooit in code/git. |
| **A03 Injection** | Geen raw SQL — alle queries via Supabase client met parametrized binding. UUID validatie via regex vóór elke `.eq("id", ...)`. |
| **A04 Insecure design** | Auth-first ordering in elke handler. Default-deny consent. Per-functie idempotency. |
| **A05 Security misconfig** | CORS allow-list (geen wildcards op POST). 503 pad voor missing secrets ipv stille fail. |
| **A06 Vulnerable components** | Pure Deno + supabase-js@2 (geen npm-deps). |
| **A07 Auth failures** | Constant-time bearer compare voorkomt timing attacks. JWT validatie via Supabase native. |
| **A08 Data integrity** | Append-only log + idempotency via DB-kolommen + RLS policies = single source of truth. |
| **A09 Logging failures** | Structured JSON logs, no PII (gemaskeerde phone/email), permanente audit in `klant_notification_log`. |
| **A10 SSRF** | Provider URLs zijn hard-coded (Twilio, Resend, Graph API), geen user-controlled fetch targets. |

Bonus: rate-limit voor opt-out blijft van Slot Q (10/min/IP). Slot F voegt geen public endpoints toe.

## Operationele runbooks

### Daily ops
- Ochtend: kijk in Supabase Dashboard ⇒ Functions ⇒ `dispatch-klant-notifications` logs voor `slot_f_dispatch_done` event met totalen.
- Wekelijks: query `klant_notification_log` voor `status='failed'` count per kanaal, troubleshoot patronen.

### Bij incident "alle SMS falen"
1. Check Twilio account balance + status page.
2. Tijdelijk `DISPATCH_ENABLE_SMS=false` zetten in Functions ⇒ Secrets.
3. Investigate via `klant_notification_log.error_detail`.
4. Re-enable na fix; volgende cron-run pikt de `*_sms_ts IS NULL` rijen op.

### Bij incident "klant ontvangt dubbele mails"
1. Vrijwel onmogelijk door idempotency-kolommen. Maar check eerst:
   ```sql
   SELECT id, plan_datum, reminder_24h_email_ts, reminder_day_email_ts
   FROM onderhoudsbeurten
   WHERE id = '<beurt_id>';
   ```
2. Indien beide kolommen gevuld zijn op verschillende dagen ⇒ dat is correct (24h + day zijn verschillende events).
3. Indien admin handmatig met `force=true` triggerde ⇒ check audit-log voor `event_type` + `created_at`.
4. Worst-case rollback: `UPDATE onderhoudsbeurten SET reminder_24h_email_ts = NULL WHERE id = '...'` om herhaling toe te laten.

### Bij incident "klant blijft mails krijgen na opt-out"
1. Verify opt-out daadwerkelijk gelogd in `klant_consents`:
   ```sql
   SELECT * FROM v_klant_consent_actief WHERE klant_email = '<email>';
   ```
2. `bereikbaar` moet `false` zijn na opt-out. Zo niet ⇒ Slot Q bug, niet Slot F.
3. Check `klant_notification_log` of er sinds opt-out nog `status='sent'` rijen zijn ⇒ indien ja, `created_at` vergelijken met `opt_out_ts` om bug te isoleren.

## Aandachtspunten + bekende beperkingen

1. **WhatsApp templates moeten manueel goedgekeurd worden door Meta.** De edge function gaat ervan uit dat templates met namen `klant_reminder_24h_nl`, `klant_reminder_24h_fr`, `klant_reminder_day_nl`, `klant_reminder_day_fr` bestaan en GOEDGEKEURD zijn. Tot die tijd: 503 of provider-error. Zie Meta Business Manager voor templating UI.
2. **Timezone**: cron draait UTC, beurt `plan_datum` is `date`-type (geen tz). Voor BE betekent 07:15 UTC ≈ 09:15 lokale tijd in zomer / 08:15 in winter. Dat is bewust gekozen zodat klant rond ontbijt zijn 24h-reminder krijgt voor de volgende dag.
3. **Geen retry-mechanisme bij failures**: als één send-call faalt, wordt enkel een audit-log geschreven met `status='failed'`. De `*_ts` kolom blijft NULL ⇒ volgende dag-run zal opnieuw proberen. Dit is acceptabel voor reminders (1 dag late is OK), maar als 24h-reminder faalt komt er géén tweede kans (de dag erop is al de afspraak zelf).
4. **Geen webhook-handling van Twilio/Resend/Meta**: bounces, delivery-confirmations en spam-rapporten worden niet geconsumeerd. Volgende slot-iteratie kan een `notification_webhooks` edge function toevoegen om `klant_notification_log.status` van `sent` naar `delivered/bounced/failed` te updaten.
5. **`klant_notification_log` heeft geen retention policy** — kan over jaren grote tabel worden. Aanbeveling: na 12 maanden ARCHIEF naar koude opslag of partition-by-month index toevoegen.

## Volgende slot-iteraties

- **Slot F+** webhook-consumers (Resend events, Twilio status callbacks, Meta delivery receipts).
- **Admin UI knoppen** in `admin/planning.html` per beurt-rij ("Stuur reminder nu", "Stuur rapport").
- **Partner-portal sectie** "Notificatie-log van mijn klanten" (al RLS-klaar, alleen UI nog).
- **Opt-in-update flow** vanuit klant: vandaag enkel opt-out via Slot Q, nog geen weg om SMS na contract-creatie alsnog aan te zetten.
- **Multi-tenant template overrides**: vandaag staat alle email-copy in code; in admin een "Email-templates per partner" pagina laat partners hun eigen tone-of-voice instellen.

## Test-plan (smoke checklist na deploy)

```bash
# 1) Auth-block voor anon
curl -i -X POST https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/dispatch-klant-notifications
# verwacht: 401 unauthorized

# 2) Auth-block voor user-JWT (dispatcher accepteert enkel service-role)
curl -i -X POST https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/dispatch-klant-notifications \
  -H "Authorization: Bearer <USER_JWT>"
# verwacht: 401 unauthorized

# 3) Email test als admin
curl -X POST https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/send-klant-notification-email \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"test","override_email":"gillian.geernaert@flancco.be"}'
# verwacht: 200 + ok:true + provider_message_id

# 4) SMS feature-flag (zonder Twilio-secrets)
curl -X POST https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/send-klant-notification-sms \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"test","override_phone":"+32470123456"}'
# verwacht: 503 twilio_not_configured

# 5) Dispatcher dry-run (manual, with service-role)
curl -X POST https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/dispatch-klant-notifications \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"trigger":"manual"}'
# verwacht: 200 + {processed, sent_email, sent_sms, sent_whatsapp, skipped, failed}
```
