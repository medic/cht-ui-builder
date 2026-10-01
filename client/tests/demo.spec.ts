/**
 * DEMO walkthrough — three watchable chapters that drive the real UI end to end.
 * Doubles as automated e2e (headless) and a live demo (headed + slow).
 *
 *   Chapter 1 — Authoring: open a form, edit a name/label + a translation,
 *               add a choice, add a question, move a question up/down, and
 *               create a group with a nested question.
 *   Chapter 2 — FHIR Standard-codes workbench: open it and show the mapped codes.
 *   Chapter 3 — Round-trip: an edit survives Save → reload (on an isolated copy,
 *               so it never touches your real project).
 *
 * ── WATCH it run (a Chromium window opens on THIS machine) ──────────────────
 *   # one-time: build the workspaces the dev server serves
 *   pnpm --filter @cht-ui/shared build && pnpm --filter @cht-ui/server build
 *
 *   # best — interactive UI (run/replay/time-travel each step):
 *   pnpm --filter @cht-ui/client exec playwright test demo.spec.ts --ui
 *   # headed + slow (window drives itself):
 *   DEMO=1 pnpm --filter @cht-ui/client exec playwright test demo.spec.ts --headed
 *   # step-through (opens paused; click Resume to advance):
 *   DEMO=1 pnpm --filter @cht-ui/client exec playwright test demo.spec.ts --debug
 *
 * ── Run HEADLESS as a test (no window) ──────────────────────────────────────
 *   pnpm --filter @cht-ui/client exec playwright test demo.spec.ts
 *
 * Demo on REAL data instead of the fixture:
 *   PLAYWRIGHT_PROJECT_PATH="D:\\medic\\config-nssd\\chis" DEMO=1 \
 *     pnpm --filter @cht-ui/client exec playwright test demo.spec.ts --headed
 * Tune the pace with SLOW_MS below.
 */
import { test, expect, PROJECT_PATH } from './setup.js';
import type { Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `DEMO=1` → headed + slow so you can watch each step (the live-demo mode).
// Unset → headless + fast, so the same file also runs as a normal e2e test.
const SLOW_MS = 700;
test.use({
  headless: !process.env.DEMO,
  launchOptions: { slowMo: process.env.DEMO ? SLOW_MS : 0 },
});

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** A survey row located by the raw type chip it renders (stable text). */
function rowByType(page: Page, rawType: RegExp) {
  return page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: rawType }) });
}

/** A survey row located by its technical `name` (stable across label edits). */
function rowByName(page: Page, name: string) {
  return page
    .locator('.survey-row')
    .filter({ has: page.locator(`input.name-input[value="${name}"]`) });
}

/** Visible survey row names, in DOM order. */
function visibleRowNames(page: Page): Promise<string[]> {
  return page
    .locator('.survey-row input.name-input')
    .evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
}

/** The label::en input of a survey row. */
function enLabelOf(page: Page, row: ReturnType<typeof rowByType>) {
  return row
    .locator('.label-row')
    .filter({ has: page.getByText('label::en', { exact: true }) })
    .locator('input');
}

/** Land in an open project. A fresh browser shows the picker; drive it if so. */
async function openProject(page: Page, projectPath = PROJECT_PATH) {
  await page.goto('/');
  const pathInput = page.getByRole('textbox', { name: /Project folder/i });
  try {
    await pathInput.waitFor({ state: 'visible', timeout: 4000 });
    await pathInput.fill(projectPath);
    await page.getByRole('button', { name: 'Open' }).click();
  } catch {
    /* a project is already open — fall through to the sidebar */
  }
  await expect(page.locator('.nav-item', { hasText: 'Forms' })).toBeVisible();
}

/** Open the pregnancy form and wait for the survey list. */
async function openPregnancy(page: Page, projectPath = PROJECT_PATH) {
  await openProject(page, projectPath);
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
  await expect(page.locator('.survey-row').first()).toBeVisible();
}

/* ── Chapter 1 — survey authoring ─────────────────────────────────────────── */

