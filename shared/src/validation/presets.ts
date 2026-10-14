/**
 * Validation presets — T9e (#18), docs/plans/9_complex_logic_calculation_relevant_constraint.
 *
 * The `constraint` column of seven real configs holds 777 rules; with `.`
 * readable (9a) about 97% of the ones that are not `true` placeholders fall
 * into a dozen shapes a program officer recognises by name: a number
 * between two values, a text of at most N characters, a date not in the
 * future, "[None] cannot be combined". This module turns a parsed
 * constraint into a list of such presets (plus `code` items for anything
 * else) and back.
 *
 * THE RECOGNISER NEVER NORMALISES. Every item carries `source`, the text of
 * the rule(s) it was read from, exactly as the author wrote it; the
 * serializer re-emits `source` while it still reads as the same preset and
 * writes the canonical spelling only for an item the author changed. So a
 * cell holding `. <= 100 and . >= 70` is DISPLAYED as "Between 70 and 100"
 * and SAVED as `. <= 100 and . >= 70` — unless the author edits that
 * preset, in which case it becomes `. >= 70 and . <= 100`.
 *
 * Pure: no React, no XLSForm I/O. The parsed shapes come from
 * `relevantParser.ts`; this module only projects them.
 */
import {
  isSelfOperand,
  parseRelevantGrouped,
  serializeRule,
  type FieldRefSpelling,
  type Operand,
  type Operator,
  type Rule,
} from '../xlsform/relevantParser.js';

/* ------------------------------------------------------------------------ */
/*                                 Model                                     */
/* ------------------------------------------------------------------------ */

export interface FieldRef {
  name: string;
  spelling: FieldRefSpelling;
}

export interface Bound {
  value: string;
  inclusive: boolean;
}

export type Script = 'latin' | 'devanagari';

export type Preset =
  /** `. OP value` — a number (`. <= 20`, `. = 9841`) or a quoted text (`. = 'yes'`). */
  | { kind: 'compare-value'; op: Operator; value: string; isString: boolean }
  /** `. >= A and . <= B` (either end may be strict, either order in the source). */
  | { kind: 'between'; min: Bound; max: Bound }
  /** `. OP ${field}` / `. OP ../field` — "at most another answer", "on or after a date". */
  | { kind: 'compare-field'; op: Operator; field: FieldRef }
  /** `. OP today()` / `. OP now()` — "not in the future", "not in the past". */
  | { kind: 'compare-today'; op: Operator; clock: 'today' | 'now' }
  /** `. OP today() - N` / `+ N` — "within the last N days". */
  | { kind: 'days-from-today'; op: Operator; direction: 'ago' | 'ahead'; days: string }
  /** `difference-in-months(., today()) OP N`. */
  | { kind: 'months-from-today'; op: Operator; months: string }
  /** `. OP max(coalesce(${a}, 0), …)` or `. OP coalesce(${a}, 0)` — "after all of". */
  | { kind: 'after-all-of'; op: Operator; fields: FieldRef[] }
  /** `string-length(.) OP N`. */
  | { kind: 'text-length'; op: Operator; n: string }
  /** `regex(., '…')` with a pattern the panel can name. */
  | { kind: 'allowed-chars'; mode: 'digits' | 'no-digits' | 'letters'; scripts: Script[] }
  /** `regex(., '…')` with any other pattern. */
  | { kind: 'pattern'; pattern: string }
  /** `int(.) OP N` — the answer read as a number (BS-year chains). */
  | { kind: 'int-value'; op: Operator; value: string }
  /**
   * Bikram Sambat year typed as text: `int(format-date(today(), '%Y')) + 57 >= int(.)`
   * (not after this year), `(… + 57 - N) <= .` (at most N years ago) and
   * `(… + 57 - N) >= .` (at least N years ago).
   */
  | { kind: 'bs-year'; bound: 'max-this-year' | 'min-years-ago' | 'max-years-ago'; years?: string }
  /** `not(selected(., 'x') and count-selected(.) > 1)` — "[x] must be chosen alone". */
  | { kind: 'choice-alone'; choice: string }
  /** `count-selected(.) OP N` / `OP ${field}`. */
  | { kind: 'count-selected'; op: Operator; value: string }
  /** `true`, `true()`, `1` — "this rule always passes". Never rewritten. */
  | { kind: 'always-true'; text: string }
  /** Anything else, kept as text. */
  | { kind: 'code'; text: string };

