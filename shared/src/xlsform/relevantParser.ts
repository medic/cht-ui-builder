/**
 * Parser and serializer for a USEFUL SUBSET of XLSForm `relevant` /
 * `constraint` / `choice_filter` expressions.
 *
 * We support the patterns that show up in 90%+ of CHT forms surveyed:
 *
 *   ${age} >= 15
 *   ${sex} = 'female'
 *   ${age} >= 15 and ${age} <= 45 and ${sex} = 'female'
 *   selected(${conditions}, 'heart_condition')
 *   not(selected(${conditions}, 'none'))
 *   ${field} != ''   (i.e. "is answered")
 *
 * Anything outside this grammar is returned as a "raw" rule with the
 * original text; the UI still lets the user keep it. Round-trip safety:
 * if the user opens an expression we can't parse, edits *other* rules,
 * and saves, the raw text is preserved.
 */

import {
  recognizeReference,
  emitContactInput,
  emitContactSummary,
} from './calcReference.js';
import {
  parseOperand,
  serializeOperand,
  type Operand,
  type RefSpelling,
} from './operand.js';

export type { Operand, RefSpelling, BinaryOp } from './operand.js';
export {
  parseOperand,
  serializeOperand,
  isSelfOperand,
  operandFields,
  KNOWN_FUNCTIONS,
} from './operand.js';

export type Operator = '=' | '!=' | '>' | '<' | '>=' | '<=';
export type Combinator = 'and' | 'or';

/**
 * How a field-subject rule spells its reference. Absent means `${field}`;
 * `'relative'` means the author wrote `../field`, which real forms use as
 * an alias (T9a, #14). The spelling is re-emitted exactly as written and
 * never rewritten in either direction.
 */
export type FieldRefSpelling = RefSpelling;

export interface ComparisonRule {
  kind: 'comparison';
  field: string;
  op: Operator;
  value: string;
  /** True if value should be wrapped in quotes when serialized back. */
  valueIsString: boolean;
  /** `'relative'` when the subject was written `../field`. See {@link FieldRefSpelling}. */
  refSpelling?: FieldRefSpelling;
}

export interface SelectedRule {
  kind: 'selected';
  field: string;
  value: string;
  /** If true, the rule is `not(selected(...))`. */
  negated: boolean;
  /** `'relative'` when the subject was written `../field`. */
  refSpelling?: FieldRefSpelling;
}

export interface AnsweredRule {
  kind: 'answered';
  field: string;
  /** If true, expression is `${field} = ''` (the field is NOT answered). */
  negated: boolean;
  /** `'relative'` when the subject was written `../field`. */
  refSpelling?: FieldRefSpelling;
}

/**
 * A field reference used directly as the boolean — `${field}` ("has an
 * answer" in the inline builder) or `not(${field})` ("is not selected").
 *
 * T9b (#15): the inline builder has always WRITTEN these two spellings but
 * emitted them as `raw`, so on reopen the parser handed back a raw rule and
 * the builder disabled every control. A rule the tool itself produced must
 * open in the tool, so they get a real kind. Spacing-divergent spellings
 * (`${ f }`, `not( ${f} )`) are demoted to raw by the self-check as usual.
 *
 * This is NOT the same rule as `answered` (`${f} != ''` / `${f} = ''`): the
 * two spellings are never rewritten into each other.
 */
export interface TruthyRule {
  kind: 'truthy';
  field: string;
  /** True for `not(${field})`. */
  negated: boolean;
  /** `'relative'` when the subject was written `../field`. */
  refSpelling?: FieldRefSpelling;
}

/**
 * T9a (#14) — a comparison whose subject is NOT a bare field reference:
 * the answer itself (`. >= 0`), a function over it (`string-length(.) <=
 * 100`, `int(format-date(., '%Y')) > 2000`), arithmetic (`int(format-date(
 * today(), '%Y')) + 57 >= int(.)`), or any operand against any operand
 * (`. > max(coalesce(${a}, 0), coalesce(${b}, 0))`). 774 of the 777 real
 * `constraint` rules have a subject of this shape.
 *
 * `source` is the clause exactly as the author wrote it. The serializer
 * re-emits it while it still parses to the same `lhs` / `op` / `rhs`, so
 * `.<=100` opens as a rule and saves back as `.<=100`; only a rule the
 * author changed is emitted in canonical spacing. Absent on rules the UI
 * builds from scratch.
 */
export interface ExprComparisonRule {
  kind: 'expr-comparison';
  lhs: Operand;
  op: Operator;
  rhs: Operand;
  source?: string;
}

/** Functions that are themselves a boolean test when called on an answer. */
export type PredicateFn = 'regex' | 'selected' | 'contains' | 'starts-with' | 'ends-with';

/**
 * T9a — `regex(., '…')`, `selected(., 'none')`, `contains(., 'x')`, each
 * optionally wrapped in `not(…)`. A `selected(${field}, …)` with a field
 * subject stays a {@link SelectedRule}; this kind is for every other
 * subject. `source` as on {@link ExprComparisonRule}.
 */
export interface PredicateRule {
  kind: 'predicate';
  fn: PredicateFn;
  args: Operand[];
  negated: boolean;
  source?: string;
}

