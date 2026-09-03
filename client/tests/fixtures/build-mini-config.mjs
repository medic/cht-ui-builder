/**
 * Generator for `client/tests/fixtures/mini-config/` — a minimal cht-conf-shaped
 * project used by the Playwright suite. Run this once; the resulting .xlsx
 * files and base_settings.json are checked into the repo so a fresh clone
 * has the fixture immediately (no env export needed).
 *
 * Usage:
 *   pnpm install   # ExcelJS lives in shared/ → root resolves it via pnpm-workspace
 *   node client/tests/fixtures/build-mini-config.mjs
 */
import ExcelJS from 'exceljs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'mini-config');

async function writeXlsx(filePath, sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'cht-ui-builder fixture';
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const row of rows) ws.addRow(row);
  }
  await mkdir(dirname(filePath), { recursive: true });
  const buf = await wb.xlsx.writeBuffer();
  await writeFile(filePath, Buffer.from(buf));
}

// Contact form: person.xlsx — `sex` is a select_one with male/female/other.
// This is the source of truth the condition builder pulls from when an app
// form references `inputs/contact/sex` via a calculate.
await writeXlsx(join(root, 'forms', 'contact', 'person.xlsx'), {
  survey: [
    ['type', 'name', 'label::en', 'required'],
    ['select_one sex_options', 'sex', 'Sex', 'yes'],
    ['text', 'patient_name', 'Name', 'yes'],
    ['integer', 'age', 'Age', ''],
  ],
  choices: [
    ['list_name', 'name', 'label::en'],
    ['sex_options', 'male', 'Male'],
    ['sex_options', 'female', 'Female'],
    ['sex_options', 'other', 'Other'],
  ],
  settings: [
    // Canonical order matches serialize.ts:155 so the round-trip smoke passes.
    ['form_title', 'form_id', 'version'],
    ['person', 'Person', '1.0'],
  ],
});

// App form: pregnancy.xlsx — `sex` arrives via inputs/contact/sex (calculate),
// matching the canonical CHT contact-injection pattern. This form is the
// fixture the editing-flow e2e suite exercises, so it deliberately carries
// the surfaces a UAT tester reaches for:
//
//   - `lmp_date` (date)  — the only `date` row; the condition-builder spec
//     discriminates it by its raw type chip, so KEEP IT THE ONLY DATE ROW.
//   - `lmp_note` (note)  — `relevant = ${lmp_date} != ''` makes it depend on
//     `lmp_date`, which sits immediately above it. Moving the note up (swap
//     with lmp_date) is the dependency-breaking reorder the guard must catch;
//     moving a row with no such reference is the benign control.
//   - `danger_signs` (select_multiple) — a real multi-select with a 3-option
//     choice list, so the inline-choices editing flow has something to edit.
//   - `chair_rise` (select_one) — a SINGLE-select whose choice LABELS differ
//     from their NAMES ("Fail"/`fail`), modelled on the geriatric IHA
//     pass/fail questions. The task-condition builder's equals comparison is
//     only correct against a single-select, so the geriatric e2e anchors
//     here; `danger_signs` (multi) needs the "any of" operator instead
//     (docs/NEXT.md items 2 + 4). Both locales are filled deliberately —
//     `form-editing.spec.ts` asserts an exact "ne: 2 missing" count.
//   - `gravidity` (integer) — an untranslated row, so the `ne` "missing"
//     counter on the Translate tab is non-zero and observable.
//
// KEEP `gravidity` THE ONLY `integer` ROW and `lmp_date` THE ONLY `date` ROW —
// condition-builder.spec.ts resolves both by their unique raw type chip.
//
// Two locales (`label::en` + `label::ne`) so label + translation editing is
// testable; `sex` still flows in via `inputs/contact/sex` so the
// condition-builder dropdown spec keeps working unchanged.
await writeXlsx(join(root, 'forms', 'app', 'pregnancy.xlsx'), {
  survey: [
    ['type', 'name', 'label::en', 'label::ne', 'calculation', 'relevant', 'required'],
    ['begin group', 'inputs', '', '', '', '', ''],
    ['begin group', 'contact', '', '', '', '', ''],
    ['calculate', 'sex', '', '', '../inputs/contact/sex', '', ''],
    ['calculate', '_id', '', '', '../inputs/contact/_id', '', ''],
    ['end group', '', '', '', '', '', ''],
    ['end group', '', '', '', '', '', ''],
    ['date', 'lmp_date', 'Last menstrual period', 'अन्तिम महिनावारी', '', '', 'yes'],
    ['note', 'lmp_note', 'LMP recorded', '', '', "${lmp_date} != ''", ''],
    ['select_multiple danger_signs', 'danger_signs', 'Danger signs', 'खतराका लक्षण', '', '', ''],
    ['select_one pass_fail', 'chair_rise', 'Chair rise test', 'कुर्सी उठ्ने परीक्षण', '', '', ''],
    ['integer', 'gravidity', 'Number of pregnancies', '', '', '', ''],
  ],
  choices: [
    ['list_name', 'name', 'label::en', 'label::ne'],
    ['danger_signs', 'vaginal_bleeding', 'Vaginal bleeding', 'योनिबाट रक्तस्राव'],
    ['danger_signs', 'severe_headache', 'Severe headache', ''],
    ['danger_signs', 'blurred_vision', 'Blurred vision', ''],
    // Label != name on purpose: the choice pickers show the LABEL and store
    // the NAME, and only a fixture where the two differ can prove it.
    ['pass_fail', 'fail', 'Fail', 'फेल'],
    ['pass_fail', 'pass', 'Pass', 'पास'],
  ],
  settings: [
    // Canonical order matches serialize.ts:155 so the round-trip smoke passes.
    ['form_title', 'form_id', 'version'],
    ['pregnancy', 'Pregnancy', '1.0'],
  ],
});

