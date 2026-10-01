/**
 * T9a (#14) — rules about the answer itself (`.`) and relative-path
 * relevants (`../field`) through the running app.
 *
 * Shared-only slice, so the UI assertion is deliberately narrow:
 *   1. open-and-save with zero edits to these cells leaves every one of
 *      them byte-identical on disk, including the tight-spaced `.<=100`
 *      that now parses structurally (the no-normalise invariant);
 *   2. the "✎ build" modal opens a `.` constraint in Visual mode as rows,
 *      not as the "couldn't be parsed" raw warning;
 *   3. a `../field` relevant opens in the inline strip as a clause.
 *
 * The cells are seeded through the API on a throwaway copy of the fixture.
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

type SurveyRow = { name?: string; type: string; labels?: unknown; extras: Record<string, string> };
type FormBody = { form: { survey: SurveyRow[] }; properties?: unknown };

const SEED: Record<string, Record<string, string>> = {
  gravidity: { constraint: '. >= 0 and . <= 20', 'constraint_message::en': 'Must be 0 to 20' },
  chair_rise: { constraint: '.<=100' },
  danger_signs: { constraint: "not(selected(., 'none') and count-selected(.) > 1)" },
  lmp_note: { relevant: "../lmp_date != ''" },
  lmp_date: { constraint: '. <= today()', relevant: "selected(../danger_signs, 'none')" },
};

function rowByType(page: Page, rawType: RegExp): Locator {
  return page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: rawType }) });
}

async function getForm(request: Parameters<Parameters<typeof test>[1]>[0]['request']): Promise<FormBody> {
  return (await (await request.get(`${API}/api/forms/app:pregnancy`)).json()) as FormBody;
}

test('T9a — `.` constraints and `../field` relevants survive open-and-save byte-identical and open structurally', async ({
  page,
  request,
}) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-t9a-'));
  try {
    await fs.cp(FIXTURE_DIR, tmp, { recursive: true });
    expect((await request.post(`${API}/api/project/open`, { data: { path: tmp } })).ok()).toBeTruthy();

    // Seed the cells through the API.
    const body = await getForm(request);
    for (const row of body.form.survey) {
      const seed = row.name ? SEED[row.name] : undefined;
      if (seed) row.extras = { ...row.extras, ...seed };
    }
    const put = await request.put(`${API}/api/forms/app:pregnancy`, {
      data: { form: body.form, properties: body.properties ?? null },
    });
    expect(put.ok()).toBeTruthy();
    const seeded = await getForm(request);
    for (const [name, cells] of Object.entries(SEED)) {
      const row = seeded.form.survey.find((r) => r.name === name);
      for (const [col, val] of Object.entries(cells)) {
        expect(row?.extras[col], `${name}.${col} seeded`).toBe(val);
      }
    }

    // Open the form in the UI.
    await page.goto('/');
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    // (2) The `.` constraint opens structured: since 9e the Validation panel
    // shows `. >= 0 and . <= 20` as "Between 0 and 20", and `.<=100` (tight)
    // as a single bound — neither as plain text.
    const gravidity = rowByType(page, /^integer$/);
    await gravidity.getByRole('button', { name: /show advanced/ }).click();
    const gravPanel = gravidity.getByTestId('validation-panel');
    await expect(gravPanel.getByRole('spinbutton', { name: 'Minimum' })).toHaveValue('0');
    await expect(gravPanel.getByRole('spinbutton', { name: 'Maximum' })).toHaveValue('20');
    await expect(gravPanel.getByRole('textbox', { name: 'Expression' })).toHaveCount(0);
    const chair = rowByType(page, /^select_one pass_fail$/);
    await chair.getByRole('button', { name: /show advanced/ }).click();
    const chairPanel = chair.getByTestId('validation-panel');
    await expect(chairPanel.getByRole('combobox', { name: 'Comparison' })).toHaveValue('<=');
    await expect(chairPanel.getByRole('textbox', { name: 'Value' })).toHaveValue('100');

    // (3) A `../field` relevant opens in the inline strip as a clause.
    const lmpNote = rowByType(page, /^note$/);
    await lmpNote.getByRole('button', { name: /show advanced/ }).click();
    const strip = lmpNote.locator('.cond-strip-unified');
    await strip.locator('.ref-chip-select').nth(0).selectOption('relevant');
    // A committed clause shows as the `↶ undo last clause` control plus an
    // enabled `+ insert`; a hand-written rule shows the status line and
    // disables both.
    await expect(strip.getByText(/This rule was hand-written/)).toHaveCount(0);
    await expect(strip.getByRole('button', { name: '↶ undo last clause' })).toBeVisible();
    await expect(strip.getByRole('button', { name: '+ insert' })).toBeEnabled();
    // Re-inserting with zero edits writes the ../ spelling back, not ${}.
    await strip.getByRole('button', { name: '+ insert' }).click();
    const relevantField = lmpNote
      .locator('label.expr-field')
      .filter({ has: page.locator('code.raw-col-tag', { hasText: /^relevant$/ }) });
    await expect(relevantField.locator('input').first()).toHaveValue("../lmp_date != ''");

    // (1) Dirty the form somewhere unrelated so Save is reachable, save, and
    // every seeded cell must still be byte-identical.
    await page.getByRole('button', { name: '+ Question' }).click();
    const picker = page.locator('.qtype-modal');
    await picker
      .locator('input[placeholder*="has_fever"], input[placeholder*="patient_age"]')
      .first()
      .fill('t9a_marker');
    await picker
      .locator('.qtype-tile')
      .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Group$/ }) })
      .click();
    await expect(picker).not.toBeVisible();
    await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
    ).toBeVisible();

    const after = await getForm(request);
    expect(after.form.survey.some((r) => r.name === 't9a_marker')).toBeTruthy();
    for (const [name, cells] of Object.entries(SEED)) {
      const row = after.form.survey.find((r) => r.name === name);
      for (const [col, val] of Object.entries(cells)) {
        expect(row?.extras[col], `${name}.${col} byte-identical after save`).toBe(val);
      }
    }
  } finally {
    await request.post(`${API}/api/project/open`, { data: { path: FIXTURE_DIR } });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
