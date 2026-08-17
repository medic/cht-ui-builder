/**
 * GERIATRIC FULL-ARC DEMO (recording, not a CI test) — ONE continuous take of
 * the entire no-code workflow:
 *
 *   PART 1 — build in the tool: new project (CHT baseline) → the Integrated
 *   Health Assessment (60+ eligibility, English+Nepali, all 10 sections) →
 *   the 7 hidden refer_* flags (If-then calculates) → the Referral Follow-up
 *   form (flag-gated domain questions) → ONE task (OR'd condition, window,
 *   resolution, modifyContent mappings).
 *   PART 2 — one-click deploy from inside the tool (now incl. translations).
 *   PART 3 — live CHT: the CHW fills the assessment failing the cognitive
 *   screen → the task fires → tapping it opens the follow-up branched to just
 *   that domain → submit → the task resolves.
 *
 * Three OFF-CAMERA file fixups, each a documented P1 finding the tool can't
 * yet do (disclosed, same convention as API seeding in the ANC demos):
 *   1. `npm install moment` — CHT-baseline template ships no package.json.
 *   2. Relocate the follow-up's refer_* rows to be DIRECT children of the
 *      inputs group ("+ add inside" drops them into inputs/user, where task
 *      content can't bind).
 * (The third fixup this spec used to carry — repairing the tasks.js the save
 * corrupted — is GONE: b0278b3 fixed that P0, and the spec now ASSERTS the
 * shipped entries survive byte-identical instead.)
 * On camera, the modifyContent sources are corrected via the actions field's
 * Raw JS hatch — the only working path (picker emission is broken; P1).
 *
 * Demo choice: the task window is built as days 30 / start 30 (visible day 0)
 * so the lifecycle fits one take; the customer's spec value is start 15.
 * The task title is now BILINGUAL via item 8 (ff04e3e) — no literal, no
 * hand-typed translation key.
 *
 *   pnpm --filter @cht-ui/client exec playwright test geriatric-full-arc-demo.spec.ts   # fast
 *   $env:DEMO=1 ; ...same...                                                            # record
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  API, T, ihaSections, REFER_FLAGS,
  ensureFullMode, rowByName, saveForm,
  createAppForm, addSection, addRow, fillRuleList,
} from './helpers/geriatric.js';
import type { Row, Rel } from './helpers/geriatric.js';

const PARENT = 'W:\\medic\\ui-builder-projects';
const PROJECT = path.join(PARENT, 'geriatric-demo-arc');
const INSTANCE = 'https://127-0-0-1.local-ip.medicmobile.org:10445';
const CHW = { user: 'geri_chw', pass: 'ElderCare!2026z' };
const CLINIC_ID = 'cacc1138-db44-4ca8-88fb-803aee5edf77';
const IHA = 'integrated_health_assessment';
const FOLLOWUP = 'referral_follow_up';
const TASK_TITLE = 'Geriatric referral follow-up';
const ELDER = 'Devi Kumari Thapa';
const SLOW = process.env.DEMO ? Number(process.env.DEMO_MS ?? '500') : 0;

test.use({
  video: { mode: 'on', size: { width: 2560, height: 1440 } },
  viewport: { width: 2560, height: 1440 },
  ignoreHTTPSErrors: true,
  launchOptions: { slowMo: SLOW },
});

/* ─────────────────────────── CHT API helper ─────────────────────────── */
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
        catch { res({ status: x.statusCode ?? 0, json: { raw: s.slice(0, 300) } }); }
      }); },
    );
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

/* ───────────────────────── Enketo runtime helpers ───────────────────────── */
async function beat(page: Page, ms: number): Promise<void> {
  if (SLOW) await page.waitForTimeout(ms);
}
async function answer(page: Page, qSnippet: string, choiceEn: string, kind: 'radio' | 'checkbox' = 'radio') {
  const q = page.locator('.question', { hasText: qSnippet }).first();
  await expect(q, `question: ${qSnippet}`).toBeVisible({ timeout: 120_000 });
  await q.getByRole(kind, { name: choiceEn }).first().check();
}
async function nextPage(page: Page) {
  await page.getByRole('button', { name: 'Next >' }).click();
  await page.waitForTimeout(SLOW ? 500 : 150);
}

/**
 * The sandbox CHT degrades under machine memory pressure (CouchDB starts
 * 500-ing on /medic/). Restart the stack and wait for health — otherwise a
 * long run dies for reasons that have nothing to do with the tool.
 */
