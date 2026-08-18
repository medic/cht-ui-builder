/**
 * Acceptance for docs/plans/pick-preexisting-context-values.md — "insert a
 * reference to a value that already exists", both halves, driven through the
 * UI with zero hand-edits.
 *
 * Workbook row R3 is the plan's exit criterion:
 *
 *     {Person_Name}'s Health Details — BMI …, blood pressure …, blood sugar …
 *
 * One row, two kinds of reference: the patient's NAME (a contact field) and
 * three COMPUTED CONTEXT VALUES. QA had to mark it "Not built", because the
 * contact-field half emitted a form that failed `cht convert`.
 *
 * ## What this spec covers, and what it deliberately does not
 *
 * It runs against the committed `mini-config` fixture, hermetically. The
 * mechanism is what's under test:
 *
 *   1. the patient's name inserted FROM THE PICKER — no typed `${…}`, no
 *      manual `inputs` surgery — and the resulting form declares the node it
 *      references, so `validate-app-forms` accepts it;
 *   2. a context value PICKED from what the config already computes — no typed
 *      identifier — using the project's own wrapper idiom.
 *
 * R3's literal payload (BMI 27.6 / BP 138 / sugar 145 for Devi Kumari Thapa)
 * lives in `config-nssd/chis`, a customer config we deliberately do not commit
 * as a fixture (docs/principle-config-agnostic.md, QA rider). That leg is
 * verified by running this same flow against NSSD with a live instance; the
 * three-channel scan behind it is pinned by 28 unit tests in
 * shared/src/contactSummary/contextKeyDiscovery.test.ts and was measured
 * through the live route at 70 keys on NSSD, 39 on lumbini, 14 on
 * cht-default, 9 on gandaki.
 *
 * The pyxform oracle for leg 1 is `scripts/validate-generated-forms.mjs`,
 * which CI runs as its own job — it needs python, so it is not re-run here.
 * What this spec adds is that the UI gesture produces the same shape.
 */
import { test, expect } from '@playwright/test';
// Reuse the proven UI drivers rather than re-guessing the picker's DOM.
import { addRow, createAppForm, rowByName } from './helpers/geriatric.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'mini-config');
const API = 'http://127.0.0.1:5174';

/** Copy the fixture so the spec's writes never touch the committed one. */
async function scratchProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pick-preexisting-'));
  await fs.cp(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Every path declared inside the outermost `inputs` group. */
function declaredInputPaths(
  survey: Array<{ type: string; name: string }>,
): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const r of survey) {
    const t = r.type.trim().toLowerCase();
    if (t === 'begin group' || t === 'begin repeat') {
      stack.push(r.name);
      continue;
    }
    if (t === 'end group' || t === 'end repeat') {
      stack.pop();
      continue;
    }
    if (stack[0] === 'inputs') out.add([...stack.slice(1), r.name].join('/'));
  }
  return out;
}

/**
 * The check `validate-app-forms` makes, run in-process: every `../inputs/…`
 * reference must resolve to a node the form declares. `inputs/meta/*` is the
 * one genuinely runtime-injected subtree (measured across 193 real forms).
 */
function danglingInputRefs(
  survey: Array<{ type: string; name: string; extras: Record<string, string> }>,
): string[] {
  const declared = declaredInputPaths(survey);
  const bad = new Set<string>();
  for (const r of survey) {
    for (const v of Object.values(r.extras)) {
      if (typeof v !== 'string') continue;
      for (const m of v.matchAll(/(?:\.\.\/)+inputs\/([A-Za-z0-9_/-]+)/g)) {
        const p = m[1]!;
        if (p.startsWith('meta/')) continue;
        if (!declared.has(p)) bad.add(p);
      }
    }
  }
  return [...bad];
}

