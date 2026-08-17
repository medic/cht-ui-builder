/**
 * GERIATRIC FULL-WORKFLOW PROBE (QA / Lorena, 2026-08-10) — the first runtime
 * test of the task lifecycle. Executes docs/qa-brief-geriatric-full-workflow.md:
 *
 *   build (assessment + 7 hidden refer_* flags + follow-up form + ONE task
 *   with modifyContent) → one-click deploy from inside the tool → live proof:
 *   60+ patient sees the form, a failed domain raises the task, tapping it
 *   opens the follow-up branched to that domain, submitting resolves it.
 *
 * Design decisions this file encodes (all from the brief + analysis doc):
 *  - ONE task, 7 OR-legs (planner's merge-geometry reading — agreed).
 *  - Template: "CHT baseline" (cht-default) — ships tasks-extras with
 *    isFormArraySubmittedInWindow, so the ResolvedWhenPicker emission is in
 *    scope; its 5 shipped tasks give us a free byte-survival check.
 *  - Day-0 window variant FIRST (days 30 / start 30 / end 15) per the brief's
 *    timing warning; the 15/30/15 spec shape is proven last (task correctly
 *    NOT visible) and left as the final on-disk state.
 *  - Task title: LITERAL string — the known queue-#8 blocker, documented.
 *  - modifyContent is built with the PICKER-emitted source (report.<field>)
 *    first — recon predicts that is wrong at runtime (fields live under
 *    report.fields.*) — then fixed via the picker's custom mode and reproven.
 *    Both runs are the deliverable, not a detour.
 *  - Intro section (consent / patient-name / BMI bridges) is out of scope
 *    here — proven elsewhere; patient-name insert is P1-DEPLOY-blocked.
 *
 * Run (servers boot via playwright.config webServer):
 *   pnpm --filter @cht-ui/shared build
 *   pnpm --filter @cht-ui/client exec playwright test geriatric-workflow-e2e.spec.ts --reporter=line
 * DEMO=1 records slow-motion 2K video (DEMO_MS to tune).
 */
import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {
  API, T, ihaSections, REFER_FLAGS,
  openProjectAt, ensureFullMode, rowByName, saveForm, readForm,
  createAppForm, addSection, addRow, fillRuleList,
} from './helpers/geriatric.js';
import type { Row, Rel } from './helpers/geriatric.js';

const PARENT = 'W:\\medic\\ui-builder-projects';
const PROJECT = path.join(PARENT, 'geriatric-workflow');
const INSTANCE = 'https://127-0-0-1.local-ip.medicmobile.org:10445';
const CHW = { user: 'geri_chw', pass: 'ElderCare!2026z' };
const CLINIC_ID = 'cacc1138-db44-4ca8-88fb-803aee5edf77';
const IHA = 'integrated_health_assessment';
const FOLLOWUP = 'referral_follow_up';
const TASK_TITLE = 'Geriatric referral follow-up';
const SLOW = process.env.DEMO ? Number(process.env.DEMO_MS ?? '600') : 0;

test.use({
  video: { mode: 'on', size: { width: 2560, height: 1440 } },
  viewport: { width: 2560, height: 1440 },
  ignoreHTTPSErrors: true,
  launchOptions: { slowMo: SLOW },
});

