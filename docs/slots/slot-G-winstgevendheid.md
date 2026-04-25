# Slot G — Winstgevendheid

## Doel

Vervangt de vroegere "forecast"-pagina door één scherm met drie drill-downs op
brutomarge: per partner, per sector en per technieker. Brutomarge wordt
gerekend op afgewerkte onderhoudsbeurten (status `afgerond`) binnen een
gekozen periode (default YTD, lopend kalenderjaar t/m vandaag). Doel is dat
Flancco-management in één blik ziet welke partners, sectoren en techniekers
echt geld opleveren — niet alleen omzet draaien.

De pagina vervangt de oude omzet-prognose volledig (zie kill-list in plan):
geen sub-tabs, één pagina = winstgevendheid. Geen backward-compat met de
oude `renderForecast()`-logica; navigatie blijft op `data-page="forecast"`
zodat bestaande bookmarks blijven werken.

## Scope

| In scope | Out of scope |
|---|---|
| Drie drill-downs (Partner / Sector / Technieker) gebaseerd op afgewerkte beurten | Voorspelling toekomstige omzet (`Komend kwartaal`-period is placeholder die YTD toont) |
| YTD-periode als default + period-selector als toolbar-element | Forecast-projectie obv historiek |
| Brutomarge-berekening: `forfait_bedrag − (planning_fee + arbeids- + reis- + materiaalkost)` | Verlof-/feestdagen-aftrek bij bezettingsgraad (v1 = simplificatie) |
| KPI-strip + stacked-bar SVG (partner/sector) + datatabel + kleur-codering marge% | PDF-export (button placeholder; haakt later op `generate-pdf`-engine) |
| Multi-tech equal-share allocatie via `UNNEST(extra_technieker_ids)` | Uren-gewogen allocatie per technieker |
| Sector-normalisatie: `warmtepomp_*` → `warmtepomp`, rest naar whitelist of `overig` | Strikte sector-enum / lookup-table |
| Slot 0 events: Page View, Tab Switch, Period Change, Export Click | Adblocker-resistente analytics-proxy |

## Files touched

| Path | Type | Verantwoordelijkheid |
|---|---|---|
| `supabase/migrations/20260425171000_slot_g_winstgevendheid_views.sql` | create | Drie views met `security_invoker=on` + GRANTs |
| `admin/index.html` (navbar regel 1516-1519) | edit | Label `Forecast` → `Winstgevendheid`, nieuw line-chart-icoon (Lucide `trending-up`) |
| `admin/index.html` (page-title map regel 6017) | edit | `forecast: 'Forecast'` → `forecast: 'Winstgevendheid'` |
| `admin/index.html` (showPage hook) | edit | Nieuwe `if (name === 'forecast') activateWinstgevendheidPage()` lazy-load |
| `admin/index.html` (page section ~regel 2503-2522) | edit | Volledige rewrite naar EW-design template (dv-header + dv-toolbar + 3 grids) |
| `admin/index.html` (CSS regel ~339-347) | edit | `.forecast-*`/`.bar-*`/`.legend-dot` weg; `.winst-*` namespacing erbij |
| `admin/index.html` (JS regel ~11142-11211) | edit | `renderForecast()` weg; nieuwe Slot G-module (~ 470 regels) |
| `admin/index.html` (loadAllData) | edit | `renderForecast()` call verwijderd, vervangen door comment |
| `docs/slots/slot-G-winstgevendheid.md` | create | Dit bestand |
| `CLAUDE.md` | edit | Schema-sectie aangevuld met de drie nieuwe views |

Niet aangeraakt (file-fence): alle `supabase/functions/*` (Slot F draait
daar), `calculator/`, `planning.html`, andere admin-pagina's, andere
migraties.

## Schema (drie views)

Alle drie de views draaien met `security_invoker = on`, waardoor de RLS van
`onderhoudsbeurten`, `contracten`, `partners` en `techniekers` automatisch
gerespecteerd wordt:

- **admin** ziet alle data
- **partner** ziet enkel beurten van eigen contracten (RLS op
  `onderhoudsbeurten` filtert via `contracten.partner_id`)
- **anon** krijgt SELECT geweigerd (geen GRANT)

### `v_winstgevendheid_per_partner`

