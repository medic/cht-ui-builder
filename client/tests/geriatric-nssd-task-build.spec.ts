/**
 * NSSD GERIATRIC BUILD — Phase 2: the task connecting
 * geriatric_health_assessment -> geriatric_referral_followup.
 *
 * Re-verified live (2026-08-12) against the current hostile-fixture status
 * rather than trusting the 2026-08-11 audit as still-current:
 *  - alive/muted guard: FIXED (A2 landed — appliesIfParser now preserves
 *    the real helper argument). Built via the picker's own
 *    "+ alive check" / "+ muted check" buttons — no hand-edit needed,
 *    correcting the build protocol's "breaks on a NEW task too" note.
 *  - resolvedIf start clamp: STILL BROKEN (resolvedIfParser.hostile.test.ts
 *    A4 cases are still `{ todo: true }`) — hand-edited after the picker
 *    builds the base shape.
 *  - modifyContent source mapping (B1) + non-string form value (B3):
 *    STILL BROKEN (actionsParser.hostile.test.ts B1/B3 still `{ todo: true
 *    }`) — built via the picker for the TARGET keys, then the actions
 *    field's Raw JS hatch fixes the SOURCE to Utils.getField(report, ...),
 *    NSSD's dominant real accessor (29 uses in tasks.js) — the same
 *    disclosed workaround already agreed for this build.
 *
 * Window is the real customer spec value throughout (days 30 / start 15 /
 * end 15) — no demo-friendly day-0 variant; this ships.
 *
 * Run:
 *   pnpm --filter @cht-ui/client exec playwright test geriatric-nssd-task-build.spec.ts --reporter=line
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { REFER_FLAGS, openProjectAt } from './helpers/geriatric.js';
import { PROJECT_PATH } from './setup.js';
import path from 'node:path';

// Project under test. Defaults to the committed fixture so a fresh clone runs;
// set CHT_PROJECT (or PLAYWRIGHT_PROJECT_PATH) to drive a real cht-conf project.
const PROJECT = process.env.CHT_PROJECT ?? PROJECT_PATH;
const IHA = 'geriatric_health_assessment';
const FOLLOWUP = 'geriatric_referral_followup';
const TASKS_JS = path.join(PROJECT, 'tasks.js');

/** Hand-edit #3 (documented) — the resolvedIf start clamp (A4, still
 *  `{ todo: true }` on HEAD). Finds our new task's resolvedIf function and
 *  inserts NSSD's canonical `Math.max(..., report.reported_date + 1)`
 *  clamp around the window-end argument, matching tasks.js's own existing
 *  pattern (e.g. line ~197) verbatim in shape. */
async function addResolvedIfStartClamp(taskName: string): Promise<void> {
  const src = await fs.readFile(TASKS_JS, 'utf8');
  const marker = `name: '${taskName}'`;
  const nameIdx = src.indexOf(marker);
  if (nameIdx < 0) throw new Error(`task '${taskName}' not found in tasks.js`);
  const resolvedIdx = src.indexOf('resolvedIf:', nameIdx);
  const fnStart = src.indexOf('{', src.indexOf('function', resolvedIdx));
  const fnEnd = src.indexOf('\n    },', fnStart); // task-entry-level closing, 4-space indent
  const body = src.slice(fnStart, fnEnd);
  if (!body.includes('isFormArraySubmittedInWindow')) {
    throw new Error('resolvedIf body does not match the expected picker-emitted shape — inspect before patching');
  }
  const fixed = body.replace(
    /Utils\.addDate\(dueDate,\s*event\.end\s*\+\s*1\)\.getTime\(\)/,
    'Math.max(Utils.addDate(dueDate, event.end + 1).getTime(), report.reported_date + 1)',
  );
  if (fixed === body) throw new Error('start-clamp pattern not found — resolvedIf shape may differ from expected');
  const patched = src.slice(0, fnStart) + fixed + src.slice(fnEnd);
  await fs.writeFile(TASKS_JS, patched);
}

/** Hand-edit #4 (documented) — modifyContent source mapping (B1/B3, still
 *  `{ todo: true }`). The picker's report-mode emits bare `report.<field>`
 *  (undefined at runtime); NSSD's dominant real accessor is
 *  `Utils.getField(report, '<field>')` (Utils is a global in tasks.js, no
 *  import — reference_cht_tasks_utils). Rewrites every emitted
 *  `= report.refer_X` to `= Utils.getField(report, 'refer_X')`. */
