# Slot V — Onderhoud-pipeline (partner-recurrent onderhoud)

**Datum**: 2026-04-29
**Status**: Spec — implementatie pending
**Plan-ref**: `valiant-petting-pretzel.md` Deel 10

---

## Context

Nieuwe top-level admin-pagina "Onderhoud" die het partner-recurrent onderhoud structureel zichtbaar maakt over alle partners heen. Vandaag zit de info versnipperd over Planning, Rapporten en Facturatie; pre-uitvoering-fasen ("nog te plannen", "ingepland-wacht-op-uitvoering") leven enkel in de kalender en niet als gestructureerde lijst.

**Filter-discriminator**: `contract.is_eenmalig = false` — Slot V toont enkel recurrent partner-werk. Eenmalige/ad-hoc klussen vallen onder Slot W; interventies blijven in `page-interventies` (geen wijziging).

### Strategische pijlers

1. **Volume gaat 10x** — vandaag 9 beurten, morgen 900. Pipeline moet schaalbaar zijn vanaf dag 1 (tabs i.p.v. kanban, paginatie-ready, server-side aggregatie als upgrade-pad).
2. **Multi-partner** — dispatcher moet over alle partners heen kunnen zien én filteren. Filter-chip op `partner_id` is cruciaal; counter-badges per partner geven bottleneck-zicht via nav-hover-tooltip.
3. **Lifecycle compleet** — van "klant-belofte" (cron-trigger op contract-frequentie) tot "factuur betaald" (status `afgewerkt` + facturatie verstuurd). Geen enkele beurt mag tussen de mazen vallen — elke fase heeft expliciete in- en uitgang.
4. **Field-team vriendelijk** — mobile-bediening voor onderweg. Tap-to-call/mail/maps in dispatcher-card; card-list i.p.v. tabel onder 768px viewport. Swipe-gestures volgen in V.5 PWA-fase.

## Architectuur

### Sleutelinzicht — geen schema-migratie voor de fase zelf

Alle fases worden client-side (of via DB-view) **afgeleid** uit bestaande tabellen. Schema-evolutie is veilig zonder data-migratie; nieuwe fases of regels invoegen vraagt enkel JS-/SQL-aanpassing.

Bron-tabellen:
- `onderhoudsbeurten.status` — bestaande constraint (`in_te_plannen|ingepland|uitgevoerd|afgewerkt`)
- `rapporten` (id, onderhoudsbeurt_id, …) — bron voor "rapport opgemaakt"
- `beurt_uren_registraties.goedgekeurd_op|gefactureerd|gefactureerd_op` — bron voor "uren gecontroleerd + verstuurd"
- `facturatie_records` + `facturatie_regels` — partner-level facturen + regel-per-beurt-koppeling

Status `afgewerkt` is een aparte definitief-klaar-marker die ná fase 5 komt — verdwijnt uit Onderhoud en blijft in Rapporten/Facturatie als historiek.

### Single source of truth voor fase-bepaling

`computeOnderhoudFase(beurt)` in `admin/index.html` returnt `'in_te_plannen'|'ingepland'|'uitgevoerd'|'rapportage'|'uitgestuurd_facturatie'|'afgewerkt'|'n.v.t.'`. Alle render-paden gaan door deze functie.

## Vijf fases

| # | Fase | Conditie |
|---|---|---|
| 1 | **In te plannen** | `status='in_te_plannen' AND (snooze_tot IS NULL OR snooze_tot <= today) AND contract.is_eenmalig=false` |
| 2 | **Ingepland** | `status='ingepland'` (ongeacht of vandaag of toekomstig) |
| 3 | **Uitgevoerd** | `status='uitgevoerd' AND geen rapporten-rij` |
| 4 | **Rapportage** | `rapporten`-rij bestaat voor deze beurt (verplicht voor partner-onderhoud) |
| 5 | **Uitgestuurd ter facturatie** | alle `beurt_uren_registraties.goedgekeurd_op IS NOT NULL` AND `gefactureerd=false` |