Aggregatie per actieve partner, periode YTD. Kolommen:

```
partner_id, partner_naam, partner_slug, kleur_primair,
aantal_beurten_afgerond,
omzet_excl_btw, planning_fee_kost,
arbeidskost, reiskost, materiaalkost,
brutomarge,
periode_start, periode_eind
```

### `v_winstgevendheid_per_sector`

Aggregatie per genormaliseerde sector. `b.sector` is free-text; we mappen
`warmtepomp_*` → `warmtepomp` en bekende sectoren blijven, rest valt in
`overig`. Kolommen identiek aan partner-view, met `sector` i.p.v.
partner-velden.

### `v_winstgevendheid_per_technieker`

Per-technieker toewijzing met **equal-share** allocatie via
`UNNEST(ARRAY[technieker_id] || COALESCE(extra_technieker_ids, '{}'))`.
Voor elke beurt wordt `share_pct = 1/(1+aantal_extras)` toegekend, en alle
omzet-/kost-/uren-velden worden vermenigvuldigd met `share_pct`.

Kolommen:

```
technieker_id, technieker_naam, technieker_voornaam,
uurtarief, contract_uren_week,
aantal_beurten,
omzet_aandeel, kost_aandeel, brutomarge_aandeel,
gewerkte_uren, bezettingsgraad_pct,
periode_start, periode_eind
```

## Berekeningen

### Brutomarge per beurt

```
brutomarge = forfait_bedrag
             − (totaal_arbeidskost + totaal_reiskost + totaal_materiaalkost
                + planning_fee_van_partner)
```

`planning_fee` komt uit de partner-record en wordt per beurt gekoppeld via
de keten `onderhoudsbeurten.contract_id → contracten.partner_id →
partners.planning_fee`. Voor partners met `planning_fee = 0` (bijv. Flancco
Direct) heeft het geen netto-effect.

### Marge-percentage

```
marge_pct = (brutomarge / omzet_excl_btw) × 100   (alleen als omzet > 0)
```

Color-coding in de UI (CSS-classes, geen inline styles):

- ≥ 20% → groen (`.winst-marge-good`)
- 10-20% → amber (`.winst-marge-warn`)
- < 10% → rood (`.winst-marge-bad`)
- N/A (omzet = 0) → grijs (`.winst-marge-na`)

### Multi-tech allocatie

Voor een beurt met 1 hoofd-tech + n extra-techs:

```
share_pct = 1 / (1 + n)
omzet_aandeel_per_tech     = forfait_bedrag × share_pct
kost_aandeel_per_tech      = (arbeids+reis+materiaal+planning_fee) × share_pct
brutomarge_aandeel_per_tech = (forfait − kost) × share_pct
gewerkte_uren_per_tech     = totaal_uren × share_pct
```

v1 = equal-share. Een uren-gewogen variant zou per (beurt, tech) een werkelijke
uren-registratie nodig hebben (bijv. via `beurt_uren_per_tech`-tabel).
Zie follow-up #6.

### Sector-normalisatie

```
CASE
  WHEN sector LIKE 'warmtepomp%'
       THEN 'warmtepomp'
  WHEN sector IN ('zonnepanelen','warmtepomp','ventilatie','verwarming',
                  'ic','klussen','airco','sanitair','elektriciteit')
       THEN sector
  ELSE COALESCE(sector, 'overig')
END
```

### Bezettingsgraad (v1-simplificatie)

```
bezettingsgraad_pct = (gewerkte_uren_YTD
                       / (contract_uren_week × ISO_weeknummer_vandaag))
                      × 100
```

**Bewuste simplificatie**: trekt geen verlof, geen EW-dagen en geen
feestdagen af. Het eerste resultaat onderschat dus de "echte" bezetting bij
techniekers met veel verlof. Zie follow-up #2 voor v2-koppeling met
`verlof_aanvragen` en `feestdagen`.

## Data flow

