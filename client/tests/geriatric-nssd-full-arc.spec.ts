/**
 * NSSD GERIATRIC — THE FULL ARC, one continuous take for the demo video.
 *
 *   PART 1  build in the no-code tool, INTO THE REAL NATIONAL CONFIG
 *           (W:\medic\config-nssd\chis): the Integrated Health Assessment
 *           form for elder population (60+ gate, EN+NE, 10 sections, BMI/BP/
 *           sugar pulled from the config's existing NCD screening context,
 *           7 referral flags) → the Geriatric care follow up form → the task.
 *   PART 2  deploy with the project's documented cht-conf command.
 *   PART 3  live CHT: CHW → assessment → task → branched follow-up → resolved.
 *
 * HAND-EDITS the tool cannot do (each a filed finding; applied off-camera and
 * logged on screen):
 *   1. reformat the emitted task entry to the config's ESLint style — without
 *      it `compile-app-settings` fails and NOTHING deploys;
 *   2. relocate the follow-up's refer_* rows to be DIRECT children of inputs;
 *   3. (on camera) rewrite modifyContent sources via the Raw JS hatch.
 * The 15/30/15 window is the customer's real spec, so the runtime leg
 * simulates time by backdating the submitted report rather than weakening it.
 *
 *   $env:DEMO=1 ; pnpm --filter @cht-ui/client exec playwright test geriatric-nssd-full-arc.spec.ts
 */
import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import {
  API, T, ihaSections, REFER_FLAGS,
  ensureFullMode, rowByName, saveForm,
  addSection, addRow, fillRuleList,
} from './helpers/geriatric.js';
import type { Row, Rel } from './helpers/geriatric.js';

const PROJECT = 'W:\\medic\\config-nssd\\chis';
const CHT_BIN = 'W:\\medic\\ui-builder-for-cht\\server\\node_modules\\.bin\\cht.cmd';
const INSTANCE = 'https://127-0-0-1.local-ip.medicmobile.org:10445';
const CHW = { user: 'nssd_chw', pass: 'NssdCare!2026x' };
const ELDER_ID = '8ad27ba1-3568-447d-88d1-be4b77d422ec';
const ELDER = 'Devi Kumari Thapa';
const IHA_TITLE = 'Integrated Health Assessment form for elder population';
const IHA = 'integrated_health_assessment_form_for_elder_population';
const FU_TITLE = 'Geriatric care follow up form';
const FOLLOWUP = 'geriatric_care_follow_up_form';
const TASK_NAME = 'Geriatric referral follow up';
const CS_KEYS = { bmi: 'previous_bmi_ctx', sys: 'sys_ctx', sugar: 'glucometer_ctx' } as const;
const SLOW = process.env.DEMO ? Number(process.env.DEMO_MS ?? '450') : 0;

test.use({
  video: { mode: 'on', size: { width: 2560, height: 1440 } },
  viewport: { width: 2560, height: 1440 },
  ignoreHTTPSErrors: true,
  launchOptions: { slowMo: SLOW },
});

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
        catch { res({ status: x.statusCode ?? 0, json: { raw: s.slice(0, 200) } }); }
      }); },
    );
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}
async function beat(page: Page, ms: number) { if (SLOW) await page.waitForTimeout(ms); }
async function answer(page: Page, q: string, choice: string, kind: 'radio' | 'checkbox' = 'radio') {
  const el = page.locator('.question', { hasText: q }).first();
  await expect(el, `question: ${q}`).toBeVisible({ timeout: 120_000 });
  await el.getByRole(kind, { name: choice }).first().check();
}
async function nextPage(page: Page) {
  await page.getByRole('button', { name: 'Next >' }).click();
  await page.waitForTimeout(SLOW ? 450 : 150);
}

async function createForm(page: Page, title: string, basename: string): Promise<void> {
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: '+ App form' }).click();
  const card = page.locator('.create-form');
  await card.locator('#new-form-title').fill(title);
  await expect(card.locator('code', { hasText: new RegExp(`^${basename}$`) })).toBeVisible();
  await card.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(card).toBeHidden();
  await expect(page.getByRole('button', { name: /^Survey/ }).first()).toBeVisible({ timeout: 60_000 });
  await ensureFullMode(page);
}