Tab-kleuren: rood (1), navy (2), `#F59E0B` oranje (3), `#8B5CF6` paars (4), `#16A34A` groen (5). Counter-badge per tab. Aging-strip onder tab-bar.

## Aging-buckets

```
< 7d (groen)    7-14d (geel)    14-30d (oranje)    > 30d (rood)
```

Klikbaar als filter ("Toon alleen rode bucket"). Berekend op `now() - status_changed_at` per record.

**SLA-breach overlay**: als `partners.sla_fase_<n>_uren` gezet is en `now() > status_changed_at + sla_uren`, wordt de aging-badge rood en het label wijzigt naar `SLA-breach Xu`. Niet-SLA-records blijven hun normale bucket-kleur.

## Sarah-resilient continuity-toolkit

**Re-framing.** Flancco heeft één vaste planner (Sarah). Bus factor = 1 is een enterprise red flag. Vijf toolkit-elementen absorberen Sarah's werkwijze zodat een collega zonder voorkennis op willekeurige dag kan invallen.

### Toolkit-1 — Audit-stempel achter de schermen

**Schema.**

```sql
ALTER TABLE onderhoudsbeurten
  ADD COLUMN last_modified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN last_modified_at TIMESTAMPTZ NULL;

CREATE TRIGGER trg_onderhoudsbeurten_stamp_last_modified
  BEFORE UPDATE ON onderhoudsbeurten
  FOR EACH ROW EXECUTE FUNCTION onderhoudsbeurten_stamp_last_modified();
```

Trigger-functie zet `NEW.last_modified_by := auth.uid()` + `NEW.last_modified_at := now()`. Reuse van bestaande Slot H pattern. Geen UI-component "Claim" — niet relevant met 1 planner. Komt terug als full assignee/owner-feature in V.2a zodra team groeit naar 2+ planners.

### Toolkit-2 — Activity-log per record

**Schema.**

```sql
CREATE TABLE beurt_dispatch_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beurt_id UUID NOT NULL REFERENCES onderhoudsbeurten(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('manual','snooze','system','transitie','mail')),
  text TEXT NOT NULL,
  user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX beurt_dispatch_log_beurt_created_idx
  ON beurt_dispatch_log (beurt_id, created_at DESC);
```

**RLS.** Admin/bediende SELECT+INSERT; partner SELECT enkel eigen `partner_id` via JOIN op contracten.

**Auto-feeders.**
- `BEFORE UPDATE OF status` trigger op `onderhoudsbeurten` → INSERT type=`transitie` rij (`"Status: <oud> → <nieuw>"`).
- Bestaande `klant_notification_log` events repliceren via cron of JOIN-view → type=`mail`.
- Cron-aanmaak via `seed_beurten_volgnummer` migratie → INSERT type=`system` rij ("Auto-aangemaakt door cron — frequentie kwartaal").
- Snooze-actie schrijft type=`snooze` met user-ingevoerde reden.
- "+ Notitie"-modal in pipeline-card schrijft type=`manual`.

**UI.** Activiteit-blok inline op elke pipeline-card, chronologisch. Bij hand-off modus default uitgeklapt; anders collapsed met counter.

### Toolkit-3 — Klant-context op record-niveau

**Schema.**

```sql
ALTER TABLE clients ADD COLUMN planner_notitie TEXT NULL;
```

**UI.** Lichtgele blok "Klant-notitie" boven contact-info met expanderbare tekst, inline bewerkbaar vanuit pipeline-card én vanuit klantfiche. Mini-historiek als compacte rij eronder ("12 beurten · gem. €450 · laatst: 21/1, 15/10, 22/7"). Read-only aggregatie van bestaande `onderhoudsbeurten`.

### Toolkit-4 — Pipeline-status tegel + hand-off modus

**Pipeline-status tegel** (dashboard):

```
Pipeline vandaag
─────────────────
SLA-breach            3 records (rood)
Overdue               5 records (oranje)
Vandaag plan-datum    8 records
Vandaag uitvoering    4 records
Wacht op rapport      2 records
─────────────────
[Toggle: Hand-off modus aan/uit]
```