```
[admin/index.html, page-forecast]
  └─ showPage('forecast') → activateWinstgevendheidPage()
        └─ loadWinstgevendheid()         (parallel 3× supabase.from(...))
        └─ renderWinstgevendheid()       (orchestrator)
              ├─ renderWinstgevendheidPartner()
              │    ├─ KPI-strip (4)
              │    ├─ stacked-bar SVG    (vanilla SVG, geen lib)
              │    └─ datatabel          (DOM via createElement, geen innerHTML)
              ├─ renderWinstgevendheidSector()    (zelfde patroon)
              └─ renderWinstgevendheidTechnieker() (zonder chart, met bezetting-kolom)

[Tab/Period switch]
  setWinstgevendheidTab(t)     → window.flanccoTrack('Winstgevendheid Tab Switch')
  setWinstgevendheidPeriod(p)  → window.flanccoTrack('Winstgevendheid Period Change')
  onWinstgevendheidExportClick → window.flanccoTrack('Winstgevendheid Export Click')
```

## Slot 0 events

| Event | Trigger | Pagina |
|---|---|---|
| `Winstgevendheid Page View` | eerste activatie van `page-forecast` per sessie | `admin/index.html` |
| `Winstgevendheid Tab Switch` | klik op segmented control (partner/sector/technieker) | `admin/index.html` |
| `Winstgevendheid Period Change` | wijziging van period-dropdown | `admin/index.html` |
| `Winstgevendheid Export Click` | klik op (disabled) export-knop — registreert intent | `admin/index.html` |

Alle calls zijn defensief gewikkeld in `if (typeof window.flanccoTrack === 'function')` zodat een geblokkeerde Plausible-loader het admin-scherm nooit kapot maakt.

## Test-instructies

### Functioneel (admin-rol)

1. Login als admin op `https://app.flancco-platform.be/admin/`.
2. Klik in de sidebar onder **Financieel** op **Winstgevendheid**.
3. Verwacht: card-header "Winstgevendheid — Brutomarge per partner, sector
   en technieker (YTD)" met segmented control [Partner | Sector | Technieker].
4. Default-tab = Partner met KPI-strip + stacked-bar + tabel.
5. Wissel naar Sector-tab → andere KPI's + andere chart + andere tabel.
6. Wissel naar Technieker-tab → KPI's + tabel met bezettingsgraad-kolom (geen chart).
7. Period-dropdown wijziging naar "Komend kwartaal" → toast verschijnt
   met v2-disclaimer; data blijft YTD (verwacht v1-gedrag).

### Empty-state

Op een nieuw account zonder afgewerkte beurten in YTD:
- KPI's tonen `0` / `€ 0`
- Stacked-bar toont lege achtergrond-bars per partner
- Tabel toont alle actieve partners met `0` waarden + footer "Totaal" rij met `0`
- Tabel-footer-rij verschijnt enkel als `hasData === true`; bij volledig lege data ziet de gebruiker de empty-state met Lucide-icoon

### Partner-rol

1. Login als partner-account (zodra een test-account beschikbaar is —
   buiten scope om er een aan te maken).
2. Sidebar toont **Winstgevendheid** NIET (`.admin-only` filter).
3. Direct navigeren naar `/admin/#forecast` toont leeg/geen pagina (rol-check).
4. Op DB-niveau: een directe `SELECT * FROM v_winstgevendheid_per_partner`
   uitgevoerd als partner-rol mag alleen rijen retourneren waarvan
   `partner_id` = eigen partner_id (RLS van onderliggende `onderhoudsbeurten`).

### Anon

`SELECT` op alle drie de views moet falen vanwege REVOKE op anon. Snelle
verificatie via supabase JS met enkel anon-key:
```js
const { data, error } = await sb.from('v_winstgevendheid_per_partner').select('*');
// expected: error.code = '42501' (insufficient_privilege)
```

### XSS-safety

- Stel een partner met `naam = '<script>alert(1)</script>'` in (testdata).
- Open Winstgevendheid-pagina.
- Verwacht: literal tekst `<script>alert(1)</script>` in de tabel-cel,
  geen popup.
- Implementatie: alle data via `td.textContent = ...`, KPI's via
  `el.textContent = ...`, SVG-tekst via `lbl.textContent = ...`.

### JS-syntax

```bash
# Extract main inline script block en valideer:
node /tmp/winst-checks/blk-5.js  # → BLK5_SYNTAX_OK
```

(Pre-existing parser-quirk: regex-extractie matched `<style>`-content als
"block 4" door een subtiel `</script>`-vooral-comment patroon. Niet
geïntroduceerd door Slot G.)

