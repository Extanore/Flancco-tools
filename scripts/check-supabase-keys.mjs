#!/usr/bin/env node
/**
 * scripts/check-supabase-keys.mjs
 *
 * CI-check: alle hardcoded `SUPA_URL` en `SUPA_KEY` literals in HTML/JS-files
 * moeten EXACT identiek zijn. Voorkomt de bug-klasse "key-rotation gemist in
 * één file" zoals onboard/* die maandenlang stuk was met een verlopen anon-key
 * terwijl de rest van de codebase al was bijgewerkt.
 *
 * USAGE
 *   node scripts/check-supabase-keys.mjs
 *
 *   Optional flags:
 *     --json         emit machine-readable JSON ipv human-friendly output
 *     --warn-only    exit 0 ondanks mismatches (handig voor baseline)
 *
 * EXIT CODES
 *   0  alle files consistent
 *   1  mismatch tussen files (CI fail)
 *   2  geen credentials gevonden (setup-fout)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const argv = process.argv.slice(2);
const FLAGS = {
  json: argv.includes('--json'),
  warnOnly: argv.includes('--warn-only'),
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.claude', 'docs', 'supabase',
]);
const EXTENSIONS = new Set(['.html', '.js', '.mjs']);

const KEY_PATTERN = /(?:var|let|const)\s+SUPA_KEY\s*=\s*['"]([^'"]+)['"]/g;
const URL_PATTERN = /(?:var|let|const)\s+SUPA_URL\s*=\s*['"]([^'"]+)['"]/g;

/** Walk repo and collect *.html/*.js files, skipping ignored dirs. */
function walkRepo(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SKIP_DIRS.has(entry)) continue;
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      walkRepo(full, acc);
    } else if (stat.isFile() && EXTENSIONS.has(extname(full))) {
      acc.push(full);
    }
  }
  return acc;
}

/** Extract all SUPA_KEY/SUPA_URL literals from a file. */
function extractCredentials(filepath) {
  let content;
  try { content = readFileSync(filepath, 'utf-8'); } catch { return []; }
  const found = [];
  let m;
  KEY_PATTERN.lastIndex = 0;
  while ((m = KEY_PATTERN.exec(content)) !== null) {
    found.push({ kind: 'SUPA_KEY', value: m[1] });
  }
  URL_PATTERN.lastIndex = 0;
  while ((m = URL_PATTERN.exec(content)) !== null) {
    found.push({ kind: 'SUPA_URL', value: m[1] });
  }
  return found;
}

/** Group findings by kind+value, returning Map<kind, Map<value, files[]>>. */
function groupFindings(allFindings) {
  const grouped = { SUPA_KEY: new Map(), SUPA_URL: new Map() };
  for (const { file, findings } of allFindings) {
    for (const { kind, value } of findings) {
      const m = grouped[kind];
      if (!m.has(value)) m.set(value, []);
      m.get(value).push(file);
    }
  }
  return grouped;
}

function mainCheck() {
  const files = walkRepo(ROOT);
  const allFindings = files
    .map(f => ({ file: relative(ROOT, f), findings: extractCredentials(f) }))
    .filter(x => x.findings.length > 0);

  if (allFindings.length === 0) {
    if (FLAGS.json) {
      console.log(JSON.stringify({ status: 'no-credentials-found', files_scanned: files.length }, null, 2));
    } else {
      console.error('SETUP: geen SUPA_KEY of SUPA_URL gevonden in', files.length, 'gescande files.');
    }
    process.exit(2);
  }

  const grouped = groupFindings(allFindings);
  const issues = { SUPA_KEY: null, SUPA_URL: null };

  for (const kind of ['SUPA_KEY', 'SUPA_URL']) {
    const m = grouped[kind];
    if (m.size > 1) {
      issues[kind] = Array.from(m.entries()).map(([value, files]) => ({
        value_excerpt: value.slice(0, 24) + '...' + value.slice(-8),
        files,
        count: files.length,
      }));
    }
  }

  const hasIssues = !!issues.SUPA_KEY || !!issues.SUPA_URL;

  if (FLAGS.json) {
    console.log(JSON.stringify({
      status: hasIssues ? 'mismatch' : 'consistent',
      files_scanned: files.length,
      files_with_credentials: allFindings.length,
      issues,
    }, null, 2));
  } else {
    console.log('Files gescand:', files.length);
    console.log('Files met credentials:', allFindings.length);
    if (!hasIssues) {
      console.log('OK — alle SUPA_KEY en SUPA_URL waarden zijn identiek over alle bestanden.');
    } else {
      console.error('');
      console.error('MISMATCH gedetecteerd:');
      for (const kind of ['SUPA_KEY', 'SUPA_URL']) {
        if (!issues[kind]) continue;
        console.error('');
        console.error('--', kind, '--');
        for (const { value_excerpt, files, count } of issues[kind]) {
          console.error('  variant:', value_excerpt, '(' + count + ' files)');
          for (const f of files) console.error('     ', f);
        }
      }
      console.error('');
      console.error('Actie: synchroniseer alle files naar dezelfde key/URL.');
      console.error('Haal de actuele anon-key op via Supabase dashboard of `mcp__get_publishable_keys`.');
    }
  }

  if (hasIssues && !FLAGS.warnOnly) process.exit(1);
  process.exit(0);
}

mainCheck();