test.describe('pick a value that already exists', () => {
  let projectPath = '';

  test.beforeEach(async ({ page }) => {
    projectPath = await scratchProject();
    const res = await page.request.post(`${API}/api/project/open`, {
      data: { path: projectPath },
    });
    expect(res.ok(), 'open the scratch project').toBeTruthy();
    await page.goto('/');
  });

  test.afterEach(async () => {
    if (projectPath) await fs.rm(projectPath, { recursive: true, force: true });
  });

  test('R3 leg 1 — the patient name, picked not typed, produces a DEPLOYABLE form', async ({
    page,
  }) => {
    // Create a form label-first. Its scaffold now declares inputs/contact/name,
    // which is the row whose absence made this whole flow undeployable.
    await createAppForm(page, 'Health details', 'health_details');

    // The scaffold must already pair declaration with reference — nothing
    // dangling before we touch it.
    const scaffolded = await readForm(page, 'app:health_details');
    expect(
      declaredInputPaths(scaffolded.survey).has('contact/name'),
      'the scaffold declares inputs/contact/name',
    ).toBeTruthy();
    expect(danglingInputRefs(scaffolded.survey), 'scaffold is deployable').toEqual([]);

    // Add the note that carries R3's sentence.
    await addRow(page, null, {
      name: 'health_details',
      en: 'Health details',
      ne: '',
      tile: /Note/,
    });

    // Insert the patient's NAME from the picker. No typing of `${…}`, and no
    // touching the inputs block by hand — that is the no-code contract.
    const row = rowByName(page, 'health_details');
    await row.locator('.label-insert-ref').getByRole('button', { name: '+ insert' }).click();
    const menu = page.locator('.label-insert-ref-menu');
    await expect(menu).toBeVisible();
    // The fixture's contact form calls the patient's name `patient_name`,
    // and the scaffold declares only `_id` / `patient_id` / `name` — so this
    // is the DECLARE-ON-DEMAND path, which is the one that used to emit an
    // undeployable form.
    const nameItem = menu
      .locator('.label-insert-ref-section')
      .filter({ hasText: 'Contact fields' })
      .getByRole('menuitem', { name: 'patient_name', exact: true });
    await expect(nameItem, 'the contact-field menu offers patient_name').toBeVisible();
    await nameItem.click();

    await saveForm(page);

    const saved = await readForm(page, 'app:health_details');

    // The harvest calculate exists and reads the contact field…
    const harvest = saved.survey.find(
      (r) => (r.extras['calculation'] ?? '').trim() === '../inputs/contact/patient_name',
    );
    expect(
      harvest,
      'a harvest calculate reads ../inputs/contact/patient_name',
    ).toBeTruthy();
    expect(harvest!.type.trim().toLowerCase()).toBe('calculate');

    // And the DECLARATION half — the bit that was missing — is there too.
    expect(
      declaredInputPaths(saved.survey).has('contact/patient_name'),
      'declare-on-demand wrote the node the calculate points at',
    ).toBeTruthy();

    // …the label carries its token, spliced by the tool…
    const note = saved.survey.find((r) => (r.labels['en'] ?? '').includes('${'));
    expect(note, 'the label carries the inserted token').toBeTruthy();
    expect(note!.labels['en']).toContain(`\${${harvest!.name}}`);

    // …and — the whole point — nothing dangles, so cht-conf will accept it.
    expect(
      danglingInputRefs(saved.survey),
      'a dangling ../inputs ref fails validate-app-forms for the ENTIRE project',
    ).toEqual([]);
  });

  test('R3 leg 2 — a context value is PICKED from what the config computes', async ({ page }) => {
    // mini-config's contact-summary computes alive / muted / show_visit_form.
    // The author must be able to choose one without knowing it exists or how
    // it is spelled.
    const scan = await page.request.get(`${API}/api/contact-summary/context-keys`);
    expect(scan.ok(), 'the context-keys route answers').toBeTruthy();
    const body = (await scan.json()) as {
      keys: Array<{ key: string; usageCount: number; origins: string[] }>;
      definitionsFound: boolean;
      summaryFiles: string[];
    };
    expect(body.definitionsFound, 'the scan located the context object').toBeTruthy();
    expect(
      body.keys.map((k) => k.key).sort(),
      'the three keys this fixture actually computes',
    ).toEqual(['alive', 'muted', 'show_visit_form']);
    // Discovered, not assumed: the fixture spells its extras with a hyphen.
    expect(body.summaryFiles).toContain('contact-summary-extras.js');

    // Now the UI half: open a calculate cell's builder and pick a key.
    // createAppForm already lands in Full mode; asserting it again here
    // re-clicks the mode control and hid the calculate rows.
    await createAppForm(page, 'Ctx pick', 'ctx_pick');

    // The scaffold's own linking calculates already carry a calculation cell,
    // so expand one of those rows rather than authoring a new calc type.
    const calcRow = rowByName(page, 'patient_uuid');
    await expect(calcRow).toBeVisible();
    await calcRow.locator('.expand-toggle').first().click();

    // The builder is reached from the CALCULATION field's own "✎ build" —
    // the row also has one for relevant and one for constraint, so scope it
    // to the field rather than taking the first on the page.
    const calcField = calcRow
      .locator('.expr-field')
      .filter({ hasText: 'Compute the value as' });
    // A CSS locator, not getByRole: the button sits inside a <label>, so
    // Chrome's accessibility tree folds its name into the label's and
    // getByRole('button', { name: ... }) matches nothing. The field carries
    // exactly one button, so this is unambiguous.
    const buildBtn = calcField.locator('button');
    await expect(buildBtn).toBeVisible();
    await buildBtn.click();

    const builder = page.locator('.single-value-panel, .rule-builder-card').first();
    await expect(builder).toBeVisible();

    // The "Contact-summary value" reference kind has to be selected before
    // its key input exists.
    await builder
      .locator('label')
      .filter({ hasText: /Contact-summary value|contact summary/i })
      .first()
      .locator('input[type="radio"]')
      .check();

    // NOT guarded by an isVisible() check: a conditional assertion here would
    // let the whole point of the test skip silently, which is the failure mode
    // this feature exists to stop elsewhere.
    const keyInput = page.getByLabel('Contact-summary context key');
    await expect(keyInput, 'the context-key picker is reachable').toBeVisible();

    // Backed by a datalist of DISCOVERED keys — the author picks rather than
    // remembering how a key is spelled.
    const values = await page
      .locator('#cb-context-keys option')
      .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    expect(
      values.sort(),
      'the picker offers exactly what this config computes — no typing needed',
    ).toEqual(['alive', 'muted', 'show_visit_form']);

    // Picking one writes the reference. The builder is a modal, so the cell
    // only takes the value on Save.
    await keyInput.fill('show_visit_form');
    const emitted = await builder
      .locator('code strong')
      .filter({ hasText: 'contact-summary' })
      .first()
      .textContent();
    expect(emitted, 'the builder previews the reference it will write').toContain(
      "instance('contact-summary')/context/show_visit_form",
    );
    // …and the wrapper is the idiom the project itself uses, not a constant of
    // ours. mini-config's own forms read context bare, so `none` is right here
    // — what matters is that it was DERIVED. inferContextWrapper's per-project
    // answers are pinned in shared/src/xlsform/calcReference.idioms.test.ts.
    await builder.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(builder).not.toBeVisible();
    await expect(
      calcField.locator('input').first(),
      'saving writes the reference into the calculation cell',
    ).toHaveValue(/instance\('contact-summary'\)\/context\/show_visit_form/);
  });
});

/* ------------------------------- helpers -------------------------------- */

async function readForm(page: import('@playwright/test').Page, formId: string) {
  const res = await page.request.get(`${API}/api/forms/${encodeURIComponent(formId)}`);
  expect(res.ok(), `GET form ${formId}`).toBeTruthy();
  return (await res.json()).form as {
    survey: Array<{
      type: string;
      name: string;
      labels: Record<string, string>;
      extras: Record<string, string>;
    }>;
  };
}

async function saveForm(page: import('@playwright/test').Page) {
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  const modalSave = page
    .locator('.rule-builder-card')
    .getByRole('button', { name: 'Save', exact: true });
  if (await modalSave.isVisible().catch(() => false)) await modalSave.click();
  await expect(
    page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible({ timeout: 20_000 });
}
