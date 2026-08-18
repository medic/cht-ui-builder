/**
 * E2E coverage for the three bread-and-butter UAT editing flows on a survey
 * form — the ones a tester reaches for first and that, until now, had NO
 * automated coverage (only the condition-builder dropdown + helper builder
 * were tested):
 *
 *   1. Editing the choices of a select_multiple (the "danger signs" question)
 *      — add / rename label / remove an option, and confirm the edit syncs to
 *      another surface (the Translate tab reads the same store).
 *   2. Editing labels + translations — edit the default-language label inline,
 *      see it on the Translate tab, fill a missing `ne` translation, and watch
 *      the per-locale "missing" counter fall.
 *   3. Reordering questions with the dependency guard — a benign move goes
 *      through silently; a move that would hoist a row above a `${field}` it
 *      references raises the guard, and dismissing it leaves the order intact.
 *
 * Flows 1–3 are UI-level (no save) so they never mutate the committed
 * `mini-config` fixture. A fourth test exercises the project's NON-NEGOTIABLE
 * invariant — round-trip safety to disk — by editing, saving through the
 * SaveDiffModal, reloading, and asserting the edit survived a real
 * serialize → write → re-parse cycle. That one saves, so it operates on an
 * isolated temp copy of the fixture, never the committed one.
 *
 * Runs against the committed `client/tests/fixtures/mini-config` project by
 * default (no env export needed). The dev server must be up (`pnpm dev`).
 */
import { test, expect } from './setup.js';
import type { Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(here, 'fixtures', 'mini-config');

/** Open the committed fixture's pregnancy form and wait for the survey list. */
async function openPregnancy(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
  await expect(page.locator('.survey-row').first()).toBeVisible();
}

// All tests run in the editor's DEFAULT Simple mode. After the
// isHiddenInSimpleMode base-token fix, Simple mode shows exactly the five
// user-facing rows [lmp_date, lmp_note, danger_signs, chair_rise, gravidity]
// (the inputs/ calculates + structural rows stay hidden). The danger-signs
// select being visible here is itself the end-to-end regression guard for
// that fix — before it, every select question was hidden in the default view.
//
// `chair_rise` (select_one) joined the fixture for docs/NEXT.md item 2; the
// inputs/ calculates stay hidden under the authoring hide set too (item 1),
// which is what keeps these arrays five-long rather than seven.

/** A survey row discriminated by the raw type chip it renders (stable text). */
function rowByType(page: Page, rawType: RegExp) {
  return page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: rawType }) });
}

/** Names of the visible survey rows, in DOM order (live input values). */
function visibleRowNames(page: Page): Promise<string[]> {
  return page
    .locator('.survey-row input.name-input')
    .evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
}

/* ===================== 1. Editing select_multiple choices ===================== */