/**
 * T9a — `not(A and B)`: a negated flat chain, the shape of the "[None] must
 * be chosen alone" rule `not(selected(., 'none') and count-selected(.) > 1)`
 * (50 real rules). The inner chain is flat and fully structured (no raw
 * parts, no second level of parens); anything else stays raw.
 */
export interface NotGroupRule {
  kind: 'not-group';
  combinator: Combinator;
  rules: Rule[];
  source?: string;
}

/**
 * T9a — `true`, `true()` or `1`: a placeholder constraint that always
 * passes (51 real rows). The UI can label it; the text is carried verbatim
 * and never rewritten to a different spelling.
 */
export interface AlwaysTrueRule {
  kind: 'always-true';
  text: string;
}

export interface RawRule {
  kind: 'raw';
  text: string;
}

export type DateUnit = 'days' | 'weeks' | 'months' | 'years';
export type DateOffsetComparator = 'more_than' | 'less_than';
export type DateOffsetDirection = 'ago' | 'from_now';

/**
 * "${field} is more/less than N days/weeks/months/years ago/from now" —
 * sugar over a date-arithmetic XPath expression. Serializes to
 *
 *   today() - ${field} > 20*365.25     (more than 20 years ago)
 *   today() - ${field} < 30            (less than 30 days ago)
 *   ${field} - today() > 7             (more than 7 days from now)
 */
export interface DateOffsetRule {
  kind: 'date_offset';
  field: string;
  comparator: DateOffsetComparator;
  /** Number as a string, so we can preserve "1.5" or empty-while-editing. */
  amount: string;
  unit: DateUnit;
  direction: DateOffsetDirection;
}

/**
 * "Age computed from ${field} op N years" — sugar over
 * `floor((today() - ${field}) div 365.25) op N`. Always whole-year integer
 * age. Op uses the standard Operator set.
 */
export interface AgeRule {
  kind: 'age';
  field: string;
  op: Operator;
  /** Number as a string, e.g. "20". */
  value: string;
}

/**
 * Comparison of a contact-form input field (`../inputs/contact/<field>`)
 * against a literal — Phase 1b of form-data-passing.md §3. Mirrors the
 * calc builder's `contact-input` kind so the relevant/constraint/
 * choice_filter cells can gate on data hydrated from the contact.
 *
 * The LHS is recognized via the same regex calcReference's
 * recognizeReference() uses; valueIsString preserves the original
 * quote semantics (real production CHT uses both `!= ''` and `!= 0`
 * variants — preserving the flag exactly is what keeps round-trip
 * byte-stable).
 */
export interface ContactInputComparisonRule {
  kind: 'contact-input-comparison';
  /** Contact-input field name (the `<field>` in `../inputs/contact/<field>`). */
  field: string;
  op: Operator;
  value: string;
  valueIsString: boolean;
}

/**
 * Comparison of a contact-summary context flag
 * (`instance('contact-summary')/context/<key>`, optionally wrapped in
 * `once(...)` or `if(ref, ref, .)`) against a literal — also Phase 1b.
 * Wrapper is the same `ContextWrapper` the calc builder uses; the
 * fallback-to-current wrapper requires BOTH refs to be identical
 * (calcReference.ts:126), and anything spacing-divergent is demoted
 * to raw by the §3.1 self-check.
 */
export interface ContactSummaryComparisonRule {
  kind: 'contact-summary-comparison';
  /** Context-summary key (the `<key>` in
   *  `instance('contact-summary')/context/<key>`). */
  contextKey: string;
  /** Wrapper around the reference — `none` is the bare ref. */
  wrapper: import('./calcReference.js').ContextWrapper;
  /**
   * The emptiness sentinel of a `guarded-fallback` reference, verbatim — `''`
   * or `0`. They are not interchangeable, so it is carried rather than
   * normalised. `null`/absent for every other wrapper.
   */
  sentinel?: string | null;
  /**
   * The reference EXACTLY as the author wrote it, when this rule was parsed
   * from an existing cell.
   *
   * Re-emitted verbatim as long as it still describes the same key, wrapper
   * and sentinel, because the emitters write one canonical spacing while real
   * cells do not: 17 of lumbini's context reads are `coalesce(REF,.)` with no
   * space. Once the recognizer learned that idiom, re-serialising it with the
   * canonical spacing failed the round-trip self-check, and the self-check
   * demotes the WHOLE expression to one raw rule — so an untouched sibling
   * clause like `${age} > 5` silently lost its editable row. Bytes were never
   * at risk; structured editing was.
   */
  refSource?: string;
  op: Operator;
  value: string;
  valueIsString: boolean;
}

export type Rule =
  | ComparisonRule
  | SelectedRule
  | AnsweredRule
  | TruthyRule
  | ExprComparisonRule
  | PredicateRule
  | NotGroupRule
  | AlwaysTrueRule
  | DateOffsetRule
  | AgeRule
  | ContactInputComparisonRule
  | ContactSummaryComparisonRule
  | RawRule;

