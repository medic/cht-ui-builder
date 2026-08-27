/**
 * Fixes a real logic bug from geriatric-nssd-task-build.spec.ts: the OR-pill
 * loop capped at `REFER_FLAGS.length - 1` pills, one short of covering the
 * psych<->continence connector, so `refer_continence` landed as an
 * unconditional AND instead of joining the OR group. A patient failing ONLY
 * continence would never trigger the task. Reopens the appliesIf builder and
 * sets every ENABLED pill to 'or' (uncapped) — trusting the tool's own
 * disabled-pill boundary around the alive/muted guard rules, the same
 * protection the original scratch demos relied on for raw rows.
 */
import { test, expect } from '@playwright/test';
import { openProjectAt } from './helpers/geriatric.js';
import { PROJECT_PATH } from './setup.js';
import path from 'node:path';

// Project under test. Defaults to the committed fixture so a fresh clone runs;
// set CHT_PROJECT (or PLAYWRIGHT_PROJECT_PATH) to drive a real cht-conf project.
const PROJECT = process.env.CHT_PROJECT ?? PROJECT_PATH;

test('fix: appliesIf OR group must cover all 7 refer_* flags', async ({ page }) => {
  test.setTimeout(300_000);
  await openProjectAt(page, PROJECT);
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  const card = page.locator('.task-card').filter({ hasText: 'geriatric_referral_followup' }).first();
  const expand = card.getByRole('button', { name: '▸' });
  if (await expand.isVisible().catch(() => false)) await expand.click();

  await card.locator('.expr-field', { hasText: 'appliesIf' })
    .locator('button', { hasText: '✎ build' }).click();
  const aif = page.locator('.rule-builder-modal');
  await expect(aif).toBeVisible();

  // 7 flags = 6 gaps between them (pills[0..5], must be 'or'); the 2 guard
  // rules (alive, muted) add 2 more gaps (pills[6],[7]) that must stay
  // 'and' — merging those into the or-group would make the task fire for
  // almost any alive, non-muted patient (confirmed by running it: it did).
  const pills = aif.locator('select.connector-pill');
  const pillCount = await pills.count();
  console.log('[fix] pill count:', pillCount);
  for (let i = 0; i < pillCount; i += 1) {
    const pill = pills.nth(i);
    const enabled = await pill.isEnabled().catch(() => false);
    const target = i < 6 ? 'or' : 'and';
    console.log(`[fix] pill[${i}] enabled=${enabled} -> setting ${target}`);
    if (enabled) await pill.selectOption(target);
  }

  const preview = await aif.locator('.preview pre').textContent();
  console.log('[fix] appliesIf preview after fix:', preview);
  await aif.getByRole('button', { name: 'Save' }).click();
  await expect(aif).toBeHidden();

  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible({ timeout: 20_000 });

  const fs = await import('node:fs/promises');
  const src = await fs.readFile(path.join(PROJECT, 'tasks.js'), 'utf8');
  const idx = src.indexOf("name: 'geriatric_referral_followup'");
  const start = src.lastIndexOf('{', idx);
  const appliesIfStart = src.indexOf('appliesIf:', start);
  const appliesToTypeIdx = src.indexOf('appliesToType:', appliesIfStart);
  const body = src.slice(appliesIfStart, appliesToTypeIdx);
  console.log('[fix] final appliesIf on disk:\n', body);
  const cognitiveLine = body.split('\n').find((l) => l.includes('refer_cognitive'));
  expect(cognitiveLine, 'refer_cognitive line exists').toBeTruthy();
  expect(cognitiveLine, 'all 7 flags must be OR-grouped on the SAME line/statement').toContain('refer_continence');
  for (const flag of ['refer_mobility', 'refer_nutrition', 'refer_vision', 'refer_hearing', 'refer_psych']) {
    expect(cognitiveLine, `${flag} on the same or-group line`).toContain(flag);
  }
  expect(cognitiveLine, 'alive/muted must NOT be merged into the flags or-group').not.toMatch(/isAlive|isMuted/);
  expect(body, 'alive check present as an independent guard').toMatch(/!isAlive\(contact\)/);
  expect(body, 'muted check present as an independent guard').toMatch(/isMuted\(contact\)/);
});
