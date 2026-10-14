/**
 * T9c (#16) — field-picker metadata: labels, sections, technical rows, search.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildFieldMeta,
  fieldMatchesQuery,
  resolveLabel,
  technicalReasonFor,
} from './fieldMeta.js';
import type { SurveyRow } from './types.js';

let n = 0;
function row(
  type: string,
  name: string,
  labels: Record<string, string> = {},
  extras: Record<string, string> = {},
): SurveyRow {
  return { rowId: `r${n++}`, type, name, labels, extras } as SurveyRow;
}

const LOCALES = ['en', 'ne'];

test('resolveLabel: first non-empty label in locale order, then any, else empty; whitespace collapsed', () => {
  assert.equal(resolveLabel({ en: 'LMP date', ne: 'ल.म.पी' }, LOCALES), 'LMP date');
  assert.equal(resolveLabel({ en: '  ', ne: 'ल.म.पी' }, LOCALES), 'ल.म.पी');
  assert.equal(resolveLabel({ fr: 'Date' }, LOCALES), 'Date');
  assert.equal(resolveLabel({}, LOCALES), '');
  assert.equal(resolveLabel(undefined, LOCALES), '');
  assert.equal(resolveLabel({ en: 'Is the LMP\n  approximate?' }, LOCALES), 'Is the LMP approximate?');
});

test('technicalReasonFor: notes, r_*, __*, hidden, inputs re-export calculates; ordinary rows are not technical', () => {
  assert.equal(technicalReasonFor(row('note', 'lmp_note')), 'note');
  assert.equal(technicalReasonFor(row('text', 'r_summary')), 'summary');
  assert.equal(technicalReasonFor(row('calculate', '__pregnancy_id')), 'hidden-output');
  assert.equal(technicalReasonFor(row('hidden', 'secret')), 'hidden');
  assert.equal(technicalReasonFor(row('text', 'x', {}, { appearance: 'hidden' })), 'hidden');
  // The harvest calculate that re-exports a contact input is the sanctioned
  // way to reach that value from a rule, so it is NOT technical.
  assert.equal(
    technicalReasonFor(row('calculate', 'patient_sex', {}, { calculation: '../inputs/contact/sex' })),
    null,
  );
  // A calculate the author wrote is a real field.
  assert.equal(
    technicalReasonFor(row('calculate', 'age_years', {}, { calculation: 'floor(../age_days div 365)' })),
    null,
  );
  assert.equal(technicalReasonFor(row('date', 'lmp_date')), null);
  assert.equal(technicalReasonFor(row('select_one yes_no', 'lmp_approx')), null);
});

test('buildFieldMeta: sections follow group nesting (both spellings), labels resolve, structural rows are skipped', () => {
  const survey: SurveyRow[] = [
    row('begin group', 'inputs', { en: 'Inputs' }),
    row('calculate', 'source', {}, { calculation: '../inputs/source' }),
    row('end group', ''),
    row('date', 'lmp_date', { en: 'LMP date' }),
    row('begin_group', 'danger', { en: 'Danger signs' }),
    row('select_multiple ds', 'danger_signs', { en: 'Which danger signs?' }),
    row('begin repeat', 'visits', { en: 'Visits' }),
    row('integer', 'visit_no', { en: 'Visit number' }),
    row('end repeat', ''),
    row('note', 'danger_note', { en: 'Refer now' }),
    row('end_group', ''),
    row('integer', 'gravidity', { en: 'Number of pregnancies' }),
    row('text', '', { en: 'unnamed row is skipped' }),
  ];
  const meta = buildFieldMeta(survey, LOCALES);
  assert.deepEqual(
    meta.map((m) => [m.name, m.section, m.sectionPath, m.technical, m.kind]),
    [
      ['source', 'Inputs', ['inputs'], false, 'unknown'],
      ['lmp_date', '', [], false, 'date'],
      ['danger_signs', 'Danger signs', ['danger'], false, 'choice'],
      ['visit_no', 'Visits', ['danger', 'visits'], false, 'numeric'],
      ['danger_note', 'Danger signs', ['danger'], true, 'text'],
      ['gravidity', '', [], false, 'numeric'],
    ],
  );
  assert.equal(meta.find((m) => m.name === 'danger_signs')?.label, 'Which danger signs?');
  assert.equal(meta.find((m) => m.name === 'danger_note')?.technicalReason, 'note');
  // A group with no label falls back to its name as the section.
  const noLabel = buildFieldMeta(
    [row('begin group', 'g1'), row('text', 'a'), row('end group', '')],
    LOCALES,
  );
  assert.equal(noLabel[0]?.section, 'g1');
});

test('fieldMatchesQuery: case-insensitive, every term must hit the label or the name, empty query matches', () => {
  const m = { name: 'lmp_approx', label: 'Is the LMP date approximate?' };
  assert.equal(fieldMatchesQuery(m, ''), true);
  assert.equal(fieldMatchesQuery(m, 'lmp'), true);
  assert.equal(fieldMatchesQuery(m, 'LMP approx'), true);
  assert.equal(fieldMatchesQuery(m, 'approximate'), true);
  assert.equal(fieldMatchesQuery(m, 'lmp_app'), true);
  assert.equal(fieldMatchesQuery(m, 'lmp gravid'), false);
  assert.equal(fieldMatchesQuery({ name: 'gravidity', label: '' }, 'grav'), true);
});
