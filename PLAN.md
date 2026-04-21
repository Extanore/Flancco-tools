# Flancco Multi-Sector Calculator Platform — Implementation Plan

## Executive Summary

Transform the Flancco partner platform from a single-sector (solar panel cleaning) calculator into a multi-sector maintenance platform covering 4 sectors: zonnepanelen, warmtepomp/airco, ventilatie, and verwarming. The architecture uses a single template-driven calculator page that loads sector-specific configuration from Supabase, enabling combination contracts and eliminating per-partner code duplication.

---

## Part 1: Architecture Decisions

### 1.1 URL Structure — Decision: Single Template with Query Parameters

**Chosen approach**: `/calculator/index.html?partner=novectra` (single page, dynamic loading)

The calculator page loads at `/calculator/index.html?partner={slug}`. It fetches the partner record, their active sectors, pricing, and supplements from Supabase, then renders the appropriate UI. Sectors are presented as tabs/cards within one flow.

**Rationale**:
- Eliminates code duplication (currently ~1050 lines duplicated per partner)
- Adding a new partner or sector requires zero new files — only database rows
- Query-param approach works on GitHub Pages (no server-side routing needed)
- Partner slug in URL is clean enough for sharing: `https://calculator.flancco-platform.be/?partner=novectra` (legacy fallback: `https://extanore.github.io/Flancco-tools/calculator/?partner=novectra`)
- Legacy URLs (`/novectra/`, `/cwsolar/`) get a small redirect `index.html` during transition

**Short partner alias URLs** (optional, phase 6): `/novectra/index.html` becomes a 3-line redirect:
```html
<!DOCTYPE html><html><head>
<meta http-equiv="refresh" content="0;url=../calculator/?partner=novectra">
</head></html>
```

### 1.2 Calculator Template Architecture — Decision: Data-Driven Sector Modules

Each sector defines its own:
- **Form fields** (what inputs to show in step 1)
- **Pricing logic** (how to calculate the price from those inputs)
- **Contract articles** (sector-specific legal text for step 3)
- **USP content** (marketing blocks)

All of this is driven by a **sector configuration object** in JavaScript within the single template. The database provides the numbers (prices, supplements); the template provides the structure per sector type.

```
SECTOR_CONFIG = {
  zonnepanelen: { fields: [...], calcFn, contractArticles, usps },
  warmtepomp:   { fields: [...], calcFn, contractArticles, usps },
  ventilatie:   { fields: [...], calcFn, contractArticles, usps },
  verwarming:   { fields: [...], calcFn, contractArticles, usps },
}
```

This keeps the architecture vanilla JS (no build tools) while being cleanly extensible.

### 1.3 Combination Contracts — Decision: Multi-Sector Cart Model

The user flow supports selecting multiple sectors in a single session:

1. **Step 0 (new)**: Sector selector — customer picks one or more sectors
2. **Step 1**: Configuration per sector (tabbed or sequential)
3. **Step 2**: Customer data (shared across all sectors — entered once)
4. **Step 3**: Combined contract preview with all sectors, single signature

Each sector produces a `sectorResult` object. The contract combines them into one document with a per-sector pricing breakdown and a grand total.

### 1.4 Database Evolution Strategy — Decision: Additive Schema Changes

**No breaking changes to existing tables.** All changes are additive:
- Add `sector` column to `pricing` and `supplementen` (default `'zonnepanelen'`)
- Create new `contract_regels` (contract line items) table for sector-specific data
- Add `sector_details` JSONB column to `contracten` for flexible sector-specific storage
- Existing solar-only rows get `sector = 'zonnepanelen'` via migration default

---

## Part 2: Database Schema Evolution

### 2.1 Migration: Add Sector Support to Existing Tables

**Migration name**: `add_sector_support`

```sql
-- 1. Add sector column to pricing (default = zonnepanelen for existing rows)
ALTER TABLE pricing
  ADD COLUMN sector text NOT NULL DEFAULT 'zonnepanelen'
  CHECK (sector IN ('zonnepanelen','warmtepomp','ventilatie','verwarming'));
-- warmtepomp subtypes worden opgeslagen als veld in sector_details JSONB:
-- subtype: 'lucht-lucht' | 'lucht-water' | 'geothermie-water'

-- 2. Add sector column to supplementen
ALTER TABLE supplementen
  DROP CONSTRAINT IF EXISTS supplementen_type_check;

ALTER TABLE supplementen
  ADD COLUMN sector text NOT NULL DEFAULT 'zonnepanelen'
  CHECK (sector IN ('zonnepanelen','warmtepomp','ventilatie','verwarming'));
-- warmtepomp subtypes worden opgeslagen als veld in sector_details JSONB:
-- subtype: 'lucht-lucht' | 'lucht-water' | 'geothermie-water'

-- Broaden supplement types to cover all sectors
ALTER TABLE supplementen
  ADD CONSTRAINT supplementen_type_check
  CHECK (type IN (
    -- global
    'transport','annulatie','planning','rapport',
    -- zonnepanelen
    'vervuiling','hoogtewerker',
    -- warmtepomp
    'extra_binnenunit','extra_buitenunit','moeilijk_bereikbaar','vierwegkanaal',
    -- ventilatie
    'extra_ventiel','kanaalreiniging',
    -- verwarming (TBD)
    'ketelonderhoud','rookgasanalyse'
  ));

-- 3. Add sector_details + juridische velden to contracten
ALTER TABLE contracten
  ADD COLUMN sector text DEFAULT 'zonnepanelen',
  ADD COLUMN sector_details jsonb DEFAULT '{}',
  ADD COLUMN contract_nummer text UNIQUE,          -- FL-2026-0001 (doorlopend)
  ADD COLUMN signing_ip text,
  ADD COLUMN signing_user_agent text,
  ADD COLUMN signing_timestamp timestamptz,
  ADD COLUMN signing_methode text CHECK (signing_methode IN ('op_afstand','ter_plaatse')),
  ADD COLUMN handtekening_url text,                -- Storage URL (vervangt base64)
  ADD COLUMN btw_attest_url text,                  -- Storage URL apart 6% attest
  ADD COLUMN privacy_akkoord boolean DEFAULT false,
  ADD COLUMN herroeping_verstreken boolean DEFAULT false;  -- true na 14 dagen of expliciete bevestiging

-- Sequence voor doorlopende contractnummering
CREATE SEQUENCE contract_nummer_seq START 1;

-- 4. Create partner_sectors: which sectors a partner offers
CREATE TABLE partner_sectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  sector text NOT NULL CHECK (sector IN ('zonnepanelen','warmtepomp','ventilatie','verwarming')),
  actief boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE (partner_id, sector)
);

-- 5. Create contract_regels: per-sector line items in a combination contract
CREATE TABLE contract_regels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES contracten(id) ON DELETE CASCADE,
  sector text NOT NULL CHECK (sector IN ('zonnepanelen','warmtepomp','ventilatie','verwarming')),
  omschrijving text NOT NULL,
  bedrag numeric NOT NULL DEFAULT 0,
  btw_pct numeric NOT NULL DEFAULT 21,  -- 6 of 21, per regel (gemengde BTW mogelijk)
  details jsonb DEFAULT '{}',
  volgorde integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- 6. Enable RLS on new tables
ALTER TABLE partner_sectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_regels ENABLE ROW LEVEL SECURITY;

-- RLS policies for partner_sectors
CREATE POLICY "anon_read_partner_sectors" ON partner_sectors
  FOR SELECT TO anon USING (true);
CREATE POLICY "admin_all_partner_sectors" ON partner_sectors
  FOR ALL TO authenticated USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

-- RLS policies for contract_regels
CREATE POLICY "anon_insert_contract_regels" ON contract_regels
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin_all_contract_regels" ON contract_regels
  FOR ALL TO authenticated USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );
CREATE POLICY "partner_read_own_contract_regels" ON contract_regels
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM contracten c
      JOIN user_roles ur ON ur.partner_id = c.partner_id
      WHERE c.id = contract_regels.contract_id AND ur.user_id = auth.uid()
    )
  );
```

### 2.2 Migration: Seed Existing Partners with Sector Data

**Migration name**: `seed_partner_sectors`

```sql
INSERT INTO partner_sectors (partner_id, sector)
SELECT id, 'zonnepanelen' FROM partners;
```

### 2.3 Sector-Specific Pricing Structures

Each sector uses the same `pricing` table but with different semantics for `staffel_min/max`:

| Sector | What staffel_min/max represents | Tiers |
|--------|--------------------------------|-------|
| **zonnepanelen** | Number of panels | 6 tiers (1-14, 15-25, 26-30, 31-35, 36-40, 41+) |
| **warmtepomp** | Number of indoor units | 3 tiers (1, 2, 3+) |
| **ventilatie** | Number of vents | 2 tiers (1-10 base, 11+) |
| **verwarming** | Boiler type code | 1 per type (flat rate) |