Klik op rij → Onderhoud opent met filter pre-applied. Karen weet binnen 10 sec waar de prioriteit ligt.

**Hand-off modus.**
- Body-class `handoff-mode` toggle + localStorage-flag `flancco_handoff_mode_since=<datum>`
- Banner bovenaan elke pagina: "Sarah afwezig sinds [datum] — [collega] vervangt tijdelijk"
- Activity-log (Toolkit-2) prominent op record-card (eerste blok, default uitgeklapt)
- Klant-notitie (Toolkit-3) altijd uitgeklapt
- Per-fase runbook-tooltips (Toolkit-5) altijd zichtbaar i.p.v. hover-only

**Schema.** Geen DB-wijziging voor MVP (localStorage volstaat); optionele V.2a-upgrade naar `app_settings.handoff_active_since DATE` voor cross-device sync.

### Toolkit-5 — SLA per partner + runbook-tooltips

**Schema.**

```sql
ALTER TABLE partners
  ADD COLUMN sla_fase_1_uren INT NULL,
  ADD COLUMN sla_fase_2_uren INT NULL,
  ADD COLUMN sla_fase_4_uren INT NULL,
  ADD COLUMN sla_fase_5_uren INT NULL;

CREATE TABLE runbook_tooltips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fase TEXT NOT NULL,
  action_key TEXT NOT NULL,
  content_nl TEXT NOT NULL,
  content_fr TEXT NULL,
  updated_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fase, action_key)
);
```

Pre-seed migratie met defaults voor alle fase + action-combinaties (NL); FR vult Slot S in. Admin-only RLS (`role='admin'`); read voor admin/bediende. Tooltip toont `updated_at` ("Laatst bijgewerkt op DD/MM door X") als drift-reminder.

**UI.** Partner-edit-modal nieuwe sectie "SLA-targets per fase (in uren)" met inputs voor fase 1/2/4/5. Info-tooltip "i" naast elke actie-knop in pipeline-card; admin-edit-modal voor runbook content.

## Acties per fase

| Fase | Knop-set | Modal / DB-effect |
|---|---|---|
| **1. In te plannen** | `[Plan in]` `[Snooze]` `[Annuleer]` `[Bel]` `[Mail]` `[Maps]` | `Plan in` → `openQuickAddModal` pre-filled (id, klant, sector, duur). `Snooze` → `UPDATE onderhoudsbeurten SET snooze_tot=<datum>` + activity-log entry. `Annuleer` → bestaande `soft_delete_beurt`-RPC. Tap-acties: `tel:` / `mailto:` / Google Maps URL — geen DB-mutatie. |
| **2. Ingepland** | `[Verplaats]` `[Bel klant]` `[Terug naar 'In te plannen']` | `Verplaats` → edit-beurt-modal (datum/tech). `Terug` → `UPDATE onderhoudsbeurten SET status='in_te_plannen'` (klant cancelt). Reminder-status leest `klant_notification_log` (Slot F). |
| **3. Uitgevoerd** | `[Markeer uitgevoerd]` (al in fase 2) of `[Maak rapport]` (onderhoud) / `[Stuur direct naar facturatie]` (losse opdrachten) | `Markeer uitgevoerd` → `openUrenBevestigenModal(beurtId)` → `status='uitgevoerd'` + uren-registraties aangevuld. `Maak rapport` → redirect `admin/rapport.html?beurt=<id>`. |
| **4. Rapportage** | `[Controleer + verstuur]` | Nieuwe **uren-controle-modal** (`modal-uren-controle`): toont `beurt_uren_registraties`, user past aan, save: `goedgekeurd_op=now()`, `goedgekeurd_door=user_id`, `facturatie_regels`-rij gegenereerd onder open of nieuw `facturatie_records`. |
| **5. Uitgestuurd ter facturatie** | `[Markeer afgewerkt]` | `UPDATE onderhoudsbeurten SET status='afgewerkt'` + `facturatie_records.status='verstuurd'`. Beurt verdwijnt uit Onderhoud; blijft in Rapporten + Facturatie als historiek. |