test('choices — add, rename label, and remove options on the danger-signs multi-select', async ({
  page,
}) => {
  await openPregnancy(page);

  const dangerRow = rowByType(page, /^select_multiple danger_signs$/);
  await expect(dangerRow).toBeVisible();
  await dangerRow.getByRole('button', { name: /show advanced/ }).click();

  const choices = dangerRow.locator('.inline-choices');
  await expect(choices).toBeVisible();
  // Fixture ships three options.
  await expect(choices.locator('.inline-choice-row')).toHaveCount(3);

  // --- Rename an option's label (name stays, label changes) ---
  // Anchor on the stable `name` cell (severe_headache) — the label cell is
  // about to change, so filtering on it would stop matching after the edit.
  const headacheRow = choices
    .locator('.inline-choice-row')
    .filter({ has: page.locator('input[value="severe_headache"]') });
  await headacheRow.locator('input').nth(1).fill('Bad headache');
  await expect(headacheRow.locator('input').nth(0)).toHaveValue('severe_headache');
  await expect(headacheRow.locator('input').nth(1)).toHaveValue('Bad headache');

  // --- Add a new option ---
  await choices.getByRole('button', { name: '+ Add option' }).click();
  await expect(choices.locator('.inline-choice-row')).toHaveCount(4);
  const added = choices.locator('.inline-choice-row').last();
  await added.locator('input').nth(0).fill('convulsions');
  await added.locator('input').nth(1).fill('Convulsions');

  // --- Remove an existing option (confirms via window.confirm) ---
  page.once('dialog', (d) => {
    expect(d.message()).toContain('blurred_vision');
    void d.accept();
  });
  await choices
    .locator('.inline-choice-row')
    .filter({ has: page.locator('input[value="blurred_vision"]') })
    .getByRole('button', { name: 'remove' })
    .click();
  await expect(choices.locator('.inline-choice-row')).toHaveCount(3);

  // --- The edit is in the shared store, so another surface (Translate tab,
  //     Choices scope) sees the added option and the removal. ---
  await page.getByRole('button', { name: 'Translate' }).click();
  await page.locator('.translate-tab').getByRole('button', { name: /^Choices \(/ }).click();
  await expect(page.getByText('convulsions', { exact: true })).toHaveCount(1);
  await expect(page.getByText('blurred_vision', { exact: true })).toHaveCount(0);
});

test('choices — rename a list from the Choices tab updates the survey row type AND the choices', async ({
  page,
}) => {
  await openPregnancy(page);
  // Confirm the danger_signs select_multiple is bound to the danger_signs list
  // BEFORE renaming.
  await expect(rowByType(page, /^select_multiple danger_signs$/)).toBeVisible();

  await page.getByRole('button', { name: /^Choices/ }).click();
  const choicesTab = page.locator('.choices-tab');
  // Selected by data-list-name, not by the heading: rename mode swaps the
  // <h3> for an input, so a heading-based filter stops matching as soon as
  // rename is clicked and the rename input can never be found.
  const dangerSection = choicesTab.locator('section.choice-list[data-list-name="danger_signs"]');
  await expect(dangerSection).toBeVisible();

  // Click "rename", fill the new name, accept the confirm.
  await dangerSection.getByRole('button', { name: 'rename' }).click();
  await dangerSection.locator('input[aria-label="Rename list danger_signs"]').fill('warning_signs');
  page.once('dialog', (d) => {
    expect(d.message()).toContain('warning_signs');
    void d.accept();
  });
  await dangerSection.getByRole('button', { name: 'save' }).click();

  // The header is now `warning_signs`; the old section is gone.
  await expect(
    choicesTab
      .locator('section.choice-list')
      .filter({ has: page.locator('h3', { hasText: 'warning_signs' }) }),
  ).toBeVisible();
  await expect(
    choicesTab
      .locator('section.choice-list')
      .filter({ has: page.locator('h3', { hasText: 'danger_signs' }) }),
  ).toHaveCount(0);

  // Back on the Survey tab the bound row's type rewrites to the new list.
  await page.getByRole('button', { name: /^Survey/ }).click();
  await expect(rowByType(page, /^select_multiple warning_signs$/)).toBeVisible();
  await expect(rowByType(page, /^select_multiple danger_signs$/)).toHaveCount(0);
});

/* ===================== 2. Editing labels + translations ===================== */

test('labels — inline edit propagates to the Translate tab; filling a missing translation lowers the count', async ({
  page,
}) => {
  await openPregnancy(page);

  // Edit the default-language (en) label of lmp_date inline on its row.
  const lmpRow = rowByType(page, /^date$/);
  const enField = lmpRow
    .locator('.label-row')
    .filter({ has: page.getByText('label::en', { exact: true }) })
    .locator('input');
  await enField.fill('LMP date');

  // The Translate tab is a second view onto the same labels — it must reflect
  // the inline edit, and report `ne` as having 2 missing (gravidity, lmp_note).
  await page.getByRole('button', { name: 'Translate' }).click();
  await expect(page.locator('.translate-tab').getByText('ne: 2 missing')).toBeVisible();

  const lmpTranslateRow = page
    .locator('.translate-grid tr')
    .filter({ has: page.getByText('lmp_date', { exact: true }) });
  await expect(lmpTranslateRow.locator('textarea').nth(0)).toHaveValue('LMP date');

  // Fill the missing Nepali translation for gravidity → missing count drops.
  const gravidityRow = page
    .locator('.translate-grid tr')
    .filter({ has: page.getByText('gravidity', { exact: true }) });
  await gravidityRow.locator('textarea').nth(1).fill('गर्भधारण');
  await expect(page.locator('.translate-tab').getByText('ne: 1 missing')).toBeVisible();
});

/* ===================== 3. Reorder with the dependency guard ===================== */

test('reorder — a move with no broken references goes through without a prompt', async ({
  page,
}) => {
  await openPregnancy(page);
  expect(await visibleRowNames(page)).toEqual([
    'lmp_date',
    'lmp_note',
    'danger_signs',
    'chair_rise',
    'gravidity',
  ]);

  // danger_signs references nothing; moving it up (swap with lmp_note, which
  // still sits below its `${lmp_date}` reference) breaks no dependency.
  await rowByType(page, /^select_multiple danger_signs$/)
    .getByRole('button', { name: 'move up' })
    .click();

  expect(await visibleRowNames(page)).toEqual([
    'lmp_date',
    'danger_signs',
    'lmp_note',
    'chair_rise',
    'gravidity',
  ]);
});

test('reorder — the guard fires and blocks a move that would break a ${field} reference', async ({
  page,
}) => {
  await openPregnancy(page);

  // lmp_note has `relevant = ${lmp_date} != ''`. Moving it up swaps it above
  // lmp_date — the guard must warn and, on dismiss, leave the order untouched.
  let warned = '';
  page.once('dialog', (d) => {
    warned = d.message();
    void d.dismiss();
  });
  await rowByType(page, /^note$/).getByRole('button', { name: 'move up' }).click();

  await expect.poll(() => warned).toContain('lmp_date');
  // Order unchanged — dismissing the guard cancels the move.
  expect(await visibleRowNames(page)).toEqual([
    'lmp_date',
    'lmp_note',
    'danger_signs',
    'chair_rise',
    'gravidity',
  ]);
});

test('reorder — the guard is overridable: accepting the warning performs the move', async ({
  page,
}) => {
  await openPregnancy(page);

  page.once('dialog', (d) => void d.accept());
  await rowByType(page, /^note$/).getByRole('button', { name: 'move up' }).click();

  // lmp_note is now above lmp_date — the guard warns but never hard-blocks.
  expect(await visibleRowNames(page)).toEqual([
    'lmp_note',
    'lmp_date',
    'danger_signs',
    'chair_rise',
    'gravidity',
  ]);
});

/* ===================== 4. Round-trip safety to disk ===================== */

test('round-trip — an edit survives save → reload → re-parse on an isolated project copy', async ({
  page,
  request,
}) => {
  // Copy the fixture so the save writes to a throwaway project, never the
  // committed one. Round-trip safety is the repo's non-negotiable invariant,
  // so this is the test that actually exercises serialize → write → re-parse.
  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-e2e-'));
  try {
    await fs.cp(FIXTURE_DIR, tmpProject, { recursive: true });

    // 127.0.0.1 (not `localhost`) — see client/tests/setup.ts for the IPv4
    // vs ::1 rationale on Windows.
    const opened = await request.post('http://127.0.0.1:5174/api/project/open', {
      data: { path: tmpProject },
    });
    expect(opened.ok()).toBeTruthy();

    // Open the form from the temp project and make one durable edit.
    await page.goto('/');
    // Guard: confirm the UI really switched to the temp project BEFORE any
    // save can fire. The server saves to whichever project is open, so this
    // is what guarantees a save can never land on the committed fixture.
    await expect(page.getByText(path.basename(tmpProject)).first()).toBeVisible();
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    const dangerRow = rowByType(page, /^select_multiple danger_signs$/);
    await dangerRow.getByRole('button', { name: /show advanced/ }).click();
    const choices = dangerRow.locator('.inline-choices');
    await choices.getByRole('button', { name: '+ Add option' }).click();
    const added = choices.locator('.inline-choice-row').last();
    await added.locator('input').nth(0).fill('convulsions');
    await added.locator('input').nth(1).fill('Convulsions');

    // Save through the confirm-diff modal.
    await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
    ).toBeVisible();

    // Reload from scratch — the server re-parses the .xlsx from disk, so this
    // proves the edit round-tripped through serialize → write → parse.
    await page.goto('/');
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    const reloadedDanger = rowByType(page, /^select_multiple danger_signs$/);
    await reloadedDanger.getByRole('button', { name: /show advanced/ }).click();
    const reloadedChoices = reloadedDanger.locator('.inline-choices');
    await expect(
      reloadedChoices.locator('.inline-choice-row').filter({
        has: page.locator('input[value="convulsions"]'),
      }),
    ).toHaveCount(1);
    // Untouched options are still there — the save didn't drop siblings.
    await expect(reloadedChoices.locator('.inline-choice-row')).toHaveCount(4);
  } finally {
    await fs.rm(tmpProject, { recursive: true, force: true });
  }
});