export type PresetKind = Preset['kind'];

export interface ValidationItem {
  preset: Preset;
  /**
   * The rule text this item was read from, verbatim. Absent on an item the
   * author built or changed. Wins on save while it still reads as `preset`.
   */
  source?: string;
}

export interface ParsedValidation {
  items: ValidationItem[];
  /**
   * The text between consecutive items exactly as written (` and `,
   * ` and\n`), when the cell's joins are not canonical. Hand it back to
   * `serializeValidation` with the same number of items to keep them.
   */
  separators?: string[];
}

/* ------------------------------------------------------------------------ */
/*                            Question kinds                                 */
/* ------------------------------------------------------------------------ */

export type QuestionKind =
  | 'integer'
  | 'decimal'
  | 'text'
  | 'date'
  | 'datetime'
  | 'select_one'
  | 'select_multiple'
  | 'other';

/** Coarse question kind from the raw XLSForm `type` cell. */
export function questionKindOf(type: string): QuestionKind {
  const t = type.trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (t === 'integer' || t === 'int' || t === 'range') return 'integer';
  if (t === 'decimal') return 'decimal';
  if (t === 'text' || t === 'string' || t === 'barcode' || t === 'tel') return 'text';
  if (t === 'date') return 'date';
  if (t === 'datetime' || t === 'date-time' || t === 'time') return 'datetime';
  if (t === 'select_one' || t === 'select_one_from_file') return 'select_one';
  if (t === 'select_multiple' || t === 'select_multiple_from_file' || t === 'rank') return 'select_multiple';
  return 'other';
}

/* ------------------------------------------------------------------------ */
/*                               Recognise                                   */
/* ------------------------------------------------------------------------ */

const DIGITS_ONLY = new Set(['^[0-9]*$', '^[0-9]+$', '^\\d*$', '^\\d+$']);
const NO_DIGITS = new Set(['^([^0-9]*)$', '^[^0-9]*$', '^([^\\d]*)$', '^[^\\d]*$']);
const LATIN = 'a-zA-Z';
const DEVANAGARI = 'ऀ-ॿ';

function lettersScripts(pattern: string): Script[] | null {
  // ^[<ranges>\s]+$ or ^[<ranges> ]+$ — ranges from the two scripts we name.
  const m = /^\^\[([^\]]*)\]\+\$$/.exec(pattern);
  if (!m) return null;
  let body = m[1]!;
  const scripts: Script[] = [];
  if (body.includes(LATIN)) {
    scripts.push('latin');
    body = body.replace(LATIN, '');
  }
  if (body.includes(DEVANAGARI)) {
    scripts.push('devanagari');
    body = body.replace(DEVANAGARI, '');
  }
  body = body.replace(/\\s| /g, '');
  if (body !== '' || scripts.length === 0) return null;
  return scripts;
}

function fieldRef(o: Operand): FieldRef | null {
  return o.kind === 'field' ? { name: o.name, spelling: o.spelling } : null;
}

function isCall(o: Operand, fn: string, arity?: number): o is Extract<Operand, { kind: 'call' }> {
  return o.kind === 'call' && o.fn === fn && (arity === undefined || o.args.length === arity);
}

function isToday(o: Operand): 'today' | 'now' | null {
  if (isCall(o, 'today', 0)) return 'today';
  if (isCall(o, 'now', 0)) return 'now';
  return null;
}

function unwrap(o: Operand): Operand {
  return o.kind === 'group' ? unwrap(o.inner) : o;
}

const FLIP: Record<Operator, Operator> = {
  '=': '=',
  '!=': '!=',
  '>': '<',
  '<': '>',
  '>=': '<=',
  '<=': '>=',
};

