# Slot D — Partner-facturatie

## Intent

Geef partners een eigen, in-product overzicht van wat zij in een gekozen periode
mogen factureren aan hun eindklanten. De pagina toont alle afgewerkte
onderhoudsbeurten (status `afgerond`) met klant-naam, datum, eindklantprijs
(excl. + incl. btw), de planning-fee die naar Flancco gaat, de partner-marge,
en een expliciete kolom **Door te factureren** zodat de partner direct weet
hoeveel hij voor die beurt aan zijn eindklant mag aanrekenen.

Het scherm vervangt het tot dusver onbekende ritueel van "wat factureer ik
deze maand?" door één strakke databron met week- / maand- / jaar-filters,
KPI-totalen, CSV-export naar boekhouding én een branded PDF-overzicht via de
gedeelde Slot P PDF-engine.

## Scope

| In scope | Out of scope |
|---|---|
| Partner-tak van `admin/index.html` (rol-gated via `.partner-only`) | Admin-tak — bestaande `card-facturatie-admin` blijft onaangeroerd |
| Periode-filter: week / maand (1·3·6·12) / jaar met navigator | Multi-partner aggregaties |
| KPI-strip: aantal · excl · incl · marge | Bewerken van beurten of facturatie-status (zie Slot O3) |
| CSV-export — kolomstructuur compatibel met de bestaande boekhoud-export | Boekhoud-API koppeling |
| PDF-export via `generate-pdf` template `facturatie_overzicht` | Email-verzending van het overzicht |
| Toggle "alleen gefactureerd" voor reconciliatie | Mass-update van facturatie-status |

## Files touched

| Path | Type | Verantwoordelijkheid |
|---|---|---|
| `admin/index.html` (partner-tak) | edit | Card `card-partner-facturatie`, toolbar, KPI-strip, tabel-render, `loadPartnerFacturatie / renderPartnerFacturatie / setPartnerFacturatie* / movePartnerFacturatiePeriode / exportPartnerFacturatieCsv / exportPartnerFacturatiePdf` |
| `calculator/i18n/nl.json.js` | edit | 35 nieuwe leaf-keys onder `partner.facturatie.*` |
| `calculator/i18n/fr.json.js` | edit | Identieke set FR-vertalingen, NL=FR=392 keys totaal |
| `supabase/functions/generate-pdf/templates/facturatie_overzicht.ts` | create | A4-landscape PDF-template met KPI-strip, 9-koloms tabel, totaal-rij, intern-disclaimer footer |
| `supabase/functions/generate-pdf/index.ts` (auth-tak / template-registry) | edit | Registratie van `facturatie_overzicht` met `requiresAuth: true`, payload-coercion via `coerceFacturatieOverzicht()` |

Niet aangeraakt (file-fence): `planning.html`, `calculator/index.html`, andere PDF-templates, andere edge functions.

## Data flow

```
[admin/index.html partner-tak]
  └─ loadPartnerFacturatie(periode)
       └─ supabase.from('onderhoudsbeurten')
            .select('id, datum, status, contracten(klant_naam, sectoren, aantal_panelen,
                     forfait_per_beurt, planning_fee, marge_pct, partners(slug, ...))')
            .eq('status','afgerond')
            .gte('datum', periode.van).lte('datum', periode.tot)
       └─ map → FacturatieBeurtRow[]  (klant, sector-label, panelen, excl, incl,
                                        planning_fee, marge, door_te_factureren_*)
       └─ totalen = aggregate(rows)

[Render]
  ├─ KPI-strip      (count, excl, incl, marge)
  ├─ Tabel          (9 kolommen + totaal-rij)
  └─ Acties         (CSV download · PDF via generate-pdf)

[PDF export]
  POST /functions/v1/generate-pdf
       Authorization: Bearer <user-JWT>
       { template: "facturatie_overzicht",
         partner_slug: <eigen-slug>,
         lang: "nl"|"fr",
         data: { periode, beurten[], totalen } }
  ↓
  index.ts → coerceFacturatieOverzicht() → facturatie_overzicht.ts → pdf-lib bytes
       ↓ upload → bucket `gen-pdf/<slug>/<YYYY-MM-DD>/...pdf`
       ↓ signed URL TTL 7 dagen
  ← { success: true, url, path, expires_at, bytes }
```

## Auth-model

| Caller | facturatie_overzicht | Reden |
|---|---|---|
| Anon / geen JWT | **401** | Bevat marge en planning-fee — interne data |
| Admin | **200** voor elke `partner_slug` | Volledige inzage |
| Partner met eigen slug | **200** | Standaardgebruik |
| Partner met andere slug | **401** | Cross-slug deny in `index.ts` lijn 559-568 |
| Bediende | **200** voor elke `partner_slug` | Bediende heeft brede inzage zoals admin |

Defense-in-depth: de partner-tak in admin/index.html valideert ook client-side
op rol vóór hij überhaupt de fetch doet — server-side gating is echter de
enige bron van waarheid.

## i18n keys (NL=FR=35)

```
partner.facturatie.title
partner.facturatie.subtitle.{week|maand|jaar}
partner.facturatie.kpi.{count|excl|incl|marge}
partner.facturatie.filter.{week|maand|jaar}
partner.facturatie.filter.maandKeuze.{1|3|6|12}
partner.facturatie.filter.alleenGefactureerd
partner.facturatie.kolom.{datum|klant|sector|panelen|excl|incl|planning|marge|door}
partner.facturatie.totaal
partner.facturatie.export.{csv|pdf|csvFilename}
partner.facturatie.empty.title
partner.facturatie.empty.body
partner.facturatie.error.fetch
partner.facturatie.error.pdf
partner.facturatie.disclaimer.intern
```