## Follow-ups

1. **Komend-kwartaal-periode**: vereist forecast-projection logica obv
   actieve contracten + frequentie + seizoenscurve. v1 toont YTD voor
   beide periodes met info-toast bij wijziging. Implementeren via een
   nieuwe view `v_winstgevendheid_komend_kwartaal_per_partner` die
   geplande beurten (`status='ingepland'` + `plan_datum BETWEEN
   today AND today + 90`) projecteert met de huidige forfait + tarieven.

2. **Bezettingsgraad v2**: huidige formule trekt verlof, EW-dagen en
   feestdagen NIET af. v2: koppel aan `verlof_aanvragen` (status='goedgekeurd'),
   `ew_registraties` en `feestdagen` om effectieve beschikbaarheid in uren
   te berekenen, zodat bezetting realistischer wordt voor techniekers met
   veel afwezigheid.

3. **Materiaalkost-vulling**: aggregaten gaan ervan uit dat
   `onderhoudsbeurten.totaal_materiaalkost` correct is gevuld bij
   afwerking van de beurt (door planning- of rapport-flow). Verifieer
   met admin dat dit veld in elk afsluit-pad geschreven wordt; anders
   wordt brutomarge structureel overschat.

4. **PDF-export**: button is nu disabled (`title`-attribuut documenteert
   waarom). Hookup: nieuw template `winstgevendheid_overzicht` in
   `supabase/functions/generate-pdf/templates/`, A4-landscape, met de
   actieve drill-down + KPI-strip + tabel + (optioneel) gerenderde
   stacked-bar. Auth-gating: `requiresAuth: true`, admin-only of
   partner-eigen-data filter via `partner_slug`-payload.

5. **Sector free-text → enum/lookup**: `b.sector` is nu free-text en kan
   willekeurige strings bevatten. Op termijn migreren naar een
   `sector_lookup`-tabel met FK + UI-dropdown bij beurt-creatie. Tot
   dan vangt de `CASE WHEN`-mapping in de view de bekende waarden af.

6. **Per-tech uren-gewogen allocatie**: huidige equal-share zou unfair
   kunnen zijn als 1 tech 6u werkt en de andere 2u op dezelfde beurt.
   v2: voer een `beurt_uren_per_tech`-tabel in (uren-registratie per
   technieker per beurt) en gebruik die i.p.v. `share_pct = 1/n`. View
   wordt dan `omzet_aandeel = forfait × (uren_tech / sum_uren_per_beurt)`.

## Veiligheid (OWASP-checklist)

| Categorie | Maatregel |
|---|---|
| A01 Broken Access Control | Views hebben `security_invoker=on`; RLS op onderliggende tabellen filtert per rol. Anon GRANT geweigerd. |
| A03 Injection | Geen dynamische SQL in client; alle queries via Supabase JS RPC met view-naam (geen string-concat). |
| A07 Auth Failures | Sidebar item `.admin-only`-class verbergt voor partners; `showPage`-hook check is rol-agnostisch (RLS doet het echte werk). |
| A05 Security Misconfig | Alle aggregaties via views (least-privilege). REVOKE FROM PUBLIC, anon expliciet. |
| XSS | Alle data via `textContent` of `escWinst()`. Nooit `innerHTML` met DB-data. SVG-tekst idem via `textContent`. |
| Data Disclosure | Anon ziet niets; partner ziet alleen eigen rijen via RLS van onderliggende `onderhoudsbeurten`. |

## Deploy

Standaard pipeline:

```bash
./DEPLOY.sh
```

Migration is al via `mcp__apply_migration` aangebracht op het Supabase-project
`dhuqpxwwavqyxaelxuzl`. Cloudflare Pages serveert het bijgewerkte
`admin/index.html` zodra de commit gepusht is.

## Rollback

1. Drop de drie views: `DROP VIEW IF EXISTS public.v_winstgevendheid_per_partner, public.v_winstgevendheid_per_sector, public.v_winstgevendheid_per_technieker CASCADE;`
2. Git-revert de commit met de Slot G-changes in `admin/index.html`.
3. Verwijder dit doc-bestand.

Geen orphaned data, geen orphaned scheduling — views zijn read-only.
