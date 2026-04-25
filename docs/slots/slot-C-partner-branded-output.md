# Slot C — Partner-branded klant-output

Twee deliverables die naar de eindklant gaan dragen voortaan altijd de
partner-stijl (logo, kleuren, naam, contact), nooit een generieke
Flancco-uitstraling. Dat bouwt op de PDF-engine uit Slot P en de
i18n-baseline uit Slot S.

| Deliverable | Edge Function | Template |
|---|---|---|
| **C3** — Branded onderhoudsrapport (klant-PDF post-beurt) | `generate-pdf` | `templates/rapport_branded.ts` |
| **C4** — Branded bevestigingsmail (post-signing) | `send-confirmation` | inline HTML in `index.ts` |

## C3 — Onderhoudsrapport

### Intent

Na elke onderhoudsbeurt ontvangt de klant een PDF die volledig in de
partner-stijl is opgemaakt. Inhoud beperkt zich tot wat de klant moet zien:

- Klant- + beurtgegevens in twee side-by-side cards
- Bevindingen (string of array van bullets)
- Aanbevelingen (string of array van bullets)
- Optioneel: foto's (max 6, 3-koloms grid, cover-fit)
- Klant-handtekening voor ontvangst

Per project-memory worden uren / verbruikt materiaal NIET op het rapport
getoond — die blijven intern (alleen via expliciete `materiaal`-veld
optioneel zichtbaar; niet vanuit calculator-flow).

### Architectuur

`renderRapportBranded(data, branding, lang) => Uint8Array`

- A4 portrait, partner-kleur header-band (kleur_primair) met logo links
  + titel rechts. Sub-titel toont `klant_naam`.
- Two info-cards met primary-color top-stripe accent.
- Section-headings: uppercase tekst in primary-color + thin underline.
- Bullets: array-input → `· item per regel` (U+00B7 middle dot, WinAnsi-safe).
- Foto-grid: pre-fetch parallel, 4s timeout, 4 MB cap per foto, cover-fit met
  hairline frame.
- Handtekening: 220×90pt frame links + naam + datum rechts.
- Pagination: `ensureSpace()` helper voegt nieuwe pagina + her-tekent header
  wanneer een sectie niet meer past.
- Footer: partner-naam · adres · contact + "Pagina X van Y".

### i18n

- NL/FR strings inline (geen runtime fetch). Sectorlabels via map
  (`zon`, `warmtepomp`, `ventilatie`, `verwarming`, `airco`).
- Datumformat via `Intl.DateTimeFormat('nl-BE'|'fr-BE')` met long-month.

### Auth

`requiresAuth: true` — admin / partner / bediende. Partner kan alleen
genereren voor eigen slug (cross-partner deny test slaagt).

### Hardening tijdens C3-bouw

- **Bullet-list fix in `_shared.ts`**: `wrapText()` splitste op `\n` *na*
  `sanitize()`, maar `sanitize()` strippte eerst alle non-WinAnsi-tekens
  inclusief `\n`. Alle bullets liepen daardoor op één regel. Fix: split op
  `\r?\n` *vóór* sanitize, sanitize per-paragraph. Geen breaking change voor
  werkplanning of bestaande templates (single-line input blijft ongewijzigd).
- **Array-input voor body-secties**: `bevindingen` / `aanbevelingen` /
  `materiaal` accepteren nu `string | string[]`. Array → bullet-list,
  string → letterlijk. `coerceBody()` helper centraliseert de coercion.

## C4 — Bevestigingsmail

### Intent

Branded HTML-mail post-signing. Per partner:

- **Andere partners** (Novectra, CW Solar, ...): partner-logo + kleur_primair
  header-band, partner contact + website in footer. From-naam:
  `"{partnerName} via Flancco"`. Reply-to: partner.email als beschikbaar,
  anders default Flancco-postvak.
- **Flancco-direct**: standaard Flancco-stijl (#1A1A2E navy header, "Flancco BV"
  branding, gillian.geernaert@flancco.be reply-to).
- **Onbekende slug / partner niet gevonden**: graceful fallback naar Flancco-default.

### Logo-fallback

`logo_url` aanwezig → `<img>` (max 200×48 px, gecentreerd). Geen logo →
H1 met partnernaam in white-on-primary.