const UNIT_DAYS: Record<DateUnit, number> = {
  days: 1,
  weeks: 7,
  months: 30,
  years: 365.25,
};

function unitForMultiplier(mult: number | null): DateUnit | null {
  if (mult === null || mult === 1) return 'days';
  if (mult === 7) return 'weeks';
  if (mult === 30) return 'months';
  if (mult === 365.25) return 'years';
  return null;
}

export interface ParsedExpression {
  combinator: Combinator;
  rules: Rule[];
  /** Whether the whole expression had to be treated as raw because grammar didn't match. */
  isRawFallback: boolean;
}

/**
 * A parenthesized mixed-combinator expression: `(A and B) or C`,
 * `A or (B and C)`, `(A and B) or (C and D)`, etc.
 *
 * Structurally non-recursive: each `subgroup` is a same-combinator
 * `ParsedExpression`, NOT another `GroupedExpression`. This enforces the
 * two-levels-max grammar boundary at the type level — a three-level
 * expression like `((A and B) or C) and D` cannot be represented and
 * routes to raw at parse time.
 *
 * Added in Slice 2 of the condition-builder plan (docs/plans/
 * condition-builder.md). The existing `parseRelevant`/`serializeRelevant`
 * signatures are unchanged; this is exposed via the additive
 * `parseRelevantGrouped` / `serializeAnyParsed` entry points so the 5
 * existing consumers (RelevantRuleBuilder.tsx, CalculationBuilder.tsx,
 * DecisionsView.tsx, shared/calculationBuilder.ts) never see the union.
 */
export interface GroupedExpression {
  kind: 'grouped';
  outerCombinator: Combinator;
  /** Each subgroup is a same-combinator chain (non-recursive: no nested grouped). */
  subgroups: ParsedExpression[];
  /** True iff the grammar didn't match cleanly and we kept the whole thing as raw. */
  isRawFallback: boolean;
}

/**
 * Discriminated union of the flat (`ParsedExpression`) and parenthesized-
 * mixed (`GroupedExpression`) shapes. Discriminate via `'subgroups' in
 * parsed` — we deliberately do NOT add a `kind` field to
 * `ParsedExpression` (that would break the `{...parsed, rules}` spreads
 * at RelevantRuleBuilder.tsx:48/51 — see plan §3 HARD RULE).
 */
export type AnyParsed = ParsedExpression | GroupedExpression;

/** Parse an expression into rules + a combinator (default 'and'). */
export function parseRelevant(expr: string): ParsedExpression {
  const trimmed = expr.trim();
  if (!trimmed) return { combinator: 'and', rules: [], isRawFallback: false };

  // Detect outer combinator. If both `and` and `or` appear, we give up
  // and return raw — mixing requires precedence handling.
  const containsAnd = /\band\b/i.test(trimmed);
  const containsOr = /\bor\b/i.test(trimmed);
  if (containsAnd && containsOr) {
    return { combinator: 'and', rules: [{ kind: 'raw', text: trimmed }], isRawFallback: true };
  }
  const combinator: Combinator = containsOr ? 'or' : 'and';

  const parts = splitOnCombinator(trimmed, combinator);
  const rules: Rule[] = [];
  let anyRaw = false;
  for (const p of parts) {
    const r = parseSinglePart(p);
    if (r.kind === 'raw') anyRaw = true;
    rules.push(r);
  }
  const candidate: ParsedExpression = {
    combinator,
    rules,
    isRawFallback: anyRaw && rules.every((r) => r.kind === 'raw'),
  };

  // §3.1 self-check (plan: docs/plans/condition-builder.md). The serializer
  // canonicalizes spacing (`${a}='x'` → `${a} = 'x'`, comma after `,` in
  // `selected(${f}, 'v')`, etc.), so a structured parse of a tight-spaced
  // human input would silently reformat the user's text on save. To make
  // byte-stability real: re-serialize the candidate and, if it doesn't
  // match the original trimmed input, discard the structured result and
  // return a single RawRule carrying the original text. This guarantees
  // `serialize(parse(x)) === x.trim()` for every non-raw result, and any
  // expression whose canonical form differs from the author's spelling
  // is preserved verbatim as raw rather than reformatted.
  if (!candidate.isRawFallback && serializeRelevant(candidate) !== trimmed) {
    return { combinator: 'and', rules: [{ kind: 'raw', text: trimmed }], isRawFallback: true };
  }
  // T9a (#14): the same check on an all-raw chain. Splitting on the
  // combinator trims each part and rejoins with single spaces, so a chain
  // written `a and  b` (two spaces; six distinct real FCHV / LMP
  // constraints) came back one byte different. The self-check is
  // authoritative on every path: when the split parts cannot reproduce the
  // text, keep the whole expression as ONE raw rule.
  if (candidate.isRawFallback && serializeRelevant(candidate) !== trimmed) {
    return { combinator: 'and', rules: [{ kind: 'raw', text: trimmed }], isRawFallback: true };
  }
  return candidate;
}

/** Serialize rules back to an XLSForm expression. */
export function serializeRelevant(parsed: ParsedExpression): string {
  if (parsed.rules.length === 0) return '';
  if (parsed.rules.length === 1) return ruleToString(parsed.rules[0]!);
  return parsed.rules.map(ruleToString).join(` ${parsed.combinator} `);
}

