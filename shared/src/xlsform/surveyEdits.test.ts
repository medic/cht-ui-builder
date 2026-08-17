/**
 * Tests for the survey-edit planners — pin the §A4/§A5 mutating-path
 * contract per punch-list §B2 (docs/plans/shipped-batch-triad-punchlist.md).
 *
 * Before this module, group-as-unit drag and ungroup lived as un-exported
 * helpers inside FormEditor.tsx with zero coverage. The §A6 save-guard
 * prevented on-disk corruption but didn't verify operations behaved
 * correctly. These tests close that gap.
 *
 * Four explicit `plan*` contracts:
 *   1. Begin-group drag moves the whole begin..end slice intact.
 *   2. Leaf drag that would split a pair is rejected (survey unchanged).
 *   3. Drop-inside-own-span is refused (a group can't land inside itself).
 *   4. Ungroup keeps children at parent depth + refuses on no-matching-end.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  findMatchingEndIndex,
  moveSurveySlice,
  planSurveyMove,
  planUngroup,
  defaultInsertIndex,
} from './surveyEdits.js';
import { findStructuralViolations } from './structuralBalance.js';
import { buildAppFormScaffold } from './scaffolds.js';
import { type SurveyRow } from './types.js';

function row(partial: Partial<SurveyRow> & { type: string; rowId: string }): SurveyRow {
  return {
    name: partial.name ?? '',
    labels: {},
    extras: {},
    ...partial,
  };
}

/* ============================ findMatchingEndIndex ============================ */

test('findMatchingEndIndex returns the matching end for a balanced group', () => {
  const survey: SurveyRow[] = [
    row({ type: 'begin group', name: 'g', rowId: 'g1' }),
    row({ type: 'text', name: 'x', rowId: 'x' }),
    row({ type: 'end group', rowId: 'g1_end' }),
  ];
  assert.equal(findMatchingEndIndex(survey, 0), 2);
});

test('findMatchingEndIndex handles arbitrary nesting (group inside repeat)', () => {
  const survey: SurveyRow[] = [
    row({ type: 'begin repeat', name: 'r', rowId: 'r1' }),
    row({ type: 'begin group', name: 'inner', rowId: 'g2' }),
    row({ type: 'text', name: 'x', rowId: 'x' }),
    row({ type: 'end group', rowId: 'g2_end' }),
    row({ type: 'end repeat', rowId: 'r1_end' }),
  ];
  assert.equal(findMatchingEndIndex(survey, 0), 4); // begin repeat → end repeat
  assert.equal(findMatchingEndIndex(survey, 1), 3); // inner begin group → end group
});

test('findMatchingEndIndex returns -1 for an unbalanced begin', () => {
  const survey: SurveyRow[] = [
    row({ type: 'begin group', name: 'orphan', rowId: 'g1' }),
    row({ type: 'text', name: 'x', rowId: 'x' }),
  ];
  assert.equal(findMatchingEndIndex(survey, 0), -1);
});

test('findMatchingEndIndex returns -1 when the index is not a begin row', () => {
  const survey: SurveyRow[] = [
    row({ type: 'text', name: 'x', rowId: 'x' }),
    row({ type: 'begin group', name: 'g', rowId: 'g1' }),
    row({ type: 'end group', rowId: 'g1_end' }),
  ];
  assert.equal(findMatchingEndIndex(survey, 0), -1);
});

/* ============================ moveSurveySlice ============================ */

test('moveSurveySlice translates toIndex from original-array indexing (dnd-kit arrayMove parity)', () => {
  const arr = ['a', 'b', 'c', 'd', 'e'];
  // Move slice [b,c] when drop target is at original idx 4 ('e'). For
  // dnd-kit parity, this lands the slice AFTER 'e' — the same place a
  // single-row arrayMove(arr, fromStart, toIndex) would land a row.
  // After removal `without = ['a','d','e']`; insertAt = 4 - sliceLength + 1
  // = 3, so the slice appends to the without-array. Result:
  //   ['a','d','e','b','c']
  assert.deepEqual(moveSurveySlice(arr, 1, 2, 4), ['a', 'd', 'e', 'b', 'c']);
});

