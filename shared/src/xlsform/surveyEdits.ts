/**
 * Pure planners for the survey-builder mutating operations.
 *
 * The §A4 reorder + §A5 ungroup paths previously lived as un-exported
 * helpers inside `FormEditor.tsx` with zero test coverage — the only
 * safety net was the save-time balance validator (§A6), which prevented
 * on-disk corruption but didn't verify the operations *behaved*
 * correctly. Punch-list §B2 (docs/plans/shipped-batch-triad-punchlist.md)
 * extracts the decision logic into this module so it's testable in
 * isolation.
 *
 * Each `plan*` function is pure: takes the current survey + the operation
 * inputs, returns either an `ok` outcome with the new survey OR a
 * `rejected` outcome with a stable `reason` and a user-facing message.
 * The caller (FormEditor) applies the new survey via `patch()` on `ok`
 * and surfaces the message via `setError()` on `rejected` — no DOM
 * coupling here.
 *
 * Two structural invariants stay non-negotiable (both proven by the
 * accompanying test suite):
 *   1. A `begin group`/`begin repeat` always moves as a whole
 *      begin..end subtree. The drag never splits a pair.
 *   2. A move that would INTRODUCE a new structural violation is
 *      rejected. The shared `findStructuralViolations` is the oracle.
 */
import { findStructuralViolations, structuralMarker } from './structuralBalance.js';
import { type SurveyRow } from './types.js';

/* ============================ utility ================================= */

/**
 * Find the survey index of the `end` row that matches the `begin` row at
 * `beginIdx`. Returns -1 if the survey is unbalanced (no matching end)
 * or `beginIdx` is not pointing at a begin row.
 */