/* ============== §A1 + §A6 — group-authoring balance guard ================ */
/*
 * docs/plans/survey-groups-and-scaffold.md §A1 — committing a structural
 * tile (Group / Repeat) must insert a MATCHED begin/end pair, not the
 * lone `begin` row the pre-fix code emitted. Without this, every
 * group-add produced an unbalanced survey that pyxform / cht-conf would
 * reject on deploy.
 *
 * §A6 — the save path refuses to write an unbalanced survey. The
 * test below proves both contracts: add a group via the picker, confirm
 * the resulting survey has BOTH a `begin group` and a matching `end group`,
 * AND that the page-header save flow succeeds (no structural-issue banner,
 * no error toast). The save guard would surface a danger badge if A1
 * regressed.
 */
test('§A1+§A6 — adding a Group via the picker emits a balanced begin/end pair and save proceeds', async ({
  page,
  request,
}) => {
  // Isolate the save target.
  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-e2e-group-'));
  try {
    await fs.cp(FIXTURE_DIR, tmpProject, { recursive: true });

    const opened = await request.post('http://127.0.0.1:5174/api/project/open', {
      data: { path: tmpProject },
    });
    expect(opened.ok()).toBeTruthy();

    await page.goto('/');
    await expect(page.getByText(path.basename(tmpProject)).first()).toBeVisible();
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    // Switch to Full mode so the structural rows render and the picker
    // can offer the structural tiles.
    await page.getByRole('button', { name: 'Full', exact: true }).click();

    // Open the picker.
    await page.getByRole('button', { name: '+ Question' }).click();
    const picker = page.locator('.qtype-modal');
    await expect(picker).toBeVisible();

    // Name the new group BEFORE picking the tile (the picker auto-commits
    // on tile click for tiles that need no list — Kobo parity, see
    // QuestionTypePicker.handlePick line ~145).
    await picker
      .locator('input[placeholder*="has_fever"], input[placeholder*="patient_age"]')
      .first()
      .fill('triage');

    // Pick the Group tile — single click commits (Group needs no list).
    await picker
      .locator('.qtype-tile')
      .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Group$/ }) })
      .click();

    // Modal closes after commit.
    await expect(picker).not.toBeVisible();

    // §A1+§A2 — the new group renders as a `.survey-group-accordion` with
    // the typed name in the header. (Begin/end rows are folded into the
    // accordion; they are NOT rendered as standalone `.survey-row` cards
    // post-A2, so the older begin-row-as-survey-row assertion no longer
    // applies.)
    const triageGroup = page.locator('.survey-group-accordion').filter({
      has: page.locator('.survey-group-header code', { hasText: 'triage' }),
    });
    await expect(triageGroup).toHaveCount(1);

    // §A6 — no danger banner; save proceeds without the structural guard
    // tripping. Click the page-header Save and walk through the diff modal.
    await expect(
      page.locator('.page-header .badge.danger'),
      'structural-violations banner must not appear for a balanced survey',
    ).toHaveCount(0);
    await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
    ).toBeVisible();

    // §A1 on-disk proof — the persisted form.survey carries BOTH a `begin
    // group` and an `end group` row with name "triage". The pre-fix code
    // produced an unbalanced survey that pyxform would reject.
    const formRes = await request.get('http://127.0.0.1:5174/api/forms/app:pregnancy');
    expect(formRes.ok()).toBeTruthy();
    const formBody = (await formRes.json()) as {
      form: { survey: Array<{ name: string; type: string }> };
    };
    const triageRows = formBody.form.survey.filter((r) => r.name === 'triage');
    const triageBegin = triageRows.find((r) => r.type.trim().toLowerCase() === 'begin group');
    const triageEnd = triageRows.find((r) => r.type.trim().toLowerCase() === 'end group');
    expect(triageBegin, 'saved survey must carry a `begin group` named "triage"').toBeTruthy();
    expect(triageEnd, 'saved survey must carry a matching `end group` named "triage"').toBeTruthy();
  } finally {
    await fs.rm(tmpProject, { recursive: true, force: true });
  }
});

