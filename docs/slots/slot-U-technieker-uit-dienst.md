# Slot U — Technieker uit dienst (soft-delete met historiek-bewaring)

**Datum**: 2026-04-28
**Status**: Live
**Plan-ref**: `valiant-petting-pretzel.md` Deel 9

---

## Intent

Wanneer een technieker het bedrijf verlaat, kan vandaag enkel **hard-deleted** worden via de "Verwijderen"-knop in `admin/index.html`. Dat verwijdert de rij uit `techniekers`, maar laat orphan-FK's achter in:
- `onderhoudsbeurten.technieker_id` + `extra_technieker_ids[]`
- `beurt_planning_dagen.technieker_id`
- `beurt_uren_registraties.technieker_id`
- `verlof_aanvragen.technieker_id`

Geen CASCADE-policies → ofwel breekt referentiële integriteit, ofwel verdwijnen technieker-namen uit historische rapporten/contracten/audit-log.

**Oplossing**: voeg `uit_dienst_sinds DATE` toe. Technieker verdwijnt uit actieve planning, maar blijft als referentie bestaan voor:
- Historische beurten + uren-registraties (FK's behouden)
- Winstgevendheid-rapportage (YTD per technieker, ook over vorige jaren)
- Audit-log uitvoerder-filter (wie heeft welke wijziging gedaan, ook ex-collega's)
- Contract-PDF + werkbon-PDF (technieker-naam blijft resolvable via LEFT JOIN)

## Architectuur

`actief` boolean blijft bestaan voor backward-compat (9+ bestaande filter-queries op `.eq('actief', true)` werken zonder code-wijziging). `uit_dienst_sinds DATE` is de nieuwe source-of-truth. Een trigger synct de twee:

```sql
NEW.actief := (NEW.uit_dienst_sinds IS NULL OR NEW.uit_dienst_sinds > CURRENT_DATE);
```

- Vandaag uit dienst (`uit_dienst_sinds = today`) → `actief=false` → tech verdwijnt uit planning-views
- Toekomstige uit-dienst (`uit_dienst_sinds = '2026-06-30'`) → `actief=true` tot die datum, dan automatisch false (cron-job 1×/dag)
- Reactiveren: `uit_dienst_sinds = NULL` → `actief=true` automatisch

## Spoor U1 — Schema-migratie

`supabase/migrations/20260428113100_slot_u_technieker_uit_dienst.sql`:

- `ALTER TABLE techniekers ADD COLUMN uit_dienst_sinds DATE`
- Trigger-functie `techniekers_sync_actief_status()` (geen SECURITY DEFINER — muteert enkel NEW)
- BEFORE INSERT/UPDATE trigger `trg_techniekers_sync_actief`
- Daily-sync functie `techniekers_daily_actief_sync()` (SECURITY DEFINER voor cron-uitvoering)
- pg_cron job `slot_u_techniekers_actief_daily` om 00:05 UTC daily — synct techs met toekomstige uit-dienst-datum die vandaag bereikt is
- Partial index `techniekers_uit_dienst_idx WHERE uit_dienst_sinds IS NOT NULL`

## Spoor U2 — UI in `admin/index.html`

### Technieker-edit modal
- "Verwijderen"-knop vervangen door 3 contextuele acties:
  - **Uit dienst zetten** (default) — opent inline date-picker pane (`#kl-uit-dienst-pane`)
  - **Reactiveren** — alleen zichtbaar als `uit_dienst_sinds IS NOT NULL`
  - **Definitief verwijderen** — alleen zichtbaar als `uit_dienst_sinds < (today - 7 jaar)` (na boekhoudkundige bewaarplicht), achter dubbele bevestigingsmodal
- Nieuwe JS functions: `openTechUitDienstPane()`, `confirmTechUitDienst()`, `cancelTechUitDienst()`, `reactivateTech()`
- Audit-log entries voor elk van deze acties

### Technieker-overzicht (`page-techniekers`)
- Toolbar-toggle `#tech-show-ex` "Toon ex-collega's"
- Default: alleen actieve techs zichtbaar
- Toggle aan: alle techs incl. inactieve, met 50% opacity + grijze badge "Uit dienst sinds <datum>"

## Spoor U3 — Filter-updates (no-op)

Bestaande filter-queries blijven werken zonder code-wijziging dankzij trigger-sync:
- `planning.html:4065` (`.eq('actief', true)`)
- `planning.html:6518, 8471, 8831, 9555` (`.filter(t => t.actief !== false)`)
- `index.html:15442, 20053, 20154, 20235, 20355, 20450` (`.filter(t => t.actief !== false && type !== 'bediende')`)

Geen code-changes uitgevoerd in dit spoor.

## Spoor U4 — Winstgevendheid-view exception

`supabase/migrations/<timestamp>_slot_u_winstgevendheid_per_technieker_include_ex.sql`:
- View `v_winstgevendheid_per_technieker` had filter `WHERE t.actief = true` → sloot ex-techs uit YTD-aggregaten
- Nieuwe definitie: filter weg, plus `uit_dienst_sinds`-kolom toegevoegd aan SELECT zodat frontend "(Uit dienst sinds <datum>)"-suffix kan renderen
- `security_invoker=on` behouden (Slot G compliance)

Audit-log uitvoerder-filter en contract-PDF/werkbon-PDF blijven werken zonder change (LEFT JOIN respecteert ex-techs).

## Spoor U5 — Edge functions

### `remove-partner-member` v3 (deployed)
- Hard-delete vervangen door soft-delete: `UPDATE techniekers SET uit_dienst_sinds = today`
- `auth.users` delete uit deze flow gehaald — historische re-aanwerving werkt direct (auth-rij blijft staan voor login). GDPR-verwijdering vereist aparte `gdpr-delete-klant`-flow (out of scope).
- Behoudt anti-self-delete + anti-last-owner checks
- Response shape: `{success, soft_deleted: true, uit_dienst_sinds, message}` i.p.v. `auth_deleted: bool`

### `invite-partner-member` v2 (deployed)
- Re-invite: `UPDATE techniekers SET uit_dienst_sinds = NULL` (trigger synct `actief=true`)
- Detectie van recent uit-dienst (<30 dagen): geeft `recently_exited: true` mee in response — geen blokkade, alleen bewustwording

## Files-touched

**Schema-migraties:**
- `20260428113100_slot_u_technieker_uit_dienst.sql`
- `<timestamp>_slot_u_winstgevendheid_per_technieker_include_ex.sql` (door Agent G via apply_migration)
- (Slot G migratie-file `20260425171000_slot_g_winstgevendheid_views.sql` mee gepatcht zodat re-apply niet de Slot U fix overschrijft)

**Frontend (`admin/index.html`):**
- HTML: `#kl-uit-dienst-pane` (kl-uit-dienst-datum + bevestigen/annuleren), `#tech-uit-dienst-btn` / `#tech-reactivate-btn` / `#tech-delete-btn` footer-knoppen, `#tech-show-ex` toolbar-toggle
- JS: `openTechUitDienstPane`, `confirmTechUitDienst`, `cancelTechUitDienst`, `reactivateTech`, aangepaste `deleteTechnieker`, `openTechModal` button-zichtbaarheid
- `renderTechniekers` respecteert `tech-show-ex` filter

**Edge functions:**
- `supabase/functions/remove-partner-member/index.ts`
- `supabase/functions/invite-partner-member/index.ts`

## Verificatie

### Schema
- Trigger `trg_techniekers_sync_actief` werkt: INSERT zonder `uit_dienst_sinds` → `actief=true` ✅
- UPDATE met `uit_dienst_sinds=today` → `actief=false` ✅
- UPDATE met `uit_dienst_sinds=tomorrow` → `actief=true` ✅
- Cron job `slot_u_techniekers_actief_daily` geregistreerd (00:05 UTC) ✅

### Edge functions
- `remove-partner-member` v3 ACTIVE
- `invite-partner-member` v2 ACTIVE

### End-to-end test-scenario
1. Login admin → Personeel → maak nieuwe tech "TestTech"
2. Plan een beurt voor TestTech vandaag → save
3. Genereer werkbon → tech-naam verschijnt
4. Open TestTech edit-modal → klik "Uit dienst zetten" → kies datum=vandaag → bevestig
5. Open planning → TestTech verdwijnt uit dropdowns + sidebar
6. Open verlof/EW pagina → TestTech niet meer in actieve lijst
7. Open Winstgevendheid → TestTech blijft zichtbaar in YTD-tab met "(Uit dienst sinds <datum>)" suffix
8. Open audit-log → uitvoerder-filter toont TestTech nog steeds
9. Genereer PDF van eerder geplande beurt → tech-naam staat er gewoon
10. Open TestTech edit-modal opnieuw → klik "Reactiveren" → tech verschijnt weer overal

### RLS-validatie
- Partner-user mag alleen eigen partner_id-techs zien — geldt al (onveranderd)
- Soft-delete via `remove-partner-member` respecteert anti-self-delete + anti-last-owner

## Known risks / open questions

- **Cron-job timing**: techs met toekomstige `uit_dienst_sinds` worden pas geactiveerd 1×/dag (00:05 UTC). Acceptabel — voor instant deactivatie gebruik datum=vandaag.
- **`bediende` rol**: type_personeel='bediende' (kantoorpersoneel) krijgt zelfde behandeling — `deleteBediende` is niet mee aangepast in deze pass (verlof_saldi cleanup-logica buiten scope). Aanbeveling: aparte mini-bundle voor bediende-uit-dienst symmetrie.
- **Manuele inconsistentie**: developers die handmatig `actief=false` zetten zonder `uit_dienst_sinds` → trigger overschrijft hun waarde. Mitigatie: trigger-comment documenteert dit; geen GENERATED-column nodig voor v1.
- **Audit-trail van uit-dienst-actie zelf**: huidige UI logt via Slot H audit-log (zie `auditLog()` calls in `confirmTechUitDienst` / `reactivateTech`). Verifieer post-deploy dat actie-strings consistent zijn.
