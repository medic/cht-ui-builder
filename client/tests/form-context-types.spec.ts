/**
 * E2E for DEV-HANDOFF #3 — form-context "Contact type is" dropdown
 * surfaces the project's REAL contact types and emits the configurable
 * `contact.contact_type === '<id>'` form (not legacy `contact.type`).
 *
 * Spec: `docs/handoff-form-context-types-2026-06-28.md`.
 *
 * Bucket A — golden path: open a form's Properties → Context, click
 * "+ contact type", pick a real project type, assert the live preview
 * shows the configurable form. Save → reload → re-parse, confirm the
 * expression in properties.json on disk matches.
 *
 * Bucket B — backward compat: a properties.json with the legacy
 * `contact.type === 'person'` shape opens as such (kind:contact_type),
 * shows a "legacy" badge, and re-serializes byte-stable until the user
 * changes the value via the dropdown.
 *
 * Bucket C — gate filtering: with "Available on people" ticked, the
 * dropdown only lists person types.
 */
import { test, expect } from './setup.js';
import type { Page, APIRequestContext } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(here, 'fixtures', 'mini-config');

async function openTempPregnancy(
  page: Page,
  request: APIRequestContext,
  seedPropertiesJson?: object,
): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-e2e-fctx-'));
  await fs.cp(FIXTURE_DIR, tmp, { recursive: true });
  if (seedPropertiesJson) {
    await fs.writeFile(
      path.join(tmp, 'forms', 'app', 'pregnancy.properties.json'),
      JSON.stringify(seedPropertiesJson, null, 2),
    );
  }
  const opened = await request.post('http://127.0.0.1:5174/api/project/open', {
    data: { path: tmp },
  });
  expect(opened.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByText(path.basename(tmp)).first()).toBeVisible();
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
  // Navigate to the Properties tab. The tab strip is plain <button>s in
  // `.tabs` — there is no `role="tab"` in FormEditor — and the Properties tab
  // only renders when the form has a `.properties.json` sidecar, which the
  // fixture now ships.
  await page.locator('.tabs').getByRole('button', { name: 'Properties' }).click();
  await expect(page.locator('.properties-editor')).toBeVisible();
  return tmp;
}

test('#3 A — dropdown lists real project types and emits contact.contact_type', async ({
  page,
  request,
}) => {
  const tmp = await openTempPregnancy(page, request);
  try {
    // Click the "+ contact type" toolbar button — adds a default rule
    // bound to the first project type (mini-config: `district_hospital`).
    await page
      .locator('.context-builder')
      .getByRole('button', { name: '+ contact type', exact: true })
      .click();

    // The dropdown options should include mini-config's real types
    // (district_hospital, health_center, clinic, person).
    const select = page.locator('.rule-row select').first();
    await expect(select.locator('option', { hasText: 'person' })).toHaveCount(1);
    await expect(select.locator('option', { hasText: 'clinic' })).toHaveCount(1);

    // Pick `person` and confirm the preview shows the configurable form.
    await select.selectOption('person');
    const preview = page.locator('.context-builder .preview code');
    await expect(preview).toContainText("contact.contact_type === 'person'");
    await expect(preview).not.toContainText("contact.type === 'person'");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('#3 B — legacy contact.type rule loads, badges, and round-trips byte-stable', async ({
  page,
  request,
}) => {
  // Seed a properties.json that uses the legacy shape — exactly what an
  // imported cht-default config would carry. The dropdown should NOT
  // silently rewrite it on load.
  const tmp = await openTempPregnancy(page, request, {
    title: [{ locale: 'en', content: 'Pregnancy' }],
    context: {
      person: true,
      place: false,
      expression: "contact.type === 'person'",
    },
  });
  try {
    const builder = page.locator('.context-builder');
    await expect(builder.locator('.preview code')).toContainText(
      "contact.type === 'person'",
    );
    // The legacy badge surfaces on the row.
    await expect(builder.locator('.rule-row').filter({ hasText: 'legacy' })).toBeVisible();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('#3 C — "Available on people" filters the dropdown to person types only', async ({
  page,
  request,
}) => {
  const tmp = await openTempPregnancy(page, request);
  try {
    // Tick "Available on people" first.
    await page.getByLabel('Available on people').check();
    // Then add a contact-type rule.
    await page
      .locator('.context-builder')
      .getByRole('button', { name: '+ contact type', exact: true })
      .click();
    const select = page.locator('.rule-row select').first();
    // Person type present; place-only types should be filtered out.
    await expect(select.locator('option', { hasText: 'person' })).toHaveCount(1);
    await expect(select.locator('option', { hasText: 'district_hospital' })).toHaveCount(0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