/* ─────────────── CHT API helpers (seeding + doc inspection) ─────────────── */
function chtReq(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((res, rej) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = https.request(
      new URL(INSTANCE + pathname),
      { method, rejectUnauthorized: false, headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from('medic:password').toString('base64'),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      } },
      (x) => { let s = ''; x.on('data', (d) => (s += d)); x.on('end', () => {
        try { res({ status: x.statusCode ?? 0, json: JSON.parse(s || '{}') }); }
        catch { res({ status: x.statusCode ?? 0, json: { raw: s.slice(0, 400) } }); }
      }); },
    );
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

async function seedElder(name: string, dob: string): Promise<string> {
  const { randomUUID } = await import('node:crypto');
  const id = randomUUID();
  const r = await chtReq('POST', '/medic', {
    _id: id, type: 'person', name, sex: 'female', date_of_birth: dob,
    parent: { _id: CLINIC_ID }, reported_date: Date.now(),
  });
  expect(r.json.ok, `seed ${name}: ${JSON.stringify(r.json)}`).toBeTruthy();
  return id;
}

/* ───────────────────────── Enketo runtime helpers ───────────────────────── */

/** Answer a select inside its own question container (labels repeat across
 *  questions, so scope by the question text first). */
async function answer(page: Page, qSnippet: string, choiceEn: string, kind: 'radio' | 'checkbox' = 'radio') {
  const q = page.locator('.question', { hasText: qSnippet }).first();
  await expect(q, `question visible: ${qSnippet}`).toBeVisible({ timeout: 15_000 });
  const input = q.getByRole(kind, { name: choiceEn });
  await input.first().check();
}
async function nextPage(page: Page) {
  await page.getByRole('button', { name: 'Next >' }).click();
  await page.waitForTimeout(SLOW ? 400 : 150);
}
async function submitForm(page: Page) {
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
}

type DomainPlan = {
  cognitive?: boolean; mobility?: boolean; nutrition?: boolean; vision?: boolean;
  hearing?: boolean; psych?: boolean; continence?: boolean; // true = FAIL it
};

/** Drive the whole assessment (one-screen sections → one Enketo page each). */
async function fillAssessment(page: Page, personId: string, fail: DomainPlan): Promise<void> {
  await page.goto(`${INSTANCE}/#/contacts/${personId}/report/${IHA}`);
  // Enketo boot can be slow on a loaded machine — wait for the first page.
  await expect(page.locator('.question:visible').first()).toBeVisible({ timeout: 120_000 });
  // Page 1 — Cognitive.
  if (fail.cognitive) {
    await answer(page, 'Do you have trouble remembering', 'Yes (Fail)');
    await answer(page, 'repeat these 3 words', 'Unable to repeat all three words (Fail)');
    await answer(page, "today's full date", 'Both correct (Pass)');
  } else {
    await answer(page, 'Do you have trouble remembering', 'No (Pass)');
  }
  await nextPage(page);
  // Mobility.
  if (fail.mobility) {
    await answer(page, 'do you feel safe standing up', 'Yes (Test)');
    await answer(page, 'How many seconds did it take', 'More than 14 seconds (Fail)');
  } else {
    await answer(page, 'do you feel safe standing up', 'No (Do not test)');
  }
  await nextPage(page);
  // Nutrition.
  await answer(page, 'has your weight decreased', fail.nutrition ? 'Yes (Fail)' : 'No (Pass)');
  await answer(page, 'belt become loose', 'No (Pass)');
  {
    const w = page.locator('.question', { hasText: 'Measure their weight' }).locator('input[type="number"]');
    if (await w.isVisible().catch(() => false)) await w.fill('60');
  }
  await nextPage(page);
  // Vision — external eye drives refer_vision (any finding except none).
  await answer(page, 'eye-related problems', 'No (Pass)');
  await answer(page, 'diabetes or high blood pressure', 'No (Pass)');
  await answer(page, 'Examine the external eye', fail.vision ? 'There is pus' : 'None of the above', 'checkbox');
  await nextPage(page);
  // Hearing — ear results are always asked.
  await answer(page, 'Do you have trouble hearing', 'No (Pass)');
  await answer(page, 'Right ear result', fail.hearing ? 'Unable to repeat all four words (Fail)' : 'Successfully repeated all four words (Pass)');
  await answer(page, 'Left ear result', 'Successfully repeated all four words (Pass)');
  await nextPage(page);
  // Psychological.
  await answer(page, 'persistently sad', fail.psych ? 'Yes (Fail)' : 'No (Pass)');
  await answer(page, 'little interest or pleasure', 'No (Pass)');
  await answer(page, 'thoughts of harming yourself', 'No (Pass)');
  await nextPage(page);
  // Social care (no flags).
  await answer(page, 'satisfied with the care', 'No (Pass)');
  await answer(page, 'not having enough money', 'No (Pass)');
  await answer(page, 'feel lonely', 'No (Pass)');
  await answer(page, 'activities you enjoy', 'No (Pass)');
  await nextPage(page);
  // Caregiver (no flags).
  await answer(page, 'adequate support from your family', 'Yes, I receive sufficient support');
  await answer(page, 'feel confident that you can take good care', 'Yes, I know what to do');
  await answer(page, 'caregiving affected your own health', 'No', 'radio');
  await answer(page, 'affected your own work or income', 'No difficulty');
  await nextPage(page);
  // Continence.
  await answer(page, 'trouble holding your urine', fail.continence ? 'Yes (Fail)' : 'No (Pass)');
  await nextPage(page);
  // Lifestyle advice (note-only page) → Submit.
  await submitForm(page);
  // Back on the contact profile = saved.
  await expect(page.locator('.content-pane')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(SLOW ? 2000 : 800);
}

/** Walk every relevant page of an open follow-up form, answering as we go;
 *  returns the question texts seen (the branching evidence). */
async function walkFollowup(page: Page, visited: 'yes' | 'no'): Promise<string[]> {
  const seen: string[] = [];
  const record = async () => {
    for (const t of await page.locator('.question:visible').allTextContents()) {
      seen.push(t.replace(/\s+/g, ' ').trim().slice(0, 80));
    }
  };
  await expect(page.getByRole('heading', { name: /Referral follow up/i })).toBeVisible({ timeout: 30_000 });
  await record();
  await answer(page, 'visit a relevant health facility', visited === 'yes' ? 'Yes' : 'No');
  for (let i = 0; i < 20; i += 1) {
    const submit = page.getByRole('button', { name: 'Submit', exact: true });
    if (await submit.isVisible().catch(() => false)) break;
    await nextPage(page);
    await record();
    // Answer whatever domain/select question this page shows, generically.
    const radios = page.locator('.question:visible').getByRole('radio');
    if ((await radios.count()) > 0) {
      const q = page.locator('.question:visible').first();
      const first = q.getByRole('radio').first();
      if (!(await first.isChecked().catch(() => true))) await first.check().catch(() => {});
    }
    const texts = page.locator('.question:visible input[type="text"]');
    if ((await texts.count()) > 0) await texts.first().fill('Reviewed at facility').catch(() => {});
  }
  await submitForm(page);
  await page.waitForTimeout(SLOW ? 2000 : 800);
  return seen;
}

async function loginChw(page: Page) {
  await page.goto(`${INSTANCE}/medic/login?redirect=%2F`);
  const user = page.locator('#user');
  if (await user.isVisible().catch(() => false)) {
    await user.fill(CHW.user);
    await page.locator('#password').fill(CHW.pass);
    await page.locator('#login').click();
  }
  await expect(page.getByRole('link', { name: /Tasks/ })).toBeVisible({ timeout: 90_000 });
}

/* ════════════════════ 1. BUILD — project, IHA, flags ════════════════════ */

test('workflow 1 — CHT-baseline project + assessment + 7 refer_* flags', async ({ page }) => {
  test.setTimeout(SLOW ? 2_400_000 : 900_000);
  await fs.rm(PROJECT, { recursive: true, force: true });
  await page.request.post(`${API}/api/project/close`).catch(() => {});

  // New Project wizard → CHT baseline template.
  await page.goto('/');
  await page.getByRole('button', { name: /Create new project/ }).click();
  const wizard = page.locator('.modal-wide');
  await wizard.locator('.template-card')
    .filter({ has: page.getByRole('heading', { name: 'CHT baseline' }) })
    .click();
  await wizard.getByRole('button', { name: /Next/ }).click();
  await wizard.locator('.form-row', { hasText: 'Parent folder' }).locator('input').fill(PARENT);
  await wizard.locator('.form-row', { hasText: 'Project name' }).locator('input').fill('geriatric-workflow');
  await wizard.getByRole('button', { name: /Next/ }).click();
  await wizard.getByRole('button', { name: /Create project/ }).click();
  await expect(page.locator('.nav-item', { hasText: 'Forms' })).toBeVisible({ timeout: 60_000 });
  // Snapshot the shipped tasks.js for the byte-survival check in test 3.
  await fs.copyFile(path.join(PROJECT, 'tasks.js'), path.join(PROJECT, 'tasks.js.shipped'));

  // The assessment: form + 60+ eligibility + Nepali + the 10 sections
  // (one-screen, so each section is a single Enketo page at runtime).
  await createAppForm(page, 'Integrated Health Assessment', IHA);
  await page.getByRole('button', { name: 'Properties', exact: true }).click();
  await page.getByLabel('Available on people').check();
  const ctx = page.locator('.context-builder');
  await ctx.getByRole('button', { name: '+ age', exact: true }).click();
  const ageRow = ctx.locator('.rule-row').last();
  await ageRow.locator('select').first().selectOption('>=');
  await ageRow.locator('input[type="number"]').fill('60');
  await page.getByRole('button', { name: /^Survey/ }).first().click();
  const bar = page.locator('.language-chip-bar');
  await bar.getByRole('button', { name: '+ Add language' }).click();
  await page.locator('.language-chip-popover').locator('button', { hasText: 'नेपाली (Nepali)' }).click();
  await saveForm(page);

  for (const section of ihaSections(true)) {
    console.log(`[wf] section: ${section.en}`);
    const accordion = await addSection(page, section);
    for (const row of section.rows) await addRow(page, accordion, row);
    await saveForm(page);
  }

  /* The 7 hidden referral flags — Calculate tile + If-then table.
     Interaction cost is logged per flag (brief deliverable 3). */
  let flagActions = 0;
  for (const flag of REFER_FLAGS) {
    console.log(`[wf] flag: ${flag.name}`);
    await ensureFullMode(page);
    await addRow(page, null, { name: flag.name, en: '', ne: '', tile: T.calc });
    const calcRow = rowByName(page, flag.name);
    const adv = calcRow.getByRole('button', { name: /show advanced/ });
    if (await adv.isVisible().catch(() => false)) await adv.click();
    await calcRow
      .locator('.expr-field')
      .filter({ has: page.locator('code.raw-col-tag', { hasText: 'calculation' }) })
      .locator('button', { hasText: 'build' })
      .click();
    const calc = page.locator('.rule-builder-modal[aria-label="Calculation builder"]');
    await expect(calc).toBeVisible();
    await calc.getByRole('tab', { name: 'If-then table' }).click();
    await calc.getByRole('button', { name: '+ Rule' }).click();
    await calc.getByRole('button', { name: /edit condition for rule 1/ }).click();
    const rb = page.locator('.rule-builder-card').last(); // nested condition editor
    await fillRuleList(page, rb, flag.rel);
    await rb.getByRole('button', { name: 'Save', exact: true }).click();
    // Then-output 'true'; the otherwise cell MUST be touched (recon: an
    // untouched otherwise emits malformed `if(cond, 'true', )`).
    const table = calc.locator('table.decision-table');
    await table.locator('tbody tr').first().locator('input[aria-label="Literal text"]').fill('true');
    const otherwise = calc.locator('.otherwise-row').locator('input[aria-label="Literal text"]');
    await otherwise.fill('x');
    await otherwise.fill('');
    await calc.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(calc).toBeHidden();
    flagActions += 8 + flag.rel.rules.length * 4;
  }
  await saveForm(page);
  console.log(`[wf] flag interaction cost ≈ ${flagActions} actions for 7 flags`);

  // Disk truth: each flag's calculation is a well-formed if(cond,'true','').
  const form = await readForm(page, `app:${IHA}`);
  for (const flag of REFER_FLAGS) {
    const row = form.survey.find((r) => r.name === flag.name);
    expect(row, `${flag.name} on disk`).toBeTruthy();
    expect(row!.type.trim()).toBe('calculate');
    const calc = row!.extras['calculation'] ?? '';
    expect(calc, `${flag.name} calculation well-formed: ${calc}`).toMatch(/^if\(.+, 'true', ''\)$/);
  }
  const vision = form.survey.find((r) => r.name === 'refer_vision')!.extras['calculation']!;
  expect(vision).toContain('selected(');
  expect(vision).toContain(' or ');
  console.log('[wf] refer_vision =', vision);
});

/* ═════════════ 2. BUILD — follow-up form + the ONE task ═════════════ */

test('workflow 2 — follow-up form (flag-gated) + one task with modifyContent', async ({ page }) => {
  test.setTimeout(SLOW ? 1_800_000 : 600_000);
  await openProjectAt(page, PROJECT);
  await page.goto('/');

  /* 2a. Referral Follow-up form. */
  await createAppForm(page, 'Referral follow up', FOLLOWUP);
  const bar = page.locator('.language-chip-bar');
  await bar.getByRole('button', { name: '+ Add language' }).click();
  await page.locator('.language-chip-popover').locator('button', { hasText: 'नेपाली (Nepali)' }).click();

  // Receiving nodes for modifyContent: hidden rows INSIDE the inputs group
  // (CHT binds content.<key> to inputs/<key>). "+ add inside" on the inputs
  // accordion is the only affordance — record it works (or doesn't).
  await ensureFullMode(page);
  const inputsAccordion = page
    .locator('.survey-group-accordion')
    .filter({ has: page.locator('code', { hasText: /^inputs$/ }) })
    .first();
  await expect(inputsAccordion, 'inputs group accordion visible in Full mode').toBeVisible();
  // Scaffold groups render COLLAPSED — expand before "+ add inside" exists.
  if (!(await inputsAccordion.getByRole('button', { name: /\+ add inside|\+ Add question/ }).first().isVisible().catch(() => false))) {
    await inputsAccordion.locator('.survey-group-header').first().click();
  }
  for (const flag of REFER_FLAGS) {
    await inputsAccordion.getByRole('button', { name: /\+ add inside|\+ Add question/ }).first().click();
    const picker = page.locator('.qtype-modal');
    await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill(flag.name);
    await picker.locator('.qtype-tile')
      .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Hidden$/ }) })
      .click();
    await expect(picker).not.toBeVisible();
  }
  await saveForm(page);

  // Content rows (sheet R3–R16; R1/R2 out of scope — see header).
  const YES_NO: Row['list'] = { list: 'yes_no', choices: [
    { name: 'yes', en: 'Yes', ne: 'छ' },
    { name: 'no', en: 'No', ne: 'छैन' },
  ] };
  const STATUS = (list: string): Row['list'] => ({ list, choices: [
    { name: `${list}_improving`, en: 'Improving', ne: 'सुधारोन्मुख' },
    { name: `${list}_same`, en: 'No change', ne: 'उस्तै छ' },
    { name: `${list}_worse`, en: 'Getting worse', ne: 'झन् खराब' },
  ] });
  const visitedYes: Rel = { kind: 'cmp', field: 'visited_facility', choice: 'yes' };
  const flagTrue = (f: string): Rel => ({ kind: 'cmp', field: f, choice: 'true' });

  const FOLLOWUP_ROWS: Row[] = [
    { name: 'visited_facility', tile: T.s1, required: true, list: YES_NO,
      en: 'Did they visit a relevant health facility or doctor for further evaluation?',
      ne: 'के उहाँ सम्बन्धित स्वास्थ्य संस्था वा डाक्टरकहाँ थप जाँचका लागि जानुभएको थियो?' },
    { name: 'formal_exam', tile: T.s1, required: true, reuse: 'yes_no',
      en: 'Was a formal examination conducted at the referred health facility?',
      ne: 'के प्रेषण संस्थामा औपचारिक परीक्षण भएको छ ?',
      rel: { rules: [visitedYes] } },
    { name: 'diagnosis_result', tile: T.text,
      en: 'Diagnosis / Result', ne: 'निदान / परिणाम',
      rel: { rules: [visitedYes] } },
    { name: 'meds_started', tile: T.s1, required: true, reuse: 'yes_no',
      en: 'Was medication or therapy started?', ne: 'औषधि वा थेरापी सुरु भयो ?',
      rel: { rules: [visitedYes] } },
    // The 8 domain rows — each gated on visited=yes AND its refer_* flag.
    { name: 'memory_improvement', tile: T.s1, required: true, list: STATUS('mem'),
      en: 'Improvement in memory', ne: 'सम्झने क्षमतामा सुधार',
      rel: { rules: [visitedYes, flagTrue('refer_cognitive')] } },
    { name: 'sit_stand_followup', tile: T.s1, required: true, list: STATUS('mob'),
      en: 'Time taken to complete five sit-to-stand repetitions', ne: '५ पटक उठन-बस्न लागेको समय',
      rel: { rules: [visitedYes, flagTrue('refer_mobility')] } },
    { name: 'weight_increased', tile: T.s1, required: true, list: STATUS('nut'),
      en: 'Has the weight increased?', ne: 'तौल बढेको छ ?',
      rel: { rules: [visitedYes, flagTrue('refer_nutrition')] } },
    { name: 'external_eye_now', tile: T.s1, required: true, list: STATUS('eye'),
      en: 'What is the current external condition of the eye?', ne: 'हाल बाह्य आँखाको अवस्था कस्तो छ ?',
      rel: { rules: [visitedYes, flagTrue('refer_vision')] } },
    { name: 'hearing_status', tile: T.s1, required: true, list: STATUS('ear'),
      en: 'What is the current status of hearing ability?', ne: 'श्रवण क्षमताको अवस्था कस्तो छ ?',
      rel: { rules: [visitedYes, flagTrue('refer_hearing')] } },
    { name: 'psych_status', tile: T.s1, required: true, list: STATUS('psy'),
      en: 'Psychological status', ne: 'मनोवैज्ञानिक अवस्था',
      rel: { rules: [visitedYes, flagTrue('refer_psych')] } },
    { name: 'continence_status', tile: T.s1, required: true, list: STATUS('con'),
      en: 'Urinary continence', ne: 'पिसाब नियन्त्रण',
      rel: { rules: [visitedYes, flagTrue('refer_continence')] } },
    { name: 'not_visited_note', tile: T.note,
      en: 'Advise the family that further treatment is required and refer them immediately to an appropriate health facility.',
      ne: 'उहाँलाई थप उपचारको आवश्यकता भएको भनि घर परिवारलाई सल्लाह दिनुहोस् र उपचार हुने स्वास्थ्य संस्थामा तुरुन्तै प्रेषण गर्नुहोस् ।',
      rel: { rules: [{ kind: 'cmp', field: 'visited_facility', choice: 'no' }] } },
  ];
  for (const row of FOLLOWUP_ROWS) {
    console.log(`[wf] follow-up row: ${row.name}`);
    await ensureFullMode(page);
    await addRow(page, null, row);
  }
  await saveForm(page);

  /* 2b. The task. */
  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  await page.getByRole('button', { name: '+ Add task' }).click();
  const card = page.locator('.task-card').last();
  const nameField = card.locator('.expr-field', { hasText: 'name' }).first();
  await nameField.locator('input').first().fill(TASK_TITLE);
  await nameField.getByRole('button', { name: 'use this' }).click();
  // LITERAL title — queue-#8 blocker (translation keys can't be created).
  const titleField = card.locator('.expr-field', { hasText: 'title' }).first();
  await titleField.locator('input').first().fill(TASK_TITLE);
  await card.locator('.expr-field', { hasText: 'appliesToType' })
    .getByRole('checkbox', { name: IHA, exact: true }).check();

  // Condition: OR of the 7 flags (connector pills; free-text 'true' values —
  // calc fields have no choice lists, recorded as friction).
  await card.locator('.expr-field', { hasText: 'appliesIf' })
    .locator('button', { hasText: '✎ build' }).click();
  const aif = page.locator('.rule-builder-modal');
  await expect(aif).toBeVisible();
  for (const flag of REFER_FLAGS) {
    await aif.getByRole('button', { name: '+ report field', exact: true }).click();
    const row = aif.locator('.rule-row').last();
    await row.locator('select.field-picker').selectOption(flag.name);
    const valueSelect = row.locator('select.choice-value-select');
    if (await valueSelect.isVisible().catch(() => false)) await valueSelect.selectOption('true');
    else await row.getByPlaceholder('value', { exact: true }).fill('true'); // calc fields: free-text cell
  }
  // Pills adjacent to the template's raw `return true;` row are disabled by
  // design (raw rows can't join OR groups) — flip only the enabled ones.
  const pills = aif.locator('select.connector-pill');
  for (let i = 0; i < (await pills.count()); i += 1) {
    const pill = pills.nth(i);
    if (await pill.isEnabled().catch(() => false)) await pill.selectOption('or');
  }
  await expect(aif.locator('.preview pre')).toContainText("Utils.getField(report, 'refer_cognitive') !== 'true'");
  await aif.getByRole('button', { name: 'Save' }).click();
  await expect(aif).toBeHidden();

  // Window: DAY-0 VARIANT first (days 30 / start 30 / end 15) — brief §timing.
  const events = card.locator('.events-editor');
  const ev = events.locator('.event-card').first();
  await ev.locator('.name-input').fill('referral_followup_30d');
  await ev.locator('input[type=number]').nth(0).fill('30');
  await ev.locator('input[type=number]').nth(1).fill('30');
  await ev.locator('input[type=number]').nth(2).fill('15');

  // Resolution: follow-up submitted in window (ResolvedWhenPicker).
  const resolved = card.locator('.expr-field', { hasText: 'resolvedIf' });
  // NB: label-wrapped buttons get the whole section as ACCESSIBLE NAME, so
  // match by the button's own TEXT (hasText), never by role name here.
  await resolved.locator('button', { hasText: /^Visual$/ }).click();
  await resolved.locator('button', { hasText: 'use "form submitted in window"' }).click();
  await resolved.locator('button', { hasText: /^pick$/ }).click();
  await resolved.locator('select[title="App form whose submission resolves the task"]').selectOption(FOLLOWUP);

  // Action: open the follow-up, carrying the 7 flags. Source = the PICKER's
  // report.<field> emission — recon predicts this is WRONG at runtime
  // (report.fields.* is the doc shape). Built as-emitted deliberately.
  const actions = card.locator('.expr-field', { hasText: 'actions' });
  const action = actions.locator('.actions-list .event-card').first();
  await action.locator('.expr-field', { hasText: 'form' }).locator('select').selectOption(FOLLOWUP);
  for (let i = 0; i < REFER_FLAGS.length; i += 1) {
    const flag = REFER_FLAGS[i]!;
    if (i === 0) await action.locator('button', { hasText: '+ Add field mapping' }).click();
    else await action.locator('.modify-content-editor').locator('..').locator('button', { hasText: '+ Add mapping' }).click();
    const mrow = action.locator('.modify-content-table tbody tr').nth(i);
    // TARGET: custom text — the picker lists the follow-up's fields as
    // dotted `inputs.<name>` paths, and a dotted target is a known landmine
    // (content.inputs.x = … throws + degrades to raw). Friction recorded.
    await mrow.locator('button', { hasText: 'custom' }).first().click();
    await mrow.locator('input[placeholder="e.g. patient_id"]').fill(flag.name);
    await mrow.locator('select.mapping-source-mode').selectOption('report');
    await mrow.locator('select').last().selectOption(flag.name);
  }
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible({ timeout: 20_000 });
});

