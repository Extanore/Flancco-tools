# Slot W — Flancco-werk-pipeline (ad-hoc Flancco-interne klussen)

**Datum**: 2026-04-29
**Status**: Planned (bouwt op Slot V infrastructure)
**Plan-ref**: `valiant-petting-pretzel.md` Deel 11

---

## Context

Naast partner-recurrent onderhoud (Slot V) doet Flancco ook **eenmalige klussen** los van partnerships — verbouwingen, ad-hoc industriële reinigingen, droogijsstralen-projecten, droger-uitgaven. Deze hebben een fundamenteel ander operationeel profiel:

- **Geen contract-frequentie** — geen cron-trigger, manueel aangemaakt via planning-modal "Losse opdracht" of contract-wizard met `is_eenmalig=true`
- **Rapport-plicht is optioneel** — vaak willen klanten geen formeel rapport (bv. droger-uitgave)
- **Vaak last-minute** — dispatcher krijgt telefoon, kluseert direct in voor morgen of vandaag
- **Tarief per uur** — facturatie via `beurt_uren_registraties` met uurtarief, niet via contract-forfait

Dit profiel verschilt zo sterk van partner-recurrent dat één gedeelde view de UX zou verstoren. Aparte pagina = aparte mindset.

## Verschil met Slot V (semantisch)

| Aspect | Slot V (Onderhoud) | Slot W (Flancco-werk) |
|---|---|---|
| Fase 2-naam | "Ingepland" (toekomstige + vandaag) | "In uitvoering" (zelfde data, andere terminologie — past bij ad-hoc-mindset) |
| Fase 4 | "Rapportage" (verplicht doorgangsstation) | "Rapport opgemaakt (optioneel)" — alleen records waarvoor admin expliciet rapport heeft gemaakt |
| Pad fase 3 → fase 5 | Niet mogelijk — moet via rapportage | **Mogelijk** — knop "Stuur direct naar facturatie" |
| Bron-data filter | `contract.is_eenmalig=false` (recurrent) | `contract.is_eenmalig=true OR contract_id IS NULL` (ad-hoc) |
| Volume-verwachting | Groot (10x scaling met partners) | Klein-tot-medium (Flancco-intern, niet schalend met partner-aantal) |

## Architectuur — shared infrastructure

Slot W is **geen kopie** van Slot V. Beide pagina's renderen via de gedeelde components-laag die in Slot V is opgezet:

- `window.FlanccoPipeline` — tab-render, aging-strip, dispatcher-card, fase-router
- `window.FlanccoPipelineToolkit` — Sarah-resilient features: activity-log, klant-notitie, hand-off modus, SLA-aging

Slot W instantieert deze components met eigen config (fase-namen, filter-discriminator, fase-3 dual-path). **Bug in shared helper raakt beide pagina's tegelijk** — grondige smoke-tests verplicht bij elke refactor.

Effort-besparing: Slot W komt op ~1¾ dag i.p.v. ~5 dagen door hergebruik.

## 5 fases

| # | Naam | Conditie |
|---|---|---|
| 1 | In te plannen | `status='in_te_plannen'` |
| 2 | In uitvoering | `status='ingepland'` (gepland werk dat nog niet uitgevoerd is) |
| 3 | Uitgevoerd | `status='uitgevoerd'` AND geen `rapporten`-rij |
| 4 | Rapport opgemaakt (optioneel) | `status IN ('uitgevoerd','afgewerkt')` AND er bestaat een `rapporten`-rij |
| 5 | Uitgestuurd ter facturatie | `goedgekeurd_op IS NOT NULL` AND `gefactureerd=false` |

**Filter-discriminator** (alle queries): `contract.is_eenmalig = true OR contract_id IS NULL`.

**Tab-kleuren** (consistent met Slot V): rood / navy / oranje / paars / groen.

## Acties per fase

| Fase | Actie-knop(pen) | Verschil met Slot V |
|---|---|---|
| 1. In te plannen | "Plan in" / "Snooze" / "Annuleer" + quick-actions (Bel/Mail/Maps) | Identiek |
| 2. In uitvoering | "Markeer uitgevoerd" | Identiek |
| 3. Uitgevoerd | **2 paths**: "Maak rapport (optioneel)" OF "Stuur direct naar facturatie" | Slot V heeft 1 verplicht pad — Slot W laat user kiezen |
| 4. Rapport opgemaakt | "Controleer + verstuur" | Identiek aan Slot V fase 5 |
| 5. Uitgestuurd ter facturatie | "Markeer afgewerkt" | Identiek |

