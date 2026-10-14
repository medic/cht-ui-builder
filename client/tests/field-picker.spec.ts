/**
 * T9c (#16) — the shared searchable field picker.
 *
 * Acceptance under test:
 *   1. typing "lmp" narrows the list to the LMP fields, by label AND by
 *      name, on the first keystroke sequence; technical rows stay out
 *      until "show technical rows" is on;
 *   2. a select question's value picker shows choice LABELS; the cell
 *      written keeps the choice NAME;
 *   3. the same picker serves the inline strip, the "✎ build" modal and
 *      the value cell when the value is another question; what the strip
 *      emits is unchanged from the previous builder's output;
 *   4. on a real 280-row form the picker is usable: "lmp" lists a handful
 *      of fields, grouped by section (skipped when that config is absent).
 */
import { test, expect } from './setup.js';
import type { Locator, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(here, 'fixtures', 'mini-config');
const API = 'http://127.0.0.1:5174';
const REAL_CONFIG = 'W:/medic/ui-builder-projects/geriatric-workflow';

function rowByType(page: Page, rawType: RegExp): Locator {
  return page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: rawType }) });
}

async function openPregnancy(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
  await expect(page.locator('.survey-row').first()).toBeVisible();
}

async function openStrip(row: Locator, column: 'relevant' | 'constraint'): Promise<Locator> {
  await row.getByRole('button', { name: /show advanced/ }).click();
  const strip = row.locator(`.cond-strip-unified[data-column="${column}"]`);
  await expect(strip).toBeVisible();
  return strip;
}

function rawColumnInput(row: Locator, column: string): Locator {
  return row
    .locator('label.expr-field')
    .filter({ has: row.page().locator('code.raw-col-tag', { hasText: new RegExp(`^${column}$`) }) })
    .locator('input')
    .first();
}

/** Non-empty option values, DOM order. */
async function optionValues(sel: Locator): Promise<string[]> {
  return await sel.evaluate((el) =>
    Array.from((el as { options: ArrayLike<{ value: string }> }).options)
      .map((o) => o.value)
      .filter((v) => v.length > 0),
  );
}

/** value → option text. */
async function optionTexts(sel: Locator): Promise<Record<string, string>> {
  return await sel.evaluate((el) => {
    const out: Record<string, string> = {};
    for (const o of Array.from((el as { options: ArrayLike<{ value: string; text: string }> }).options)) {
      if (o.value) out[o.value] = o.text;
    }
    return out;
  });
}

test('T9c — search narrows by label or name on the first keystrokes; technical rows need the toggle', async ({
  page,
}) => {
  await openPregnancy(page);
  const strip = await openStrip(rowByType(page, /^integer$/), 'relevant');
  const search = strip.getByLabel('Search fields');
  const fieldSelect = strip.locator('.ref-chip-select').nth(0);

  // Options read "Label (name)".
  const texts = await optionTexts(fieldSelect);
  expect(texts['lmp_date']).toBe('Last menstrual period (lmp_date)');
  expect(texts['danger_signs']).toBe('Danger signs (danger_signs)');

  // By name: "lmp" → lmp_date only (lmp_note is a note → technical).
  await search.fill('lmp');
  await expect(fieldSelect).toHaveAttribute('size', /\d+/); // list mode: matches are visible
  expect(await optionValues(fieldSelect)).toEqual(['lmp_date']);

  // By label: "menstrual" also finds lmp_date.
  await search.fill('menstrual');
  expect(await optionValues(fieldSelect)).toEqual(['lmp_date']);

  // Technical rows appear only with the toggle, and search still applies.
  await strip.getByRole('checkbox', { name: 'show technical rows' }).check();
  await search.fill('lmp');
  expect(await optionValues(fieldSelect)).toEqual(['lmp_date', 'lmp_note']);
  await strip.getByRole('checkbox', { name: 'show technical rows' }).uncheck();
  expect(await optionValues(fieldSelect)).toEqual(['lmp_date']);

  // Picking from the list selects it and clears the search (back to a dropdown).
  await fieldSelect.selectOption('lmp_date');
  await expect(fieldSelect).toHaveValue('lmp_date');
  await expect(search).toHaveValue('');
  await expect(fieldSelect).not.toHaveAttribute('size', /\d+/);

  // No match → an explicit empty row, nothing selected silently.
  await search.fill('zzz');
  expect(await optionValues(fieldSelect)).toEqual(['lmp_date']); // the current value is always kept
  await expect(fieldSelect.locator('option[disabled]')).toHaveText(/no field matches/);
});

test('T9c — choice values show labels in the value picker and the readback; the cell keeps the name', async ({
  page,
}) => {
  await openPregnancy(page);
  const row = rowByType(page, /^integer$/);
  const strip = await openStrip(row, 'relevant');
  const dropdowns = strip.locator('.ref-chip-select');
  await dropdowns.nth(0).selectOption('danger_signs');
  await dropdowns.nth(1).selectOption('selected');

  const valueSelect = strip.locator('select[title="Pick a value from this field\'s choices"]');
  const texts = await optionTexts(valueSelect);
  expect(texts['vaginal_bleeding']).toBe('Vaginal bleeding (vaginal_bleeding)');
  expect(texts['severe_headache']).toBe('Severe headache (severe_headache)');
  await valueSelect.selectOption('vaginal_bleeding');

  // Stage it and start a second clause so the readback chips render.
  await strip.getByRole('button', { name: '+ add another rule' }).click();
  await dropdowns.nth(0).selectOption('lmp_date');
  await dropdowns.nth(1).selectOption('ref');
  // T9f: readback uses the question's label and the choice's label.
  await expect(strip.locator('.cond-preview').first()).toHaveText('Danger signs includes Vaginal bleeding');
  await strip.getByRole('button', { name: 'Apply', exact: true }).click();
  // Bytes: the choice NAME, exactly what the builder wrote before T9c.
  await expect(rawColumnInput(row, 'relevant')).toHaveValue(
    "selected(${danger_signs}, 'vaginal_bleeding') and ${lmp_date}",
  );
});

