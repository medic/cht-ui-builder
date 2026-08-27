/**
 * NSSD GERIATRIC FULL ARC — build the geriatric use case INTO THE REAL
 * NATIONAL CONFIG (`W:\medic\config-nssd\chis`) through the no-code UI,
 * deploy it, and prove the task lifecycle on the live instance. One test =
 * one continuous video.
 *
 * Naming follows the workbook's "Form Overview" tab (option A):
 *   Integrated Health Assessment form for elder population
 *     → integrated_health_assessment_form_for_elder_population
 *   Geriatric care follow up form
 *     → geriatric_care_follow_up_form
 *
 * WHAT THIS CONFIG ALREADY GIVES US (so the tool doesn't have to):
 * contact-summary-extras.js exposes previous_bmi_ctx / sys_ctx / dia_ctx /
 * glucometer_ctx, computed from hypertension_screening + diabetes_screening
 * (gated on age >= 30 + an NCD record). The workbook's R3 row ("BMI: …,
 * blood pressure …, blood sugar …") is therefore three CALCULATES that read
 * those keys — the house convention being
 * `once(instance('contact-summary')/context/<key>)` — plus three notes. No
 * new contact-summary code is written by this spec.
 *
 * NOT TOUCHED: hierarchy, contact types, contact forms, or any existing
 * form/task in the config.
 *
 *   pnpm --filter @cht-ui/client exec playwright test geriatric-nssd-build.spec.ts   # fast
 *   $env:DEMO=1 ; ...same...                                                          # record
 */
import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  API, T, ihaSections, REFER_FLAGS,
  ensureFullMode, rowByName, saveForm,
  addSection, addRow, fillRuleList,
} from './helpers/geriatric.js';
import type { Row, Rel } from './helpers/geriatric.js';
import { PROJECT_PATH } from './setup.js';

// Project under test. Defaults to the committed fixture so a fresh clone runs;
// set CHT_PROJECT (or PLAYWRIGHT_PROJECT_PATH) to drive a real cht-conf project.
const PROJECT = process.env.CHT_PROJECT ?? PROJECT_PATH;
const IHA_TITLE = 'Integrated Health Assessment form for elder population';
const IHA = 'integrated_health_assessment_form_for_elder_population';
const FU_TITLE = 'Geriatric care follow up form';
const FOLLOWUP = 'geriatric_care_follow_up_form';
const TASK_NAME = 'Geriatric referral follow up';
const SLOW = process.env.DEMO ? Number(process.env.DEMO_MS ?? '500') : 0;

/** Context keys this config already computes from the NCD screening forms. */
const CS_KEYS = {
  bmi: 'previous_bmi_ctx',
  sys: 'sys_ctx',
  dia: 'dia_ctx',
  sugar: 'glucometer_ctx',
} as const;

test.use({
  video: { mode: 'on', size: { width: 2560, height: 1440 } },
  viewport: { width: 2560, height: 1440 },
  ignoreHTTPSErrors: true,
  launchOptions: { slowMo: SLOW },
});

async function beat(page: Page, ms: number): Promise<void> {
  if (SLOW) await page.waitForTimeout(ms);
}

/** Create an app form in a project that already has dozens of them. */
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

/**
 * A calculate that reads one of the config's existing contact-summary keys.
 * Prefers the builder's cross-form picker; falls back to the Raw tab when the
 * picker can't see keys this config assembles imperatively (a FINDING — the
 * context-key picker only lists structured `context: {…}` literals).
 */