/* ═════════ 3. Emitted tasks.js semantics + template survival ═════════ */

test('workflow 3 — tasks.js: semantics correct AND the 5 shipped tasks survive byte-identical', async ({ page }) => {
  const saved = await fs.readFile(path.join(PROJECT, 'tasks.js'), 'utf8');
  const shipped = await fs.readFile(path.join(PROJECT, 'tasks.js.shipped'), 'utf8');

  // (a) our entry's semantics
  expect(saved).toContain(`appliesToType: [ '${IHA}' ]`);
  for (const flag of REFER_FLAGS) {
    expect(saved, `guard leg for ${flag.name}`).toContain(`Utils.getField(report, '${flag.name}') !== 'true'`);
  }
  expect(saved).toContain("{ id: 'referral_followup_30d', days: 30, start: 30, end: 15 }");
  expect(saved).toContain('isFormArraySubmittedInWindow(');
  expect(saved).toContain(`'${FOLLOWUP}'`);
  expect(saved).toContain('modifyContent: function (content, contact, report, event)');
  expect(saved).toContain('content.refer_cognitive = report.refer_cognitive;');
  expect(saved).toContain(`title: '${TASK_TITLE}'`);

  // (b) byte-survival of the cht-default entries. RESULT (P0 finding,
  // 2026-08-10): the tool's save DROPS standalone comments and — far worse —
  // TRUNCATES the unknown-LMP ANC task's computed events expression
  // `[...Array(21).keys()].map(i => generateEventForHomeVisit(...))` down to
  // `[...Array(21).keys()]` — silent semantic corruption of a hand-written
  // entry on a plain save. Recorded here, then REPAIRED (documented hand-fix)
  // so the runtime phases don't run on a possibly engine-crashing config.
  const shippedBody = shipped.slice(shipped.indexOf('module.exports'));
  const missing = shippedBody.split('\n').filter((l) => l.trim().length > 2 && !saved.includes(l));
  if (missing.length > 0) {
    console.log(`[wf] 🔴 P0 FINDING — ${missing.length} shipped tasks.js lines lost/rewritten on tool save:`);
    for (const l of missing) console.log('   |', l.slice(0, 110));
    test.info().annotations.push({ type: 'finding-P0', description: `tool save corrupted ${missing.length} shipped tasks.js lines (computed events .map() truncated)` });
    await fs.copyFile(path.join(PROJECT, 'tasks.js'), path.join(PROJECT, 'tasks.js.corrupted-evidence'));
    await repairShippedTasks();
    const repaired = await fs.readFile(path.join(PROJECT, 'tasks.js'), 'utf8');
    expect(repaired).toContain('generateEventForHomeVisit((i + 1) * 2, 6, 7)');
    expect(repaired).toContain(`title: '${TASK_TITLE}'`);
    console.log('[wf] repaired: shipped entries restored + our task kept');
  } else {
    console.log('[wf] shipped cht-default tasks: byte-survival OK');
  }
  void page;
});