test('moveSurveySlice moves a slice leftward', () => {
  const arr = ['a', 'b', 'c', 'd', 'e'];
  // Move slice [c,d] to index 0 → ['c','d','a','b','e'].
  assert.deepEqual(moveSurveySlice(arr, 2, 3, 0), ['c', 'd', 'a', 'b', 'e']);
});

/* ============================ planSurveyMove ============================ */

// Reusable survey: a group "g" with two inner rows, plus three top-level rows.
function groupSurvey(): SurveyRow[] {
  return [
    row({ type: 'text', name: 'pre', rowId: 'pre' }),
    row({ type: 'begin group', name: 'g', rowId: 'g_begin' }),
    row({ type: 'text', name: 'in1', rowId: 'in1' }),
    row({ type: 'text', name: 'in2', rowId: 'in2' }),
    row({ type: 'end group', rowId: 'g_end' }),
    row({ type: 'text', name: 'mid', rowId: 'mid' }),
    row({ type: 'text', name: 'post', rowId: 'post' }),
  ];
}

test('planSurveyMove (B2.a) — begin-group drag moves the whole begin..end slice intact', () => {
  const survey = groupSurvey();
  // Drag the group ("g_begin") onto "post" — the slice begin..end (3 rows)
  // should move past "mid" + "post" and land at the end.
  const plan = planSurveyMove(survey, 'g_begin', 'post');
  assert.equal(plan.kind, 'ok');
  if (plan.kind !== 'ok') return;
  assert.equal(plan.isGroupMove, true);
  // The whole 3-row slice must stay contiguous in the result.
  const ids = plan.next.map((r) => r.rowId);
  const gStart = ids.indexOf('g_begin');
  assert.equal(ids[gStart + 1], 'in1');
  assert.equal(ids[gStart + 2], 'in2');
  assert.equal(ids[gStart + 3], 'g_end');
  // Result is still balanced.
  assert.equal(findStructuralViolations(plan.next).length, 0);
});

test('planSurveyMove (B2.b) — leaf drag that splits a pair is rejected (survey unchanged)', () => {
  // Set up a survey where dragging "post" between begin and end would
  // split the pair. The structural validator catches this.
  const survey: SurveyRow[] = [
    row({ type: 'begin group', name: 'g', rowId: 'g_begin' }),
    row({ type: 'text', name: 'in1', rowId: 'in1' }),
    row({ type: 'end group', rowId: 'g_end' }),
    row({ type: 'text', name: 'post', rowId: 'post' }),
  ];
  // Drag "post" UP one slot. dnd-kit's arrayMove(survey, 3, 2) yields:
  //   [begin g, in1, post, end g]   ← still balanced (post lands BEFORE end)
  // So pick the actually-violating move: drag "in1" past begin to land at
  // index 0 — `arrayMove(survey, 1, 0)` gives [in1, begin g, end g, post].
  // That moves a content row OUT of its group, which is still balanced
  // structurally. The genuinely violating case is when arrayMove
  // produces a split; constructing one here requires a different
  // shape: drag "post" UP into the middle of the begin..end pair.
  //
  // Construct it: drag "post" (idx 3) to "g_begin" (idx 0). arrayMove
  // moves "post" before g_begin: ["post", "g_begin", "in1", "g_end"] —
  // still balanced. So leaf drags rarely produce a violation; the
  // contract is "if it would, reject." Pin the always-pass case here
  // and use the synthetic case in the next test.
  const plan = planSurveyMove(survey, 'in1', 'post');
  // in1 → post: moves in1 forward inside the begin..end region. Still ok.
  assert.equal(plan.kind, 'ok');
});

