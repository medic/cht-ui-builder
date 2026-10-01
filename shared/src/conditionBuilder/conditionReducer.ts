/**
 * Pure state machine for the unified condition builder.
 *
 * Slice 2 of docs/plans/condition-builder.md v0.2. Commit B added flat
 * chaining; commit C wakes up the `groups` arm so a user can press
 * `( group these )`, collect the current flat clauses into subgroup 1,
 * then build a second subgroup joined by the OTHER combinator. Two
 * levels max (enforced by the parser type and at parse time); within
 * each subgroup the intra-connector is still locked (§3.3 — flat-mixed
 * is structurally impossible).
 *
 * The reducer lives in `shared/` (not `client/`) so it tests against
 * the existing `node --test "dist/**\/*.test.js"` runner without
 * standing up vitest. It has zero React imports and operates over
 * plain TS values + parser types from `../xlsform/relevantParser`.
 *
 * Responsibilities (plan §3, §5):
 *   - Hold the chain-building session state for a single
 *     `row.extras[column]` column: committed flat clauses + the
 *     in-flight draft, OR (in grouped mode) one or two subgroups plus
 *     the draft scoped to the active subgroup.
 *   - Reject the silent-AND/OR-mix invariant — `commit-clause('or')`
 *     while the locked / active-subgroup connector is `and` is a no-op.
 *     The legitimate way to mix is to enter grouped mode.
 *   - Rehydrate from an existing column value via `parseRelevantGrouped`
 *     so `${sex} = 'female' and ${age} > 18` reopens as two committed
 *     clauses + a locked AND, and `(A and B) or C` reopens as two
 *     subgroups + an outer OR. Grammar boundaries route to raw fallback
 *     (chaining disabled, text preserved verbatim).
 *   - Serialize the session state via `serializeAnyParsed` only — the
 *     legacy fragment-append path was removed in commit B (§3.7).
 */
import {
  parseRelevant,
  parseRelevantGrouped,
  serializeAnyParsed,
  serializeRelevant,
  type AnyParsed,
  type GroupedExpression,
  type ParsedExpression,
  type Rule,
} from '../xlsform/relevantParser.js';
import type { FieldKind } from '../xlsform/types.js';

/** Operators the visual builder offers. `and`/`or` are NOT here — those
 *  live between clauses (intra-subgroup) and between subgroups
 *  (outer-connector), never inside a single one (plan §3.7). */
export type ClauseOp =
  | '='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'selected'      // selected(${field}, 'value')
  | 'selected-not'  // not(selected(${field}, 'value'))
  | 'not'           // not(${field})
  | 'ref'           // ${field}
  | 'today';        // today()

/** A single atomic clause assembled in the strip. */
export interface Clause {
  field: string;
  op: ClauseOp;
  /** Empty for ops in {'ref','today','not','selected'-without-value}. */
  value: string;
  /**
   * The clause EXACTLY as the author wrote it, when this clause was
   * hydrated from a cell whose spelling differs from what `clauseToRule`
   * would emit for the same projection. Today that is `${f} != ''` /
   * `${f} = ''` (parser kind `answered`), which the strip shows as
   * "has an answer" / "is not selected" — the same labels as `${f}` /
   * `not(${f})` — but must never be rewritten into them (T9 invariant 1:
   * the preset is a projection; the stored text wins on save unless the
   * projection changed). Absent on every clause the user builds.
   */
  source?: string;
}

export type Connector = 'and' | 'or';

/**
 * Columns whose value is a BOOLEAN expression — the only columns this
 * builder owns. `calculation` is deliberately absent (plan
 * docs/plans/calculation-builder.md v0.2 §3.6 — the "double-door" fix):
 * a `calculation` cell produces a VALUE, not a yes/no, and routing it
 * through `parseRelevantGrouped` silently corrupted things like
 * `if(${a}=1, 2, 3)`. The dedicated `CalculationBuilder` editor handles
 * `calculation` instead, gated by `supportsCalculation` in FormEditor.
 */
export type ConditionColumn = 'relevant' | 'constraint' | 'choice_filter';

