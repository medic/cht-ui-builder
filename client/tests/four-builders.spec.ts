/**
 * T9g (#20) — June acceptance 3: ONE automated test drives all four builders
 * (relevant, constraint, choice_filter, calculation) and asserts the
 * emitted cells on disk.
 *
 *   relevant       the inline strip (condition builder)      → `selected(${chair_rise}, 'pass')`
 *   choice_filter  the same strip on the choice_filter column → `${chair_rise} = 'pass'`
 *   constraint     the Validation panel (9e)                 → `. >= 0 and . <= 20` + message
 *   calculation    the calculation builder (single value)    → `${gravidity} + 1`
 *
 * Every cell is read back through the API after a UI save, i.e. what the
 * server re-parsed from the sheet on disk. Runs on a throwaway copy of the
 * mini-config fixture.
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

type SurveyRow = { name?: string; type: string; extras: Record<string, string> };
type FormBody = { form: { survey: SurveyRow[] } };

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

async function showAdvanced(row: Locator): Promise<void> {
  const btn = row.getByRole('button', { name: /show advanced/ });
  if ((await btn.count()) > 0) await btn.click();
}

function rawColumnInput(row: Locator, column: string): Locator {
  return row
    .locator('label.expr-field')
    .filter({ has: row.page().locator('code.raw-col-tag', { hasText: new RegExp(`^${column}$`) }) })
    .locator('input')
    .first();
}

test('T9g — all four builders in one journey; every emitted cell asserted on disk', async ({
  page,
  request,
}) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-t9g-'));
  try {
    await fs.cp(FIXTURE_DIR, tmp, { recursive: true });
    expect((await request.post(`${API}/api/project/open`, { data: { path: tmp } })).ok()).toBeTruthy();

    await page.goto('/');
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    // 1. relevant — the inline strip: gravidity shows when chair_rise includes pass.
    const gravidity = rowByType(page, /^integer$/);
    await showAdvanced(gravidity);
    const strip = gravidity.locator('.cond-strip-unified[data-column="relevant"]');
    const dd = strip.locator('.ref-chip-select');
    await dd.nth(0).selectOption('chair_rise');
    await dd.nth(1).selectOption('selected');
    await strip.locator('select[title="Pick a value from this field\'s choices"]').selectOption('pass');
    await strip.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(rawColumnInput(gravidity, 'relevant')).toHaveValue("selected(${chair_rise}, 'pass')");

    // 2. constraint — the Validation panel: Between 0 and 20 with a message.
    const panel = gravidity.getByTestId('validation-panel');
    await panel.getByRole('combobox', { name: 'Add a validation rule' }).selectOption({ label: 'Between two values' });
    await panel.getByRole('spinbutton', { name: 'Minimum' }).fill('0');
    await panel.getByRole('spinbutton', { name: 'Maximum' }).fill('20');
    await expect(panel.getByPlaceholder('Message shown when the answer is rejected')).toHaveValue('Must be between 0 and 20');

    // 3. choice_filter — the strip on the select_one chair_rise: filter its
    //    choices when danger_signs includes vaginal_bleeding (an EARLIER
    //    field — the picker never offers a later one).
    const chair = rowByType(page, /^select_one pass_fail$/);
    await showAdvanced(chair);
    const cStrip = chair.locator('.cond-strip-unified[data-column="choice_filter"]');
    const ddd = cStrip.locator('.ref-chip-select');
    await ddd.nth(0).selectOption('danger_signs');
    await ddd.nth(1).selectOption('selected');
    await cStrip.locator('select[title="Pick a value from this field\'s choices"]').selectOption('vaginal_bleeding');
    await cStrip.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(rawColumnInput(chair, 'choice_filter')).toHaveValue("selected(${danger_signs}, 'vaginal_bleeding')");

    // 4. calculation — the calculation builder on a fresh calculate row.
    await page.getByRole('button', { name: '+ Question', exact: true }).click();
    const picker = page.locator('.qtype-modal');
    await picker.getByPlaceholder(/has_fever/).fill('gravidity_next');
    await picker
      .locator('.qtype-tile')
      .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Calculate$/ }) })
      .click();
    await expect(picker).not.toBeVisible();
    const calcRow = await rowByName(page, 'gravidity_next');
    await showAdvanced(calcRow);
    const calcField = calcRow
      .locator('label.expr-field')
      .filter({ has: page.locator('code.raw-col-tag', { hasText: /^calculation$/ }) });
    await calcField.locator('button', { hasText: '✎ build' }).click();
    const calcModal = page.getByRole('dialog', { name: 'Calculation builder' });
    await expect(calcModal).toBeVisible();
    await calcModal.getByRole('tab', { name: 'Raw', exact: true }).click();
    await calcModal.locator('textarea').fill('${gravidity} + 1');
    await calcModal.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(rawColumnInput(calcRow, 'calculation')).toHaveValue('${gravidity} + 1');

    // Save and read every cell back from disk.
    await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
    ).toBeVisible();
    const after = (await (await request.get(`${API}/api/forms/app:pregnancy`)).json()) as FormBody;
    const row = (name: string) => after.form.survey.find((r) => r.name === name)!;
    expect(row('gravidity').extras['relevant']).toBe("selected(${chair_rise}, 'pass')");
    expect(row('gravidity').extras['constraint']).toBe('. >= 0 and . <= 20');
    expect(row('gravidity').extras['constraint_message::en']).toBe('Must be between 0 and 20');
    expect(row('chair_rise').extras['choice_filter']).toBe("selected(${danger_signs}, 'vaginal_bleeding')");
    expect(row('gravidity_next').type).toBe('calculate');
    expect(row('gravidity_next').extras['calculation']).toBe('${gravidity} + 1');
  } finally {
    await request.post(`${API}/api/project/open`, { data: { path: FIXTURE_DIR } });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