test('demo 1 — author a survey: edit, choices, add, move, group + nest, translate', async ({
  page,
}) => {
  await test.step('Open the project + the pregnancy form', async () => {
    await openPregnancy(page);
  });

  await test.step('Rename a question label (the user-facing title)', async () => {
    const enLabel = enLabelOf(page, rowByType(page, /^date$/));
    await enLabel.fill('Last menstrual period');
    await expect(enLabel).toHaveValue('Last menstrual period');
  });

  await test.step('Rename a question’s technical name (a leaf nothing references)', async () => {
    await rowByName(page, 'gravidity').locator('input.name-input').fill('gravida');
    await expect(page.locator('.survey-row input.name-input[value="gravida"]')).toBeVisible();
  });

  await test.step('Add a choice to the danger-signs select', async () => {
    const dangerRow = rowByType(page, /^select_multiple danger_signs$/);
    await dangerRow.getByRole('button', { name: /show advanced/ }).click();
    const choices = dangerRow.locator('.inline-choices');
    await expect(choices).toBeVisible();
    const before = await choices.locator('.inline-choice-row').count();
    await choices.getByRole('button', { name: '+ Add option' }).click();
    const added = choices.locator('.inline-choice-row').last();
    await added.locator('input').nth(0).fill('convulsions');
    await added.locator('input').nth(1).fill('Convulsions');
    await expect(choices.locator('.inline-choice-row')).toHaveCount(before + 1);
  });

  await test.step('Add a new "temperature" Number question', async () => {
    await page.getByRole('button', { name: '+ Question' }).click();
    const picker = page.locator('.qtype-modal');
    await expect(picker).toBeVisible();
    await picker
      .locator('input[placeholder*="has_fever"], input[placeholder*="patient_age"]')
      .first()
      .fill('temperature');
    await picker
      .locator('.qtype-tile')
      .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Number$/ }) })
      .click();
    await expect(picker).not.toBeVisible();
    await expect(page.locator('.survey-row input.name-input[value="temperature"]')).toBeVisible();
  });

  await test.step('Move danger_signs up, then back down', async () => {
    expect(await visibleRowNames(page)).toEqual([
      'lmp_date',
      'lmp_note',
      'danger_signs',
      // T9d (#17): "+ Question" inserts after the row the author is on —
      // the danger_signs card they just edited — not at the end of the sheet.
      'temperature',
      'chair_rise',
      'gravida',
    ]);
    // `.first()` = the ROW header's move button (the open choices panel adds
    // per-option move buttons that would otherwise make this ambiguous).
    const danger = () => rowByType(page, /^select_multiple danger_signs$/);
    await danger().getByRole('button', { name: 'move up' }).first().click();
    expect(await visibleRowNames(page)).toEqual([
      'lmp_date',
      'danger_signs',
      'lmp_note',
      'temperature',
      'chair_rise',
      'gravida',
    ]);
    await danger().getByRole('button', { name: 'move down' }).first().click();
    expect(await visibleRowNames(page)).toEqual([
      'lmp_date',
      'lmp_note',
      'danger_signs',
      // T9d (#17): "+ Question" inserts after the row the author is on —
      // the danger_signs card they just edited — not at the end of the sheet.
      'temperature',
      'chair_rise',
      'gravida',
    ]);
  });

  await test.step('Create a "triage" group and nest a question inside it', async () => {
    // Structural tiles only appear in Full mode.
    await page.getByRole('button', { name: 'Full', exact: true }).click();
    await page.getByRole('button', { name: '+ Question' }).click();
    const picker = page.locator('.qtype-modal');
    await picker
      .locator('input[placeholder*="has_fever"], input[placeholder*="patient_age"]')
      .first()
      .fill('triage');
    await picker
      .locator('.qtype-tile')
      .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Group$/ }) })
      .click();
    await expect(picker).not.toBeVisible();

    const triageGroup = page
      .locator('.survey-group-accordion')
      .filter({ has: page.locator('.survey-group-header code', { hasText: 'triage' }) });
    await expect(triageGroup).toHaveCount(1);

    // "+ add inside triage" → drop a question INTO the group (nested).
    await triageGroup.getByRole('button', { name: /add inside/ }).click();
    const picker2 = page.locator('.qtype-modal');
    await picker2
      .locator('input[placeholder*="has_fever"], input[placeholder*="patient_age"]')
      .first()
      .fill('triage_note');
    await picker2
      .locator('.qtype-tile')
      .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Number$/ }) })
      .click();
    await expect(picker2).not.toBeVisible();
    await expect(
      triageGroup.locator('input.name-input[value="triage_note"]'),
    ).toBeVisible();
  });

  await test.step('Fill a Nepali translation on the Translate tab', async () => {
    await page.getByRole('button', { name: 'Translate' }).click();
    const noteRow = page
      .locator('.translate-grid tr')
      .filter({ has: page.getByText('lmp_note', { exact: true }) });
    await noteRow.locator('textarea').nth(1).fill('अन्तिम महिनावारीको टिप्पणी');
    await expect(noteRow.locator('textarea').nth(1)).toHaveValue('अन्तिम महिनावारीको टिप्पणी');
  });
});

