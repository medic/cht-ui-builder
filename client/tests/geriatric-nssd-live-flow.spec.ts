/**
 * NSSD GERIATRIC — the live CHW loop on the deployed national config.
 *
 *   CHW logs in → opens the 60+ person (proves the c82_person + age gate)
 *   → fills the Integrated Health Assessment, failing the cognitive screen
 *   → [time simulation: the submitted report is backdated 20 days, because
 *      the workbook's window is start 15 / due 30 — the task is CORRECTLY
 *      invisible on day 0 and we keep the config truthful]
 *   → Tasks tab: the bilingual task appears
 *   → tap → the Geriatric care follow up form opens BRANCHED to just the
 *      failed domain (proves modifyContent delivery)
 *   → fill + submit → the task resolves.
 *
 *   pnpm --filter @cht-ui/client exec playwright test geriatric-nssd-live-flow.spec.ts
 *   $env:DEMO=1 ; ...same...    # slow-mo 2K video
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import https from 'node:https';

const INSTANCE = 'https://127-0-0-1.local-ip.medicmobile.org:10445';
const CHW = { user: 'nssd_chw', pass: 'NssdCare!2026x' };
const ELDER_ID = '8ad27ba1-3568-447d-88d1-be4b77d422ec';
const ELDER = 'Devi Kumari Thapa';
const IHA = 'integrated_health_assessment_form_for_elder_population';
const IHA_TITLE = 'Integrated Health Assessment form for elder population';
const FU_TITLE = 'Geriatric care follow up form';
const TASK_TITLE = 'Geriatric referral follow up';
const SLOW = process.env.DEMO ? Number(process.env.DEMO_MS ?? '900') : 0;

test.use({
  baseURL: INSTANCE,
  video: { mode: 'on', size: { width: 2560, height: 1440 } },
  viewport: { width: 2560, height: 1440 },
  ignoreHTTPSErrors: true,
  launchOptions: { slowMo: SLOW },
});

function chtReq(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((res, rej) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = https.request(
      new URL(INSTANCE + pathname),
      { method, rejectUnauthorized: false, headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from('medic:password').toString('base64'),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      } },
      (x) => { let s = ''; x.on('data', (d) => (s += d)); x.on('end', () => {
        try { res({ status: x.statusCode ?? 0, json: JSON.parse(s || '{}') }); }
        catch { res({ status: x.statusCode ?? 0, json: { raw: s.slice(0, 200) } }); }
      }); },
    );
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

async function beat(page: Page, ms: number) { if (SLOW) await page.waitForTimeout(ms); }
async function answer(page: Page, q: string, choice: string, kind: 'radio' | 'checkbox' = 'radio') {
  const el = page.locator('.question', { hasText: q }).first();
  await expect(el, `question: ${q}`).toBeVisible({ timeout: 120_000 });
  await el.getByRole(kind, { name: choice }).first().check();
}
async function nextPage(page: Page) {
  await page.getByRole('button', { name: 'Next >' }).click();
  await page.waitForTimeout(SLOW ? 500 : 150);
}

/** Wipe previous runs' geriatric reports so the demo starts clean. */
async function cleanup(): Promise<void> {
  const docs: Array<{ _id: string; _rev: string }> = [];
  for (const form of [IHA, 'geriatric_care_follow_up_form']) {
    const r = await chtReq('POST', '/medic/_find', { selector: { type: 'data_record', form }, limit: 100 });
    docs.push(...(r.json.docs ?? []));
  }
  if (docs.length) {
    await chtReq('POST', '/medic/_bulk_docs', { docs: docs.map((d) => ({ _id: d._id, _rev: d._rev, _deleted: true })) });
    console.log(`[live] cleanup: removed ${docs.length} previous geriatric reports`);
  }
}