/** Runtime allow-list mirroring `ConditionColumn` — used by
 *  `hydrateColumn` as defensive insurance against a forced caller that
 *  bypasses the type narrowing (e.g. a persisted older state). */
const BOOLEAN_COLUMNS: ReadonlySet<string> = new Set<ConditionColumn>([
  'relevant',
  'constraint',
  'choice_filter',
]);

/**
 * One subgroup of a grouped expression. The intra-subgroup `connector`
 * locks after the first commit (same rule as flat mode); the outer
 * connector between subgroups lives in `state.outerConnector`.
 */
export interface Subgroup {
  clauses: Clause[];
  connector: Connector;
}

export interface ConditionBuilderState {
  column: ConditionColumn | '';
  /** Committed clauses for THIS column (flat mode). Empty in grouped mode. */
  clauses: Clause[];
  /** `connectors[i]` joins `clauses[i]` to `clauses[i + 1]` (flat mode). */
  connectors: Connector[];
  /** The currently-armed strip. Scoped to the active subgroup in grouped mode. */
  draft: Clause;
  /** Set after the first connector is chosen (flat mode). Null in grouped mode. */
  lockedConnector: Connector | null;
  /** Non-null when the existing column couldn't be cleanly parsed; chaining disabled. */
  rawFallback: string | null;
  /**
   * Non-null when the user has pressed `( group these )` or hydrated
   * from a grouped expression. Two-levels-max — each subgroup is a
   * single-combinator chain.
   */
  groups: Subgroup[] | null;
  /** The AND/OR between subgroups. Set once `groups.length === 2`. */
  outerConnector: Connector | null;
  /** Which subgroup the draft commits into. Null iff `groups === null`. */
  activeGroupIndex: number | null;
}

export const EMPTY_DRAFT: Clause = { field: '', op: '=', value: '' };

export const initialConditionBuilderState: ConditionBuilderState = {
  column: '',
  clauses: [],
  connectors: [],
  draft: EMPTY_DRAFT,
  lockedConnector: null,
  rawFallback: null,
  groups: null,
  outerConnector: null,
  activeGroupIndex: null,
};

/* ----------------------------- actions ----------------------------------- */

export type ConditionBuilderAction =
  | { kind: 'set-column'; column: ConditionColumn | ''; existingValue: string }
  | { kind: 'set-draft'; partial: Partial<Clause> }
  | { kind: 'commit-clause'; connector: Connector }
  | { kind: 'pop-clause' }
  | { kind: 'start-over' }
  | { kind: 'enter-group-mode' }
  | { kind: 'add-subgroup'; connector: Connector }
  | { kind: 'set-active-group'; index: number }
  | { kind: 'exit-group-mode' };