/** Cheap, paren-aware split that respects function-call parens. */
function splitOnCombinator(expr: string, combinator: Combinator): string[] {
  const out: string[] = [];
  let depth = 0;
  let i = 0;
  let last = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0) {
      // Look for ` and ` or ` or ` boundary at word level.
      const w = wordAt(expr, i);
      if (w && w.toLowerCase() === combinator) {
        const prevCh = expr[i - 1];
        const nextCh = expr[i + w.length];
        if (
          (i === 0 || prevCh === ' ' || prevCh === '\t' || prevCh === ')') &&
          (nextCh === ' ' || nextCh === '\t' || nextCh === '(' || nextCh === undefined)
        ) {
          out.push(expr.slice(last, i).trim());
          i += w.length;
          last = i;
          continue;
        }
      }
    }
    i++;
  }
  out.push(expr.slice(last).trim());
  return out.filter(Boolean);
}

function wordAt(s: string, i: number): string | null {
  if (!/[a-zA-Z]/.test(s[i] ?? '')) return null;
  let j = i;
  while (j < s.length && /[a-zA-Z]/.test(s[j] ?? '')) j++;
  return s.slice(i, j);
}

/** Parse one boolean clause into a Rule. */
function parseSinglePart(part: string): Rule {
  const t = part.trim();
  if (!t) return { kind: 'raw', text: '' };

  // age: floor((today() - ${field}) div 365.25) OP N
  const ageRe = /^floor\(\(\s*today\(\)\s*-\s*\$\{\s*([^}\s]+)\s*\}\s*\)\s*div\s*365(?:\.25)?\s*\)\s*(>=|<=|!=|=|>|<)\s*(-?\d+(?:\.\d+)?)$/i;
  const ageMatch = ageRe.exec(t);
  if (ageMatch && ageMatch[1] && ageMatch[2] && ageMatch[3] !== undefined) {
    return {
      kind: 'age',
      field: ageMatch[1],
      op: ageMatch[2] as Operator,
      value: ageMatch[3],
    };
  }

  // date_offset (ago):    (today() - ${field}) > N            | N*7 | N*30 | N*365.25
  // date_offset (future): (${field} - today()) > N           | etc.
  // Parens optional. Comparator is > / < (>= and <= treated as same intent).
  const offRe = /^\(?\s*(today\(\)|\$\{\s*[^}\s]+\s*\})\s*-\s*(today\(\)|\$\{\s*[^}\s]+\s*\})\s*\)?\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)(?:\s*\*\s*(-?\d+(?:\.\d+)?))?$/i;
  const offMatch = offRe.exec(t);
  if (offMatch) {
    const left = offMatch[1]!;
    const right = offMatch[2]!;
    const op = offMatch[3]! as '>' | '<' | '>=' | '<=';
    const amount = offMatch[4]!;
    const mult = offMatch[5] === undefined ? null : Number(offMatch[5]);
    const unit = unitForMultiplier(mult);
    // Need exactly one ${field} and one today() in the subtraction.
    const leftIsToday = left.toLowerCase() === 'today()';
    const rightIsToday = right.toLowerCase() === 'today()';
    if (unit !== null && leftIsToday !== rightIsToday) {
      const field = (leftIsToday ? right : left).replace(/^\$\{\s*|\s*\}$/g, '');
      const direction: DateOffsetDirection = leftIsToday ? 'ago' : 'from_now';
      const comparator: DateOffsetComparator = op === '>' || op === '>=' ? 'more_than' : 'less_than';
      return { kind: 'date_offset', field, comparator, amount, unit, direction };
    }
  }

  // not(selected(${field}, 'value'))
  const notSel = /^not\(\s*selected\(\s*\$\{\s*([^}\s]+)\s*\}\s*,\s*'([^']*)'\s*\)\s*\)$/i.exec(t);
  if (notSel && notSel[1] && notSel[2] !== undefined) {
    return { kind: 'selected', field: notSel[1], value: notSel[2], negated: true };
  }
  // selected(${field}, 'value')
  const sel = /^selected\(\s*\$\{\s*([^}\s]+)\s*\}\s*,\s*'([^']*)'\s*\)$/i.exec(t);
  if (sel && sel[1] && sel[2] !== undefined) {
    return { kind: 'selected', field: sel[1], value: sel[2], negated: false };
  }
  // ${field}   or   not(${field})   — the reference itself as the boolean.
  // Deliberately tight (no inner whitespace): the serializer emits exactly
  // this shape, and the §3.1 self-check would demote anything looser anyway.
  const truthy = /^(not\()?\$\{([^}\s]+)\}(\))?$/.exec(t);
  if (truthy && truthy[2] && Boolean(truthy[1]) === Boolean(truthy[3])) {
    return { kind: 'truthy', field: truthy[2], negated: truthy[1] !== undefined };
  }
  // ${field} = ''   or   ${field} != ''
  const ans = /^\$\{\s*([^}\s]+)\s*\}\s*(=|!=)\s*''$/.exec(t);
  if (ans && ans[1]) {
    // `${f} != ''` means "answered". `${f} = ''` means "not answered".
    return { kind: 'answered', field: ans[1], negated: ans[2] === '=' };
  }
  // ${field} OP value
  const cmp = /^\$\{\s*([^}\s]+)\s*\}\s*(>=|<=|!=|=|>|<)\s*(.+)$/.exec(t);
  if (cmp && cmp[1] && cmp[2] && cmp[3] !== undefined) {
    const opRaw = cmp[2];
    const op: Operator = opRaw as Operator;
    const valueRaw = cmp[3].trim();
    const m = /^'([^']*)'$/.exec(valueRaw);
    if (m && m[1] !== undefined) {
      return { kind: 'comparison', field: cmp[1], op, value: m[1], valueIsString: true };
    }
    return { kind: 'comparison', field: cmp[1], op, value: valueRaw, valueIsString: false };
  }

  // T9a (#14) — the same four field-subject rules written with a relative
  // path, `../field`, which real forms use as an alias of `${field}`. A
  // single segment only: `../inputs/contact/x` is the contact-input
  // reference recognised further down, and any other multi-segment path
  // stays raw. The spelling is carried on the rule and re-emitted as written.
  const relNotSel =
    /^not\(\s*selected\(\s*\.\.\/([A-Za-z_][\w-]*)\s*,\s*'([^']*)'\s*\)\s*\)$/i.exec(t);
  if (relNotSel && relNotSel[1] && relNotSel[2] !== undefined) {
    return {
      kind: 'selected',
      field: relNotSel[1],
      value: relNotSel[2],
      negated: true,
      refSpelling: 'relative',
    };
  }
  const relSel = /^selected\(\s*\.\.\/([A-Za-z_][\w-]*)\s*,\s*'([^']*)'\s*\)$/i.exec(t);
  if (relSel && relSel[1] && relSel[2] !== undefined) {
    return {
      kind: 'selected',
      field: relSel[1],
      value: relSel[2],
      negated: false,
      refSpelling: 'relative',
    };
  }
  const relTruthy = /^(not\()?\.\.\/([A-Za-z_][\w-]*)(\))?$/.exec(t);
  if (relTruthy && relTruthy[2] && Boolean(relTruthy[1]) === Boolean(relTruthy[3])) {
    return {
      kind: 'truthy',
      field: relTruthy[2],
      negated: relTruthy[1] !== undefined,
      refSpelling: 'relative',
    };
  }
  const relAns = /^\.\.\/([A-Za-z_][\w-]*)\s*(=|!=)\s*''$/.exec(t);
  if (relAns && relAns[1]) {
    return { kind: 'answered', field: relAns[1], negated: relAns[2] === '=', refSpelling: 'relative' };
  }
  const relCmp = /^\.\.\/([A-Za-z_][\w-]*)\s*(>=|<=|!=|=|>|<)\s*(.+)$/.exec(t);
  if (relCmp && relCmp[1] && relCmp[2] && relCmp[3] !== undefined) {
    const op = relCmp[2] as Operator;
    const valueRaw = relCmp[3].trim();
    const m = /^'([^']*)'$/.exec(valueRaw);
    if (m && m[1] !== undefined) {
      return {
        kind: 'comparison',
        field: relCmp[1],
        op,
        value: m[1],
        valueIsString: true,
        refSpelling: 'relative',
      };
    }
    return {
      kind: 'comparison',
      field: relCmp[1],
      op,
      value: valueRaw,
      valueIsString: false,
      refSpelling: 'relative',
    };
  }

  // Split at the first comparison operator that sits OUTSIDE any brackets or
  // quotes. A lazy regex found the first operator anywhere, so
  // `if(REF != '', REF, .) = 'true'` — what the relevant builder now emits for
  // the guarded-fallback wrapper — was cut at the `!=` INSIDE the `if(`,
  // leaving `if(REF` as the left-hand side. The recognizer rejected that, the
  // clause fell to raw, and the whole expression demoted with it.
  //
  // Longest operators first so `>=` / `<=` / `!=` beat the prefixes `>` `<` `=`.
  //
  // Phase 1b — contact-input / contact-summary comparison. The LHS is
  // recognized via the SAME `recognizeReference()` the calc builder
  // uses, so a clause like `../inputs/contact/sex = 'female'` or
  // `instance('contact-summary')/context/show_pregnancy = 'true'`
  // surfaces as a structured rule and round-trips back to identical
  // bytes via emitContactInput / emitContactSummary. Anything spacing-
  // divergent is demoted to raw by the §3.1 self-check upstream — DO
  // NOT loosen the recognizer here.
  //
  // Strategy: split on the operator (longest first so `>=`/`<=`/`!=`
  // beat the prefix `>`/`<`/`=`), feed the LHS into recognizeReference,
  // route the value through the same string-quote/literal logic as
  // ComparisonRule above.
  const opSplit = splitAtTopLevelOperator(t);
  if (opSplit) {
    const lhsRaw = opSplit.lhs.trim();
    const op: Operator = opSplit.op as Operator;
    const valueRaw = opSplit.rhs.trim();
    const recognized = recognizeReference(lhsRaw);
    if (recognized && recognized.kind === 'contact-input') {
      const m = /^'([^']*)'$/.exec(valueRaw);
      if (m && m[1] !== undefined) {
        return {
          kind: 'contact-input-comparison',
          field: recognized.argument,
          op,
          value: m[1],
          valueIsString: true,
        };
      }
      return {
        kind: 'contact-input-comparison',
        field: recognized.argument,
        op,
        value: valueRaw,
        valueIsString: false,
      };
    }
    if (recognized && recognized.kind === 'contact-summary') {
      const m = /^'([^']*)'$/.exec(valueRaw);
      if (m && m[1] !== undefined) {
        return {
          kind: 'contact-summary-comparison',
          contextKey: recognized.argument,
          wrapper: recognized.wrapper,
          sentinel: recognized.sentinel,
          refSource: lhsRaw,
          op,
          value: m[1],
          valueIsString: true,
        };
      }
      return {
        kind: 'contact-summary-comparison',
        contextKey: recognized.argument,
        wrapper: recognized.wrapper,
        op,
        value: valueRaw,
        valueIsString: false,
      };
    }
  }

  // T9a (#14) — rules about the answer itself and anything else inside the
  // operand grammar. Every kind below carries `source` (the clause verbatim)
  // and the serializer re-emits it while it still parses to the same rule,
  // so a tight-spaced `.<=100` opens AND saves back byte-identical. These
  // sit after every field-subject regex so existing consumers keep getting
  // exactly the rules they got before.

  // `true`, `true()`, `1` — a placeholder that always passes. Never rewritten.
  if (/^(true|true\(\)|1)$/.test(t)) return { kind: 'always-true', text: t };

  // `not(<predicate>)` or `not(<flat chain>)`.
  const notWrapped = parseNotWrapped(t);
  if (notWrapped) return notWrapped;

  // `regex(., '…')`, `selected(., 'none')`, `contains(., 'x')` …
  const predicate = parsePredicate(t);
  if (predicate) return { ...predicate, source: t };

  // `<operand> OP <operand>`: `. >= 0`, `string-length(.) <= 100`,
  // `int(format-date(today(), '%Y')) + 57 >= int(.)`, `. > max(coalesce(…))`.
  if (opSplit) {
    const lhs = parseOperand(opSplit.lhs);
    const rhs = lhs ? parseOperand(opSplit.rhs) : null;
    if (lhs && rhs) {
      return { kind: 'expr-comparison', lhs, op: opSplit.op as Operator, rhs, source: t };
    }
  }

  return { kind: 'raw', text: t };
}

