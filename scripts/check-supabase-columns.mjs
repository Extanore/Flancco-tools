#!/usr/bin/env node
/**
 * scripts/check-supabase-columns.mjs
 *
 * CI-check: cross-check Supabase `.from('table').select(...)` patterns in
 * admin/*.html + admin/shared/*.js tegen `information_schema.columns`.
 *
 * Vangt staticly de bug-klasse "kolom genoemd in code maar bestaat niet in DB"
 * (bv. `beurt_uren_registraties.eindprijs` vóór de GENERATED-kolom landde).
 *
 * USAGE
 *   DATABASE_URL=postgres://postgres:PWD@db.PROJ.supabase.co:5432/postgres \
 *     node scripts/check-supabase-columns.mjs
 *
 *   Optional flags:
 *     --json         emit machine-readable JSON ipv human-friendly output
 *     --warn-only    exit 0 zelfs bij mismatches (handig voor first-run baseline)
 *     --debug        toon parser-output per file
 *
 * EXIT CODES
 *   0  geen issues
 *   1  mismatches gevonden (CI fail)
 *   2  setup-fout (env-var ontbreekt, db-fail, etc.)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const SCAN_TARGETS = [
  { path: 'admin', recursive: true, exts: ['.html', '.js'] },
];

// PostgREST/Supabase-pseudokolom-modifiers die niet in information_schema staan.
const PSEUDO_COLS = new Set([
  '*',
  'count',
  'count(*)',
  // arrow-style nested-json paths (`field->subfield`) worden ge-stript naar `field`,
  // dus geen aparte entries nodig — split op `->` gebeurt in parser.
]);

// Tabel-namen die we expres skippen (geen public-tabel, of dynamisch gevormd).
const IGNORED_TABLES = new Set([
  // Voorbeeld: rpc-functies die via `.from()` worden aangesproken in legacy code.
]);

// Token voor flag-comment in de code: `// supabase-check-ignore-next`
// Wordt gebruikt om bewust dynamische selects (template-literals met expressies) te skippen.
const IGNORE_NEXT_MARKER = 'supabase-check-ignore-next';

const FLAGS = new Set(process.argv.slice(2));
const JSON_OUTPUT = FLAGS.has('--json');
const WARN_ONLY = FLAGS.has('--warn-only');
const DEBUG = FLAGS.has('--debug');

// ─────────────────────────────────────────────────────────────────────────────
// File walking
// ─────────────────────────────────────────────────────────────────────────────

function* walk(absDir, exts) {
  if (!existsSync(absDir)) return;
  for (const entry of readdirSync(absDir)) {
    if (entry.startsWith('.')) continue;
    const full = join(absDir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full, exts);
    } else if (exts.includes(extname(entry))) {
      yield full;
    }
  }
}

function collectFiles() {
  const out = [];
  for (const target of SCAN_TARGETS) {
    const abs = join(REPO_ROOT, target.path);
    if (target.recursive) {
      for (const f of walk(abs, target.exts)) out.push(f);
    } else if (existsSync(abs) && target.exts.includes(extname(abs))) {
      out.push(abs);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
//
// We zoeken naar `.from('TABLE')...` gevolgd binnen een redelijke afstand door
// `.select('LITERAL_STRING')`. We negeren bewust:
//   - .select() zonder argumenten (insert/update flows)
//   - .select(`template ${expr} literal`)  — dynamic, kunnen we niet veilig parsen
//   - .from(variable) — dynamic table name
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match `.from('table')` start-positie en tabel-naam.
 * Returns array of {tableStart, tableEnd, table}.
 */
function findFromCalls(content) {
  const re = /\.from\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)/gi;
  const out = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, table: m[1] });
  }
  return out;
}

/**
 * Vanaf `.from(...)` einde, zoek het eerstvolgende `.select(...)` binnen WINDOW chars
 * dat onderdeel is van dezelfde method-chain (alleen whitespace, comments en `.foo(...)`
 * tussenin). Returned ofwel { ok:false, reason } ofwel { ok:true, raw, dynamic, fromIndex }.
 */