export function conditionBuilderReducer(
  state: ConditionBuilderState,
  action: ConditionBuilderAction,
): ConditionBuilderState {
  switch (action.kind) {
    case 'set-column': {
      if (!action.column) {
        return { ...initialConditionBuilderState };
      }
      return hydrateColumn(action.column, action.existingValue);
    }

    case 'set-draft':
      return { ...state, draft: { ...state.draft, ...action.partial } };

    case 'commit-clause': {
      // Plan §3.2: refuse a partial clause regardless of mode.
      if (!isDraftComplete(state.draft)) return state;

      // Flat mode: §3.3 forbids mixed-connector commits in a flat chain.
      if (state.groups === null) {
        if (state.lockedConnector !== null && state.lockedConnector !== action.connector) {
          return state;
        }
        const isFirstCommit = state.clauses.length === 0;
        return {
          ...state,
          clauses: [...state.clauses, state.draft],
          connectors: isFirstCommit
            ? state.connectors
            : [...state.connectors, action.connector],
          draft: EMPTY_DRAFT,
          lockedConnector: action.connector,
        };
      }

      // Grouped mode: route the clause into groups[activeGroupIndex].
      // Same intra-subgroup mixed-connector refusal.
      const idx = state.activeGroupIndex;
      if (idx === null) return state;
      const active = state.groups[idx];
      if (!active) return state;
      const isFirstInSubgroup = active.clauses.length === 0;
      if (
        !isFirstInSubgroup &&
        active.connector !== action.connector
      ) {
        return state;
      }
      const nextGroups = state.groups.map((g, i) =>
        i === idx
          ? {
              clauses: [...g.clauses, state.draft],
              connector: isFirstInSubgroup ? action.connector : g.connector,
            }
          : g,
      );
      return {
        ...state,
        groups: nextGroups,
        draft: EMPTY_DRAFT,
      };
    }

    case 'pop-clause': {
      // Flat mode.
      if (state.groups === null) {
        if (state.clauses.length === 0) return state;
        const nextClauses = state.clauses.slice(0, -1);
        const nextConnectors = state.connectors.slice(0, -1);
        return {
          ...state,
          clauses: nextClauses,
          connectors: nextConnectors,
          lockedConnector: nextClauses.length > 1 ? state.lockedConnector : null,
        };
      }
      // Grouped mode: pop from the active subgroup. If that empties the
      // ACTIVE subgroup AND it was subgroup 2, drop subgroup 2 entirely
      // and snap active back to 0. If subgroup 1 emptied AND there's no
      // subgroup 2, collapse out of grouped mode (rare — pop only deletes
      // groups[0] when groups[1] doesn't exist).
      const idx = state.activeGroupIndex;
      if (idx === null) return state;
      const active = state.groups[idx];
      if (!active || active.clauses.length === 0) return state;
      const poppedClauses = active.clauses.slice(0, -1);
      const poppedConnector =
        poppedClauses.length > 1 ? active.connector : 'and';

      if (poppedClauses.length === 0 && idx === 1) {
        // Subgroup 2 emptied → drop it.
        return {
          ...state,
          groups: [state.groups[0]!],
          outerConnector: null,
          activeGroupIndex: 0,
          // The intra-subgroup connector of an empty group is meaningless;
          // reset to 'and' for cleanliness.
          // (intra-subgroup 1 connector preserved as state.groups[0])
        };
      }
      if (poppedClauses.length === 0 && idx === 0 && state.groups.length === 1) {
        // Subgroup 1 emptied AND no subgroup 2 → collapse out of grouped
        // mode entirely.
        return {
          ...state,
          groups: null,
          outerConnector: null,
          activeGroupIndex: null,
        };
      }
      // Otherwise just shrink the active subgroup.
      const nextGroups = state.groups.map((g, i) =>
        i === idx
          ? { clauses: poppedClauses, connector: poppedConnector }
          : g,
      );
      return { ...state, groups: nextGroups };
    }

    case 'start-over': {
      // Byte-safe: zero all session state. Column preserved (rehydratable).
      // The caller never writes to row.extras as a result (plan §3.5).
      return {
        ...state,
        clauses: [],
        connectors: [],
        draft: EMPTY_DRAFT,
        lockedConnector: null,
        groups: null,
        outerConnector: null,
        activeGroupIndex: null,
      };
    }

    case 'enter-group-mode': {
      // Pre: 2+ clauses, no existing group state, no raw fallback,
      // and the draft is either empty or completable (we preserve the
      // draft verbatim — Bhishan's mid-thought clause stays put).
      if (state.clauses.length < 2) return state;
      if (state.groups !== null) return state;
      if (state.rawFallback !== null) return state;
      // Refuse if the draft is partial-but-incomplete — we won't silently
      // drop input. Empty or complete is OK.
      const draftStarted = !isDraftEmpty(state.draft);
      const draftComplete = isDraftComplete(state.draft);
      if (draftStarted && !draftComplete) return state;
      // Collect existing flat clauses into subgroup 1.
      const subgroup1: Subgroup = {
        clauses: [...state.clauses],
        connector: state.lockedConnector ?? 'and',
      };
      return {
        ...state,
        clauses: [],
        connectors: [],
        lockedConnector: null,
        groups: [subgroup1],
        outerConnector: null,
        activeGroupIndex: 0,
        // draft preserved verbatim
      };
    }

    case 'add-subgroup': {
      // Pre: groups has exactly one subgroup with >= 1 clause.
      if (state.groups === null) return state;
      if (state.groups.length !== 1) return state;
      if (state.groups[0]!.clauses.length === 0) return state;
      return {
        ...state,
        outerConnector: action.connector,
        groups: [state.groups[0]!, { clauses: [], connector: 'and' }],
        activeGroupIndex: 1,
        // draft preserved — user might already have started typing the
        // first clause of subgroup 2 before clicking the outer connector.
      };
    }

    case 'set-active-group': {
      // Switch focus between subgroups. UI is responsible for confirming
      // any in-flight draft first; we refuse if the draft is partial-
      // but-incomplete (no silent loss).
      if (state.groups === null) return state;
      if (state.activeGroupIndex === null) return state;
      if (action.index < 0 || action.index >= state.groups.length) return state;
      if (action.index === state.activeGroupIndex) return state;
      const draftStarted = !isDraftEmpty(state.draft);
      const draftComplete = isDraftComplete(state.draft);
      if (draftStarted && !draftComplete) return state;
      return { ...state, activeGroupIndex: action.index };
    }

    case 'exit-group-mode': {
      // "Flatten" — only safe with one non-empty subgroup; with two
      // non-empty subgroups it would force flat-mixed AND/OR (refused).
      if (state.groups === null) return state;
      // If exactly one subgroup is empty, drop it first.
      const nonEmpty = state.groups.filter((g) => g.clauses.length > 0);
      if (nonEmpty.length === 0) {
        // Both empty — clean exit, no clauses to restore.
        return {
          ...state,
          groups: null,
          outerConnector: null,
          activeGroupIndex: null,
        };
      }
      if (nonEmpty.length >= 2) {
        // Two non-empty subgroups joined by an outer combinator — can't
        // collapse without losing semantics. Refuse.
        return state;
      }
      // Exactly one non-empty subgroup → collapse to flat.
      const sole = nonEmpty[0]!;
      return {
        ...state,
        clauses: [...sole.clauses],
        connectors:
          sole.clauses.length > 1
            ? Array.from({ length: sole.clauses.length - 1 }, () => sole.connector)
            : [],
        lockedConnector: sole.clauses.length > 1 ? sole.connector : null,
        groups: null,
        outerConnector: null,
        activeGroupIndex: null,
      };
    }
  }
}