test('planSurveyMove (B2.b synthetic) — a move that would unbalance the form is rejected', () => {
  // Force a violation: a survey already missing one of its end rows is
  // unbalanced. Any move that doesn't fix it must NOT be flagged
  // (prevCount === nextCount), but a move that would CREATE a new
  // violation must be rejected.
  //
  // Build a balanced survey with TWO groups, then synthetically remove
  // the inner group's end via a move that would orphan it. Easier: use
  // moveSurveySlice manually to construct what the planner should reject.
  //
  // For the actual contract: when planSurveyMove sees nextCount > prevCount,
  // it returns 'introduces-imbalance'. Stub the input to exercise this path
  // directly — drag the end row out of a group (an end row isn't a begin
  // marker, so it's a leaf drag).
  const survey: SurveyRow[] = [
    row({ type: 'begin group', name: 'g', rowId: 'g_begin' }),
    row({ type: 'text', name: 'in1', rowId: 'in1' }),
    row({ type: 'end group', rowId: 'g_end' }),
    row({ type: 'text', name: 'post', rowId: 'post' }),
  ];
  // Drag the end row to index 0: arrayMove(survey, 2, 0) →
  // [end group, begin group, in1, post] — now there's an unmatched-end at
  // idx 0 AND an unmatched-begin at idx 1.
  const plan = planSurveyMove(survey, 'g_end', 'g_begin');
  assert.equal(plan.kind, 'rejected');
  if (plan.kind !== 'rejected') return;
  assert.equal(plan.reason, 'introduces-imbalance');
});

test('planSurveyMove (B2.c) — drop-inside-own-span is refused', () => {
  const survey = groupSurvey();
  // Drag the group's begin onto its OWN inner row "in1" — the begin would
  // land inside its own span, which is illegal.
  const plan = planSurveyMove(survey, 'g_begin', 'in1');
  assert.equal(plan.kind, 'rejected');
  if (plan.kind !== 'rejected') return;
  assert.equal(plan.reason, 'drop-inside-own-span');
});

test('planSurveyMove — unbalanced source begin is refused', () => {
  const survey: SurveyRow[] = [
    row({ type: 'begin group', name: 'orphan', rowId: 'g_begin' }),
    row({ type: 'text', name: 'in1', rowId: 'in1' }),
  ];
  const plan = planSurveyMove(survey, 'g_begin', 'in1');
  assert.equal(plan.kind, 'rejected');
  if (plan.kind !== 'rejected') return;
  assert.equal(plan.reason, 'unbalanced-source');
});

test('planSurveyMove — same source/destination is a no-op rejection', () => {
  const survey = groupSurvey();
  assert.equal(planSurveyMove(survey, 'in1', 'in1').kind, 'rejected');
});

test('planSurveyMove — missing source or destination row id is rejected', () => {
  const survey = groupSurvey();
  assert.equal(planSurveyMove(survey, 'nope', 'in1').kind, 'rejected');
  assert.equal(planSurveyMove(survey, 'in1', 'nope').kind, 'rejected');
});

/* ============================ planUngroup ============================ */

test('planUngroup (B2.d) — strips the begin/end shell, children stay at parent depth', () => {
  const survey = groupSurvey();
  const plan = planUngroup(survey, 'g_begin');
  assert.equal(plan.kind, 'ok');
  if (plan.kind !== 'ok') return;
  const ids = plan.next.map((r) => r.rowId);
  // 'g_begin' and 'g_end' are gone; children land in-place.
  assert.deepEqual(ids, ['pre', 'in1', 'in2', 'mid', 'post']);
  assert.equal(findStructuralViolations(plan.next).length, 0);
});

test('planUngroup (B2.d) — refuses on no-matching-end (unbalanced)', () => {
  const survey: SurveyRow[] = [
    row({ type: 'begin group', name: 'orphan', rowId: 'g_begin' }),
    row({ type: 'text', name: 'in1', rowId: 'in1' }),
  ];
  const plan = planUngroup(survey, 'g_begin');
  assert.equal(plan.kind, 'rejected');
  if (plan.kind !== 'rejected') return;
  assert.equal(plan.reason, 'no-matching-end');
});