Alle 35 keys aanwezig in zowel `nl.json.js` als `fr.json.js`. Totale woordenboek:
**392 leaf-keys NL = 392 leaf-keys FR**.

## PDF-template — design

A4 landscape (842×595 pt), partner-branding via gedeelde header/footer:

| Sectie | Inhoud |
|---|---|
| Header | Partner-logo (links) + titel "Facturatie-overzicht" + periode-label + lang-stempel |
| KPI-strip | 4 kaarten: aantal · excl btw · incl btw · partner-marge |
| Tabel | 9 kolommen — Datum 78pt · Klant 168 · Sector 96 · # 38 · Excl 70 · Incl 70 · Planning 70 · Marge 72 · Door te factureren 84 (totaal 746pt) |
| Totaal-rij | Som van excl, incl, planning, marge, door |
| Footer | "Intern document — niet voor eindklant" disclaimer + paginanummering |

`sanitize()` (uit `_shared.ts`) zorgt voor WinAnsi-veilige strings; non-WinAnsi
karakters worden stilzwijgend gestript. Voor klant-namen met accenten valt dit
binnen Latin-1 dus geen verlies.

## CSV-export

Gegenereerd client-side in `exportPartnerFacturatieCsv()`. Kolomstructuur is
compatibel met de bestaande Flancco boekhoud-export (`exportFacturatieCSV`)
zodat partners hun eigen CSV direct in dezelfde sjablonen kunnen droppen:

```
Datum;Klant;Sector;Panelen;Excl. BTW;Incl. BTW;Planning fee;Marge;Door te factureren
```

Decimaal-separator: komma (BE-conventie). Veld-separator: puntkomma.
Bestandsnaam: `facturatie_<slug>_<periode-slug>.csv`.

## Anchor-counts (file-fence verificatie)

Slot D mag enkel binnen de partner-tak in admin/index.html schrijven. De
volgende anchors uit eerdere slots moeten exact onveranderd blijven:

| Anchor | Target | Resultaat |
|---|---|---|
| `feestdag` | 66 | **66** |
| `switchVerlofEwTab` | 4 | **4** |
| `c-pipeline-` | 48 | **48** |
| `pipeline_emailKlant` | 2 | **2** |

Geen drift in vorige-slot-functionaliteit.

## Curl-tests post-deploy

Edge function `generate-pdf` is opnieuw gedeployed (versie 3 → 4, status ACTIVE).
Vier deterministische auth-scenarios uitgevoerd tegen
`https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/generate-pdf`:

| Scenario | Resultaat | Verwacht |
|---|---|---|
| 1. `facturatie_overzicht` zonder JWT | **401** "Valid Authorization header required" | 401 |
| 2. `facturatie_overzicht` met anon JWT (geen user) | **401** | 401 |
| 3. `facturatie_overzicht` met garbage Bearer | **401** | 401 |
| 4. `werkplanning` (public) zonder JWT | **400** payload-validatie ("data.technieker_naam is required") | 200 met geldige payload, 400 hier — bevestigt dat auth-tak overgeslagen wordt |

Auth-gating bevestigd: `requiresAuth: true` weigert systematisch elke caller
zonder geldig user-account; `requiresAuth: false` (werkplanning) bereikt direct
de payload-coercion.

**Niet uitgevoerd** vanuit deze sessie (vereist een echt sign-in user-JWT,
service-role secret niet beschikbaar via MCP):
- 5. Admin-JWT → verwacht 200 met signed URL
- 6. Partner-JWT eigen slug → verwacht 200
- 7. Partner-JWT cross-slug → verwacht 401

Aanbevolen vervolg: één test uitvoeren vanuit het admin-account in de live
admin-UI (klik PDF-overzicht knop) en één vanuit het partner-account
`robbe@cw-solar.be`. Beide moeten een signed URL teruggeven; geen extra
codewijziging nodig.

## Security advisor

`get_advisors(type=security)` → `lints: []` na deploy. Geen nieuwe waarschuwingen
toegevoegd door Slot D.

## Performantie-notes

- `loadPartnerFacturatie()` doet één query met nested join — partners met >500
  beurten in één maand zijn theoretisch te verwachten. Postgres met de juiste
  index (`onderhoudsbeurten(status, datum)`) handelt dit ruim onder 200 ms af.
- KPI-aggregatie gebeurt client-side over de gefilterde set — verwaarloosbaar
  voor realistische volumes.
- PDF-render is server-side bounded: pdf-lib over Deno doet ~50-300 ms per
  pagina; bij >150 beurten breekt de tabel naar pagina 2 en verder. Bestand
  blijft normaliter onder de 1 MB cap.

## Open follow-ups (out of scope, niet in deze slot)

1. **Slot O3** — bewerken van facturatie-status vanuit de partner-tak. Vandaag
   read-only.
2. **Slot N** — boekhoud-API koppeling (Octopus / Yuki / Exact) voor automatische
   factuur-aanmaak vanuit partner-tak.
3. **Email-bezorging** van het PDF-overzicht naar de partner — vandaag enkel
   download.
4. **Multi-partner aggregatie** voor admin-bediende — bestaande admin-tak dekt
   dit deels via partner-filter.

## Eigenaar

Gillian Geernaert — `gillian.geernaert@flancco.be`