/* ====================== §B2 — ungroup e2e ====================== */
/*
 * docs/plans/shipped-batch-triad-punchlist.md §B2 — group-as-unit move,
 * boundary-safe leaf move, and ungroup are real shipped mutating paths.
 * The drag contract is pinned by the 17 shared `surveyEdits.test.ts`
 * cases (planSurveyMove + planUngroup over every contract: group-as-unit
 * intact, boundary-split rejected, drop-inside-own-span refused,
 * ungroup balance). This e2e pins the UNGROUP path end-to-end through
 * the UI + on-disk save — the one path the user reaches through a
 * dedicated affordance (the "ungroup" link on each group header).
 */
test('§B2 — ungroup round-trips through the UI + on-disk form', async ({
  page,
  request,
}) => {
  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-e2e-surveyedits-'));
  try {
    await fs.cp(FIXTURE_DIR, tmpProject, { recursive: true });
    const opened = await request.post('http://127.0.0.1:5174/api/project/open', {
      data: { path: tmpProject },
    });
    expect(opened.ok()).toBeTruthy();

    await page.goto('/');
    await expect(page.getByText(path.basename(tmpProject)).first()).toBeVisible();
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    // Full mode so the structural rows render and the group's accordion
    // header (with the "ungroup" link) is reachable.
    await page.getByRole('button', { name: 'Full', exact: true }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    // Add a fresh "triage" group so we have a known begin/end pair to
    // ungroup without touching the existing `inputs` plumbing accordion.
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

    // Save the baseline (triage begin + end seeded).
    await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
    ).toBeVisible();

    const before = await request.get('http://127.0.0.1:5174/api/forms/app:pregnancy');
    const beforeBody = (await before.json()) as {
      form: { survey: Array<{ name: string; type: string }> };
    };
    // 11 fixture rows + 2 triage begin/end. The fixture gained `chair_rise`
    // (a select_one pass_fail) in c66cfcb and this count was not updated with
    // it, so assert against the parsed fixture rather than a literal that goes
    // stale the next time a row is added.
    expect(beforeBody.form.survey.length).toBe(13);

    // Ungroup the triage container via its header link. The shared
    // planUngroup decision returned `kind:'ok'` and the inline patch
    // strips the begin/end shell.
    const triageHeader = page.locator('.survey-group-header', { hasText: 'triage' });
    await expect(triageHeader).toBeVisible();
    // The ungroup link sits next to the header inside the same row
    // container — use the parent `.survey-group-header-row` for scope.
    const triageHeaderRow = page.locator('.survey-group-header-row', { hasText: 'triage' });
    await triageHeaderRow.getByRole('button', { name: 'ungroup' }).click();

    // No structural badge appears (the survey is still balanced — empty
    // begin/end pairs ungroup losslessly).
    await expect(page.locator('.page-header .badge.danger')).toHaveCount(0);

    // Save the ungrouped state.
    await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
    ).toBeVisible();

    const after = await request.get('http://127.0.0.1:5174/api/forms/app:pregnancy');
    const afterBody = (await after.json()) as {
      form: { survey: Array<{ name: string; type: string }> };
    };
    // Triage's begin and end are gone (no other group shares the name).
    const remainingTriage = afterBody.form.survey.filter((r) => r.name === 'triage');
    expect(remainingTriage).toHaveLength(0);
    // Row count dropped by exactly 2 (the begin + the end shell rows).
    // Back to the fixture's own 11 rows: ungrouping removed only the two
    // begin/end shell rows, which is the whole point of the assertion.
    expect(afterBody.form.survey.length).toBe(11);
  } finally {
    await fs.rm(tmpProject, { recursive: true, force: true });
  }
});

