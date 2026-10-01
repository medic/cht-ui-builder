/**
 * T9b (#15) — rules the inline builder writes for "has an answer" (`${f}`)
 * and "is not selected" (`not(${f})`) must reopen in the inline builder,
 * and `${f} != ''` (already in the fixture as `lmp_note`'s relevant) must
 * open as a clause and save back byte-identical.
 *
 * "Reopens as a clause" is observable in the strip as: no "hand-written"
 * status, the `↶ undo last clause` control present (it only renders when a
 * clause is committed), and `+ insert` enabled. A hand-written rule shows
 * the status line and disables both.
 *
 * Runs on a throwaway copy of `fixtures/mini-config` so the committed
 * fixture never changes. Bytes are asserted through the API (`GET
 * /api/forms/app:pregnancy`), i.e. what the server re-parsed from the
 * sheet on disk after the UI saved it.
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

type SurveyRow = { name?: string; type: string; extras?: Record<string, string> };

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

async function saveForm(page: Page): Promise<void> {
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible();
}

/** Open the row's advanced panel and point the unified strip at `column`. */
async function openStrip(row: Locator, column: 'relevant' | 'constraint'): Promise<Locator> {
  await row.getByRole('button', { name: /show advanced/ }).click();
  const strip = row.locator('.cond-strip-unified');
  await expect(strip).toBeVisible();
  await strip.locator('.ref-chip-select').nth(0).selectOption(column);
  return strip;
}

/** The raw column textbox for `column` inside the row's advanced panel. */
function rawColumnInput(row: Locator, column: string): Locator {
  return row
    .locator('label.expr-field')
    .filter({ has: row.page().locator('code.raw-col-tag', { hasText: new RegExp(`^${column}$`) }) })
    .locator('input')
    .first();
}

async function expectOpenAsClause(strip: Locator): Promise<void> {
  await expect(strip.getByText(/This rule was hand-written/)).toHaveCount(0);
  await expect(strip.getByRole('button', { name: '↶ undo last clause' })).toBeVisible();
  await expect(strip.getByRole('button', { name: '+ insert' })).toBeEnabled();
  await expect(strip.locator('.ref-chip-select').nth(1)).toBeEnabled();
}

test('T9b — "has an answer" and "is not selected" written by the strip reopen as clauses with controls enabled', async ({
  page,
  request,
}) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-t9b-'));
  try {
    await fs.cp(FIXTURE_DIR, tmp, { recursive: true });
    expect((await request.post(`${API}/api/project/open`, { data: { path: tmp } })).ok()).toBeTruthy();
    await openPregnancy(page);

    // gravidity (integer): relevant = "lmp_date has an answer" → `${lmp_date}`.
    const gravidity = rowByType(page, /^integer$/);
    let strip = await openStrip(gravidity, 'relevant');
    await strip.locator('.ref-chip-select').nth(1).selectOption('lmp_date');
    await strip.locator('.ref-chip-select').nth(2).selectOption('ref');
    await strip.getByRole('button', { name: '+ insert' }).click();
    await expect(rawColumnInput(gravidity, 'relevant')).toHaveValue('${lmp_date}');
    // The strip re-hydrates from what it just wrote: a clause, not hand-written text.
    await expectOpenAsClause(strip);

    // chair_rise (select_one): relevant = "danger_signs is not selected" → `not(${danger_signs})`.
    const chairRise = rowByType(page, /^select_one pass_fail$/);
    strip = await openStrip(chairRise, 'relevant');
    await strip.locator('.ref-chip-select').nth(1).selectOption('danger_signs');
    await strip.locator('.ref-chip-select').nth(2).selectOption('not');
    await strip.getByRole('button', { name: '+ insert' }).click();
    await expect(rawColumnInput(chairRise, 'relevant')).toHaveValue('not(${danger_signs})');
    await expectOpenAsClause(strip);

    await saveForm(page);

    // Bytes on disk are exactly what the builder has always written.
    const saved = (await (await request.get(`${API}/api/forms/app:pregnancy`)).json()) as {
      form: { survey: SurveyRow[] };
    };
    const byName = new Map(saved.form.survey.map((r) => [r.name, r]));
    expect(byName.get('gravidity')?.extras?.relevant).toBe('${lmp_date}');
    expect(byName.get('chair_rise')?.extras?.relevant).toBe('not(${danger_signs})');

    // Cold reopen after a reload: both rows come back as clauses, not text.
    await openPregnancy(page);
    strip = await openStrip(rowByType(page, /^integer$/), 'relevant');
    await expectOpenAsClause(strip);
    strip = await openStrip(rowByType(page, /^select_one pass_fail$/), 'relevant');
    await expectOpenAsClause(strip);
  } finally {
    await request.post(`${API}/api/project/open`, { data: { path: FIXTURE_DIR } });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("T9b — an existing `${f} != ''` relevant opens as a clause and saves back byte-identical", async ({
  page,
  request,
}) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-t9b-'));
  try {
    await fs.cp(FIXTURE_DIR, tmp, { recursive: true });
    expect((await request.post(`${API}/api/project/open`, { data: { path: tmp } })).ok()).toBeTruthy();

    const before = (await (await request.get(`${API}/api/forms/app:pregnancy`)).json()) as {
      form: { survey: SurveyRow[] };
    };
    expect(before.form.survey.find((r) => r.name === 'lmp_note')?.extras?.relevant).toBe(
      "${lmp_date} != ''",
    );

    await openPregnancy(page);
    const lmpNote = rowByType(page, /^note$/);
    const strip = await openStrip(lmpNote, 'relevant');
    await expectOpenAsClause(strip);

    // Re-insert with zero edits: the clause is written back as it was
    // spelled, never normalised to `${lmp_date}`.
    await strip.getByRole('button', { name: '+ insert' }).click();
    await expect(rawColumnInput(lmpNote, 'relevant')).toHaveValue("${lmp_date} != ''");

    // Dirty the form elsewhere so Save is reachable, then save.
    const gravidity = rowByType(page, /^integer$/);
    const gStrip = await openStrip(gravidity, 'relevant');
    await gStrip.locator('.ref-chip-select').nth(1).selectOption('lmp_date');
    await gStrip.locator('.ref-chip-select').nth(2).selectOption('ref');
    await gStrip.getByRole('button', { name: '+ insert' }).click();
    await saveForm(page);

    const after = (await (await request.get(`${API}/api/forms/app:pregnancy`)).json()) as {
      form: { survey: SurveyRow[] };
    };
    expect(after.form.survey.find((r) => r.name === 'lmp_note')?.extras?.relevant).toBe(
      "${lmp_date} != ''",
    );
    expect(after.form.survey.find((r) => r.name === 'gravidity')?.extras?.relevant).toBe(
      '${lmp_date}',
    );
  } finally {
    await request.post(`${API}/api/project/open`, { data: { path: FIXTURE_DIR } });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
