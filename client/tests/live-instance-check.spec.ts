/**
 * T9g (#20) — June acceptance 4: a condition authored through the picker
 * MATCHES AT RUNTIME on a live CHT instance, verified with real data.
 *
 * Journey:
 *   1. In the builder (desktop mode, scratch copy of mini-config whose
 *      pregnancy form is duplicated as `t9g_live_check`), author through
 *      the UI only: gravidity shows when chair_rise includes "pass" (the
 *      inline strip), and accepts 0..20 with a message (the Validation
 *      panel). Save.
 *   2. Deploy that one form to the local CHT instance with cht-conf inside
 *      the `cht-ui-builder` image (`convert-app-forms upload-app-forms`).
 *   3. As the CHW, open the form on the instance: the gravidity question
 *      is hidden; choose "Pass" and it shows; enter 25 and the form shows
 *      the message and refuses to submit; enter 10 and submit; the report
 *      exists in CouchDB with `fields.gravidity === "10"`.
 *   4. Remove the report and the form docs again.
 *
 * Skipped when the instance or Docker is not reachable. Record ids are
 * printed so a manual re-check can find them.
 */
import { test, expect } from './setup.js';
import type { Locator, Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(here, 'fixtures', 'mini-config');
const API = 'http://127.0.0.1:5174';
const INSTANCE_HOST = '127-0-0-1.local-ip.medicmobile.org';
const INSTANCE = `https://${INSTANCE_HOST}:10445`;
const ADMIN = { user: 'medic', pass: 'password' };
const CHW = { user: 'nssd_chw', pass: 'NssdCare!2026x' };
const FORM = 't9g_live_check';
const IMAGE = 'cht-ui-builder:latest';

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
            res({ status: x.statusCode ?? 0, json: { raw: s.slice(0, 200) } });
          }
        });
      },
    );
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

async function instanceUp(): Promise<boolean> {
  try {
    return (await chtReq('GET', '/api/info')).status === 200;
  } catch {
    return false;
  }
}

function dockerUp(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

function rowByType(page: Page, rawType: RegExp): Locator {
  return page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: rawType }) });
}

async function removeDeployed(): Promise<void> {
  const r = await chtReq('POST', '/medic/_find', { selector: { type: 'data_record', form: FORM }, limit: 50 });
  const docs: Array<{ _id: string; _rev: string }> = r.json.docs ?? [];
  const formDoc = await chtReq('GET', `/medic/form:${FORM}`);
  if (formDoc.status === 200) docs.push({ _id: formDoc.json._id, _rev: formDoc.json._rev });
  if (docs.length) {
    await chtReq('POST', '/medic/_bulk_docs', { docs: docs.map((d) => ({ _id: d._id, _rev: d._rev, _deleted: true })) });
  }
}