The `label` column stores human-readable descriptions. The `flancco_forfait` column stores the Flancco base price. The universal formula applies to all:

```
customer_price = (flancco_forfait * (1 + marge_pct/100) + planning_fee) * (1 + btw_rate)
```

### 2.4 contract_regels vs sector_details

- **`contract_regels`**: Structured line items for the pricing breakdown displayed in the contract. One row per price line (forfait, supplement, korting, etc.).
- **`sector_details` (JSONB on contracten)**: Flexible storage for sector-specific input data that does not map to a price line (e.g., `daktype`, `systeem_type`, `merk_ketel`).

The existing solar-specific columns (`aantal_panelen`, `daktype`, etc.) remain for backward compatibility. New sector data uses `sector_details`.

---

## Part 3: Calculator Template Design

### 3.1 File Structure After Implementation

```
Flancco-tools/
├── calculator/
│   └── index.html          ← NEW: universal multi-sector calculator
├── admin/
│   └── index.html          ← MODIFIED: multi-sector contract support
├── novectra/
│   └── index.html          ← Redirect to /calculator/?partner=novectra
├── cwsolar/
│   └── index.html          ← Redirect to /calculator/?partner=cwsolar
├── DEPLOY.sh
├── CLAUDE.md
└── .gitignore
```

### 3.2 Calculator Page Flow

```
Step 0: Sector Selection (sector-cards met "Waarom?" content)
  ┌──────────────────────┐  ┌──────────────────────┐
  │  🌡️ Warmtepomp        │  │  ☀️ Zonnepanelen       │
  │  Onderhoud & controle │  │  Reiniging & controle │
  │  [Waarom? ▼]          │  │  [Waarom? ▼]          │
  │  [✓ Selecteren]       │  │  [✓ Geselecteerd]     │
  └──────────────────────┘  └──────────────────────┘
  Elke sector-card heeft een icon, naam, beschrijving en uitklapbare
  "Waarom?" content (vergelijkbaar met de bestaande info-blocks voor solar).
  Op mobiel: vertical accordion i.p.v. grid.
  (Only sectors the partner offers appear, from partner_sectors)

Step 1: Configuration per sector (tabbed, desktop) / accordion (mobiel)
  ┌─────────────────────────────────┐
  │ Tab: Zonnepanelen | Warmtepomp  │
  │ [Sector-specific form fields]   │
  │ [Live price calculation]        │
  └─────────────────────────────────┘
  
  Sticky prijsbar (altijd zichtbaar):
  ┌─────────────────────────────────────────────────┐
  │ Uw selectie:                                     │
  │   Zonnepanelen (20 panelen)        € 186,00     │
  │   Warmtepomp (1 unit, basic)       € 125,00     │
  │   ────────────────────────────────────────       │
  │   Totaal per beurt incl. BTW       € 311,00     │
  │                          [← Terug] [Verder →]   │
  └─────────────────────────────────────────────────┘
  Desktop: sticky sidebar rechts. Mobiel: floating bottom bar met totaal + "Verder".

Step 1b: Offerte samenvatting (tussenscherm voor contract)
  ┌─────────────────────────────────────────────────┐
  │  Uw offerte samengevat                           │
  │  ─────────────────────────────────────────       │
  │  20 zonnepanelen — jaarlijkse reiniging          │
  │  1 warmtepomp — basic onderhoud                  │
  │  3 jaar — 5% korting                             │
  │                                                   │
  │  Totaal per beurt: € 295,45 incl. BTW            │
  │                                                   │
  │  [← Aanpassen]     [Akkoord, ga naar contract →] │
  └─────────────────────────────────────────────────┘
  Dit geeft de klant een laatste check-moment vóór het juridisch contract.

Step 2: Customer data (shared, entered once)

Step 3: Contract preview + signature → submit
  Contract-layout: visuele samenvatting bovenaan (wat, wanneer, hoeveel),
  gevolgd door uitklapbaar "Volledige voorwaarden" blok. Handtekening staat
  onder de samenvatting — volledige voorwaarden zijn beschikbaar maar niet intimiderend.

Step 4: Post-ondertekening (bevestigingsscherm)
  ┌─────────────────────────────────────────────────┐
  │  ✅ Uw contract is ondertekend!                  │
  │                                                   │
  │  Wat gebeurt er nu?                               │
  │  1. U ontvangt een bevestigingsmail met PDF       │
  │  2. Wij plannen uw eerste beurt in [seizoen]      │
  │  3. U wordt telefonisch gecontacteerd             │
  │                                                   │
  │  Vragen? Bel [partner tel] of mail [partner mail] │
  │                                                   │
  │  [📄 Download contract PDF]                       │
  └─────────────────────────────────────────────────┘
```

### 3.3 Sector Configuration Objects

Each sector is a JavaScript object defining its form, pricing logic, and contract text:

```javascript
const SECTORS = {
  zonnepanelen: {
    label: 'Zonnepanelen reiniging',
    icon: '<svg>...</svg>',
    fields: [
      { id:'panelen', type:'number', label:'Aantal zonnepanelen', min:1, max:200, default:12 },
      { id:'daktype', type:'select', label:'Type dak', options:[...] },
      { id:'dakhoogte', type:'select', label:'Dakrandhoogte', options:[...] },
      { id:'vervuiling', type:'toggle', label:'Hevige vervuiling of mosvorming' },
    ],
    frequentieOpties: true,
    contractduurOpties: true,
    calcFn(inputs, pricing, supplements, partner) { /* returns line items + total */ },
    contractArticles(inputs, result) { /* returns HTML for contract sections */ },
    usps: [ /* marketing bullet points */ ],
  },
  warmtepomp: { /* ... */ },
  ventilatie: { /* ... */ },
  verwarming: { /* ... */ },
};
```

### 3.4 Dynamic Data Loading

At page load, the calculator fetches all configuration in parallel:

```javascript
async function loadPartnerConfig(slug) {
  const { data: partner } = await sb.from('partners')
    .select('*').eq('slug', slug).single();
  const { data: sectors } = await sb.from('partner_sectors')
    .select('sector').eq('partner_id', partner.id).eq('actief', true);
  const { data: pricing } = await sb.from('pricing')
    .select('*').eq('partner_id', partner.id)
    .in('sector', sectors.map(s => s.sector)).order('staffel_min');
  const { data: supplements } = await sb.from('supplementen')
    .select('*').eq('partner_id', partner.id)
    .in('sector', sectors.map(s => s.sector));
  return { partner, sectors: sectors.map(s => s.sector), pricing, supplements };
}
```

### 3.5 Partner Branding (dynamic CSS variables)

```javascript
function applyBranding(partner) {
  const r = document.documentElement.style;
  r.setProperty('--primary', partner.kleur_primair);
  r.setProperty('--primary-dark', partner.kleur_donker);
  document.title = partner.bedrijfsnaam + ' — Onderhoudscalculator';
}
```

The CSS uses `var(--primary)` everywhere instead of the current hardcoded `var(--green)`.

### 3.6 UX-verbeteringen Calculator

**Labeled step bar** (vervangt de huidige dots):
```
[1. Diensten] ——— [2. Configuratie] ——— [3. Uw gegevens] ——— [4. Overeenkomst]
     ●                    ○                     ○                     ○
```
Gebaseerd op het wizard-step-tabs patroon uit de rapport-generator.

**Micro-interacties**:
- Stap-transities: zachte slide-in (CSS transform, 300ms ease)
- Prijs-updates: totaalbedrag animeert van oud naar nieuw (counter animation via JS)
- Knoppen: korte spinner bij laden → checkmark bij succes
- Statuswijzigingen: kleur fade-transitie (CSS transition)

**Mobiel (< 768px)**:
- Sector-tabs worden verticale accordion (uitklapbaar)
- Prijsbar wordt floating bottom bar (fixed, 60px hoog) met totaal + "Verder" knop
- Contract sig-grid wordt single column
- Formulier field-rows worden single column

---

## Part 4: Admin Dashboard Updates

### 4.1 Required Changes (Admin)

1. **Contract list**: Add `sector` column with color-coded badge
2. **Pricing page**: Sector tabs above partner grid
3. **Partner detail**: Show enabled sectors with toggles
4. **Forecast**: Revenue breakdown by sector
5. **New contract modal**: Sector selector
6. **Dashboard stats**: Sector distribution

### 4.1b Sidebar-navigatie herstructureren
De sidebar groeit van 5-6 naar 8-9 items. Groepeer:
```
OVERZICHT
  Dashboard
  Contracten

PLANNING                    (nieuw)
  Planning
  Rapporten
  Interventies

BEHEER
  Partners
  Techniekers               (nieuw, admin-only)
  Prijsbeheer
  Forecast
  Instellingen              (partner-only)
```