// app_settings/base_settings.json — carries the canonical CHT place hierarchy
// (district_hospital → health_center → clinic → person) so the Hierarchy editor
// has a real tree to render/edit. Modeled on server/templates/cht-default.
const contactTypes = [
  {
    id: 'district_hospital',
    name_key: 'contact.type.district_hospital',
    group_key: 'contact.type.district_hospital.plural',
    create_key: 'contact.type.district_hospital.new',
    edit_key: 'contact.type.place.edit',
    icon: 'medic-district-hospital',
    create_form: 'form:contact:district_hospital:create',
    edit_form: 'form:contact:district_hospital:edit',
  },
  {
    id: 'health_center',
    name_key: 'contact.type.health_center',
    group_key: 'contact.type.health_center.plural',
    create_key: 'contact.type.health_center.new',
    edit_key: 'contact.type.place.edit',
    parents: ['district_hospital'],
    icon: 'medic-health-center',
    create_form: 'form:contact:health_center:create',
    edit_form: 'form:contact:health_center:edit',
  },
  {
    id: 'clinic',
    name_key: 'contact.type.clinic',
    group_key: 'contact.type.clinic.plural',
    create_key: 'contact.type.clinic.new',
    edit_key: 'contact.type.place.edit',
    parents: ['health_center'],
    icon: 'medic-clinic',
    create_form: 'form:contact:clinic:create',
    edit_form: 'form:contact:clinic:edit',
  },
  {
    id: 'person',
    name_key: 'contact.type.person',
    group_key: 'contact.type.person.plural',
    create_key: 'contact.type.person.new',
    edit_key: 'contact.type.person.edit',
    parents: ['district_hospital', 'health_center', 'clinic'],
    icon: 'medic-person',
    person: true,
    create_form: 'form:contact:person:create',
    edit_form: 'form:contact:person:edit',
  },
];

await mkdir(join(root, 'app_settings'), { recursive: true });
await writeFile(
  join(root, 'app_settings', 'base_settings.json'),
  JSON.stringify(
    {
      contact_types: contactTypes,
      place_hierarchy_types: ['district_hospital', 'health_center', 'clinic'],
      permissions: {},
    },
    null,
    2,
  ) + '\n',
);

// forms/contact/place-types.json — human display names for the place types,
// surfaced in the Hierarchy editor's "Display name" field.
await writeFile(
  join(root, 'forms', 'contact', 'place-types.json'),
  JSON.stringify(
    {
      district_hospital: 'District Hospital',
      health_center: 'Health Center',
      clinic: 'Clinic',
    },
    null,
    2,
  ) + '\n',
);

// forms/app/pregnancy.properties.json — a real cht-conf project carries a
// sidecar per app form, and FormEditor only renders the Properties tab when
// one is present (`properties !== null`). Without this the tab is unreachable,
// so the form-context specs have nothing to drive.
await writeFile(
  join(root, 'forms', 'app', 'pregnancy.properties.json'),
  JSON.stringify(
    {
      title: [{ locale: 'en', content: 'Pregnancy registration' }],
      // Left unticked and expression-free on purpose: the context specs tick
      // "Available on people" themselves and assert on the resulting filter.
      context: { person: false, place: false },
      icon: 'icon-pregnancy',
    },
    null,
    2,
  ) + '\n',
);

console.log('Wrote mini-config fixture to', root);