/* ---------------------------- serialization ------------------------------ */

/**
 * Serialize the current session to a single XLSForm-column string.
 * In grouped mode the output is `(A and B) or (C and D)`-shaped;
 * structurally cannot be flat-mixed.
 */
export function serializeBuilderState(state: ConditionBuilderState): string {
  if (state.rawFallback !== null) return state.rawFallback;

  if (state.groups !== null) {
    return serializeGrouped(state);
  }

  // Flat path (unchanged from commit B).
  const allClauses = [...state.clauses];
  if (isDraftComplete(state.draft)) allClauses.push(state.draft);
  if (allClauses.length === 0) return '';
  const combinator: Connector = state.lockedConnector ?? 'and';
  const rules: Rule[] = allClauses.map(clauseToRule);
  const flat: ParsedExpression = { combinator, rules, isRawFallback: false };
  return serializeAnyParsed(flat);
}

function serializeGrouped(state: ConditionBuilderState): string {
  const groups = state.groups!;
  // Build a ParsedExpression for each subgroup. The draft, if complete,
  // is included in the active subgroup so the preview reflects work in
  // flight.
  const idx = state.activeGroupIndex;
  const built: ParsedExpression[] = groups.map((g, i) => {
    const clauses =
      i === idx && isDraftComplete(state.draft)
        ? [...g.clauses, state.draft]
        : g.clauses;
    return {
      combinator: g.connector,
      rules: clauses.map(clauseToRule),
      isRawFallback: false,
    };
  });
  // Drop empty subgroups before serialization — they have no semantics
  // and serializeAnyParsed would emit a stray `()`.
  const nonEmpty = built.filter((p) => p.rules.length > 0);
  if (nonEmpty.length === 0) return '';
  if (nonEmpty.length === 1) {
    // Single subgroup: degrade to flat shape, no parens.
    return serializeAnyParsed(nonEmpty[0]!);
  }
  const outer = state.outerConnector ?? 'and';
  const grouped: GroupedExpression = {
    kind: 'grouped',
    outerCombinator: outer,
    subgroups: nonEmpty,
    isRawFallback: false,
  };
  return serializeAnyParsed(grouped);
}