async function fixModifyContentSources(taskName: string): Promise<void> {
  const src = await fs.readFile(TASKS_JS, 'utf8');
  const marker = `name: '${taskName}'`;
  const nameIdx = src.indexOf(marker);
  if (nameIdx < 0) throw new Error(`task '${taskName}' not found in tasks.js`);
  const actionsIdx = src.indexOf('modifyContent:', nameIdx);
  const fnEnd = src.indexOf('\n    },', actionsIdx);
  const before = src.slice(0, actionsIdx);
  const body = src.slice(actionsIdx, fnEnd);
  const after = src.slice(fnEnd);
  let fixedCount = 0;
  const fixed = body.replace(/=\s*report\.(refer_\w+);/g, (_m, field) => {
    fixedCount += 1;
    return `= Utils.getField(report, '${field}');`;
  });
  if (fixedCount !== REFER_FLAGS.length) {
    throw new Error(`expected to fix ${REFER_FLAGS.length} modifyContent sources, fixed ${fixedCount} — inspect before trusting`);
  }
  await fs.writeFile(TASKS_JS, before + fixed + after);
}

test('NSSD geriatric — build the task connecting the two forms', async ({ page }) => {
  test.setTimeout(1_200_000);
  await openProjectAt(page, PROJECT);
  await page.goto('/');

  const shippedBefore = await fs.readFile(TASKS_JS, 'utf8');
  const shippedTaskCount = (shippedBefore.match(/^\s*\{\s*$/gm) ?? []).length;
  console.log(`[nssd] tasks.js before: ${shippedBefore.split('\n').length} lines`);

  // Cold-nav gap (same class as the iha-demo's Contact-Summary finding):
  // the app-forms list only populates in the store after Forms has been
  // visited at least once this session — visit it before Tasks so the
  // "App forms" fieldset in appliesToType actually has entries.
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await expect(page.getByRole('button', { name: `${IHA}.xlsx` })).toBeVisible({ timeout: 15_000 });

  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  await page.getByRole('button', { name: '+ Add task' }).click();
  const card = page.locator('.task-card').last();

  const nameField = card.locator('.expr-field', { hasText: 'name' }).first();
  await nameField.locator('input').first().fill('Geriatric referral followup');
  await nameField.getByRole('button', { name: 'use this' }).click();
  const derivedName = await nameField.locator('code').first().textContent();
  console.log('[nssd] auto-derived task name:', derivedName);

  const titleField = card.locator('.expr-field', { hasText: 'title' }).first();
  await titleField.locator('input').first().fill('Geriatric referral followup');

  // appliesTo defaults to empty/contacts on a brand-new task — AppliesToTypeField
  // renders contact-type checkboxes until this is exactly 'reports'. Exact-match
  // the label so this doesn't also grab the "appliesToType" field's container.
  const appliesToField = card.locator('.expr-field')
    .filter({ has: page.locator('code', { hasText: /^appliesTo$/ }) });
  await appliesToField.locator('input').first().fill('reports');

  await card.locator('.expr-field', { hasText: 'appliesToType' })
    .getByRole('checkbox', { name: IHA, exact: true }).check();

  /* appliesIf — the 7 flags OR'd, AND alive, AND not-muted. */
  await card.locator('.expr-field', { hasText: 'appliesIf' })
    .locator('button', { hasText: '✎ build' }).click();
  const aif = page.locator('.rule-builder-modal');
  await expect(aif).toBeVisible();
  for (const flag of REFER_FLAGS) {
    await aif.getByRole('button', { name: '+ report field', exact: true }).click();
    const row = aif.locator('.rule-row').last();
    await row.locator('select.field-picker').selectOption(flag.name);
    const valueSelect = row.locator('select.choice-value-select');
    if (await valueSelect.isVisible().catch(() => false)) await valueSelect.selectOption('true');
    else await row.getByPlaceholder('value', { exact: true }).fill('true');
  }
  await aif.getByRole('button', { name: '+ alive check', exact: true }).click();
  await aif.getByRole('button', { name: '+ muted check', exact: true }).click();
  // OR only the 7 flag-comparison pills; leave alive/muted joins at the AND default.
  const pills = aif.locator('select.connector-pill');
  const pillCount = await pills.count();
  for (let i = 0; i < Math.min(pillCount, REFER_FLAGS.length - 1); i += 1) {
    const pill = pills.nth(i);
    if (await pill.isEnabled().catch(() => false)) await pill.selectOption('or');
  }
  const preview = await aif.locator('.preview pre').textContent();
  console.log('[nssd] appliesIf preview:', preview);
  await aif.getByRole('button', { name: 'Save' }).click();
  await expect(aif).toBeHidden();

  /* Window — the real spec value: days 30 / start 15 / end 15. */
  const events = card.locator('.events-editor');
  const ev = events.locator('.event-card').first();
  await ev.locator('.name-input').fill('geriatric_referral_followup_visit');
  await ev.locator('input[type=number]').nth(0).fill('30');
  await ev.locator('input[type=number]').nth(1).fill('15');
  await ev.locator('input[type=number]').nth(2).fill('15');

  /* resolvedIf — form submitted in window (base shape; clamp hand-added after save). */
  const resolved = card.locator('.expr-field', { hasText: 'resolvedIf' });
  await resolved.locator('button', { hasText: /^Visual$/ }).click();
  await resolved.locator('button', { hasText: 'use "form submitted in window"' }).click();
  await resolved.locator('button', { hasText: /^pick$/ }).click();
  await resolved.locator('select[title="App form whose submission resolves the task"]').selectOption(FOLLOWUP);

  /* Action: open the follow-up, carrying the 7 flags (targets via picker). */
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

  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible({ timeout: 30_000 });
  console.log('[nssd] task saved via UI, name:', derivedName);

  /* ═══ Safety-net check: did the P0 corrupt the 29 shipped tasks? ═══ */
  const savedAfterUi = await fs.readFile(TASKS_JS, 'utf8');
  const shippedBody = shippedBefore.slice(shippedBefore.indexOf('module.exports'), shippedBefore.lastIndexOf('];'));
  const missingLines = shippedBody.split('\n').filter((l) => l.trim().length > 2 && !savedAfterUi.includes(l.trim()));
  if (missingLines.length > 0) {
    console.log(`[nssd] 🔴 P0 CHECK FAILED — ${missingLines.length} shipped tasks.js lines lost/rewritten:`);
    for (const l of missingLines.slice(0, 20)) console.log('   |', l.slice(0, 110));
    throw new Error(`tasks.js P0: ${missingLines.length} shipped lines corrupted by the UI save — STOP, do not proceed to hand-edits on a corrupted file`);
  }
  console.log('[nssd] ✓ P0 check passed — all pre-existing tasks.js content survived the save byte-for-byte');

  const taskNameMatch = savedAfterUi.match(/name:\s*'([^']*geriatric[^']*)'/);
  const taskName = taskNameMatch?.[1];
  if (!taskName) throw new Error('could not find our task name in saved tasks.js');
  console.log('[nssd] task name on disk:', taskName);

  /* Hand-edits #3 and #4 (documented above). */
  await addResolvedIfStartClamp(taskName);
  console.log('[nssd] hand-edit applied: resolvedIf start clamp (A4, still todo on HEAD)');
  await fixModifyContentSources(taskName);
  console.log('[nssd] hand-edit applied: modifyContent sources -> Utils.getField(report, ...) (B1/B3, still todo on HEAD)');

  /* ═══ Verify the final tasks.js ═══ */
  const finalSrc = await fs.readFile(TASKS_JS, 'utf8');
  expect(finalSrc).toContain(`name: '${taskName}'`);
  expect(finalSrc).toContain("Math.max(Utils.addDate(dueDate, event.end + 1).getTime(), report.reported_date + 1)");
  for (const flag of REFER_FLAGS) {
    expect(finalSrc, `${flag.name} modifyContent source`).toContain(`Utils.getField(report, '${flag.name}')`);
  }
  console.log(`[nssd] DONE — task '${taskName}' complete, tasks.js now ${finalSrc.split('\n').length} lines (was ${shippedBefore.split('\n').length})`);
});
