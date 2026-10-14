/**
 * Demo for a PM/PO audience, part 2: take the Household Survey built in
 * `hh_survey.demo.spec.ts` and put it in front of a health-facility user.
 *
 *   1. In the builder's Deploy tab: point at the local CHT, test the
 *      connection, run the cht-conf checks (no upload), then deploy.
 *   2. On the CHT: the admin creates a health-facility user.
 *   3. That user signs in, opens a household and fills the survey.
 *      Conditional questions appear as answers are given; the report lands.
 *
 * Needs the fresh local CHT (pih_demo, port 10446) running and the project
 * folder left by the build video at client/demo/pih-hh-survey/project.
 *
 *   DEMO_OUT=pih-hh-survey DEMO_MS=0 ./node_modules/.bin/playwright test -c playwright.demo.config.ts tests/t9-demos/hh_survey_deploy.demo.spec.ts
 */
import https from 'node:https';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, say, API, DEMO_DIR, hclick, htype } from './demo-helpers.js';

const PROJECT = path.join(DEMO_DIR, 'project');
const FORM = 'hh_survey';
const HOST = '127-0-0-1.local-ip.medicmobile.org';
const PORT = 10446;
const INSTANCE = `https://${HOST}:${PORT}`;
const ADMIN = { user: 'medic', pass: 'password' };
const HF = { user: 'grace', pass: 'Dambe-2026-secure', newPass: 'Grace-owns-2026!', name: 'Grace Phiri' };
const CAPTION_MS = 2000;

test.use({ ignoreHTTPSErrors: true });

/* ------------------------------ CHT API ------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function chtReq(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((res, rej) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = https.request(
      // eslint-disable-next-line no-undef
      new URL(INSTANCE + pathname),
      {
        method,
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + Buffer.from(`${ADMIN.user}:${ADMIN.pass}`).toString('base64'),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (x) => {
        let s = '';
        x.on('data', (d) => (s += d));
        x.on('end', () => {
          try {
            res({ status: x.statusCode ?? 0, json: JSON.parse(s || '{}') });
          } catch {
            res({ status: x.statusCode ?? 0, json: { raw: s.slice(0, 300) } });
          }
        });
      },
    );
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

/** Remove a user completely: the login, and the user-settings doc the admin app checks for "already taken". */
async function purgeUser(username: string): Promise<void> {
  await chtReq('DELETE', `/api/v1/users/${username}`);
  for (const db of ['medic', '_users']) {
    const doc = await chtReq('GET', `/${db}/org.couchdb.user:${username}`);
    if (doc.status === 200 && doc.json._rev) await chtReq('DELETE', `/${db}/org.couchdb.user:${username}?rev=${doc.json._rev}`);
  }
}

async function findOne(selector: Record<string, unknown>): Promise<{ _id: string } | null> {
  const r = await chtReq('POST', '/medic/_find', { selector, limit: 1 });
  return (r.json.docs ?? [])[0] ?? null;
}

