/**
 * CI guard: forms this tool GENERATES must survive cht-conf's own validator.
 *
 * Usage:
 *   node scripts/validate-generated-forms.mjs            # temp dir, cleans up
 *   node scripts/validate-generated-forms.mjs --keep     # leave the projects on disk
 *
 * Exits nonzero if a generated form fails `validate-app-forms`, or if the
 * negative control unexpectedly passes.
 *
 * ## Why this exists
 *
 * `insertContactFieldRef` used to emit `../inputs/contact/<field>` without
 * declaring the node it points at. cht-conf's `validate-app-forms` fails the
 * ENTIRE run on one unresolvable XPath, so a single bad reference in one form
 * blocked every form AND the app settings from deploying:
 *
 *   ERROR  geri_note.xml contains invalid XPath expressions (absolute or
 *          relative paths that refer to a non-existant node):
 *   ERROR    - calculate for /data/patient_name contains [../inputs/contact/name]
 *   ERROR  One or more forms have failed validation.
 *
 * That shipped with nine green flow tests and a clean typecheck, because
 * every gate we had was blind to it — pyxform is the only oracle that knows
 * whether an XForm's XPaths resolve.
 *
 * The fast hermetic version of this check lives in
 * `shared/src/xlsform/insertContactFieldRef.declare.test.ts` and runs on
 * every `pnpm --filter @cht-ui/shared test`. This script is the real thing:
 * it drives the actual generator, converts with actual pyxform, and validates
 * with actual cht-conf.
 *
 * ## The negative control
 *
 * A guard that cannot fail is worth nothing, so this also generates a form
 * with the bug deliberately reintroduced and asserts that cht-conf REJECTS
 * it. If that ever starts passing, the validator stopped looking and this
 * script's green tick would be meaningless.
 *
 * Requires python3 + pyxform on PATH (cht-conf shells out to it for
 * `convert-app-forms`). Verified against pyxform 4.5.0 / cht-conf 6.5.0.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const KEEP = process.argv.includes('--keep');

const SHARED = path.join(REPO, 'shared', 'dist');
const { buildAppFormScaffold } = await import(
  new URL(`file://${path.join(SHARED, 'xlsform/scaffolds.js').replace(/\\/g, '/')}`)
);
const { insertContactFieldRef } = await import(
  new URL(`file://${path.join(SHARED, 'xlsform/insertContactFieldRef.js').replace(/\\/g, '/')}`)
);
const { serializeXlsForm } = await import(
  new URL(`file://${path.join(SHARED, 'xlsform/serialize.js').replace(/\\/g, '/')}`)
);

/**
 * The cht-conf CLI entry point. Resolved through the `server` workspace,
 * which is where the dependency is declared — under pnpm the real path is
 * inside `.pnpm/`, so hardcoding it would break on any version bump.
 */
const chtBinPath = createRequire(path.join(REPO, 'server', 'package.json')).resolve(
  'cht-conf/src/bin/index.js',
);

/* -------------------------------------------------------------------------- */

/** A minimal project skeleton cht-conf will accept. */
function seedProject(root) {
  mkdirSync(path.join(root, 'forms', 'app'), { recursive: true });
  cpSync(
    path.join(REPO, 'server', 'templates', 'cht-default', 'app_settings'),
    path.join(root, 'app_settings'),
    { recursive: true },
  );
  writeFileSync(path.join(root, 'resources.json'), '{}\n');
}

function noteRow(label) {
  return { rowId: 'greeting', type: 'note', name: 'greeting', labels: { en: label }, extras: {} };
}

/**
 * The good case: build a form the way the editor does — scaffold, then insert
 * several contact fields, including ones no scaffold could enumerate ahead of
 * time (NSSD's `c82_person` carries `house_number` and `sickle_cell_test`).
 */
