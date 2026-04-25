# Slot R — Email deliverability + cost monitoring + security runbook

**Status:** Documentatie-slot — geen code, alleen DNS + dashboard-config + procedures.

## Intent

Voorkomen dat:
1. Outbound mails in spam belanden (deliverability)
2. Externe-API kosten ontsporen (cost monitoring)
3. Misbruik / DDoS / spam-bots de calculator-flow lamleggen (rate limiting)
4. Security-incidenten paniek triggeren in plaats van gestructureerde response (runbook)

Dit slot is **prerequisite** voor:
- **Slot F** — multi-kanaal klant-notificaties (mail/SMS/WhatsApp); zonder deliverability-floor crashen klant-comms
- **Slot Q** — GDPR consent management; runbook beschrijft datalek-procedure
- **Cluster 5** — partner-portal branded mails; per-partner DNS-setup hier gedocumenteerd

## Files touched

| File | Aard | Lines |
|---|---|---|
| `docs/deliverability.md` | Nieuw | ~210 |
| `docs/security-runbook.md` | Nieuw | ~190 |
| `docs/slots/slot-R-deliverability.md` | Nieuw (deze) | ~50 |

**Geen code-changes. Geen DB-changes. Geen CSP-impact.**

## DNS / external setup steps

Zie [`docs/deliverability.md` §1](../deliverability.md) voor SPF / DKIM / DMARC records die in de Cloudflare DNS-zone moeten landen.

Zie [`docs/security-runbook.md` §0](../security-runbook.md) voor contact-flow en tooling-toegang.

## Cost monitoring — wat ingesteld moet worden vóór go-live

| Service | Drempel | Locatie |
|---|---|---|
| Supabase | $50/maand budget-alert | Dashboard → Project Settings → Billing |
| Resend | $30/maand spending-limit | Dashboard → Settings → Billing |
| Twilio (Slot F live) | €25/maand spending-limit + 80%-alert | Console → Account → Settings → General |
| Google Maps (Slot E live) | €5/dag harde quota-cap | Cloud Console → Quotas |

## Deploy steps

Geen deploy. Per actiepunt in `docs/deliverability.md §8` en `docs/security-runbook.md §10` — checklist afwerken:

1. DNS-records publiceren of verifiëren
2. mailbox `dmarc@flancco-platform.be` aanmaken (of doorroute)
3. Resend domain "Verified" status checken
4. mail-tester.com smoke-test op bestaande templates
5. Supabase + Resend budget/spending-alerts configureren
6. Datalek-templates voorbereiden (3 stuks — zie security-runbook §10)

## Rollback

N/A — alleen documentatie.

## Verificatie-checklist

- [ ] `dig TXT flancco-platform.be +short | grep spf` → toont de SPF-record
- [ ] `dig TXT _dmarc.flancco-platform.be +short` → toont DMARC met `p=quarantine`
- [ ] Resend dashboard: domain verified, beide DKIM keys actief
- [ ] mail-tester.com test op `send-confirmation` template: ≥9/10
- [ ] Supabase budget-alert geconfigureerd op $50/maand
- [ ] Resend spending-limit op $30/maand
- [ ] Security-runbook contactpersonen gevalideerd (Gillian + Extanore bereikbaar)

## Known gaps / future work

- BIMI logo-card-in-Gmail vereist VMC-certificaat (€1500–2000/jaar) — wachten tot marketing-budget
- Cloudflare Turnstile captcha integratie in calculator (anti-bot) — opvolg-slot na 4 weken Plausible-data toont spam-volume
- Per-partner branded SMTP-credential storage in `partners` tabel + Supabase Vault — opvolg-slot bij eerste partner met eigen mail-domain
- Pen-test (extern) — gepland bij >50 partners moment
