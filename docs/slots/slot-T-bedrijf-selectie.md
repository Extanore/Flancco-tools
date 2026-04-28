# Slot T — Bedrijf-selectie + werklocatie-aware planning

**Datum**: 2026-04-28
**Status**: Live
**Plan-ref**: `valiant-petting-pretzel.md` Deel 8

---

## Intent

Drie samenhangende UX-pijnpunten van Sarah Di Marco (Flancco operations) opgelost in één gecoördineerde release:

1. **Verwarring 1** — al gefixt eerder (commit `331472a`, searchable combobox): klant-dropdowns toonden enkel contactpersoon zonder bedrijfsnaam.
2. **Verwarring 2** — bedrijf-zelf kunnen kiezen als klant (niet enkel contactpersoon). Vandaag is `clients`-row 1 (bedrijf, persoon)-paar; users wilden bedrijf-only-keuze voor B2B-bezoeken zonder vaste contactpersoon.
3. **Verwarring 3** — te-plannen-cards toonden facturatieklant-postcode i.p.v. werklocatie. Twee jobs op verschillende werven kregen identieke kaarten.

## Architectuur — Route 2 ("embrace `client_contacts`")

Het schema was al half-genormaliseerd:
- `clients` rij = bedrijf-entiteit (heeft `company_name` + legacy `contact_person`-snapshot)
- `client_contacts` rij = volledige contactpersoon-data (was 9 rows, alle bedrijven gespiegeld, met `is_primary` + `role`-velden)
- 7 FK-relaties op `clients.id`, geen op `client_contacts.id` — UI gebruikte de tabel niet

Slot T omarmt dit:
- Child-tabellen (onderhoudsbeurten / contracten / bouwdrogers) krijgen optionele `client_contact_id`-FK naar `client_contacts`
- Semantiek: `client_id NOT NULL + client_contact_id NULL` = "het bedrijf zelf, geen specifieke persoon"
- Bedrijf-only contracten/orders zijn nu volwaardig representeerbaar zonder schema-leugen

## Spoor A — Bedrijf-selectie

### A1. Schema-migratie (`20260428113000_slot_t_bedrijf_selectie_via_client_contacts.sql`)
- `clients.contact_person` nullable
- `onderhoudsbeurten.client_contact_id` UUID FK → `client_contacts(id)` ON DELETE SET NULL
- `contracten.client_contact_id` idem
- `bouwdrogers.huidige_client_contact_id` idem
- Backfill: bestaande rijen krijgen primary contact
- Partial indexen `WHERE client_contact_id IS NOT NULL`
- Cleanup: testdata-rij `tgvtg/gvtgv` verwijderd

### A2. Combobox + items-builder uitgebreid
- `admin/shared/client-combobox.js`: nieuwe optie `selectableHeaders: true` — company-headers worden klikbaar (krijgen `role=option`, click-delegation, hover/active states)
- `admin/shared/client-combobox-items.js`: nieuwe opties `selectableHeaders + clientContacts`. Bij selectableHeaders krijgen headers value `bedrijf:<UUID>` en sub-items value `contact:<UUID>` (uit `client_contacts`-array i.p.v. `clients.contact_person`).
- `admin/shared/client-combobox.css`: `.fcb-group-company--selectable` met `→`-arrow-affordance
- Backwards-compat: defaults blijven oud gedrag

### A3. Wirings 4 modal-flows
Shared resolver `admin/shared/client-combobox-resolver.js` parseert value-prefixes:

| Value-prefix | Resolved |
|---|---|
| `bedrijf:UUID` | `{client_id: UUID, client_contact_id: null}` (bedrijf-only) |
| `contact:UUID` | `{client_id: <lookup>, client_contact_id: UUID}` (specifieke persoon) |
| `contract:UUID` | `{contract_id: UUID, ...}` (legacy ni-klant flow) |
| `__new` | `{isNew: true}` (wizard-magic) |
| `UUID` (geen prefix) | `{client_id: UUID, client_contact_id: null}` (legacy) |

Wirings:
- `qa-client` (Losse opdracht — `planning.html`)
- `ni-klant` (Interventie — `planning.html`, met legacy contracten als `extraItems`)
- `uitgeef-client` (Bouwdroger uitgeven — `index.html`)
- `wiz-client` (Contract-wizard — `contracten-wizard.html`, met magic `__new`-item)

### A4. Klant-edit modal (`admin/index.html` `openKlantModal`)
- Nieuwe toggle "Bedrijf zonder vaste contactpersoon" (zichtbaar bij client_type=bedrijf)
- Validatie loslaten: bij bedrijf-only mag primary contact first_name+last_name leeg blijven
- Save-pad: bij toggle-aan → `clients.contact_person = null` + bestaande `client_contacts`-rijen worden verwijderd

### A5. Calculator (`calculator/index.html`)
- Stap 2 sub-toggle "Wie tekent dit contract?": specifieke contactpersoon (default) vs het bedrijf zelf
- Bij bedrijf-only: contact-velden verbergen, validatie aanpassen, juridische disclaimer onder handtekening-canvas tonen
- i18n NL+FR via `calculator/i18n/{nl,fr}.json.js`

## Spoor B — Te-plannen-cards werklocatie-fix

5-regel fix in `admin/planning.html` `renderSidebarCard()` (regels 5602-5614):
- Werklocatie-blok (`werfHtml`) bestond al maar billing-postcode werd ALTIJD daaronder getoond → dubbele info, niet onderscheidbaar
- Fix: billing-postcode-blok wordt fallback (alleen wanneer `werfHtml` leeg is, geen werklocatie-FK)
- Productie-data: 6/9 onderhoudsbeurten hebben `client_location_id` gezet → directe winst voor 67%