function generateGoodForm() {
  let form = buildAppFormScaffold({ basename: 'generated_note', title: 'Generated note' });
  const tokens = [];
  for (const field of ['name', 'sex', 'date_of_birth', 'house_number', 'sickle_cell_test']) {
    const r = insertContactFieldRef(form, field);
    if (r.undeclarableReason) {
      throw new Error(`generator refused to declare "${field}": ${r.undeclarableReason}`);
    }
    form = r.form;
    tokens.push(`\${${r.harvestName}}`);
  }
  return { ...form, survey: [...form.survey, noteRow(`Hello ${tokens.join(' ')}`)] };
}

/**
 * The negative control: the pre-fix behaviour, reproduced exactly. Strip the
 * scaffolded `name` declaration, then add only the harvest calculate.
 */
function generateBrokenForm() {
  const form = buildAppFormScaffold({ basename: 'generated_note', title: 'Generated note' });
  const survey = form.survey.filter(
    (r, i) =>
      !(r.name === 'name' && r.type === 'hidden' && form.survey[i - 1]?.name === 'patient_id'),
  );
  return {
    ...form,
    survey: [
      ...survey,
      {
        rowId: 'harvest',
        type: 'calculate',
        name: 'patient_name',
        labels: { en: '' },
        extras: { calculation: '../inputs/contact/name' },
      },
      noteRow('Hello ${patient_name}'),
    ],
  };
}

async function writeProject(root, form) {
  seedProject(root);
  const buf = await serializeXlsForm(form);
  writeFileSync(path.join(root, 'forms', 'app', 'generated_note.xlsx'), Buffer.from(buf));
}

/** Run cht-conf's convert + validate. Returns { ok, output }. */
function runChtValidate(root) {
  const res = spawnSync(
    process.execPath,
    [chtBinPath, '--local', '--skip-dependency-check', 'convert-app-forms', 'validate-app-forms'],
    { cwd: root, encoding: 'utf8', timeout: 10 * 60_000 },
  );
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  // cht-conf's exit code is authoritative, but be defensive: a validation
  // failure always prints this sentence, so treat it as failure regardless.
  const failedText = /One or more forms have failed validation/i.test(output);
  return { ok: res.status === 0 && !failedText, output };
}

function relevant(output) {
  return output
    .split(/\r?\n/)
    .filter((l) => /ERROR|invalid XPath|failed validation|complete\./i.test(l))
    .filter((l) => !/New version|npm install/i.test(l))
    .join('\n');
}

/* -------------------------------------------------------------------------- */

const workRoot = KEEP
  ? path.join(os.tmpdir(), `cht-ui-validate-${process.pid}`)
  : mkdtempSync(path.join(os.tmpdir(), 'cht-ui-validate-'));
mkdirSync(workRoot, { recursive: true });

let failures = 0;

try {
  // 1. The forms the tool generates must PASS.
  const goodRoot = path.join(workRoot, 'generated');
  await writeProject(goodRoot, generateGoodForm());
  const good = runChtValidate(goodRoot);
  if (good.ok) {
    console.log('ok    generated form passes convert-app-forms + validate-app-forms');
  } else {
    failures++;
    console.error('FAIL  a form generated by this tool does NOT validate:');
    console.error(relevant(good.output).replace(/^/gm, '        '));
  }

  // 2. The negative control must FAIL, or this guard proves nothing.
  const badRoot = path.join(workRoot, 'negative-control');
  await writeProject(badRoot, generateBrokenForm());
  const bad = runChtValidate(badRoot);
  if (!bad.ok && /invalid XPath/i.test(bad.output)) {
    console.log('ok    negative control is rejected, so the validator is really looking');
  } else {
    failures++;
    console.error(
      'FAIL  the negative control PASSED. An undeclared ../inputs/contact/name was\n' +
        '      accepted, so this guard can no longer detect the defect it exists for.',
    );
    console.error(relevant(bad.output).replace(/^/gm, '        '));
  }
} finally {
  if (KEEP) console.log(`\nprojects left at ${workRoot}`);
  else rmSync(workRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll generated-form validation checks passed.');