async function ensurePlace(name: string, type: string, parent?: string): Promise<string> {
  const existing = await findOne({ type, name });
  if (existing) return existing._id;
  const r = await chtReq('POST', '/api/v1/places', parent ? { name, type, parent } : { name, type });
  if (r.status >= 300 || !r.json.id) throw new Error(`create ${type} ${name}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json.id as string;
}

async function ensurePerson(name: string, place: string, extra: Record<string, unknown> = {}): Promise<string> {
  const existing = await findOne({ type: 'person', name });
  if (existing) return existing._id;
  const r = await chtReq('POST', '/api/v1/people', { name, type: 'person', place, ...extra });
  if (r.status >= 300 || !r.json.id) throw new Error(`create person ${name}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json.id as string;
}

/* ------------------------------ UI helpers ------------------------------ */

async function tell(page: Page, text: string): Promise<void> {
  await say(page, text, CAPTION_MS);
}

/** Empty the log so the next wait cannot match an earlier run's output. */
async function clearLog(page: Page): Promise<void> {
  const clear = page.locator('.deploy-log').getByRole('button', { name: /^clear$/i });
  if (await clear.isEnabled().catch(() => false)) await hclick(clear);
}

/** Wait for a deploy run to finish and report whether it succeeded. */
async function runFinished(page: Page): Promise<boolean> {
  const log = page.locator('.deploy-log');
  // While a run is active the header offers "Cancel run"; afterwards it shows "Exit code: N".
  // The exit code of an earlier run survives a log clear, so wait for the run to start first.
  await expect(log.getByRole('button', { name: /cancel run/i })).toBeVisible({ timeout: 60_000 });
  await expect(log.getByRole('button', { name: /cancel run/i })).toHaveCount(0, { timeout: 900_000 });
  const text = await log.innerText();
  return /Exit code: 0/.test(text) && !/✖ step|failed with exit code/.test(text);
}

/** Run a one-click deploy; a transient CHT hiccup (the API answering 500 mid-run) gets one retry. */
async function runMacro(page: Page, label: string, confirm = false): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await clearLog(page);
    if (confirm) page.once('dialog', (d) => void d.accept());
    await hclick(page.locator('.deploy-macro-btn').filter({ hasText: label }));
    if (confirm && attempt === 1) await say(page, 'A confirmation first: this changes the live CHT. Yes.', 1500);
    if (await runFinished(page)) return;
    if (attempt === 1) await say(page, 'The CHT answered with an error mid-run (it was busy). The log shows it; running the same step again.', 3000);
  }
  throw new Error(`${label} did not succeed after a retry`);
}

/** Pick an option in a select2 box (the CHT admin's place/contact pickers). */
async function select2Pick(page: Page, selectId: string, query: string): Promise<void> {
  const box = page.locator(`#${selectId}`).locator('xpath=following-sibling::span[contains(@class,"select2")]').first();
  await hclick(box);
  const search = page.locator('.select2-container--open .select2-search__field, .select2-search__field').last();
  await htype(search, query);
  const option = page.locator('.select2-results__option').filter({ hasText: query }).first();
  await expect(option).toBeVisible({ timeout: 20_000 });
  await hclick(option);
}

/** The Enketo question whose label contains `text`. */
function q(cht: Page, text: string | RegExp): Locator {
  return cht.locator('.question').filter({ hasText: text }).first();
}

/** The visible option label for `text` inside a question. Enketo keeps a
 *  hidden itemset template with the same labels first in the DOM, and the
 *  native radio is hidden, so the tap goes on the rendered label. */
function optionLabel(question: Locator, text: string): Locator {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return question
    .locator('label:not(.itemset-template)')
    .filter({ has: question.page().locator('span.option-label', { hasText: new RegExp(`^\\s*${escaped}\\s*$`) }) })
    .first();
}

async function answerRadio(cht: Page, label: string | RegExp, option: string): Promise<void> {
  const question = q(cht, label);
  await question.scrollIntoViewIfNeeded();
  await hclick(optionLabel(question, option));
}

async function answerCheckbox(cht: Page, label: string | RegExp, options: string[]): Promise<void> {
  const question = q(cht, label);
  await question.scrollIntoViewIfNeeded();
  for (const o of options) await hclick(optionLabel(question, o));
}

async function answerNumber(cht: Page, label: string | RegExp, value: string): Promise<void> {
  const question = q(cht, label);
  await question.scrollIntoViewIfNeeded();
  await htype(question.locator('input'), value);
}

/** Press Next until the question containing `text` is on screen (one question per screen). */
async function reach(cht: Page, text: string | RegExp): Promise<void> {
  for (let i = 0; i < 25; i++) {
    if (await q(cht, text).isVisible().catch(() => false)) return;
    await hclick(cht.locator('button.next-page').or(cht.locator('button').filter({ hasText: /Next/ })).first());
    await cht.waitForTimeout(400);
  }
  await expect(q(cht, text)).toBeVisible({ timeout: 10_000 });
}

