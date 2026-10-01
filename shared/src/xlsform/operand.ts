/**
 * A small XPath *operand* grammar for the constraint / relevant parser —
 * T9a (#14), docs/plans/9_complex_logic_calculation_relevant_constraint.
 *
 * Real validation rules are written against the answer itself (`.`), use
 * relative paths (`../lmp_date`) as an alias of `${lmp_date}`, and wrap
 * either in a handful of functions: `string-length(.)`, `int(format-date(.,
 * '%Y'))`, `max(coalesce(${a}, 0), …)`, `today() - 30`. This module parses
 * one side of a comparison (or one argument of a predicate) into a tree so
 * the UI can recognise presets, and serializes a tree back to canonical
 * spacing.
 *
 * Canonical spacing is only ever emitted for a rule the author CHANGED.
 * A parsed rule carries its verbatim `source` (see `relevantParser.ts`) and
 * re-emits it while it still describes the same tree — so `.<=100` and
 * `. <= 100` both open as the same rule and both save back byte-identical.
 *
 * The grammar is deliberately closed: only the functions in `KNOWN_FUNCTIONS`
 * parse, and a relative path must be a single segment (`../inputs/contact/x`
 * is the contact-input reference handled by `calcReference.ts`). Anything
 * outside returns `null`, and the caller keeps the text raw.
 */

export type RefSpelling = 'braces' | 'relative';

export type Operand =
  /** `.` — the answer to this question. */
  | { kind: 'self' }
  /** `${name}` or `../name`; the spelling is kept so it is re-emitted as written. */
  | { kind: 'field'; name: string; spelling: RefSpelling }
  /** A numeric literal, text preserved (`36.50`, `-1`). */
  | { kind: 'number'; text: string }
  /** A quoted literal; XPath has no escaping inside quotes. */
  | { kind: 'string'; value: string; quote: "'" | '"' }
  /** `fn(arg, …)`; `today()` / `now()` are zero-argument calls. */
  | { kind: 'call'; fn: string; args: Operand[] }
  /** `left op right`. */
  | { kind: 'binary'; op: BinaryOp; left: Operand; right: Operand }
  /** `(inner)` — kept so precedence survives a canonical re-emit. */
  | { kind: 'group'; inner: Operand };

export type BinaryOp = '+' | '-' | '*' | 'div' | 'mod';

/**
 * Functions that may appear in a structured operand. ODK XPath plus the CHT
 * Enketo extensions that the seven real configs actually call in
 * `constraint` / `relevant` cells (validation-rules-v2 §"What real configs
 * actually call"). Unknown names fall to raw text, never an error.
 */
export const KNOWN_FUNCTIONS: ReadonlySet<string> = new Set([
  // ODK / XPath
  'string-length',
  'regex',
  'selected',
  'selected-at',
  'count-selected',
  'count',
  'sum',
  'int',
  'number',
  'string',
  'boolean',
  'floor',
  'round',
  'max',
  'min',
  'coalesce',
  'concat',
  'substr',
  'contains',
  'starts-with',
  'ends-with',
  'translate',
  'today',
  'now',
  'date',
  'date-time',
  'format-date',
  'format-date-time',
  'decimal-date-time',
  'decimal-time',
  'if',
  'once',
  'position',
  'jr:choice-name',
  // CHT extensions
  'add-date',
  'difference-in-months',
  'to-bikram-sambat',
  'cht:difference-in-days',
  'cht:difference-in-weeks',
  'cht:difference-in-months',
  'cht:difference-in-years',
  'z-score',
]);

/* ------------------------------------------------------------------------ */
/*                                 Tokens                                    */
/* ------------------------------------------------------------------------ */

type Token =
  | { t: 'self' }
  | { t: 'field'; name: string; spelling: RefSpelling }
  | { t: 'number'; text: string }
  | { t: 'string'; value: string; quote: "'" | '"' }
  | { t: 'ident'; name: string }
  | { t: 'punct'; ch: '(' | ')' | ',' | '+' | '-' | '*' };

const IDENT_RE = /^[A-Za-z_][\w-]*(?::[A-Za-z_][\w-]*)?/;
const RELATIVE_RE = /^\.\.\/([A-Za-z_][\w-]*)(?![\w\-/])/;
const BRACES_RE = /^\$\{\s*([^}\s]+)\s*\}/;
const NUMBER_RE = /^(?:\d+(?:\.\d+)?|\.\d+)/;