const PREDICATE_FNS: ReadonlySet<string> = new Set<PredicateFn>([
  'regex',
  'selected',
  'contains',
  'starts-with',
  'ends-with',
]);

/** A single predicate call over the operand grammar, or null. No `source`. */
function parsePredicate(t: string): Omit<PredicateRule, 'source'> | null {
  const op = parseOperand(t);
  if (!op || op.kind !== 'call' || !PREDICATE_FNS.has(op.fn)) return null;
  return { kind: 'predicate', fn: op.fn as PredicateFn, args: op.args, negated: false };
}

/**
 * `not( … )` where the paren opened after `not` closes at the very end.
 * A negated predicate becomes a {@link PredicateRule}; a negated flat
 * chain becomes a {@link NotGroupRule} only when every inner rule is
 * structured (no raw parts, no second level of parens).
 */
function parseNotWrapped(t: string): Rule | null {
  if (!/^not\(/i.test(t) || !t.endsWith(')')) return null;
  // The `(` after `not` must enclose the whole remainder.
  let depth = 0;
  for (let i = 3; i < t.length; i++) {
    const ch = t[i];
    if (ch === "'" || ch === '"') {
      const close = t.indexOf(ch, i + 1);
      if (close < 0) return null;
      i = close;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0 && i !== t.length - 1) return null;
    }
  }
  if (depth !== 0) return null;
  const inner = t.slice(4, -1).trim();
  if (!inner) return null;

  const predicate = parsePredicate(inner);
  if (predicate) return { ...predicate, negated: true, source: t };

  const chain = parseRelevant(inner);
  if (chain.isRawFallback || chain.rules.length === 0) return null;
  if (chain.rules.some((r) => r.kind === 'raw')) return null;
  return { kind: 'not-group', combinator: chain.combinator, rules: chain.rules, source: t };
}

