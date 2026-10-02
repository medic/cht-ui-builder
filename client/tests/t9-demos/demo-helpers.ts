/**
 * Shared helpers for the T9 feature demos. Each `*.demo.spec.ts` is one
 * continuous take with on-screen captions; the video lands in
 * `client/demo/t9/<ticket>.webm` (plus an .mp4 when ffmpeg is installed)
 * when the page closes, next to `client/demo/t9/README.md`, which says what
 * each video shows and how to replay it by hand.
 *
 * Run with `playwright.demo.config.ts` — that config turns video on and
 * slows actions down; under the normal config these specs are ignored.
 */
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.resolve(here, '..', 'fixtures', 'mini-config');
export const API = 'http://127.0.0.1:5174';
export const DEMO_DIR = path.resolve(here, '..', '..', 'demo', 't9');

export type SurveyRow = {
  name?: string;
  type: string;
  required?: string;
  labels?: Record<string, string>;
  extras: Record<string, string>;
};
export type FormBody = { form: { survey: SurveyRow[] }; properties?: unknown };
type Request = Parameters<Parameters<typeof base>[1]>[0]['request'];

/**
 * Fixture: a throwaway copy of mini-config is the open project for the
 * test; the video is copied to `demo/t9/<ticket>.webm` afterwards, where
 * `<ticket>` is the spec's basename (`t9e.demo.spec.ts` → `t9e.webm`).
 */
export const test = base.extend<{ scratch: string }>({
  scratch: [
    async ({ request }, use) => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-t9demo-'));
      await fs.cp(FIXTURE_DIR, tmp, { recursive: true });
      const res = await request.post(`${API}/api/project/open`, { data: { path: tmp } });
      if (!res.ok()) throw new Error(`open ${tmp}: ${res.status()}`);
      await use(tmp);
      await request.post(`${API}/api/project/open`, { data: { path: FIXTURE_DIR } });
      await fs.rm(tmp, { recursive: true, force: true });
    },
    { auto: true },
  ],
  page: async ({ page }, run, testInfo) => {
    // Captions survive a reload: the init script re-creates the banner
    // from sessionStorage on every document.
    await page.addInitScript(() => {
      // eslint-disable-next-line no-undef
      const w = window as unknown as { __demoCaption?: (t: string) => void };
      w.__demoCaption = (text: string) => {
        // eslint-disable-next-line no-undef
        const d = document;
        let el = d.getElementById('__demo-caption');
        if (!el) {
          el = d.createElement('div');
          el.id = '__demo-caption';
          el.style.cssText =
            'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:14px 24px;' +
            'background:rgba(20,24,34,.92);color:#fff;font:600 20px/1.35 system-ui,Segoe UI,sans-serif;' +
            'letter-spacing:.01em;pointer-events:none;box-shadow:0 -2px 12px rgba(0,0,0,.35)';
          (d.body ?? d.documentElement).appendChild(el);
        }
        el.textContent = text;
        el.style.display = text ? 'block' : 'none';
        try {
          // eslint-disable-next-line no-undef
          sessionStorage.setItem('__demoCaption', text);
        } catch {
          /* ignore */
        }
      };
      // eslint-disable-next-line no-undef
      document.addEventListener('DOMContentLoaded', () => {
        try {
          // eslint-disable-next-line no-undef
          const t = sessionStorage.getItem('__demoCaption');
          if (t) w.__demoCaption!(t);
        } catch {
          /* ignore */
        }
      });
    });
    await run(page);
    const video = page.video();
    await page.close();
    if (video) {
      await fs.mkdir(DEMO_DIR, { recursive: true });
      // The replay notes live beside the specs and beside the videos.
      await fs.copyFile(path.join(here, 'README.md'), path.join(DEMO_DIR, 'README.md'));
      const ticket = path.basename(testInfo.file).replace(/\.demo\.spec\.ts$/, '');
      const dest = path.join(DEMO_DIR, `${ticket}.webm`);
      await video.saveAs(dest);
      testInfo.annotations.push({ type: 'video', description: dest });
      console.log(`[demo] ${ticket} → ${dest}`);
      // An MP4 beside it for GitHub issue comments, when ffmpeg is on PATH.
      try {
        const mp4 = dest.replace(/\.webm$/, '.mp4');
        execFileSync(
          'ffmpeg',
          ['-y', '-loglevel', 'error', '-i', dest, '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4],
          { stdio: 'ignore' },
        );
        console.log(`[demo] ${ticket} → ${mp4}`);
      } catch {
        /* no ffmpeg: the .webm is still there */
      }
    }
  },
});

