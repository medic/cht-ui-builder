/**
 * Corpus sweep — no-op round-trips over every real cht-conf project on this machine.
 *
 * Usage:
 *   node scripts/corpus-sweep.mjs                     # discover configs, sweep them all
 *   node scripts/corpus-sweep.mjs <path> [<path>...]  # sweep only these project folders
 *   node scripts/corpus-sweep.mjs --list              # discovery only, no sweep
 *
 * This is the QA "local corpus sweep" from docs/principle-config-agnostic.md:
 * one config is not a passing grade, so a change to `shared/` runs this against
 * whatever real configs the machine has before it's called done. Customer
 * configs are never committed as fixtures — this script visits them in place.
 *
 * STRICTLY READ-ONLY: the script never writes inside a config folder. All
 * serializer output stays in memory; the only outputs are stdout and the
 * process exit code (nonzero if any surface drifted, so this can gate "done").
 *
 * Per config it runs the no-op parse → serialize round-trip on each surface
 * and counts drift:
 *   - forms/app/*.xlsx, forms/contact/*.xlsx   parse → serialize → re-parse,
 *     compare the FULL parsed model (smoke-parser's approach, but the whole
 *     AST rather than a summary — .xlsx is a zip container, so byte-comparing
 *     the archive itself would only measure zip metadata)
 *   - tasks.js                                 parse → rebuild, byte-compare;
 *     plus entries parsed / pristine per isEntryPristine
 *   - contact-summary.templated.js             context parse → serialize with
 *     the SAME flags/order, byte-compare
 *   - translations/messages-*.properties       parse → serialize, byte-compare;
 *     plus duplicate-key counts (all four real configs have duplicates)
 *
 * Note: this script is run with Node, so it imports the COMPILED `shared`
 * package from `shared/dist/`. Build first with: pnpm --filter @cht-ui/shared build
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = path.join(repoRoot, 'shared', 'dist', 'index.js');
if (!existsSync(distEntry)) {
  console.error('shared/dist/index.js not found — build shared first:');
  console.error('  pnpm --filter @cht-ui/shared build');
  process.exit(2);
}
const shared = await import(pathToFileURL(distEntry).href);

// Every surface degrades to 'n/a' if the export pair doesn't exist, rather
// than guessing at a different function.
const has = (...names) => names.every((n) => typeof shared[n] === 'function');

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'tmp']);
const skipDir = (name) => name.startsWith('.') || SKIP_DIRS.has(name);

function looksLikeProject(dir) {
  return (
    existsSync(path.join(dir, 'forms', 'app')) ||
    existsSync(path.join(dir, 'app_settings')) ||
    existsSync(path.join(dir, 'app_settings.json')) ||
    existsSync(path.join(dir, 'base_settings.json'))
  );
}

/**
 * Find project roots up to 2 levels below `scanRoot`, so nested layouts like
 * config-nssd/chis and config-gandaki/cht-config are found (the project root
 * sits below the git root in 3 of the 4 real configs). A dir that qualifies is
 * recorded and not descended into — no nested-project hunting inside projects.
 */