/**
 * The author's own text for a T9a rule while it still describes the rule;
 * otherwise the canonical form. Re-checking rather than trusting `source`
 * blindly matters: a consumer that spreads `{ ...rule, op: '<' }` keeps the
 * stale text, and emitting it would write the OLD rule.
 */
function sourceOrCanonical(
  rule: ExprComparisonRule | PredicateRule | NotGroupRule,
  canonical: () => string,
): string {
  if (rule.source !== undefined) {
    const reparsed = parseSinglePart(rule.source);
    if (sameRule(reparsed, rule)) return rule.source;
  }
  return canonical();
}

function sameRule(a: Rule, b: Rule): boolean {
  return JSON.stringify(stripSources(a)) === JSON.stringify(stripSources(b));
}

function stripSources(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSources);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'source') continue;
      out[k] = stripSources(val);
    }
    return out;
  }
  return v;
}

/** `${field}` or, when the author wrote it that way, `../field`. */
function fieldRef(rule: { field: string; refSpelling?: FieldRefSpelling }): string {
  return rule.refSpelling === 'relative' ? `../${rule.field}` : `\${${rule.field}}`;
}

/** Serialize a single rule. Exposed so UI consumers can show any kind as text. */
export function serializeRule(rule: Rule): string {
  return ruleToString(rule);
}