/** `coalesce(${f}, 0)` → the field, else null. */
function coalesceField(o: Operand): FieldRef | null {
  if (!isCall(o, 'coalesce', 2)) return null;
  const f = fieldRef(o.args[0]!);
  const zero = o.args[1]!;
  if (!f || zero.kind !== 'number' || Number(zero.text) !== 0) return null;
  return f;
}

/** `int(format-date(today(), '%Y')) + 57` → true. */
function isBsThisYear(o: Operand): boolean {
  const u = unwrap(o);
  if (u.kind !== 'binary' || u.op !== '+') return false;
  const left = unwrap(u.left);
  const right = unwrap(u.right);
  if (right.kind !== 'number' || right.text !== '57') return false;
  if (!isCall(left, 'int', 1)) return false;
  const fd = left.args[0]!;
  if (!isCall(fd, 'format-date', 2)) return false;
  return isToday(fd.args[0]!) === 'today' && fd.args[1]!.kind === 'string' && fd.args[1]!.value === '%Y';
}

/** One parsed rule → one preset. `code` when nothing names it. */
export function recogniseRule(rule: Rule): Preset {
  switch (rule.kind) {
    case 'always-true':
      return { kind: 'always-true', text: rule.text };
    case 'raw':
      return { kind: 'code', text: rule.text };
    case 'predicate': {
      if (rule.fn === 'regex' && !rule.negated && rule.args.length === 2) {
        const [subject, pat] = rule.args as [Operand, Operand];
        if (isSelfOperand(subject) && pat.kind === 'string') {
          if (DIGITS_ONLY.has(pat.value)) return { kind: 'allowed-chars', mode: 'digits', scripts: [] };
          if (NO_DIGITS.has(pat.value)) return { kind: 'allowed-chars', mode: 'no-digits', scripts: [] };
          const scripts = lettersScripts(pat.value);
          if (scripts) return { kind: 'allowed-chars', mode: 'letters', scripts };
          return { kind: 'pattern', pattern: pat.value };
        }
      }
      break;
    }
    case 'not-group': {
      if (rule.combinator === 'and' && rule.rules.length === 2) {
        const [a, b] = rule.rules as [Rule, Rule];
        if (
          a.kind === 'predicate' &&
          a.fn === 'selected' &&
          !a.negated &&
          a.args.length === 2 &&
          isSelfOperand(a.args[0]!) &&
          a.args[1]!.kind === 'string' &&
          b.kind === 'expr-comparison' &&
          isCall(unwrap(b.lhs), 'count-selected', 1) &&
          isSelfOperand((unwrap(b.lhs) as Extract<Operand, { kind: 'call' }>).args[0]!) &&
          b.op === '>' &&
          b.rhs.kind === 'number' &&
          b.rhs.text === '1'
        ) {
          return { kind: 'choice-alone', choice: a.args[1]!.value };
        }
      }
      break;
    }
    case 'expr-comparison': {
      const lhs = unwrap(rule.lhs);
      const rhs = unwrap(rule.rhs);
      // Put `.` (or a function over it) on the left so one branch serves both spellings.
      const selfLeft = isSelfOperand(lhs);
      const selfRight = isSelfOperand(rhs);
      if (selfLeft || (!selfRight && lhsIsSelfFunction(lhs))) {
        return recogniseSelfComparison(lhs, rule.op, rhs);
      }
      if (selfRight || lhsIsSelfFunction(rhs)) {
        return recogniseSelfComparison(rhs, FLIP[rule.op], lhs);
      }
      break;
    }
    default:
      break;
  }
  return { kind: 'code', text: serializeRule(rule) };
}

function lhsIsSelfFunction(o: Operand): boolean {
  const u = unwrap(o);
  if (u.kind !== 'call' || u.args.length === 0) return false;
  if (u.fn === 'string-length' || u.fn === 'count-selected' || u.fn === 'int') {
    return u.args.length === 1 && isSelfOperand(u.args[0]!);
  }
  if (u.fn === 'difference-in-months') {
    return u.args.length === 2 && isSelfOperand(u.args[0]!) && isToday(u.args[1]!) === 'today';
  }
  return false;
}

