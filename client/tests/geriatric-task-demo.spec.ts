/**
 * GERIATRIC TASK-LIFECYCLE DEMO (recording, not a CI test) — one continuous
 * take of the CHW runtime loop on the live instance:
 *
 *   open the 60+ patient → fill the Integrated Health Assessment, FAILING the
 *   cognitive screen → Tasks tab: "Geriatric referral follow-up" appears →
 *   tap it → the Referral Follow-up opens BRANCHED to just the failed domain
 *   → fill + submit → the task disappears.
 *
 * Prereqs (all live already): the geriatric-workflow app deployed with the
 * day-0 window variant (days 30 / start 30), geri_chw user, clinic. The
 * patient is seeded via API off-camera; every form interaction is real and
 * on-camera.
 *
 *   pnpm --filter @cht-ui/client exec playwright test geriatric-task-demo.spec.ts   # fast check
 *   $env:DEMO=1 ; ...same...                                                        # slow-mo video
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

const INSTANCE = 'https://127-0-0-1.local-ip.medicmobile.org:10445';
const CHW = { user: 'geri_chw', pass: 'ElderCare!2026z' };
const CLINIC_ID = 'cacc1138-db44-4ca8-88fb-803aee5edf77';
const SLOW = process.env.DEMO ? Number(process.env.DEMO_MS ?? '1000') : 0;

test.use({
  baseURL: INSTANCE,
  video: { mode: 'on', size: { width: 2560, height: 1440 } },
  viewport: { width: 2560, height: 1440 },
  ignoreHTTPSErrors: true,
  launchOptions: { slowMo: SLOW },
});

function chtPost(pathname: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const r = https.request(
      new URL(INSTANCE + pathname),
      { method: 'POST', rejectUnauthorized: false, headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from('medic:password').toString('base64'),
        'Content-Length': Buffer.byteLength(data),
      } },
      (x) => { let s = ''; x.on('data', (d) => (s += d)); x.on('end', () => res({ status: x.statusCode ?? 0, json: JSON.parse(s || '{}') })); },
    );
    r.on('error', rej); r.write(data); r.end();
  });
}


/** Form boot can take minutes on a CPU-starved machine — one PATIENT wait
 *  (reloading restarts replication and makes it worse). */
async function waitFirstQuestion(page: Page): Promise<boolean> {
  try {
    await expect(page.locator('.question:visible').first()).toBeVisible({ timeout: 900_000 });
    return true;
  } catch {
    return false;
  }
}

async function beat(page: Page, ms: number): Promise<void> {
  if (SLOW) await page.waitForTimeout(ms);
}

async function answer(page: Page, qSnippet: string, choiceEn: string, kind: 'radio' | 'checkbox' = 'radio') {
  const q = page.locator('.question', { hasText: qSnippet }).first();
  await expect(q).toBeVisible({ timeout: 120_000 });
  await q.getByRole(kind, { name: choiceEn }).first().check();
}
async function nextPage(page: Page) {
  await page.getByRole('button', { name: 'Next >' }).click();
  await page.waitForTimeout(SLOW ? 600 : 150);
}

