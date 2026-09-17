/**
 * FULL-ARC DEMO (not a CI test) — one continuous take of the whole journey:
 *   no-code build (hierarchy → forms → contexts → 8-visit ANC task)
 *   → live deploy → open the CHT instance → CHW logs in
 *   → adds a new pregnant woman → registers her pregnancy
 *   → the ANC visit task fires → the CHW fills the task's visit form.
 *
 * The `page` navigates from the builder (localhost:5173) over to the live CHT
 * instance in the same context, so it is ONE video.
 *
 * Enketo submit DOES fire in a real (headed) browser — the whole CHW loop is
 * on-camera and real (contact + report saves via actual form Submit). Run the
 * recording headed so the submit is reliable:
 *   $env:DEMO=1 ; pnpm --filter @cht-ui/client exec playwright test anc-full-arc-demo.spec.ts --headed
 * Fast (debug, no slow-mo):
 *   pnpm --filter @cht-ui/client exec playwright test anc-full-arc-demo.spec.ts --headed
 * Video lands in client/test-results/…; copy it to a stable path afterward.
 */
import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = 'http://127.0.0.1:5174';
const INSTANCE = 'https://127-0-0-1.local-ip.medicmobile.org:10445';
const CHW = { user: 'kamala_chw', pass: 'Anc7Health!2026' };
const ANC_WEEKS = [12, 20, 26, 30, 34, 36, 38, 40];
const SLOW = process.env.DEMO ? 1500 : 0;
// The new pregnant woman the CHW creates on camera.
const WOMAN = 'Sunita Rai';
// LMP ≈ 12 weeks before "today" (2026-07-02) so the 12-week visit is due now.
const LMP = '2026-04-09';

test.use({
  // Explicit 2K video size — `video:'on'` alone downscales to fit 800×800.
  video: { mode: 'on', size: { width: 2560, height: 1440 } },
  viewport: { width: 2560, height: 1440 }, // 2K / QHD recording
  ignoreHTTPSErrors: true,
  launchOptions: { slowMo: SLOW },
});

/** Pause for narration — only when recording (DEMO), so debug runs stay fast. */
async function beat(page: Page, ms = 2500): Promise<void> {
  if (SLOW) await page.waitForTimeout(ms);
}