/** `subject OP value` where `subject` is `.` or a named function over `.`. */
function recogniseSelfComparison(subject: Operand, op: Operator, value: Operand): Preset {
  const v = unwrap(value);
  if (isSelfOperand(subject)) {
    if (v.kind === 'number') return { kind: 'compare-value', op, value: v.text, isString: false };
    if (v.kind === 'string') return { kind: 'compare-value', op, value: v.value, isString: true };
    const f = fieldRef(v);
    if (f) return { kind: 'compare-field', op, field: f };
    const clock = isToday(v);
    if (clock) return { kind: 'compare-today', op, clock };
    if (v.kind === 'binary' && (v.op === '-' || v.op === '+')) {
      const l = unwrap(v.left);
      const r = unwrap(v.right);
      if (isToday(l) === 'today' && r.kind === 'number') {
        return { kind: 'days-from-today', op, direction: v.op === '-' ? 'ago' : 'ahead', days: r.text };
      }
    }
    const single = coalesceField(v);
    if (single) return { kind: 'after-all-of', op, fields: [single] };
    if (isCall(v, 'max') && v.args.length >= 1) {
      const fields = v.args.map(coalesceField);
      if (fields.every((f): f is FieldRef => f !== null)) return { kind: 'after-all-of', op, fields };
    }
    // `(int(format-date(today(), '%Y')) + 57 - N) <= .` reaches here flipped as
    // `. >= (… - N)` (at most N years ago); `… >= .` as `. <= (… - N)` (at least N years ago).
    const bs = bsYearsAgo(v);
    if (bs !== null && (op === '>=' || op === '>')) return { kind: 'bs-year', bound: 'min-years-ago', years: bs };
    if (bs !== null && (op === '<=' || op === '<')) return { kind: 'bs-year', bound: 'max-years-ago', years: bs };
    if (isBsThisYear(v) && (op === '<=' || op === '<')) return { kind: 'bs-year', bound: 'max-this-year' };
  }
  if (subject.kind === 'call') {
    if (subject.fn === 'string-length' && v.kind === 'number') return { kind: 'text-length', op, n: v.text };
    if (subject.fn === 'count-selected') {
      if (v.kind === 'number') return { kind: 'count-selected', op, value: v.text };
      const f = fieldRef(v);
      if (f) return { kind: 'count-selected', op, value: f.spelling === 'relative' ? `../${f.name}` : `\${${f.name}}` };
    }
    if (subject.fn === 'int') {
      if (v.kind === 'number') return { kind: 'int-value', op, value: v.text };
      if (isBsThisYear(v) && (op === '<=' || op === '<')) return { kind: 'bs-year', bound: 'max-this-year' };
      const bs = bsYearsAgo(v);
      if (bs !== null && (op === '>=' || op === '>')) return { kind: 'bs-year', bound: 'min-years-ago', years: bs };
      if (bs !== null && (op === '<=' || op === '<')) return { kind: 'bs-year', bound: 'max-years-ago', years: bs };
    }
    if (subject.fn === 'difference-in-months' && v.kind === 'number') {
      return { kind: 'months-from-today', op, months: v.text };
    }
  }
  return {
    kind: 'code',
    text: serializeRule({ kind: 'expr-comparison', lhs: subject, op, rhs: value }),
  };
}

/** `int(format-date(today(), '%Y')) + 57 - N` → N, else null. */
function bsYearsAgo(o: Operand): string | null {
  const u = unwrap(o);
  if (u.kind !== 'binary' || u.op !== '-') return null;
  const r = unwrap(u.right);
  if (r.kind !== 'number') return null;
  return isBsThisYear(u.left) ? r.text : null;
}

/**
 * Parse a `constraint` cell into items. An `or` chain, a grouped expression
 * or an unparseable cell is ONE `code` item carrying the whole text.
 */