/** Reconstruct tasks.js = shipped entries + our (tool-authored) last entry.
 *  Documented hand-fix for the P0 above; called after every tool save. */
async function repairShippedTasks(): Promise<void> {
  const saved = await fs.readFile(path.join(PROJECT, 'tasks.js'), 'utf8');
  const shipped = await fs.readFile(path.join(PROJECT, 'tasks.js.shipped'), 'utf8');
  const ourStart = saved.indexOf("    name: 'geriatric");
  if (ourStart < 0) throw new Error('our task entry not found in saved tasks.js');
  const entryStart = saved.lastIndexOf('{', ourStart);
  const entryEnd = saved.lastIndexOf('];');
  let ourEntry = saved.slice(entryStart, entryEnd).trimEnd();
  if (ourEntry.endsWith(',')) ourEntry = ourEntry.slice(0, -1);
  const close = shipped.lastIndexOf('];');
  let head = shipped.slice(0, close).trimEnd();
  if (!head.endsWith(',')) head += ',';
  await fs.writeFile(path.join(PROJECT, 'tasks.js'), `${head}\n  ${ourEntry}\n];\n`);
}

/* ═════════════════ 4. One-click deploy from inside the tool ═════════════════ */

test('workflow 4 — one-click deploy (+ the translations gap)', async ({ page }) => {
  test.setTimeout(1_200_000);
  await openProjectAt(page, PROJECT);
  await page.goto('/');

  // SELF-HEAL: force the day-0 window variant (start=30) before deploying,
  // regardless of what an earlier partial run left on disk.
  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  const card = page.locator('.task-card').filter({ hasText: TASK_TITLE }).first();
  const expand = card.getByRole('button', { name: '▸' });
  if (await expand.isVisible().catch(() => false)) await expand.click();
  const ev = card.locator('.events-editor .event-card').first();
  await ev.locator('input[type=number]').nth(1).fill('30');
  const saveBtn = page.locator('.page-header').getByRole('button', { name: 'Save', exact: true });
  if (await saveBtn.isVisible().catch(() => false)) {
    await saveBtn.click();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible({ timeout: 20_000 });
    await repairShippedTasks();
  }
  expect(await fs.readFile(path.join(PROJECT, 'tasks.js'), 'utf8'))
    .toContain("{ id: 'referral_followup_30d', days: 30, start: 30, end: 15 }");

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
  await expect(oneclick.locator('.deploy-oneclick-step.state-success')).toHaveCount(6, { timeout: 900_000 });
  console.log('[wf] one-click deploy: 6/6 steps green');

  // FINDING (recon-confirmed): upload-custom-translations is NOT part of the
  // one-click pipeline (nor the server's step enum) — a bilingual project's
  // messages-ne never ships one-click. The individual action button in the
  // panel is the in-tool fallback; drive it and record.
  const translations = page.getByRole('button', { name: /custom translations/i }).first();
  if (await translations.isVisible().catch(() => false)) {
    await translations.click();
    console.log('[wf] upload-custom-translations: fired via the individual action button (NOT one-click)');
    await page.waitForTimeout(8000);
  } else {
    console.log('[wf] upload-custom-translations button NOT found — translations undeployable in-tool');
  }

  // Verify what actually landed.
  const settings = await chtReq('GET', '/api/v1/settings');
  const tasksSrc = JSON.stringify(settings.json.tasks ?? '');
  expect(JSON.stringify(settings.json), 'deployed settings carry our task').toContain('referral_followup_30d');
  const form = await chtReq('GET', `/medic/form:${IHA}`);
  expect(form.status, 'IHA form doc on instance').toBe(200);
  const fu = await chtReq('GET', `/medic/form:${FOLLOWUP}`);
  expect(fu.status, 'follow-up form doc on instance').toBe(200);
  void tasksSrc;
});