async function addContextCalc(page: Page, accordion: Locator, name: string, key: string): Promise<void> {
  await addRow(page, accordion, { name, en: '', ne: '', tile: T.calc });
  const row = rowByName(page, name);
  const adv = row.getByRole('button', { name: /show advanced/ });
  if (await adv.isVisible().catch(() => false)) await adv.click();
  await row.locator('.expr-field')
    .filter({ has: page.locator('code.raw-col-tag', { hasText: 'calculation' }) })
    .locator('button', { hasText: 'build' }).click();
  const calc = page.locator('.rule-builder-modal[aria-label="Calculation builder"]');
  await calc.getByRole('tab', { name: 'Raw' }).click();
  // FINDING: the context-key picker only lists structured `context: {…}`
  // literals; this config assembles context imperatively, so the key is typed.
  await calc.locator('textarea').first().fill(`once(instance('contact-summary')/context/${key})`);
  await calc.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(calc).toBeHidden();
}

async function insertRef(page: Page, noteName: string, ref: string): Promise<void> {
  const noteRow = rowByName(page, noteName);
  const enLabel = noteRow.locator('.label-row').filter({ has: page.getByText('label::en', { exact: true }) });
  await enLabel.locator('input').click();
  await enLabel.getByRole('button', { name: '+ insert' }).click();
  const menu = page.locator('.label-insert-ref-menu');
  if (!(await menu.getByRole('menuitem', { name: `\${${ref}}` }).isVisible().catch(() => false))) {
    await page.keyboard.press('Escape');
    await rowByName(page, ref).getByRole('button', { name: 'move up' }).click();
    await enLabel.locator('input').click();
    await enLabel.getByRole('button', { name: '+ insert' }).click();
  }
  await menu.getByRole('menuitem', { name: `\${${ref}}` }).click();
}

/** Hand-edit 2 — refer_* rows must be DIRECT children of `inputs`. */
async function relocateInputRows(): Promise<void> {
  const m = await import('file:///W:/medic/ui-builder-for-cht/shared/dist/index.js' as string);
  const p = path.join(PROJECT, 'forms', 'app', `${FOLLOWUP}.xlsx`);
  const form = await m.parseXlsForm(await fs.readFile(p));
  const isRefer = (r: any) => /^refer_/.test(r.name) && r.type.trim() === 'hidden';
  const moved = form.survey.filter(isRefer);
  if (!moved.length) return;
  form.survey = form.survey.filter((r: any) => !isRefer(r));
  const iBegin = form.survey.findIndex((r: any) => r.name === 'inputs' && /^begin[ _]group/.test(r.type.trim()));
  let depth = 0, iClose = -1;
  for (let i = iBegin; i < form.survey.length; i += 1) {
    const t = form.survey[i].type.trim();
    if (/^begin[ _]group/.test(t)) depth += 1;
    else if (/^end[ _]group/.test(t)) { depth -= 1; if (depth === 0) { iClose = i; break; } }
  }
  form.survey.splice(iClose, 0, ...moved);
  await fs.writeFile(p, await m.serializeXlsForm(form));
  console.log(`[arc] hand-edit 2 — relocated ${moved.length} refer_* rows to direct inputs children`);
}