export function findMatchingEndIndex(survey: SurveyRow[], beginIdx: number): number {
  const beginMarker = structuralMarker(survey[beginIdx]!);
  if (beginMarker !== 'begin-group' && beginMarker !== 'begin-repeat') return -1;
  let depth = 1;
  for (let j = beginIdx + 1; j < survey.length; j++) {
    const m = structuralMarker(survey[j]!);
    if (m === 'begin-group' || m === 'begin-repeat') depth++;
    else if (m === 'end-group' || m === 'end-repeat') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * Move the contiguous slice `[fromStart, fromEnd]` (inclusive) of `arr`
 * to land starting at `toIndex` (interpreted in the ORIGINAL indexing).
 * Pure — returns a new array. Used by group-as-unit drag so the entire
 * begin..end subtree moves as one.
 */
export function moveSurveySlice<T>(
  arr: T[],
  fromStart: number,
  fromEnd: number,
  toIndex: number,
): T[] {
  if (fromStart < 0 || fromEnd >= arr.length || fromStart > fromEnd) return arr;
  const sliceLength = fromEnd - fromStart + 1;
  const slice = arr.slice(fromStart, fromEnd + 1);
  const without = [...arr.slice(0, fromStart), ...arr.slice(fromEnd + 1)];
  // Translate toIndex from original-arr to without-slice indexing.
  let insertAt: number;
  if (toIndex <= fromStart) insertAt = toIndex;
  else if (toIndex >= fromEnd) insertAt = toIndex - sliceLength + 1;
  else insertAt = fromStart;
  insertAt = Math.max(0, Math.min(insertAt, without.length));
  return [...without.slice(0, insertAt), ...slice, ...without.slice(insertAt)];
}

/** Reference implementation of @dnd-kit/sortable's `arrayMove`, kept
 *  here so the shared module has zero React/dnd-kit dependency. */
function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  if (from === to) return arr;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  if (item === undefined) return arr;
  next.splice(to, 0, item);
  return next;
}

/* ============================ planSurveyMove =============================== */

export type MovePlan =
  | {
      kind: 'ok';
      next: SurveyRow[];
      /** True when the dragged row was a `begin group`/`begin repeat` and
       *  the move sliced the whole begin..end subtree. The caller can
       *  use this to skip per-row dependency-violation prompting (the
       *  per-row dependency validator doesn't model whole-group moves). */
      isGroupMove: boolean;
    }
  | {
      kind: 'rejected';
      reason:
        | 'rows-not-found'
        | 'unbalanced-source'
        | 'drop-inside-own-span'
        | 'introduces-imbalance';
      message: string;
    };

/**
 * Plan a drag-reorder. `fromRowId` is the row the user picked up;
 * `toRowId` is the row they dropped onto. Returns a `MovePlan` carrying
 * either the new survey OR a rejection with a stable reason + user
 * message. Pure — never mutates `survey`.
 *
 * Group-as-unit semantics: when `fromRowId` points at a begin row, the
 * whole begin..end span moves as one. A drop INSIDE the dragged group's
 * own span is refused (you can't move a group into itself). A move that
 * would introduce a new structural violation is refused (the §A6
 * save-guard's oracle would block the save otherwise).
 */
export function planSurveyMove(
  survey: SurveyRow[],
  fromRowId: string,
  toRowId: string,
): MovePlan {
  if (fromRowId === toRowId) {
    return { kind: 'rejected', reason: 'rows-not-found', message: 'No-op move.' };
  }
  const oldIndex = survey.findIndex((r) => r.rowId === fromRowId);
  const newIndex = survey.findIndex((r) => r.rowId === toRowId);
  if (oldIndex < 0 || newIndex < 0) {
    return {
      kind: 'rejected',
      reason: 'rows-not-found',
      message: 'Move blocked — source or destination row was not found.',
    };
  }

  const activeMarker = structuralMarker(survey[oldIndex]!);
  const isGroupBegin =
    activeMarker === 'begin-group' || activeMarker === 'begin-repeat';

  let predicted: SurveyRow[];
  if (isGroupBegin) {
    const endIdx = findMatchingEndIndex(survey, oldIndex);
    if (endIdx < 0) {
      return {
        kind: 'rejected',
        reason: 'unbalanced-source',
        message: 'Move blocked — this group has no matching end row. Fix the imbalance first.',
      };
    }
    if (newIndex > oldIndex && newIndex <= endIdx) {
      return {
        kind: 'rejected',
        reason: 'drop-inside-own-span',
        message: 'Move blocked — a group cannot land inside its own contents.',
      };
    }
    predicted = moveSurveySlice(survey, oldIndex, endIdx, newIndex);
  } else {
    predicted = arrayMove(survey, oldIndex, newIndex);
  }

  // Compare structural violations BEFORE/AFTER. A move never adds
  // violations when it stays inside the §A4 contract — but a leaf drag
  // that lands between a `begin` and its `end` would split the pair.
  const prevCount = findStructuralViolations(survey).length;
  const nextCount = findStructuralViolations(predicted).length;
  if (nextCount > prevCount) {
    const first = findStructuralViolations(predicted)[nextCount - 1]!;
    return {
      kind: 'rejected',
      reason: 'introduces-imbalance',
      message: `Move blocked — it would unbalance the form: ${first.message}`,
    };
  }

  return { kind: 'ok', next: predicted, isGroupMove: isGroupBegin };
}

/* ============================ planUngroup ============================ */

export type UngroupPlan =
  | { kind: 'ok'; next: SurveyRow[] }
  | {
      kind: 'rejected';
      reason: 'row-not-found' | 'not-a-begin' | 'no-matching-end';
      message: string;
    };

/**
 * Plan an "ungroup" operation: strip the `begin`/`end` shell around a
 * group while keeping the children at the parent depth. Returns a
 * `UngroupPlan` carrying the new survey or a stable rejection.
 *
 * Refuses when the begin row can't be found, when the indicated row
 * isn't a `begin group`/`begin repeat`, or when the group has no
 * matching `end` (an unbalanced survey — the §A6 banner already
 * surfaces this and the user should fix the imbalance first).
 */
export function planUngroup(survey: SurveyRow[], beginRowId: string): UngroupPlan {
  const beginIdx = survey.findIndex((r) => r.rowId === beginRowId);
  if (beginIdx < 0) {
    return {
      kind: 'rejected',
      reason: 'row-not-found',
      message: 'Ungroup blocked — the target row was not found.',
    };
  }
  const marker = structuralMarker(survey[beginIdx]!);
  if (marker !== 'begin-group' && marker !== 'begin-repeat') {
    return {
      kind: 'rejected',
      reason: 'not-a-begin',
      message: 'Ungroup blocked — the target is not a begin group / begin repeat row.',
    };
  }
  const endIdx = findMatchingEndIndex(survey, beginIdx);
  if (endIdx < 0) {
    return {
      kind: 'rejected',
      reason: 'no-matching-end',
      message:
        'Cannot ungroup — this group has no matching end row. Fix the imbalance first.',
    };
  }
  const next = [
    ...survey.slice(0, beginIdx),
    ...survey.slice(beginIdx + 1, endIdx),
    ...survey.slice(endIdx + 1),
  ];
  return { kind: 'ok', next };
}

/**
 * §B1 — pick the index where a top-level "+ Question" should land. The
 * Part-B Default app scaffold ends with linking `calculate` rows at
 * depth 0 (`patient_uuid` / `patient_id` / `created_by` /
 * `created_by_person_uuid`); appending past those would silently bury
 * the user's first real question behind invisible plumbing — Bhishan's
 * cold-start abandonment trigger.
 *
 * Returns the index of the FIRST row in the trailing depth-0 `calculate`
 * run, so a positional splice at that index lands the new row
 * immediately BEFORE the linking calculates. On a form with no trailing
 * calculates this returns `survey.length` and the legacy append-to-end
 * behaviour is preserved.
 *
 * Lives in shared (instead of FormEditor) so the contract is unit-
 * testable; FormEditor is JSX-rich and not natively node-test-runnable.
 */
export function defaultInsertIndex(survey: SurveyRow[]): number {
  let depth = 0;
  let trailingStart = -1;
  for (let j = 0; j < survey.length; j++) {
    const t = survey[j]!.type.trim().toLowerCase();
    if (t === 'begin group' || t === 'begin repeat') {
      depth++;
      trailingStart = -1;
      continue;
    }
    if (t === 'end group' || t === 'end repeat') {
      depth--;
      trailingStart = -1;
      continue;
    }
    if (depth !== 0) continue;
    if (t === 'calculate') {
      if (trailingStart === -1) trailingStart = j;
    } else {
      // Any other depth-0 row breaks the trailing-calc run — only an
      // UNBROKEN suffix of calculates at depth 0 counts.
      trailingStart = -1;
    }
  }
  return trailingStart === -1 ? survey.length : trailingStart;
}

/**
 * T9d (#17) — the index where "+ Question" lands when the author is ON a
 * row: directly after it. A `begin group` / `begin repeat` row counts as
 * "inside the group" (its first child), so the pair stays balanced; any
 * other row is followed by its new sibling, which keeps every enclosing
 * pair balanced too. An unknown or absent `rowId` falls back to
 * {@link defaultInsertIndex}, the before-the-trailing-plumbing position.
 */
export function insertIndexAfterRow(survey: SurveyRow[], rowId: string | null): number {
  if (!rowId) return defaultInsertIndex(survey);
  const idx = survey.findIndex((r) => r.rowId === rowId);
  if (idx < 0) return defaultInsertIndex(survey);
  return idx + 1;
}