/* ═════════ 5. RUNTIME — eligibility, task fires, landmine leg ═════════ */


/** Wait for a task link, reloading up to N times (slow rules-engine machines). */
async function waitForTask(page: Page, nameRe: RegExp, reloads = 3): Promise<Locator> {
  for (let i = 0; i <= reloads; i += 1) {
    await page.goto(`${INSTANCE}/#/tasks`);
    const link = page.getByRole('link', { name: nameRe }).first();
    try {
      await expect(link).toBeVisible({ timeout: 45_000 });
      return link;
    } catch {
      if (i === reloads) throw new Error(`task ${nameRe} not visible after ${reloads + 1} attempts`);
      await page.reload();
      await page.waitForTimeout(4000);
    }
  }
  throw new Error('unreachable');
}

/** Delete every person + report left by earlier probe runs (idempotent). */
async function cleanupRuntimeData(): Promise<void> {
  const names = ['Kali Devi', 'Ratna Kumari', 'Purna Maya', 'Shanta Devi', 'Ganga Maya'];
  const docs: Array<{ _id: string; _rev: string }> = [];
  const people = await chtReq('POST', '/medic/_find', { selector: { type: 'person', name: { $in: names } }, limit: 200 });
  docs.push(...(people.json.docs ?? []));
  for (const form of [IHA, FOLLOWUP]) {
    const r = await chtReq('POST', '/medic/_find', { selector: { type: 'data_record', form }, limit: 200 });
    docs.push(...(r.json.docs ?? []));
  }
  if (docs.length) {
    await chtReq('POST', '/medic/_bulk_docs', { docs: docs.map((d) => ({ _id: d._id, _rev: d._rev, _deleted: true })) });
    console.log(`[wf] cleanup: deleted ${docs.length} leftover runtime docs`);
  }
}