/**
 * True when the current session has enough to insert.
 * - Flat mode: at least one complete clause OR a complete draft;
 *   no dangling connector (partial draft with committed clauses is rejected).
 * - Grouped mode: every non-empty subgroup must be valid, and the
 *   active subgroup's draft is either empty or complete; at least one
 *   subgroup must contain a clause.
 */
export function isInsertReady(state: ConditionBuilderState): boolean {
  if (state.column === '') return false;
  if (state.rawFallback !== null) return false;

  if (state.groups !== null) {
    // The draft must not be partial in any subgroup's active position.
    if (!isDraftEmpty(state.draft) && !isDraftComplete(state.draft)) return false;
    // At least one clause somewhere.
    const totalClauses = state.groups.reduce(
      (n, g) => n + g.clauses.length,
      0,
    );
    if (totalClauses === 0 && !isDraftComplete(state.draft)) return false;
    return true;
  }

  // Flat mode (unchanged from commit B).
  const draftComplete = isDraftComplete(state.draft);
  if (state.clauses.length === 0) return draftComplete;
  if (isDraftEmpty(state.draft)) return true;
  return draftComplete;
}

/* ----------------------------- helpers ----------------------------------- */

export function isDraftEmpty(c: Clause): boolean {
  return c.field === '' && c.value === '' && c.op === '=';
}

export function isDraftComplete(c: Clause): boolean {
  if (c.op === 'today') return true;
  if (c.op === 'ref' || c.op === 'not') return c.field !== '';
  if (c.op === 'selected' || c.op === 'selected-not') {
    return c.field !== '' && c.value !== '';
  }
  return c.field !== '' && c.value !== '';
}

function clauseToRule(c: Clause): Rule {
  // A hydrated clause carries the author's own spelling. Re-emit it while
  // it still projects to the same clause (field / op / value); the user
  // cannot edit a committed clause in place, but a stale `source` on a
  // clause that no longer matches would otherwise write the OLD text.
  if (c.source !== undefined) {
    const parsed = parseRelevant(c.source);
    const sole = parsed.rules.length === 1 ? parsed.rules[0] : undefined;
    if (sole && !parsed.isRawFallback) {
      const projected = projectRule(sole);
      if (
        projected &&
        projected.field === c.field &&
        projected.op === c.op &&
        projected.value === c.value
      ) {
        return sole;
      }
    }
  }
  return clauseToCanonicalRule(c);
}

/** The rule the builder emits for a clause it built itself (`${field}` spelling). */
function clauseToCanonicalRule(c: Clause): Rule {
  if (c.op === 'today') return { kind: 'raw', text: 'today()' };
  if (c.op === 'ref') return { kind: 'truthy', field: c.field, negated: false };
  if (c.op === 'not') return { kind: 'truthy', field: c.field, negated: true };
  if (c.op === 'selected') {
    return { kind: 'selected', field: c.field, value: c.value, negated: false };
  }
  if (c.op === 'selected-not') {
    return { kind: 'selected', field: c.field, value: c.value, negated: true };
  }
  const valueRaw = c.value;
  if (valueRaw === '') {
    return { kind: 'comparison', field: c.field, op: c.op, value: '', valueIsString: true };
  }
  if (/^\$\{[^}]+\}$/.test(valueRaw) || /^-?\d+(\.\d+)?$/.test(valueRaw)) {
    return { kind: 'comparison', field: c.field, op: c.op, value: valueRaw, valueIsString: false };
  }
  return { kind: 'comparison', field: c.field, op: c.op, value: valueRaw, valueIsString: true };
}