Hergebruik bestaande modals waar mogelijk: `openQuickAddModal`, `openUrenBevestigenModal`, edit-beurt-modal, `admin/rapport.html`. Eén nieuwe modal: `modal-uren-controle` (fase 4 → 5).

## Edge cases

- **Multi-day beurten** — één rij per parent-beurt, fase afgeleid uit aggregate van dag-records (`alle uitgevoerd? → fase 3; alle gefactureerd? → fase 5`).
- **Losse opdrachten zonder contract** — gaan naar Slot W (eigen pagina). Filter `contract.is_eenmalig=false` sluit ze uit.
- **Interventies** — eigen pagina `page-interventies`, geen wijziging in Slot V.
- **Soft-deleted records** (`verwijderd_op IS NOT NULL`) — uitgesloten uit alle 5 tabs.
- **Status `afgewerkt`** — niet zichtbaar in pipeline. Te vinden via Rapporten- of Facturatie-pagina.
- **Snoozed records** — verbergen niet de aging (bucket telt door tijdens snooze). Max 30 dagen + audit-log entry per snooze-actie.

## Permissies + RLS

- **Admin + bediende**: zien Onderhoud-pagina, kunnen alle 5 fase-acties triggeren.
- **Partner-rol**: zien deze pagina niet — partners hebben hun eigen `page-facturatie` voor hun records.
- **RLS-laag**: bestaande policies op `onderhoudsbeurten` / `rapporten` / `beurt_uren_registraties` / `facturatie_records` blijven onveranderd. Nieuwe tabellen (`beurt_dispatch_log`, `runbook_tooltips`) krijgen eigen RLS (zie Toolkit-2/5 schema-blocks).

## Verificatie

### End-to-end pipeline-test

1. Admin login → Onderhoud → tab 1 → contract met cron-gegenereerde beurt zichtbaar met contact-info
2. `[Bel]` → native dialer opent (mobiel) of skype/teams (desktop)
3. `[Plan in]` → QuickAdd-modal pre-filled → kies datum + tech → save → beurt naar tab 2
4. Wacht 24u → tab 2 toont reminder-status uit `klant_notification_log`
5. Plan-datum bereikt → `[Markeer uitgevoerd]` → uren-bevestigen-modal → save → tab 3
6. `[Maak rapport]` → `admin/rapport.html?beurt=<id>` opent → vul in → save → tab 4
7. `[Controleer + verstuur]` → uren-controle-modal opent met `beurt_uren_registraties` → tarief aanpassen → save → tab 5
8. `[Markeer afgewerkt]` → beurt verdwijnt; verifieer `facturatie_regels`-rij in Facturatie-pagina

### Sarah-resilient continuity-test

1. **Toolkit-1**: Sarah wijzigt status fase 1 → 2; later wijzigt Karen fase 2 → 1 (klant-cancel). Query: `SELECT last_modified_by, last_modified_at FROM onderhoudsbeurten WHERE id=...` → laatste mutatie = Karen.
2. **Toolkit-2**: voeg manuele notitie toe ("Sophie gebeld 14:32, terug bel donderdag"). Snooze met reden ("Sophie op reis tot 3/5"). Trigger status-transitie. Verifieer 3 rijen in `beurt_dispatch_log` met juiste types.
3. **Toolkit-3**: zet `clients.planner_notitie='Voormiddag-afspraken, geen ma/wo, FR-talig'`. Open elke record van die klant → notitie-blok toont content. Mini-historiek toont aantal vorige beurten + gem. tarief.
4. **Toolkit-4**: zet hand-off modus aan vanuit instellingen. Verifieer banner verschijnt op alle pagina's. Open Onderhoud → activity-log + klant-notitie + runbook-tooltips zijn default uitgeklapt. Zet uit → terug normale state.
5. **Toolkit-5**: zet `partners.sla_fase_1_uren=4` voor Novectra. Maak Novectra-record met `status_changed_at=now() - 5h` → aging-badge rood, label "SLA-breach 1u". CW Solar met zelfde leeftijd maar `sla_fase_1_uren=24` → niet-rood.
6. **Continuity-rolespel**: admin A zet hand-off modus aan met start-datum vandaag. Admin B opent Onderhoud "vers" en navigeert door 3 willekeurige fase-1 records → kan op basis van banner + activity-log + klant-notitie + SLA-badge + runbook-tooltips zelfstandig acties triggeren zonder admin A te raadplegen.

