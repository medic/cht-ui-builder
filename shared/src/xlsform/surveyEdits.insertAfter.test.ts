/**
 * T9d (#17) — "+ Question" inserts after the row the author is on, and an
 * insert inside a group keeps its begin / end pair balanced.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { defaultInsertIndex, insertIndexAfterRow } from './surveyEdits.js';
import { isStructurallyBalanced } from './structuralBalance.js';
import type { SurveyRow } from './types.js';

function row(rowId: string, type: string, name = rowId): SurveyRow {
  return { rowId, type, name, labels: {}, extras: {} } as SurveyRow;
}

const survey: SurveyRow[] = [
  row('lmp', 'date'),
  row('g_begin', 'begin group', 'danger'),
  row('ds', 'select_multiple ds'),
  row('note', 'note'),
  row('g_end', 'end group', 'danger'),
  row('grav', 'integer'),
  row('calc1', 'calculate'),
  row('calc2', 'calculate'),
];

function spliced(at: number): SurveyRow[] {
  return [...survey.slice(0, at), row('age', 'integer'), ...survey.slice(at)];
}

test('insertIndexAfterRow: directly after a top-level row', () => {
  const at = insertIndexAfterRow(survey, 'lmp');
  assert.equal(at, 1);
  assert.equal(spliced(at)[1]?.rowId, 'age');
  assert.ok(isStructurallyBalanced(spliced(at)));
});

test('insertIndexAfterRow: after a row inside a group stays inside and balanced', () => {
  const at = insertIndexAfterRow(survey, 'ds');
  const next = spliced(at);
  assert.deepEqual(
    next.map((r) => r.rowId).slice(1, 6),
    ['g_begin', 'ds', 'age', 'note', 'g_end'],
  );
  assert.ok(isStructurallyBalanced(next));
});

test('insertIndexAfterRow: after a begin-group row becomes its first child', () => {
  const at = insertIndexAfterRow(survey, 'g_begin');
  const next = spliced(at);
  assert.deepEqual(next.map((r) => r.rowId).slice(1, 4), ['g_begin', 'age', 'ds']);
  assert.ok(isStructurallyBalanced(next));
});

test('insertIndexAfterRow: after the last question lands before the trailing plumbing calculates', () => {
  // Explicit "after grav" is index 6 — the author asked for that spot.
  assert.equal(insertIndexAfterRow(survey, 'grav'), 6);
  // No current row → the default, which is also before the plumbing run.
  assert.equal(insertIndexAfterRow(survey, null), defaultInsertIndex(survey));
  assert.equal(defaultInsertIndex(survey), 6);
});

test('insertIndexAfterRow: unknown row id falls back to the default position', () => {
  assert.equal(insertIndexAfterRow(survey, 'nope'), defaultInsertIndex(survey));
});