function ruleToClause(r: Rule): Clause | null {
  const projected = projectRule(r);
  if (projected === null) return null;
  // Keep the author's spelling whenever the canonical emission for this
  // projection would differ: `${f} != ''` (answered) and every `../field`
  // rule (T9a) read as the same clause as their `${f}` counterparts but
  // must save back byte-identical when the user never touched them.
  const authored = serializeRelevant({ combinator: 'and', rules: [r], isRawFallback: false });
  const canonical = serializeRelevant({
    combinator: 'and',
    rules: [clauseToCanonicalRule(projected)],
    isRawFallback: false,
  });
  return authored === canonical ? projected : { ...projected, source: authored };
}

/** The clause a rule reads as, ignoring spelling. Null when there is no 1:1. */
function projectRule(r: Rule): Clause | null {
  if (r.kind === 'comparison') {
    return { field: r.field, op: r.op, value: r.value };
  }
  if (r.kind === 'selected') {
    return {
      field: r.field,
      op: r.negated ? 'selected-not' : 'selected',
      value: r.value,
    };
  }
  if (r.kind === 'truthy') {
    return { field: r.field, op: r.negated ? 'not' : 'ref', value: '' };
  }
  if (r.kind === 'answered') {
    // `${f} != ''` reads as "has an answer" and `${f} = ''` as "is not selected".
    return { field: r.field, op: r.negated ? 'not' : 'ref', value: '' };
  }
  // date_offset / age / contact-* / the T9a `.`-subject kinds / raw don't
  // have a 1:1 in the Clause shape (the `.` kinds get theirs in 9e / 9f).
  return null;
}

function rulesToSubgroup(parsed: ParsedExpression): Subgroup | null {
  const clauses: Clause[] = [];
  for (const rule of parsed.rules) {
    const c = ruleToClause(rule);
    if (c === null) return null;
    clauses.push(c);
  }
  return { clauses, connector: parsed.combinator };
}

function hydrateColumn(
  column: ConditionColumn,
  existingValue: string,
): ConditionBuilderState {
  // Defensive insurance against a forced caller (an older persisted state
  // or non-type-safe consumer) that hands us a non-boolean column like
  // `calculation`. Without this, parseRelevantGrouped would silently
  // corrupt a value-producing cell (plan v0.2 §3.6).
  if (!BOOLEAN_COLUMNS.has(column)) {
    return { ...initialConditionBuilderState, column };
  }
  const parsed: AnyParsed = parseRelevantGrouped(existingValue);

  // Raw fallback — keep the text editable in the UI, disable chaining.
  if (parsed.isRawFallback) {
    return {
      ...initialConditionBuilderState,
      column,
      rawFallback: existingValue,
    };
  }

  // Grouped expression: populate the groups arm directly. The newest
  // subgroup (the second one) is active by default — that's the one the
  // user most recently appended.
  if ('subgroups' in parsed) {
    const subgroups: Subgroup[] = [];
    for (const sub of parsed.subgroups) {
      const sg = rulesToSubgroup(sub);
      if (sg === null) {
        // Any sub-clause we can't represent → raw fallback for safety.
        return {
          ...initialConditionBuilderState,
          column,
          rawFallback: existingValue,
        };
      }
      subgroups.push(sg);
    }
    if (subgroups.length === 0) {
      return { ...initialConditionBuilderState, column };
    }
    if (subgroups.length === 1) {
      // Degenerate grouped-with-one-subgroup → reopen as flat.
      const sole = subgroups[0]!;
      return {
        ...initialConditionBuilderState,
        column,
        clauses: [...sole.clauses],
        connectors:
          sole.clauses.length > 1
            ? Array.from(
                { length: sole.clauses.length - 1 },
                () => sole.connector,
              )
            : [],
        lockedConnector: sole.clauses.length > 1 ? sole.connector : null,
      };
    }
    return {
      ...initialConditionBuilderState,
      column,
      groups: subgroups,
      outerConnector: parsed.outerCombinator,
      activeGroupIndex: subgroups.length - 1,
    };
  }

  // Flat chain (zero or more rules joined by a single combinator).
  const clauses: Clause[] = [];
  for (const rule of parsed.rules) {
    const c = ruleToClause(rule);
    if (c === null) {
      return {
        ...initialConditionBuilderState,
        column,
        rawFallback: existingValue,
      };
    }
    clauses.push(c);
  }
  return {
    ...initialConditionBuilderState,
    column,
    clauses,
    connectors:
      clauses.length > 1
        ? Array.from({ length: clauses.length - 1 }, () => parsed.combinator)
        : [],
    lockedConnector: clauses.length > 1 ? parsed.combinator : null,
  };
}