/** Hand-edit 1 — the emitted entry must satisfy the config's ESLint. */
async function reformatEmittedTask(): Promise<void> {
  const p = path.join(PROJECT, 'tasks.js');
  const s = await fs.readFile(p, 'utf8');
  const marker = `  {\n    name: 'geriatric_referral_follow_up',`;
  const start = s.indexOf(marker);
  if (start < 0) throw new Error('emitted task entry not found');
  const end = s.lastIndexOf('];');
  const entry = `  {
    name: 'geriatric_referral_follow_up',
    title: 'task.geriatric_referral_follow_up.title',
    icon: 'icon-task',
    appliesTo: 'reports',
    appliesToType: [ '${IHA}' ],
    appliesIf: function (contact, report) {
      if (Utils.getField(report, 'refer_cognitive') !== 'true' &&
        Utils.getField(report, 'refer_mobility') !== 'true' &&
        Utils.getField(report, 'refer_nutrition') !== 'true' &&
        Utils.getField(report, 'refer_vision') !== 'true' &&
        Utils.getField(report, 'refer_hearing') !== 'true' &&
        Utils.getField(report, 'refer_psych') !== 'true' &&
        Utils.getField(report, 'refer_continence') !== 'true') {
        return false;
      }
      return true;
    },
    events: [
      {
        id: 'geriatric_referral_followup_visit',
        days: 30,
        start: 15,
        end: 15
      }
    ],
    actions: [
      {
        form: '${FOLLOWUP}',
        modifyContent: function (content, contact, report) {
${REFER_FLAGS.map((f) => `          content.${f.name} = Utils.getField(report, '${f.name}');`).join('\n')}
        }
      }
    ],
    resolvedIf: function (contact, report, event, dueDate) {
      return isFormArraySubmittedInWindow(
        contact.reports,
        '${FOLLOWUP}',
        Utils.addDate(dueDate, -event.start).getTime(),
        Utils.addDate(dueDate, event.end + 1).getTime()
      );
    }
  },
`;
  await fs.writeFile(p, s.slice(0, start) + entry + s.slice(end));
  console.log('[arc] hand-edit 1 — reformatted the emitted task to the config ESLint style');
}

