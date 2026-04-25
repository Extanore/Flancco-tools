# Slot A2 — Contract-terms tab in admin/rapport.html

**Status:** Productieklaar. Continuous release — geen feature-flag, direct live in admin-rapport-pagina.

## Intent

- Technieker (admin/bediende) opent de Rapport-pagina, kiest een onderhoudsbeurt en heeft direct twee top-level tabs: **Rapport** (default — bestaande wizard) en **Contract** (nieuw).
- Contract-tab dient drie doelen:
  1. **Read-only inzicht** in scope + klantgegevens vóór de werken starten — vermijdt onnodig schakelen tussen tools.
  2. **Speciale instructies voor de technieker** vastleggen in een vrij-tekst-veld (1.000 chars) — verschijnt later op de werkbon-PDF.
  3. **Optionele scope-akkoord-handtekening** ter plekke laten zetten als extra juridische dekking vóór start van de uitvoering.
- Geen workflow-blocker — beurt kan ook zonder scope-akkoord uitgevoerd en gerapporteerd worden.

## Datamodel

Migration: `supabase/migrations/20260425140000_add_contract_terms_to_contracten.sql`

```sql
ALTER TABLE public.contracten
  ADD COLUMN IF NOT EXISTS speciale_instructies_technieker        text NULL,
  ADD COLUMN IF NOT EXISTS scope_akkoord_handtekening             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scope_akkoord_handtekening_base64      text NULL,
  ADD COLUMN IF NOT EXISTS scope_akkoord_handtekening_datum       timestamptz NULL;

ALTER TABLE public.contracten
  ADD CONSTRAINT chk_scope_handtekening_consistent
  CHECK (
    scope_akkoord_handtekening = false OR (
      scope_akkoord_handtekening_base64 IS NOT NULL
      AND scope_akkoord_handtekening_datum IS NOT NULL
    )
  );
```

- `speciale_instructies_technieker`: vrije tekst, max 1.000 chars enforced **client-side** (geen DB-CHECK om latere uitbreiding zonder migratie mogelijk te maken). Lege string wordt als `NULL` opgeslagen.
- `scope_akkoord_handtekening`: bool flag.
- `scope_akkoord_handtekening_base64`: PNG data-URL (`data:image/png;base64,...`).
- `scope_akkoord_handtekening_datum`: tijdstip van akkoord.
- CHECK constraint dwingt af dat als de bool TRUE is, beide andere velden ingevuld zijn — voorkomt half-getekende toestanden in de DB.

## RLS

Geen nieuwe policies nodig. Bestaande `contracten`-policies dekken de nieuwe kolommen automatisch:

| Policy | Rol | Operatie | Scope |
|---|---|---|---|
| `contracten_write_admin` | admin | ALL | alle rijen |
| `contracten_partner_write` | partner | ALL | eigen partner_id |
| `contracten_anon_insert` | anon | INSERT | calculator submit |

De Contract-tab wordt alleen geserveerd binnen `admin/rapport.html`, en die pagina checkt expliciet `user_roles.role = 'admin'` bij init — page-level gate, geen aparte UI-rol-check nodig voor de "Wis & opnieuw"-knop.

## Files touched

| File | Aard | Lines |
|---|---|---|
| `supabase/migrations/20260425140000_add_contract_terms_to_contracten.sql` | Nieuw | 48 |
| `calculator/i18n/nl.json.js` | Edit (`rapport.contract.*` namespace) | +60 |
| `calculator/i18n/fr.json.js` | Edit (`rapport.contract.*` namespace, vous-form BE-FR baseline) | +60 |
| `admin/rapport.html` | Edit (3 i18n script-tags, CSS voor tabs/cards/modal/toast, top-tabs HTML, Contract-tab pane, modal, toast-stack, ~700 lines JS) | +900 |

## Frontend gedrag

### Tab-toggle (`switchTopTab`)

- Pure UI-toggle — geen netwerk-calls per tab-switch.
- Bij eerste open van Contract-tab fired Slot 0-event `Rapport Contract Tab Opened`.
- Aria-attributen (`aria-selected`, `role="tab"`, `role="tabpanel"`, `aria-labelledby`) volledig uitgewerkt voor screen readers.

### Scope-card

- Toont read-only: aantal panelen (alleen indien gevuld), frequentie, contractduur, BTW-tarief (incl. 6% verklaring-trail wanneer relevant), totaal incl. BTW, totaal excl. BTW (client-side afgeleid uit `totaal_incl_btw` en `btw_type` — `totaal_excl_btw` bestaat niet in DB), eenheidsprijs per beurt.
- Bij 6% BTW maar ontbrekende verklaring-aanvinkjes (Slot O2): toont waarschuwing `btw6VerklaringMissing`.

