# Slot K — Belgische feestdagen + sluitingsperiodes (soft-warning)

**Status:** Productieklaar. Continuous release — geen feature-flag, direct live op `admin/planning.html` en `admin/index.html`.

## Intent

Voorkomen dat een planner per ongeluk een onderhoudsbeurt inplant op een wettelijke Belgische feestdag of tijdens een bedrijfs-sluitingsperiode (bouwverlof, kerstvakantie), zonder hard te blokkeren. Twee doelen:

1. **Visuele markering** in de planning-agenda (week / dag / maand) zodat feestdagen en sluitingsperiodes onmiddellijk herkenbaar zijn.
2. **Soft-warning modal** vóór een nieuwe planning-actie op zo'n dag — de admin kan altijd doorduwen voor uitzonderingen (urgente interventie, klant-akkoord, etc.).

Geen harde validatie, geen DB-constraint die plannen onmogelijk maakt. Pure UX-laag bovenop bestaande planning-flow.

## Architectuur

### Twee paginas, één centrale tabel

| Locatie | Functie |
|---|---|
| `admin/planning.html` | Lezer: 1× load bij init, O(1) lookup tijdens render (Map by datum), soft-warning intercept op cell-click. |
| `admin/index.html` page-feestdagen | CRUD-beheer (admin-only), filters (jaar / type), auto-extend knop voor volgend jaar. |
| `supabase/functions/seed-feestdagen-jaar` | Cron 1 december — Computus-algoritme genereert 10 wettelijke feestdagen voor next year. |

### Files touched

| Path | Wijziging | \u0394 regels |
|---|---|---|
| `supabase/migrations/20260425150000_create_feestdagen.sql` | Migratie van legacy v1 (datum PK, naam, land) naar v2 (uuid PK, label, datum_eind, recurring, type), + RLS, + 2 jaar pre-seed | ~190 |
| `supabase/functions/seed-feestdagen-jaar/index.ts` | Computus + auth (admin-JWT \u00f3f service_role) + idempotente upsert | ~275 |
| `supabase/functions/seed-feestdagen-jaar/deno.json` | Imports map | 8 |
| `admin/planning.html` | + CSS (markers, banners, modal), + modal HTML, + helpers (loadFeestdagen / isFeestdag / getSluitingsperiodeOverlap / getFeestdagHeaderMarkup), + soft-warning modal logic, + render-wirings in week/dag/maand-view, + intercept op `openDagPlusKiezer` en `monthDayClick` | ~430 |
| `admin/index.html` | + nav-item Feestdagen, + page-feestdagen (dv-pattern), + create/edit modal, + delete modal, + JS (renderFeestdagenPage, openFeestdagModal, submitFeestdag, askDeleteFeestdag, confirmDeleteFeestdag, seedFeestdagenJaar) | ~330 |
| `calculator/i18n/nl.json.js` | + `planning.feestdagen.*` + `admin.feestdagen.*` keys | ~55 |
| `calculator/i18n/fr.json.js` | + identieke FR-keys | ~55 |
| `docs/slots/slot-K-feestdagen.md` | nieuw (deze doc) | — |

Geen wijzigingen aan calculator, contracten-wizard, rapportage of andere edge-functions.

## DB-schema

### Tabel `public.feestdagen`

| Kolom | Type | Default | Notes |
|---|---|---|---|
| `id` | uuid | `gen_random_uuid()` | PK |
| `datum` | date | — | Voor feestdag: de dag zelf. Voor sluitingsperiode: startdatum incl. |
| `datum_eind` | date | NULL | Verplicht bij `type='sluitingsperiode'`, NULL bij `type='feestdag'` (CHECK constraint) |
| `label` | text | — | NOT NULL, min 2 tekens (CHECK) |
| `type` | text | — | `'feestdag'` of `'sluitingsperiode'` (CHECK) |
| `recurring` | text | `'eenmalig'` | `'jaarlijks'` (auto-extend cron) of `'eenmalig'` |
| `aangemaakt_door` | uuid | NULL | FK auth.users, ON DELETE SET NULL |
| `aangemaakt_op` | timestamptz | `now()` | NOT NULL |
| `bijgewerkt_op` | timestamptz | `now()` | NOT NULL, BEFORE UPDATE trigger |

### Constraints

- `chk_sluitingsperiode_eind` — sluitingsperiode \u21d2 datum_eind \u2265 datum, feestdag \u21d2 datum_eind IS NULL
- `chk_label_min_length` — `length(trim(label)) \u2265 2`
- `idx_feestdagen_datum_label_uniq` — UNIQUE op `(datum, label)` voor idempotente upsert vanuit edge-function

