# Slot O2 — Postcode-first, Verklaring op eer (KB nr. 20) en Inline Validatie

**Status:** Productieklaar. Continuous release — geen feature-flag, direct live op calculator + admin-wizard.

## Intent

Drie samenhangende UX- en compliance-verbeteringen die anti-friction creëren én de juridische basis voor het verlaagd 6% BTW-tarief borgen:

1. **Postcode-first.** Postcode wordt het eerste veld in stap 1 (vóór BTW-keuze). Bepaalt of 6% BTW überhaupt zichtbaar is, triggert taal-detectie (Slot S) en vult de gemeente automatisch in.
2. **Verklaring op eer (verplicht conform KB nr. 20 / AR n° 20).** Het oude single-checkbox-model is vervangen door **twee verplichte aparte checkboxen** (privé-woning + ouderdom 10 jaar) plus een wettelijke disclaimer. Beide moeten aangevinkt zijn anders revert het BTW-tarief automatisch naar 21%.
3. **Real-time inline validatie.** Per veld op blur/300 ms debounce: groene check / rode border + hint, telefoon-auto-format `+32 4XX XX XX XX`, e-mail/postcode regex, en een progress-counter "Nog X velden in te vullen voor u verder kan".

Doel: minder formulier-frictie, harde compliance op het 6%-pad, en één gedeelde validator-laag voor calculator én admin-wizard.

## Architectuur

### Drie nieuwe bestanden

| Bestand | Rol |
|---|---|
| `calculator/data/be-postcodes.json` | 1145 unieke BE-postcodes met deelgemeenten (~78 KB, statisch) |
| `calculator/shared/validators.js` | Pure-functie validators (postcode/email/tel/naam/VAT) — registreert `window.flanccoValidators` |
| `calculator/shared/postcode-lookup.js` | Lazy-load helper voor `be-postcodes.json` met dedupe + soft-fail back-off — registreert `window.flanccoPostcodes` |

### Datamodel

Migration: `supabase/migrations/20260425130000_add_btw6_verklaring_to_contracten.sql`

```sql
ALTER TABLE public.contracten
  ADD COLUMN IF NOT EXISTS verklaring_6btw_privewoning_aangevinkt boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verklaring_6btw_ouderdan10j_aangevinkt boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verklaring_6btw_datum                  timestamptz NULL;

ALTER TABLE public.contracten
  ADD CONSTRAINT chk_btw6_verklaring_consistent
  CHECK (
    btw_type IS NULL
    OR btw_type NOT LIKE '6%'
    OR (
      verklaring_6btw_privewoning_aangevinkt = true
      AND verklaring_6btw_ouderdan10j_aangevinkt = true
      AND verklaring_6btw_datum IS NOT NULL
    )
  );
```

`btw_type` is een tekstkolom die zowel `'21%'` (calculator) als `'21'` (legacy) kan bevatten — vandaar `LIKE '6%'` in de CHECK om beide te dekken. De constraint maakt het database-niveau onmogelijk om een 6%-contract op te slaan zonder beide verklaringen + tijdstempel.

### Postcode-data