async function healInstance(): Promise<boolean> {
  const probe = async () => (await chtReq('GET', '/medic/').catch(() => ({ status: 0 }))).status;
  if ((await probe()) === 200) return true;
  console.log('[arc] instance unhealthy — restarting CHT stack');
  try {
    execSync('docker restart poc_demo_cht-couchdb-1 poc_demo_cht-haproxy-1 poc_demo_cht-api-1', { stdio: 'ignore' });
  } catch { /* keep waiting anyway */ }
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 10_000));
    if ((await probe()) === 200) { console.log(`[arc] instance healthy after ~${(i + 1) * 10}s`); return true; }
  }
  return false;
}

/* ── off-camera fixup 2: refer_* rows must be DIRECT children of inputs ── */
async function relocateInputRows(): Promise<void> {
  const m = await import('file:///W:/medic/ui-builder-for-cht/shared/dist/index.js' as string);
  const p = path.join(PROJECT, 'forms', 'app', `${FOLLOWUP}.xlsx`);
  const form = await m.parseXlsForm(await fs.readFile(p));
  const isRefer = (r: any) => /^refer_/.test(r.name) && r.type.trim() === 'hidden';
  const moved = form.survey.filter(isRefer);
  form.survey = form.survey.filter((r: any) => !isRefer(r));
  const iBegin = form.survey.findIndex((r: any) => r.name === 'inputs' && /^begin group/.test(r.type.trim()));
  let depth = 0, iClose = -1;
  for (let i = iBegin; i < form.survey.length; i += 1) {
    const t = form.survey[i].type.trim();
    if (/^begin[ _]group/.test(t)) depth += 1;
    else if (/^end[ _]group/.test(t)) { depth -= 1; if (depth === 0) { iClose = i; break; } }
  }
  form.survey.splice(iClose, 0, ...moved);
  await fs.writeFile(p, await m.serializeXlsForm(form));
}