test('NSSD geriatric FULL ARC — build in the tool → deploy → live task lifecycle', async ({ page }) => {
  test.setTimeout(7_200_000);

  /* Reset to the pre-build baseline so the recording builds from scratch. */
  for (const [snap, target] of [
    ['tasks.js.before', 'tasks.js'],
    ['messages-en.properties.before', 'translations/messages-en.properties'],
    ['messages-ne.properties.before', 'translations/messages-ne.properties'],
  ] as const) {
    await fs.copyFile(path.join(PROJECT, snap), path.join(PROJECT, target)).catch(() => {});
  }
  for (const f of [
    `forms/app/${IHA}.xlsx`, `forms/app/${IHA}.xml`, `forms/app/${IHA}.properties.json`,
    `forms/app/${FOLLOWUP}.xlsx`, `forms/app/${FOLLOWUP}.xml`, `forms/app/${FOLLOWUP}.properties.json`,
  ]) await fs.rm(path.join(PROJECT, f), { force: true });
  for (const form of [IHA, FOLLOWUP, 'geriatric_care_follow_up_form']) {
    const r = await chtReq('POST', '/medic/_find', { selector: { type: 'data_record', form }, limit: 100 });
    const docs = r.json.docs ?? [];
    if (docs.length) await chtReq('POST', '/medic/_bulk_docs', { docs: docs.map((d: any) => ({ _id: d._id, _rev: d._rev, _deleted: true })) });
  }

  await page.request.post(`${API}/api/project/close`).catch(() => {});
  expect((await page.request.post(`${API}/api/project/open`, { data: { path: PROJECT } })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.locator('.nav-item', { hasText: 'Forms' })).toBeVisible({ timeout: 120_000 });
  await beat(page, 2500);

  /* ══════════════ PART 1 — build ══════════════ */
  console.log('[arc] PART 1 — building the assessment in the national config');
  await createForm(page, IHA_TITLE, IHA);
  await page.getByRole('button', { name: 'Properties', exact: true }).click();
  await page.getByLabel('Available on people').check();
  const ctx = page.locator('.context-builder');
  await ctx.getByRole('button', { name: '+ contact type', exact: true }).click();
  await ctx.locator('.rule-row').last().locator('select').selectOption('c82_person');
  await ctx.getByRole('button', { name: '+ age', exact: true }).click();
  const ageRow = ctx.locator('.rule-row').last();
  await ageRow.locator('select').first().selectOption('>=');
  await ageRow.locator('input[type="number"]').fill('60');
  await expect(ctx.locator('.preview code')).toContainText('ageInYears(contact) >= 60');
  await beat(page, 2000);
  await page.getByRole('button', { name: /^Survey/ }).first().click();
  const bar = page.locator('.language-chip-bar');
  if (!(await bar.locator('.language-chip', { hasText: 'नेपाली' }).isVisible().catch(() => false))) {
    await bar.getByRole('button', { name: '+ Add language' }).click();
    await page.locator('.language-chip-popover').locator('button', { hasText: 'नेपाली (Nepali)' }).click();
  }
  await saveForm(page);

  const intro = await addSection(page, {
    en: 'Elderly integrated care', ne: 'वृद्ध व्यक्तिको एकीकृत हेरचाह फारम',
    slug: 'elderly_integrated_care', oneScreen: true, rows: [],
  });
  await addRow(page, intro, {
    name: 'consent', tile: T.s1, required: true,
    en: "I'll do a general check-in on your health. It takes about 8 to 12 minutes. What you share stays confidential and is only used to support you. You can stop whenever you'd like.",
    ne: 'म तपाईंको स्वास्थ्यको सामान्य जाँच गर्नेछु। यसमा करिब ८ देखि १२ मिनेट लाग्छ। तपाईंले भन्नुभएका कुरा गोप्य रहन्छन्। मन नलागे जहिले पनि रोक्न सक्नुहुन्छ।',
    list: { list: 'geri_consent', choices: [
      { name: 'agree', en: 'Agree', ne: 'सहमत छु' },
      { name: 'disagree', en: 'Disagree', ne: 'सहमत छैन' },
    ] },
  });
  console.log('[arc] pulling BMI / BP / blood sugar from the config’s NCD screening context');
  for (const [calcName, key, noteName, noteEn, noteNe] of [
    ['geri_bmi', CS_KEYS.bmi, 'geri_bmi_note', 'Body Mass Index (BMI): ', 'बडी मास इन्डेक्स (BMI): '],
    ['geri_sys', CS_KEYS.sys, 'geri_bp_note', 'Your blood pressure (systolic) is: ', 'तपाईंको रक्तचाप (सिस्टोलिक): '],
    ['geri_sugar', CS_KEYS.sugar, 'geri_sugar_note', 'The amount of sugar in your blood is: ', 'तपाईंको रगतमा चिनीको मात्रा: '],
  ] as const) {
    await addContextCalc(page, intro, calcName, key);
    await addRow(page, intro, { name: noteName, tile: T.note, en: noteEn, ne: noteNe });
    await insertRef(page, noteName, calcName);
  }
  await saveForm(page);

  for (const section of ihaSections(true)) {
    console.log(`[arc] section: ${section.en}`);
    const accordion = await addSection(page, section);
    for (const row of section.rows) await addRow(page, accordion, row);
    await saveForm(page);
  }

  console.log('[arc] the seven referral flags');
  for (const flag of REFER_FLAGS) {
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
    await otherwise.fill('x'); await otherwise.fill('');
    await calc.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(calc).toBeHidden();
  }
  await saveForm(page);

  console.log('[arc] building the follow-up form');
  await createForm(page, FU_TITLE, FOLLOWUP);
  const bar2 = page.locator('.language-chip-bar');
  if (!(await bar2.locator('.language-chip', { hasText: 'नेपाली' }).isVisible().catch(() => false))) {
    await bar2.getByRole('button', { name: '+ Add language' }).click();
    await page.locator('.language-chip-popover').locator('button', { hasText: 'नेपाली (Nepali)' }).click();
  }
  await ensureFullMode(page);
  const inputsAcc = page.locator('.survey-group-accordion')
    .filter({ has: page.locator('code', { hasText: /^inputs$/ }) }).first();
  if (!(await inputsAcc.getByRole('button', { name: /\+ add inside|\+ Add question/ }).first().isVisible().catch(() => false))) {
    await inputsAcc.locator('.survey-group-header').first().click();
  }
  for (const flag of REFER_FLAGS) {
    await inputsAcc.getByRole('button', { name: /\+ add inside|\+ Add question/ }).first().click();
    const picker = page.locator('.qtype-modal');
    await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill(flag.name);
    await picker.locator('.qtype-tile')
      .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Hidden$/ }) }).click();
    await expect(picker).not.toBeVisible();
  }
  await saveForm(page);

  const YES_NO: Row['list'] = { list: 'geri_fu_yes_no', choices: [
    { name: 'yes', en: 'Yes', ne: 'छ' }, { name: 'no', en: 'No', ne: 'छैन' },
  ] };
  const STATUS = (l: string): Row['list'] => ({ list: l, choices: [
    { name: `${l}_improving`, en: 'Improving', ne: 'सुधारोन्मुख' },
    { name: `${l}_same`, en: 'No change', ne: 'उस्तै छ' },
    { name: `${l}_worse`, en: 'Getting worse', ne: 'झन् खराब' },
  ] });
  const visited: Rel = { kind: 'cmp', field: 'visited_facility', choice: 'yes' };
  const flagTrue = (f: string): Rel => ({ kind: 'cmp', field: f, choice: 'true' });
  const FU_ROWS: Row[] = [
    { name: 'visited_facility', tile: T.s1, required: true, list: YES_NO,
      en: 'Did they visit a relevant health facility or doctor for further evaluation?',
      ne: 'के उहाँ सम्बन्धित स्वास्थ्य संस्था वा डाक्टरकहाँ थप जाँचका लागि जानुभएको थियो?' },
    { name: 'formal_exam', tile: T.s1, required: true, reuse: 'geri_fu_yes_no',
      en: 'Was a formal examination conducted at the referred health facility?',
      ne: 'के प्रेषण संस्थामा औपचारिक परीक्षण भएको छ ?', rel: { rules: [visited] } },
    { name: 'diagnosis_result', tile: T.text, en: 'Diagnosis / Result', ne: 'निदान / परिणाम', rel: { rules: [visited] } },
    { name: 'meds_started', tile: T.s1, required: true, reuse: 'geri_fu_yes_no',
      en: 'Was medication or therapy started?', ne: 'औषधि वा थेरापी सुरु भयो ?', rel: { rules: [visited] } },
    { name: 'memory_improvement', tile: T.s1, required: true, list: STATUS('geri_mem'),
      en: 'Improvement in memory', ne: 'सम्झने क्षमतामा सुधार', rel: { rules: [visited, flagTrue('refer_cognitive')] } },
    { name: 'sit_stand_followup', tile: T.s1, required: true, list: STATUS('geri_mob'),
      en: 'Time taken to complete five sit-to-stand repetitions', ne: '५ पटक उठन-बस्न लागेको समय', rel: { rules: [visited, flagTrue('refer_mobility')] } },
    { name: 'weight_increased', tile: T.s1, required: true, list: STATUS('geri_nut'),
      en: 'Has the weight increased?', ne: 'तौल बढेको छ ?', rel: { rules: [visited, flagTrue('refer_nutrition')] } },
    { name: 'external_eye_now', tile: T.s1, required: true, list: STATUS('geri_eye'),
      en: 'What is the current external condition of the eye?', ne: 'हाल बाह्य आँखाको अवस्था कस्तो छ ?', rel: { rules: [visited, flagTrue('refer_vision')] } },
    { name: 'hearing_status', tile: T.s1, required: true, list: STATUS('geri_ear'),
      en: 'What is the current status of hearing ability?', ne: 'श्रवण क्षमताको अवस्था कस्तो छ ?', rel: { rules: [visited, flagTrue('refer_hearing')] } },
    { name: 'psych_status', tile: T.s1, required: true, list: STATUS('geri_psy'),
      en: 'Psychological status', ne: 'मनोवैज्ञानिक अवस्था', rel: { rules: [visited, flagTrue('refer_psych')] } },
    { name: 'continence_status', tile: T.s1, required: true, list: STATUS('geri_con'),
      en: 'Urinary continence', ne: 'पिसाब नियन्त्रण', rel: { rules: [visited, flagTrue('refer_continence')] } },
    { name: 'not_visited_note', tile: T.note,
      en: 'Advise the family that further treatment is required and refer them immediately to an appropriate health facility.',
      ne: 'उहाँलाई थप उपचारको आवश्यकता भएको भनि घर परिवारलाई सल्लाह दिनुहोस् र उपचार हुने स्वास्थ्य संस्थामा तुरुन्तै प्रेषण गर्नुहोस् ।',
      rel: { rules: [{ kind: 'cmp', field: 'visited_facility', choice: 'no' }] } },
  ];
  for (const row of FU_ROWS) { await ensureFullMode(page); await addRow(page, null, row); }
  await saveForm(page);

  console.log('[arc] building the task');
  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  await page.getByRole('button', { name: '+ Add task' }).click();
  const card = page.locator('.task-card').last();
  const nameField = card.locator('.expr-field', { hasText: 'name' }).first();
  await nameField.locator('input').first().fill(TASK_NAME);
  await nameField.getByRole('button', { name: 'use this' }).click();
  const titleField = card.locator('.expr-field', { hasText: 'title' }).first();
  const enTitle = titleField.getByRole('textbox', { name: 'Task title in en' });
  if (!(await enTitle.isVisible().catch(() => false))) {
    await titleField.locator('input').first().fill(TASK_NAME);
    await titleField.getByRole('button', { name: 'Make it translatable' }).click();
  }
  await enTitle.fill('Geriatric referral follow up');
  await titleField.getByRole('textbox', { name: 'Task title in ne' }).fill('ज्येष्ठ नागरिक प्रेषण फलोअप');
  await beat(page, 1500);
  await card.locator('.expr-field', { hasText: 'appliesToType' })
    .getByRole('checkbox', { name: IHA, exact: true }).check();
  await card.locator('.expr-field', { hasText: 'appliesIf' }).locator('button', { hasText: '✎ build' }).click();
  const aif = page.locator('.rule-builder-modal');
  for (const flag of REFER_FLAGS) {
    await aif.getByRole('button', { name: '+ report field', exact: true }).click();
    const row = aif.locator('.rule-row').last();
    await row.locator('select.field-picker').selectOption(flag.name);
    const vs = row.locator('select.choice-value-select');
    if (await vs.isVisible().catch(() => false)) await vs.selectOption('true');
    else await row.getByPlaceholder('value', { exact: true }).fill('true');
  }
  const pills = aif.locator('select.connector-pill');
  for (let i = 0; i < (await pills.count()); i += 1) {
    const pill = pills.nth(i);
    if (await pill.isEnabled().catch(() => false)) await pill.selectOption('or');
  }
  await aif.getByRole('button', { name: 'Save' }).click();
  await expect(aif).toBeHidden();
  const ev = card.locator('.events-editor .event-card').first();
  await ev.locator('.name-input').fill('geriatric_referral_followup_visit');
  await ev.locator('input[type=number]').nth(0).fill('30');
  await ev.locator('input[type=number]').nth(1).fill('15');
  await ev.locator('input[type=number]').nth(2).fill('15');
  const resolved = card.locator('.expr-field', { hasText: 'resolvedIf' });
  await resolved.locator('button', { hasText: /^Visual$/ }).click();
  await resolved.locator('button', { hasText: 'use "form submitted in window"' }).click();
  await resolved.locator('button', { hasText: /^pick$/ }).click();
  await resolved.locator('select[title="App form whose submission resolves the task"]').selectOption(FOLLOWUP);
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
  // Hand-edit 3, on camera: the picker's report.<field> is undefined at runtime.
  await actionsField.locator('button', { hasText: /^Raw JS$/ }).first().click();
  const ta = actionsField.locator('textarea').first();
  const cur = await ta.inputValue();
  await ta.fill(cur.replace(/content\.(refer_\w+)\s*=\s*report\.(refer_\w+);/g,
    (_m, t: string, s2: string) => `content.${t} = Utils.getField(report, '${s2}');`));
  await beat(page, 2000);
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible({ timeout: 60_000 });

  /* Off-camera hand-edits the tool cannot do. */
  await relocateInputRows();
  await reformatEmittedTask();

  /* ══════════════ PART 2 — deploy ══════════════ */
  console.log('[arc] PART 2 — deploying with the project’s cht-conf command');
  let deployOut = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // The sandbox CouchDB degrades under memory pressure; heal before trying.
    if ((await chtReq('GET', '/medic/').catch(() => ({ status: 0 }))).status !== 200) {
      console.log('[arc] instance unhealthy — restarting the CHT stack');
      try { execFileSync('docker', ['restart', 'poc_demo_cht-couchdb-1', 'poc_demo_cht-haproxy-1', 'poc_demo_cht-api-1'], { stdio: 'ignore' }); } catch { /* keep waiting */ }
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 10_000));
        if ((await chtReq('GET', '/medic/').catch(() => ({ status: 0 }))).status === 200) break;
      }
    }
    try {
      deployOut = execFileSync(CHT_BIN, [
        `--url=https://medic:password@127-0-0-1.local-ip.medicmobile.org:10445/`,
        'compile-app-settings', 'convert-app-forms', 'convert-collect-forms', 'convert-contact-forms',
        'upload-app-settings', 'upload-app-forms', 'upload-collect-forms', 'upload-contact-forms',
        'upload-resources', 'upload-custom-translations', '--force',
      ], { cwd: PROJECT, encoding: 'utf8', timeout: 2_400_000, shell: true });
      if (deployOut.includes('All actions completed')) break;
    } catch (e: any) {
      deployOut = String(e?.stdout ?? e?.message ?? e);
      console.log(`[arc] deploy attempt ${attempt} failed: ${deployOut.slice(-200)}`);
    }
  }
  expect(deployOut, 'cht-conf completed').toContain('All actions completed');
  console.log('[arc] ✓ deploy: All actions completed');

  /* ══════════════ PART 3 — the live CHW loop ══════════════ */
  console.log('[arc] PART 3 — the CHW on the live instance');
  await page.goto(`${INSTANCE}/medic/login?redirect=%2F`);
  const user = page.locator('#user');
  if (await user.isVisible().catch(() => false)) {
    await user.fill(CHW.user);
    await page.locator('#password').fill(CHW.pass);
    await page.locator('#login').click();
  }
  await expect(page.getByRole('link', { name: /Tasks/ })).toBeVisible({ timeout: 300_000 });
  await page.waitForTimeout(20_000);
  await beat(page, 2000);

  await page.goto(`${INSTANCE}/#/contacts/${ELDER_ID}`);
  await expect(page.locator('.content-pane').getByRole('heading', { name: ELDER })).toBeVisible({ timeout: 300_000 });
  await beat(page, 2500);
  await page.locator('.content-pane mm-fast-action-button button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(IHA_TITLE)).toBeVisible({ timeout: 120_000 });
  await beat(page, 2000);
  await dialog.getByText(IHA_TITLE).click();
  await expect(page.locator('.question:visible').first()).toBeVisible({ timeout: 900_000 });
  await beat(page, 2500);

  await answer(page, 'general check-in on your health', 'Agree');
  await beat(page, 2500);
  await nextPage(page);
  await answer(page, 'Do you have trouble remembering', 'Yes (Fail)');
  await answer(page, 'repeat these 3 words', 'Unable to repeat all three words (Fail)');
  await answer(page, "today's full date", 'Both correct (Pass)');
  await beat(page, 1500);
  await nextPage(page);
  await answer(page, 'do you feel safe standing up', 'No (Do not test)');
  await nextPage(page);
  await answer(page, 'has your weight decreased', 'No (Pass)');
  await answer(page, 'belt become loose', 'No (Pass)');
  {
    const w = page.locator('.question', { hasText: 'Measure their weight' }).locator('input[type="number"]');
    if (await w.isVisible().catch(() => false)) await w.fill('62');
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

  // Enketo saves locally first. Right after a deploy the client re-syncs the
  // whole config, which queues the outbound push — so poll patiently and
  // reload periodically to nudge replication.
  let report: any;
  for (let i = 0; i < 60 && !report; i += 1) {
    const found = await chtReq('POST', '/medic/_find', { selector: { type: 'data_record', form: IHA }, limit: 50 });
    report = (found.json.docs ?? []).sort((a: any, b: any) => b.reported_date - a.reported_date)[0];
    if (!report) {
      await new Promise((r) => setTimeout(r, 5000));
      if (i % 6 === 5) { await page.reload().catch(() => {}); await page.waitForTimeout(8000); }
    }
  }
  expect(report, 'assessment replicated to the server').toBeTruthy();
  expect(JSON.stringify(report.fields)).toContain('"refer_cognitive":"true"');
  report.reported_date = Date.now() - 20 * 24 * 60 * 60 * 1000;
  await chtReq('PUT', `/medic/${report._id}`, report);
  console.log('[arc] ⏩ simulating 20 days so the customer’s 15/30/15 window opens');
  await page.reload();
  await page.waitForTimeout(20_000);

  await page.goto(`${INSTANCE}/#/tasks`);
  let task = page.getByRole('link', { name: new RegExp(ELDER) }).first();
  for (let i = 0; i < 30; i += 1) {
    if (await task.isVisible().catch(() => false)) break;
    await page.waitForTimeout(20_000);
    if (i % 5 === 4) { await page.reload(); await page.waitForTimeout(10_000); await page.goto(`${INSTANCE}/#/tasks`); }
    task = page.getByRole('link', { name: new RegExp(ELDER) }).first();
  }
  await expect(task).toBeVisible({ timeout: 60_000 });
  await expect(task).toContainText('Geriatric referral follow up');
  await beat(page, 3500);

  await task.click();
  await expect(page.locator('.question:visible').first()).toBeVisible({ timeout: 900_000 });
  await beat(page, 2500);
  const seen: string[] = [];
  const record = async () => {
    for (const t of await page.locator('.question:visible').allTextContents()) seen.push(t.replace(/\s+/g, ' ').trim().slice(0, 70));
  };
  await record();
  await answer(page, 'visit a relevant health facility', 'Yes');
  await nextPage(page); await record();
  await answer(page, 'formal examination', 'Yes');
  await nextPage(page); await record();
  {
    const diag = page.locator('.question:visible input[type="text"], .question:visible textarea').first();
    if (await diag.isVisible().catch(() => false)) {
      await diag.fill('Mild cognitive impairment — reviewed at facility');
      await nextPage(page); await record();
    }
  }
  await answer(page, 'medication or therapy started', 'Yes');
  await nextPage(page); await record();
  await answer(page, 'Improvement in memory', 'Improving');
  await beat(page, 3000);
  await nextPage(page).catch(() => {});
  await record();
  const joined = seen.join(' | ');
  expect(joined).toContain('Improvement in memory');
  for (const hidden of ['sit-to-stand', 'weight increased', 'external condition of the eye', 'hearing ability', 'Psychological status', 'Urinary continence']) {
    expect(joined.toLowerCase(), `${hidden} hidden`).not.toContain(hidden.toLowerCase());
  }
  const submit = page.getByRole('button', { name: 'Submit', exact: true });
  await expect(submit).toBeVisible({ timeout: 120_000 });
  await submit.click();
  await beat(page, 3000);

  await page.goto(`${INSTANCE}/#/tasks`);
  await page.waitForTimeout(SLOW ? 8000 : 5000);
  await expect(page.getByRole('link', { name: new RegExp(ELDER) })).toHaveCount(0, { timeout: 120_000 });
  await beat(page, 3000);
  console.log('[arc] ✓✓ FULL ARC COMPLETE on the NSSD national config');
});