### 4.1c Dashboard herschrijven
Het huidige dashboard (4 stat-cards + recente contracten) geeft geen inzicht.

**Flancco admin dashboard**:
```
┌─ Vandaag ──────────┐  ┌─ Deze week ────────────┐  ┌─ Aandacht vereist ──┐
│ 3 beurten ingepland │  │ 18/25 capaciteit      │  │ 🔴 2 zwaar overtijd │
│ Matin: 2 | Marino: 1│  │ ███████████░░░ 72%    │  │ 🟠 5 achterstallig  │
└────────────────────┘  └──────────────────────┘  └────────────────────┘

[Recente contracten]  [Open interventies]  [Binnenkort in te plannen]
```

**Partner dashboard**:
```
┌─ Mijn klanten ─────┐  ┌─ Omzet Q2 2026 ──────┐  ┌─ Actie nodig ──────┐
│ 45 actief           │  │ € 12.450 bruto       │  │ 3 open interventies│
│ 12 in planning      │  │ € 1.245 mijn marge   │  │ [Bekijk →]         │
└────────────────────┘  └──────────────────────┘  └────────────────────┘
```

### 4.1d Universele zoekbalk
Bovenaan de main area, naast de page title:
```
┌──────────────────────────────────────────────────────────────┐
│ 🔍 Zoek klant, contract, partner...                         │
└──────────────────────────────────────────────────────────────┘
```
- Zoekt over: klant_naam, klant_gemeente, partner_naam, contract_nummer
- Type-ahead dropdown met resultaten gegroepeerd per type (Klant | Contract | Partner)
- Klikken op resultaat opent de klant-dossierpagina

### 4.1e Klant-dossierpagina
Klikbare contractrijen openen een detail-view (slide-in panel of full page):
```
┌─────────────────────────────────────────────────────────┐
│ Jan Janssen — FL-2026-0042                              │
│ Kerkstraat 12, 9000 Gent  |  📞 +32 4... | ✉️ jan@...   │
├─────────────────────────────────────────────────────────┤
│ CONTRACTDETAILS                                         │
│ Partner: Novectra | Sectoren: Solar + Warmtepomp        │
│ Frequentie: jaarlijks | Duur: 3 jaar | Korting: 5%      │
│ Totaal/beurt: € 295,45 incl. BTW                       │
├─────────────────────────────────────────────────────────┤
│ ONDERHOUDSBEURTEN                                       │
│ ✅ 15 mrt 2026 — Solar — Matin — [📄 Rapport]           │
│ 🟢 22 apr 2027 — Warmtepomp — ingepland                 │
│ ⚪ ~okt 2027 — Solar — toekomstig                       │
├─────────────────────────────────────────────────────────┤
│ INTERVENTIES                                            │
│ 🟠 Lekkage binnenunit — Novectra — open sinds 3d        │
└─────────────────────────────────────────────────────────┘
```
Dit wordt het hart van het systeem — alle info over één klant op één plek.

### 4.1f Empty states met CTA
Lege tabellen/pagina's tonen een helpende boodschap i.p.v. lege ruimte:

**Partner zonder contracten:**
```
Nog geen contracten

Deel je calculator-link met klanten om je eerste contract binnen te halen:
[https://...?partner=novectra]  [📋 Kopieer link]

Of bekijk de handleiding: [Hoe werkt het? →]
```

**Geen interventies:**
```
✅ Geen openstaande interventies — alles is up-to-date!
```

### 4.1h Sector-beheer per partner (Flancco admin)
In de Partners-pagina (admin-only) krijgt elke partner een sectie met sector-toggles:
```
┌─ Novectra ─────────────────────────────────────────────┐
│ Actieve sectoren:                                       │
│ [✅ on ] Zonnepanelen    [✅ on ] Warmtepomp            │
│ [  off] Ventilatie       [  off] Verwarming            │
│                                            [Opslaan]   │
└────────────────────────────────────────────────────────┘
```
- Toggles schrijven naar `partner_sectors` tabel (actief true/false)
- Bij deactiveren: bestaande contracten blijven geldig, maar er kunnen geen nieuwe contracten meer afgesloten worden voor die sector
- De calculator leest `partner_sectors` en toont alleen actieve sectoren
- Beveiligd: alleen Flancco admin kan sectoren aan/uitzetten (RLS + UI)

### 4.1g Tablet-modus (768-1024px)
- Sidebar wordt hamburger menu (uitklapbaar)
- Tabellen worden card-lijsten (één card per contract/beurt)
- Kanban kolommen worden horizontaal scrollbaar

### 4.2 Partner Instellingen — Herschreven UX

De huidige instellingenpagina is te technisch en onvolledig. Herschreven voor het multi-sector platform:

**Blok 1: Welkomst & onboarding** (alleen bij eerste login of lege gegevens)
```
Welkom bij het Flancco Partner Platform, [bedrijfsnaam]!
Vul hieronder je bedrijfsgegevens in om aan de slag te gaan.
Je calculator-link wordt automatisch actief zodra je gegevens compleet zijn.
```

**Blok 2: Branding & weergave**
- **Logo-upload**: drag-drop of klik om logo te uploaden (→ Supabase Storage). Preview naast upload-knop.
- **Kleurthema**: 5-6 preset thema's (groen, blauw, rood, oranje, navy, teal) als klikbare swatches.
  Onder de presets: uitklapbaar "Geavanceerd" paneel met color picker + hex voor custom kleuren.
- **Live preview-blok**: toont een mini-versie van de calculator-header met gekozen logo + kleuren. Updates real-time bij wijziging.

**Blok 3: Bedrijfsgegevens**
- Bedrijfsnaam, contactpersoon, email, telefoon
- Adres, postcode, gemeente (nieuw — nodig voor contracten)
- BTW-nummer (read-only na eerste invoer, wijzigen via Flancco)

**Blok 4: Actieve sectoren** (read-only voor partner, beheerd door Flancco admin)
```
✅ Zonnepanelen reiniging     — actief
✅ Warmtepomp onderhoud       — actief
⬜ Ventilatie onderhoud        — niet actief
⬜ Verwarming / CV            — niet actief
ℹ️ Neem contact op met Flancco om sectoren te activeren of te wijzigen.
```
De partner ziet welke sectoren actief zijn maar kan dit niet zelf wijzigen.
De Flancco admin beheert dit via de Partners-pagina (sector-toggles per partner, zie 4.1h).

**Blok 5: Calculator-links**
Per actieve sector een kopieerbare link:
```
Alle sectoren:  https://calculator.flancco-platform.be/?partner=novectra  [📋 Kopieer]
Zonnepanelen:   https://...?partner=novectra&sector=zonnepanelen              [📋 Kopieer]
Warmtepomp:     https://...?partner=novectra&sector=warmtepomp                [📋 Kopieer]
```

**Blok 6: Calculator-instellingen**
- Gratis transport km (aanpasbaar)
- Eigen intro-tekst boven contract (optioneel tekstveld, max 500 tekens)
- Marge, planning fee: read-only met info-tooltip:
  "Dit wordt bepaald in je samenwerkingsovereenkomst met Flancco. Neem contact op om wijzigingen te bespreken."

**Blok 7: Opslag-feedback**
- Bij opslaan: **groene banner bovenaan** die 5 seconden zichtbaar blijft: "Instellingen opgeslagen ✓"
- Bij fout: **rode banner** met foutmelding + retry-knop
- Loading spinner op de opslaan-knop tijdens verwerking

### 4.3 Database-aanpassingen voor partner-instellingen
```sql
-- Nieuwe kolom op partners tabel
ALTER TABLE partners
  ADD COLUMN logo_url text,           -- Supabase Storage URL
  ADD COLUMN intro_tekst text;        -- Optionele tekst boven contract (max 500 chars)
```

### 4.4 Pricing Management with Sector Tabs

```
Sector: [Zonnepanelen] [Warmtepomp] [Ventilatie] [Verwarming]

┌─ Novectra ─────────────┐  ┌─ CW Solar ─────────────┐
│ Staffel  Flancco → Klant│  │ Staffel  Flancco → Klant│
│ 1-14    €90    → €126  │  │ 1-14    €90    → €126  │
│ ...                     │  │ ...                     │
│ [Opslaan]               │  │ [Opslaan]               │
└─────────────────────────┘  └─────────────────────────┘
```

---

## Part 5: Onderhoudsbeurten, Rapporten & Interventies