## Spoor C — Werklocatie-pickflow bij multi-locatie-bedrijven

### C2. Shared component (`admin/shared/werklocatie-picker.{js,css,demo.html}`)
- 1208 LOC totaal (component + CSS + demo)
- API: `window.FlanccoWerklocatiePicker.attach(wrapperEl, {clientId, allClientLocations, onChange, autoSelectIfSingle, allowNew, onAddNew})`
- Single-locatie klanten: auto-select primary, geen UI-prompt
- Multi-locatie klanten: 2-column kaarten-grid, ARIA radiogroup, keyboard-nav

### C3. Wirings 4 call-sites
- `qa-locatie` (planning.html) — vervangen door werklocatie-picker
- `ni-locatie` (planning.html) — idem
- Nieuwe sectie in `admin/contracten-wizard.html` na klant-keuze
- Nieuwe sectie in uitgeef-droger modal in `admin/index.html`

### C4. Save-laag
- `bouwdrogers.client_location_id` toegevoegd via aanvullende migratie `20260428114200_slot_t_bouwdrogers_client_location_id.sql`
- `onderhoudsbeurten.client_location_id` bestond al
- `contracten.client_location_id` bestond al
- `interventies.client_location_id` bestond al

## Cross-cutting concern 1 — Contract-PDF + mail-templates

(Geleverd door agent E — zie commit-log voor details)

- `generate-pdf` template `contract_signed`: bedrijf-only mode (titel = company_name, geen "Contactpersoon"-regel, "namens [bedrijf]"-disclaimer)
- `send-confirmation`, `send-contract-link`, `send-klant-notification-{email,sms,whatsapp}`: bedrijf-only recipient + aanhef resolution

## Cross-cutting concern 2 — GDPR / klant_consents

### Migratie `20260428113700_slot_t_klant_consents_opt_out_door.sql`
- `klant_consents.opt_out_door` TEXT toegevoegd
- Vrije tekst — naam van wie binnen het bedrijf de opt-out triggered ("Naam X namens [bedrijfsnaam]")

### Edge function `handle-opt-out`
- Accepteert `opt_out_door` in POST-body
- Bedrijfs-email (clients.email) wordt opt-out-koppel voor bedrijf-only klanten

## Files-touched

**Schema-migraties (lokaal in `supabase/migrations/`):**
- `20260428113000_slot_t_bedrijf_selectie_via_client_contacts.sql`
- `20260428113700_slot_t_klant_consents_opt_out_door.sql`
- `20260428114200_slot_t_bouwdrogers_client_location_id.sql`

**Shared components (`admin/shared/`):**
- `client-combobox.js` — selectableHeaders-uitbreiding
- `client-combobox.css` — selectable-state styles
- `client-combobox-items.js` — clientContacts-mode
- `client-combobox-resolver.js` — NEW (value-prefix parser)
- `werklocatie-picker.js` — NEW (kaarten-grid component)
- `werklocatie-picker.css` — NEW
- `werklocatie-picker-demo.html` — NEW

**Host pages:**
- `admin/planning.html` (qa-client, ni-klant, qa-locatie, ni-locatie wirings + Spoor B fix)
- `admin/index.html` (uitgeef-client, klant-edit modal, uitgeef-werklocatie, Slot U technieker UI)
- `admin/contracten-wizard.html` (wiz-client + werklocatie-card)
- `calculator/index.html` (bedrijf-only sub-toggle)
- `calculator/i18n/{nl,fr}.json.js` (vertaalstrings)

**Edge functions:**
- `generate-pdf` (template aangepast)
- `send-confirmation`, `send-contract-link`
- `send-klant-notification-email/sms/whatsapp`
- `handle-opt-out` (`opt_out_door` veld)

## Verificatie

End-to-end test-scenario:
1. Admin login → Klanten → maak bedrijf "TestBedrijf BV" zonder contactpersoon (toggle aan)
2. Voeg 3 werklocaties toe (Sluiskil, Terneuzen, Brussel)
3. Plan losse opdracht → werklocatie-picker toont 3 keuzes → kies Sluiskil → save
4. Te-plannen-queue → kaart toont Sluiskil-postcode (NIET billing)
5. Contract-wizard → klant-combobox toont TestBedrijf als selectable bedrijf-header
6. Selecteer bedrijf-niveau → werklocatie-picker → contract-PDF genereren
7. PDF: kop = "TestBedrijf BV", geen "Contactpersoon"-regel
8. Calculator open partner-link → kies bedrijf-modus → "tekent het bedrijf zelf" → submit
9. `klant_consents` rij heeft bedrijfs-email als opt-out-koppel
10. RLS: tweede partner-user mag deze rijen niet zien

## Known issues / open follow-up

- Slot G/F/H/Q/R lokale migratie-files zijn lokaal aanwezig maar niet allemaal in `list_migrations`-output. Mogelijk pre-existing apply-pad-mismatch — buiten Slot T+U-scope. Aanbeveling: separate apply-pass voor deze sloten zodat winstgevendheid-pagina + opt-out-flow correct gevoed worden.
- Pre-existing JS-syntax baseline-issue in `admin/index.html` block #10 (line 808) — niet door Slot T geraakt.
- BE-juridische valididatie van bedrijf-only contract-tekening: implementeerd met disclaimer onder handtekening; CFO/legal-check aanbevolen vóór hoog-risico-segment go-live.