test('full arc — no-code build → deploy → CHW adds a woman → ANC task', async ({ page, request }) => {
  test.setTimeout(1_200_000);
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-fullarc-'));
  const projectPath = path.join(parent, 'anc-demo');

  /* ================= PART 1 — no-code build ================= */
  await request.post(`${API}/api/project/close`).catch(() => {});
  await fs.rm(projectPath, { recursive: true, force: true });
  await page.goto('/');
  await page.getByRole('button', { name: /From a template/ }).click();
  const wizard = page.locator('.modal-wide');
  await wizard.locator('.template-card').filter({ has: page.getByRole('heading', { name: 'Empty project' }) }).click();
  await wizard.getByRole('button', { name: /Next/ }).click();
  await wizard.locator('.form-row', { hasText: 'Parent folder' }).locator('input').fill(parent);
  await wizard.locator('.form-row', { hasText: 'Project name' }).locator('input').fill('anc-demo');
  await wizard.getByRole('button', { name: /Next/ }).click();
  await wizard.getByRole('button', { name: /Create project/ }).click();
  await expect(page.locator('.nav-item', { hasText: 'Forms' })).toBeVisible({ timeout: 30_000 });
  await beat(page, 3000);

  // Hierarchy via Quick Hierarchy Creator — the cold-start scaffolder. Slowed
  // down so the presenter can talk through each level.
  await page.locator('.nav-item', { hasText: 'Hierarchy' }).click();
  await beat(page, 2500);
  await page.locator('.qhc-empty-cta').getByRole('button', { name: 'Quick start' }).click();
  const qhc = page.locator('.qhc-modal');
  await qhc.getByLabel('Number of place levels').selectOption('5');
  await beat(page, 2500);
  const placeNames = ['District', 'Ward', 'Health facility', 'FCHV Area', 'Household'];
  for (let i = 0; i < placeNames.length; i += 1) {
    await qhc.locator('.qhc-rows li').nth(i).locator('input').first().fill(placeNames[i]!);
    await beat(page, 1500);
  }
  await qhc.locator('.qhc-person-card input').first().fill('Patient');
  await beat(page, 2500);
  const commit = qhc.getByRole('button', { name: 'Set up my hierarchy' });
  await commit.scrollIntoViewIfNeeded();
  await commit.click();
  await expect(qhc.getByText(/Your hierarchy is saved/)).toBeVisible();
  await beat(page, 3000);
  await qhc.getByRole('button', { name: 'Generate forms' }).click();
  await generateForms(page);
  // Two more person roles beyond the default Patient, each at its own level.
  await addPersonType(page, 'fchv', 'fchv_area');
  await beat(page, 2000);
  await addPersonType(page, 'hf_officer', 'health_facility');
  await beat(page, 2000);
  await saveHierarchy(page);
  await beat(page, 2500);
  await page.getByRole('button', { name: 'Generate contact forms…' }).click();
  await generateForms(page);
  await beat(page, 2500);

  // ---- pregnancy_registration: LMP + mother, plus a first-pregnancy branch ----
  await createAppForm(page, 'pregnancy_registration');
  await addQuestion(page, 'Date', 'lmp_date', 'LMP date');
  await addQuestion(page, 'Text', 'mother_name', "Mother's name");
  await addSelectQuestion(page, 'Select one', 'first_pregnancy', 'Is this your first pregnancy?', [
    { name: 'yes', label: 'Yes' },
    { name: 'no', label: 'No' },
  ]);
  // A note that congratulates first-time mothers…
  await addNote(page, 'note_congrats', 'Congratulations on your first pregnancy!', "${first_pregnancy} = 'yes'");
  // …and one that flags multigravida risk for the rest.
  await addNote(page, 'note_multigravida', 'Be aware of multigravida pregnancy risks.', "${first_pregnancy} = 'no'");
  await saveForm(page);
  await beat(page, 2500);

  // ---- pregnancy_visit: a danger-signs checklist ----
  await createAppForm(page, 'pregnancy_visit');
  await addSelectQuestion(page, 'Select many', 'danger_signs', 'Do you have any danger signs?', [
    { name: 'vaginal_bleeding', label: 'Vaginal bleeding' },
    { name: 'severe_headache', label: 'Severe headache' },
    { name: 'blurred_vision', label: 'Blurred vision' },
    { name: 'high_fever', label: 'High fever' },
    { name: 'reduced_fetal_movement', label: 'Reduced fetal movement' },
    { name: 'swelling', label: 'Swelling of face or hands' },
  ]);
  await saveForm(page);
  await beat(page, 2500);

  // The 8-visit ANC schedule — anchored on the lmp_date FIELD (the correct anchor).
  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  await page.getByRole('button', { name: '+ Add task' }).click();
  const card = page.locator('.task-card').last();
  const nameField = card.locator('.expr-field', { hasText: 'name' }).first();
  await nameField.locator('input').first().fill('ANC home visit');
  await nameField.getByRole('button', { name: 'use this' }).click();
  await card.locator('.expr-field', { hasText: 'appliesToType' })
    .getByRole('checkbox', { name: 'pregnancy_registration', exact: true }).check();
  const events = card.locator('.events-editor');
  await expect(events.locator('.event-card').first().locator('select option[value="field:lmp_date"]'))
    .toBeAttached({ timeout: 15_000 });
  while ((await events.locator('.event-card').count()) < ANC_WEEKS.length) {
    await events.locator('button', { hasText: '+ Event' }).click();
  }
  for (let i = 0; i < ANC_WEEKS.length; i += 1) {
    const ev = events.locator('.event-card').nth(i);
    await ev.locator('.name-input').first().fill(`anc_${ANC_WEEKS[i]}_weeks`);
    await ev.locator('select').nth(0).selectOption('field:lmp_date'); // anchor on our real date field
    await ev.locator('select').nth(1).selectOption('weeks');
    await ev.locator('input[type=number]').nth(0).fill(String(ANC_WEEKS[i]));
    await ev.locator('input[type=number]').nth(1).fill('7');
    await ev.locator('input[type=number]').nth(2).fill('14');
  }
  await card.locator('.expr-field', { hasText: 'actions' }).locator('select').first().selectOption('pregnancy_visit');
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await beat(page, 2500);

  // Make the visit form task-only before deploy (drops it from the New menu).
  const vp = path.join(projectPath, 'forms', 'app', 'pregnancy_visit.properties.json');
  const props = JSON.parse(await fs.readFile(vp, 'utf8')) as { context: Record<string, unknown> };
  props.context = { person: false, place: false, expression: 'false' };
  await fs.writeFile(vp, JSON.stringify(props, null, 2) + '\n');

  /* ================= PART 2 — live deploy ================= */
  await page.locator('.nav-item', { hasText: 'Deploy' }).click();
  const target = page.locator('.deploy-target');
  await target.locator('input[name="target"]').nth(2).check();
  await target.locator('input[placeholder="https://your-instance.medicmobile.org"]').fill(INSTANCE);
  await target.locator('input[placeholder="medic"]').fill('medic');
  await target.locator('input[type="password"]').fill('password');
  await target.getByRole('button', { name: /Test connection/ }).click();
  await expect(target.locator('.deploy-test-result.ok')).toBeVisible({ timeout: 30_000 });
  const oneclick = page.locator('.deploy-oneclick');
  const anyway = oneclick.getByRole('button', { name: 'Deploy anyway' });
  if (await anyway.isVisible().catch(() => false)) await anyway.click();
  await oneclick.getByRole('button', { name: 'Deploy', exact: true }).click();
  // Block until the form + settings uploads actually land — the CHW loop below
  // fills these exact forms, so they must be live before we continue.
  for (const step of ['upload-app-forms', 'upload-contact-forms', 'upload-app-settings']) {
    await expect(
      oneclick.locator('.deploy-oneclick-step', {
        has: page.locator('code.deploy-oneclick-name', { hasText: step }),
      }),
    ).toHaveClass(/state-success/, { timeout: 180_000 });
  }
  await beat(page, 3000);

  /* ============ PART 3 — CHW opens CHT and works a real case ============ */
  await page.goto(`${INSTANCE}/`);
  await page.getByRole('textbox', { name: 'User name' }).fill(CHW.user);
  await page.getByRole('textbox', { name: 'Password' }).fill(CHW.pass);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByRole('link', { name: /Tasks/ })).toBeVisible({ timeout: 60_000 });
  await beat(page, 3000);

  // Drill into the CHW's area → a household, so we can register a woman there.
  await page.goto(`${INSTANCE}/#/contacts`);
  await page.getByRole('link', { name: /FCHV Area/ }).first().click();
  await beat(page, 2500);
  await page.getByRole('link', { name: /Household/ }).first().click();
  await beat(page, 2500);

  // --- Add a new pregnant woman (real contact form Submit) ---
  await contentFab(page).click(); // household → New patient
  await expect(page.getByRole('textbox', { name: /Patient name/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('textbox', { name: /Patient name/ }).fill(WOMAN);
  await page.getByRole('radio', { name: 'Female' }).check();
  await beat(page, 2000);
  // CHT runs an async duplicate search; if earlier runs left a same-named
  // woman it blocks submit until "not a duplicate" is confirmed.
  const dupConfirm = page.getByRole('checkbox', { name: /not a duplicate/i });
  await dupConfirm.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  if (await dupConfirm.isVisible().catch(() => false)) await dupConfirm.check();
  await enketoSubmit(page);
  await expect(page.getByRole('heading', { name: WOMAN })).toBeVisible({ timeout: 30_000 });
  await beat(page, 3000);

  // --- Register her pregnancy (real report Submit, with the first-pregnancy branch) ---
  await contentFab(page).click(); // person → New action menu
  await page.getByRole('dialog').getByText('pregnancy_registration', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'pregnancy_registration' })).toBeVisible({ timeout: 30_000 });
  await enketoSetDate(page, LMP);               // page 1: LMP date
  await beat(page, 1500);
  await enketoNext(page);
  await page.getByRole('textbox', { name: /Mother/ }).fill(WOMAN); // page 2: mother's name
  await beat(page, 1500);
  await enketoNext(page);
  await page.getByRole('radio', { name: 'Yes' }).check(); // page 3: first pregnancy? → Yes
  await beat(page, 1500);
  await enketoNext(page);
  // page 4: the congrats note becomes relevant — linger so it's visible on camera.
  await expect(page.getByText('Congratulations on your first pregnancy!')).toBeVisible({ timeout: 15_000 });
  await beat(page, 3500);
  await enketoSubmit(page);
  await expect(page.getByRole('heading', { name: WOMAN })).toBeVisible({ timeout: 30_000 });
  await beat(page, 3000);

  // --- Work the task: Tasks tab → her ANC visit → fill the danger-signs form ---
  await page.goto(`${INSTANCE}/#/tasks`);
  const task = page.getByRole('link', { name: new RegExp(WOMAN) }).first();
  await expect(task).toBeVisible({ timeout: 90_000 }); // rules engine computes the schedule
  await beat(page, 2500);
  await task.click();
  await expect(page.getByRole('heading', { name: 'pregnancy_visit' })).toBeVisible({ timeout: 30_000 });
  await beat(page, 2500);
  // Advance past the patient-id page to the danger-signs checklist.
  const danger = page.getByRole('checkbox', { name: 'Severe headache' });
  if (!(await danger.isVisible().catch(() => false))) await enketoNext(page);
  await page.getByRole('checkbox', { name: 'Severe headache' }).check();
  await page.getByRole('checkbox', { name: 'Swelling of face or hands' }).check();
  await beat(page, 2500);
  await enketoSubmit(page);
  // Landing after a task submit is the task-group / tasks screen.
  await expect(page).toHaveURL(/#\/tasks/, { timeout: 30_000 });
  await beat(page, 3500);
});

/* =========================== Enketo (deployed CHT) helpers =========================== */
function contentFab(page: Page): Locator {
  return page.locator('.content-pane mm-fast-action-button button.fast-action-fab-button');
}
async function enketoNext(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Next >' }).click();
  await page.waitForTimeout(SLOW ? 500 : 150);
}
async function enketoSubmit(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
}
async function enketoSetDate(page: Page, value: string): Promise<void> {
  const inp = page.locator('input[placeholder="yyyy-mm-dd"]:visible').first();
  await inp.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    (el as HTMLInputElement).blur();
  }, value);
  await page.waitForTimeout(SLOW ? 400 : 100);
}