const SELECT_WINDOW = 2000;

function findSelectAfter(content, fromEnd) {
  // Scan vooruit: spring over whitespace, kommentaar, en chain-calls (.x(...)) die geen select zijn.
  let i = fromEnd;
  const limit = Math.min(content.length, fromEnd + SELECT_WINDOW);
  while (i < limit) {
    const ch = content[i];
    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    // Line-comment
    if (ch === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i);
      i = nl === -1 ? content.length : nl + 1;
      continue;
    }
    // Block comment
    if (ch === '/' && content[i + 1] === '*') {
      const close = content.indexOf('*/', i + 2);
      i = close === -1 ? content.length : close + 2;
      continue;
    }
    // Verwachten een `.`
    if (ch !== '.') return { ok: false, reason: 'no-method-chain' };
    // Lees method-naam
    let j = i + 1;
    while (j < limit && /[a-zA-Z0-9_$]/.test(content[j])) j++;
    const method = content.slice(i + 1, j);
    // Verwacht `(`
    if (content[j] !== '(') return { ok: false, reason: 'no-paren' };
    // Find matching close-paren met depth-tracking en string-awareness.
    const closeIdx = findMatchingClose(content, j);
    if (closeIdx === -1) return { ok: false, reason: 'unbalanced-paren' };
    if (method === 'select') {
      const inner = content.slice(j + 1, closeIdx).trim();
      if (inner === '') {
        return { ok: false, reason: 'select-empty' }; // .select() zonder arg
      }
      // Eerste arg uit `.select(arg, opts?)` — split op top-level komma.
      const firstArg = sliceFirstArg(inner);
      const litCheck = parseStringLiteral(firstArg.trim());
      if (!litCheck.ok) {
        return { ok: false, reason: 'dynamic-select', raw: firstArg.slice(0, 80) };
      }
      return { ok: true, raw: litCheck.value, dynamic: false };
    }
    // Het was een andere chain-call (eq, order, ...) — spring eroverheen en ga door.
    i = closeIdx + 1;
  }
  return { ok: false, reason: 'no-select-found' };
}

/**
 * Vind matching `)` voor `(` op `openIdx`, respecterend strings, template-literals en geneste parens.
 */
