# scripts/

CI-scripts en developer-utilities voor het Flancco-platform.

---

## `check-supabase-columns.mjs`

Statische cross-check: vangt **kolomnaam-mismatches** tussen frontend-code en de live Supabase-database, vóór ze runtime-bugs worden.

**Voorbeeld-bug die dit scriptelijk gevangen had:**
> `admin/index.html` selecteerde `beurt_uren_registraties.eindprijs`, maar die kolom bestond niet in de DB. Pas via Preview-runtime ontdekt.

### Wat het doet

1. Scant `admin/*.html` en `admin/shared/*.js` op alle Supabase `.from('table').select(...)`-patterns.
2. Parseert tabel-naam + alle geselecteerde kolommen — inclusief embedded relations zoals `uren:beurt_uren_registraties(id, eindprijs)`, alias-prefixes, JSON-paths (`->`), modifiers (`!inner`) en casts (`::text`).
3. Cross-checkt elke `(table, col)`-paar tegen `information_schema.columns` van het live schema.
4. Rapporteert mismatches (incl. "did you mean?"-suggesties via Levenshtein-distance), unknown tables en — in debug-mode — dynamic selects die geskipt zijn.

### Setup

#### 1. Connection-string ophalen

Supabase Dashboard → **Project Settings** → **Database** → **Connection string** → tab **URI** (of **Connection pooler** voor IPv4-only netwerken).

Plak in een lokale `.env`-file (gitignored) of exporteer in shell:

```bash
export DATABASE_URL='postgres://postgres.dhuqpxwwavqyxaelxuzl:JOUW_PASSWORD@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'
```

> Gebruik de **Session pooler** (poort 6543) of **Transaction pooler** voor CI — directe `db.PROJ.supabase.co:5432` werkt soms niet vanuit GitHub Actions runners.

#### 2. `pg`-package installeren

Het script gebruikt een dynamic import van `pg`, dus geen permanente devDep nodig:

```bash
npm install --no-save pg
```

(Op CI: gewoon `npm i pg` in een ephemerale step — zie YAML hieronder.)

### Lokaal runnen

```bash
node scripts/check-supabase-columns.mjs
```

#### Flags

| Flag           | Effect                                                                          |
| -------------- | ------------------------------------------------------------------------------- |
| `--json`       | Machine-readable output (voor pipeline-parsing of dashboards)                   |
| `--warn-only`  | Exit 0 zelfs bij mismatches — handig voor first-run baseline                    |
| `--debug`      | Toon ook geskipte dynamic selects en hun reden                                  |

#### Exit codes

| Code | Betekenis                                              |
| ---- | ------------------------------------------------------ |
| `0`  | Geen mismatches                                        |
| `1`  | Mismatches gevonden (CI fail)                          |
| `2`  | Setup-fout: env-var ontbreekt, db-connect fout, etc.   |

### Inline-ignore

Voor bewust dynamische selects (template-literals met expressies, RPC-aliases) — voeg een marker toe op de regel ervoor:

```js
// supabase-check-ignore-next
const { data } = await sb.from('contracten').select(`id, ${dynamicCols}`);
```

Het script slaat de eerstvolgende `.from(...)` over.

### CI-integratie — GitHub Actions

`.github/workflows/db-check.yml`:

```yaml
name: db-column-check

on:
  pull_request:
    paths:
      - 'admin/**'
      - 'scripts/check-supabase-columns.mjs'
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install pg
        run: npm install --no-save pg
      - name: Run column check
        env:
          DATABASE_URL: ${{ secrets.SUPABASE_DATABASE_URL }}
        run: node scripts/check-supabase-columns.mjs
```

Voeg `SUPABASE_DATABASE_URL` toe als GitHub-secret (Settings → Secrets and variables → Actions). Gebruik bij voorkeur een **read-only DB-user** in plaats van het master `postgres` account.

### Bekende parser-limieten

Het script is een statische analyse zonder JS-execution. Volgende patterns worden bewust **niet** gevalideerd (en worden geskipt):

- **Dynamic select-strings**: `\`id, ${cols}\`` of `\`id, \${(condition ? 'a' : 'b')}\``  → markeer met `// supabase-check-ignore-next` om ruis te vermijden, of breek op naar een literal.
- **Variabele tabel-namen**: `sb.from(tableName)` → script vereist string-literal in `.from()`.
- **Constant-folded select-strings**: `const SELECT = 'id, naam'; sb.from('x').select(SELECT)` → tweede arg is variabele, niet literal. Workaround: inline literaal of gebruik ignore-marker.
- **Computed column refs in `.eq('col', ...)`-filters**: niet binnen scope (script controleert alléén `.select()`-args).
- **Generated columns / views met RLS-row-filters**: geen probleem — het script leest gewoon `information_schema.columns` voor zowel tabellen als views.

### Maintenance

Wanneer een nieuwe shared `.js` of HTML-page met Supabase-calls wordt toegevoegd buiten `admin/`, breid `SCAN_TARGETS` bovenaan het script uit. Voor nieuwe pseudo-kolommen (PostgREST-features), update `PSEUDO_COLS`.
