/**
 * T9d (#17) — the add-question configure step, insert-after-current-row,
 * and scroll + highlight of the new row.
 *
 * Acceptance under test:
 *   1. add **age** (integer) with required and a hint set in the configure
 *      step; the new row appears directly after the row the author was
 *      on, scrolled into view and highlighted;
 *   2. the sheet on disk has the row in that position with `required` and
 *      `hint::<lang>` set (and the Validation slot's constraint + message);
 *      every other row is byte-identical;
 *   3. adding inside a group keeps `begin group` / `end group` paired;
 *   4. the step is skippable: "add without details" for one question, and
 *      the remembered "always skip this step" preference for one-click
 *      tiles (which is what the rest of the suite runs with).
 *
 * The suite's fixture seeds the one-click preference ON; this spec clears
 * it so the step itself is exercised.
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

type SurveyRow = {
  name?: string;
  type: string;
  required?: string;
  labels?: Record<string, string>;
  extras: Record<string, string>;
};
type FormBody = { form: { survey: SurveyRow[] } };

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

/** The row card whose name textbox reads `name` (React-controlled inputs carry no value attribute). */
async function rowByName(page: Page, name: string): Promise<Locator> {
  const rows = page.locator('.survey-row').filter({
    has: page.getByRole('textbox', { name: 'name', exact: true }),
  });
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    if ((await row.getByRole('textbox', { name: 'name', exact: true }).inputValue()) === name) {
      return row;
    }
  }
  throw new Error(`no row named ${name}`);
}

/** Names of the rendered row cards, in DOM order. */
async function renderedNames(page: Page): Promise<string[]> {
  const inputs = page.locator('.survey-row').getByRole('textbox', { name: 'name', exact: true });
  const n = await inputs.count();
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await inputs.nth(i).inputValue());
  return out;
}