async function discover(scanRoot) {
  const found = [];
  if (looksLikeProject(scanRoot)) return [scanRoot];
  const level1 = await readdir(scanRoot, { withFileTypes: true }).catch(() => []);
  for (const d1 of level1) {
    if (!d1.isDirectory() || skipDir(d1.name)) continue;
    const p1 = path.join(scanRoot, d1.name);
    if (looksLikeProject(p1)) {
      found.push(p1);
      continue;
    }
    const level2 = await readdir(p1, { withFileTypes: true }).catch(() => []);
    for (const d2 of level2) {
      if (!d2.isDirectory() || skipDir(d2.name)) continue;
      const p2 = path.join(p1, d2.name);
      if (looksLikeProject(p2)) found.push(p2);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Per-surface round-trips (all in memory — nothing is ever written to disk)
// ---------------------------------------------------------------------------

/** XLSForm: parse → serialize → re-parse, full-model compare. */
async function sweepFormsDir(dir) {
  const result = { present: false, total: 0, stable: 0, errors: [], unstable: [] };
  if (!existsSync(dir)) return result;
  result.present = true;
  const files = (await readdir(dir))
    .filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
    .sort();
  for (const f of files) {
    result.total++;
    try {
      const buf = await readFile(path.join(dir, f));
      const form1 = await shared.parseXlsForm(buf);
      const bytes = await shared.serializeXlsForm(form1);
      const form2 = await shared.parseXlsForm(bytes);
      if (JSON.stringify(form1) === JSON.stringify(form2)) {
        result.stable++;
        process.stdout.write('.');
      } else {
        const keys = new Set([...Object.keys(form1), ...Object.keys(form2)]);
        const loci = [...keys].filter(
          (k) => JSON.stringify(form1[k]) !== JSON.stringify(form2[k]),
        );
        result.unstable.push({ name: f, loci });
        process.stdout.write('x');
      }
    } catch (err) {
      result.errors.push({ name: f, message: String(err?.message ?? err) });
      process.stdout.write('E');
    }
  }
  if (files.length > 0) process.stdout.write('\n');
  return result;
}

/** tasks.js: parse → rebuild, byte-compare; count pristine entries. */
async function sweepTasks(root) {
  const file = path.join(root, 'tasks.js');
  if (!existsSync(file)) return { present: false };
  if (!has('parseTaskFile', 'rebuildTaskFile')) return { present: true, na: 'no parser pair' };
  const source = await readFile(file, 'utf8');
  const parsed = shared.parseTaskFile(source);
  const rebuilt = shared.rebuildTaskFile(parsed);
  const pristine = has('isEntryPristine')
    ? parsed.entries.filter((e) => shared.isEntryPristine(e)).length
    : null;
  return {
    present: true,
    entries: parsed.entries.length,
    pristine,
    arrayFound: parsed.arrayBounds != null,
    stable: rebuilt === source,
  };
}

/** contact-summary.templated.js: context parse → serialize same flags/order, byte-compare. */
async function sweepContactSummary(root) {
  const file = path.join(root, 'contact-summary.templated.js');
  if (!existsSync(file)) return { present: false };
  if (!has('parseContactSummary', 'serializeContactSummary')) {
    return { present: true, na: 'no parser pair' };
  }
  const source = await readFile(file, 'utf8');
  const parsed = shared.parseContactSummary(source);
  if (parsed.contextBounds == null) return { present: true, na: 'context not recognized' };
  const out = shared.serializeContactSummary(parsed, parsed.contextFlags, parsed.contextOrder);
  return { present: true, flags: parsed.contextOrder.length, stable: out === source };
}

/** translations/messages-*.properties: parse → serialize byte-compare + duplicate keys. */
async function sweepTranslations(root) {
  const dir = path.join(root, 'translations');
  const result = { present: false, total: 0, stable: 0, unstable: [], duplicates: [] };
  if (!existsSync(dir)) return result;
  result.present = true;
  if (!has('parseProperties', 'serializeProperties')) return { present: true, na: 'no parser pair' };
  const files = (await readdir(dir))
    .filter((f) => /^messages-.*\.properties$/.test(f))
    .sort();
  for (const f of files) {
    result.total++;
    const source = await readFile(path.join(dir, f), 'utf8');
    const parsed = shared.parseProperties(source);
    if (shared.serializeProperties(parsed) === source) result.stable++;
    else result.unstable.push(f);
    const seen = new Map();
    for (const line of parsed) {
      if (line.kind === 'entry') seen.set(line.key, (seen.get(line.key) ?? 0) + 1);
    }
    let dupKeys = 0;
    for (const n of seen.values()) if (n > 1) dupKeys++;
    result.duplicates.push({ name: f, dupKeys });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const explicit = argv.filter((a) => a !== '--list');

let roots = [];
if (explicit.length > 0) {
  // Explicit paths: resolve each to the project root(s) it contains.
  for (const arg of explicit) {
    const p = path.resolve(arg);
    if (!existsSync(p)) {
      console.error(`# not found on disk, skipping: ${p}`);
      continue;
    }
    const found = await discover(p);
    if (found.length === 0) console.error(`# no cht-conf project under (2 levels): ${p}`);
    for (const r of found) roots.push(r);
  }
} else {
  // No args: scan W:\medic and the repo's own parent (deduped when identical).
  const scanRoots = [...new Set([path.dirname(repoRoot), 'W:\\medic'].map((p) => path.resolve(p)))]
    .filter((p) => existsSync(p));
  console.log('# scanning for cht-conf projects (2 levels) under:');
  for (const s of scanRoots) console.log(`#   ${s}`);
  for (const s of scanRoots) roots.push(...(await discover(s)));
}
roots = [...new Set(roots.map((r) => path.resolve(r)))].sort();

console.log(`# discovered ${roots.length} project root(s):`);
for (const r of roots) console.log(`#   ${r}`);
if (listOnly) process.exit(0);
if (roots.length === 0) {
  console.error('Nothing to sweep.');
  process.exit(2);
}

const label = (root) => path.join(path.basename(path.dirname(root)), path.basename(root));
const rows = [];
let anyDrift = false;

for (const root of roots) {
  const started = Date.now();
  console.log(`\n== ${root}`);

  const app = await sweepFormsDir(path.join(root, 'forms', 'app'));
  const contact = await sweepFormsDir(path.join(root, 'forms', 'contact'));
  const tasks = await sweepTasks(root);
  const cs = await sweepContactSummary(root);
  const tr = await sweepTranslations(root);

  const notes = [];
  for (const [name, r] of [['app', app], ['contact', contact]]) {
    for (const u of r.unstable.slice(0, 3)) {
      notes.push(`${name}:${u.name} drift[${u.loci.join(',')}]`);
    }
    if (r.unstable.length > 3) notes.push(`${name}:+${r.unstable.length - 3} more`);
    for (const e of r.errors.slice(0, 2)) notes.push(`${name}:${e.name} ERROR ${e.message}`);
    if (r.errors.length > 2) notes.push(`${name}:+${r.errors.length - 2} more errors`);
  }
  if (tasks.present && !tasks.na && !tasks.arrayFound) notes.push('tasks: exports array not found');
  if (cs.present && cs.na) notes.push(`cs: ${cs.na}`);
  if (tr.unstable?.length) notes.push(`tr drift: ${tr.unstable.slice(0, 3).join(', ')}`);

  const formsCell = (r) =>
    !r.present ? '-' : `${r.stable}/${r.total}` + (r.errors.length ? ` (${r.errors.length}E)` : '');
  const tasksCell = !tasks.present
    ? '-'
    : tasks.na
      ? 'n/a'
      : `${tasks.stable ? 'ok' : 'DRIFT'} ${tasks.pristine ?? '?'}/${tasks.entries}p`;
  const csCell = !cs.present ? '-' : cs.na ? 'n/a' : cs.stable ? 'ok' : 'DRIFT';
  const trCell = !tr.present ? '-' : tr.na ? 'n/a' : `${tr.stable}/${tr.total}`;
  const dupCell = tr.duplicates?.length
    ? tr.duplicates.map((d) => `${d.name.replace(/^messages-|\.properties$/g, '')}:${d.dupKeys}`).join(' ')
    : '-';

  const drift =
    app.unstable.length + app.errors.length > 0 ||
    contact.unstable.length + contact.errors.length > 0 ||
    (tasks.present && !tasks.na && !tasks.stable) ||
    (cs.present && !cs.na && !cs.stable) ||
    (tr.unstable?.length ?? 0) > 0;
  if (drift) anyDrift = true;

  console.log(
    `   app ${formsCell(app)} | contact ${formsCell(contact)} | tasks ${tasksCell} | cs ${csCell} | translations ${trCell} | ${Date.now() - started}ms`,
  );
  for (const n of notes) console.log(`   note: ${n}`);

  rows.push([label(root), formsCell(app), formsCell(contact), tasksCell, csCell, trCell, dupCell, notes.join('; ') || (drift ? '' : 'clean')]);
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------

const headers = ['config', 'app forms', 'contact forms', 'tasks.js', 'contact-summary', 'translations', 'dup keys', 'notes'];
const cap = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const printable = rows.map((r) => r.map((c, i) => cap(String(c), i === 7 ? 70 : 40)));
const widths = headers.map((h, i) => Math.max(h.length, ...printable.map((r) => r[i].length)));
const line = (cells) => '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
console.log('\n# Summary (stable/total per surface; dup keys = duplicated keys per file, last-wins in CHT)');
console.log(line(headers));
console.log('|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|');
for (const r of printable) console.log(line(r));

console.log(anyDrift ? '\nDRIFT DETECTED — some surface is not a no-op round-trip.' : '\nAll surfaces stable.');
process.exitCode = anyDrift ? 1 : 0;