/* =========================== builder helpers =========================== */
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
async function createAppForm(page: Page, name: string): Promise<void> {
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: '+ App form' }).click();
  const createCard = page.locator('.create-form');
  await createCard.locator('input').first().fill(name);
  await createCard.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.page-header').getByRole('button', { name: /Save/ })).toBeVisible();
}
async function addQuestion(page: Page, tileLabel: string, name: string, label: string): Promise<void> {
  await page.getByRole('button', { name: '+ Question' }).first().click();
  const picker = page.locator('.qtype-modal');
  await picker.getByPlaceholder(/has_fever, patient_age/i).fill(name);
  await picker.locator('.qtype-tile').filter({ has: page.locator('.qtype-tile-label', { hasText: new RegExp(`^${tileLabel}$`) }) }).first().click();
  await expect(picker).not.toBeVisible();
  await labelInput(page, name).fill(label);
}
/** Create a select_one / select_multiple with its options, via the picker's
 *  built-in "configure list" step, then set the question's label. */
async function addSelectQuestion(
  page: Page,
  tileLabel: 'Select one' | 'Select many',
  name: string,
  label: string,
  options: Array<{ name: string; label: string }>,
): Promise<void> {
  await page.getByRole('button', { name: '+ Question' }).first().click();
  const picker = page.locator('.qtype-modal');
  await picker.getByPlaceholder(/has_fever, patient_age/i).fill(name);
  await picker.locator('.qtype-tile').filter({ has: page.locator('.qtype-tile-label', { hasText: new RegExp(`^${tileLabel}$`) }) }).first().click();
  // configure-list step: seed rows (starts with 2), fill name + label per option.
  const rows = picker.locator('.qtype-choice-row');
  while ((await rows.count()) < options.length) {
    await picker.getByRole('button', { name: '+ Add choice' }).click();
  }
  for (let i = 0; i < options.length; i += 1) {
    const cr = rows.nth(i);
    await cr.locator('input').nth(0).fill(options[i]!.name);
    await cr.locator('input').nth(1).fill(options[i]!.label);
  }
  await picker.getByRole('button', { name: 'Add question' }).click();
  await expect(picker).not.toBeVisible();
  await labelInput(page, name).fill(label);
}
/** Create a Note (display-only) row, optionally gated by a relevance expression. */
async function addNote(page: Page, name: string, label: string, relevance?: string): Promise<void> {
  await addQuestion(page, 'Note', name, label);
  if (relevance) {
    const row = rowByName(page, name);
    const toggle = row.locator('.expand-toggle');
    if ((await toggle.textContent())?.includes('show advanced')) await toggle.click();
    const rel = row.locator('.expr-field').filter({ has: page.locator('strong', { hasText: 'Show this question when' }) });
    await rel.locator('input').fill(relevance);
  }
}
function rowByName(page: Page, name: string): Locator {
  return page.locator('.survey-row').filter({ has: page.locator(`input.name-input[value="${name}"]`) });
}
function labelInput(page: Page, name: string): Locator {
  return rowByName(page, name).locator('.label-row', { hasText: 'label::en' }).locator('input');
}
async function saveForm(page: Page): Promise<void> {
  const header = page.locator('.page-header');
  const saved = header.getByRole('button', { name: 'Saved', exact: true });
  if (await saved.isVisible().catch(() => false)) return;
  await header.getByRole('button', { name: 'Save', exact: true }).click();
  const modalSave = page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true });
  if (await modalSave.isVisible().catch(() => false)) await modalSave.click();
  await expect(saved).toBeVisible();
}