Fase 3 dual-path is het hart van Slot W — admin beslist per klus of een formeel rapport meerwaarde heeft of niet. Tooltips op de twee knoppen documenteren wanneer welk pad past.

## Sarah-resilient toolkit (geërfd)

Slot W krijgt automatisch via `window.FlanccoPipelineToolkit`:
- **Activity-log** per beurt (wie heeft wat wanneer gedaan)
- **Klant-notitie-block** (vrije tekst per klus)
- **Hand-off modus** (dispatcher A draagt over aan dispatcher B mid-flow)
- **SLA-aging-display** (kleur-gecodeerde leeftijd-strip per kaart)

Geen extra implementatie-werk in Slot W — alleen referentie naar shared components.

## Critical files te wijzigen

| File | Wijziging |
|---|---|
| `admin/index.html` | Nav-item "Flancco-werk" + page-flancco-werk HTML + JS-functies (`computeFlanccoWerkFase`, `loadFlanccoWerkData`, `renderFlanccoWerk`) |
| `admin/index.html` | Refactor: gedeelde tab-render + aging-strip + dispatcher-card naar `window.FlanccoPipeline` (gebeurt in W1.2 vóór data-laag) |
| `CLAUDE.md` | Documenteer Slot W naast Slot V |
| `docs/slots/slot-W-flancco-werk.md` | Runbook (dit bestand) |

**Geen extra schema-migratie** — `snooze_tot` uit Slot V is gedeeld. Geen edge-function-wijzigingen.

## Verificatie

End-to-end Flancco-interne klus journey:
1. Admin → Planning → "+ Nieuwe losse opdracht" voor klant Z (`contract.is_eenmalig=true`) → save
2. Open Flancco-werk → tab 1 "In te plannen" → klus zichtbaar met contact-info
3. Klik "Plan in" → QuickAdd-modal → kies datum + tech → save → klus naar tab 2
4. Op de plan-datum: klik "Markeer uitgevoerd" → uren-bevestigen-modal → save → klus naar tab 3
5. **Pad A** (klus 1): Klik "Stuur direct naar facturatie" → uren-controle-modal → save → klus skipt fase 4 en gaat direct naar tab 5
6. **Pad B** (klus 2): Klik "Maak rapport (optioneel)" → `admin/rapport.html` → save → klus naar tab 4 → "Controleer + verstuur" → tab 5
7. Klik "Markeer afgewerkt" → klus verdwijnt uit Flancco-werk, `status='afgewerkt'`

### Cross-check Slot V

- Maak een **partner-onderhoud-klus** (`is_eenmalig=false`) → moet in Slot V verschijnen, **NIET** in Slot W
- Maak een **losse opdracht** (`is_eenmalig=true OR contract_id IS NULL`) → enkel in Slot W zichtbaar
- Beide views simultaan open → geen overlap

## Edge cases / risks

- **Data-bron overlap (legacy data)**: records met `contract_id IS NULL AND is_eenmalig=false` bestaan mogelijk historisch. Filter `is_eenmalig=true OR contract_id IS NULL` is OR-gecombineerd → veilig: legacy NULL-contract-rijen vallen onder Slot W (correcte semantiek voor ad-hoc).
- **Refactor-risico shared helpers**: een bug in `window.FlanccoPipeline` raakt Slot V én W tegelijk. Mitigatie: smoke-tests op beide pagina's vóór elke release; W1.2 (refactor naar shared) gebeurt vóór W2 erop bouwt.
- **Volume-mismatch**: Slot V scaled met partner-aantal (10x), Slot W blijft Flancco-intern. Performance-tuning asymmetrisch — geen acuut probleem voor MVP, maar pagina-pagineering moet onafhankelijk configureerbaar zijn.

## Slot W follow-up roadmap

Gespiegeld op Slot V.2-V.4 maar voor Flancco-werk-context:
- **Slot W.2 — Smart-suggestions voor losse klussen** (~2 dagen, na 3 maanden volume) — pattern-detectie voor terugkerende ad-hoc klanten
- **Slot W.3 — Bulk-acties** (~½ dag) — lagere prioriteit door kleiner volume
- **Slot W.4 — Auto-comms** — samen ontwikkelen met V.4 voor consistentie