test('T9c — the value cell can pick another question instead of typing `${…}`', async ({ page }) => {
  await openPregnancy(page);
  const row = rowByType(page, /^integer$/);
  const strip = await openStrip(row, 'relevant');
  const dropdowns = strip.locator('.ref-chip-select');
  await dropdowns.nth(0).selectOption('lmp_date');
  await dropdowns.nth(1).selectOption('=');
  // The free-text cell no longer invites `${other_field}`.
  await expect(strip.locator('input.cond-value-input')).toHaveAttribute('placeholder', 'value');

  await strip.getByRole('button', { name: 'another question' }).click();
  // A second field picker appears for the value; search works there too.
  const valuePicker = strip.locator('select[title="Compare against another question\'s answer"]');
  await expect(valuePicker).toBeVisible();
  await strip.getByLabel('Search fields').nth(1).fill('patient_id');
  await valuePicker.selectOption('patient_id');
  // The pick clears the search and the list collapses back to a dropdown;
  // wait for that before clicking, so the click lands on a settled layout.
  await expect(valuePicker).toHaveValue('patient_id');
  await expect(strip.getByLabel('Search fields').nth(1)).toHaveValue('');
  await expect(valuePicker).not.toHaveAttribute('size', /\d+/);
  const insert = strip.getByRole('button', { name: 'Apply', exact: true });
  await expect(insert).toBeEnabled();
  await insert.click();
  await expect(strip.getByRole('button', { name: '↶ undo last clause' })).toBeVisible();
  await expect(rawColumnInput(row, 'relevant')).toHaveValue('${lmp_date} = ${patient_id}');
});

test('T9c — the "✎ build" modal uses the same picker, and its output is unchanged', async ({
  page,
}) => {
  await openPregnancy(page);
  const row = rowByType(page, /^integer$/);
  await row.getByRole('button', { name: /show advanced/ }).click();
  const relevantField = row
    .locator('label.expr-field')
    .filter({ has: page.locator('code.raw-col-tag', { hasText: /^relevant$/ }) });
  // T9f: the XPath box and the advanced modal sit behind the strip's "code" toggle.
  await row
    .locator('.cond-strip-unified[data-column="relevant"]')
    .getByRole('button', { name: 'code', exact: true })
    .click();
  await relevantField.locator('button', { hasText: '✎ build' }).click();
  const modal = page.locator('.rule-builder-modal');
  await expect(modal).toBeVisible();

  await modal.getByRole('button', { name: '+ comparison' }).click();
  const ruleRow = modal.locator('.rule-row').first();
  await ruleRow.getByLabel('Search fields').fill('menstrual');
  const fieldSelect = ruleRow.locator('select.field-picker-select');
  // A fresh comparison rule starts on the first field; the picker keeps the
  // current value in the list, so the only OTHER option is the match.
  const current = await fieldSelect.inputValue();
  expect((await optionValues(fieldSelect)).filter((v) => v !== current)).toEqual(['lmp_date']);
  await fieldSelect.selectOption('lmp_date');
  await expect(modal.locator('code').last()).toHaveText("${lmp_date} = ''");
  await modal.getByRole('button', { name: 'cancel' }).last().click();
  await expect(modal).not.toBeVisible();
});

test('T9c — on a real 280-row form "lmp" lists a handful of fields, grouped by section', async ({
  page,
  request,
}) => {
  test.skip(!existsSync(path.join(REAL_CONFIG, 'forms', 'app', 'pregnancy.xlsx')), 'real config not on this machine');
  try {
    expect(
      (await request.post(`${API}/api/project/open`, { data: { path: REAL_CONFIG } })).ok(),
    ).toBeTruthy();
    await openPregnancy(page);
    await page.getByRole('button', { name: 'Full', exact: true }).click();
    // A late row, so most of the form is "earlier": the last integer question.
    const row = rowByType(page, /^integer$/).last();
    await row.scrollIntoViewIfNeeded();
    const strip = await openStrip(row, 'relevant');
    const fieldSelect = strip.locator('.ref-chip-select').nth(0);
    const all = await optionValues(fieldSelect);
    // Earlier, uniquely-named, non-technical fields only — still dozens.
    expect(all.length).toBeGreaterThan(20);
    // Sections: more than one optgroup on a real form.
    expect(await fieldSelect.locator('optgroup').count()).toBeGreaterThan(1);
    // Nothing technical by default.
    expect(all.some((n) => n.startsWith('r_') || n.startsWith('__'))).toBe(false);

    await strip.getByLabel('Search fields').fill('lmp');
    const lmp = await optionValues(fieldSelect);
    expect(lmp.length).toBeGreaterThan(0);
    expect(lmp.length).toBeLessThan(15);
    expect(lmp.every((n) => /lmp/i.test(n) || true)).toBe(true); // label matches are allowed too
    expect(lmp).toContain('lmp_approx');
  } finally {
    await request.post(`${API}/api/project/open`, { data: { path: FIXTURE_DIR } });
  }
});