/* ============== §H3 follow-up — structural-issues click-to-jump ============== */
/*
 * docs/plans/shipped-batch-triad-punchlist.md §H3 (follow-up) — the
 * Structural-issues popover lists every imbalance, but each entry is now a
 * clickable button that jumps to the offending row, forces Full mode (so
 * structural rows are visible), pulses a `.row-flash` outline, and moves
 * focus to the row. This pins the full chain end-to-end:
 *   1. an unbalanced survey shows the danger badge in the page header
 *   2. clicking it opens the popover; clicking an issue triggers the jump
 *   3. SurveyTab flips Simple → Full and the target accordion gets
 *      `.row-flash` + focus.
 *
 * The unbalance is introduced via the UI (delete the `end group` row of a
 * freshly-added "triage" group) so the test does not depend on a bespoke
 * fixture and exercises the actual save-block trigger users hit.
 */
test('§H3 follow-up — clicking a structural-issue jumps to the row, forces Full mode, and flashes', async ({
  page,
  request,
}) => {
  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-e2e-jump-'));
  try {
    await fs.cp(FIXTURE_DIR, tmpProject, { recursive: true });
    const opened = await request.post('http://127.0.0.1:5174/api/project/open', {
      data: { path: tmpProject },
    });
    expect(opened.ok()).toBeTruthy();

    await page.goto('/');
    await expect(page.getByText(path.basename(tmpProject)).first()).toBeVisible();
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    // Seed an unbalanced survey. After §A2, every group renders as a folded
    // accordion and the builder PREVENTS creating an imbalance (balanced
    // insert + ungroup + the §A6 save guard) — so the only way a survey
    // becomes unbalanced is loading a malformed form, which is exactly what
    // the structural-issue jump exists to surface. Drop one `end group` row
    // via the API (the client save guard is bypassed; the server does not
    // re-balance), then reload so the editor re-parses an unbalanced survey.
    const got = await request.get('http://127.0.0.1:5174/api/forms/app:pregnancy');
    const body = (await got.json()) as {
      form: { survey: Array<{ type: string; name?: string; labels?: unknown; extras?: unknown }> };
      properties?: unknown;
    };
    // Append a dangling `begin group` at the very END — an unclosed group with
    // nothing after it. This unbalances the survey (→ structural issue) while
    // leaving every real question renderable in Simple mode: none of them fall
    // inside the unclosed group, so the editor still shows survey rows. (Removing
    // an existing end-group instead would leave the trailing rows "inside" the
    // never-closed group, which computeSimpleHiddenRowIds hides entirely.)
    body.form.survey.push({ type: 'begin group', name: 'orphan_block', labels: {}, extras: {} });
    const put = await request.put('http://127.0.0.1:5174/api/forms/app:pregnancy', {
      data: { form: body.form, properties: body.properties ?? null },
    });
    expect(put.ok()).toBeTruthy();

    // Reload — the form now parses as unbalanced, in the default Simple mode
    // (so the jump has something to auto-flip away from).
    await page.goto('/');
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();
    // The structural-issues badge appears for the unbalanced survey.
    const badge = page.locator('.page-header .badge.danger');
    await expect(badge).toBeVisible();

    // Start in Simple so the jump's auto-flip to Full is observable.
    await page.getByRole('button', { name: 'Simple', exact: true }).click();

    // Open the popover and click the first issue (the "Row N" jump button).
    await badge.click();
    const popover = page.locator('.structural-issues-popover');
    await expect(popover).toBeVisible();
    await popover.locator('button.structural-issue-jump').first().click();

    // Jump consequences:
    //   1. mode is now Full
    //   2. some row/accordion picked up `.row-flash` (the begin of triage
    //      renders as an accordion since the end is missing — its data-row-id
    //      is the begin row's id)
    //   3. that element holds focus
    await expect(page.getByRole('button', { name: 'Full', exact: true })).toHaveClass(/active/);
    const flashed = page.locator('[data-row-id].row-flash');
    await expect(flashed).toHaveCount(1);
    // Focus assertion: the flashed element is the active focus target. We
    // compare data-row-id rather than the DOM node directly so the assertion
    // works whether it's a `.survey-row` or `.survey-group-accordion`.
    const flashedRowId = await flashed.getAttribute('data-row-id');
    const activeRowId = await page.evaluate(
      // eslint-disable-next-line no-undef
      () => (document.activeElement as HTMLElement | null)?.getAttribute('data-row-id') ?? null,
    );
    expect(activeRowId).toBe(flashedRowId);
  } finally {
    await fs.rm(tmpProject, { recursive: true, force: true });
  }
});