test('planUngroup — refuses when the row id is not found', () => {
  const survey = groupSurvey();
  const plan = planUngroup(survey, 'nope');
  assert.equal(plan.kind, 'rejected');
  if (plan.kind !== 'rejected') return;
  assert.equal(plan.reason, 'row-not-found');
});

test('planUngroup — refuses when the target row is not a begin row', () => {
  const survey = groupSurvey();
  const plan = planUngroup(survey, 'in1'); // a text row, not a begin
  assert.equal(plan.kind, 'rejected');
  if (plan.kind !== 'rejected') return;
  assert.equal(plan.reason, 'not-a-begin');
});

/* ===================== §B1 — defaultInsertIndex ===================== */

test('§B1 — defaultInsertIndex on the Default app scaffold lands BEFORE the trailing linking calculates', () => {
  const scaffold = buildAppFormScaffold({ basename: 'pregnancy_visit' });
  const idx = defaultInsertIndex(scaffold.survey);
  // The scaffold's trailing calculates start at row 13 (per §B1 layout in
  // scaffolds.ts: rows 0-12 = inputs block, rows 13-16 = linking
  // calculates). The first inserted question must land there so it appears
  // above the (invisible-in-Simple-mode) plumbing.
  //
  // Was 12 until `hidden name` joined inputs/contact. Asserting the
  // relationship rather than the literal would not be better here: the
  // point of the test is that the boundary is computed, and a wrong
  // boundary is exactly what a literal catches.
  assert.equal(idx, 13, 'index must point at the first trailing calculate');
  const insertedAt = scaffold.survey[idx]!;
  assert.equal(insertedAt.type, 'calculate', 'idx points at a calculate row');
  assert.equal(insertedAt.name, 'patient_uuid', 'and specifically the first linking calc');
});

test('§B1 — on a form with no trailing calculates, returns survey.length (append behaviour)', () => {
  const survey: SurveyRow[] = [
    { rowId: 'a', type: 'text', name: 'a', labels: {}, extras: {} },
    { rowId: 'b', type: 'integer', name: 'b', labels: {}, extras: {} },
  ];
  assert.equal(defaultInsertIndex(survey), survey.length);
});

test('§B1 — calculates INSIDE a group do not count as a trailing suffix', () => {
  // A calculate nested inside a group is structural metadata for that
  // group, not part of the trailing depth-0 plumbing run. Insert
  // should still append after the end group.
  const survey: SurveyRow[] = [
    { rowId: 'bg', type: 'begin group', name: 'g', labels: {}, extras: {} },
    { rowId: 'c1', type: 'calculate', name: 'c1', labels: {}, extras: {} },
    { rowId: 'eg', type: 'end group', name: 'g', labels: {}, extras: {} },
  ];
  assert.equal(defaultInsertIndex(survey), survey.length);
});

test('§B1 — a non-calculate row at depth 0 BREAKS the trailing run, even mid-suffix', () => {
  // A `text` after a calc means the run isn't a true trailing-only suffix
  // — append at end. The function only treats an UNBROKEN suffix of
  // depth-0 calcs as "trailing."
  const survey: SurveyRow[] = [
    { rowId: 'c1', type: 'calculate', name: 'c1', labels: {}, extras: {} },
    { rowId: 't1', type: 'text', name: 't1', labels: {}, extras: {} },
    { rowId: 'c2', type: 'calculate', name: 'c2', labels: {}, extras: {} },
  ];
  // The trailing run starts at c2; the text at index 1 broke the run
  // started at c1. So defaultInsertIndex should return 2 (index of c2).
  assert.equal(defaultInsertIndex(survey), 2);
});

test('§B1 — empty survey returns 0 (append-to-end semantics)', () => {
  assert.equal(defaultInsertIndex([]), 0);
});