function ruleToString(rule: Rule): string {
  switch (rule.kind) {
    case 'comparison': {
      const v = rule.valueIsString ? `'${rule.value.replace(/'/g, "\\'")}'` : rule.value;
      return `${fieldRef(rule)} ${rule.op} ${v}`;
    }
    case 'selected': {
      const inner = `selected(${fieldRef(rule)}, '${rule.value.replace(/'/g, "\\'")}')`;
      return rule.negated ? `not(${inner})` : inner;
    }
    case 'answered': {
      // Answered = `${f} != ''`; not answered = `${f} = ''`.
      return rule.negated ? `${fieldRef(rule)} = ''` : `${fieldRef(rule)} != ''`;
    }
    case 'truthy': {
      return rule.negated ? `not(${fieldRef(rule)})` : fieldRef(rule);
    }
    case 'expr-comparison':
      return sourceOrCanonical(
        rule,
        () => `${serializeOperand(rule.lhs)} ${rule.op} ${serializeOperand(rule.rhs)}`,
      );
    case 'predicate':
      return sourceOrCanonical(rule, () => {
        const inner = `${rule.fn}(${rule.args.map(serializeOperand).join(', ')})`;
        return rule.negated ? `not(${inner})` : inner;
      });
    case 'not-group':
      return sourceOrCanonical(
        rule,
        () =>
          `not(${serializeRelevant({
            combinator: rule.combinator,
            rules: rule.rules,
            isRawFallback: false,
          })})`,
      );
    case 'always-true':
      return rule.text;
    case 'date_offset': {
      const op = rule.comparator === 'more_than' ? '>' : '<';
      const days = UNIT_DAYS[rule.unit];
      const rhs = days === 1 ? rule.amount : `${rule.amount}*${days}`;
      const lhs =
        rule.direction === 'ago'
          ? `today() - \${${rule.field}}`
          : `\${${rule.field}} - today()`;
      return `${lhs} ${op} ${rhs}`;
    }
    case 'age': {
      return `floor((today() - \${${rule.field}}) div 365.25) ${rule.op} ${rule.value}`;
    }
    case 'contact-input-comparison': {
      // Mirrors ComparisonRule's RHS quoting exactly so valueIsString
      // round-trips on both `!= ''` (string) and `!= 0` (numeric)
      // variants used in real production CHT forms.
      const v = rule.valueIsString ? `'${rule.value.replace(/'/g, "\\'")}'` : rule.value;
      return `${emitContactInput(rule.field)} ${rule.op} ${v}`;
    }
    case 'contact-summary-comparison': {
      const v = rule.valueIsString ? `'${rule.value.replace(/'/g, "\\'")}'` : rule.value;
      return `${contactSummaryRefSource(rule)} ${rule.op} ${v}`;
    }
    case 'raw':
      return rule.text;
  }
}

/**
 * The reference text for a contact-summary comparison: the author's own
 * spelling while it still describes this rule, otherwise the canonical form.
 *
 * Re-checking rather than trusting `refSource` blindly matters — the user can
 * change the key or the wrapper in the builder, and stale authored text would
 * then emit the OLD reference.
 */
function contactSummaryRefSource(rule: ContactSummaryComparisonRule): string {
  const authored = rule.refSource?.trim();
  if (authored) {
    const rec = recognizeReference(authored);
    if (
      rec &&
      rec.kind === 'contact-summary' &&
      rec.argument === rule.contextKey &&
      rec.wrapper === rule.wrapper &&
      (rec.sentinel ?? null) === (rule.sentinel ?? null)
    ) {
      return authored;
    }
  }
  return emitContactSummary(rule.contextKey, rule.wrapper, rule.sentinel ?? null);
}

/**
 * Split `t` at the first comparison operator outside brackets and quotes.
 * `null` when there is none at top level.
 */
function splitAtTopLevelOperator(
  t: string,
): { lhs: string; op: string; rhs: string } | null {
  let depth = 0;
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < t.length && t[i] !== q) i += t[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '(' || c === '[') {
      depth++;
      i++;
      continue;
    }
    if (c === ')' || c === ']') {
      depth--;
      i++;
      continue;
    }
    if (depth === 0) {
      const two = t.slice(i, i + 2);
      if (two === '>=' || two === '<=' || two === '!=') {
        return { lhs: t.slice(0, i), op: two, rhs: t.slice(i + 2) };
      }
      if (c === '=' || c === '>' || c === '<') {
        return { lhs: t.slice(0, i), op: c, rhs: t.slice(i + 1) };
      }
    }
    i++;
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/*                         Grouped expression support                        */
/* ------------------------------------------------------------------------ */