function findMatchingClose(s, openIdx) {
  let depth = 0;
  let i = openIdx;
  let inStr = null; // ' " `
  while (i < s.length) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inStr) { inStr = null; i++; continue; }
      // Voor template-literals: `${...}` heeft eigen depth; we behandelen dit conservatief
      // door binnen `\`` enkel op de afsluitende backtick te letten. Geneste expressies
      // breken depth-tracking maar zijn zeldzaam en de outer-paren komen toch uit.
      i++;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inStr = ch; i++; continue; }
    if (ch === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      const close = s.indexOf('*/', i + 2);
      i = close === -1 ? s.length : close + 2;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Slice de eerste top-level argument uit een arg-list-string (zonder omhullende parens).
 * Respect strings en geneste parens.
 */
function sliceFirstArg(argList) {
  let depth = 0;
  let inStr = null;
  for (let i = 0; i < argList.length; i++) {
    const ch = argList[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) return argList.slice(0, i);
  }
  return argList;
}

/**
 * Parse een string-literal (single, double, of backtick zonder interpolatie).
 * Returns { ok:true, value } of { ok:false } bij dynamic content.
 */
function parseStringLiteral(s) {
  if (s.length < 2) return { ok: false };
  const q = s[0];
  if (q !== '\'' && q !== '"' && q !== '`') return { ok: false };
  if (s[s.length - 1] !== q) return { ok: false };
  const body = s.slice(1, -1);
  // Backtick met `${...}` → dynamisch
  if (q === '`' && body.includes('${')) return { ok: false };
  // Strip simple escapes
  return { ok: true, value: body.replace(/\\(['"`\\])/g, '$1') };
}

/**
 * Splits een select-string op top-level kommas (zonder embedded relations te splitsen).
 */
function splitTopLevelCommas(s) {
  const out = [];
  let buf = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * Parse één kolom-token. Returns een lijst van {table, col} pairs:
 *   - simple col          → [{ table:null, col:'foo' }]
 *   - alias:col           → [{ table:null, col:'col' }]   (alias-naam genegeerd)
 *   - col!modifier        → [{ table:null, col:'col' }]
 *   - col->json_path      → [{ table:null, col:'col' }]
 *   - relation(a,b,c)     → [{ table:'relation', col:'a' }, ... ]   recursief
 *   - alias:relation(a,b) → idem maar table = relation
 *   - relation!fk(a,b)    → table = relation
 *   - relation!inner(a,b) → table = relation
 *
 * Voor inline-views/RPC die niet in schema staan: caller skipt onbekende tabel.
 */
function parseColumnToken(token) {
  // Verwijder evt. `as alias` suffix (PostgREST gebruikt `:` maar JS-mensen typen soms alias)
  // PostgREST officiële alias-syntax = `alias:column` of `alias:relation(...)`.
  let t = token.trim();
  if (!t) return [];

  // Detecteer relation-embed: bevat `(` op top-level
  const parenIdx = t.indexOf('(');
  if (parenIdx !== -1) {
    // links van `(` is `[alias:]relation[!modifier]`
    const left = t.slice(0, parenIdx).trim();
    const innerStart = parenIdx + 1;
    const innerEnd = findMatchingCloseSimple(t, parenIdx);
    if (innerEnd === -1) return [];
    const inner = t.slice(innerStart, innerEnd);
    const relation = stripAliasAndModifier(left);
    if (!relation) return [];
    const innerCols = splitTopLevelCommas(inner)
      .flatMap(parseColumnToken)
      .map(c => ({ table: c.table || relation, col: c.col }));
    return innerCols;
  }

  // Geen embed: simple col met eventueel alias en/of modifiers
  // alias:col!modifier::cast → strip alias, modifier, cast
  const stripped = stripAliasAndModifier(t);
  if (!stripped) return [];
  // JSON-path: `field->sub` of `field->>sub` — keep `field`
  const fieldOnly = stripped.split('->')[0].trim();
  if (!fieldOnly) return [];
  if (PSEUDO_COLS.has(fieldOnly)) return [];
  if (!/^[a-z_][a-z0-9_]*$/i.test(fieldOnly)) return []; // weird tokens, skip
  return [{ table: null, col: fieldOnly }];
}

function findMatchingCloseSimple(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Strip alias-prefix (`alias:`) en !modifier suffix (`!inner`, `!fk_name`),
 * en `::cast` suffix. Returns kolom/relation-naam of '' bij ongeldig.
 */
function stripAliasAndModifier(tok) {
  let t = tok.trim();
  // Strip alias `alias:rest`
  const colonIdx = t.indexOf(':');
  if (colonIdx !== -1) {
    // Pas op: `field::cast` heeft dubbele colon
    if (t[colonIdx + 1] !== ':') {
      t = t.slice(colonIdx + 1).trim();
    }
  }
  // Strip ::cast
  const castIdx = t.indexOf('::');
  if (castIdx !== -1) t = t.slice(0, castIdx).trim();
  // Strip !modifier
  const bangIdx = t.indexOf('!');
  if (bangIdx !== -1) t = t.slice(0, bangIdx).trim();
  return t;
}

/**
 * Parse de select-string van één `.from(table).select(SELECT)` call.
 * Returns array of {table, col} pairs (table is altijd ingevuld — primaire of relation).
 */
function parseSelectString(rootTable, selectStr) {
  if (selectStr.trim() === '*') return [];
  const tokens = splitTopLevelCommas(selectStr);
  const out = [];
  for (const tok of tokens) {
    const parsed = parseColumnToken(tok);
    for (const p of parsed) {
      out.push({ table: p.table || rootTable, col: p.col });
    }
  }
  return out;
}

/**
 * Hoofd-extractor. Returns array of {file, line, table, cols, raw, ignored?}.
 */
function extractAllFromFile(absPath, content) {
  const fromCalls = findFromCalls(content);
  const out = [];
  for (const f of fromCalls) {
    // Check op ignore-marker op de regel ervoor
    const lineStart = content.lastIndexOf('\n', f.start - 1) + 1;
    const prevNewline = content.lastIndexOf('\n', lineStart - 2);
    const prevLine = content.slice(prevNewline + 1, lineStart);
    const isIgnored = prevLine.includes(IGNORE_NEXT_MARKER);

    const sel = findSelectAfter(content, f.end);
    const lineNum = content.slice(0, f.start).split('\n').length;

    if (!sel.ok) {
      // Stille skip; debug-mode toont reden.
      if (DEBUG) {
        out.push({
          file: absPath,
          line: lineNum,
          table: f.table,
          skipped: true,
          reason: sel.reason,
          raw: sel.raw,
        });
      }
      continue;
    }
    const cols = parseSelectString(f.table, sel.raw);
    out.push({
      file: absPath,
      line: lineNum,
      table: f.table,
      cols,
      raw: sel.raw.length > 120 ? sel.raw.slice(0, 117) + '...' : sel.raw,
      ignored: isIgnored,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema fetcher
// ─────────────────────────────────────────────────────────────────────────────

async function fetchSchema() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL env-var ontbreekt.');
    console.error('');
    console.error('Get connection-string via: Supabase Dashboard → Project Settings → Database → Connection string → URI.');
    console.error('Run als:');
    console.error('  DATABASE_URL=\'postgres://postgres.PROJ:PWD@aws-0-eu-central-1.pooler.supabase.com:6543/postgres\' \\');
    console.error('    node scripts/check-supabase-columns.mjs');
    process.exit(2);
  }

  let pg;
  try {
    pg = await import('pg');
  } catch (e) {
    console.error('ERROR: `pg` package niet geïnstalleerd.');
    console.error('Run: npm install --no-save pg   (of: npm i -D pg)');
    process.exit(2);
  }

  const Client = pg.default?.Client || pg.Client;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
  } catch (e) {
    console.error('ERROR: db-connect faalde:', e.message);
    process.exit(2);
  }

  const sql = `
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;
  const { rows } = await client.query(sql);
  await client.end();

  const schema = new Map();
  for (const r of rows) {
    if (!schema.has(r.table_name)) schema.set(r.table_name, new Set());
    schema.get(r.table_name).add(r.column_name);
  }
  return schema;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

function formatHuman(report) {
  const { mismatches, unknownTables, dynamicSelects, summary } = report;

  const C = {
    red: (s) => process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s,
    yellow: (s) => process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s,
    green: (s) => process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s,
    dim: (s) => process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s,
    bold: (s) => process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s,
  };

  const lines = [];
  lines.push('');
  lines.push(C.bold('Supabase column-check'));
  lines.push(C.dim('─'.repeat(60)));
  lines.push(`Schema      : ${summary.tableCount} tabellen, ${summary.columnCount} kolommen`);
  lines.push(`Files       : ${summary.fileCount}`);
  lines.push(`Selects     : ${summary.selectCount} (${summary.uniqueColumnRefCount} unique col-refs)`);
  lines.push('');

  if (mismatches.length === 0 && unknownTables.length === 0) {
    lines.push(C.green('✓ Alle kolom-referenties matchen het live schema.'));
  }

  if (mismatches.length > 0) {
    lines.push(C.red(`✗ ${mismatches.length} mismatch(es) — kolom genoemd in code maar niet in DB:`));
    lines.push('');
    for (const m of mismatches) {
      const rel = relative(REPO_ROOT, m.file);
      lines.push(`  ${C.red(m.table + '.' + m.col)}`);
      lines.push(`    ${C.dim(rel + ':' + m.line)}`);
      lines.push(`    ${C.dim('select: ' + m.raw)}`);
      const candidates = m.candidates || [];
      if (candidates.length > 0) {
        lines.push(`    ${C.yellow('did you mean: ' + candidates.join(', ') + '?')}`);
      }
      lines.push('');
    }
  }

  if (unknownTables.length > 0) {
    lines.push(C.yellow(`⚠ ${unknownTables.length} unknown table reference(s) (skipped):`));
    for (const u of unknownTables) {
      const rel = relative(REPO_ROOT, u.file);
      lines.push(`  ${C.dim(rel + ':' + u.line)} → ${u.table}`);
    }
    lines.push('');
  }

  if (DEBUG && dynamicSelects.length > 0) {
    lines.push(C.dim(`(debug) ${dynamicSelects.length} dynamic select(s) geskipt:`));
    for (const d of dynamicSelects) {
      lines.push(C.dim(`  ${relative(REPO_ROOT, d.file)}:${d.line} → ${d.reason}`));
    }
    lines.push('');
  }

  lines.push(C.dim('─'.repeat(60)));
  if (mismatches.length > 0) {
    lines.push(WARN_ONLY ? C.yellow('Result: FAIL (warn-only mode → exit 0)') : C.red('Result: FAIL'));
  } else {
    lines.push(C.green('Result: OK'));
  }
  return lines.join('\n');
}

/**
 * Lev-distance voor "did you mean" hints (max 3 suggestions, edit-distance ≤ 3).
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function suggestColumns(target, candidates) {
  return [...candidates]
    .map(c => ({ c, d: levenshtein(target, c) }))
    .filter(x => x.d <= Math.max(2, Math.floor(target.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(x => x.c);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const schema = await fetchSchema();
  const tableCount = schema.size;
  const columnCount = [...schema.values()].reduce((a, s) => a + s.size, 0);

  const files = collectFiles();
  const allRefs = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const refs = extractAllFromFile(file, content);
    for (const r of refs) allRefs.push(r);
  }

  const mismatches = [];
  const unknownTables = [];
  const dynamicSelects = [];
  const seenUnknownTable = new Set();
  let selectCount = 0;
  let uniqueColumnRefCount = 0;
  const seenColRef = new Set();

  for (const ref of allRefs) {
    if (ref.skipped) {
      dynamicSelects.push(ref);
      continue;
    }
    if (ref.ignored) continue;
    selectCount++;
    if (IGNORED_TABLES.has(ref.table)) continue;
    if (!schema.has(ref.table)) {
      const key = ref.file + ':' + ref.line + ':' + ref.table;
      if (!seenUnknownTable.has(key)) {
        seenUnknownTable.add(key);
        unknownTables.push({ file: ref.file, line: ref.line, table: ref.table });
      }
      continue;
    }
    for (const { table, col } of ref.cols) {
      const dedup = table + '.' + col;
      if (!seenColRef.has(dedup)) {
        seenColRef.add(dedup);
        uniqueColumnRefCount++;
      }
      if (!schema.has(table)) {
        // embedded relation refereert naar onbekende tabel/view
        continue;
      }
      const tableCols = schema.get(table);
      if (!tableCols.has(col)) {
        const candidates = suggestColumns(col, tableCols);
        mismatches.push({
          file: ref.file,
          line: ref.line,
          table,
          col,
          raw: ref.raw,
          candidates,
        });
      }
    }
  }

  const report = {
    summary: {
      tableCount,
      columnCount,
      fileCount: files.length,
      selectCount,
      uniqueColumnRefCount,
      mismatchCount: mismatches.length,
    },
    mismatches,
    unknownTables,
    dynamicSelects,
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, (k, v) => k === 'file' ? relative(REPO_ROOT, v) : v, 2));
  } else {
    console.log(formatHuman(report));
  }

  if (mismatches.length > 0 && !WARN_ONLY) process.exit(1);
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e?.stack || e);
  process.exit(2);
});