### Terminologie
- **Onderhoudsbeurt**: een geplande, terugkerende uitvoering van een contract
- **Rapport**: het digitale verslag van een uitgevoerde beurt (checklist, foto's, PDF) — gebaseerd op bestaande Flancco rapport-generator
- **Interventie**: een ongeplande, reactieve actie n.a.v. een vaststelling tijdens onderhoud

### Onderhoudsbeurt lifecycle met urgentie-kleuren
```
toekomstig      ⚪ grijs         — ver in de toekomst, geen actie
in_te_plannen   🔵 blauw         — binnen planningshorizon, moet ingepland worden
ingepland       🟢 groen         — datum geprikt, staat vast
uitgevoerd      ✅ donkergroen   — afgerond, rapport gekoppeld
achterstallig   🟠 oranje        — due date < 7 dagen geleden
zwaar_overtijd  🔴 rood          — due date > 14 dagen geleden
geannuleerd     ⚫ grijs gestreept
```

BELANGRIJK: status "uitgevoerd" kan ALLEEN bereikt worden nadat de rapport-wizard volledig is afgerond. Dit garandeert dat elk onderhoud gedocumenteerd is.

### Flow na contractondertekening
1. Contract getekend → onderhoudsbeurten automatisch gegenereerd (frequentie × duur, alle beurten vooruit)
2. **Bevestigingsmail** automatisch naar klant met:
   - PDF van het getekende contract als bijlage
   - Samenvatting: gekozen diensten, frequentie, bedrag
   - Verwachte periode eerste onderhoudsbeurt
   - Contactgegevens partner
   (Verzonden via Supabase Edge Function + SMTP/Resend)
3. X weken voor due_date → beurt wordt "in_te_plannen" (visueel blauw)
4. Flancco plant in → beurt wordt "ingepland" (groen) met datum
5. Technieker voert uit → na afloop vult kantoor de rapport-wizard in (pre-filled met contractdata)
6. Rapport opgeslagen → PDF gegenereerd, gekoppeld aan beurt → status wordt "uitgevoerd"
7. Eventuele interventie(s) geregistreerd:
   - Opgelost ter plaatse → registratie (dossiervorming)
   - Opvolging nodig → melding naar partner (via email-notificatie)
8. Volgende beurt → automatisch berekend op basis van seizoensvenster, cyclus herstart
9. Overtijd? → oranje (7d) → rood (14d), visueel alarm in dashboard

### Seizoenslogica per sector
Onderhoudsbeurten worden niet blind op "vorige + frequentie" gepland, maar binnen het optimale seizoensvenster:

```javascript
SEIZOEN_CONFIG = {
  zonnepanelen: { maanden: [3,4,5,6,7,8,9,10], label: 'maart–oktober' },
  warmtepomp:   { maanden: [3,4,9,10], label: 'maart–april / sept–okt' },
  ventilatie:   { maanden: null, label: 'heel het jaar' },  // geen beperking
  verwarming:   { maanden: [8,9,10], label: 'aug–okt (voor stookseizoen)' },
}
```

**Logica**: als de berekende due_date buiten het seizoensvenster valt, wordt deze verschoven naar de eerstvolgende maand IN het venster. Voorbeeld: zonnepanelen-contract getekend in november → eerste beurt gepland in maart.

### Planningshorizon per sector
Hoeveel weken voor de due_date een beurt "in_te_plannen" wordt:

```javascript
PLANNING_HORIZON = {
  zonnepanelen: 8,  // weken — druk seizoen, vroeg beginnen
  warmtepomp:   6,
  ventilatie:   4,
  verwarming:   6,
}
```

Instelbaar in de admin-instellingen.

### Capaciteitsplanning
Simpele capaciteitslimiet om overplanning te voorkomen:
- Instelling: **max beurten per week** (standaard: 25, aanpasbaar door Flancco admin)
- Planning-view toont per week: "18/25 ingepland" met visuele balk
- Bij overschrijding: waarschuwing bij het inplannen ("Deze week zit al vol")

### Regio-filtering in planning
De planning-view krijgt een **postcode/regio-filter** zodat Flancco beurten kan clusteren:
- Filter op eerste 2 cijfers postcode (BE) of eerste 4 cijfers (NL)
- Kaartweergave is v2, maar filtering is v1

### Rapport-wizard (geïntegreerd vanuit bestaande Flancco rapport-generator)
De bestaande rapport-generator (Flancco-rapport-generator.html) wordt geïntegreerd:
- Stap 1: Sector & details (auto-ingevuld vanuit contract)
- Stap 2: Klantgegevens (auto-ingevuld vanuit contract)
- Stap 3: Checklist afvinken + opmerkingen (sector-specifiek)
- Stap 4: Foto's uploaden voor/na per categorie
- Stap 5: Preview + opslaan
- Stap 6 (optioneel): Interventie(s) registreren

### Opslag & PDF-generatie — Supabase-native (vervangt lokale opslag)
De huidige rapport-generator gebruikt File System Access + IndexedDB (per-device, per-browser).
Dit wordt volledig vervangen door Supabase:

**Opslag:**
- Rapport-metadata + checklist → `rapporten` tabel (JSONB)
- Foto's → Supabase Storage bucket `rapporten` (per rapport georganiseerd)
- PDF's → Supabase Storage bucket `rapporten-pdf`
- Alles gekoppeld aan onderhoudsbeurt → zichtbaar voor Flancco én partner

**PDF-generatie:**
- Server-side via Supabase Edge Function (vervangt html2canvas + jsPDF)
- Rapport-data wordt als JSON naar Edge Function gestuurd
- Edge Function genereert PDF en slaat op in Storage
- Voordelen: consistente output, geen zware client-side libraries, werkt op elk device

**Flow:**
```
Rapport-wizard ingevuld op kantoor
  → Data opgeslagen in rapporten tabel
  → Foto's geüpload naar Supabase Storage
  → Edge Function genereert PDF → opgeslagen in Storage
  → PDF-link gekoppeld aan rapport record
  → Partner kan PDF downloaden vanuit dashboard
```

Bestaande checklists per sector:
- **Airco BASIC**: Reiniging (3), Metingen (2), Rapportage (2)
- **Airco ALL-IN**: Reiniging (7), Metingen (2), Inspectie (4), Rapportage (2)
- **Solar**: Reiniging (1), Controle (3)
- **Ventilatie C**: Reiniging (3), Controle (1), Afwerking (1)
- **Ventilatie D**: Reiniging (4), Controle (3), Metingen (1), Afwerking (1)

Foto-categorieën per sector:
- **Airco**: binnenunit(s) voor/na, buitenunit(s) voor/na, metingen, overige
- **Solar**: overzicht dak voor/na, detail panelen voor/na, bevindingen
- **Ventilatie**: toestel voor/na, ventielen voor/na, warmtewisselaar (D), filters (D), overige

### Wat de partner ziet
Onderhoudshistoriek per klant:
| Datum | Sector | Technieker | Rapport | Status | Interventies |
|-------|--------|-----------|---------|--------|-------------|
| 15 mrt 2026 | Airco ALL-IN | Matin | 📄 PDF | ✅ | 1 (afgehandeld) |
| 22 apr 2027 | Airco | — | — | 🟢 ingepland | — |
| ~okt 2027 | Airco | — | — | ⚪ toekomstig | — |

Partner kan:
- Rapporten bekijken/downloaden als PDF
- Open interventies opvolgen (status updaten, klant contacteren)
- **Geplande datums inzien** (read-only) — zodat partner klant kan informeren bij navraag
- **Klant direct contacteren**: klikbaar telefoonnummer (`tel:`) en mailto-link bij elke klant
- **Verdienste-overzicht**: dashboard toont per kwartaal/jaar: aantal contracten, bruto omzet, eigen marge

Partner kan NIET: onderhoudsbeurten zelf plannen of wijzigen (dat doet Flancco).

### Verdienste-overzicht partner
Het partner-dashboard krijgt een financieel blok:
```
Dit kwartaal (Q2 2026)
├── Actieve contracten: 45
├── Bruto omzet: € 12.450
├── Mijn marge: € 1.245 (10%)
└── Openstaande interventies: 3
```
Berekening: `marge = totaal_incl_btw - (flancco_forfait × freq × 1.21)` per contract.

### Database-tabellen (nieuw)

```sql
-- Techniekers
techniekers (
  id uuid PK,
  naam text NOT NULL,
  voornaam text,
  telefoon text,
  email text,
  foto_url text,
  actief boolean DEFAULT true,
  max_beurten_per_dag integer DEFAULT 5,
  notities text,
  created_at timestamptz
)

-- Technieker sector-certificeringen
technieker_sectoren (
  id uuid PK,
  technieker_id FK → techniekers,
  sector text,
  certificaat_nummer text,
  certificaat_verloopt date,
  UNIQUE (technieker_id, sector)
)

-- Technieker afwezigheden (verlof, ziekte)
technieker_afwezigheden (
  id uuid PK,
  technieker_id FK → techniekers,
  van_datum date,
  tot_datum date,
  reden text,
  created_at timestamptz
)

-- Onderhoudsbeurten: de geplande uitvoeringen
onderhoudsbeurten (
  id uuid PK,
  contract_id FK → contracten,
  sector text,
  volgnummer integer,
  due_date date,
  plan_datum date,
  uitvoer_datum date,
  status text CHECK (IN 'toekomstig','in_te_plannen','ingepland','uitgevoerd','geannuleerd'),
  technieker_id FK → techniekers (nullable),
  notities text,
  created_at timestamptz
)

-- Rapporten: het digitale verslag per uitgevoerde beurt
rapporten (
  id uuid PK,
  onderhoudsbeurt_id FK → onderhoudsbeurten (UNIQUE),
  contract_id FK → contracten,
  referentie text (FL-RAPP-YYYY-NNNN),
  sector text,
  formule text (basic|allin|null),
  systeem text (C|D|null),
  checklist_data JSONB,
  foto_urls JSONB (per categorie → Supabase Storage URLs),
  opmerkingen text,
  technieker_id FK → techniekers,
  datum_onderhoud date,
  pdf_url text (Supabase Storage),
  klant_snapshot JSONB,
  created_at timestamptz
)

-- Interventies: ongeplande vaststellingen
interventies (
  id uuid PK,
  onderhoudsbeurt_id FK → onderhoudsbeurten,
  rapport_id FK → rapporten (nullable),
  contract_id FK → contracten,
  gemeld_door text,
  omschrijving text,
  foto_urls JSONB,
  ernst text CHECK (IN 'laag','normaal','urgent'),
  actie_door text ('flancco'|'partner'),
  opgelost_ter_plaatse boolean DEFAULT false,
  status text CHECK (IN 'open','ingepland','afgehandeld'),
  plan_datum date,
  afhandel_datum date,
  afhandel_notitie text,
  created_at timestamptz
)
```

---

## Part 6: Phased Implementation Plan

### Phase 1: Database Foundation
**Risk**: None (additive changes only)

1. Run migration `add_sector_support` (pricing, supplementen, partner_sectors, contract_regels)
2. Run migration `seed_partner_sectors`
3. Run migration `add_onderhoud_tables` (onderhoudsbeurten, rapporten, interventies, audit_log, techniekers, technieker_sectoren, technieker_afwezigheden, duur_instellingen, voertuigen, voertuig_kosten, voertuig_km_log)
4. Run migration `add_rls_new_tables` (RLS policies voor alle nieuwe tabellen)
5. Setup Supabase Storage buckets: `handtekeningen`, `rapporten`, `rapporten-pdf`, `partner-logos`, `voertuig-documenten`
6. Verify existing calculators and admin dashboard still work
7. **Checkpoint**: Confirm schema + RLS in Supabase, run security advisors

### Phase 2: Universal Calculator — Solar Only

1. Create `calculator/index.html` with template architecture + loading skeleton
2. Labeled step bar (vervangt dots): [1. Diensten] — [2. Configuratie] — [3. Gegevens] — [4. Overeenkomst]
3. Implement `zonnepanelen` sector config (port existing pricing logic)
4. Load pricing/supplements dynamically from Supabase (fixes hardcoded TIERS)
4. Implement partner branding via CSS custom properties
5. 6% BTW optie met verklaring op eer + apart BTW-attest PDF (alleen voor BE postcodes)
6. Gemengde BTW ondersteuning per contract_regel
7. Herroepingsclausule in contract + wettelijk herroepingsformulier in bevestigingsmail
8. Privacyverklaring link + acceptatie-checkbox (dynamisch per partner/Flancco Direct)
9. Handtekening upload naar Supabase Storage (niet base64 in database)
10. Ondertekeningscontext opslaan (IP, user agent, timestamp, methode)
11. Doorlopende contractnummering (FL-2026-0001 via Postgres sequence)
12. Input sanitization op alle tekstvelden
13. Sticky prijsbar (desktop: sidebar rechts, mobiel: floating bottom bar)
14. Offerte-samenvattingsscherm (tussenscherm vóór contract)
15. Contract-layout: visuele samenvatting bovenaan + uitklapbare volledige voorwaarden
16. Implement full flow: config → customer data → contract + signature → submit
17. Post-ondertekening bevestigingsscherm ("Wat gebeurt er nu?")
18. Auto-generate onderhoudsbeurten bij contractondertekening (met seizoenslogica)
19. Bevestigingsmail naar klant met PDF + herroepingsformulier (Edge Function + Resend/SMTP)
20. Stap-transitie animaties (slide-in, 300ms) + prijs counter-animatie
21. Mobiel: floating bottom bar + single-column field-rows + single-column sig-grid
22. Test with Novectra and CW Solar slugs
23. **Checkpoint**: Side-by-side price comparison + email test + juridische review + mobiel test

### Phase 3: Multi-Sector UI + Warmtepomp

1. Add Step 0 (sector selector) to calculator
2. Implement sector tabs in Step 1
3. Define warmtepomp pricing rules with user
4. Seed warmtepomp pricing rows for test partner(s)
5. Build warmtepomp calcFn and contractArticles
6. Implement combined contract preview (multi-sector in one document)
7. Implement contract_regels storage on submit
8. **Checkpoint**: User reviews warmtepomp flow end-to-end

### Phase 4: Ventilatie & Verwarming Sectoren

1. Define ventilatie pricing rules with user
2. Seed ventilatie pricing rows
3. Build ventilatie sector config
4. Define verwarming pricing rules with user
5. Build verwarming sector config
6. Test combination contracts (meerdere sectoren)
7. **Checkpoint**: User reviews alle sectoren

### Phase 5: Planning Dashboard + Rapport-wizard

**Techniekers & Wagenpark (alleen Flancco admin, NIET zichtbaar voor partners):**
1. Techniekers-pagina: CRUD, sector-certificeringen met verloopdata, afwezigheidsbeheer, foto-upload, gekoppeld voertuig
2. Wagenpark-pagina: CRUD voertuigen, keuring/verzekering verloopdata met kleurcodes, kosten, km-log, koppeling technieker, document-uploads
3. Partner ziet alleen technieker-naam op het rapport (niet de pagina/beschikbaarheid/wagenpark)

**Planningsagenda — tijdgebonden weekview met technieker-lanes:**
3. Agenda als apart bestand `/admin/planning.html` (~1000+ regels)
4. **Weekview** (standaard): technieker-rijen × dag-kolommen, tijdslots 08:00-18:00
   - Kaart-hoogte = tijdsduur (1u beurt = 1 blok, 2u = dubbel)
   - Sector-kleur per kaart (oranje=solar, rood=warmtepomp, navy=ventilatie, grijs=verwarming)
   - Kaart toont: sector-icoon, klantnaam, installatiegrootte, duur, postcode+gemeente
   - Afwezig-markering als grijze balk over hele dag
5. **Dagview**: meer detail per dag, alle techniekers naast elkaar
6. **Maandview**: kalender met aantallen per dag (overzicht)
7. **Duur-berekening per beurt**:
   - Standaard: 1 uur
   - Automatisch berekend op basis van installatiegrootte (instelbaar door admin):
     Zonnepanelen: 1-20 pan → 1u, 21-35 → 1u30, 36+ → 2u
     Warmtepomp: 1 unit → 1u, 2 units → 1u30, 3+ → 2u
     Ventilatie: Systeem C → 1u, Systeem D → 1u30
     Verwarming: standaard → 1u
   - Handmatig aanpasbaar per beurt
   - Duur-instellingen opgeslagen in database (admin-configureerbaar)
8. **Drag & drop inplannen**: sleep beurten vanuit "In te plannen" sidebar naar een tijdslot
   - Systeem controleert sector-certificering, overlap, afwezigheid
   - Bij overlap: rode markering + waarschuwing
9. **"In te plannen" sidebar** rechts: gesorteerd op urgentie (rood → oranje → blauw)
   - Filterbalk bovenaan: regio, sector
   - Elke kaart toont: klantnaam, sector, postcode, urgentie-kleur, geschatte duur
10. **Postcode-clustering / route-suggestie**:
    - Bij meerdere beurten op één dag voor één technieker: automatische sorteeroptie op postcode
    - "Route-suggestie" knop die beurten herordent op postcode-nabijheid
    - Volgorde handmatig aanpasbaar (drag & drop binnen de dag)
11. Urgentie-kleuren: grijs → blauw → groen → oranje → rood
12. Filterbalk: regio, sector, technieker, week

**Rapport-wizard:**
13. Rapport-wizard als `/admin/rapport.html?beurt_id=xxx` (apart bestand)
14. Pre-fill klant- en contractdata + toegewezen technieker (incl. certificaatnummer op rapport)
15. Foto-upload naar Supabase Storage
16. PDF-generatie client-side + upload naar Supabase Storage
17. Blokkeer "uitgevoerd" status tot rapport volledig is ingevuld
18. Audit logging bij elke statuswijziging
19. Interventie-registratie stap toevoegen aan rapport-wizard
20. Email-notificatie naar partner bij interventie met opvolging

**Partner-view:**
21. Onderhoudshistoriek + rapporten inzien/downloaden + klikbare contactgegevens
22. Partner ziet geplande datum + technieker-naam (read-only), NIET de agenda

**Database-aanpassingen voor tijdsplanning:**
```sql
ALTER TABLE onderhoudsbeurten
  ADD COLUMN start_tijd time,           -- bijv. 09:00
  ADD COLUMN duur_minuten integer DEFAULT 60;  -- bijv. 90 (1u30)

-- Duur-instellingen per sector/grootte
CREATE TABLE duur_instellingen (
  id uuid PK,
  sector text,
  grootte_min integer,     -- bijv. 1 (panelen/units)
  grootte_max integer,     -- bijv. 20
  duur_minuten integer DEFAULT 60,
  created_at timestamptz
);
```

23. **Checkpoint**: Volledige flow test: contract → planning → drag-drop → uitvoering → rapport → interventie → notificatie

### Phase 6: Admin Dashboard Updates + Polish

**UX herschrijven:**
1. Sidebar herstructureren (3 groepen: Overzicht, Planning, Beheer)
2. Dashboard herschrijven (Flancco: vandaag/capaciteit/aandacht; Partner: klanten/omzet/acties)
3. Universele zoekbalk (type-ahead over klanten, contracten, partners)
4. Klant-dossierpagina (klikbare contractrijen → detail met beurten, rapporten, interventies)
5. Empty states met CTA's (geen lege tabellen)
6. Tablet-modus: hamburger menu + card-lijsten

**Functioneel:**
7. Contract list met sector-kolom + kleur-badges
8. Pricing page met sector-tabs
9. Partner detail met sector-toggles
10. Forecast met sector-breakdown
11. Partner instellingenpagina herschrijven (logo-upload, kleurthema presets, live preview, sector-links, onboarding)
12. Partner verdienste-overzicht (omzet, marge per kwartaal)
13. In-app notificatie badge bij partner-login (open interventies + nieuwe contracten)
14. Open interventies overzicht (Flancco ziet alles, partner ziet eigen)

**Compliance & security:**
15. GDPR: admin-functie om klantdata volledig te verwijderen (cascade: contracten, beurten, rapporten, foto's, handtekeningen)
16. Retentie-overzicht: welke records binnenkort geanonimiseerd worden
17. Interventie-escalatielogica (herinnering dag 3, escalatie dag 7)
18. Verloopwaarschuwingen dashboard: technieker-certificaten + voertuig-keuringen + voertuig-verzekeringen (kleurcodes + alerts)
19. Technieker prestatie-overzicht (beurten/maand, rapport-volledigheid, interventies vastgesteld)

**Cleanup:**
18. Replace `/novectra/` en `/cwsolar/` met redirects
19. Update `CLAUDE.md`
20. Mobile responsive testing (calculator floating bottom bar, admin card-lijsten)
21. Security review: RLS advisors + rate limiting check + XSS audit
22. **Checkpoint**: Volledige regressietest

---

## Part 6: Sector Pricing Rules Reference

### Zonnepanelen (existing, well defined)
- Base: tiered by panel count (6 tiers)
- Extra panels (41+): per-panel rate
- Supplements: vervuiling/panel, transport/km, hoogtewerker flat fee
- Options: frequency (1x/2x year), contract duration (0/3/5 year with 5% discount)

### Warmtepomp (3 subtypes)
- **Subtypes**: lucht-lucht (airco/split), lucht-water (monobloc/split), geothermie-water
- Formula: basic vs all-in (different base prices)
- Base: includes 1 indoor + 1 outdoor unit
- Extra indoor units: per-unit (rate changes from 3rd unit)
- Extra outdoor units: per-unit
- Supplements: moeilijk bereikbaar (flat), vierwegkanaal (per unit)

### Ventilatie (from user's specification)
- Base: per system type (C vs D) — includes up to 10 vents
- Extra vents (>10): per-vent surcharge
- Optional: kanaalreiniging per strekkende meter

### Verwarming / CV (to be defined with user)
- Suggested: base per ketel type (gas/mazout/condensatie)
- Rookgasanalyse: mandatory in Flanders — included or add-on

### Global Supplements (all sectors)
- Transport: per km above partner's free threshold
- Annulatie: flat fee (<48h cancellation)
- Planning fee: per partner setting (already in partner record)

### BTW-regeling
- **Standaard**: 21% BTW
- **6% BTW optie**: beschikbaar voor alle sectoren, BEHALVE bij partners of eindklanten in Nederland (altijd 21%)
- De calculator detecteert land op basis van postcode (BE vs NL) en toont de 6% optie alleen voor België
- Renovatie-regel: woning >10 jaar → 6% tarief mogelijk
- **Verklaring op eer + apart BTW-attest**: zie Part 8 (8.0c) voor volledige fiscale vereisten
- **Gemengde BTW bij combinatiecontracten**: elke contract_regel heeft eigen btw_pct (zie Part 8, 8.0d)

### Flancco Direct Pricing
- Flancco Direct krijgt alle 4 sectoren
- Marge van 10% wordt doorgerekend naar de eindklant (niet 0% zoals eerder)
- Dit zorgt ervoor dat de eindklantprijs identiek is ongeacht of het via een partner of Flancco Direct gaat
- De 10% marge bij Flancco Direct is extra winst voor Flancco zelf

---

## Part 7: Technical Considerations

### 7.1 Supplement Handling
Duplicate transport/annulatie rows per sector rather than using a "global" flag. Simpler query logic, allows per-sector transport rates if ever needed.

### 7.2 Combination Contracts
Single `contracten` row = master contract. `contract_regels` rows = per-sector breakdown. Contract number is based on `contracten.id`.

### 7.3 Two Usage Scenarios
Both use the same URL. No auth needed for calculator (anon Supabase access). Partner ID comes from URL slug.
- **Partner at customer site**: fills in on tablet, customer signs on screen
- **Customer via shared link**: fills in independently, signs digitally

### 7.4 Backward Compatibility
- Existing `contracten` rows untouched (`sector = 'zonnepanelen'` default)
- Solar-specific columns remain on `contracten` for legacy reads
- New contracts use `sector_details` JSONB + `contract_regels`
- Admin reads both formats

### 7.5 Error Handling & UX
- Invalid partner slug → friendly error with Flancco branding
- Partner with no active sectors → "no services available" message
- Network errors → retry with fallback message
- Missing pricing → "contact partner" instead of broken calculation
- **Loading states**: skeleton UI tijdens laden van Supabase data (geen lege pagina)
- **Offline resilience**: foutmelding bij onbereikbare Supabase met retry-knop

### 7.6 File Architecture
- **Calculator**: `/calculator/index.html` (~1200 regels) — universele multi-sector calculator
- **Rapport-wizard**: `/admin/rapport.html?beurt_id=xxx` — apart bestand (~1300 regels), niet in admin/index.html geïntegreerd
- **Admin dashboard**: `/admin/index.html` (~1100 regels) — linkt naar rapport.html voor invullen
- Alle bestanden blijven vanilla HTML/CSS/JS, geen build tools

### 7.7 PDF-generatie strategie
- **V1: client-side generatie + server-side opslag**: PDF wordt client-side gegenereerd (html2canvas + jsPDF), vervolgens geüpload naar Supabase Storage. Pragmatisch, werkt direct.
- **V2 (later)**: server-side PDF via externe service of Supabase Edge Function met PDF-library.
- Reden: Deno (Edge Functions) heeft geen headless browser, server-side PDF is complex. Client-side + upload is de snelste weg naar werkend product.

### 7.8 Onderhoudsbeurten auto-generatie
Bij contractondertekening worden **alle beurten vooruit gegenereerd** voor de volledige contractduur:
- 5 jaar jaarlijks = 5 beurten
- 3 jaar halfjaarlijks = 6 beurten
- Eenmalig = 1 beurt
- Due dates worden berekend met seizoenslogica (Part 5)
- Alle beurten starten als "toekomstig", worden automatisch "in_te_plannen" op basis van planningshorizon

### 7.9 Notificatie-systeem
Meldingen worden verzonden via email (Supabase Edge Function + SMTP/Resend):
- **Klant**: bevestigingsmail bij contractondertekening (met PDF)
- **Partner**: email bij nieuwe interventie die opvolging vereist
- **Flancco admin**: dagelijkse digest van achterstallige beurten (optioneel, v2)
In-app notificaties (badge/bell icon) bij partner-login: aantal open interventies + nieuwe contracten

---

## Part 8: Juridisch & Compliance

### 8.0 Ondertekeningscontext (eIDAS bewijskracht)
Elke contractondertekening slaat naast de handtekening ook een juridische context op:
```sql
-- Velden op contracten tabel (of apart signing_context JSONB):
signing_ip text,              -- IP-adres ondertekenaar
signing_user_agent text,      -- Browser/device info
signing_timestamp timestamptz, -- Exact moment (UTC)
signing_methode text,         -- 'op_afstand' of 'ter_plaatse'
```
Dit versterkt de bewijskracht van de gewone elektronische handtekening bij betwisting.

### 8.0b Doorlopende contractnummering
Elke contract krijgt een leesbaar, doorlopend nummer naast de uuid:
- Formaat: `FL-{JAAR}-{VOLGNUMMER}` bijv. `FL-2026-0001`
- Gegenereerd via een Postgres sequence: `CREATE SEQUENCE contract_nummer_seq`
- Wordt getoond op het contract, in de bevestigingsmail en in het admin dashboard
- Nodig voor boekhouding en geschillenbeslechting

### 8.0c BTW-attest 6% (Belgische fiscale vereiste)
Bij keuze voor 6% BTW wordt automatisch een apart **BTW-attest** gegenereerd met:
- Naam en adres van de opdrachtgever
- Exacte ligging van het gebouw (kan afwijken van facturatieadres)
- Verklaring dat het gebouw >10 jaar in gebruik is als privéwoning
- Datum en handtekening van de opdrachtgever
- Opgeslagen als apart PDF in Supabase Storage, gekoppeld aan het contract
- Moet bij btw-controle specifiek voorgelegd kunnen worden (niet verstopt in het contract)

### 8.0d Gemengde BTW bij combinatiecontracten
Een combinatiecontract kan meerdere btw-tarieven bevatten:
- Zonnepanelen op nieuwbouw: 21%
- Ventilatie in woning >10 jaar: 6%
- Elke `contract_regels` rij krijgt een eigen `btw_pct` veld (6 of 21)
- Het contract toont een split totaal: subtotaal 6% + subtotaal 21% + totaal incl. BTW
- BTW-attest wordt alleen gegenereerd voor de regels met 6%

### 8.0e Privacyverklaring & cookie-melding
De calculator moet vóór ondertekening een link tonen naar een **privacyverklaring**:
- Wie verzamelt de data (partner + Flancco)
- Welke gegevens (naam, adres, email, telefoon, handtekening, foto's)
- Doel van verwerking (uitvoering contract, planning onderhoud)
- Bewaartermijn
- Rechten van de betrokkene (inzage, rectificatie, verwijdering, portabiliteit)
- Contactgegevens DPO / verantwoordelijke
- Acceptatie-checkbox: "Ik heb de privacyverklaring gelezen en ga akkoord" (verplicht vóór ondertekening)
- Cookie/tracking-vermelding: minimaal een banner als Supabase JS cookies plaatst

### 8.0f Herroepingsrecht (volledig)
**Wanneer van toepassing:**
- Overeenkomst op afstand (klant tekent via link, partner niet aanwezig): 14 dagen herroepingsrecht
- Overeenkomst buiten verkoopruimten (partner ter plaatse bij klant): 14 dagen herroepingsrecht
- `signing_methode` in het contract bepaalt welk regime geldt

**Verplichtingen:**
- Contract bevat herroepingsclausule met wettelijke tekst
- Bevestigingsmail bevat het **wettelijk modelformulier voor herroeping** (Bijlage 2, Richtlijn 2011/83/EU)
- Contract-status "getekend" → wordt pas "actief" na 14 dagen OF bij expliciete bevestiging klant
- **Uitzondering**: als onderhoud op uitdrukkelijk verzoek vóór einde herroepingstermijn wordt uitgevoerd, vervalt het recht voor het reeds uitgevoerde deel. Dit moet expliciet aangevinkt worden in het contract.

### 8.0g Interventie-escalatie & aansprakelijkheid
Bij interventies met `ernst: urgent` en `actie_door: partner`:
- **Dag 0**: melding naar partner (email)
- **Dag 3**: herinnering naar partner (email)
- **Dag 7**: escalatie naar Flancco admin → Flancco kan beslissen over te nemen
- **Dag 14**: automatische status-escalatie in dashboard (rood)

Het partnercontract (samenwerkingsovereenkomst) moet een clausule bevatten over:
- Reactietermijn bij urgente interventies (max 7 werkdagen)
- Aansprakelijkheidsverdeling als partner niet reageert en defect schade veroorzaakt
- Recht van Flancco om interventie over te nemen en kosten door te rekenen

### 8.0h Bewaarplicht & retentietermijnen
Gedifferentieerde bewaartermijnen per datatype:

| Datatype | Bewaartermijn | Grondslag |
|----------|--------------|-----------|
| Contracten + factuurgegevens | 7 jaar na einde contract | Belgisch boekhoudrecht |
| Onderhoudsrapporten | 10 jaar | Aansprakelijkheid verborgen gebreken |
| Handtekeningen + ondertekeningscontext | 10 jaar | Verjaringstermijn België |
| Persoonsgegevens (naam, adres, etc.) | Tot einde bewaartermijn contract | AVG - niet langer dan noodzakelijk |
| Foto's van installaties | 10 jaar (kunnen persoonsgegevens bevatten) | Onderhoudsdossier + aansprakelijkheid |

Na afloop bewaartermijn: automatisch anonimiseren (namen/adressen wissen, foto's verwijderen) of volledig verwijderen.
Admin-dashboard krijgt een **retentie-overzicht**: welke records binnenkort geanonimiseerd/verwijderd worden.

### 8.0i GDPR rolverdeling
De verwerkingsrelatie is complexer dan één model:
- **Partner-klant via partner-link**: gezamenlijke verwerkingsverantwoordelijkheid (art. 26 AVG) — partner én Flancco bepalen samen het doel
- **Flancco Direct**: Flancco is zelfstandig verwerkingsverantwoordelijke
- **Rapportfoto's**: kunnen persoonsgegevens bevatten (kentekenplaten, gezichten). Benoemd in verwerkingsovereenkomst.

De calculator toont een **dynamische privacyvermelding** op basis van de partner:
- Flancco Direct: "Flancco BV verwerkt uw gegevens..."
- Partner: "Novectra B.V. en Flancco BV verwerken gezamenlijk uw gegevens..."

---

## Part 9: Security

### 9.1 Anon INSERT beveiliging
De anon key is publiek (staat in HTML). Misbruik voorkomen:
- **Rate limiting**: configureer in Supabase dashboard (max requests per IP per minuut)
- **Input sanitization**: alle tekstvelden escapen bij rendering in admin dashboard (voorkomt stored XSS)
- **Server-side validatie** (v2): Edge Function als proxy voor contract-inserts met honeypot/validatie
- **Monitoring**: alert bij ongewoon hoog aantal inserts per uur

### 9.2 Handtekeningen naar Storage
Handtekeningen worden NIET als base64 in de database opgeslagen (kan MB's per record zijn).
In plaats daarvan:
- Canvas → PNG blob → upload naar Supabase Storage bucket `handtekeningen`
- Alleen de Storage URL wordt opgeslagen in `contracten.handtekening_url`
- Migratie: bestaande `handtekening_data` kolom blijft voor backward compatibility

### 9.3 Audit trail
Statuswijzigingen op onderhoudsbeurten en interventies worden gelogd:
```sql
audit_log (
  id uuid PK,
  tabel text,           -- 'onderhoudsbeurten', 'interventies', 'contracten'
  record_id uuid,
  actie text,           -- 'status_wijziging', 'aangemaakt', 'gewijzigd'
  oude_waarde text,
  nieuwe_waarde text,
  user_id uuid FK → auth.users,
  created_at timestamptz
)
```
Geïmplementeerd via Postgres trigger OF applicatie-level logging bij elke statuswijziging.

### 9.4 RLS policies voor nieuwe tabellen
Alle nieuwe tabellen krijgen RLS policies:

**onderhoudsbeurten:**
- Admin: volledige CRUD
- Partner: SELECT op eigen contracten (via contract_id → contracten.partner_id)
- Anon: geen toegang

**rapporten:**
- Admin: volledige CRUD
- Partner: SELECT op eigen rapporten (via contract_id)
- Anon: geen toegang

**interventies:**
- Admin: volledige CRUD
- Partner: SELECT + UPDATE status op eigen interventies (via contract_id)
- Anon: geen toegang

## Part 9b: Wagenpark-module (Flancco admin-only)

### Overzicht
Aparte tab "Wagenpark" in de admin sidebar (onder BEHEER). Intern overzicht van het Flancco-wagenpark: voertuigen, uitrusting, keuringen, verzekeringen, km-registratie, kosten. Gekoppeld aan techniekers. Geen impact op de planningsagenda — puur administratief.

### Wagenpark-pagina UX
```
┌─ Wagenpark ──────────────────────────────────────────────────────────────┐
│ 🔍 Zoek merk, model, nummerplaat...        [+ Nieuw voertuig]           │
│ Filter: [Status ▼ Alle]                                                  │
├──────────────────────────────────────────────────────────────────────────┤
│ Nummerplaat  Merk/Model         Technieker   Keuring    Verzekering  KM │
│ 1-ABC-123   Renault Master     Matin        🟢 08/27   🟢 12/27    45.230│
│   ▼ (uitklapbaar)                                                        │
│   ┌─ Details ─────────────────────────────────────────────────────┐      │
│   │ VIN: VF1MA000012345  Bouwjaar: 2022  Brandstof: Diesel       │      │
│   │ Trekhaak: ✅  Dakdrager: ✅  Foto: [📷]                      │      │
│   │ Notities: Nieuwe banden nodig voor winter                     │      │
│   ├─ Uitrusting / Inventaris ────────────────────────────────────┤      │
│   │ Osmose-installatie, 2x ladder (6m+9m), HVAC-meetset,         │      │
│   │ Hogedrukreiniger, Gereedschapskist basis                     │      │
│   │ [📎 Inventarislijst.pdf]  [✏️ Bewerk]                        │      │
│   ├─ Kosten (5) ────────────────────────────────────────────────┤      │
│   │ 12/03/26  Onderhoud    €450    Grote beurt garage Peeters    │      │
│   │ 05/01/26  Band         €320    4x winterbanden              │      │
│   ├─ KM-historiek (laatste 10) ──────────────────────────────────┤      │
│   │ 10/04/27  45.230 km  (+1.200)                                │      │
│   │ 01/04/27  44.030 km  (+980)                                  │      │
│   └──────────────────────────────────────────────────────────────┘      │
│                                                                          │
│ 1-DEF-456   Mercedes Vito      Marino       🟠 06/27   🟢 11/27    32.100│
│ 1-GHI-789   VW Transporter     Abdellah     🔴 VERLOPEN 🟢 09/27   28.500│
└──────────────────────────────────────────────────────────────────────────┘
```

### Keuring & verzekering — kleurcodes
- 🟢 Groen: >X maanden voor verval (X = instelbaar herinneringsvenster, standaard 2 maanden)
- 🟠 Oranje: binnen herinneringsvenster
- 🔴 Rood: verlopen
- Dashboard-alert: "⚠️ Keuring VW Transporter (1-GHI-789) is verlopen!"

### Uitrusting & inventaris
Twee manieren om uitrusting vast te leggen:
- **Tekstveld**: vrije tekst-invoer (komma-gescheiden of per regel), bijv. "Osmose-installatie, 2x ladder, HVAC-meetset"
- **Document uploaden**: inventarislijst als PDF/foto uploaden naar Supabase Storage
- **Vaste velden**: trekhaak (ja/nee toggle), dakdrager (ja/nee toggle) — apart omdat deze vaak gevraagd worden bij planning

### Koppeling met techniekers
- Elk voertuig kan aan 1 technieker gekoppeld worden (FK → techniekers)
- Op de techniekers-pagina: omgekeerd zichtbaar welk voertuig toegewezen is

### Database-tabellen

```sql
voertuigen (
  id uuid PK,
  merk text NOT NULL,
  model text NOT NULL,
  nummerplaat text NOT NULL UNIQUE,
  vin text,
  bouwjaar integer,
  brandstof text CHECK (IN 'diesel','benzine','elektrisch','hybride'),
  foto_url text,                     -- Supabase Storage
  trekhaak boolean DEFAULT false,
  dakdrager boolean DEFAULT false,
  uitrusting_tekst text,             -- vrije tekst inventaris
  uitrusting_document_url text,      -- upload inventarislijst (PDF/foto)
  technieker_id FK → techniekers (nullable),
  status text CHECK (IN 'actief','in_onderhoud','uit_dienst') DEFAULT 'actief',
  keuring_verval date,
  keuring_herinnering_maanden integer DEFAULT 2,
  keuring_document_url text,         -- Supabase Storage
  verzekering_verval date,
  verzekering_herinnering_maanden integer DEFAULT 2,
  verzekering_maatschappij text,
  verzekering_polisnummer text,
  huidige_km integer DEFAULT 0,
  notities text,
  created_at timestamptz,
  updated_at timestamptz
)

voertuig_kosten (
  id uuid PK,
  voertuig_id FK → voertuigen ON DELETE CASCADE,
  datum date NOT NULL,
  categorie text,              -- onderhoud, band, brandstof, schade, etc.
  bedrag numeric NOT NULL,
  omschrijving text,
  document_url text,           -- optioneel bewijs/factuur
  created_at timestamptz
)

voertuig_km_log (
  id uuid PK,
  voertuig_id FK → voertuigen ON DELETE CASCADE,
  datum date NOT NULL DEFAULT CURRENT_DATE,
  km_stand integer NOT NULL,
  created_at timestamptz
)
-- KM-logregel wordt automatisch aangemaakt bij wijziging van huidige_km
```

### RLS policies
- Admin: volledige CRUD op alle wagenpark-tabellen
- Partner/Anon: geen toegang (intern Flancco)

### Supabase Storage
- Bucket: `voertuig-documenten`
- Paden: `keuringen/{voertuig_id}/...`, `kosten/{voertuig_id}/...`, `inventaris/{voertuig_id}/...`, `fotos/{voertuig_id}/...`

### Sidebar-update
```
BEHEER
  Partners
  Techniekers
  Wagenpark               (nieuw, admin-only)
  Prijsbeheer
  Forecast
  Instellingen            (partner-only)
```

---

**techniekers / technieker_sectoren / technieker_afwezigheden:**
- Admin: volledige CRUD
- Partner: GEEN toegang (techniekers zijn intern Flancco)
- Anon: geen toegang

**duur_instellingen:**
- Admin: volledige CRUD
- Partner/Anon: geen toegang

**audit_log:**
- Admin: SELECT only
- Partner/Anon: geen toegang

### 9.5 GDPR/AVG compliance
- **Recht op verwijdering**: admin-functie om een klant en al zijn gerelateerde data te verwijderen (contracten, beurten, rapporten, interventies, handtekeningen, foto's uit Storage)
- Verwerkingsovereenkomst, rolverdeling, retentietermijnen en privacy: zie Part 8 (Juridisch & Compliance)

## Part 10: Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Single-file HTML becomes unwieldy | Medium | Rapport-wizard als apart bestand; calculator ~1200 regels is beheersbaar |
| Pricing rules change during build | Low | Elke sector gevalideerd met user voor codering |
| Combination contract legal text complexity | Medium | Composable contract generator; elke sector draagt artikelen bij |
| GitHub Pages caching | Low | Cache-busting query params op CDN scripts |
| RLS policy gaps on new tables | High | Policies gedefinieerd in plan; security advisors na elke migratie |
| Anon key misbruik (spam/XSS) | High | Rate limiting + input sanitization + server-side validatie (v2) |
| Handtekening base64 database bloat | Medium | Storage upload i.p.v. database; URL opslaan |
| Geen audit trail bij statuswijzigingen | Medium | audit_log tabel met Postgres triggers |
| GDPR non-compliance | High | Verwerkingsovereenkomst + recht op verwijdering + retention policy |
| Old calculator URLs break | Low | Redirect files behouden backward compatibility |

---

## Summary: Build Order

1. **Database foundation** — migraties, RLS, Storage buckets
2. **Universal solar calculator** — template architectuur, bevestigingsmail, handtekening naar Storage, seizoenslogica
3. **Multi-sector UI + warmtepomp** — sector-selector, combinatiecontracten
4. **Ventilatie & verwarming** — volgt gevalideerd patroon
5. **Planning + rapport-wizard** — kanban, capaciteit, regio-filter, rapport, interventies, notificaties
6. **Dashboard updates + polish** — partner marge-overzicht, GDPR, security audit

Elke fase eindigt met een user validation checkpoint.

### Niet in v1, wel op de roadmap:
- Klantportaal (eigen contract/planning inzien)
- Server-side PDF-generatie
- Routeoptimalisatie / kaartweergave
- Dagelijkse email-digest voor Flancco admin
- Mobiele rapport-invulling door technieker ter plaatse