### Footer

- Partner contact-block (telefoon link, email link, website link) — links in
  primary-color.
- "Platform aangedreven door Flancco BV" credit voor non-Flancco-partners.
- GDPR opt-out link via `klant_consents.opt_out_token` (laatste rij per
  email, query op `aangemaakt_op DESC`).

### i18n

`contracten.lang` is ground-truth (Slot S DB-persistentie). Payload-level
`lang` override blijft toegestaan. Subject + filename
herroepingsformulier worden gelokaliseerd:

- NL: `"{partnerName} — Bevestiging onderhoud zonnepanelen ({nr})"`
  + bijlage `Herroepingsformulier.pdf`
- FR: `"{partnerName} — Confirmation de l'entretien panneaux solaires ({nr})"`
  + bijlage `Formulaire_de_retractation.pdf`

### Bijlagen

1. Contract-PDF (uit `contracten.pdf_url` indien aanwezig — anders warning,
   mail wordt nog steeds verzonden zodat herroepingstermijn juridisch start).
2. Herroepingsformulier (altijd, gegenereerd via `_shared/herroeping.ts`).
   Blijft Flancco-juridisch — Flancco BV is de aannemer-entiteit, partners
   zijn commerciële intermediairs.

### Idempotentie

`contracten.verzonden_bevestiging_op` wordt gezet na succesvolle Resend-call.
Re-call retourneert `{success:true, skipped:true, reason:"already_sent"}`.

### URL-sanitization

`escUrl()` accepteert alleen `https://`, `http://`, `mailto:`, `tel:`. Andere
schemes (`javascript:`, `data:`, etc.) worden vervangen door `#`. Voorkomt
URL-injection via partner-record-velden.

## Verificatie (2026-04-25)

| Test | Resultaat |
|---|---|
| rapport_branded — admin JWT — NL/novectra | 200 (2986 bytes, signed URL) |
| rapport_branded — geen auth | 401 "Valid Authorization header required" |
| rapport_branded — partner JWT — own slug (cwsolar) | 200 (cwsolar branding) |
| rapport_branded — partner JWT — andere slug | 401 "Partner cannot generate for another partner" |
| rapport_branded — bediende JWT | 200 |
| rapport_branded — admin JWT — FR/novectra | 200 (3017 bytes) |
| send-confirmation — NL/novectra | 200, attachments_count=1 |
| send-confirmation — FR/novectra (Walloon-case) | 200, lang=fr |
| send-confirmation — Flancco-direct (default fallback) | 200, partner_slug=flancco |
| send-confirmation — idempotency replay | 200, skipped:true |

Visuele PDF-inspectie: header-band in juiste partner-kleur (Novectra
#4A7C59 groen, CW Solar #098979 teal, Flancco #1A1A2E navy), bullet-lijst
één per regel, FR-content correct gelokaliseerd inclusief datumformat
(`23 avril 2026`) en "Page 1 sur 1" footer.

## Rollback

Verwijder de twee `--use-api` deployments via Supabase dashboard, of
re-deploy de pre-Slot-C versies van:

- `supabase/functions/generate-pdf/templates/rapport_branded.ts` (was stub
  vóór Slot P → C3)
- `supabase/functions/send-confirmation/index.ts` (was non-branded NL-only
  vóór C4)

Database-impact: nul. Geen migraties, geen RLS-wijzigingen.

## Open follow-ups

- [ ] Klant-portal upload-pipeline voor foto's (vereist een klant-facing
      Storage-bucket + signed-URL flow). Vandaag verwacht het rapport URLs
      die de aanroepende admin/partner pre-signt.
- [ ] Contract-PDF download in `send-confirmation` faalt nu silently met
      `attachment_warnings: ["contract-pdf-missing"]` als `pdf_url` leeg is.
      Nice-to-have: re-genereren via `generate-pdf` → `contract_signed`
      template als fallback (Slot O2 eindigt op deze brug).
- [ ] Email open-tracking (Resend webhook) → schrijven naar
      `email_events`-tabel voor partner-portal funnel.
- [ ] Custom-fonts ondersteuning in pdf-lib (TTF embed) als partners brand-
      typografie willen — vandaag draaien we Helvetica-only.
