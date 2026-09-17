/**
 * "Build poc-test" e2e — rebuild a project FROM SCRATCH through the UI
 * (empty template → hierarchy → contact forms → app form → deploy-valid
 * output), then assert the produced folder is deploy-clean. Doubles as a
 * watchable demo of the tool building a project end to end.
 *
 * Authored from docs/handoff-qa-poc-build-e2e-2026-06-28.md (QA / Lorena).
 *
 * ── What it proves ──────────────────────────────────────────────────────────
 *   B. The exact manual flow a user ran by hand:
 *        new project (Empty) → Quick Hierarchy Creator (5 place levels +
 *        person leaf) → Generate contact forms → "+ Add type" two person
 *        types → Generate their forms → new app form with a contact-type
 *        context → Save.
 *   C. Regression guards on the WRITTEN folder — each encodes a bug hit
 *      during the manual build (all since fixed; this keeps them fixed):
 *        - template ships every cht-conf-required file (targets.js gap)
 *        - every contact type incl. the person leaf gets create_form +
 *          edit_form (person-types-silently-uncreatable bug)
 *        - place_hierarchy_types excludes person types
 *        - generated contact forms: no leading-underscore field name
 *          (the `_id_placement` CouchDB reject) except canonical `_id`;
 *          meta calculates use the three-hop `../../../inputs/user/...`
 *          (the created_by XPath off-by-one); every named row is a valid
 *          XLSForm identifier (space/punctuation names).
 *        - the app form's context emits the configurable
 *          `contact.contact_type === 'patient'`.
 *   D. Deploy-valid super-check (guarded): `cht compile-app-settings` +
 *      `cht convert-contact-forms` against the produced folder exit 0.
 *      Both are local (no CHT instance). Skips cleanly if cht-conf isn't
 *      installed (e.g. CI without the bundled binary).
 *   E. Demo capture — video is always recorded; a labeled storyboard of
 *      full-page screenshots lands under client/demo/poc-build/.
 *
 * ── Run it ──────────────────────────────────────────────────────────────────
 *   # one-time: the dev server serves the prebuilt shared/dist, so a stale
 *   # shared/dist would test the OLD generator — rebuild it first.
 *   pnpm --filter @cht-ui/shared build && pnpm --filter @cht-ui/server build
 *
 *   # headless (regression):
 *   pnpm --filter @cht-ui/client exec playwright test poc-build.spec.ts
 *   # headed + slow (watchable demo; window drives itself):
 *   DEMO=1 pnpm --filter @cht-ui/client exec playwright test poc-build.spec.ts --headed
 *
 * Deliverables after a run:
 *   - storyboard PNGs:  client/demo/poc-build/NN-*.png
 *   - video (.webm):    client/test-results/…  (convert to .mp4 to share:
 *                         ffmpeg -i video.webm poc-build.mp4)
 *
 * Builds into an OS temp folder and removes it in `finally` — never targets
 * a real project path.
 *
 * NOTE: this spec drives the PROJECT PICKER, so it must start with no project
 * open. It therefore imports the raw Playwright `test` (NOT ./setup.js, whose
 * auto-fixture opens mini-config before every test) and closes any open
 * project via the API first.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { parseXlsForm } from '@cht-ui/shared';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:5174';

// Always record video (this is the PO's deliverable); headed + slow under
// DEMO=1 so the recording is watchable rather than a blur.
const SLOW_MS = 350;
test.use({
  video: 'on',
  // Tall viewport so the multi-row Quick-Hierarchy modal fits without its
  // footer (the "Set up my hierarchy" commit button) overflowing below the
  // fold — and the storyboard screenshots capture the whole modal.
  viewport: { width: 1366, height: 1400 },
  headless: !process.env.DEMO,
  launchOptions: { slowMo: process.env.DEMO ? SLOW_MS : 0 },
});

/* ── storyboard ─────────────────────────────────────────────────────────── */
const DEMO_DIR = path.resolve(here, '..', 'demo', 'poc-build');
let shotN = 0;
async function shot(page: Page, name: string): Promise<void> {
  shotN += 1;
  const file = path.join(DEMO_DIR, `${String(shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
}

/* ── expected shape of the built project ────────────────────────────────── */
// 5 place levels + person leaf (from QHC) + 2 person types (from "+ Add type").
const PLACES = ['district', 'ward', 'health_facility', 'fchv_area', 'household'];
const PERSON_LEAF = 'patient';
const EXTRA_PERSONS = ['fchv', 'hf_officer'];
const ALL_TYPES = [...PLACES, PERSON_LEAF, ...EXTRA_PERSONS]; // 8

test('poc-build — empty project → hierarchy → forms → app form → deploy-valid', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await fs.mkdir(DEMO_DIR, { recursive: true });

  // Build under an OS temp PARENT; the wizard creates `<parent>/poc-test`.
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-poc-build-'));
  const projectPath = path.join(parent, 'poc-test');
  try {
    /* ===================== B. UI walkthrough ===================== */

    // Close any open project so the picker (not the editor) renders on load.
    await request.post(`${API}/api/project/close`);
    await page.goto('/');

    // ── New project → Empty template ──────────────────────────────────────
    await page.getByRole('button', { name: /From a template/ }).click();
    const wizard = page.locator('.modal-wide');
    await expect(wizard).toBeVisible();
    await shot(page, 'new-project-wizard');

    // Pick "Empty project" EXPLICITLY (the picker defaults to "Blank").
    const emptyCard = wizard
      .locator('.template-card')
      .filter({ has: page.getByRole('heading', { name: 'Empty project' }) });
    await expect(emptyCard).toBeVisible();
    await emptyCard.click();
    await expect(emptyCard).toHaveClass(/selected/);
    await shot(page, 'template-empty-selected');
    await wizard.getByRole('button', { name: /Next/ }).click();

    // ── Location: parent temp folder + name `poc-test` ────────────────────
    await wizard.locator('.form-row', { hasText: 'Parent folder' }).locator('input').fill(parent);
    const nameInput = wizard.locator('.form-row', { hasText: 'Project name' }).locator('input');
    await nameInput.fill('poc-test');
    await expect(wizard.getByText(`→ Will create`)).toBeVisible();
    await shot(page, 'location');
    await wizard.getByRole('button', { name: /Next/ }).click();

    // ── Confirm + scaffold → project opens ────────────────────────────────
    await expect(wizard.getByRole('heading', { name: 'Ready to scaffold' })).toBeVisible();
    await shot(page, 'confirm');
    await wizard.getByRole('button', { name: /Create project/ }).click();

    // The wizard closes and the project opens — the sidebar appears.
    await expect(page.locator('.nav-item', { hasText: 'Forms' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('poc-test').first()).toBeVisible();
    await shot(page, 'project-open');

    // ── Hierarchy → Quick Hierarchy Creator ───────────────────────────────
    await page.locator('.nav-item', { hasText: 'Hierarchy' }).click();
    await expect(page.locator('.qhc-empty-cta')).toBeVisible();
    await page.locator('.qhc-empty-cta').getByRole('button', { name: 'Quick start' }).click();
    const qhc = page.locator('.qhc-modal');
    await expect(qhc).toBeVisible();

    // 5 place levels (top → bottom) + the person leaf "Patient".
    await qhc.getByLabel('Number of place levels').selectOption('5');
    const placeRows = qhc.locator('.qhc-rows li');
    await expect(placeRows).toHaveCount(5);
    const placeNames = ['District', 'Ward', 'Health facility', 'FCHV Area', 'Household'];
    for (let i = 0; i < placeNames.length; i += 1) {
      await placeRows.nth(i).locator('input').first().fill(placeNames[i]);
    }
    await qhc.locator('.qhc-person-card input').first().fill('Patient');
    await shot(page, 'qhc-filled');
    const commit = qhc.getByRole('button', { name: 'Set up my hierarchy' });
    await commit.scrollIntoViewIfNeeded();
    await commit.click();

    // ── Accept the "Generate contact forms" offer ─────────────────────────
    await expect(qhc.getByText(/Your hierarchy is saved/)).toBeVisible();
    await shot(page, 'qhc-saved');
    await qhc.getByRole('button', { name: 'Generate forms' }).click();
    await generateForms(page);
    await shot(page, 'forms-generated');

    // ── "+ Add type" twice: fchv (Person, parent FCHV Area) + hf_officer
    //     (Person, parent Health facility) ──────────────────────────────────
    await addPersonType(page, 'fchv', 'fchv_area');
    await addPersonType(page, 'hf_officer', 'health_facility');
    await shot(page, 'types-added');

    // Persist the two new types so the generator (which reads the saved
    // base_settings) can see them, then generate their forms.
    await saveHierarchy(page);
    await page.getByRole('button', { name: 'Generate contact forms…' }).click();
    await generateForms(page);
    await shot(page, 'extra-forms-generated');

    // ── New app form `pregnancy_registration` + context ───────────────────
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: '+ App form' }).click();
    const createCard = page.locator('.create-form');
    await createCard.locator('input').first().fill('pregnancy_registration');
    await createCard.getByRole('button', { name: 'Create', exact: true }).click();

    // The new form opens in the editor — go to Properties → Context.
    // (The editor's tab bar renders as buttons, not ARIA tabs.)
    await page.getByRole('button', { name: 'Properties', exact: true }).click();
    await expect(page.locator('.properties-editor')).toBeVisible();
    await page.getByLabel('Available on people').check();
    await page
      .locator('.context-builder')
      .getByRole('button', { name: '+ contact type', exact: true })
      .click();
    await page.locator('.context-builder .rule-row select').first().selectOption(PERSON_LEAF);
    await expect(page.locator('.context-builder .preview code')).toContainText(
      `contact.contact_type === '${PERSON_LEAF}'`,
    );
    await shot(page, 'app-form-context');

    // ── Save ──────────────────────────────────────────────────────────────
    await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
    ).toBeVisible();
    await shot(page, 'saved');

    /* ===================== C. Assertions on the produced folder ===================== */

    // C1 — template ships every cht-conf-required file.
    for (const rel of [
      'targets.js',
      'tasks.js',
      '.eslintrc',
      path.join('app_settings', 'base_settings.json'),
      'contact-summary.templated.js',
    ]) {
      await expect(
        fileExists(path.join(projectPath, rel)),
        `required file missing: ${rel}`,
      ).resolves.toBe(true);
    }

    // C2 — all 8 contact types present, with parents, and EVERY type
    // (incl. patient / fchv / hf_officer) has create_form AND edit_form.
    const settings = JSON.parse(
      await fs.readFile(path.join(projectPath, 'app_settings', 'base_settings.json'), 'utf8'),
    ) as {
      contact_types: Array<{ id: string; parents?: string[]; create_form?: string; edit_form?: string }>;
      place_hierarchy_types: string[];
    };
    const byId = new Map(settings.contact_types.map((t) => [t.id, t]));
    expect([...byId.keys()].sort()).toEqual([...ALL_TYPES].sort());
    for (const id of ALL_TYPES) {
      const t = byId.get(id)!;
      expect(t.create_form, `${id} missing create_form`).toBeTruthy();
      expect(t.edit_form, `${id} missing edit_form`).toBeTruthy();
    }
    // Parent chain (linear places → person leaf under the last place →
    // added persons under their chosen parents).
    expect(byId.get('district')!.parents ?? []).toEqual([]);
    expect(byId.get('ward')!.parents).toContain('district');
    expect(byId.get('health_facility')!.parents).toContain('ward');
    expect(byId.get('fchv_area')!.parents).toContain('health_facility');
    expect(byId.get('household')!.parents).toContain('fchv_area');
    expect(byId.get('patient')!.parents).toContain('household');
    expect(byId.get('fchv')!.parents).toContain('fchv_area');
    expect(byId.get('hf_officer')!.parents).toContain('health_facility');

    // C3 — place_hierarchy_types is exactly the 5 places (persons excluded).
    expect(settings.place_hierarchy_types).toEqual(PLACES);

    // C4 — every generated contact .xlsx is deploy-clean.
    const contactDir = path.join(projectPath, 'forms', 'contact');
    const xlsxFiles = (await fs.readdir(contactDir)).filter((f) => f.endsWith('.xlsx'));
    // 8 types × {create, edit} = 16 forms.
    expect(xlsxFiles.length).toBe(ALL_TYPES.length * 2);
    const idRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const file of xlsxFiles) {
      const form = await parseXlsForm(await fs.readFile(path.join(contactDir, file)));
      for (const row of form.survey) {
        // Leading `_` is a CouchDB doc-validation reject (the `_id_placement`
        // bug); only the canonical `_id` (edit forms) is allowed.
        if (row.name.startsWith('_')) {
          expect(row.name, `${file}: illegal leading-underscore field`).toBe('_id');
        }
        // Named rows must be valid XLSForm identifiers. Structural rows
        // (begin/end group) carry an empty name and are exempt.
        if (row.name !== '') {
          expect(row.name, `${file}: invalid field name "${row.name}"`).toMatch(idRe);
        }
        // meta calculates reference the creating user three hops up
        // (../../../inputs/user/...) — the off-by-one shipped two hops.
        const calc = row.extras['calculation'] ?? '';
        if (calc.includes('inputs/user')) {
          expect(calc, `${file}: wrong inputs/user XPath in "${row.name}"`).toMatch(
            /\.\.\/\.\.\/\.\.\/inputs\/user\//,
          );
        }
      }
    }

    // C5 — the app form's context emits the configurable contact_type form.
    const props = JSON.parse(
      await fs.readFile(
        path.join(projectPath, 'forms', 'app', 'pregnancy_registration.properties.json'),
        'utf8',
      ),
    ) as { context?: { expression?: string } };
    expect(props.context?.expression ?? '').toContain(`contact.contact_type === '${PERSON_LEAF}'`);

    /* ===================== D. Deploy-valid super-check (opt-in) ===================== */
    // Local cht-conf actions (no instance): `compile-app-settings` +
    // `convert-contact-forms` must exit 0 on the produced folder — the
    // one-shot proof the output is deploy-clean. Opt-in via
    // CHT_DEPLOY_CHECK=1 because `convert-contact-forms` needs cht-conf's
    // form-conversion toolchain (pyxform), which a bare CI runner may lack;
    // gating keeps the B+C regression run deterministic everywhere.
    const cht = chtBinary();
    if (process.env.CHT_DEPLOY_CHECK === '1' && (await fileExists(cht))) {
      for (const action of ['compile-app-settings', 'convert-contact-forms']) {
        const { code, output } = await runCht(cht, action, projectPath);
        expect(code, `cht ${action} failed (exit ${code}):\n${output}`).toBe(0);
      }
    } else {
      test.info().annotations.push({
        type: 'note',
        description:
          'deploy-valid super-check skipped — set CHT_DEPLOY_CHECK=1 (needs cht-conf + pyxform)',
      });
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

/* ── helpers ─────────────────────────────────────────────────────────────── */

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Drive the open Contact-Form Generator modal: run, wait for the written
 *  summary, close. */
async function generateForms(page: Page): Promise<void> {
  const modal = page.locator('.lineage-builder-modal');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: /Generate \d+ file/ }).click();
  // Result summary reads e.g. "✓ Written (new): 12 → Skipped …".
  await expect(modal.getByText(/Written \(new\):\s*\d+/)).toBeVisible({ timeout: 30_000 });
  // Two "Close" affordances exist (header ✕ via aria-label + footer button);
  // target the footer button by its visible text.
  await modal.locator('button', { hasText: /^Close$/ }).click();
  await expect(modal).not.toBeVisible();
}

/** Add a Person-kind contact type with the given parent via "+ Add type". */
async function addPersonType(page: Page, name: string, parentId: string): Promise<void> {
  await page.getByRole('button', { name: '+ Add type' }).click();
  const modal = page.locator('[aria-label="Add contact type"]');
  await expect(modal).toBeVisible();
  await modal.getByPlaceholder(/CHW, Patient/i).fill(name);
  await modal.getByText('Person', { exact: true }).click();
  await modal.locator('select').selectOption(parentId);
  await modal.getByRole('button', { name: 'Add type' }).click();
  await expect(modal).not.toBeVisible();
}

/** Save the hierarchy and wait for the button to settle to "Saved". */
async function saveHierarchy(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
}

/** Bundled cht-conf binary path (server workspace dep). */
function chtBinary(): string {
  const serverRoot = path.resolve(here, '..', '..', 'server');
  const isWindows = process.platform === 'win32';
  return path.join(serverRoot, 'node_modules', '.bin', isWindows ? 'cht.cmd' : 'cht');
}

/** Run a local cht-conf action in `cwd`; resolve its exit code + combined
 *  output. `requiresInstance:false` actions take no targeting flag. */
function runCht(
  cht: string,
  action: string,
  cwd: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    // Windows `.cmd` must be spawned through a shell.
    const child = spawn(`"${cht}" ${action}`, { cwd, shell: true });
    let output = '';
    child.stdout.on('data', (b: Buffer) => (output += b.toString()));
    child.stderr.on('data', (b: Buffer) => (output += b.toString()));
    child.on('close', (code) => resolve({ code, output }));
    child.on('error', (e) => resolve({ code: -1, output: String(e) }));
  });
}
