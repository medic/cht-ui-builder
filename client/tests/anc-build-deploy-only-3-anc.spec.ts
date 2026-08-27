/**
 * "Build the ANC workflow" e2e — drives the no-code builder end-to-end to
 * construct the maternal-health app from docs/anc-guide.pdf, entirely through
 * the screen, then optionally deploys it live.
 *
 * Mirrors the guide's phases:
 *   1. Area structure     — Quick Hierarchy Creator (5 places + Patient) + 2 person types
 *   2. Place/people forms  — Generate contact forms
 *   3. Pregnancy forms     — pregnancy_registration (with lmp_date) + pregnancy_visit
 *   4. ANC schedule        — one task, 3 LMP-anchored events (12/26/38 wk), opens the visit form
 *   5. Confidence          — local cht compile/convert exit 0 (CHT_DEPLOY_CHECK=1)
 *   6. Live deploy         — Deploy panel → the instance (LIVE_DEPLOY=1 only)
 *   7. Verify              — the instance's /api/v1/settings carries our types
 *
 * CI-safe by default: phases 1–4 build a deploy-clean project and assert its
 * on-disk shape without touching cht-conf or any instance. Opt-in env flags:
 *   CHT_DEPLOY_CHECK=1  → also run local compile/convert (needs pyxform)
 *   LIVE_DEPLOY=1       → also upload to the instance + verify (real, overwriting push)
 *   ANC_OUTPUT_DIR=…    → build somewhere other than W:\medic\ui-builder-projects
 *
 * Unlike poc-build (temp folder, deleted), this builds into the USER's real
 * output location and KEEPS it:  W:\medic\ui-builder-projects\anc-workflow
 *
 * ── Watch it build + deploy (headed + slow) + record ───────────────────────
 *   pnpm --filter @cht-ui/shared build ; pnpm --filter @cht-ui/server build
 *   $env:DEMO=1 ; $env:LIVE_DEPLOY=1 ; pnpm --filter @cht-ui/client exec playwright test anc-build-deploy-only-3-anc.spec.ts --headed
 *   # video:      client\test-results\…\video.webm
 *   # storyboard: client\demo\anc-workflow\NN-*.png
 *   # replay:     pnpm --filter @cht-ui/client exec playwright show-report
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:5174';

// Output location. Defaults to the user's real folder (kept after the run);
// override with ANC_OUTPUT_DIR for a portable/CI path.
const PARENT = process.env.ANC_OUTPUT_DIR ?? os.tmpdir();
const PROJECT_NAME = 'anc-workflow';
const PROJECT_PATH = path.join(PARENT, PROJECT_NAME);

// Live-deploy target.
const INSTANCE_URL = 'https://127-0-0-1.local-ip.medicmobile.org:10445';
const INSTANCE_USER = 'medic';
const INSTANCE_PASS = 'password';
// The one-click pipeline runs these 6 steps (compile → convert → upload).
const DEPLOY_STEP_COUNT = 6;

const SLOW_MS = 1500;
test.use({
  // Record at full 2K (QHD) resolution. `size` must match the viewport, else
  // Playwright up/downscales and the extra pixels add no real detail.
  video: { mode: 'on', size: { width: 2560, height: 1440 } },
  viewport: { width: 2560, height: 1440 },
  headless: !process.env.DEMO,
  launchOptions: { slowMo: process.env.DEMO ? SLOW_MS : 0 },
});

/* ── storyboard ─────────────────────────────────────────────────────────── */
const DEMO_DIR = path.resolve(here, '..', 'demo', 'anc-workflow');
let shotN = 0;
async function shot(page: Page, name: string): Promise<void> {
  shotN += 1;
  await page.screenshot({
    path: path.join(DEMO_DIR, `${String(shotN).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
}

/* ── the ANC schedule (guide §4): gestational week per visit ─────────────── */
const ANC_WEEKS = [12, 26, 38];

test('anc-build — hierarchy → forms → pregnancy forms → 3-visit ANC schedule', async ({
  page,
  request,
}) => {
  test.setTimeout(600_000);
  await fs.mkdir(DEMO_DIR, { recursive: true });
  // Clean-slate the target so the wizard can create it; KEEP it after the run.
  await request.post(`${API}/api/project/close`).catch(() => {});
  await fs.rm(PROJECT_PATH, { recursive: true, force: true });

  /* ===================== 1. Area structure ===================== */
  await page.goto('/');
  await page.getByRole('button', { name: /Create new project/ }).click();
  const wizard = page.locator('.modal-wide');
  await expect(wizard).toBeVisible();
  const emptyCard = wizard
    .locator('.template-card')
    .filter({ has: page.getByRole('heading', { name: 'Empty project' }) });
  await emptyCard.click();
  await wizard.getByRole('button', { name: /Next/ }).click();
  await wizard.locator('.form-row', { hasText: 'Parent folder' }).locator('input').fill(PARENT);
  await wizard.locator('.form-row', { hasText: 'Project name' }).locator('input').fill(PROJECT_NAME);
  await wizard.getByRole('button', { name: /Next/ }).click();
  await expect(wizard.getByRole('heading', { name: 'Ready to scaffold' })).toBeVisible();
  await wizard.getByRole('button', { name: /Create project/ }).click();
  await expect(page.locator('.nav-item', { hasText: 'Forms' })).toBeVisible({ timeout: 30_000 });
  await shot(page, 'project-open');

  // Quick Hierarchy Creator: 5 places + person leaf "Patient".
  await page.locator('.nav-item', { hasText: 'Hierarchy' }).click();
  await page.locator('.qhc-empty-cta').getByRole('button', { name: 'Quick start' }).click();
  const qhc = page.locator('.qhc-modal');
  await expect(qhc).toBeVisible();
  await qhc.getByLabel('Number of place levels').selectOption('5');
  const placeRows = qhc.locator('.qhc-rows li');
  await expect(placeRows).toHaveCount(5);
  const placeNames = ['District', 'Ward', 'Health facility', 'FCHV Area', 'Household'];
  for (let i = 0; i < placeNames.length; i += 1) {
    await placeRows.nth(i).locator('input').first().fill(placeNames[i]!);
  }
  await qhc.locator('.qhc-person-card input').first().fill('Patient');
  await shot(page, 'qhc-filled');
  const commit = qhc.getByRole('button', { name: 'Set up my hierarchy' });
  await commit.scrollIntoViewIfNeeded();
  await commit.click();
  await expect(qhc.getByText(/Your hierarchy is saved/)).toBeVisible();

  // Generate contact forms for the base hierarchy.
  await qhc.getByRole('button', { name: 'Generate forms' }).click();
  await generateForms(page);

  // + Add type: FCHV (under FCHV Area) and HF Officer (under Health facility).
  await addPersonType(page, 'fchv', 'fchv_area');
  await addPersonType(page, 'hf_officer', 'health_facility');
  await saveHierarchy(page);
  await page.getByRole('button', { name: 'Generate contact forms…' }).click();
  await generateForms(page);
  await shot(page, 'hierarchy-and-forms');

  /* ===================== 3. Pregnancy forms ===================== */
  // pregnancy_registration with the key lmp_date (Date) field.
  await createAppForm(page, 'pregnancy_registration');
  await addQuestion(page, 'Date', 'lmp_date', 'LMP date');
  await addQuestion(page, 'Text', 'mother_name', "Mother's name");
  await saveForm(page);
  await shot(page, 'pregnancy-registration');

  // pregnancy_visit — the form a CHW fills at each ANC visit.
  await createAppForm(page, 'pregnancy_visit');
  await saveForm(page);

  /* ===================== 4. ANC visit schedule ===================== */
  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  await page.getByRole('button', { name: '+ Add task' }).click();
  const card = page.locator('.task-card').last();
  await expect(card).toBeVisible();

  // name → slugified id "anc-home-visit".
  const nameField = card.locator('.expr-field', { hasText: 'name' }).first();
  await nameField.locator('input').first().fill('ANC home visit');
  await nameField.getByRole('button', { name: 'use this' }).click();

  // appliesToType = pregnancy_registration. Multi-select mode is already
  // active for the default '[]'; the mode button is label-wrapped (its
  // accessible name is the whole field), so just tick the checkbox.
  const appliesTo = card.locator('.expr-field', { hasText: 'appliesToType' });
  await appliesTo.getByRole('checkbox', { name: 'pregnancy_registration', exact: true }).check();

  // events → 3 LMP-anchored visits.
  const events = card.locator('.events-editor');
  // The LMP anchor option appears once the report form's date fields are
  // fetched (now that appliesToType points at pregnancy_registration).
  await expect(
    events.locator('.event-card').first().locator('select option[value="lmp"]'),
  ).toBeAttached({ timeout: 15_000 });
  // Grow to 3 event cards (starts with 1). Button text is content-matched
  // because it's label-wrapped.
  while ((await events.locator('.event-card').count()) < ANC_WEEKS.length) {
    await events.locator('button', { hasText: '+ Event' }).click();
  }
  for (let i = 0; i < ANC_WEEKS.length; i += 1) {
    const wk = ANC_WEEKS[i]!;
    const ev = events.locator('.event-card').nth(i);
    await ev.locator('.name-input').first().fill(`anc_${wk}_weeks`);
    // due = LMP date (the pregnancy helper option appears because the report
    // form has an lmp_date field).
    await ev.locator('select').nth(0).selectOption('lmp');
    // offset value + unit = <wk> weeks.
    await ev.locator('select').nth(1).selectOption('weeks');
    await ev.locator('input[type=number]').nth(0).fill(String(wk));
    // window: opens 7 days before, closes 14 days after.
    await ev.locator('input[type=number]').nth(1).fill('7');
    await ev.locator('input[type=number]').nth(2).fill('14');
  }
  await shot(page, 'anc-schedule');

  // action → open pregnancy_visit.
  const actions = card.locator('.expr-field', { hasText: 'actions' });
  await actions.locator('select').first().selectOption('pregnancy_visit');

  // Save tasks.js.
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await shot(page, 'tasks-saved');

  /* ===================== 5. On-disk assertions ===================== */
  // The ANC project exists at the user's real path with the expected artifacts.
  for (const rel of [
    'targets.js',
    'tasks.js',
    path.join('app_settings', 'base_settings.json'),
    path.join('forms', 'app', 'pregnancy_registration.xlsx'),
    path.join('forms', 'app', 'pregnancy_visit.xlsx'),
  ]) {
    expect(await fileExists(path.join(PROJECT_PATH, rel)), `missing: ${rel}`).toBe(true);
  }
  // tasks.js carries the 3-visit schedule anchored on LMP.
  const tasksSrc = await fs.readFile(path.join(PROJECT_PATH, 'tasks.js'), 'utf8');
  expect(tasksSrc).toContain('getLmpDate'); // LMP-anchored schedule
  expect(tasksSrc).toContain("form: 'pregnancy_visit'"); // opens the visit form
  for (const wk of ANC_WEEKS) {
    // Each visit is an event whose dueDate is LMP + (week × 7) days.
    expect(tasksSrc, `event anc_${wk}_weeks missing`).toContain(`anc_${wk}_weeks`);
    expect(tasksSrc, `${wk}wk (${wk * 7}d) offset missing`).toContain(`getLmpDate(report), ${wk * 7})`);
  }

  /* ===================== 5b. Deploy-valid super-check (opt-in) ===================== */
  const cht = chtBinary();
  if (process.env.CHT_DEPLOY_CHECK === '1' && (await fileExists(cht))) {
    for (const action of ['compile-app-settings', 'convert-app-forms', 'convert-contact-forms']) {
      const { code, output } = await runCht(cht, action, PROJECT_PATH);
      expect(code, `cht ${action} failed (${code}):\n${output}`).toBe(0);
    }
  }

  /* ===================== 6. Live deploy to the instance (opt-in) ===================== */
  // CI-safe by default: phases 1–5 above guard the builder + produce a
  // deploy-clean project WITHOUT touching any instance. The live upload only
  // runs under LIVE_DEPLOY=1 (a real, overwriting push to the target below).
  if (process.env.LIVE_DEPLOY !== '1') {
    test.info().annotations.push({
      type: 'note',
      description: 'live deploy skipped — set LIVE_DEPLOY=1 to upload to the instance',
    });
    return;
  }
  await page.locator('.nav-item', { hasText: 'Deploy' }).click();
  await shot(page, 'deploy-panel');

  // Target = the user's instance via --url + credentials (password is held in
  // component state, never persisted — read by the pipeline at click time).
  const target = page.locator('.deploy-target');
  await target.locator('input[name="target"]').nth(2).check(); // --url
  await target.locator('input[placeholder="https://your-instance.medicmobile.org"]').fill(INSTANCE_URL);
  await target.locator('input[placeholder="medic"]').fill(INSTANCE_USER);
  await target.locator('input[type="password"]').fill(INSTANCE_PASS);

  // Prove the credentials actually reach the instance before uploading.
  await target.getByRole('button', { name: /Test connection/ }).click();
  await expect(target.locator('.deploy-test-result.ok')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'deploy-connection-ok');

  // One-click pipeline: compile → convert → upload (6 steps).
  const oneclick = page.locator('.deploy-oneclick');
  const anyway = oneclick.getByRole('button', { name: 'Deploy anyway' });
  if (await anyway.isVisible().catch(() => false)) await anyway.click();
  await oneclick.getByRole('button', { name: 'Deploy', exact: true }).click();

  // Every step must reach success; none may fail. Uploads to a real instance
  // take a while, so allow a generous window.
  await expect(oneclick.locator('.deploy-oneclick-step.state-success')).toHaveCount(
    DEPLOY_STEP_COUNT,
    { timeout: 300_000 },
  );
  await expect(oneclick.locator('.deploy-oneclick-step.state-fail')).toHaveCount(0);
  await shot(page, 'deploy-success');

  /* ===================== 7. Verify on the instance ===================== */
  // Confirm OUR app-settings are actually live: the instance's settings now
  // carry the ANC hierarchy's contact types (fchv_area / hf_officer are unique
  // to this build — a stock CHT instance would not have them).
  const auth = 'Basic ' + Buffer.from(`${INSTANCE_USER}:${INSTANCE_PASS}`).toString('base64');
  const settings = await request.get(`${INSTANCE_URL}/api/v1/settings`, {
    headers: { Authorization: auth },
  });
  expect(settings.ok(), 'instance settings not reachable after deploy').toBeTruthy();
  const settingsBody = await settings.text();
  for (const type of ['fchv_area', 'hf_officer', 'patient']) {
    expect(settingsBody, `contact type "${type}" not live on the instance`).toContain(`"${type}"`);
  }
});

/* ── helpers (shared with poc-build's proven flow) ─────────────────────────── */

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function generateForms(page: Page): Promise<void> {
  const modal = page.locator('.lineage-builder-modal');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: /Generate \d+ file/ }).click();
  await expect(modal.getByText(/Written \(new\):\s*\d+/)).toBeVisible({ timeout: 30_000 });
  await modal.locator('button', { hasText: /^Close$/ }).click();
  await expect(modal).not.toBeVisible();
}

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

async function saveHierarchy(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
}

/** Forms tab → + App form → name → Create; leaves the new form open. */
async function createAppForm(page: Page, name: string): Promise<void> {
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: '+ App form' }).click();
  const createCard = page.locator('.create-form');
  await createCard.locator('input').first().fill(name);
  await createCard.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.page-header').getByRole('button', { name: /Save/ })).toBeVisible();
}

/** Add a question via the tile picker, then label it. */
async function addQuestion(
  page: Page,
  tileLabel: string,
  name: string,
  label: string,
): Promise<void> {
  await page.getByRole('button', { name: '+ Question' }).first().click();
  const picker = page.locator('.qtype-modal');
  await expect(picker).toBeVisible();
  await picker.getByPlaceholder(/has_fever, patient_age/i).fill(name);
  // Non-list tiles commit on click (like Group in poc-build).
  await picker
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: new RegExp(`^${tileLabel}$`) }) })
    .first()
    .click();
  await expect(picker).not.toBeVisible();
  // Label the freshly-added row (discriminate by its name-input value).
  const row = page
    .locator('.survey-row')
    .filter({ has: page.locator(`input.name-input[value="${name}"]`) });
  await row
    .locator('.label-row', { hasText: 'label::en' })
    .locator('input')
    .fill(label);
}

async function saveForm(page: Page): Promise<void> {
  const header = page.locator('.page-header');
  const saved = header.getByRole('button', { name: 'Saved', exact: true });
  // A freshly-created empty form (e.g. pregnancy_visit) is already clean —
  // the header shows a disabled "Saved" and there is nothing to save.
  if (await saved.isVisible().catch(() => false)) return;
  await header.getByRole('button', { name: 'Save', exact: true }).click();
  // The confirm-diff modal appears for real structural changes.
  const modalSave = page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true });
  if (await modalSave.isVisible().catch(() => false)) await modalSave.click();
  await expect(saved).toBeVisible();
}

function chtBinary(): string {
  const serverRoot = path.resolve(here, '..', '..', 'server');
  const isWindows = process.platform === 'win32';
  return path.join(serverRoot, 'node_modules', '.bin', isWindows ? 'cht.cmd' : 'cht');
}

function runCht(cht: string, action: string, cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(`"${cht}" ${action}`, { cwd, shell: true });
    let output = '';
    child.stdout.on('data', (b: Buffer) => (output += b.toString()));
    child.stderr.on('data', (b: Buffer) => (output += b.toString()));
    child.on('close', (code) => resolve({ code, output }));
    child.on('error', (e) => resolve({ code: -1, output: String(e) }));
  });
}