async function addContextCalc(page: Page, accordion: Locator, name: string, key: string): Promise<'picker' | 'raw'> {
  await addRow(page, accordion, { name, en: '', ne: '', tile: T.calc });
  const row = rowByName(page, name);
  const adv = row.getByRole('button', { name: /show advanced/ });
  if (await adv.isVisible().catch(() => false)) await adv.click();
  await row.locator('.expr-field')
    .filter({ has: page.locator('code.raw-col-tag', { hasText: 'calculation' }) })
    .locator('button', { hasText: 'build' }).click();
  const calc = page.locator('.rule-builder-modal[aria-label="Calculation builder"]');
  await expect(calc).toBeVisible();

  let how: 'picker' | 'raw' = 'raw';
  await calc.getByRole('tab', { name: 'Single value' }).click();
  const crossForm = calc.getByRole('radio', { name: /From another form/ });
  if (await crossForm.isVisible().catch(() => false)) {
    await crossForm.click();
    const picker = calc.getByLabel('Cross-form context value');
    const options = await picker.locator('option').allTextContents().catch(() => [] as string[]);
    if (options.some((o) => o.includes(key))) {
      await picker.selectOption(key);
      how = 'picker';
    }
  }
  if (how === 'raw') {
    // House convention in this config: once(instance('contact-summary')/context/<key>)
    await calc.getByRole('tab', { name: 'Raw' }).click();
    await calc.locator('textarea').first().fill(`once(instance('contact-summary')/context/${key})`);
  }
  await calc.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(calc).toBeHidden();
  return how;
}

/** Put ${ref} into a note's EN label via the insert menu (reorders if needed). */
async function insertRefIntoLabel(page: Page, noteName: string, ref: string): Promise<void> {
  const noteRow = rowByName(page, noteName);
  const enLabel = noteRow.locator('.label-row').filter({ has: page.getByText('label::en', { exact: true }) });
  await enLabel.locator('input').click();
  await enLabel.getByRole('button', { name: '+ insert' }).click();
  const menu = page.locator('.label-insert-ref-menu');
  const item = menu.getByRole('menuitem', { name: `\${${ref}}` });
  if (!(await item.isVisible().catch(() => false))) {
    // NEXT.md item E — a fresh calculate can land BELOW the note, so it isn't
    // offered as an "earlier field" until moved up.
    await page.keyboard.press('Escape');
    await rowByName(page, ref).getByRole('button', { name: 'move up' }).click();
    await enLabel.locator('input').click();
    await enLabel.getByRole('button', { name: '+ insert' }).click();
  }
  await menu.getByRole('menuitem', { name: `\${${ref}}` }).click();
  await expect(enLabel.locator('input')).toHaveValue(new RegExp(`\\$\\{${ref}\\}`));
}

