/**
 * T9e (#18) — the Validation panel.
 *
 * Acceptance under test:
 *   1. add **age** (integer) with "Between 0 and 20" and a message in the
 *      picker; the sheet has `. >= 0 and . <= 20` and `constraint_message::en`;
 *      reopening shows the preset filled in;
 *   4. open-and-save with zero edits leaves every `constraint` byte-identical,
 *      INCLUDING those the panel displays as presets (`. <= 100 and . >= 70`
 *      shown as Between 70 and 100), and `true()` is labelled, never rewritten;
 *      an edited preset is written canonically, the untouched one as written;
 *   5. one preset per type (text length, date not in the future, select-many
 *      "[choice] must be chosen alone") with the emitted cell asserted on disk;
 *   plus: required + required_message live beside the rule.
 *
 * The suite fixture seeds the one-click tile preference ON; the picker test
 * clears it so the configure step (and the panel inside it) is exercised.
 */
import { test, expect } from './setup.js';
import type { Locator, Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(here, 'fixtures', 'mini-config');
const API = 'http://127.0.0.1:5174';

type SurveyRow = { name?: string; type: string; required?: string; extras: Record<string, string> };
type FormBody = { form: { survey: SurveyRow[] }; properties?: unknown };

function rowByType(page: Page, rawType: RegExp): Locator {
  return page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: rawType }) });
}

async function rowByName(page: Page, name: string): Promise<Locator> {
  const rows = page.locator('.survey-row').filter({
    has: page.getByRole('textbox', { name: 'name', exact: true }),
  });
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    if ((await row.getByRole('textbox', { name: 'name', exact: true }).inputValue()) === name) return row;
  }
  throw new Error(`no row named ${name}`);
}

async function openPregnancy(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
  await expect(page.locator('.survey-row').first()).toBeVisible();
}

async function saveForm(page: Page): Promise<void> {
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible();
}

/** Open a row's advanced panel and return its Validation panel. */
async function openPanel(row: Locator): Promise<Locator> {
  await row.getByRole('button', { name: /show advanced/ }).click();
  const panel = row.getByTestId('validation-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** Make the form dirty somewhere harmless (gravidity's English label) so Save is reachable. */
async function dirtyForm(page: Page): Promise<void> {
  const label = rowByType(page, /^integer$/).getByPlaceholder('label in en');
  await label.fill('Number of pregnancies (t9e)');
}

async function withScratchProject(
  request: Parameters<Parameters<typeof test>[1]>[0]['request'],
  body: () => Promise<void>,
): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-t9e-'));
  try {
    await fs.cp(FIXTURE_DIR, tmp, { recursive: true });
    expect((await request.post(`${API}/api/project/open`, { data: { path: tmp } })).ok()).toBeTruthy();
    await body();
  } finally {
    await request.post(`${API}/api/project/open`, { data: { path: FIXTURE_DIR } });
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function getForm(request: Parameters<Parameters<typeof test>[1]>[0]['request']): Promise<FormBody> {
  return (await (await request.get(`${API}/api/forms/app:pregnancy`)).json()) as FormBody;
}

async function seedCells(
  request: Parameters<Parameters<typeof test>[1]>[0]['request'],
  seed: Record<string, Record<string, string>>,
): Promise<void> {
  const body = await getForm(request);
  for (const row of body.form.survey) {
    const s = row.name ? seed[row.name] : undefined;
    if (s) row.extras = { ...row.extras, ...s };
  }
  const put = await request.put(`${API}/api/forms/app:pregnancy`, {
    data: { form: body.form, properties: body.properties ?? null },
  });
  expect(put.ok()).toBeTruthy();
}

test('T9e — age with Between 0 and 20 in the picker: sheet has the rule and the message; reopening shows the preset filled in', async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    try {
      // eslint-disable-next-line no-undef
      window.localStorage.setItem('cht-ui-builder.oneClickTiles', 'false');
    } catch {
      /* storage unavailable */
    }
  });
  await withScratchProject(request, async () => {
    await openPregnancy(page);
    await page.getByRole('button', { name: '+ Question', exact: true }).click();
    const picker = page.locator('.qtype-modal');
    await picker.getByPlaceholder(/has_fever/).fill('age');
    await picker.locator('.qtype-locale-label input').first().fill('Age');
    await picker
      .locator('.qtype-tile')
      .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Number$/ }) })
      .click();
    const panel = picker.getByTestId('validation-panel');
    await expect(panel).toBeVisible();
    await panel.getByRole('combobox', { name: 'Add a validation rule' }).selectOption({ label: 'Between two values' });
    await panel.getByRole('spinbutton', { name: 'Minimum' }).fill('0');
    await panel.getByRole('spinbutton', { name: 'Maximum' }).fill('20');
    // The message is suggested from the preset; the author may edit it.
    const enMessage = panel.getByPlaceholder('Message shown when the answer is rejected');
    await expect(enMessage).toHaveValue('Must be between 0 and 20');
    await picker.getByRole('button', { name: 'Add question', exact: true }).click();
    await expect(picker).not.toBeVisible();
    await saveForm(page);

    const after = await getForm(request);
    const age = after.form.survey.find((r) => r.name === 'age')!;
    expect(age.extras['constraint']).toBe('. >= 0 and . <= 20');
    expect(age.extras['constraint_message::en']).toBe('Must be between 0 and 20');

    // Reopen: the preset is filled in.
    await openPregnancy(page);
    const panel2 = await openPanel(await rowByName(page, 'age'));
    await expect(panel2.getByRole('spinbutton', { name: 'Minimum' })).toHaveValue('0');
    await expect(panel2.getByRole('spinbutton', { name: 'Maximum' })).toHaveValue('20');
    await expect(panel2.getByPlaceholder('Message shown when the answer is rejected')).toHaveValue('Must be between 0 and 20');
  });
});