/* ==================== Calculation builder (Tier 0/1/1.5) ==================== */
/*
 * docs/plans/calculation-builder.md §4 lists "calc-builder e2e, incl. a
 * Decisions-still-renders assertion after a builder edit" as a deliverable.
 * Until now the calc builder had unit/round-trip coverage only (the 17
 * calculationBuilder.roundtrip.test.ts cases + the 258-cell field-coverage
 * tripwire) but ZERO browser coverage. These two tests close that:
 *   1. a single-value (auto-quoted text) edit round-trips save → reload —
 *      the round-trip-to-disk invariant through the real serialize/parse path;
 *   2. an if-then decision table built in the UI round-trips AND surfaces in
 *      the read-only Decisions sign-off view (the §4 "Decisions-still-renders"
 *      assertion, made concrete: the calc actually appears there).
 *
 * Both save, so both run against an isolated temp copy of the fixture.
 * `gravidity` (the only `integer` row) is the edit target — visible in the
 * default Simple mode, and a regular question accepts a `calculation` cell.
 */

/** Open the calculation builder on gravidity's advanced panel. Returns the
 *  calc-field locator (for post-save value assertions) and the modal. */
async function openCalcBuilderOnGravidity(page: Page) {
  const gravRow = rowByType(page, /^integer$/);
  await gravRow.getByRole('button', { name: /show advanced/ }).click();
  const calcField = gravRow
    .locator('.expr-field')
    .filter({ has: page.locator('code.raw-col-tag', { hasText: 'calculation' }) });
  // The build button lives inside the `<label>`, so its computed accessible
  // name is the whole field label — match on visible text instead.
  await calcField.locator('button', { hasText: 'build' }).click();
  const modal = page.locator('.rule-builder-modal[aria-label="Calculation builder"]');
  await expect(modal).toBeVisible();
  return { calcField, modal };
}