Bron: [`jief/zipcode-belgium`](https://github.com/jief/zipcode-belgium) (CC-BY 3.0, afgeleid van bpost open data). Gecompacteerd naar `{<postcode>: [{gemeente: ...}, ...]}`. 1145 unieke postcodes; 518 hebben meerdere deelgemeenten (bv. 9050 → Gentbrugge + Ledeberg, 4000 → Glain + Liège + Rocourt).

Lazy-loaded via `fetch('data/be-postcodes.json', { cache: 'force-cache' })` bij eerste blur of step-mount. Soft-fail: bij netwerkfout wordt het format-criterium (`/^[1-9]\d{3}$/`) gerespecteerd en de klant kan doorgaan; gemeente blijft handmatig in te vullen.

### Calculator (`calculator/index.html`)

- **Postcode-card** bovenaan stap 1 (vóór de partner-intro). Eigen `<h2>` met locatie-icoon, helper-tekst, postcode-input, gemeente-input (verschijnt na geldige BE postcode), deelgemeente-dropdown bij ambiguïteit.
- **Step 2 postcode** blijft bestaan en is bidirectioneel ge-mirrord (`syncPostcodeBetweenSteps`) — beide invoeren editen dezelfde waarde, gemeente in stap 2 wordt enkel auto-gevuld als die nog leeg is (respect voor user-edit).
- **6%-radio** krijgt class `is-disabled` + uitleg-helper bij niet-BE postcode; klik wordt geblokkeerd via CSS (`pointer-events: none` op `<input>`).
- **Verklaring-blok**: twee aparte `<label class="check-row">` met `id="btw6-check-prive"` en `id="btw6-check-ouderdom"`, plus `verklaring-disclaimer` met de wettelijke verhalingstekst. Niet aangevinkt = rode border-highlight + scrollIntoView bij submit-poging.
- **Inline-validatie**: per veld een `<span class="field-icon">` (groene check/rode alert) + `<div class="field-hint" role="alert">` voor screen-readers. Telefoon krijgt auto-format on blur via `flanccoValidators.formatPhoneBE()`.
- **CTA-progress**: nieuwe `<div id="cta-progress" aria-live="polite">` onder de submit-knop telt resterende verplichte velden + onthoudt 6%-verklaringen + privacy-check.

### Admin wizard (`admin/contracten-wizard.html`)

- **Postcode-veld** (stap 2, nieuwe-klant-form) is nu numeric/4-cijfers met live lookup → gemeente auto-fill of deelgemeente-dropdown. Visuele states identiek aan calculator.
- **BTW-card op stap 4** (nieuw, tussen "Looptijd" en "Details"): twee tegels (`21%` default, `6%`). 6%-tegel wordt automatisch disabled als de actieve klant-postcode niet BE is — gebruikt `getActiveKlantPostcode()` die zowel `wizState.newClient.postal_code`, lopende `nc-postcode` invoer als `clients.postal_code` van bestaande klant raadpleegt.
- **Verklaring-blok** (`#wiz-btw6-verklaring`) verschijnt onder de BTW-tegels zodra 6% gekozen wordt. Tekst is licht herformuleerd ("De partner bevestigt…") omdat dit een admin-context is, maar bevat dezelfde KB nr. 20-disclaimer.
- **`recalcPricing()`** gebruikt nu `wizState.btwPct` i.p.v. de hardcoded `21`.
- **`saveContract()`** guard: bij 6% zonder beide checkboxen → toast + abort + rode markering.

### Slot S — taal-detectie

De bestaande `attachPostcodeListener()` luistert nu op **beide** invoeren (`pc-postcode` en `klant-postcode`). De Brussels-prompt blijft onveranderd; FR-switch via 4xxx/13xx/7xxx postcodes werkt automatisch zodra er 4 cijfers staan.

`langFromPostcode()` is **strikter** gemaakt: input '99999' (NL-postcode-formaat) → `null` i.p.v. te truncaten naar '9999' en `'nl'` te returnen.

## Files touched

| File | Aard | Lines |
|---|---|---|
| `supabase/migrations/20260425130000_add_btw6_verklaring_to_contracten.sql` | Nieuw | 41 |
| `calculator/data/be-postcodes.json` | Nieuw (data) | 1145 entries / 78 KB |
| `calculator/shared/validators.js` | Nieuw | 113 |
| `calculator/shared/postcode-lookup.js` | Nieuw | 76 |
| `calculator/i18n/nl.json.js` | Edit (postcode-keys, verklaring v2, validation-bundle) | +30 |
| `calculator/i18n/fr.json.js` | Edit (zelfde keys, AR n° 20-formulering) | +30 |
| `calculator/index.html` | Edit (CSS, postcode-card, verklaring v2, inline-validatie, payload) | +470 |
| `admin/contracten-wizard.html` | Edit (CSS, postcode-lookup, BTW-card, verklaring, payload, guard) | +260 |
| `docs/slots/slot-O2-postcode-verklaring-validatie.md` | Nieuw | (dit doc) |

## Frontend gedrag — flows

### Calculator: BE-flow met 6%

1. Klant landt op stap 1, ziet postcode-card als eerste element.
2. Vult `9000` → BE check OK → groene check + helper "Belgische postcode — alle BTW-tarieven beschikbaar"; gemeente-veld verschijnt en bevat `Gent`.
3. Klant scrollt naar BTW-card → 6%-radio is zichtbaar (geen `is-disabled`-class).
4. Klant kiest 6% → verklaring-blok rolt open met twee aparte checkboxen + disclaimer.
5. Klant vult stap 2 in → gemeente staat al voor hem ingevuld (mirror).
6. Bij `goToSummary`: beide verklaringen verplicht → bij ontbreken één → toast + scrollIntoView naar verklaring-blok + rode highlights.
7. Submit → payload bevat `verklaring_6btw_privewoning_aangevinkt: true`, `verklaring_6btw_ouderdan10j_aangevinkt: true`, `verklaring_6btw_datum: <ISO timestamp>`.

### Calculator: NL-postcode (`9999XX` → niet-BE)

1. Klant typt `9999` → format-OK → 6%-optie blijft zichtbaar (4 cijfers BE-style).
2. Maar: gemeente-lookup in `be-postcodes.json` retourneert `found: false` → helper toont "Belgische postcode" maar geen auto-fill.
3. Klant typt `99999` (5 cijfers) → input wordt afgekapt naar `9999`. Realistische NL-flow vereist dat klant de werken in BE laat uitvoeren — toepassing zegt zelf BE-only (zie marketing).

### Calculator: Brussels (1000-1299) — taal-prompt

1. Postcode `1000` → BE check OK + (uit Slot S) `setLangFromPostcode('1000', showBrusselsPrompt)` triggert overlay "Welke taal verkiest u?" met NL/FR keuze.
2. Klant kiest FR → `flanccoI18n.setLang('fr')` → alle data-i18n keys herrenderen.

### Calculator: foreign postcode → 21% revert

1. Klant typt `BLABLA` of `99` → format-fail → 6%-optie verbergt (`display: none`).
2. Als 6% al gekozen was → automatische revert naar 21% + toast "BTW automatisch teruggezet naar 21%" + Plausible-event `Calculator BTW6 Reverted To 21`.

### Wizard: bestaande BE-klant met 6%

1. Wizard stap 2 → bestaande klant gekozen → postcode komt uit `clients.postal_code`.
2. Stap 4 → `refreshWizBtw6Availability()` checkt postcode → 6%-tegel wordt actief.
3. Admin klikt 6% → verklaring-blok verschijnt → vinkt beide aan.
4. `saveContract` → guard passes, payload bevat de 3 nieuwe kolommen + `btw_type: '6%'` → CHECK constraint accepteert.

## Analytics (Slot 0)

Vier nieuwe events via `window.flanccoTrack`:

```js
flanccoTrack('Calculator Postcode Filled', { country: 'BE', deelgemeenten: 2 });
flanccoTrack('Calculator BTW6 Selected', {});
flanccoTrack('Calculator BTW6 Reverted To 21', { reason: 'foreign_postcode' });
flanccoTrack('Calculator Validation Error', { field: 'email' | 'phone' | 'btw6_verklaring' });
```

**Geen PII** — geen postcodes, geen e-mailadressen, geen namen.

## i18n — nieuwe keys

NL + FR (zie `calculator/i18n/nl.json.js` en `fr.json.js`):

```
step1.postcode.title / .subtitle / .label / .placeholder / .helperBE / .helperFallback
step1.postcode.gemeenteLabel / .gemeenteAuto / .gemeenteChoose
step1.cards.btw6disabled
step1.btw6.checkPrive / .checkOuderdom / .disclaimer
validation.required / .invalidEmail / .invalidPhone / .invalidPostcode / .invalidName
validation.postcodeNotFound / .remainingFieldsOne / .remainingFieldsMany / .okReady
validation.btw6NeedsBoth / .btw6Reverted
```

FR-vertaling is BASELINE — laten valideren door native FR-speaker (Belgisch FR, geen FR-FR-jargon). De wettelijke termen ("arrêté royal n° 20", "rubriques XXXVIII et XXXI", "art. 1quater") zijn uit de officiële NL/FR-versie van het KB overgenomen.

## RLS

Geen nieuwe policies nodig — bestaande `contracten`-policies dekken de drie nieuwe kolommen automatisch. Anon mag enkel INSERT (incl. de drie nieuwe kolommen) en de CHECK constraint dwingt consistentie af.

## Test checklist

| # | Scenario | Verwacht |
|---|---|---|
| 1 | Calculator BE-postcode `9000` + 6% + beide checkboxen + submit | Contract met `btw_type='6%'`, `verklaring_6btw_privewoning_aangevinkt=true`, `verklaring_6btw_ouderdan10j_aangevinkt=true`, `verklaring_6btw_datum NOT NULL` |
| 2 | Calculator BE-postcode `9000` + 6% + slechts 1 checkbox + submit | Toast + scrollIntoView, geen submit |
| 3 | Calculator postcode `99999` (NL-stijl) | 6%-optie verbergt; bij eerder gekozen 6% → revert + toast |
| 4 | Calculator postcode `1000` (Brussels) | Brussels-prompt verschijnt zoals voor Slot O2 |
| 5 | Calculator postcode `4000` (Liège) | Lang switcht naar FR; deelgemeente-dropdown toont Glain/Liège/Rocourt |
| 6 | Calculator postcode `9050` (Gentbrugge+Ledeberg) | Deelgemeente-picker met 2 opties; Gentbrugge default ingevuld |
| 7 | Calculator e-mail `foo` (geen @) | Inline rode border + hint "Vul een geldig e-mailadres in"; submit blocked |
| 8 | Calculator telefoon `0477123456` on blur | Auto-format naar `+32 477 12 34 56`, groene check |
| 9 | Calculator stap 2 — alle velden ingevuld | CTA-progress: "Alle gegevens zijn correct ingevuld" (groen) |
| 10 | Wizard nieuwe klant + BE postcode + stap 4 → kies 6% + beide checkboxen + save | Contract met 6% + verklaringen, geen CHECK-violatie |
| 11 | Wizard bestaande klant met buitenlandse postcode + stap 4 | 6%-tegel grijs, klik geblokkeerd |
| 12 | DB: poging tot direct INSERT met `btw_type='6%'` zonder verklaringen | CHECK constraint violation `chk_btw6_verklaring_consistent` |

JS-syntax getest via `node -e 'new Function(scriptBlock)'` op alle inline scripts in beide HTML's én op de twee shared modules. Validators getest met 18 unit-checks (postcode/email/phone/lang).

## Bekende gaps (niet-doelen voor deze slot)

- Geen postcode-data voor andere landen — buiten BE krijgt klant fallback-helper en 21% (het businessmodel is BE-only).
- Geen API-driven gemeente-lookup (bv. Bpost) — statische JSON is sneller, GDPR-vrij en geen rate-limit.
- Geen client-side preview van de 6%-impact in cijfers (-15% prijs-effect) — bewuste keuze om druk te beperken; het komt automatisch in de prijscalculatie naar voor.
- Geen aparte audit-row in `audit_log` — de timestamp + booleans op `contracten` zijn juridisch voldoende.
- Geen herzicht-flow als klant later beweert geen recht te hebben op 6% — handmatig admin-werk via re-issue.

## Deploy

```bash
# 1. Migration is al toegepast (mcp__apply_migration, project dhuqpxwwavqyxaelxuzl)
#    Versie 20260425111606 — add_btw6_verklaring_to_contracten

# 2. Frontend is statisch — geen edge-function-redeploy
git add .
git commit -m "feat(calculator,wizard): postcode-first + KB nr. 20 verklaring + inline validatie (Slot O2)"
git push
# Cloudflare Pages auto-deployed
```

## Rollback

1. **Frontend**: `git revert <commit>` — alle bestanden geïsoleerd in calculator + wizard, geen impact op andere pagina's.
2. **Database**:
   ```sql
   ALTER TABLE public.contracten
     DROP CONSTRAINT IF EXISTS chk_btw6_verklaring_consistent;
   ALTER TABLE public.contracten
     DROP COLUMN IF EXISTS verklaring_6btw_privewoning_aangevinkt,
     DROP COLUMN IF EXISTS verklaring_6btw_ouderdan10j_aangevinkt,
     DROP COLUMN IF EXISTS verklaring_6btw_datum;
   ```
   Bestaande 6%-contracten verliezen de verklaring-meta maar blijven volledig bruikbaar.
3. **Postcode-JSON**: kan blijven staan — wordt niet meer geladen zodra de inline-script-tags verwijderd zijn.