### RLS-policies

- `feestdagen_select_authenticated` \u2014 alle authenticated users mogen lezen (planner + technieker zien markering)
- `feestdagen_admin_write` \u2014 INSERT/UPDATE/DELETE alleen admin (via `user_roles.role='admin'` join)

### Pre-seed bij migratie

20 rijen pre-loaded: 10 wettelijke BE feestdagen \u00d7 2026 + 2027. Variabele datums (Pasen-afgeleid) berekend met Computus en hard-coded in de SQL — verificatie:

- Pasen 2026 = 5 april \u2192 Paasmaandag 6 apr, Hemelvaart 14 mei, Pinkstermaandag 25 mei
- Pasen 2027 = 28 maart \u2192 Paasmaandag 29 mrt, Hemelvaart 6 mei, Pinkstermaandag 17 mei

Toekomstige jaren (2028+) worden automatisch toegevoegd door de cron.

## Edge function `seed-feestdagen-jaar`

### Endpoint

```
POST https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/seed-feestdagen-jaar?year=2028
Headers:
  Content-Type: application/json
  Authorization: Bearer <admin_jwt_or_service_role>
Body: {} (year kan ook in body)
```

Default `year = currentYear + 1`. Range-check 2024-2100.

### Computus

Anonymous Gregorian algorithm (Meeus) berekent Pasen voor een gegeven jaar (geldig 1583-4099). Daaruit afgeleid:

| Feestdag | Berekening |
|---|---|
| Paasmaandag | Pasen + 1 dag |
| O.L.H. Hemelvaart | Pasen + 39 dagen |
| Pinkstermaandag | Pasen + 50 dagen |

Vaste datums: Nieuwjaar (1/1), Dag van de Arbeid (1/5), Nationale Feestdag (21/7), O.L.V. Hemelvaart (15/8), Allerheiligen (1/11), Wapenstilstand (11/11), Kerstmis (25/12).

### Auth