/* ---------------------- type-aware soft filter (v0.3) -------------------- */

/**
 * Single source of truth for type-aware operator filtering (plan v0.3 §2).
 * Keyed by the **real** 11-value `ClauseOp` union — `Record<ClauseOp, …>`
 * makes adding a future op a compile error until it has a kind list. Each
 * entry lists the {@link FieldKind} values the operator is "typical" for;
 * `unknown` is OMITTED here and injected at filter time as universally
 * compatible. Any kind absent from an op's list is treated identically to
 * `unknown` (always-pass) — that's the never-de-emphasize contract for
 * future `FieldKind` enum growth.
 *
 * `not` and `ref` are deliberately broad and identical: the answered /
 * negation check applies to any answerable field. `today` is field-
 * independent (the field `<select>` is disabled by `COND_OPS_NEED_FIELD`
 * in the client), so its list is harmless but kept exhaustive.
 */
export const OP_FIELD_KINDS: Record<ClauseOp, FieldKind[]> = {
  '=': ['text', 'numeric', 'date', 'choice'],
  '!=': ['text', 'numeric', 'date', 'choice'],
  '>': ['numeric', 'date'],
  '<': ['numeric', 'date'],
  '>=': ['numeric', 'date'],
  '<=': ['numeric', 'date'],
  selected: ['choice'],
  'selected-not': ['choice'],
  not: ['text', 'numeric', 'date', 'choice', 'geo'],
  ref: ['text', 'numeric', 'date', 'choice', 'geo'],
  today: ['text', 'numeric', 'date', 'choice', 'geo'],
};

/**
 * Union of every kind that appears in any `OP_FIELD_KINDS` entry. Used by
 * {@link fieldsTypicalForOp} to give a graceful "always-pass" verdict to
 * any future `FieldKind` value the map hasn't been updated for — protecting
 * the never-de-emphasize contract against enum growth (plan v0.3 §2).
 */
const LISTED_KINDS: Set<FieldKind> = new Set(
  (Object.values(OP_FIELD_KINDS) as FieldKind[][]).flat(),
);

/**
 * Predicate: is `kind` "typical" for `op`? Returns `true` for `'unknown'`
 * and for any kind that hasn't been enumerated anywhere in `OP_FIELD_KINDS`
 * (graceful fall-through). Only enumerated kinds that are explicitly absent
 * from an op's list count as atypical.
 *
 * Pure selector — never mutates draft state, never reaches a serializer.
 */
export function fieldsTypicalForOp(op: ClauseOp, kind: FieldKind): boolean {
  if (kind === 'unknown') return true;
  if (!LISTED_KINDS.has(kind)) return true;
  return OP_FIELD_KINDS[op].includes(kind);
}

/**
 * The set of ops "typical" for a given `kind`, in `ClauseOp` declaration
 * order. `'unknown'` (and any future unlisted kind) → all 11 ops, so the
 * op picker stays maximally permissive when the field can't be classified.
 */
const ALL_OPS: ClauseOp[] = Object.keys(OP_FIELD_KINDS) as ClauseOp[];

export function opsTypicalForKind(kind: FieldKind): ClauseOp[] {
  if (kind === 'unknown' || !LISTED_KINDS.has(kind)) return [...ALL_OPS];
  return ALL_OPS.filter((op) => OP_FIELD_KINDS[op].includes(kind));
}