### Klant-card

- Toont read-only contactgegevens met Slot O1-differentiatie:
  - **Particulier**: naam, adres, postcode, gemeente, email, telefoon.
  - **Bedrijf**: bedrijfsnaam, BTW-nummer (met validatie-status badge), contactpersoon, adres, postcode, gemeente, email, telefoon.
- BTW-validatie-status komt uit `btw_nummer_validated` + `btw_validated_at` (Slot O1).

### Instructies-card

- Textarea met `maxlength=1000`, char-counter (kleurcode bij 900+/1000), expliciete "Opslaan"-knop (geen auto-save — bewuste keuze, zie UX-rationale).
- Save-state pill: leeg → `Opslaan…` → `Opgeslagen` (groen, 4s zichtbaar).
- Toast-feedback bij success of error.
- Save-knop disabled tot textarea-content effectief verschilt van laatst-opgeslagen waarde (`_ct.instructiesDirty`).

### Scope-handtekening-card

- **Niet-getekend**: status-row met CTA-knop "Klant tekent ter plekke" — opent modal.
- **Modal**: titel + uitleg + canvas (200px hoog, full-width responsive) + Wissen/Annuleren/Bevestig-knoppen.
- Canvas ondersteunt mouse + touch (pen op tablet). Event-listeners 1× gebonden via `_ct.sigBound` flag.
- Bevestig zonder ink → inline error (`empty`-key), geen DB-call.
- Bij confirm: PNG data-URL via `canvas.toDataURL('image/png')` → upsert in DB (3 velden + `updated_at`) → re-render → toast + audit + Slot 0-event.
- **Getekend**: read-only preview (img-tag uit base64) + signed-at timestamp + admin-only "Wis & opnieuw"-knop. Bevestiging via native `confirm()` — destructieve actie.
- ESC-toets en klik-buiten-modal sluiten de modal en wissen het canvas.

## UX-rationale (keuzes uit het 11-stappenplan)

- **Expliciete save-knop ipv debounced auto-save**: voor speciale instructies wil de admin/bediende een duidelijk *"klaar"*-moment hebben. Debounced auto-save creëert onzekerheid ("is dit bewaard?") en triggert onnodig vaak een DB-write.
- **Textarea + char-counter ipv contenteditable rich-text**: technieker leest dit op een telefoon op een dak in de zon. Plain text → maximale leesbaarheid en geen styling-bugs.
- **Modal voor handtekening ipv inline canvas**: handtekening is een bewust ritueel ("klant overhandig de tablet, klant tekent, klant geeft tablet terug"). Modal forceert focus en voorkomt accidentele inkt op canvas tijdens scrollen.
- **Aparte canvas + state ipv shared signature-lib**: de bestaande `handtekening-canvas` in stap-samenvatting heeft eigen state, init-logica en CSS. Een extractie naar gedeelde lib zou ~40 LOC besparen tegen het risico op regressie in een live wizard. Voor Slot A2 is de duplicatie verantwoorder dan de refactor — als er een 3e canvas-use-case bijkomt, wordt extractie wel waardevol.
- **6% BTW verklaring-trail**: wanneer `btw_type LIKE '6%'` wordt expliciet getoond of de verklaring is gezet (datum) en welke twee aanvinkjes effectief TRUE zijn — voorkomt verrassingen bij audits.

## Analytics (Slot 0)

Vier events worden gelogd via `window.flanccoTrack` — alle PII-vrij:

```js
flanccoTrack('Rapport Contract Tab Opened',           { contract_id_hash: <sha256>, partner_slug: <slug> });
flanccoTrack('Rapport Instructies Saved',             { length_chars: <int> });
flanccoTrack('Rapport Scope Handtekening Signed',     { partner_slug: <slug> });
flanccoTrack('Rapport Scope Handtekening Cleared',    { partner_slug: <slug> });
```

`contract_id_hash` is SHA-256 hex via `window.crypto.subtle.digest`. **Geen klantgegevens of contract-ID's in plaintext** worden ooit gelogd.

## Audit-trail

Drie acties komen in `audit_log`:

| Actie | Oude waarde | Nieuwe waarde |
|---|---|---|
| `instructies_technieker_update` | `null` | `<N> chars` (lengte, niet de inhoud — privacy bij gevoelige instructies) |
| `scope_akkoord_handtekening_signed` | `null` | ISO-timestamp |
| `scope_akkoord_handtekening_cleared` | `'true'` | `'false'` |