test('T9e — displayed as presets, saved as written: reverse-order between, tight not-in-future, true(); an edited preset is canonical', async ({
  page,
  request,
}) => {
  await withScratchProject(request, async () => {
    await seedCells(request, {
      gravidity: { constraint: '. <= 100 and . >= 70', 'constraint_message::en': 'Between 70 and 100' },
      lmp_date: { constraint: '.<=today()' },
      chair_rise: { constraint: 'true()' },
    });
    await openPregnancy(page);

    const gravPanel = await openPanel(rowByType(page, /^integer$/));
    await expect(gravPanel.getByRole('spinbutton', { name: 'Minimum' })).toHaveValue('70');
    await expect(gravPanel.getByRole('spinbutton', { name: 'Maximum' })).toHaveValue('100');
    const lmpPanel = await openPanel(rowByType(page, /^date$/));
    await expect(lmpPanel.getByRole('combobox', { name: 'Relative to today' })).toHaveValue('<=');
    const chairPanel = await openPanel(rowByType(page, /^select_one pass_fail$/));
    await expect(chairPanel.getByRole('note')).toHaveText(/This rule always passes/);

    // Zero edits to the rules; dirty the form elsewhere and save.
    await dirtyForm(page);
    await saveForm(page);
    let after = await getForm(request);
    const cell = (name: string) => after.form.survey.find((r) => r.name === name)!.extras['constraint'];
    expect(cell('gravidity')).toBe('. <= 100 and . >= 70');
    expect(cell('lmp_date')).toBe('.<=today()');
    expect(cell('chair_rise')).toBe('true()');

    // Edit the maximum: that item is written canonically (min first).
    await gravPanel.getByRole('spinbutton', { name: 'Maximum' }).fill('99');
    await saveForm(page);
    after = await getForm(request);
    expect(cell('gravidity')).toBe('. >= 70 and . <= 99');
    expect(cell('lmp_date')).toBe('.<=today()');
  });
});

test('T9e — one preset per type: text length, date not in the future, select-many choice alone, required message', async ({
  page,
  request,
}) => {
  await withScratchProject(request, async () => {
    await openPregnancy(page);

    // Date: Not in the future.
    const lmpPanel = await openPanel(rowByType(page, /^date$/));
    await lmpPanel.getByRole('combobox', { name: 'Add a validation rule' }).selectOption({ label: 'Not in the future' });
    await expect(lmpPanel.getByPlaceholder('Message shown when the answer is rejected')).toHaveValue('Cannot be in the future');

    // Select many: vaginal_bleeding must be chosen alone (choice labels shown, name saved).
    const dsPanel = await openPanel(rowByType(page, /^select_multiple danger_signs$/));
    await dsPanel.getByRole('combobox', { name: 'Add a validation rule' }).selectOption({ label: 'A choice must be chosen alone' });
    await dsPanel.getByRole('combobox', { name: 'Choice' }).selectOption('vaginal_bleeding');

    // Integer: required with its own message, beside the rule.
    const gravPanel = await openPanel(rowByType(page, /^integer$/));
    await gravPanel.getByRole('checkbox', { name: /^Required/ }).check();
    await gravPanel.getByPlaceholder('Message shown when the answer is missing (optional)').fill('Please enter a number');

    // Text: add a text question (one-click tile, suite default) and give it a length rule.
    await page.getByRole('button', { name: '+ Question', exact: true }).click();
    const picker = page.locator('.qtype-modal');
    await picker.getByPlaceholder(/has_fever/).fill('notes');
    await picker
      .locator('.qtype-tile')
      .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Text$/ }) })
      .click();
    await expect(picker).not.toBeVisible();
    const notesPanel = await openPanel(await rowByName(page, 'notes'));
    await notesPanel.getByRole('combobox', { name: 'Add a validation rule' }).selectOption({ label: 'At most N characters' });
    await notesPanel.getByRole('spinbutton', { name: 'Characters' }).fill('100');
    await expect(notesPanel.getByPlaceholder('Message shown when the answer is rejected')).toHaveValue('Must be at most 100 characters');

    await saveForm(page);
    const after = await getForm(request);
    const row = (name: string) => after.form.survey.find((r) => r.name === name)!;
    expect(row('lmp_date').extras['constraint']).toBe('. <= today()');
    expect(row('lmp_date').extras['constraint_message::en']).toBe('Cannot be in the future');
    expect(row('danger_signs').extras['constraint']).toBe("not(selected(., 'vaginal_bleeding') and count-selected(.) > 1)");
    expect(row('gravidity').required).toBe('yes');
    expect(row('gravidity').extras['required_message::en']).toBe('Please enter a number');
    expect(row('notes').extras['constraint']).toBe('string-length(.) <= 100');
    expect(row('notes').extras['constraint_message::en']).toBe('Must be at most 100 characters');
  });
});