/* ── Chapter 2 — FHIR Standard-codes workbench ────────────────────────────── */

test('demo 2 — open the FHIR Standard-codes workbench and show the codes', async ({ page }) => {
  await test.step('Open the Standard codes workbench', async () => {
    await openProject(page);
    await page.locator('.nav-item', { hasText: 'Standard codes' }).click();
    await expect(page.getByRole('heading', { name: 'Standard codes' })).toBeVisible();
  });

  await test.step('The first form auto-loads with its mappable columns + codes', async () => {
    // The workbench auto-selects the first app form and renders its table;
    // pregnancy overlaps the bundled pack, so suggested code chips appear.
    await expect(page.locator('.codes-table')).toBeVisible();
    await expect(page.locator('.code-chip').first()).toBeVisible();
  });
});

/* ── Chapter 3 — round-trip safety (Save → reload) ────────────────────────── */

test('demo 3 — an edit survives Save → reload (isolated copy, never your real project)', async ({
  page,
  request,
}) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-demo-rt-'));
  try {
    await fs.cp(PROJECT_PATH, tmp, { recursive: true });
    const opened = await request.post('http://127.0.0.1:5174/api/project/open', {
      data: { path: tmp },
    });
    expect(opened.ok()).toBeTruthy();

    await test.step('Edit a label and Save through the diff modal', async () => {
      await openPregnancy(page, tmp);
      await enLabelOf(page, rowByType(page, /^date$/)).fill('Last menstrual period (saved)');
      await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
      await page
        .locator('.rule-builder-card')
        .getByRole('button', { name: 'Save', exact: true })
        .click();
      await expect(
        page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
      ).toBeVisible();
    });

    await test.step('Reload from disk — the edit round-tripped through serialize → write → parse', async () => {
      await openPregnancy(page, tmp);
      await expect(enLabelOf(page, rowByType(page, /^date$/))).toHaveValue(
        'Last menstrual period (saved)',
      );
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ── Chapter 4 — place hierarchy ──────────────────────────────────────────── */

test('demo 4 — view the place hierarchy and add a new place type', async ({ page }) => {
  await test.step('Open the Hierarchy editor', async () => {
    await openProject(page);
    await page.locator('.nav-item', { hasText: 'Hierarchy' }).click();
    await expect(page.getByRole('heading', { name: 'Hierarchy' })).toBeVisible();
    // The canonical place chain (district_hospital → health_center → clinic →
    // person) renders as a tree.
    await expect(page.locator('.tree-row', { hasText: 'district_hospital' })).toBeVisible();
    await expect(page.locator('.tree-row', { hasText: 'person' })).toBeVisible();
  });

  await test.step('Add a "ward" place type under health_center', async () => {
    await page.getByRole('button', { name: '+ Type' }).click();
    const modal = page.locator('.qtype-modal');
    await expect(modal).toBeVisible();
    await modal.getByPlaceholder(/chw, patient/).fill('ward');
    await modal.locator('select').selectOption('health_center');
    await modal.getByRole('button', { name: 'Add type' }).click();
    await expect(modal).not.toBeVisible();
    await expect(page.locator('.tree-row', { hasText: 'ward' })).toBeVisible();
  });
});