test('geriatric demo — assessment → task fires → branched follow-up filled → task resolves', async ({ page }) => {
  test.setTimeout(5_400_000); // slow machines are the realistic field condition

  // Off-camera: a fresh 66-year-old under the CHW's clinic.
  const elderId = randomUUID();
  const seed = await chtPost('/medic', {
    _id: elderId, type: 'person', name: 'Maiya Gurung', sex: 'female',
    date_of_birth: '1960-02-11', parent: { _id: CLINIC_ID }, reported_date: Date.now(),
  });
  expect(seed.json.ok, 'seed elder').toBeTruthy();

  // 1. CHW logs in.
  await page.goto(`${INSTANCE}/medic/login?redirect=%2F`);
  const user = page.locator('#user');
  if (await user.isVisible().catch(() => false)) {
    await user.fill(CHW.user);
    await page.locator('#password').fill(CHW.pass);
    await page.locator('#login').click();
  }
  await expect(page.getByRole('link', { name: /Tasks/ })).toBeVisible({ timeout: 300_000 });
  // Let the initial replication finish before opening forms (starved CPU).
  await page.waitForTimeout(15_000);
  await beat(page, 2000);

  // 2. Her profile → the (60+-gated) Integrated Health Assessment.
  await page.goto(`${INSTANCE}/#/contacts/${elderId}`);
  await expect(page.locator('.content-pane').getByRole('heading', { name: 'Maiya Gurung' })).toBeVisible({ timeout: 300_000 });
  await beat(page, 2500);
  await page.locator('.content-pane mm-fast-action-button button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Integrated Health Assessment')).toBeVisible({ timeout: 120_000 });
  await beat(page, 2000);
  await dialog.getByText('Integrated Health Assessment').click();
  expect(await waitFirstQuestion(page), 'assessment form rendered').toBe(true);
  await beat(page, 2000);

  // 3. Fill the assessment — FAIL the cognitive screen, pass everything else.
  await answer(page, 'Do you have trouble remembering', 'Yes (Fail)');
  await beat(page, 1200);
  await answer(page, 'repeat these 3 words', 'Unable to repeat all three words (Fail)');
  await answer(page, "today's full date", 'Both correct (Pass)');
  await beat(page, 1500);
  await nextPage(page); // → Mobility
  await answer(page, 'do you feel safe standing up', 'No (Do not test)');
  await nextPage(page); // → Nutrition
  await answer(page, 'has your weight decreased', 'No (Pass)');
  await answer(page, 'belt become loose', 'No (Pass)');
  {
    const w = page.locator('.question', { hasText: 'Measure their weight' }).locator('input[type="number"]');
    if (await w.isVisible().catch(() => false)) await w.fill('58');
  }
  await nextPage(page); // → Vision
  await answer(page, 'eye-related problems', 'No (Pass)');
  await answer(page, 'diabetes or high blood pressure', 'No (Pass)');
  await answer(page, 'Examine the external eye', 'None of the above', 'checkbox');
  await nextPage(page); // → Hearing
  await answer(page, 'Do you have trouble hearing', 'No (Pass)');
  await answer(page, 'Right ear result', 'Successfully repeated all four words (Pass)');
  await answer(page, 'Left ear result', 'Successfully repeated all four words (Pass)');
  await nextPage(page); // → Psychological
  await answer(page, 'persistently sad', 'No (Pass)');
  await answer(page, 'little interest or pleasure', 'No (Pass)');
  await answer(page, 'thoughts of harming yourself', 'No (Pass)');
  await nextPage(page); // → Social
  await answer(page, 'satisfied with the care', 'No (Pass)');
  await answer(page, 'not having enough money', 'No (Pass)');
  await answer(page, 'feel lonely', 'No (Pass)');
  await answer(page, 'activities you enjoy', 'No (Pass)');
  await nextPage(page); // → Caregiver
  await answer(page, 'adequate support from your family', 'Yes, I receive sufficient support');
  await answer(page, 'feel confident that you can take good care', 'Yes, I know what to do');
  await answer(page, 'caregiving affected your own health', 'No');
  await answer(page, 'affected your own work or income', 'No difficulty');
  await nextPage(page); // → Continence
  await answer(page, 'trouble holding your urine', 'No (Pass)');
  await nextPage(page); // → Lifestyle advice (note page)
  await beat(page, 2500);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('.content-pane').getByRole('heading', { name: 'Maiya Gurung' })).toBeVisible({ timeout: 300_000 });
  await beat(page, 3000);

  // 4. Tasks tab — the referral follow-up task fires for the failed screen.
  await page.goto(`${INSTANCE}/#/tasks`);
  let task = page.getByRole('link', { name: /Maiya Gurung/ }).first();
  // The rules engine can take MANY minutes on a slow machine — poll up to
  // ~20 min, nudging with an occasional reload.
  for (let i = 0; i < 60; i += 1) {
    if (await task.isVisible().catch(() => false)) break;
    await page.waitForTimeout(20_000);
    if (i % 6 === 5) {
      await page.reload();
      await page.waitForTimeout(8000);
      await page.goto(`${INSTANCE}/#/tasks`);
    }
    task = page.getByRole('link', { name: /Maiya Gurung/ }).first();
  }
  await expect(task).toBeVisible({ timeout: 60_000 });
  await expect(task).toContainText('Geriatric referral follow-up');
  await beat(page, 3500);

  // 5. Tap → the follow-up opens, branched to ONLY the cognitive domain.
  await task.click();
  expect(await waitFirstQuestion(page), 'follow-up form rendered').toBe(true);
  await beat(page, 2500);
  await answer(page, 'visit a relevant health facility', 'Yes');
  await beat(page, 1500);
  await nextPage(page);
  await answer(page, 'formal examination', 'Yes');
  await nextPage(page);
  {
    const diag = page.locator('.question:visible input[type="text"], .question:visible textarea').first();
    if (await diag.isVisible().catch(() => false)) {
      await diag.fill('Mild cognitive impairment — reviewed at facility');
      await beat(page, 1500);
      await nextPage(page);
    }
  }
  await answer(page, 'medication or therapy started', 'Yes');
  await nextPage(page);
  // THE BRANCH: only the cognitive row shows (memory improvement).
  await answer(page, 'Improvement in memory', 'Improving');
  await beat(page, 3000);
  await nextPage(page).catch(() => {});
  const submit = page.getByRole('button', { name: 'Submit', exact: true });
  await expect(submit).toBeVisible({ timeout: 120_000 });
  await submit.click();
  await beat(page, 3000);

  // 6. Back on Tasks — the task is GONE (resolved by the submission).
  await page.goto(`${INSTANCE}/#/tasks`);
  await page.waitForTimeout(SLOW ? 6000 : 4000);
  await expect(page.getByRole('link', { name: /Maiya Gurung/ })).toHaveCount(0, { timeout: 60_000 });
  await beat(page, 3000);
  console.log('[demo] full task lifecycle on camera: assessment → task → branched follow-up → resolved');
});
