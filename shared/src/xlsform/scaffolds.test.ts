/**
 * Round-trip + structural-balance tests for the survey-builder Part B
 * scaffolds (plan docs/plans/survey-groups-and-scaffold.md).
 *
 * Contracts pinned:
 *   1. The app scaffold has the exact 16-row inputs block per §B1.
 *   2. The contact scaffold defaults to `person` and accepts a rename
 *      via `contactType`.
 *   3. Every scaffold is structurally balanced — `findStructuralViolations`
 *      returns zero. The §A6 save-guard will accept a freshly-scaffolded
 *      form without any user edits.
 *   4. parse(serialize(scaffold)) reproduces the survey rows (modulo
 *      regenerated rowIds) — proves the scaffold round-trips through
 *      the XLSForm serializer cleanly.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildAppFormScaffold,
  buildBlankFormScaffold,
  buildContactFormScaffold,
} from './scaffolds.js';
import { findStructuralViolations } from './structuralBalance.js';
import { parseXlsForm } from './parse.js';
import { serializeXlsForm } from './serialize.js';

test('B1 app scaffold — inputs block has the 17 canonical rows', () => {
  const f = buildAppFormScaffold({ basename: 'pregnancy_visit' });
  // 17 since `hidden name` joined inputs/contact — the row whose absence
  // made every "insert the patient's name" emit an undeployable form.
  assert.equal(f.survey.length, 17, 'app scaffold survey row count');
  // Spot-check shape: the begin group at idx 0 is `inputs` with field-list +
  // the `./source = 'user'` relevant.
  assert.equal(f.survey[0]!.type, 'begin group');
  assert.equal(f.survey[0]!.name, 'inputs');
  assert.equal(f.survey[0]!.extras['appearance'], 'field-list');
  assert.equal(f.survey[0]!.extras['relevant'], `./source = 'user'`);
  // The first calc after the inputs block — patient_uuid — pulls _id.
  const patientUuid = f.survey.find((r) => r.name === 'patient_uuid');
  assert.ok(patientUuid);
  assert.equal(patientUuid!.type, 'calculate');
  assert.equal(patientUuid!.extras['calculation'], '../inputs/contact/_id');
});

test('B1 app scaffold — is structurally balanced (§A6 accepts it)', () => {
  const f = buildAppFormScaffold({ basename: 'x' });
  assert.deepEqual(findStructuralViolations(f.survey), []);
});

test('B2 contact scaffold — defaults to "person" and uses the typed name on begin/end', () => {
  const f = buildContactFormScaffold({ basename: 'c80_household-create' });
  assert.equal(f.survey.length, 4);
  assert.equal(f.survey[0]!.type, 'begin group');
  assert.equal(f.survey[0]!.name, 'person');
  assert.equal(f.survey[3]!.type, 'end group');
  assert.equal(f.survey[3]!.name, 'person');
  // contact_type carries the default of `person` so the runtime knows
  // what kind of contact this form creates.
  const contactType = f.survey.find((r) => r.name === 'contact_type');
  assert.equal(contactType?.extras['default'], 'person');
});

test('B2 contact scaffold — accepts a renamed contact_type', () => {
  const f = buildContactFormScaffold({ basename: 'x', contactType: 'household' });
  assert.equal(f.survey[0]!.name, 'household');
  const contactType = f.survey.find((r) => r.name === 'contact_type');
  assert.equal(contactType?.extras['default'], 'household');
});

test('B2 contact scaffold — is structurally balanced', () => {
  const f = buildContactFormScaffold({ basename: 'x' });
  assert.deepEqual(findStructuralViolations(f.survey), []);
});

test('B3 blank scaffold — empty survey, balanced by vacuity', () => {
  for (const cat of ['app', 'contact'] as const) {
    const f = buildBlankFormScaffold({ basename: 'x', category: cat });
    assert.equal(f.survey.length, 0);
    assert.deepEqual(findStructuralViolations(f.survey), []);
  }
});

test('B1 app scaffold — round-trip via parse/serialize is structure-preserving', async () => {
  const f = buildAppFormScaffold({ basename: 'visit' });
  const buf = await serializeXlsForm(f);
  const parsed = await parseXlsForm(buf);
  // RowIds are regenerated on parse — compare on (type, name, key extras).
  assert.equal(parsed.survey.length, f.survey.length);
  for (let i = 0; i < f.survey.length; i++) {
    const a = f.survey[i]!;
    const b = parsed.survey[i]!;
    assert.equal(b.type, a.type, `row ${i}: type mismatch`);
    assert.equal(b.name, a.name, `row ${i}: name mismatch`);
  }
  assert.deepEqual(findStructuralViolations(parsed.survey), []);
});

test('B2 contact scaffold — round-trip via parse/serialize is structure-preserving', async () => {
  const f = buildContactFormScaffold({ basename: 'cc' });
  const buf = await serializeXlsForm(f);
  const parsed = await parseXlsForm(buf);
  assert.equal(parsed.survey.length, f.survey.length);
  for (let i = 0; i < f.survey.length; i++) {
    assert.equal(parsed.survey[i]!.type, f.survey[i]!.type);
    assert.equal(parsed.survey[i]!.name, f.survey[i]!.name);
  }
});