function tokenize(src: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = BRACES_RE.exec(rest))) {
      out.push({ t: 'field', name: m[1]!, spelling: 'braces' });
      i += m[0].length;
      continue;
    }
    if ((m = RELATIVE_RE.exec(rest))) {
      out.push({ t: 'field', name: m[1]!, spelling: 'relative' });
      i += m[0].length;
      continue;
    }
    if (rest.startsWith('../')) return null; // multi-segment path: not an alias
    if ((m = NUMBER_RE.exec(rest))) {
      out.push({ t: 'number', text: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '.') {
      out.push({ t: 'self' });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const close = src.indexOf(ch, i + 1);
      if (close < 0) return null;
      out.push({ t: 'string', value: src.slice(i + 1, close), quote: ch });
      i = close + 1;
      continue;
    }
    if ((m = IDENT_RE.exec(rest))) {
      out.push({ t: 'ident', name: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',' || ch === '+' || ch === '-' || ch === '*') {
      out.push({ t: 'punct', ch });
      i++;
      continue;
    }
    return null;
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/*                                 Parser                                    */
/* ------------------------------------------------------------------------ */

class Parser {
  private pos = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }
  private next(): Token | undefined {
    return this.toks[this.pos++];
  }
  private isPunct(ch: string): boolean {
    const t = this.peek();
    return t !== undefined && t.t === 'punct' && t.ch === ch;
  }
  private isIdent(name: string): boolean {
    const t = this.peek();
    return t !== undefined && t.t === 'ident' && t.name === name;
  }

  done(): boolean {
    return this.pos >= this.toks.length;
  }

  /** expr := term (('+' | '-') term)* */
  expr(): Operand | null {
    let left = this.term();
    if (!left) return null;
    for (;;) {
      const op: BinaryOp | null = this.isPunct('+') ? '+' : this.isPunct('-') ? '-' : null;
      if (op === null) return left;
      this.next();
      const right = this.term();
      if (!right) return null;
      left = { kind: 'binary', op, left, right };
    }
  }

  /** term := primary (('*' | 'div' | 'mod') primary)* */
  private term(): Operand | null {
    let left = this.primary();
    if (!left) return null;
    for (;;) {
      const op: BinaryOp | null = this.isPunct('*')
        ? '*'
        : this.isIdent('div')
          ? 'div'
          : this.isIdent('mod')
            ? 'mod'
            : null;
      if (op === null) return left;
      this.next();
      const right = this.primary();
      if (!right) return null;
      left = { kind: 'binary', op, left, right };
    }
  }

  private primary(): Operand | null {
    const t = this.next();
    if (!t) return null;
    switch (t.t) {
      case 'self':
        return { kind: 'self' };
      case 'field':
        return { kind: 'field', name: t.name, spelling: t.spelling };
      case 'number':
        return { kind: 'number', text: t.text };
      case 'string':
        return { kind: 'string', value: t.value, quote: t.quote };
      case 'punct': {
        if (t.ch === '(') {
          const inner = this.expr();
          if (!inner || !this.isPunct(')')) return null;
          this.next();
          return { kind: 'group', inner };
        }
        if (t.ch === '-') {
          // Unary minus only directly before a numeric literal (`-1`, `- 1`).
          const n = this.peek();
          if (n && n.t === 'number') {
            this.next();
            return { kind: 'number', text: `-${n.text}` };
          }
        }
        return null;
      }
      case 'ident': {
        if (!KNOWN_FUNCTIONS.has(t.name)) return null;
        if (!this.isPunct('(')) return null;
        this.next();
        const args: Operand[] = [];
        if (this.isPunct(')')) {
          this.next();
          return { kind: 'call', fn: t.name, args };
        }
        for (;;) {
          const a = this.expr();
          if (!a) return null;
          args.push(a);
          if (this.isPunct(',')) {
            this.next();
            continue;
          }
          if (this.isPunct(')')) {
            this.next();
            return { kind: 'call', fn: t.name, args };
          }
          return null;
        }
      }
    }
  }
}

/**
 * Parse one operand. `null` when the text is outside the grammar — the
 * caller keeps it as raw text.
 */
export function parseOperand(src: string): Operand | null {
  const toks = tokenize(src.trim());
  if (!toks || toks.length === 0) return null;
  const p = new Parser(toks);
  const out = p.expr();
  if (!out || !p.done()) return null;
  return out;
}

/** Canonical spacing: `fn(a, b)`, `a - b`, `(inner)`. */
export function serializeOperand(o: Operand): string {
  switch (o.kind) {
    case 'self':
      return '.';
    case 'field':
      return o.spelling === 'relative' ? `../${o.name}` : `\${${o.name}}`;
    case 'number':
      return o.text;
    case 'string':
      return `${o.quote}${o.value}${o.quote}`;
    case 'call':
      return `${o.fn}(${o.args.map(serializeOperand).join(', ')})`;
    case 'binary':
      return `${serializeOperand(o.left)} ${o.op} ${serializeOperand(o.right)}`;
    case 'group':
      return `(${serializeOperand(o.inner)})`;
  }
}

/** True when the operand is `.`, possibly wrapped in parens (`(.)`). */
export function isSelfOperand(o: Operand): boolean {
  return o.kind === 'self' || (o.kind === 'group' && isSelfOperand(o.inner));
}

/** Every field the operand references, in order, `${}` and `../` alike. */
export function operandFields(o: Operand): string[] {
  switch (o.kind) {
    case 'field':
      return [o.name];
    case 'call':
      return o.args.flatMap(operandFields);
    case 'binary':
      return [...operandFields(o.left), ...operandFields(o.right)];
    case 'group':
      return operandFields(o.inner);
    default:
      return [];
  }
}