test('workflow 5 — runtime: eligibility + task fires + picker-emitted modifyContent (landmine leg)', async ({ page }) => {
  test.setTimeout(SLOW ? 2_400_000 : 900_000);
  await cleanupRuntimeData();
  const elder1 = await seedElder('Kali Devi', '1958-03-10');

  await loginChw(page);
  // (1) eligibility: 60+ sees the assessment; the under-60 CHW contact doesn't.
  await page.goto(`${INSTANCE}/#/contacts/${elder1}`);
  await expect(page.locator('.content-pane').getByRole('heading', { name: 'Kali Devi' })).toBeVisible({ timeout: 60_000 });
  await page.locator('.content-pane mm-fast-action-button button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Integrated Health Assessment', { exact: false })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  console.log('[wf] ✓ eligibility: 60+ contact offers the assessment');

  // (2) fail exactly ONE domain (cognitive) and submit.
  await fillAssessment(page, elder1, { cognitive: true });
  // Flags truth from the submitted doc (no server-side sort — needs an index):
  const find = await chtReq('POST', '/medic/_find', { selector: { type: 'data_record', form: IHA }, limit: 50 });
  const iha1 = (find.json.docs ?? []).sort((a: any, b: any) => b.reported_date - a.reported_date)[0];
  console.log('[wf] submitted IHA flags:', JSON.stringify({
    refer_cognitive: iha1?.fields?.refer_cognitive, refer_vision: iha1?.fields?.refer_vision,
  }));
  expect(iha1?.fields?.refer_cognitive, 'refer_cognitive flag persisted in the report').toBe('true');

  // (3) the task appears (day-0 window variant).
  const task = await waitForTask(page, /Kali Devi/);
  await expect(task).toContainText(TASK_TITLE);
  await page.screenshot({ path: 'test-results/wf-task-card.png' });
  console.log('[wf] ✓ task visible with literal title');

  // (4)+(5) tap → follow-up opens; landmine leg: picker-emitted
  // report.<field> sources — do the flags arrive?
  await task.click();
  const seen = await walkFollowup(page, 'yes');
  const sawCognitive = seen.some((t) => t.includes('Improvement in memory'));
  const sawOtherDomain = seen.some((t) => t.includes('sit-to-stand') || t.includes('hearing ability'));
  console.log(`[wf] LANDMINE LEG — cognitive row shown: ${sawCognitive}; other domains shown: ${sawOtherDomain}`);
  console.log('[wf] pages seen:', JSON.stringify(seen.slice(0, 12)));
  // Doc truth for deliverable 4:
  const fuFind = await chtReq('POST', '/medic/_find', { selector: { type: 'data_record', form: FOLLOWUP }, limit: 5 });
  const fu1 = (fuFind.json.docs ?? []).sort((a: any, b: any) => b.reported_date - a.reported_date)[0];
  console.log('[wf] follow-up doc inputs:', JSON.stringify(fu1?.fields?.inputs ?? fu1?.fields ?? {}).slice(0, 400));

  // (6) submitting resolved the task.
  await page.goto(`${INSTANCE}/#/tasks`);
  await page.waitForTimeout(SLOW ? 4000 : 2500);
  await expect(page.getByRole('link', { name: /Kali Devi/ })).toHaveCount(0, { timeout: 60_000 });
  console.log('[wf] ✓ task resolved on follow-up submission');
});