test('NSSD geriatric — assessment → task → branched follow-up → resolved', async ({ page }) => {
  test.setTimeout(5_400_000);
  await cleanup();

  /* 1. CHW logs in. */
  await page.goto(`${INSTANCE}/medic/login?redirect=%2F`);
  const user = page.locator('#user');
  if (await user.isVisible().catch(() => false)) {
    await user.fill(CHW.user);
    await page.locator('#password').fill(CHW.pass);
    await page.locator('#login').click();
  }
  await expect(page.getByRole('link', { name: /Tasks/ })).toBeVisible({ timeout: 300_000 });
  await page.waitForTimeout(15_000); // initial replication of a big config
  await beat(page, 2000);

  /* 2. The 60+ person → the assessment is offered (c82_person + age gate). */
  await page.goto(`${INSTANCE}/#/contacts/${ELDER_ID}`);
  await expect(page.locator('.content-pane').getByRole('heading', { name: ELDER })).toBeVisible({ timeout: 300_000 });
  await beat(page, 2500);
  await page.locator('.content-pane mm-fast-action-button button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(IHA_TITLE)).toBeVisible({ timeout: 120_000 });
  await beat(page, 2000);
  await dialog.getByText(IHA_TITLE).click();
  await expect(page.locator('.question:visible').first()).toBeVisible({ timeout: 900_000 });
  await beat(page, 2000);

  /* 3. Page 1 — consent, plus the BMI / BP / sugar pulled from this config's
        existing hypertension + diabetes screening context values. */
  const introText = (await page.locator('.form-footer, .question:visible').allTextContents()).join(' ');
  console.log('[live] intro page shows NCD values:', /27\.6|138|145/.test(introText) ? 'YES' : 'not visible in text scrape');
  await answer(page, 'general check-in on your health', 'Agree');
  await beat(page, 2000);
  await nextPage(page);

  /* 4. Fail the cognitive screen; pass everything else. */
  await answer(page, 'Do you have trouble remembering', 'Yes (Fail)');
  await answer(page, 'repeat these 3 words', 'Unable to repeat all three words (Fail)');
  await answer(page, "today's full date", 'Both correct (Pass)');
  await beat(page, 1500);
  await nextPage(page);
  await answer(page, 'do you feel safe standing up', 'No (Do not test)');
  await nextPage(page);
  await answer(page, 'has your weight decreased', 'No (Pass)');
  await answer(page, 'belt become loose', 'No (Pass)');
  {
    const w = page.locator('.question', { hasText: 'Measure their weight' }).locator('input[type="number"]');
    if (await w.isVisible().catch(() => false)) await w.fill('62');
  }
  await nextPage(page);
  await answer(page, 'eye-related problems', 'No (Pass)');
  await answer(page, 'diabetes or high blood pressure', 'No (Pass)');
  await answer(page, 'Examine the external eye', 'None of the above', 'checkbox');
  await nextPage(page);
  await answer(page, 'Do you have trouble hearing', 'No (Pass)');
  await answer(page, 'Right ear result', 'Successfully repeated all four words (Pass)');
  await answer(page, 'Left ear result', 'Successfully repeated all four words (Pass)');
  await nextPage(page);
  await answer(page, 'persistently sad', 'No (Pass)');
  await answer(page, 'little interest or pleasure', 'No (Pass)');
  await answer(page, 'thoughts of harming yourself', 'No (Pass)');
  await nextPage(page);
  await answer(page, 'satisfied with the care', 'No (Pass)');
  await answer(page, 'not having enough money', 'No (Pass)');
  await answer(page, 'feel lonely', 'No (Pass)');
  await answer(page, 'activities you enjoy', 'No (Pass)');
  await nextPage(page);
  await answer(page, 'adequate support from your family', 'Yes, I receive sufficient support');
  await answer(page, 'feel confident that you can take good care', 'Yes, I know what to do');
  await answer(page, 'caregiving affected your own health', 'No');
  await answer(page, 'affected your own work or income', 'No difficulty');
  await nextPage(page);
  await answer(page, 'trouble holding your urine', 'No (Pass)');
  await nextPage(page);
  await beat(page, 2000);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('.content-pane').getByRole('heading', { name: ELDER })).toBeVisible({ timeout: 300_000 });
  await beat(page, 2500);

  /* 5. Flags really persisted? (the contract with the task)
        Enketo saves to the local PouchDB first, so poll the server rather
        than racing replication. */
  let report: any;
  for (let i = 0; i < 30 && !report; i += 1) {
    const found = await chtReq('POST', '/medic/_find', { selector: { type: 'data_record', form: IHA }, limit: 50 });
    report = (found.json.docs ?? []).sort((a: any, b: any) => b.reported_date - a.reported_date)[0];
    if (!report) await new Promise((r) => setTimeout(r, 4000));
  }
  expect(report, 'assessment report replicated to the server').toBeTruthy();
  const flat = JSON.stringify(report.fields);
  console.log('[live] refer_cognitive in report:', /"refer_cognitive":"true"/.test(flat) ? 'true' : flat.slice(0, 160));
  expect(flat).toContain('"refer_cognitive":"true"');

  /* 6. TIME SIMULATION — the workbook's window is start 15 / due 30, so the
        task is correctly invisible today. Backdate the report 20 days rather
        than weakening the config. */
  const twentyDays = 20 * 24 * 60 * 60 * 1000;
  report.reported_date = Date.now() - twentyDays;
  const put = await chtReq('PUT', `/medic/${report._id}`, report);
  expect(put.json.ok, 'backdate report').toBeTruthy();
  console.log('[live] ⏩ simulated 20 days passing (report backdated) so the 15/30/15 window is open');
  await page.reload();
  await page.waitForTimeout(20_000);

  /* 7. The task appears — bilingual title from item 8. */
  await page.goto(`${INSTANCE}/#/tasks`);
  let task = page.getByRole('link', { name: new RegExp(ELDER) }).first();
  for (let i = 0; i < 30; i += 1) {
    if (await task.isVisible().catch(() => false)) break;
    await page.waitForTimeout(20_000);
    if (i % 5 === 4) { await page.reload(); await page.waitForTimeout(10_000); await page.goto(`${INSTANCE}/#/tasks`); }
    task = page.getByRole('link', { name: new RegExp(ELDER) }).first();
  }
  await expect(task).toBeVisible({ timeout: 60_000 });
  await expect(task).toContainText(TASK_TITLE);
  console.log('[live] ✓ task visible with its translated title');
  await beat(page, 3000);

  /* 8. Tap → the follow-up, branched to the failed domain only. */
  await task.click();
  await expect(page.locator('.question:visible').first()).toBeVisible({ timeout: 900_000 });
  await expect(page.getByRole('heading', { name: new RegExp(FU_TITLE, 'i') })).toBeVisible({ timeout: 30_000 });
  await beat(page, 2000);
  const seen: string[] = [];
  const record = async () => {
    for (const t of await page.locator('.question:visible').allTextContents()) seen.push(t.replace(/\s+/g, ' ').trim().slice(0, 70));
  };
  await record();
  await answer(page, 'visit a relevant health facility', 'Yes');
  await nextPage(page); await record();
  await answer(page, 'formal examination', 'Yes');
  await nextPage(page); await record();
  {
    const diag = page.locator('.question:visible input[type="text"], .question:visible textarea').first();
    if (await diag.isVisible().catch(() => false)) {
      await diag.fill('Mild cognitive impairment — reviewed at facility');
      await nextPage(page); await record();
    }
  }
  await answer(page, 'medication or therapy started', 'Yes');
  await nextPage(page); await record();
  await answer(page, 'Improvement in memory', 'Improving'); // the branch
  await beat(page, 2500);
  await nextPage(page).catch(() => {});
  await record();
  const joined = seen.join(' | ');
  expect(joined, 'cognitive question shown').toContain('Improvement in memory');
  for (const hidden of ['sit-to-stand', 'weight increased', 'external condition of the eye', 'hearing ability', 'Psychological status', 'Urinary continence']) {
    expect(joined.toLowerCase(), `${hidden} hidden`).not.toContain(hidden.toLowerCase());
  }
  console.log('[live] ✓ follow-up branched to the cognitive domain only');

  const submit = page.getByRole('button', { name: 'Submit', exact: true });
  await expect(submit).toBeVisible({ timeout: 120_000 });
  await submit.click();
  await beat(page, 2500);

  /* 9. Resolved. */
  await page.goto(`${INSTANCE}/#/tasks`);
  await page.waitForTimeout(SLOW ? 8000 : 5000);
  await expect(page.getByRole('link', { name: new RegExp(ELDER) })).toHaveCount(0, { timeout: 120_000 });
  console.log('[live] ✓ task resolved by the follow-up submission — FULL LIFECYCLE PROVEN ON THE NATIONAL CONFIG');
  await beat(page, 2500);
});
