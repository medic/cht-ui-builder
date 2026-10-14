/**
 * T9f (#19) — the sentence-shaped logic editor.
 *
 * Acceptance under test:
 *   1. cold start: an author adds "show this when Chair rise includes Pass"
 *      by picking only, reads it back in plain English, and never sees
 *      XPath unless they ask for it ("code"); the collapsed row summarises
 *      the logic in words; the cell on disk is the builder's usual output;
 *   3. relevants written by hand as `../field` reopen as sentences and are
 *      re-emitted byte-identical with zero edits; a rule the editor cannot
 *      show as a sentence opens with its XPath visible, so the author
 *      always has something to edit.
 *
 * Runs on a throwaway copy of `fixtures/mini-config`; bytes are asserted
 * through the API (what the server re-parsed from disk after the save).
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
type FormBody = { form: { survey: SurveyRow[] }; properties?: unknown };
type Request = Parameters<Parameters<typeof test>[1]>[0]['request'];

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

function strip(row: Locator, column: 'relevant' | 'choice_filter'): Locator {
  return row.locator(`.cond-strip-unified[data-column="${column}"]`);
}

function rawColumnInput(row: Locator, column: string): Locator {
  return row
    .locator('label.expr-field')
    .filter({ has: row.page().locator('code.raw-col-tag', { hasText: new RegExp(`^${column}$`) }) })
    .locator('input')
    .first();
}

async function getForm(request: Request): Promise<FormBody> {
  return (await (await request.get(`${API}/api/forms/app:pregnancy`)).json()) as FormBody;
}

async function seedCells(request: Request, seed: Record<string, Record<string, string>>): Promise<void> {
  const body = await getForm(request);
  for (const row of body.form.survey) {
    const s = row.name ? seed[row.name] : undefined;
    if (s) row.extras = { ...row.extras, ...s };
  }
  expect(
    (
      await request.put(`${API}/api/forms/app:pregnancy`, {
        data: { form: body.form, properties: body.properties ?? null },
      })
    ).ok(),
  ).toBeTruthy();
}

async function withScratchProject(request: Request, body: () => Promise<void>): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-t9f-'));
  try {
    await fs.cp(FIXTURE_DIR, tmp, { recursive: true });
    expect((await request.post(`${API}/api/project/open`, { data: { path: tmp } })).ok()).toBeTruthy();
    await body();
  } finally {
    await request.post(`${API}/api/project/open`, { data: { path: FIXTURE_DIR } });
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test('T9f — cold start: a rule is picked, read back in English, and the XPath stays behind "code"', async ({
  page,
  request,
}) => {
  await withScratchProject(request, async () => {
    await openPregnancy(page);
    const gravidity = rowByType(page, /^integer$/);
    await gravidity.getByRole('button', { name: /show advanced/ }).click();

    // The panel is grouped and the logic column reads as a sentence.
    await expect(gravidity.locator('h4.advanced-section')).toHaveText(['Logic', 'Display', 'Messages', 'Raw']);
    const s = strip(gravidity, 'relevant');
    await expect(s.locator('.cond-lead')).toContainText('Show this question when');
    // No XPath box on screen before the author asks for it.
    await expect(rawColumnInput(gravidity, 'relevant')).toBeHidden();
    await expect(s.getByRole('button', { name: 'code', exact: true })).toHaveAttribute('aria-pressed', 'false');

    // Picked, never typed.
    await s.locator('.ref-chip-select').nth(0).selectOption('chair_rise');
    await s.locator('.ref-chip-select').nth(1).selectOption('selected');
    await s.locator('select[title="Pick a value from this field\'s choices"]').selectOption('pass');
    await s.getByRole('button', { name: 'Apply', exact: true }).click();

    // Plain-English readback from the first clause, using labels.
    await expect(s.getByText('This row shows when:')).toBeVisible();
    await expect(s.locator('.cond-preview').first()).toHaveText('Chair rise test includes Pass');
    await expect(rawColumnInput(gravidity, 'relevant')).toBeHidden();

    // "code" reveals the XPath; "hide code" puts it away again.
    await s.getByRole('button', { name: 'code', exact: true }).click();
    await expect(rawColumnInput(gravidity, 'relevant')).toBeVisible();
    await expect(rawColumnInput(gravidity, 'relevant')).toHaveValue("selected(${chair_rise}, 'pass')");
    await s.getByRole('button', { name: 'hide code', exact: true }).click();
    await expect(rawColumnInput(gravidity, 'relevant')).toBeHidden();

    // A Number question does not show "Compute the value as…" uninvited.
    await expect(gravidity.getByRole('button', { name: '+ compute this value…' })).toBeVisible();
    await expect(rawColumnInput(gravidity, 'calculation')).toHaveCount(0);

    // Collapsed, the row summarises the logic in words, not XPath.
    await gravidity.getByRole('button', { name: /hide advanced/ }).click();
    await expect(gravidity).toContainText('shows when Chair rise test includes Pass');
    await expect(gravidity).not.toContainText('${chair_rise}');

    await saveForm(page);
    const after = await getForm(request);
    expect(after.form.survey.find((r) => r.name === 'gravidity')?.extras['relevant']).toBe(
      "selected(${chair_rise}, 'pass')",
    );
  });
});

test('T9f — `../field` relevants reopen as sentences and re-emit byte-identical; an unshowable rule opens with its XPath', async ({
  page,
  request,
}) => {
  await withScratchProject(request, async () => {
    // Mixed and/or without parentheses: outside the builder's grammar.
    const MIXED = "${lmp_date} != '' or ${gravidity} > 1 and ${patient_sex} = 'f'";
    await seedCells(request, {
      lmp_note: { relevant: "../lmp_date != ''" },
      lmp_date: { relevant: "selected(../danger_signs, 'none')" },
      chair_rise: { relevant: MIXED },
    });
    await openPregnancy(page);

    // (3) ../ spelling reads as the same sentence as ${}.
    const note = rowByType(page, /^note$/);
    await note.getByRole('button', { name: /show advanced/ }).click();
    const ns = strip(note, 'relevant');
    await expect(ns.getByText(/This rule was hand-written/)).toHaveCount(0);
    await expect(ns.locator('.cond-preview').first()).toHaveText('Last menstrual period has an answer');
    await expect(rawColumnInput(note, 'relevant')).toBeHidden();
    await ns.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(rawColumnInput(note, 'relevant')).toHaveValue("../lmp_date != ''");

    const lmp = rowByType(page, /^date$/);
    await lmp.getByRole('button', { name: /show advanced/ }).click();
    const ls = strip(lmp, 'relevant');
    await expect(ls.locator('.cond-preview').first()).toHaveText('Danger signs includes none');
    await ls.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(rawColumnInput(lmp, 'relevant')).toHaveValue("selected(../danger_signs, 'none')");

    // A rule the sentence editor cannot show opens with the XPath visible —
    // the author is never left with nothing to edit.
    const chair = rowByType(page, /^select_one pass_fail$/);
    await chair.getByRole('button', { name: /show advanced/ }).click();
    const cs = strip(chair, 'relevant');
    await expect(cs.getByText(/This rule was hand-written/)).toBeVisible();
    await expect(rawColumnInput(chair, 'relevant')).toBeVisible();
    await expect(rawColumnInput(chair, 'relevant')).toHaveValue(MIXED);
    await expect(cs.getByRole('button', { name: 'hide code', exact: true })).toBeVisible();
    // The collapsed summary says so in words.
    await chair.getByRole('button', { name: /hide advanced/ }).click();
    await expect(chair).toContainText('shows when (hand-written rule)');

    // Dirty the form elsewhere, save: every seeded cell is byte-identical.
    const gravidity = rowByType(page, /^integer$/);
    await gravidity.getByPlaceholder('label in en').fill('Number of pregnancies (t9f)');
    await saveForm(page);
    const after = await getForm(request);
    const cell = (name: string) => after.form.survey.find((r) => r.name === name)?.extras['relevant'];
    expect(cell('lmp_note')).toBe("../lmp_date != ''");
    expect(cell('lmp_date')).toBe("selected(../danger_signs, 'none')");
    expect(cell('chair_rise')).toBe(MIXED);
  });
});