/* ═════════ 6. Fix the mapping sources (report.fields.*) + redeploy ═════════ */

test('workflow 6 — correct the modifyContent sources via custom mode + redeploy', async ({ page }) => {
  test.setTimeout(1_200_000);
  await openProjectAt(page, PROJECT);
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  const card = page.locator('.task-card').filter({ hasText: TASK_TITLE }).first();
  const expand = card.getByRole('button', { name: '▸' });
  if (await expand.isVisible().catch(() => false)) await expand.click();
  // FINDING (B), upgraded at runtime: the structured source picker cannot
  // express `report.fields.<x>` — its report-mode emits the broken bare
  // `report.<x>`, and switching the row to custom RESETS the source to ''
  // which demotes the whole mapping table to read-only. The only in-tool
  // path to a WORKING mapping is the actions field's Raw JS escape hatch
  // (typed JS — fails the strict no-code bar; recorded).
  const actionsField = card.locator('.expr-field', { hasText: 'actions' }).first();
  await actionsField.locator('button', { hasText: /^Raw JS$/ }).first().click();
  const ta = actionsField.locator('textarea').first();
  await expect(ta).toBeVisible();
  const cur = await ta.inputValue();
  expect(cur).toContain('content.refer_cognitive = report.refer_cognitive;');
  await ta.fill(cur.replaceAll('= report.refer_', '= report.fields.refer_'));
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible({ timeout: 20_000 });
  await repairShippedTasks(); // every tool save re-corrupts the shipped entries (P0)
  const saved = await fs.readFile(path.join(PROJECT, 'tasks.js'), 'utf8');
  expect(saved).toContain('content.refer_cognitive = report.fields.refer_cognitive;');

  // Redeploy (settings only would do, but one-click is the in-tool gesture).
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
  await expect(oneclick.locator('.deploy-oneclick-step.state-success')).toHaveCount(6, { timeout: 900_000 });
});

/* ═════ 7. RUNTIME — corrected mappings: single, triple, negative ═════ */