export function parseValidation(text: string): ParsedValidation {
  const trimmed = text.trim();
  if (!trimmed) return { items: [] };
  const parsed = parseRelevantGrouped(trimmed);
  if (parsed.isRawFallback || 'subgroups' in parsed || parsed.combinator === 'or') {
    return { items: [{ preset: { kind: 'code', text: trimmed }, source: trimmed }] };
  }
  const items: ValidationItem[] = parsed.rules.map((rule) => ({
    preset: recogniseRule(rule),
    source: serializeRule(rule),
  }));
  const seps = parsed.separators ?? parsed.rules.slice(1).map(() => ' and ');
  const merged = mergeBetween(items, seps);
  const canonical = merged.separators.every((s) => s === ' and ');
  return canonical ? { items: merged.items } : { items: merged.items, separators: merged.separators };
}

/**
 * Two adjacent numeric bounds on `.` in opposite directions → one "between".
 * The join between the two rules becomes part of the item's `source`; the
 * joins between items are returned alongside.
 */
function mergeBetween(
  items: ValidationItem[],
  seps: string[],
): { items: ValidationItem[]; separators: string[] } {
  const out: ValidationItem[] = [];
  const outSeps: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    const b = items[i + 1];
    if (out.length > 0) outSeps.push(seps[i - 1] ?? ' and ');
    if (b) {
      const ab = asBetween(a.preset, b.preset);
      if (ab) {
        out.push({ preset: ab, source: `${a.source}${seps[i] ?? ' and '}${b.source}` });
        i++;
        continue;
      }
    }
    out.push(a);
  }
  return { items: out, separators: outSeps };
}

function asBetween(a: Preset, b: Preset): Preset | null {
  if (a.kind !== 'compare-value' || b.kind !== 'compare-value') return null;
  if (a.isString || b.isString) return null;
  const lower = (p: typeof a) => (p.op === '>=' || p.op === '>' ? { value: p.value, inclusive: p.op === '>=' } : null);
  const upper = (p: typeof a) => (p.op === '<=' || p.op === '<' ? { value: p.value, inclusive: p.op === '<=' } : null);
  const min = lower(a) ?? lower(b);
  const max = upper(a) ?? upper(b);
  if (!min || !max) return null;
  if ((lower(a) && lower(b)) || (upper(a) && upper(b))) return null;
  return { kind: 'between', min, max };
}

/* ------------------------------------------------------------------------ */
/*                                 Emit                                      */
/* ------------------------------------------------------------------------ */

function ref(f: FieldRef): string {
  return f.spelling === 'relative' ? `../${f.name}` : `\${${f.name}}`;
}

function quote(s: string): string {
  return `'${s}'`;
}

/** Canonical XPath for a preset — used for items the author built or changed. */
export function emitPreset(p: Preset): string {
  switch (p.kind) {
    case 'compare-value':
      return `. ${p.op} ${p.isString ? quote(p.value) : p.value}`;
    case 'between':
      return `. ${p.min.inclusive ? '>=' : '>'} ${p.min.value} and . ${p.max.inclusive ? '<=' : '<'} ${p.max.value}`;
    case 'compare-field':
      return `. ${p.op} ${ref(p.field)}`;
    case 'compare-today':
      return `. ${p.op} ${p.clock}()`;
    case 'days-from-today':
      return `. ${p.op} today() ${p.direction === 'ago' ? '-' : '+'} ${p.days}`;
    case 'months-from-today':
      return `difference-in-months(., today()) ${p.op} ${p.months}`;
    case 'after-all-of': {
      const parts = p.fields.map((f) => `coalesce(${ref(f)}, 0)`);
      return `. ${p.op} ${parts.length === 1 ? parts[0] : `max(${parts.join(', ')})`}`;
    }
    case 'text-length':
      return `string-length(.) ${p.op} ${p.n}`;
    case 'allowed-chars': {
      if (p.mode === 'digits') return "regex(., '^[0-9]*$')";
      if (p.mode === 'no-digits') return "regex(., '^([^0-9]*)$')";
      const ranges = p.scripts.map((s) => (s === 'latin' ? LATIN : DEVANAGARI)).join('');
      return `regex(., '^[${ranges}\\s]+$')`;
    }
    case 'pattern':
      return `regex(., ${quote(p.pattern)})`;
    case 'int-value':
      return `int(.) ${p.op} ${p.value}`;
    case 'bs-year':
      if (p.bound === 'max-this-year') return "int(format-date(today(), '%Y')) + 57 >= int(.)";
      return `(int(format-date(today(), '%Y')) + 57 - ${p.years ?? '0'}) ${p.bound === 'min-years-ago' ? '<=' : '>='} .`;
    case 'choice-alone':
      return `not(selected(., ${quote(p.choice)}) and count-selected(.) > 1)`;
    case 'count-selected':
      return `count-selected(.) ${p.op} ${p.value}`;
    case 'always-true':
      return p.text;
    case 'code':
      return p.text;
  }
}

