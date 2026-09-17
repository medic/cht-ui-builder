/**
 * CI guard: every starter template must be deployable AS SHIPPED.
 *
 * Usage:
 *   node scripts/validate-templates.mjs            # all templates, temp dirs, cleans up
 *   node scripts/validate-templates.mjs blank      # one template
 *   node scripts/validate-templates.mjs --keep     # leave the copies on disk
 *
 * For each directory under server/templates/ this copies the template
 * (INCLUDING dotfiles — an earlier `cp -r dir/*` missed `.eslintrc` and
 * produced a false failure), installs its declared dependencies if it ships a
 * package.json, and runs the offline half of the cht-conf toolchain against
 * the copy:
 *
 *   compile-app-settings  convert-app-forms  validate-app-forms
 *   convert-contact-forms validate-contact-forms
 *
 * Exits nonzero if any template fails any step.
 *
 * ## Why this exists
 *
 * A standing PO directive says every template ships minimal-valid versions of
 * ALL cht-conf-required files (decision_templates_ship_required_minimal), and
 * the hosted authoring plan's definition of done is "a project that passes
 * compile + convert + validate". Yet nothing checked it: `cht-default`, the
 * obvious "show me what CHT can do" template, did not compile because its
 * extras `require('moment')` with nothing to resolve it. Found by hand on
 * 2026-08-20 (docs/plans/hosted-authoring.md §9). This script would have
 * caught it, and catches the next one.
 *
 * Requires python3 + pyxform on PATH (cht-conf shells out to xls2xform for
 * convert-*-forms) and npm for templates with a package.json. Runs unchanged
 * inside the Dockerfile image, which is the reference environment.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TEMPLATES = path.join(REPO, 'server', 'templates');
const KEEP = process.argv.includes('--keep');
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const chtBinPath = createRequire(path.join(REPO, 'server', 'package.json')).resolve(
  'cht-conf/src/bin/index.js',
);

/** The offline toolchain. `--skip-version-check` keeps cht-conf off the network. */
const STEPS = [
  'compile-app-settings',
  'convert-app-forms',
  'validate-app-forms',
  'convert-contact-forms',
  'validate-contact-forms',
];

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function tail(text, n = 25) {
  return text.trim().split('\n').slice(-n).join('\n');
}

const templates = readdirSync(TEMPLATES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => ONLY.length === 0 || ONLY.includes(name));

if (templates.length === 0) {
  console.error(`No templates matched ${ONLY.join(', ')} under ${TEMPLATES}`);
  process.exit(2);
}

const work = mkdtempSync(path.join(os.tmpdir(), 'cht-ui-templates-'));
let failed = 0;

for (const name of templates) {
  const src = path.join(TEMPLATES, name);
  const dest = path.join(work, name);
  // cpSync copies dotfiles; that is the point (see header).
  cpSync(src, dest, { recursive: true });
  console.log(`\n=== template: ${name} → ${dest}`);

  if (existsSync(path.join(dest, 'package.json'))) {
    const r = run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], dest);
    if (r.code !== 0) {
      console.error(`  ✖ npm install failed (exit ${r.code})\n${tail(r.out)}`);
      failed++;
      continue;
    }
    console.log('  ✓ npm install (package.json present)');
  }

  let ok = true;
  for (const step of STEPS) {
    const r = run(process.execPath, [chtBinPath, '--skip-version-check', step], dest);
    if (r.code !== 0) {
      console.error(`  ✖ ${step} (exit ${r.code})\n${tail(r.out)}`);
      ok = false;
      break;
    }
    console.log(`  ✓ ${step}`);
  }
  if (!ok) failed++;
}

if (!KEEP) rmSync(work, { recursive: true, force: true });
else console.log(`\nKept: ${work}`);

if (failed > 0) {
  console.error(`\n${failed} of ${templates.length} template(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${templates.length} template(s) compile, convert and validate as shipped.`);