test('workflow 7 — branch-correct follow-up, one task for 3 domains, no task on all-pass', async ({ page }) => {
  test.setTimeout(SLOW ? 3_000_000 : 1_500_000);
  const single = await seedElder('Ratna Kumari', '1955-06-01');
  const triple = await seedElder('Purna Maya', '1952-01-20');
  const allpass = await seedElder('Shanta Devi', '1950-11-11');

  await loginChw(page);

  // (A) single-domain fail → follow-up shows EXACTLY that domain.
  await fillAssessment(page, single, { cognitive: true });
  const t1 = await waitForTask(page, /Ratna Kumari/);
  await t1.click();
  const seen1 = await walkFollowup(page, 'yes');
  expect(seen1.some((t) => t.includes('Improvement in memory')), 'cognitive row shown').toBe(true);
  for (const other of ['sit-to-stand', 'weight increased', 'external condition of the eye', 'hearing ability', 'Psychological status', 'Urinary continence']) {
    expect(seen1.some((t) => t.toLowerCase().includes(other.toLowerCase())), `${other} hidden`).toBe(false);
  }
  console.log('[wf] ✓ single-domain branch correct');
  const fuFind = await chtReq('POST', '/medic/_find', { selector: { type: 'data_record', form: FOLLOWUP }, limit: 10 });
  const newest = (fuFind.json.docs ?? []).sort((a: any, b: any) => b.reported_date - a.reported_date)[0];
  const inputs = newest?.fields?.inputs ?? {};
  console.log('[wf] saved-doc inputs:', JSON.stringify(inputs).slice(0, 300));
  // FINDING: delivery into the LIVE form is proven by the branch assertions
  // above; the SAVED doc's inputs come back '' because the scaffold gates the
  // inputs group on source='user' and Enketo clears non-relevant values on
  // submit. Persisting task-delivered flags needs harvest calculates (the
  // canonical CHT pattern) which the tool has no affordance to create.
  if (String(inputs.refer_cognitive ?? '') !== 'true') {
    console.log('[wf] FINDING: inputs cleared on submit — flags not persisted in the saved follow-up doc');
  }

  // (B) three domains fail → ONE task; follow-up shows exactly those three.
  await fillAssessment(page, triple, { cognitive: true, vision: true, psych: true });
  await waitForTask(page, /Purna Maya/);
  await expect(page.getByRole('link', { name: /Purna Maya/ })).toHaveCount(1);
  console.log('[wf] ✓ one task, not three');
  await page.getByRole('link', { name: /Purna Maya/ }).first().click();
  const seen3 = await walkFollowup(page, 'yes');
  expect(seen3.some((t) => t.includes('Improvement in memory')), 'cognitive shown').toBe(true);
  expect(seen3.some((t) => t.includes('external condition of the eye')), 'vision shown').toBe(true);
  expect(seen3.some((t) => t.includes('Psychological status')), 'psych shown').toBe(true);
  expect(seen3.some((t) => t.includes('sit-to-stand')), 'mobility hidden').toBe(false);
  expect(seen3.some((t) => t.includes('hearing ability')), 'hearing hidden').toBe(false);
  console.log('[wf] ✓ triple-domain branch correct');

  // (C) all-pass → NO task.
  await fillAssessment(page, allpass, {});
  await page.goto(`${INSTANCE}/#/tasks`);
  await page.waitForTimeout(SLOW ? 6000 : 4000);
  await expect(page.getByRole('link', { name: /Shanta Devi/ })).toHaveCount(0);
  console.log('[wf] ✓ all-pass raises no task');
});

/* ═════ 8. Window semantics — restore start:15, task correctly invisible ═════ */

test('workflow 8 — 15/30/15 restored: a fresh failure is NOT visible on day 0', async ({ page }) => {
  test.setTimeout(1_500_000);
  await openProjectAt(page, PROJECT);
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  const card = page.locator('.task-card').filter({ hasText: TASK_TITLE }).first();
  const expand = card.getByRole('button', { name: '▸' });
  if (await expand.isVisible().catch(() => false)) await expand.click();
  const ev = card.locator('.events-editor .event-card').first();
  await ev.locator('input[type=number]').nth(1).fill('15'); // start: 30 → 15 (the customer's spec)
  const save8 = page.locator('.page-header').getByRole('button', { name: 'Save', exact: true });
  if (await save8.isVisible().catch(() => false)) {
    await save8.click();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible({ timeout: 20_000 });
    await repairShippedTasks(); // every tool save re-corrupts the shipped entries (P0)
  }
  expect(await fs.readFile(path.join(PROJECT, 'tasks.js'), 'utf8'))
    .toContain("{ id: 'referral_followup_30d', days: 30, start: 15, end: 15 }");

  // Redeploy settings via one-click.
  await page.locator('.nav-item', { hasText: 'Deploy' }).click();
  const target = page.locator('.deploy-target');
  await target.locator('input[name="target"]').nth(2).check();
  await target.locator('input[placeholder="https://your-instance.medicmobile.org"]').fill(INSTANCE);
  await target.locator('input[placeholder="medic"]').fill('medic');
  await target.locator('input[type="password"]').fill('password');
  await target.getByRole('button', { name: /Test connection/ }).click();
  await expect(target.locator('.deploy-test-result.ok')).toBeVisible({ timeout: 30_000 });
  const oneclick = page.locator('.deploy-oneclick');
  // Settings-only redeploy: uncheck the four form steps (faster, less flaky).
  for (const step of ['convert-app-forms', 'convert-contact-forms', 'upload-app-forms', 'upload-contact-forms']) {
    const cb = oneclick.getByRole('checkbox', { name: step });
    if (await cb.isChecked().catch(() => false)) await cb.uncheck();
  }
  const anyway = oneclick.getByRole('button', { name: 'Deploy anyway' });
  if (await anyway.isVisible().catch(() => false)) await anyway.click();
  await oneclick.getByRole('button', { name: 'Deploy', exact: true }).click();
  await expect(oneclick.locator('.deploy-oneclick-step.state-success')).toHaveCount(2, { timeout: 900_000 });

  // A fresh failing assessment now must NOT surface a task (visible day 15).
  const late = await seedElder('Ganga Maya', '1949-04-05');
  await loginChw(page);
  await fillAssessment(page, late, { continence: true });
  await page.goto(`${INSTANCE}/#/tasks`);
  await page.waitForTimeout(6000);
  await expect(page.getByRole('link', { name: /Ganga Maya/ })).toHaveCount(0);
  console.log('[wf] ✓ 15/30/15 semantics: task correctly hidden until day 15 (method: start=30 variant used for the lifecycle proof, then restored)');
});