test('calc builder — a single-value (auto-quoted text) calculation round-trips save → reload', async ({
  page,
  request,
}) => {
  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-e2e-calc-'));
  try {
    await fs.cp(FIXTURE_DIR, tmpProject, { recursive: true });
    const opened = await request.post('http://127.0.0.1:5174/api/project/open', {
      data: { path: tmpProject },
    });
    expect(opened.ok()).toBeTruthy();

    await page.goto('/');
    await expect(page.getByText(path.basename(tmpProject)).first()).toBeVisible();
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    const { calcField, modal } = await openCalcBuilderOnGravidity(page);
    await modal.getByRole('tab', { name: 'Single value' }).click();
    await modal.getByRole('radio', { name: 'Text', exact: true }).click();
    await modal.getByLabel('Literal text value').fill('yes');
    await modal.getByRole('button', { name: 'Save', exact: true }).click();

    // Auto-quote: the literal `yes` is stored as the XLSForm string `'yes'`.
    await expect(calcField.locator('input').first()).toHaveValue("'yes'");

    // Persist through the diff modal, then reload — the server re-parses from
    // disk, proving the calculation round-tripped serialize → write → parse.
    await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
    ).toBeVisible();

    await page.goto('/');
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    const reGrav = rowByType(page, /^integer$/);
    await reGrav.getByRole('button', { name: /show advanced/ }).click();
    const reCalc = reGrav
      .locator('.expr-field')
      .filter({ has: page.locator('code.raw-col-tag', { hasText: 'calculation' }) });
    await expect(reCalc.locator('input').first()).toHaveValue("'yes'");
  } finally {
    await fs.rm(tmpProject, { recursive: true, force: true });
  }
});