## Schema-overview

| Object | Type | Slot | Doel |
|---|---|---|---|
| `onderhoudsbeurten.snooze_tot` | DATE NULL | V1.1 | Fase 1 snooze-functie |
| `onderhoudsbeurten.last_modified_by` | UUID FK auth.users | Toolkit-1 | Audit-stempel "wie laatst" |
| `onderhoudsbeurten.last_modified_at` | TIMESTAMPTZ NULL | Toolkit-1 | Audit-stempel "wanneer laatst" |
| `trg_onderhoudsbeurten_stamp_last_modified` | BEFORE UPDATE trigger | Toolkit-1 | Auto-fill last_modified_* |
| `beurt_dispatch_log` | TABLE | Toolkit-2 | Activity-log (manual/snooze/system/transitie/mail) |
| Status-transition trigger op `onderhoudsbeurten` | trigger | Toolkit-2 | Auto-feed type=`transitie` |
| `clients.planner_notitie` | TEXT NULL | Toolkit-3 | Klant-context vrije tekst |
| `partners.sla_fase_1_uren` / `_2_uren` / `_4_uren` / `_5_uren` | INT NULL | Toolkit-5 | SLA-breach-trigger per fase |
| `runbook_tooltips` | TABLE | Toolkit-5 | Admin-bewerkbare info-tooltips per fase + action |

**RLS-policies (nieuw).**
- `beurt_dispatch_log`: admin/bediende SELECT+INSERT; partner SELECT via JOIN `onderhoudsbeurten → contracten.partner_id = current_partner_id()`.
- `runbook_tooltips`: admin RW; admin/bediende SELECT.

## Critical files

| File | Wijziging |
|---|---|
| `supabase/migrations/<ts>_slot_v_snooze_tot.sql` | NEW — `onderhoudsbeurten.snooze_tot` |
| `supabase/migrations/<ts>_slot_v_toolkit_1_audit_stempel.sql` | NEW — `last_modified_by/at` + trigger |
| `supabase/migrations/<ts>_slot_v_toolkit_2_dispatch_log.sql` | NEW — `beurt_dispatch_log` + index + RLS + status-transition trigger |
| `supabase/migrations/<ts>_slot_v_toolkit_3_planner_notitie.sql` | NEW — `clients.planner_notitie` |
| `supabase/migrations/<ts>_slot_v_toolkit_5_sla_runbook.sql` | NEW — `partners.sla_fase_*_uren` + `runbook_tooltips` + UNIQUE + pre-seed NL |
| `admin/index.html` | Nav-item "Onderhoud" tussen Planning en Interventies; `<div id="page-onderhoud">`; JS: `computeOnderhoudFase`, `loadOnderhoudData`, `renderOnderhoud`, `renderOnderhoudTab`, `renderOnderhoudPartnerCounters`, aging-strip, actie-handlers |
| `admin/index.html` | Nieuwe `modal-uren-controle` (fase 4 → 5 transitie) |
| `admin/index.html` | Toolkit-2 UI: activity-log render-block + "+ Notitie"-modal + auto-feed render |
| `admin/index.html` | Toolkit-3 UI: klant-notitie inline-edit-block + mini-historiek |
| `admin/index.html` | Toolkit-4 UI: dashboard-tegel + hand-off body-class toggle in instellingen |
| `admin/index.html` | Toolkit-5 UI: partner-modal SLA-sectie + runbook-tooltip-render + admin-edit-modal |
| `admin/rapport.html` | Geen wijziging — bestaande URL-param `?beurt=<id>` werkt al |
| `CLAUDE.md` | Documenteer nieuwe pagina + 5-fase mapping + snooze_tot + Sarah-resilient toolkit |