function samePreset(a: Preset, b: Preset): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The author's text while it still reads as this preset, else the canonical form. */
export function emitItem(item: ValidationItem): string {
  if (item.source !== undefined) {
    const re = parseValidation(item.source);
    if (re.items.length === 1 && samePreset(re.items[0]!.preset, item.preset)) return item.source;
  }
  return emitPreset(item.preset);
}

/**
 * Items → the `constraint` cell. Presets combine with `and`; the author's
 * own joins are kept while `separators` still fits the item count.
 */
export function serializeValidation(items: ValidationItem[], separators?: string[]): string {
  const texts = items.map(emitItem);
  if (separators && separators.length === texts.length - 1 && separators.every((s) => s.trim().toLowerCase() === 'and')) {
    let out = texts[0] ?? '';
    for (let i = 1; i < texts.length; i++) out += separators[i - 1]! + texts[i]!;
    return out;
  }
  return texts.join(' and ');
}

/* ------------------------------------------------------------------------ */
/*                        Catalogue and messages                             */
/* ------------------------------------------------------------------------ */

/** Presets the panel offers for a question kind, in menu order. */
export function presetsFor(kind: QuestionKind): Preset[] {
  switch (kind) {
    case 'integer':
    case 'decimal':
      return [
        { kind: 'between', min: { value: '', inclusive: true }, max: { value: '', inclusive: true } },
        { kind: 'compare-value', op: '<', value: '', isString: false },
        { kind: 'compare-value', op: '>', value: '', isString: false },
        { kind: 'compare-field', op: '<=', field: { name: '', spelling: 'braces' } },
        { kind: 'compare-field', op: '>=', field: { name: '', spelling: 'braces' } },
        { kind: 'compare-value', op: '=', value: '', isString: false },
      ];
    case 'text':
      return [
        { kind: 'text-length', op: '<=', n: '' },
        { kind: 'text-length', op: '>=', n: '' },
        { kind: 'text-length', op: '=', n: '' },
        { kind: 'allowed-chars', mode: 'letters', scripts: ['latin'] },
        { kind: 'allowed-chars', mode: 'digits', scripts: [] },
        { kind: 'allowed-chars', mode: 'no-digits', scripts: [] },
        { kind: 'pattern', pattern: '' },
        { kind: 'bs-year', bound: 'max-this-year' },
        { kind: 'bs-year', bound: 'min-years-ago', years: '' },
        { kind: 'compare-value', op: '=', value: '', isString: true },
      ];
    case 'date':
      return [
        { kind: 'compare-today', op: '<=', clock: 'today' },
        { kind: 'compare-today', op: '>=', clock: 'today' },
        { kind: 'compare-field', op: '>=', field: { name: '', spelling: 'braces' } },
        { kind: 'after-all-of', op: '>', fields: [] },
        { kind: 'days-from-today', op: '>=', direction: 'ago', days: '' },
        { kind: 'days-from-today', op: '<=', direction: 'ahead', days: '' },
      ];
    case 'datetime':
      return [
        { kind: 'compare-today', op: '<=', clock: 'now' },
        { kind: 'compare-today', op: '>=', clock: 'now' },
        { kind: 'compare-field', op: '>=', field: { name: '', spelling: 'braces' } },
      ];
    case 'select_multiple':
      return [
        { kind: 'choice-alone', choice: '' },
        { kind: 'count-selected', op: '<=', value: '' },
        { kind: 'count-selected', op: '>=', value: '' },
      ];
    case 'select_one':
      return [{ kind: 'compare-value', op: '=', value: '', isString: true }];
    default:
      return [{ kind: 'compare-value', op: '=', value: '', isString: false }];
  }
}