## Deploy

```bash
# 1. Migration (al toegepast via mcp__apply_migration op project dhuqpxwwavqyxaelxuzl)
supabase migration up

# 2. Frontend (Cloudflare Pages auto-deploy via git push)
git push
```

Geen edge functions — pure frontend + DB.

## Test checklist

| # | Scenario | Verwacht |
|---|---|---|
| 1 | Open `admin/rapport.html`, kies een beurt | Top-tabs zichtbaar, Rapport-tab default actief, beurt-info-box gevuld |
| 2 | Klik Contract-tab | Pane fade-in, Scope + Klant + Instructies + Handtekening-cards gerendered, Slot 0-event `Rapport Contract Tab Opened` fired |
| 3 | Beurt heeft 6% BTW + Slot O2-verklaring gezet | Scope-card toont "BTW: 6% — Verklaring op eer (dd/mm/yyyy)" pil |
| 4 | Beurt heeft 6% BTW maar verklaring nog niet gezet | Scope-card toont oranje waarschuwing `btw6VerklaringMissing` |
| 5 | Klant is bedrijf met geverifieerde BTW (Slot O1) | Klant-card toont bedrijfsnaam + BTW-nummer + contactpersoon + groen "VIES geverifieerd"-badge |
| 6 | Type tekst in instructies-textarea | Counter live updaten, Save-knop wordt enabled |
| 7 | Type 901+ chars | Counter krijgt `warn`-styling (oranje) |
| 8 | Type 1000 chars | Counter `danger` (rood), `maxlength` blokkeert verdere input |
| 9 | Klik "Instructies opslaan" met dirty content | Save-pill `Opslaan…` → `Opgeslagen`, toast success, knop disabled, audit-log entry, Slot 0-event |
| 10 | Reload pagina + zelfde beurt | Textarea bevat opgeslagen instructies, Save-knop disabled |
| 11 | Klik "Klant tekent ter plekke" | Modal opent, canvas leeg, ESC sluit modal |
| 12 | Klik Bevestig zonder te tekenen | Inline error `empty`, geen DB-call |
| 13 | Teken iets, klik Bevestig | Modal sluit, preview-img verschijnt met signed-at timestamp, toast success, DB krijgt 3 velden, audit + Slot 0-event |
| 14 | Reload pagina + zelfde beurt | Preview blijft zichtbaar, "Wis & opnieuw"-knop zichtbaar |
| 15 | Klik "Wis & opnieuw" → bevestig native confirm | Drie velden gewist in DB, status-row terug naar CTA, toast, audit + Slot 0-event |
| 16 | Tab terug naar Rapport-tab | Wizard nog steeds in step-state waar je hem verliet, geen herrender |
| 17 | Geen beurt geselecteerd (reset) | Contract-tab toont empty-state, Save-knop + textarea disabled |
| 18 | Switch taal naar FR (`?lang=fr`) | Tab-label, alle card-titels, modal-tekst in FR |

## Niet in scope (toekomst — TODOs)

- **Werkbon-PDF integratie**: `speciale_instructies_technieker` moet renderen op de werkbon-PDF die de technieker meeneemt. Dat vereist een aanpassing in `generate-pdf` Edge Function (Slot P) — de `werkplanning`-template moet de instructies-paragraaf toevoegen wanneer aanwezig. Niet in dit slot.
- **Scope-akkoord op rapport-PDF**: bij eindrapport moet de scope-akkoord-handtekening (indien aanwezig) als extra annex worden bijgevoegd. Vereist evenzo edit in PDF-template (`rapport_branded`).
- **Versionering van instructies**: huidig overschrijft elke save de vorige. Wanneer instructies juridisch relevant worden (bv. bij geschil), zou een history-tabel `contracten_instructies_history` zinvol zijn. Bewust niet in scope — over-engineering voor huidige use-case.
- **Real-time collaboration**: meerdere techniekers tegelijk op dezelfde beurt → last-write-wins. Geen conflict-detection. Acceptabel: éen technieker per beurt is de regel.
- **Signature-lib refactor**: rapport.html bevat nu 2 onafhankelijke canvas-implementaties (klant-handtekening en scope-akkoord). Bij toevoeging van een 3e use-case wordt extractie naar `assets/js/signature-pad.js` waardevol.
- **FR-i18n native review**: huidige FR-strings zijn vous-form baseline van NL-original. Native FR-spreker (BE-NL <> BE-FR) zou nuance kunnen verfijnen ("ter plekke" → "sur place" vs "sur le site" etc.).