/**
 * Parse an expression that MAY include a parenthesized mixed-combinator
 * outer structure (e.g. `(A and B) or C`). For flat input or anything
 * else, delegates to `parseRelevant`.
 *
 * This is an additive entry point — `parseRelevant` is unchanged.
 *
 * Algorithm (plan §4):
 *   1. Try paren-aware splits on both `or` and `and` at the top level.
 *   2. If one combinator yields multiple top-level parts AND at least
 *      one part is a fully-wrapped paren group → grouped expression.
 *      Strip outer parens from each wrapped part and `parseRelevant`
 *      the inner; un-wrapped parts go through `parseRelevant` as-is.
 *   3. Any subgroup whose result is `isRawFallback: true` (would require
 *      a third level of nesting) collapses the whole expression to raw.
 *   4. Apply the §3.1 self-check: re-serialize and, if it doesn't byte-
 *      match the trimmed input (e.g. inner-padded parens, redundant
 *      parens, tight spacing inside subgroups), return a raw fallback.
 */
export function parseRelevantGrouped(expr: string): AnyParsed {
  const trimmed = expr.trim();
  if (!trimmed) return parseRelevant('');

  // Paren-aware splits on each combinator at the top level. If only one
  // yields multiple parts, that's the outer combinator (single-combinator
  // chain → no grouping needed, defer to flat parser). If BOTH yield
  // multiple parts at the top level (e.g. `A and B or C` with no parens),
  // that's an unambiguously flat-mixed expression — stay raw.
  const partsOr = splitOnCombinator(trimmed, 'or');
  const partsAnd = splitOnCombinator(trimmed, 'and');

  const orMulti = partsOr.length > 1;
  const andMulti = partsAnd.length > 1;

  if (orMulti && !andMulti && partsOr.some(isFullyWrapped)) {
    const grouped = tryBuildGrouped(trimmed, 'or', partsOr);
    if (grouped) return grouped;
  }
  if (andMulti && !orMulti && partsAnd.some(isFullyWrapped)) {
    const grouped = tryBuildGrouped(trimmed, 'and', partsAnd);
    if (grouped) return grouped;
  }
  // Defer to flat parser (which now self-checks per §3.1). For flat-mixed
  // without parens (both combinators top-level), this hits the existing
  // raw-fallback path at parseRelevant lines 120-122.
  return parseRelevant(trimmed);
}

/**
 * Best-effort grouped construction. Returns null if the candidate doesn't
 * pass the §3.1 self-check or contains a `isRawFallback` subgroup
 * (two-levels-max enforcement).
 */
function tryBuildGrouped(
  trimmed: string,
  outerCombinator: Combinator,
  parts: string[],
): GroupedExpression | null {
  const subgroups: ParsedExpression[] = [];
  for (const part of parts) {
    const inner = isFullyWrapped(part) ? stripOuterParens(part) : part;
    const parsed = parseRelevant(inner);
    if (parsed.isRawFallback) return null; // two-levels-max: refuse
    subgroups.push(parsed);
  }
  const candidate: GroupedExpression = {
    kind: 'grouped',
    outerCombinator,
    subgroups,
    isRawFallback: false,
  };
  // §3.1 self-check at the grouped level — routes inner-padded parens,
  // redundant single-clause wraps, etc. to raw rather than reformatting.
  if (serializeAnyParsed(candidate) !== trimmed) return null;
  return candidate;
}

/**
 * Serialize either a flat `ParsedExpression` or a grouped one. The grouped
 * canonical form is `(A and B) or C` — only multi-rule subgroups get
 * parens; single-rule subgroups stay bare. This matches plan §6 Bucket A.
 *
 * STRUCTURALLY guarantees no flat-mixed output: a `ParsedExpression` has
 * exactly one combinator, and `GroupedExpression` introduces the second
 * only inside explicit parens. There is no code path that can emit
 * `a or b and c` at the same precedence level.
 */
export function serializeAnyParsed(parsed: AnyParsed): string {
  if ('subgroups' in parsed) {
    return parsed.subgroups
      .map((sg) => {
        const inner = serializeRelevant(sg);
        // Wrap only when the subgroup has 2+ rules (the canonical form;
        // bare single-rule subgroups don't need parens).
        return sg.rules.length > 1 ? `(${inner})` : inner;
      })
      .join(` ${parsed.outerCombinator} `);
  }
  return serializeRelevant(parsed);
}

/** True iff `s` is wholly enclosed by a single matched paren pair. */
function isFullyWrapped(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || t[0] !== '(' || t[t.length - 1] !== ')') return false;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      // If depth hits 0 before the last char, the leading `(` didn't enclose
      // the whole string — e.g. `(A) and (B)`.
      if (depth === 0 && i !== t.length - 1) return false;
    }
  }
  return depth === 0;
}

/** Strip one balanced outer paren pair. Caller must have checked `isFullyWrapped`. */
function stripOuterParens(s: string): string {
  const t = s.trim();
  return t.slice(1, -1).trim();
}