const OP_WORDS: Record<Operator, string> = {
  '=': 'exactly',
  '!=': 'not',
  '>': 'more than',
  '<': 'less than',
  '>=': 'at least',
  '<=': 'at most',
};

/** Suggested English `constraint_message` for a preset; the author can edit it. */
export function suggestMessage(p: Preset, fieldLabel: (name: string) => string = (n) => n): string {
  switch (p.kind) {
    case 'compare-value':
      if (p.op === '=') return `Must be ${p.isString ? p.value : p.value}`;
      return `Must be ${OP_WORDS[p.op]} ${p.value}`;
    case 'between':
      return `Must be between ${p.min.value} and ${p.max.value}`;
    case 'compare-field':
      return `Must be ${OP_WORDS[p.op]} ${fieldLabel(p.field.name)}`;
    case 'compare-today':
      if (p.op === '<=' || p.op === '<') return 'Cannot be in the future';
      if (p.op === '>=' || p.op === '>') return 'Cannot be in the past';
      return 'Must be today';
    case 'days-from-today':
      if (p.direction === 'ago') return `Must be within the last ${p.days} days`;
      return `Must be within the next ${p.days} days`;
    case 'months-from-today':
      return `Must be ${OP_WORDS[p.op]} ${p.months} months ago`;
    case 'after-all-of':
      return `Must be after ${p.fields.map((f) => fieldLabel(f.name)).join(', ')}`;
    case 'text-length':
      return `Must be ${OP_WORDS[p.op]} ${p.n} characters`;
    case 'allowed-chars':
      if (p.mode === 'digits') return 'Digits only';
      if (p.mode === 'no-digits') return 'Must not contain digits';
      return 'Letters only';
    case 'pattern':
      return 'Invalid format';
    case 'int-value':
      return `Must be ${OP_WORDS[p.op]} ${p.value}`;
    case 'bs-year':
      if (p.bound === 'max-this-year') return 'Year cannot be in the future';
      if (p.bound === 'min-years-ago') return `Year cannot be more than ${p.years ?? ''} years ago`;
      return `Year must be at least ${p.years ?? ''} years ago`;
    case 'choice-alone':
      return `"${p.choice}" cannot be combined with other options`;
    case 'count-selected':
      return `Choose ${OP_WORDS[p.op]} ${p.value}`;
    case 'always-true':
    case 'code':
      return '';
  }
}

/** True when every value a preset needs is filled in. */
export function presetComplete(p: Preset): boolean {
  switch (p.kind) {
    case 'compare-value':
      return p.value !== '';
    case 'between':
      return p.min.value !== '' && p.max.value !== '';
    case 'compare-field':
      return p.field.name !== '';
    case 'days-from-today':
      return p.days !== '';
    case 'months-from-today':
      return p.months !== '';
    case 'after-all-of':
      return p.fields.length > 0 && p.fields.every((f) => f.name !== '');
    case 'text-length':
      return p.n !== '';
    case 'allowed-chars':
      return p.mode !== 'letters' || p.scripts.length > 0;
    case 'pattern':
      return p.pattern !== '';
    case 'int-value':
      return p.value !== '';
    case 'bs-year':
      return p.bound === 'max-this-year' || Boolean(p.years);
    case 'choice-alone':
      return p.choice !== '';
    case 'count-selected':
      return p.value !== '';
    case 'compare-today':
    case 'always-true':
      return true;
    case 'code':
      return p.text.trim() !== '';
  }
}