export { expect };

/** Show a caption at the bottom of the frame and hold for `holdMs`. */
export async function say(page: Page, text: string, holdMs = 1800): Promise<void> {
  await page.evaluate((t) => {
    // eslint-disable-next-line no-undef
    (window as unknown as { __demoCaption?: (t: string) => void }).__demoCaption?.(t);
  }, text);
  await page.waitForTimeout(holdMs);
}

/** A narration pause. */
export async function beat(page: Page, ms = 1200): Promise<void> {
  await page.waitForTimeout(ms);
}

export async function openPregnancy(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
  await expect(page.locator('.survey-row').first()).toBeVisible();
}

export function rowByType(page: Page, rawType: RegExp): Locator {
  return page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: rawType }) });
}

/** The row card whose name textbox reads `name` (controlled inputs carry no value attribute). */
export async function rowByName(page: Page, name: string): Promise<Locator> {
  const rows = page.locator('.survey-row').filter({
    has: page.getByRole('textbox', { name: 'name', exact: true }),
  });
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    if ((await row.getByRole('textbox', { name: 'name', exact: true }).inputValue()) === name) return row;
  }
  throw new Error(`no row named ${name}`);
}

export async function showAdvanced(row: Locator): Promise<void> {
  await row.scrollIntoViewIfNeeded();
  const btn = row.getByRole('button', { name: /show advanced/ });
  if ((await btn.count()) > 0) await btn.click();
}

/** Open the row's advanced panel and return the sentence strip for `column`. */
export async function openStrip(
  row: Locator,
  column: 'relevant' | 'choice_filter',
): Promise<Locator> {
  await showAdvanced(row);
  const strip = row.locator(`.cond-strip-unified[data-column="${column}"]`);
  await expect(strip).toBeVisible();
  await strip.scrollIntoViewIfNeeded();
  return strip;
}

export async function openPanel(row: Locator): Promise<Locator> {
  await showAdvanced(row);
  const panel = row.getByTestId('validation-panel');
  await expect(panel).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  return panel;
}

export function rawColumnInput(row: Locator, column: string): Locator {
  return row
    .locator('label.expr-field')
    .filter({ has: row.page().locator('code.raw-col-tag', { hasText: new RegExp(`^${column}$`) }) })
    .locator('input')
    .first();
}

export async function saveForm(page: Page): Promise<void> {
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible();
}

export async function getForm(request: Request): Promise<FormBody> {
  return (await (await request.get(`${API}/api/forms/app:pregnancy`)).json()) as FormBody;
}

export async function seedCells(
  request: Request,
  seed: Record<string, Record<string, string>>,
): Promise<void> {
  const body = await getForm(request);
  for (const row of body.form.survey) {
    const s = row.name ? seed[row.name] : undefined;
    if (s) row.extras = { ...row.extras, ...s };
  }
  const put = await request.put(`${API}/api/forms/app:pregnancy`, {
    data: { form: body.form, properties: body.properties ?? null },
  });
  expect(put.ok()).toBeTruthy();
}

/** `extras[column]` of the named row, as the server re-parsed it from disk. */
export async function cellOnDisk(request: Request, name: string, column: string): Promise<string | undefined> {
  const body = await getForm(request);
  return body.form.survey.find((r) => r.name === name)?.extras[column];
}

/** Prefer the one-click tiles off/on for this page (the configure step). */
export async function setOneClickTiles(page: Page, on: boolean): Promise<void> {
  await page.addInitScript((v) => {
    try {
      // eslint-disable-next-line no-undef
      window.localStorage.setItem('cht-ui-builder.oneClickTiles', v);
    } catch {
      /* storage unavailable */
    }
  }, String(on));
}