test('calc builder — an if-then table round-trips and surfaces in the Decisions view', async ({
  page,
  request,
}) => {
  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-e2e-calc-dt-'));
  try {
    await fs.cp(FIXTURE_DIR, tmpProject, { recursive: true });
    const opened = await request.post('http://127.0.0.1:5174/api/project/open', {
      data: { path: tmpProject },
    });
    expect(opened.ok()).toBeTruthy();

    await page.goto('/');
    await expect(page.getByText(path.basename(tmpProject)).first()).toBeVisible();
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    const { calcField, modal } = await openCalcBuilderOnGravidity(page);
    await modal.getByRole('tab', { name: 'If-then table' }).click();
    await modal.getByRole('button', { name: '+ Rule' }).click();

    // Give rule 1 a real (non-empty) condition. "+ comparison" seeds
    // `${<first field>} = ''` — enough to serialize to a valid if-chain that
    // re-parses as a decision_table (an empty condition would demote to raw).
    await modal.getByRole('button', { name: /edit condition for rule 1/ }).click();
    // The nested rule builder renders INSIDE the calc-card, so both cards
    // carry a "Save" — target the innermost (last) card to disambiguate.
    const ruleBuilder = page.locator('.rule-builder-card').last();
    await ruleBuilder.getByRole('button', { name: '+ comparison' }).click();
    await ruleBuilder.getByRole('button', { name: 'Save', exact: true }).click();

    // Otherwise → numeric 0, so the cell serializes to `if(cond, '', 0)`.
    const otherwise = modal.locator('.otherwise-row');
    await otherwise.getByRole('radio', { name: 'Number' }).click();
    await otherwise.locator('input[type="number"]').fill('0');

    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(calcField.locator('input').first()).toHaveValue(/^if\(/);

    // Persist.
    await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
    ).toBeVisible();

    // The §4 deliverable: the read-only Decisions view still renders AND now
    // aggregates the new decision-table calculation (`Compute "gravidity"`).
    await page.locator('.nav-item', { hasText: 'Decisions' }).click();
    await expect(page.getByText('Compute "gravidity"')).toBeVisible();
  } finally {
    await fs.rm(tmpProject, { recursive: true, force: true });
  }
});