test('geriatric full arc — no-code build → deploy → CHT task lifecycle', async ({ page }) => {
  test.setTimeout(5_400_000);
  await fs.rm(PROJECT, { recursive: true, force: true });
  await page.request.post(`${API}/api/project/close`).catch(() => {});

  /* ═══════════ PART 1a — new project from the CHT-baseline template ═══════════ */
  await page.goto('/');
  await page.getByRole('button', { name: /Create new project/ }).click();
  const wizard = page.locator('.modal-wide');
  await wizard.locator('.template-card')
    .filter({ has: page.getByRole('heading', { name: 'CHT baseline' }) }).click();
  await beat(page, 1500);
  await wizard.getByRole('button', { name: /Next/ }).click();
  await wizard.locator('.form-row', { hasText: 'Parent folder' }).locator('input').fill(PARENT);
  await wizard.locator('.form-row', { hasText: 'Project name' }).locator('input').fill('geriatric-demo-arc');
  await wizard.getByRole('button', { name: /Next/ }).click();
  await wizard.getByRole('button', { name: /Create project/ }).click();
  await expect(page.locator('.nav-item', { hasText: 'Forms' })).toBeVisible({ timeout: 60_000 });
  await beat(page, 2000);
  // Off-camera fixups: snapshot shipped tasks.js (P0 repair basis) + moment
  // dependency the template forgets (P1 finding).
  await fs.copyFile(path.join(PROJECT, 'tasks.js'), path.join(PROJECT, 'tasks.js.shipped'));
  execSync('npm init -y >nul 2>&1 & npm install moment@^2.29 --no-audit --no-fund >nul 2>&1', { cwd: PROJECT, shell: 'cmd.exe' });

  /* ═══════════ PART 1b — the Integrated Health Assessment ═══════════ */
  await createAppForm(page, 'Integrated Health Assessment', IHA);
  await page.getByRole('button', { name: 'Properties', exact: true }).click();
  await page.getByLabel('Available on people').check();
  const ctx = page.locator('.context-builder');
  await ctx.getByRole('button', { name: '+ age', exact: true }).click();
  const ageRow = ctx.locator('.rule-row').last();
  await ageRow.locator('select').first().selectOption('>=');
  await ageRow.locator('input[type="number"]').fill('60');
  await beat(page, 1500);
  await page.getByRole('button', { name: /^Survey/ }).first().click();
  const bar = page.locator('.language-chip-bar');
  await bar.getByRole('button', { name: '+ Add language' }).click();
  await page.locator('.language-chip-popover').locator('button', { hasText: 'नेपाली (Nepali)' }).click();
  await saveForm(page);

  for (const section of ihaSections(true)) {
    console.log(`[arc] section: ${section.en}`);
    const accordion = await addSection(page, section);
    for (const row of section.rows) await addRow(page, accordion, row);
    await saveForm(page);
  }

  // The 7 hidden referral flags (If-then table calculates).
  for (const flag of REFER_FLAGS) {
    console.log(`[arc] flag: ${flag.name}`);
    await ensureFullMode(page);
    await addRow(page, null, { name: flag.name, en: '', ne: '', tile: T.calc });
    const calcRow = rowByName(page, flag.name);
    const adv = calcRow.getByRole('button', { name: /show advanced/ });
    if (await adv.isVisible().catch(() => false)) await adv.click();
    await calcRow.locator('.expr-field')
      .filter({ has: page.locator('code.raw-col-tag', { hasText: 'calculation' }) })
      .locator('button', { hasText: 'build' }).click();
    const calc = page.locator('.rule-builder-modal[aria-label="Calculation builder"]');
    await calc.getByRole('tab', { name: 'If-then table' }).click();
    await calc.getByRole('button', { name: '+ Rule' }).click();
    await calc.getByRole('button', { name: /edit condition for rule 1/ }).click();
    const rb = page.locator('.rule-builder-card').last();
    await fillRuleList(page, rb, flag.rel);
    await rb.getByRole('button', { name: 'Save', exact: true }).click();
    const table = calc.locator('table.decision-table');
    await table.locator('tbody tr').first().locator('input[aria-label="Literal text"]').fill('true');
    const otherwise = calc.locator('.otherwise-row').locator('input[aria-label="Literal text"]');
    await otherwise.fill('x');
    await otherwise.fill('');
    await calc.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(calc).toBeHidden();
  }
  await saveForm(page);

  /* ═══════════ PART 1c — the Referral Follow-up form ═══════════ */
  await createAppForm(page, 'Referral follow up', FOLLOWUP);
  const bar2 = page.locator('.language-chip-bar');
  await bar2.getByRole('button', { name: '+ Add language' }).click();
  await page.locator('.language-chip-popover').locator('button', { hasText: 'नेपाली (Nepali)' }).click();
  await ensureFullMode(page);
  const inputsAccordion = page.locator('.survey-group-accordion')
    .filter({ has: page.locator('code', { hasText: /^inputs$/ }) }).first();
  if (!(await inputsAccordion.getByRole('button', { name: /\+ add inside|\+ Add question/ }).first().isVisible().catch(() => false))) {
    await inputsAccordion.locator('.survey-group-header').first().click();
  }
  for (const flag of REFER_FLAGS) {
    await inputsAccordion.getByRole('button', { name: /\+ add inside|\+ Add question/ }).first().click();
    const picker = page.locator('.qtype-modal');
    await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill(flag.name);
    await picker.locator('.qtype-tile')
      .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Hidden$/ }) }).click();
    await expect(picker).not.toBeVisible();
  }
  await saveForm(page);

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
      ne: 'के प्रेषण संस्थामा औपचारिक परीक्षण भएको छ ?', rel: { rules: [visitedYes] } },
    { name: 'diagnosis_result', tile: T.text,
      en: 'Diagnosis / Result', ne: 'निदान / परिणाम', rel: { rules: [visitedYes] } },
    { name: 'meds_started', tile: T.s1, required: true, reuse: 'yes_no',
      en: 'Was medication or therapy started?', ne: 'औषधि वा थेरापी सुरु भयो ?', rel: { rules: [visitedYes] } },
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
    console.log(`[arc] follow-up row: ${row.name}`);
    await ensureFullMode(page);
    await addRow(page, null, row);
  }
  await saveForm(page);
  await relocateInputRows(); // off-camera fixup 2 (P1: no direct-inputs affordance)

  /* ═══════════ PART 1d — the ONE task ═══════════ */
  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  await page.getByRole('button', { name: '+ Add task' }).click();
  const card = page.locator('.task-card').last();
  const nameField = card.locator('.expr-field', { hasText: 'name' }).first();
  await nameField.locator('input').first().fill(TASK_TITLE);
  await nameField.getByRole('button', { name: 'use this' }).click();
  // Title — item 8 (ff04e3e): type the literal, then "Make it translatable"
  // turns it into ONE INPUT PER LOCALE and derives task.<name>.title behind
  // the scenes. A bilingual task title with NO hand-typed translation key —
  // the blocker that forced a literal title in the earlier demo is gone.
  const titleField = card.locator('.expr-field', { hasText: 'title' }).first();
  const enTitle = titleField.getByRole('textbox', { name: 'Task title in en' });
  if (!(await enTitle.isVisible().catch(() => false))) {
    // Literal-title shape: type it, then promote (carries the literal across).
    await titleField.locator('input').first().fill(TASK_TITLE);
    await beat(page, 1200);
    await titleField.getByRole('button', { name: 'Make it translatable' }).click();
  }
  // Translated shape (the "+ Add task" seed already holds a key): one input
  // per project locale — type the strings, the tool owns the key.
  await enTitle.fill(TASK_TITLE);
  await beat(page, 1200);
  await titleField.getByRole('textbox', { name: 'Task title in ne' })
    .fill('ज्येष्ठ नागरिक प्रेषण फलोअप');
  await beat(page, 1500);
  await card.locator('.expr-field', { hasText: 'appliesToType' })
    .getByRole('checkbox', { name: IHA, exact: true }).check();
  await card.locator('.expr-field', { hasText: 'appliesIf' })
    .locator('button', { hasText: '✎ build' }).click();
  const aif = page.locator('.rule-builder-modal');
  for (const flag of REFER_FLAGS) {
    await aif.getByRole('button', { name: '+ report field', exact: true }).click();
    const row = aif.locator('.rule-row').last();
    await row.locator('select.field-picker').selectOption(flag.name);
    const valueSelect = row.locator('select.choice-value-select');
    if (await valueSelect.isVisible().catch(() => false)) await valueSelect.selectOption('true');
    else await row.getByPlaceholder('value', { exact: true }).fill('true');
  }
  const pills = aif.locator('select.connector-pill');
  for (let i = 0; i < (await pills.count()); i += 1) {
    const pill = pills.nth(i);
    if (await pill.isEnabled().catch(() => false)) await pill.selectOption('or');
  }
  await aif.getByRole('button', { name: 'Save' }).click();
  await expect(aif).toBeHidden();
  // Window: day-0 demo variant (customer spec is start 15).
  const events = card.locator('.events-editor');
  const ev = events.locator('.event-card').first();
  await ev.locator('.name-input').fill('referral_followup_30d');
  await ev.locator('input[type=number]').nth(0).fill('30');
  await ev.locator('input[type=number]').nth(1).fill('30');
  await ev.locator('input[type=number]').nth(2).fill('15');
  // Resolution.
  const resolved = card.locator('.expr-field', { hasText: 'resolvedIf' });
  await resolved.locator('button', { hasText: /^Visual$/ }).click();
  await resolved.locator('button', { hasText: 'use "form submitted in window"' }).click();
  await resolved.locator('button', { hasText: /^pick$/ }).click();
  await resolved.locator('select[title="App form whose submission resolves the task"]').selectOption(FOLLOWUP);
  // Action + mappings (picker targets; sources corrected via Raw JS — the
  // only WORKING path today, P1).
  const actionsField = card.locator('.expr-field', { hasText: 'actions' }).first();
  const action = actionsField.locator('.actions-list .event-card').first();
  await action.locator('.expr-field', { hasText: 'form' }).locator('select').selectOption(FOLLOWUP);
  for (let i = 0; i < REFER_FLAGS.length; i += 1) {
    const flag = REFER_FLAGS[i]!;
    if (i === 0) await action.locator('button', { hasText: '+ Add field mapping' }).click();
    else await action.locator('.modify-content-editor').locator('..').locator('button', { hasText: '+ Add mapping' }).click();
    const mrow = action.locator('.modify-content-table tbody tr').nth(i);
    await mrow.locator('button', { hasText: 'custom' }).first().click();
    await mrow.locator('input[placeholder="e.g. patient_id"]').fill(flag.name);
    await mrow.locator('select.mapping-source-mode').selectOption('report');
    await mrow.locator('select').last().selectOption(flag.name);
  }
  await beat(page, 1500);
  // Correct the sources on camera via the Raw JS hatch.
  await actionsField.locator('button', { hasText: /^Raw JS$/ }).first().click();
  const ta = actionsField.locator('textarea').first();
  const cur = await ta.inputValue();
  await ta.fill(cur.replaceAll('= report.refer_', '= report.fields.refer_'));
  await beat(page, 1500);
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible({ timeout: 30_000 });

  // VERIFY the P0 fix (b0278b3) instead of repairing around it: every line of
  // the template's hand-written tasks.js must survive our save byte-for-byte.
  // (This is why the off-camera "repair" fixup is gone from this spec.)
  {
    const saved = await fs.readFile(path.join(PROJECT, 'tasks.js'), 'utf8');
    const shipped = await fs.readFile(path.join(PROJECT, 'tasks.js.shipped'), 'utf8');
    const body = shipped.slice(shipped.indexOf('module.exports'));
    const lost = body.split('\n').filter((l) => l.trim().length > 2 && !saved.includes(l));
    expect(lost, `shipped tasks.js lines lost on save:\n${lost.slice(0, 6).join('\n')}`).toEqual([]);
    // Item 8: the title is a DERIVED translation key now, not the literal.
    // (Separator is project-derived per dd66cef, so match the shape.)
    expect(saved).toMatch(/title: 'task\.[\w.\-]+\.title'/);
    console.log('[arc] ✓ P0 fixed: cht-default tasks survive byte-identical; title is a derived key');
  }

  /* ═══════════ PART 2 — one-click deploy ═══════════ */
  await healInstance();
  await page.locator('.nav-item', { hasText: 'Deploy' }).click();
  const target = page.locator('.deploy-target');
  await target.locator('input[name="target"]').nth(2).check();
  await target.locator('input[placeholder="https://your-instance.medicmobile.org"]').fill(INSTANCE);
  await target.locator('input[placeholder="medic"]').fill('medic');
  await target.locator('input[type="password"]').fill('password');
  const oneclick = page.locator('.deploy-oneclick');
  // 7 steps since the dev's W2 change (translations now included). Retry the
  // whole gesture if the sandbox instance falls over mid-pipeline.
  let deployed = false;
  for (let attempt = 1; attempt <= 3 && !deployed; attempt += 1) {
    if (attempt > 1) {
      console.log(`[arc] deploy attempt ${attempt} — healing first`);
      await healInstance();
    }
    await target.getByRole('button', { name: /Test connection/ }).click();
    await expect(target.locator('.deploy-test-result.ok')).toBeVisible({ timeout: 120_000 });
    const anyway = oneclick.getByRole('button', { name: 'Deploy anyway' });
    if (await anyway.isVisible().catch(() => false)) await anyway.click();
    await oneclick.getByRole('button', { name: 'Deploy', exact: true }).click();
    try {
      await expect(oneclick.locator('.deploy-oneclick-step.state-success')).toHaveCount(7, { timeout: 1_800_000 });
      deployed = true;
    } catch {
      const failed = await oneclick.locator('.deploy-oneclick-step.state-fail code').allTextContents();
      console.log(`[arc] deploy attempt ${attempt} failed at: ${failed.join(', ') || '(unknown)'}`);
    }
  }
  expect(deployed, 'one-click deploy reached 7/7').toBe(true);
  console.log('[arc] one-click deploy: 7/7 green (incl. custom translations)');
  await beat(page, 2500);

  /* ═══════════ PART 3 — the CHT task lifecycle ═══════════ */
  const elderId = randomUUID();
  const seed = await chtReq('POST', '/medic', {
    _id: elderId, type: 'person', name: ELDER, sex: 'female',
    date_of_birth: '1959-04-02', parent: { _id: CLINIC_ID }, reported_date: Date.now(),
  });
  expect(seed.json.ok, 'seed elder').toBeTruthy();

  await page.goto(`${INSTANCE}/medic/login?redirect=%2F`);
  const user = page.locator('#user');
  if (await user.isVisible().catch(() => false)) {
    await user.fill(CHW.user);
    await page.locator('#password').fill(CHW.pass);
    await page.locator('#login').click();
  }
  await expect(page.getByRole('link', { name: /Tasks/ })).toBeVisible({ timeout: 300_000 });
  await page.waitForTimeout(15_000); // initial replication
  await beat(page, 2000);

  await page.goto(`${INSTANCE}/#/contacts/${elderId}`);
  await expect(page.locator('.content-pane').getByRole('heading', { name: ELDER })).toBeVisible({ timeout: 300_000 });
  await beat(page, 2000);
  await page.locator('.content-pane mm-fast-action-button button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Integrated Health Assessment')).toBeVisible({ timeout: 120_000 });
  await beat(page, 1500);
  await dialog.getByText('Integrated Health Assessment').click();
  await expect(page.locator('.question:visible').first()).toBeVisible({ timeout: 900_000 });
  await beat(page, 2000);

  // Fill: FAIL cognitive, pass everything else.
  await answer(page, 'Do you have trouble remembering', 'Yes (Fail)');
  await answer(page, 'repeat these 3 words', 'Unable to repeat all three words (Fail)');
  await answer(page, "today's full date", 'Both correct (Pass)');
  await nextPage(page);
  await answer(page, 'do you feel safe standing up', 'No (Do not test)');
  await nextPage(page);
  await answer(page, 'has your weight decreased', 'No (Pass)');
  await answer(page, 'belt become loose', 'No (Pass)');
  {
    const w = page.locator('.question', { hasText: 'Measure their weight' }).locator('input[type="number"]');
    if (await w.isVisible().catch(() => false)) await w.fill('58');
  }
  await nextPage(page);
  await answer(page, 'eye-related problems', 'No (Pass)');
  await answer(page, 'diabetes or high blood pressure', 'No (Pass)');
  await answer(page, 'Examine the external eye', 'None of the above', 'checkbox');
  await nextPage(page);
  await answer(page, 'Do you have trouble hearing', 'No (Pass)');
  await answer(page, 'Right ear result', 'Successfully repeated all four words (Pass)');
  await answer(page, 'Left ear result', 'Successfully repeated all four words (Pass)');
  await nextPage(page);
  await answer(page, 'persistently sad', 'No (Pass)');
  await answer(page, 'little interest or pleasure', 'No (Pass)');
  await answer(page, 'thoughts of harming yourself', 'No (Pass)');
  await nextPage(page);
  await answer(page, 'satisfied with the care', 'No (Pass)');
  await answer(page, 'not having enough money', 'No (Pass)');
  await answer(page, 'feel lonely', 'No (Pass)');
  await answer(page, 'activities you enjoy', 'No (Pass)');
  await nextPage(page);
  await answer(page, 'adequate support from your family', 'Yes, I receive sufficient support');
  await answer(page, 'feel confident that you can take good care', 'Yes, I know what to do');
  await answer(page, 'caregiving affected your own health', 'No');
  await answer(page, 'affected your own work or income', 'No difficulty');
  await nextPage(page);
  await answer(page, 'trouble holding your urine', 'No (Pass)');
  await nextPage(page);
  await beat(page, 2000);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('.content-pane').getByRole('heading', { name: ELDER })).toBeVisible({ timeout: 300_000 });
  await beat(page, 2500);

  // The task fires.
  await page.goto(`${INSTANCE}/#/tasks`);
  let task = page.getByRole('link', { name: new RegExp(ELDER) }).first();
  for (let i = 0; i < 60; i += 1) {
    if (await task.isVisible().catch(() => false)) break;
    await page.waitForTimeout(20_000);
    if (i % 6 === 5) { await page.reload(); await page.waitForTimeout(8000); await page.goto(`${INSTANCE}/#/tasks`); }
    task = page.getByRole('link', { name: new RegExp(ELDER) }).first();
  }
  await expect(task).toBeVisible({ timeout: 60_000 });
  await expect(task).toContainText(TASK_TITLE);
  await beat(page, 3000);

  // Tap → branched follow-up → fill → submit.
  await task.click();
  await expect(page.locator('.question:visible').first()).toBeVisible({ timeout: 900_000 });
  await beat(page, 2000);
  await answer(page, 'visit a relevant health facility', 'Yes');
  await nextPage(page);
  await answer(page, 'formal examination', 'Yes');
  await nextPage(page);
  {
    const diag = page.locator('.question:visible input[type="text"], .question:visible textarea').first();
    if (await diag.isVisible().catch(() => false)) {
      await diag.fill('Mild cognitive impairment — reviewed at facility');
      await nextPage(page);
    }
  }
  await answer(page, 'medication or therapy started', 'Yes');
  await nextPage(page);
  await answer(page, 'Improvement in memory', 'Improving'); // THE BRANCH
  await beat(page, 2500);
  await nextPage(page).catch(() => {});
  const submit = page.getByRole('button', { name: 'Submit', exact: true });
  await expect(submit).toBeVisible({ timeout: 120_000 });
  await submit.click();
  await beat(page, 2500);

  // Resolved.
  await page.goto(`${INSTANCE}/#/tasks`);
  await page.waitForTimeout(SLOW ? 6000 : 4000);
  await expect(page.getByRole('link', { name: new RegExp(ELDER) })).toHaveCount(0, { timeout: 120_000 });
  await beat(page, 2500);
  console.log('[arc] FULL ARC COMPLETE: no-code build → deploy → assessment → task → branched follow-up → resolved');
});