Geen edge-function-wijzigingen.

## Rollback-procedure

Migraties zijn additief — geen DROP COLUMN op bestaande producten-data. Rollback per migratie:

1. **Snooze_tot rollback** — `ALTER TABLE onderhoudsbeurten DROP COLUMN snooze_tot;` (geen data-loss; veld werd alleen voor fase 1 filter gebruikt).
2. **Toolkit-1 rollback** — `DROP TRIGGER trg_onderhoudsbeurten_stamp_last_modified ON onderhoudsbeurten;` + `ALTER TABLE onderhoudsbeurten DROP COLUMN last_modified_by, DROP COLUMN last_modified_at;`. Audit-trail in `audit_log` (Slot H) blijft bestaan en is canonical.
3. **Toolkit-2 rollback** — `DROP TABLE beurt_dispatch_log CASCADE;` + drop van status-transition trigger. Activity-log gaat verloren — neem export-snapshot vóór rollback (`COPY beurt_dispatch_log TO '/tmp/dispatch-log-backup.csv' CSV HEADER;`).
4. **Toolkit-3 rollback** — `ALTER TABLE clients DROP COLUMN planner_notitie;`. Notities gaan verloren — neem snapshot vóór rollback.
5. **Toolkit-5 rollback** — `ALTER TABLE partners DROP COLUMN sla_fase_1_uren, ...;` + `DROP TABLE runbook_tooltips CASCADE;`.
6. **Frontend rollback** — `git revert <commit-range>` op `admin/index.html` wijzigingen. Pagina verdwijnt; bestaande Planning/Rapporten/Facturatie blijven werken.

Volgorde bij volledige rollback: frontend eerst (UI verdwijnt), dan toolkit-5 → 3 → 2 → 1 → snooze (omgekeerd t.o.v. apply-volgorde). Verifieer na elke stap dat Planning + Rapporten + Facturatie nog correct laden.

## Known risks + mitigations

- **Concurrent edits** — twee bedienden controleren tegelijk dezelfde beurt voor facturatie → laatste-write-wint. Mitigatie: optimistic-locking via `updated_at`-check (waarschuwing als verouderd). Niet voor MVP.
- **Cron-frequentie voor fase 1-generatie** — bij honderden contracten zwaar. Acceptabel voor MVP; bij scaling overweeg incremental generation per partner.
- **Snooze-misbruik** — gebruikers verbergen bottleneck door eindeloos snoozen. Mitigatie: aging-bucket telt door tijdens snooze; max 30 dagen + audit-log entry per snooze.
- **Volume-impact aging-strip** — bij 1000+ records per fase wordt SLA-berekening client-side traag. Mitigatie: pre-compute aging-buckets server-side via DB-view. Niet voor MVP.
- **Toolkit-2 activity-log volume** — bij honderden notities per record wordt rendering traag. Mitigatie: lazy-load oudere entries (toon laatste 10, knop "Toon alles") + index `(beurt_id, created_at DESC)`.
- **Toolkit-3 PII in `planner_notitie`** — vrije tekst kan onbedoeld GDPR-gevoelige content bevatten. Mitigatie: Slot H audit-log entries voor wijzigingen; GDPR-export-functie includeert dit veld; bij klant-delete-flow ook leegmaken. Onboarding-doc voor bedienden: geen medische/financiële details.
- **Toolkit-4 hand-off-modus per device** — localStorage is per-browser. Mitigatie MVP: één planner = één centraal kantoor-device. V.2a-upgrade naar `app_settings` tabel.
- **Toolkit-5 runbook-tooltips drift** — tooltips raken outdated. Mitigatie: `updated_at` weergeven onder elke tooltip; admin-edit-UI toont "Laatst bijgewerkt op DD/MM door X" als reminder.
- **Status-transitie naar fase 5 voor losse opdrachten** — losse opdrachten hebben geen rapporten-rij. Aanbeveling: knop "Stuur direct naar facturatie" in fase 3 voor losse + interventie opent dezelfde uren-controle-modal als fase 4 → 5.