- **Service-role-JWT** (cron) \u2192 bypass (we accepteren expliciet, omdat Supabase's built-in JWT-verify service-role weigert).
- **User-JWT** \u2192 valideren via `sb.auth.getUser()`, daarna `user_roles.role='admin'` checken via service-role-client.
- Geen JWT \u2192 401 `unauthorized`.

### Idempotency

Upsert met `onConflict: 'datum,label', ignoreDuplicates: true` \u2192 gegenereerde SQL = `INSERT \u2026 ON CONFLICT DO NOTHING`. Cron kan dus veilig herhaaldelijk draaien.

### Rate-limiting

5 calls/uur per IP (in-memory Deno isolate-bucket). Voldoende voor beheers-functie. Geen DB-roundtrip nodig.

### Cron-setup (manueel via Supabase Dashboard)

```sql
-- Database \u2192 Cron Jobs \u2192 New
-- Name: feestdagen_jaarlijks_extend
-- Schedule: 0 6 1 12 *  (1 december, 06:00 UTC)
SELECT net.http_post(
  url := 'https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/seed-feestdagen-jaar',
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'Authorization','Bearer <SERVICE_ROLE_KEY>'
  ),
  body := '{}'::jsonb
);
```

## Front-end gedrag

### Planning.html (lezer)

1. `loadPlanningData()` \u2192 await `loadFeestdagen()` (parallel met andere init-fetches).
2. `window.flanccoFeestdagen.byDatum` (Map) opgevuld voor O(1) lookup tijdens render.
3. **Week-view**: `<th>` voor elke dag krijgt `is-feestdag` of `is-sluiting` class + marker-pill onder de dag-label.
4. **Dag-view**: enkel de "Tijd"-header krijgt class + marker (de dag zelf is al impliciet zichtbaar).
5. **Maand-view**: `<td>` cel krijgt class + tag in de cel; banner bovenaan toont overlappende sluitingsperiodes.
6. **Sluitingsperiode-banner**: bovenaan week + maand-view bij overlap met huidige periode.
7. **Cell-click intercept**: `openDagPlusKiezer(techId, datum)` en `monthDayClick(dateStr)` worden gewrapped door `checkFeestdagAndProceed(datum, callback)` \u2192 toont modal als match, anders direct doorgaan.

### Soft-warning modal

A11y-compliant: `role="dialog"`, `aria-modal`, `aria-labelledby`, `aria-describedby`, focus-trap (default focus op Annuleer = veilige keuze), ESC-close, click-outside-close. Restoreert focus na sluiten.

Twee kleuren: rood voor feestdagen (`#E74C3C`-gerelateerd), oranje voor sluitingsperiodes (`#F39C12`).

### Admin/index.html (beheer)

- Nav-item "Feestdagen" onder Operationeel (admin-only).
- Page-feestdagen volgt het admin data-view template (dv-header / dv-toolbar / table).
- CRUD: create / edit / delete \u2014 met bevestigingsmodal voor delete.
- Type-toggle in modal: switcht tussen feestdag (eindatum verborgen, recurring zichtbaar) en sluitingsperiode (eindatum verplicht, recurring forceer eenmalig).
- Auto-extend knop "Genereer YYYY" \u2192 fetch naar edge-function met admin-JWT \u2192 toast met aantal nieuw / duplicate.
- Filters: jaar (dropdown gevuld uit data + huidig + volgend jaar) en type.
- Audit-log: best-effort `auditLog('feestdagen', ...)` op create / update / delete.

## Performance

- 1\u00d7 fetch van feestdagen (\< 50 rows realistisch) bij planning-init.
- Map-based O(1) lookup tijdens render \u2014 geen array-iteratie per cel.
- Sluitingsperiodes O(n) overlap-check (n = aantal sluitingsperiodes, typisch \u2264 5/jaar).
- Geen extra DB-roundtrip per render of per cell-click.
- Banner-render alleen wanneer er minimum 1 overlap is.

## Slot 0 events

| Event | Properties | Trigger |
|---|---|---|
| `Planning Feestdag Warning Shown` | `{type, label}` | Modal opent |
| `Planning Feestdag Warning Decision` | `{decision: 'cancel'\|'proceed'}` | Modal sluit |
| `Feestdag Created` | `{type, recurring}` | Admin maakt nieuwe entry |
| `Feestdag Updated` | `{type, recurring}` | Admin bewerkt bestaande entry |
| `Feestdag Deleted` | `{type}` | Admin verwijdert entry |
| `Feestdagen Auto Extend` | `{year, inserted_count}` | Auto-extend knop succes |

Geen PII in events \u2014 alleen type + label (truncated tot 50 chars in `Warning Shown`).

## Security

- RLS verplicht admin-role voor write-operaties \u2014 ook al kan de UI verborgen zijn, de DB blokkeert vanzelf.
- `aangemaakt_door` wordt NIET via UI gezet (niet vereist) \u2014 toekomstig: trigger met `auth.uid()`.
- Edge-function accepteert service-role-JWT expliciet voor cron, maar lekt deze nooit naar client.
- Geen PII in feestdagen-tabel: alleen wettelijke / publiek-bekende data.

## Mental QA scenarios

1. **Open planning op 1 januari**: marker "Nieuwjaar" zichtbaar in week-/dag-/maand-view dag-cel of header.
2. **Klik leeg cell op 1 januari**: modal opent met titel "Je plant op een feestdag", details "Nieuwjaar — 1 jan 2026". Cancel \u2192 niets gebeurt. Proceed \u2192 dag-plus-kiezer opent normaal.
3. **Maand-view klik op cel**: zelfde flow \u2014 cancel blijft op maand, proceed switcht naar dag-view.
4. **Bouwverlof 11/7-21/7 ingevoerd door admin**: banner bovenaan week-view week 28-29, alle 9 dagen oranje gemarkeerd, soft-warning bij plannen.
5. **Auto-extend knop in admin**: maakt 10 nieuwe rijen voor 2028 als nog niet aanwezig, anders 0 nieuw / 10 duplicate.
6. **Niet-admin probeert create**: RLS blokkeert (Supabase error) \u2014 toast toont reden.
7. **Computus jaar 2030**: Pasen = 21 april \u2192 Paasmaandag 22 apr, Hemelvaart 30 mei, Pinkstermaandag 10 jun. Verifieerbaar via `?year=2030` op edge-function.

## Out of scope (toekomstige uitbreidingen)

- iCal-export van feestdagen voor externe calendar-sync.
- Per-tech / per-partner sluitingsperiode (huidig: bedrijfs-breed).
- Sector-specifieke feestdagen (bv. bouwsector kerstvakantie).
- Email-reminder vooraf bij plannen op feestdag.
- I18n-keys consumeren op admin pages (huidig: inline-fallback NL).