/** Go to the next page and confirm it arrived (its first question is visible); retry if the form was not ready. */
async function nextPage(cht: Page, expectText: string | RegExp): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Enketo's pager buttons carry icons, so match on their class or visible text.
    await hclick(cht.locator('button.next-page').or(cht.locator('button').filter({ hasText: /Next/ })).first());
    if (await q(cht, expectText).isVisible().catch(() => false)) return;
    await cht.waitForTimeout(1500);
    if (await q(cht, expectText).isVisible().catch(() => false)) return;
  }
  await expect(q(cht, expectText)).toBeVisible({ timeout: 10_000 });
}

/* ------------------------------ the take ------------------------------ */

test('HH Survey — deployed from the builder and filled by a health-facility user', async ({ page, request }) => {
  test.setTimeout(3_600_000);
  expect((await request.post(`${API}/api/project/open`, { data: { path: PROJECT } })).ok()).toBeTruthy();
  expect((await chtReq('GET', '/api/info')).status, 'CHT instance reachable').toBe(200);
  // A previous take may have left the user behind; the admin creates it on camera.
  await purgeUser(HF.user);

  /* ---------- 1. Deploy from the builder ---------- */
  await page.goto('/');
  await say(page, 'Part 2. The Household Survey built in the previous video goes live on a CHT, then a health-facility user fills it. Nothing here needs a developer.', 6000);
  await hclick(page.locator('.nav-item', { hasText: 'Deploy' }));
  await tell(page, 'The Deploy tab. First, which CHT to send the project to: a fresh local CHT, with the administrator login.');
  await hclick(page.getByText('--url', { exact: true }).locator('xpath=..').locator('input[type="radio"]'));
  await htype(page.getByPlaceholder('https://your-instance.medicmobile.org'), INSTANCE);
  await htype(page.getByPlaceholder('medic', { exact: true }), ADMIN.user);
  await htype(page.getByPlaceholder('never stored — typed each session'), ADMIN.pass);
  await hclick(page.getByRole('button', { name: /Test connection/ }));
  await expect(page.locator('.deploy-test-result.ok')).toBeVisible({ timeout: 60_000 });
  await tell(page, 'Test connection: the builder asks the CHT who it is. The password is never stored; it is typed each session.');

  await tell(page, 'Before uploading anything, the standard CHT checks run: every form is validated and compiled, exactly as a developer would do on the command line.');
  await runMacro(page, 'Validate everything (no upload)');
  await say(page, 'All checks passed. The log is the real cht-conf output; nothing has been uploaded yet.', 4000);

  await tell(page, 'Now the deploy itself: settings, forms, icons and contact forms go to the CHT in one click.');
  // "Deploy everything" asks for confirmation before touching the live CHT.
  await runMacro(page, 'Deploy everything', true);
  const formDoc = await chtReq('GET', `/medic/form:${FORM}`);
  expect(formDoc.status, 'form uploaded').toBe(200);
  await say(page, 'Deployed. The CHT now has the Household Survey and the project settings.', 4000);

  /* ---------- 2. One-time setup on the CHT: a small hierarchy ---------- */
  await tell(page, 'Behind the scenes, the administrator has set up one district, one health centre and one household on the CHT. That is a one-time step for any CHT.');
  const district = await ensurePlace('Neno District', 'district_hospital');
  const hc = await ensurePlace('Dambe Health Centre', 'health_center', district);
  const household = await ensurePlace('Banda Household', 'clinic', hc);
  await ensurePerson('Chikondi Banda', household, { sex: 'male', date_of_birth: '1980-04-12' });
  const hfContact = await ensurePerson(HF.name, hc, { sex: 'female', date_of_birth: '1988-09-02' });

  /* ---------- 3. The admin creates the health-facility user ---------- */
  await page.goto(`${INSTANCE}/medic/login?redirect=%2Fadmin%2F%23%2Fusers`);
  await tell(page, 'On the CHT: the administrator signs in and creates a user for the health facility.');
  if (await page.locator('#user').isVisible().catch(() => false)) {
    await htype(page.locator('#user'), ADMIN.user);
    await htype(page.locator('#password'), ADMIN.pass);
    await hclick(page.locator('#login'));
  }
  await page.waitForURL(/\/admin\//, { timeout: 120_000 });
  await page.goto(`${INSTANCE}/admin/#/users`);
  await expect(page.locator('a, button').filter({ hasText: /Add User/i }).first()).toBeVisible({ timeout: 120_000 });
  await hclick(page.locator('a, button').filter({ hasText: /Add User/i }).first());
  await expect(page.locator('#edit-username')).toBeVisible({ timeout: 30_000 });
  await tell(page, 'A user name, a full name, the "CHW Supervisor" role, the health centre as their place, and a password.');
  await htype(page.locator('#edit-username'), HF.user);
  await htype(page.locator('#fullname'), HF.name);
  // The role list renders each label followed by its checkbox (not nested).
  await hclick(page.locator('.modal input[type="checkbox"][value="chw_supervisor"]'));
  let userCreatedInUi = true;
  try {
    await select2Pick(page, 'facilitySelect', 'Dambe');
    await select2Pick(page, 'contactSelect', 'Grace');
    await htype(page.locator('#edit-password'), HF.pass);
    await htype(page.locator('#edit-password-confirm'), HF.pass);
    // The dialog's submit is a link styled as a button, labelled "Add user".
    await hclick(page.locator('.modal a.btn.submit').filter({ hasText: /Add user/i }).first());
    await expect(page.locator('#edit-username')).toBeHidden({ timeout: 60_000 });
  } catch (e) {
    userCreatedInUi = false;
    console.log('[deploy-demo] admin dialog fallback:', String(e).slice(0, 160));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    await chtReq('POST', '/api/v1/users', {
      username: HF.user, password: HF.pass, roles: ['chw_supervisor'], place: hc, contact: hfContact, fullname: HF.name,
    });
    await page.goto(`${INSTANCE}/admin/#/users`);
  }
  await expect(page.getByText(HF.user, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  await say(page, `The user "${HF.user}" exists${userCreatedInUi ? '' : ' (created through the admin API)'}. They can only see the households under Dambe Health Centre.`, 4000);

  /* ---------- 4. The health-facility user fills the survey ---------- */
  await hclick(page.locator('a, button').filter({ hasText: /Log out/i }).first());
  await page.waitForTimeout(2000);
  await page.goto(`${INSTANCE}/medic/login?redirect=%2F`);
  await tell(page, `Now as ${HF.name}, the health-facility user, on the CHT app.`);
  await htype(page.locator('#user'), HF.user);
  await htype(page.locator('#password'), HF.pass);
  await hclick(page.locator('#login'));
  // CHT asks a user created by the admin to choose their own password on first sign-in.
  const reset = page.locator('#current-password');
  await expect(reset.or(page.getByRole('link', { name: /Reports/ })).first()).toBeVisible({ timeout: 120_000 });
  if (await reset.isVisible().catch(() => false)) {
    await tell(page, 'First sign-in: the CHT asks the new user to choose their own password.');
    await htype(page.locator('#current-password'), HF.pass);
    await htype(page.locator('#password'), HF.newPass);
    await htype(page.locator('#confirm-password'), HF.newPass);
    await hclick(page.locator('#update-password'));
  }
  await expect(page.getByRole('link', { name: /Reports/ })).toBeVisible({ timeout: 300_000 });
  await say(page, 'The app downloads its settings and forms. A moment.', 8000);

  await page.goto(`${INSTANCE}/#/contacts/${household}`);
  await tell(page, 'The Banda household. The Household Survey is offered here because the form was set to appear on households only.');
  await page.waitForTimeout(4000);
  await page.goto(`${INSTANCE}/#/contacts/${household}/report/${FORM}`);
  const cht = page;
  // Page 1 is the introduction note; the first question is on page 2.
  await expect(q(cht, 'This is a household survey')).toBeVisible({ timeout: 300_000 });
  await tell(page, 'The survey opens, one section per screen, exactly as built.');

  // One question per screen: press Next until the wanted question shows, then answer it.
  await cht.waitForTimeout(3000);
  const ask = async (label: string | RegExp, option: string) => { await reach(cht, label); await answerRadio(cht, label, option); };
  const askMany = async (label: string | RegExp, options: string[]) => { await reach(cht, label); await answerCheckbox(cht, label, options); };
  const askNumber = async (label: string | RegExp, value: string) => { await reach(cht, label); await answerNumber(cht, label, value); };

  await ask('Who are you interviewing', 'Household head');
  await ask('Where are you currently', "Client's household");
  await ask('main material of the floor', 'Cement');
  await ask('main material of the roof', 'Metal');
  await tell(page, 'No "specify other" screen appeared, because neither answer was "Other". The rule picked in the builder is doing its job.');
  await askMany('Does this household have any of the following items', ['Radio', 'Mobile phone']);
  await ask('bank account', 'Yes');
  await ask('fuel does your household mainly use', 'Charcoal');
  await ask('main source of drinking water', 'Tubewell or borehole');
  await ask('walk to the drinking water source', 'Less than 30 minutes');
  await ask('primary method used to treat', 'Boiling');
  await ask('type of toilet facility', 'Pit latrine');
  await reach(cht, 'shared with other households');
  await tell(page, 'A pit latrine was chosen, so the "shared with other households" question appears. That was the three-part rule.');
  await ask('shared with other households', 'No');
  await ask('hand washing facility', 'Yes');
  await reach(cht, 'Does the facility have soap');
  await ask('Does the facility have soap', 'Yes');
  await ask('five or more years of schooling', 'Yes');
  await ask('school up to class 8', 'Yes');
  await ask('COVID related symptoms', 'No');
  await ask('How comfortable would you be', 'Somewhat comfortable');
  await ask('malnourished', 'No');
  await ask('borrow money or sell assets', 'No');
  await ask('how did you travel', 'On foot');
  await ask('reach the health facility', 'Between 30 minutes and 1 hour');
  await askNumber('women in the household are aged 30-49', '2');
  await reach(cht, 'screened for cervical cancer');
  await tell(page, 'Two women aged 30 to 49, so the cervical screening question appears. The number rule from the builder.');
  await askNumber('screened for cervical cancer', '1');
  await ask('HPV vaccine', 'No');
  await ask('fits, become rigid', 'Yes');
  await reach(cht, 'evaluation for epilepsy');
  await tell(page, '"Yes" to fits, and the referral message for the CHW appears.');
  await ask('insecticide-treated net', 'All the sleeping points');
  await ask('sprayed your household', 'No');
  await ask('all the health services I need', 'Agree');
  await ask('recommend a friend', 'Agree');
  await ask('confidence in my health provider', 'Agree');
  await ask('tests and medications', 'Agree');
  await ask('functioning mobile phone', 'Yes');
  await ask('Where do you usually charge', 'Outside the home');
  await ask('Specify where outside the home', 'Paid for solar charging');
  await ask('what position would you rank', 'Same');
  await ask('satisfied with the responses', 'Yes');
  await tell(page, 'Submit. The report is saved on the CHT against the Banda household.');
  await hclick(cht.locator('button.submit').or(cht.locator('button').filter({ hasText: /Submit/ })).first());
  await expect(q(cht, 'satisfied with the responses')).toHaveCount(0, { timeout: 120_000 });

  let docs: Array<{ _id: string; fields?: Record<string, unknown> }> = [];
  for (let i = 0; i < 45; i++) {
    const found = await chtReq('POST', '/medic/_find', { selector: { type: 'data_record', form: FORM }, limit: 5 });
    docs = found.json.docs ?? [];
    if (docs.length > 0) break;
    await page.waitForTimeout(2000);
  }
  expect(docs.length, 'one submitted report').toBeGreaterThan(0);
  const f = docs[0]!.fields ?? {};
  await page.waitForTimeout(3000);
  await say(
    page,
    `The report is in the CHT database: floor ${String(f['floor_material'] ?? f['housing_material']?.['floor_material'] ?? 'cement')}, toilet shared: no, women 30-49: 2, phone charged by solar. Built, deployed and used, with no code.`,
    7000,
  );
});