async function withScratchProject(
  request: Parameters<Parameters<typeof test>[1]>[0]['request'],
  body: (tmp: string) => Promise<void>,
): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-t9d-'));
  try {
    await fs.cp(FIXTURE_DIR, tmp, { recursive: true });
    expect((await request.post(`${API}/api/project/open`, { data: { path: tmp } })).ok()).toBeTruthy();
    await body(tmp);
  } finally {
    await request.post(`${API}/api/project/open`, { data: { path: FIXTURE_DIR } });
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test.describe('configure step on (the default for a new author)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        // eslint-disable-next-line no-undef
        window.localStorage.setItem('cht-ui-builder.oneClickTiles', 'false');
      } catch {
        /* storage unavailable */
      }
    });
  });

  test('T9d — age (integer) with required, hint and a rule lands right after the current row, scrolled and highlighted; bytes on disk', async ({
    page,
    request,
  }) => {
    await withScratchProject(request, async () => {
      const before = (await (await request.get(`${API}/api/forms/app:pregnancy`)).json()) as FormBody;

      await openPregnancy(page);
      // The author is on the LMP date row: focus a control inside its card.
      const lmp = rowByType(page, /^date$/);
      await lmp.getByRole('textbox', { name: 'name', exact: true }).click();

      await page.getByRole('button', { name: '+ Question', exact: true }).click();
      const picker = page.locator('.qtype-modal');
      await picker.getByPlaceholder(/has_fever/).fill('age');
      await picker.locator('.qtype-locale-label input').first().fill('Age');
      await picker
        .locator('.qtype-tile')
        .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Number$/ }) })
        .click();

      // The configure step, not an immediate commit.
      const configure = picker.locator('.qtype-configure');
      await expect(configure).toBeVisible();
      await configure.getByRole('checkbox', { name: /^Required/ }).check();
      // The fixture is bilingual (en, ne): one hint and one message per language.
      await configure.getByPlaceholder(/Help text/).first().fill('Years');
      // The Validation slot is the 9e panel: a preset, and a message per language.
      const panel = configure.getByTestId('validation-panel');
      await panel.getByRole('combobox', { name: 'Add a validation rule' }).selectOption({ label: 'Between two values' });
      await panel.getByRole('spinbutton', { name: 'Minimum' }).fill('0');
      await panel.getByRole('spinbutton', { name: 'Maximum' }).fill('20');
      await panel.getByPlaceholder('Message shown when the answer is rejected').fill('Must be 0 to 20');
      await configure.getByRole('button', { name: 'Add question', exact: true }).click();
      await expect(picker).not.toBeVisible();

      // Directly after lmp_date, highlighted, in view.
      const names = await renderedNames(page);
      expect(names[names.indexOf('lmp_date') + 1]).toBe('age');
      const flashed = page.locator('.survey-row.row-flash');
      await expect(flashed).toHaveCount(1);
      await expect(flashed.getByRole('textbox', { name: 'name', exact: true })).toHaveValue('age');
      await expect(flashed).toBeInViewport();

      await saveForm(page);
      const after = (await (await request.get(`${API}/api/forms/app:pregnancy`)).json()) as FormBody;
      const idx = after.form.survey.findIndex((r) => r.name === 'age');
      expect(after.form.survey[idx - 1]?.name).toBe('lmp_date');
      const age = after.form.survey[idx]!;
      expect(age.type).toBe('integer');
      expect(age.required).toBe('yes');
      expect(age.extras['hint::en']).toBe('Years');
      expect(age.extras['constraint']).toBe('. >= 0 and . <= 20');
      expect(age.extras['constraint_message::en']).toBe('Must be 0 to 20');
      expect(age.labels?.['en']).toBe('Age');
      // Every other row is unchanged (row ids are positional and shift by one
      // after the insert, so compare the cells, not the ids).
      const cells = (r: SurveyRow) => ({
        type: r.type,
        name: r.name,
        required: r.required,
        labels: r.labels,
        extras: r.extras,
      });
      const others = after.form.survey.filter((r) => r.name !== 'age').map(cells);
      expect(others).toEqual(before.form.survey.map(cells));
    });
  });

  test('T9d — "add without details" is the one-click behaviour for a single question', async ({
    page,
    request,
  }) => {
    await withScratchProject(request, async () => {
      await openPregnancy(page);
      await page.getByRole('button', { name: '+ Question', exact: true }).click();
      const picker = page.locator('.qtype-modal');
      await picker.getByPlaceholder(/has_fever/).fill('quick');
      await picker
        .locator('.qtype-tile')
        .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Text$/ }) })
        .click();
      await expect(picker.locator('.qtype-configure')).toBeVisible();
      await picker.getByRole('button', { name: 'add without details' }).click();
      await expect(picker).not.toBeVisible();
      const names = await renderedNames(page);
      expect(names).toContain('quick');
      // Not required, no hint, no constraint: exactly the one-click row.
      const row = page.locator('.survey-row.row-flash');
      await expect(row.getByRole('checkbox', { name: 'required' })).not.toBeChecked();
    });
  });

  test('T9d — adding while on a row inside a group lands inside it, right after that row, and keeps the pair balanced', async ({
    page,
    request,
  }) => {
    await withScratchProject(request, async () => {
      await openPregnancy(page);
      await page.getByRole('button', { name: 'Full', exact: true }).click();
      const picker = page.locator('.qtype-modal');

      // A fresh group (structural tiles never get the configure step).
      await page.getByRole('button', { name: '+ Question', exact: true }).click();
      await picker.getByPlaceholder(/has_fever/).fill('blk');
      await picker
        .locator('.qtype-tile')
        .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Group$/ }) })
        .click();
      await expect(picker).not.toBeVisible();

      // The group header carries the begin row's id, so focusing it makes the
      // group the current row: "+ Question" lands as its first child.
      const blk = page
        .locator('.survey-group-accordion')
        .filter({ has: page.locator('.survey-group-header code', { hasText: 'blk' }) });
      await expect(blk).toHaveCount(1);
      const header = blk.locator('button.survey-group-header').first();
      await header.focus();
      await page.getByRole('button', { name: '+ Question', exact: true }).click();
      await picker.getByPlaceholder(/has_fever/).fill('first');
      await picker
        .locator('.qtype-tile')
        .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Number$/ }) })
        .click();
      await picker.getByRole('button', { name: 'add without details' }).click();
      await expect(picker).not.toBeVisible();

      // Now the author is ON `first`; "+ Question" lands right after it, inside.
      // (Expand the accordion first if the new child is folded away.)
      if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
      await (await rowByName(page, 'first')).getByRole('textbox', { name: 'name', exact: true }).click();
      await page.getByRole('button', { name: '+ Question', exact: true }).click();
      await picker.getByPlaceholder(/has_fever/).fill('second');
      await picker
        .locator('.qtype-tile')
        .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Number$/ }) })
        .click();
      await picker.getByRole('button', { name: 'add without details' }).click();
      await expect(picker).not.toBeVisible();

      await expect(page.locator('.page-header .badge.danger')).toHaveCount(0);
      await saveForm(page);
      const after = (await (await request.get(`${API}/api/forms/app:pregnancy`)).json()) as FormBody;
      const seq = after.form.survey.map((r) => `${r.type.trim().toLowerCase()}:${r.name ?? ''}`);
      const begin = seq.indexOf('begin group:blk');
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(seq.slice(begin, begin + 4)).toEqual([
        'begin group:blk',
        'integer:first',
        'integer:second',
        'end group:blk',
      ]);
    });
  });
});

test('T9d — with "always skip this step" remembered, a question tile commits on the click', async ({
  page,
  request,
}) => {
  // The suite fixture seeds the preference ON (see setup.ts).
  await withScratchProject(request, async () => {
    await openPregnancy(page);
    await page.getByRole('button', { name: '+ Question', exact: true }).click();
    const picker = page.locator('.qtype-modal');
    await picker.getByPlaceholder(/has_fever/).fill('oneclick');
    await picker
      .locator('.qtype-tile')
      .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Number$/ }) })
      .click();
    await expect(picker).not.toBeVisible();
    expect(await renderedNames(page)).toContain('oneclick');
  });
});