test('T9g — a relevance and a constraint authored by picking match at runtime on the live instance', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(900_000);
  test.skip(!(await instanceUp()), `CHT instance at ${INSTANCE} is not reachable`);
  test.skip(!dockerUp(), 'Docker is not running (cht-conf runs inside the image)');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-t9g-live-'));
  try {
    await fs.cp(FIXTURE_DIR, tmp, { recursive: true });
    // The deployable copy: its own form id, its own title, visible everywhere.
    await fs.copyFile(
      path.join(tmp, 'forms', 'app', 'pregnancy.xlsx'),
      path.join(tmp, 'forms', 'app', `${FORM}.xlsx`),
    );
    await fs.writeFile(
      path.join(tmp, 'forms', 'app', `${FORM}.properties.json`),
      JSON.stringify(
        {
          title: [
            { locale: 'en', content: 'T9g live check' },
            { locale: 'ne', content: 'T9g live check' },
          ],
          context: { person: false, place: false },
        },
        null,
        2,
      ),
    );
    expect((await request.post(`${API}/api/project/open`, { data: { path: tmp } })).ok()).toBeTruthy();

    /* 1. Author by picking. */
    await page.goto('/');
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: `${FORM}.xlsx` }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();
    // The fixture marks the LMP date required; this check submits only the
    // two questions it tests, so untick it (through the UI, like everything else).
    const lmp = rowByType(page, /^date$/);
    await lmp.getByRole('checkbox', { name: 'required' }).uncheck();
    const gravidity = rowByType(page, /^integer$/);
    await gravidity.getByRole('button', { name: /show advanced/ }).click();
    const strip = gravidity.locator('.cond-strip-unified[data-column="relevant"]');
    const dd = strip.locator('.ref-chip-select');
    await dd.nth(0).selectOption('chair_rise');
    await dd.nth(1).selectOption('selected');
    await strip.locator('select[title="Pick a value from this field\'s choices"]').selectOption('pass');
    await strip.getByRole('button', { name: 'Apply', exact: true }).click();
    const panel = gravidity.getByTestId('validation-panel');
    await panel.getByRole('combobox', { name: 'Add a validation rule' }).selectOption({ label: 'Between two values' });
    await panel.getByRole('spinbutton', { name: 'Minimum' }).fill('0');
    await panel.getByRole('spinbutton', { name: 'Maximum' }).fill('20');
    await expect(panel.getByPlaceholder('Message shown when the answer is rejected')).toHaveValue('Must be between 0 and 20');
    await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true })).toBeVisible();

    const saved = (await (await request.get(`${API}/api/forms/app:${FORM}`)).json()) as {
      form: { survey: Array<{ name?: string; extras: Record<string, string> }> };
    };
    const grav = saved.form.survey.find((r) => r.name === 'gravidity')!;
    expect(grav.extras['relevant']).toBe("selected(${chair_rise}, 'pass')");
    expect(grav.extras['constraint']).toBe('. >= 0 and . <= 20');

    // cht-conf insists the file name equals the sheet's form_id; the copy
    // still carries the fixture's. Set it through the builder's API (the
    // same save path the Settings tab uses), nothing else changes.
    const full = (await (await request.get(`${API}/api/forms/app:${FORM}`)).json()) as {
      form: { settings: Record<string, unknown> } & Record<string, unknown>;
      properties?: unknown;
    };
    full.form.settings = { ...full.form.settings, form_id: FORM, form_title: 'T9g live check' };
    const put = await request.put(`${API}/api/forms/app:${FORM}`, {
      data: { form: full.form, properties: full.properties ?? null },
    });
    expect(put.ok()).toBeTruthy();

    /* 2. Deploy that form with cht-conf inside the image. */
    await removeDeployed();
    const url = `https://${ADMIN.user}:${ADMIN.pass}@${INSTANCE_HOST}:10445`;
    const out = execFileSync(
      'docker',
      [
        'run', '--rm',
        '--add-host', `${INSTANCE_HOST}:host-gateway`,
        '-e', 'NODE_TLS_REJECT_UNAUTHORIZED=0',
        '-v', `${tmp}:/proj`,
        '-w', '/proj',
        IMAGE,
        'sh', '-c',
        `/app/server/node_modules/.bin/cht --url=${url} --skip-dependency-check --skip-validate --force convert-app-forms upload-app-forms -- ${FORM} 2>&1 | tail -15`,
      ],
      { encoding: 'utf8', timeout: 300_000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
    console.log('[live] cht-conf:', out.trim().split('\n').slice(-6).join(' | '));
    const formDoc = await chtReq('GET', `/medic/form:${FORM}`);
    expect(formDoc.status, 'form uploaded').toBe(200);

    /* 3. On the instance, as the CHW. */
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
    const cht = await ctx.newPage();
    try {
      await cht.goto(`${INSTANCE}/medic/login?redirect=%2F`);
      const user = cht.locator('#user');
      if (await user.isVisible().catch(() => false)) {
        await user.fill(CHW.user);
        await cht.locator('#password').fill(CHW.pass);
        await cht.locator('#login').click();
      }
      await expect(cht.getByRole('link', { name: /Reports/ })).toBeVisible({ timeout: 300_000 });
      await cht.waitForTimeout(10_000); // let replication pick up the new form

      await cht.goto(`${INSTANCE}/#/reports/add/${FORM}`);
      const chairQ = cht.locator('.question', { hasText: 'Chair rise test' }).first();
      await expect(chairQ).toBeVisible({ timeout: 300_000 });
      const gravQ = cht.locator('.question', { hasText: 'Number of pregnancies' }).first();
      // Hidden until chair rise is "Pass".
      await expect(gravQ).toBeHidden();
      await chairQ.getByRole('radio', { name: 'Pass' }).check();
      await expect(gravQ).toBeVisible({ timeout: 30_000 });

      // 25 is rejected with the authored message; the form does not submit.
      const gravInput = gravQ.locator('input');
      await gravInput.fill('25');
      await gravInput.blur();
      await expect(gravQ.locator('.or-constraint-msg.active, .invalid-constraint .or-constraint-msg')).toContainText('Must be between 0 and 20', { timeout: 30_000 });
      await cht.getByRole('button', { name: /^Submit$/ }).click();
      await expect(cht.locator('.question', { hasText: 'Number of pregnancies' }).first()).toBeVisible();
      let found = await chtReq('POST', '/medic/_find', { selector: { type: 'data_record', form: FORM }, limit: 10 });
      expect(found.json.docs ?? []).toHaveLength(0);

      // 10 is accepted and the report lands in CouchDB.
      await gravInput.fill('10');
      await gravInput.blur();
      await expect(gravQ).not.toHaveClass(/invalid-constraint/);
      await cht.getByRole('button', { name: /^Submit$/ }).click();
      await expect(cht.locator('.question', { hasText: 'Number of pregnancies' })).toHaveCount(0, { timeout: 60_000 });
      for (let i = 0; i < 30; i++) {
        found = await chtReq('POST', '/medic/_find', { selector: { type: 'data_record', form: FORM }, limit: 10 });
        if ((found.json.docs ?? []).length > 0) break;
        await cht.waitForTimeout(2000);
      }
      const docs = found.json.docs as Array<{ _id: string; fields?: Record<string, unknown> }>;
      expect(docs.length, 'one submitted report').toBeGreaterThan(0);
      console.log(`[live] report ${docs[0]!._id} fields.gravidity=${String(docs[0]!.fields?.['gravidity'])}`);
      expect(String(docs[0]!.fields?.['gravidity'])).toBe('10');
    } finally {
      await ctx.close();
    }
  } finally {
    await removeDeployed().catch(() => {});
    await request.post(`${API}/api/project/open`, { data: { path: FIXTURE_DIR } });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