test('NSSD geriatric — build the assessment, the follow-up and the task in the national config', async ({ page }) => {
  test.setTimeout(5_400_000);

  // Snapshot the files the tool will touch, so the report can prove exactly
  // what changed (and that nothing else did).
  for (const f of ['tasks.js', 'translations/messages-en.properties', 'translations/messages-ne.properties']) {
    await fs.copyFile(path.join(PROJECT, f), path.join(PROJECT, `${path.basename(f)}.before`)).catch(() => {});
  }

  await page.request.post(`${API}/api/project/close`).catch(() => {});
  const open = await page.request.post(`${API}/api/project/open`, { data: { path: PROJECT } });
  expect(open.ok(), 'open config-nssd/chis').toBeTruthy();
  await page.goto('/');
  await expect(page.locator('.nav-item', { hasText: 'Forms' })).toBeVisible({ timeout: 120_000 });
  await beat(page, 2500);

  /* ════════════ 1. The Integrated Health Assessment ════════════ */
  console.log('[nssd] creating the assessment form');
  await createForm(page, IHA_TITLE, IHA);

  // Eligibility: c82_person aged 60+ (Form Overview R1 "Context").
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

  // Nepali, so every add-picker collects label::ne inline.
  const bar = page.locator('.language-chip-bar');
  if (!(await bar.locator('.language-chip', { hasText: 'नेपाली' }).isVisible().catch(() => false))) {
    await bar.getByRole('button', { name: '+ Add language' }).click();
    await page.locator('.language-chip-popover').locator('button', { hasText: 'नेपाली (Nepali)' }).click();
  }
  await saveForm(page);
  await beat(page, 1500);

  /* 1a. Intro section: consent + the three NCD values pulled via contact
        summary (workbook rows R1 and R3). */
  console.log('[nssd] intro section (consent + BMI/BP/sugar from NCD screenings)');
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

  const calcHow: string[] = [];
  for (const [calcName, key, noteName, noteEn, noteNe] of [
    ['geri_bmi', CS_KEYS.bmi, 'geri_bmi_note', 'Body Mass Index (BMI): ', 'बडी मास इन्डेक्स (BMI): '],
    ['geri_sys', CS_KEYS.sys, 'geri_bp_note', 'Your blood pressure (systolic) is: ', 'तपाईंको रक्तचाप (सिस्टोलिक): '],
    ['geri_sugar', CS_KEYS.sugar, 'geri_sugar_note', 'The amount of sugar in your blood is: ', 'तपाईंको रगतमा चिनीको मात्रा: '],
  ] as const) {
    calcHow.push(`${calcName}:${await addContextCalc(page, intro, calcName, key)}`);
    await addRow(page, intro, { name: noteName, tile: T.note, en: noteEn, ne: noteNe });
    await insertRefIntoLabel(page, noteName, calcName);
  }
  console.log(`[nssd] cross-form calcs authored via → ${calcHow.join(', ')}`);
  await saveForm(page);

  /* 1b. The ten assessment sections (workbook rows R4–R51). */
  for (const section of ihaSections(true)) {
    console.log(`[nssd] section: ${section.en}`);
    const accordion = await addSection(page, section);
    for (const row of section.rows) await addRow(page, accordion, row);
    await saveForm(page);
  }

  /* 1c. The seven hidden referral flags — the contract with the task and the
        follow-up form (the workbook's referral NOTES persist nothing). */
  for (const flag of REFER_FLAGS) {
    console.log(`[nssd] flag: ${flag.name}`);
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

  // Disk truth for the assessment.
  {
    const res = await page.request.get(`${API}/api/forms/${encodeURIComponent(`app:${IHA}`)}`);
    expect(res.ok()).toBeTruthy();
    const form = (await res.json()).form as {
      survey: Array<{ type: string; name: string; extras: Record<string, string> }>;
    };
    for (const flag of REFER_FLAGS) {
      const r = form.survey.find((x) => x.name === flag.name);
      expect(r, `${flag.name} on disk`).toBeTruthy();
      expect(r!.extras['calculation'] ?? '').toMatch(/^if\(.+, 'true', ''\)$/);
    }
    const bmi = form.survey.find((x) => x.name === 'geri_bmi')!;
    expect(bmi.extras['calculation']).toContain(CS_KEYS.bmi);
    console.log(`[nssd] ✓ assessment on disk — ${form.survey.length} rows, BMI calc = ${bmi.extras['calculation']}`);
  }

  /* ════════════ 2. The Geriatric care follow up form ════════════ */
  console.log('[nssd] creating the follow-up form');
  await createForm(page, FU_TITLE, FOLLOWUP);
  const bar2 = page.locator('.language-chip-bar');
  if (!(await bar2.locator('.language-chip', { hasText: 'नेपाली' }).isVisible().catch(() => false))) {
    await bar2.getByRole('button', { name: '+ Add language' }).click();
    await page.locator('.language-chip-popover').locator('button', { hasText: 'नेपाली (Nepali)' }).click();
  }

  // Receiving nodes for the task's modifyContent.
  await ensureFullMode(page);
  const inputsAccordion = page.locator('.survey-group-accordion')
    .filter({ has: page.locator('code', { hasText: /^inputs$/ }) }).first();
  await expect(inputsAccordion).toBeVisible();
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

  const YES_NO: Row['list'] = { list: 'geri_fu_yes_no', choices: [
    { name: 'yes', en: 'Yes', ne: 'छ' },
    { name: 'no', en: 'No', ne: 'छैन' },
  ] };
  const STATUS = (list: string): Row['list'] => ({ list, choices: [
    { name: `${list}_improving`, en: 'Improving', ne: 'सुधारोन्मुख' },
    { name: `${list}_same`, en: 'No change', ne: 'उस्तै छ' },
    { name: `${list}_worse`, en: 'Getting worse', ne: 'झन् खराब' },
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
    { name: 'diagnosis_result', tile: T.text,
      en: 'Diagnosis / Result', ne: 'निदान / परिणाम', rel: { rules: [visited] } },
    { name: 'meds_started', tile: T.s1, required: true, reuse: 'geri_fu_yes_no',
      en: 'Was medication or therapy started?', ne: 'औषधि वा थेरापी सुरु भयो ?', rel: { rules: [visited] } },
    { name: 'memory_improvement', tile: T.s1, required: true, list: STATUS('geri_mem'),
      en: 'Improvement in memory', ne: 'सम्झने क्षमतामा सुधार',
      rel: { rules: [visited, flagTrue('refer_cognitive')] } },
    { name: 'sit_stand_followup', tile: T.s1, required: true, list: STATUS('geri_mob'),
      en: 'Time taken to complete five sit-to-stand repetitions', ne: '५ पटक उठन-बस्न लागेको समय',
      rel: { rules: [visited, flagTrue('refer_mobility')] } },
    { name: 'weight_increased', tile: T.s1, required: true, list: STATUS('geri_nut'),
      en: 'Has the weight increased?', ne: 'तौल बढेको छ ?',
      rel: { rules: [visited, flagTrue('refer_nutrition')] } },
    { name: 'external_eye_now', tile: T.s1, required: true, list: STATUS('geri_eye'),
      en: 'What is the current external condition of the eye?', ne: 'हाल बाह्य आँखाको अवस्था कस्तो छ ?',
      rel: { rules: [visited, flagTrue('refer_vision')] } },
    { name: 'hearing_status', tile: T.s1, required: true, list: STATUS('geri_ear'),
      en: 'What is the current status of hearing ability?', ne: 'श्रवण क्षमताको अवस्था कस्तो छ ?',
      rel: { rules: [visited, flagTrue('refer_hearing')] } },
    { name: 'psych_status', tile: T.s1, required: true, list: STATUS('geri_psy'),
      en: 'Psychological status', ne: 'मनोवैज्ञानिक अवस्था',
      rel: { rules: [visited, flagTrue('refer_psych')] } },
    { name: 'continence_status', tile: T.s1, required: true, list: STATUS('geri_con'),
      en: 'Urinary continence', ne: 'पिसाब नियन्त्रण',
      rel: { rules: [visited, flagTrue('refer_continence')] } },
    { name: 'not_visited_note', tile: T.note,
      en: 'Advise the family that further treatment is required and refer them immediately to an appropriate health facility.',
      ne: 'उहाँलाई थप उपचारको आवश्यकता भएको भनि घर परिवारलाई सल्लाह दिनुहोस् र उपचार हुने स्वास्थ्य संस्थामा तुरुन्तै प्रेषण गर्नुहोस् ।',
      rel: { rules: [{ kind: 'cmp', field: 'visited_facility', choice: 'no' }] } },
  ];
  for (const row of FU_ROWS) {
    console.log(`[nssd] follow-up row: ${row.name}`);
    await ensureFullMode(page);
    await addRow(page, null, row);
  }
  await saveForm(page);

  /* ════════════ 3. The task in tasks.js ════════════ */
  console.log('[nssd] building the task');
  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  const before = (await page.locator('.task-card').count());
  await page.getByRole('button', { name: '+ Add task' }).click();
  const card = page.locator('.task-card').last();
  const nameField = card.locator('.expr-field', { hasText: 'name' }).first();
  await nameField.locator('input').first().fill(TASK_NAME);
  await nameField.getByRole('button', { name: 'use this' }).click();

  // Bilingual title (item 8) — the tool derives + writes the translation key.
  const titleField = card.locator('.expr-field', { hasText: 'title' }).first();
  const enTitle = titleField.getByRole('textbox', { name: 'Task title in en' });
  if (!(await enTitle.isVisible().catch(() => false))) {
    await titleField.locator('input').first().fill(TASK_NAME);
    await titleField.getByRole('button', { name: 'Make it translatable' }).click();
  }
  await enTitle.fill('Geriatric referral follow up');
  await titleField.getByRole('textbox', { name: 'Task title in ne' })
    .fill('ज्येष्ठ नागरिक प्रेषण फलोअप');
  await beat(page, 1500);

  await card.locator('.expr-field', { hasText: 'appliesToType' })
    .getByRole('checkbox', { name: IHA, exact: true }).check();

  // Condition: OR of the seven referral flags.
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

  // Window: the workbook's 15 / 30 / 15.
  const ev = card.locator('.events-editor .event-card').first();
  await ev.locator('.name-input').fill('geriatric_referral_followup_visit');
  await ev.locator('input[type=number]').nth(0).fill('30');
  await ev.locator('input[type=number]').nth(1).fill('15');
  await ev.locator('input[type=number]').nth(2).fill('15');

  // Resolution: the follow-up submitted in the window.
  const resolved = card.locator('.expr-field', { hasText: 'resolvedIf' });
  await resolved.locator('button', { hasText: /^Visual$/ }).click();
  await resolved.locator('button', { hasText: 'use "form submitted in window"' }).click();
  await resolved.locator('button', { hasText: /^pick$/ }).click();
  await resolved.locator('select[title="App form whose submission resolves the task"]').selectOption(FOLLOWUP);

  // Action + the seven flag mappings.
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
  // KNOWN P1: the picker emits `report.<field>`, undefined at runtime. The
  // Raw JS hatch is the only working path today.
  await actionsField.locator('button', { hasText: /^Raw JS$/ }).first().click();
  const ta = actionsField.locator('textarea').first();
  const cur = await ta.inputValue();
  // Rewrite to this config's own house style, which is also the shape that
  // actually resolves at runtime: Utils.getField(report, '<field>').
  const fixed = cur.replace(
    /content\.(refer_\w+)\s*=\s*report\.(refer_\w+);/g,
    (_m, target: string, src: string) => `content.${target} = Utils.getField(report, '${src}');`,
  );
  expect(fixed, 'mapping sources rewritten').toContain("Utils.getField(report, 'refer_cognitive')");
  await ta.fill(fixed);
  await beat(page, 1500);

  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible({ timeout: 60_000 });

  /* ════════════ 4. Disk truth: our task added, the config's 20+ intact ════════════ */
  {
    const saved = await fs.readFile(path.join(PROJECT, 'tasks.js'), 'utf8');
    const beforeSrc = await fs.readFile(path.join(PROJECT, 'tasks.js.before'), 'utf8');
    const lost = beforeSrc.split('\n').filter((l) => l.trim().length > 2 && !saved.includes(l));
    expect(lost, `EXISTING tasks.js lines lost on save:\n${lost.slice(0, 8).join('\n')}`).toEqual([]);
    expect(saved).toContain(`appliesToType: [ '${IHA}' ]`);
    expect(saved).toContain(`'${FOLLOWUP}'`);
    for (const flag of REFER_FLAGS) {
      expect(saved, `guard leg ${flag.name}`).toContain(`Utils.getField(report, '${flag.name}') !== 'true'`);
    }
    expect(saved).toMatch(/title: 'task\.[\w.\-]+\.title'/);
    const en = await fs.readFile(path.join(PROJECT, 'translations', 'messages-en.properties'), 'utf8');
    const ne = await fs.readFile(path.join(PROJECT, 'translations', 'messages-ne.properties'), 'utf8');
    expect(en).toContain('Geriatric referral follow up');
    expect(ne).toContain('ज्येष्ठ नागरिक प्रेषण फलोअप');
    console.log(`[nssd] ✓ tasks.js: ${before} existing tasks intact, ours appended; bilingual title written to both locales`);
  }
});
