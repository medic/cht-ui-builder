/**
 * Discover which contact-summary context values a config already computes,
 * so a no-code author can PICK one instead of typing an identifier they
 * hope is spelled right.
 *
 * Spec: docs/plans/pick-preexisting-context-values.md. Read-only — this
 * module never emits anything into a config, so it carries no round-trip
 * risk.
 *
 * ## Three channels, and why the order is what it is
 *
 * The plan's own central finding, which inverted its earlier draft:
 * **reading what a config CONSUMES beats reading what it DEFINES.**
 * Measured on `config-nssd/chis`:
 *
 * | Channel | Scans | Keys |
 * |---|---|---|
 * | 1 consumption — form calculations | `instance('contact-summary')/context/<key>` in every form | **63** |
 * | 2 consumption — form eligibility  | `summary.<key>` in every `*.properties.json` | **7** |
 * | 3 definition  — static scan       | `context.<key> = …` in the contact-summary JS | **21** |
 * | union | | **~70** |
 *
 * 48 keys are read by real forms yet invisible to the static scan: the
 * whole `*_vax` series (they arrive via a spread from another function),
 * the ANC set (`lmp_date_8601`, `edd_8601`, …, assigned through a
 * `context[key] = value` loop), and the `baby_name_1..4_ctx` /
 * `baby_status_1..4_ctx` families (template-literal keys). Channel 1 names
 * those concretely — with their real instantiated names — which static
 * analysis provably cannot.
 *
 * Conversely 6 keys are defined but appear in no form calculation
 * (`alive`, `has_become_form`, the `show_*_form` set); channel 2 explains
 * why — they are consumed in form-eligibility expressions instead. The
 * channels are complementary, not redundant.
 *
 * Two things channel 1 gives away free:
 *   - **Proof of use.** A key six forms already read is safer to offer than
 *     one nothing reads. That is `usageCount`.
 *   - **The house idiom.** The surrounding cell shows HOW this config reads
 *     context, so an insert can match it rather than impose ours. That is
 *     `idiom` (see `inferContextWrapper` in xlsform/calcReference.ts).
 *
 * ## Honesty requirement
 *
 * Channel 3 is provably incomplete — dynamic keys, template-literal keys
 * and spreads from a call cannot be enumerated statically. So the scan
 * reports {@link ContextScan.indeterminate} and the UI must say so. A
 * partial list presented as complete is worse than no list: it makes a
 * missing key look like a spelling mistake.
 */
import {
  recognizeReference,
  type ContextWrapper,
} from '../xlsform/calcReference.js';
import { isStructural, type XLSForm } from '../xlsform/types.js';
import { parseContactSummary } from '../tasks/contactSummaryParser.js';
import { blankNonCode, matchBracket, skipNonCodeAt } from '../tasks/jsScan.js';

/* ========================== the shared shape ============================= */

/** Every way we can come to know a context key exists. */
export type ContextKeyOrigin =
  /** A form's calculation cell reads it — proven to work, a form ships it. */
  | 'form-calculation'
  /** A form's eligibility expression reads it — also proven. */
  | 'form-eligibility'
  /** `const context = { key: … }` or `context: { key: … }` in the export. */
  | 'definition-literal'
  /** `context.key = …` / `context['key'] = …`. */
  | 'definition-assignment';

/** Why part of the definition scan is unknowable. */
export type IndeterminateReason =
  /** `context[expr] = …` where `expr` is not a string literal. */
  | 'dynamic-key'
  /** `context[`name_${i}`] = …` — a FAMILY of keys, count set by data. */
  | 'template-literal-key'
  /** `Object.assign({}, f(…))` / `{...f(…)}` — keys come from elsewhere. */
  | 'spread-from-call';

export interface ContextKeyInfo {
  key: string;
  /** Every channel that found it, best-evidence first. */
  origins: ContextKeyOrigin[];
  /**
   * How many form cells / eligibility expressions read this key
   * (channels 1 + 2). `0` means "defined but nothing reads it yet" — worth
   * offering, but with less confidence than a key six forms depend on.
   */
  usageCount: number;
  /** Form ids that read it, deduped, first-seen order. */
  usedBy: string[];
  /**
   * The wrapper idiom the existing reads use most often, so an insert can
   * match the config's own style. `null` when nothing reads it (channel 3
   * only) or when every read sits inside a larger expression we don't
   * classify.
   */
  idiom: ContextWrapper | null;
  /**
   * Channel 3: the assignment is nested inside an `if` / loop / ternary, so
   * the key may legitimately not exist for a given contact. The UI must
   * mark these — static detection cannot tell "doesn't apply to her" from
   * "you spelled it wrong", which is the argument for showing real values.
   */
  conditional: boolean;
  /** Channel 3: right-hand-side source text, for a "computed from…" hint. */
  expression: string | null;
  /** Channel 3: which file the definition was found in. */
  definedIn: string | null;
}

export interface IndeterminateNote {
  reason: IndeterminateReason;
  /** The offending source text, trimmed and truncated for display. */
  evidence: string;
  file: string;
}

export interface ContextScan {
  /**
   * Proven-by-use keys first (descending `usageCount`), then
   * definition-only keys alphabetically. That ordering IS the confidence
   * signal the plan asks for.
   */
  keys: ContextKeyInfo[];
  /** Non-empty ⇒ the list is provably partial. Say so in the UI. */
  indeterminate: IndeterminateNote[];
  /**
   * `false` when channel 3 could not locate the context object at all —
   * distinct from "located it and it was empty". Today's zero-keys bug is
   * exactly this case going unreported.
   */
  definitionsFound: boolean;
}

/* ===================== channel 1 — form calculations ===================== */

/**
 * Every context key read anywhere in `cell`, with the wrapper idiom when
 * the whole cell is one recognizable read.
 *
 * Deliberately NOT `recognizeReference(cell)` alone: that anchors on the
 * entire trimmed cell, so a key used inside a larger expression — say
 * `concat(instance('contact-summary')/context/a, ' ', ${b})` — would be
 * missed entirely. Discovery wants every occurrence; the wrapper is a bonus
 * that only makes sense for a whole-cell read.
 */
export function harvestContextKeyReads(
  cell: string,
): Array<{ key: string; wrapper: ContextWrapper | null }> {
  const out: Array<{ key: string; wrapper: ContextWrapper | null }> = [];
  if (!cell || !cell.includes("instance('contact-summary')")) return out;

  const whole = recognizeReference(cell);
  const wholeWrapper =
    whole && whole.kind === 'contact-summary' ? whole.wrapper : null;

  // ONE entry per distinct key, not per occurrence. The fallback and guarded
  // wrappers name the same key twice by construction — `if(REF, REF, .)` — so
  // counting occurrences double-counts them and inverts the ranking that
  // ContextKeyInfo.usageCount is documented to express ("how many form cells
  // read this key") and that the picker orders by. Measured on NSSD: 79 cells
  // carry context reads but produced 147 hits, ranking `lmp_date_8601` (3
  // cells) above `previous_bmi_ctx` (5 cells).
  const re = /instance\('contact-summary'\)\/context\/([\w-]+)/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(cell)) !== null) {
    const key = m[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    // A whole-cell wrapper describes the cell, so it applies to the key that
    // cell is about.
    out.push({ key, wrapper: wholeWrapper });
  }
  return out;
}

/**
 * Columns scanned for context reads.
 *
 * Measured: all 132 real occurrences across five config roots live in
 * `calculation` and nowhere else. The other columns are scanned anyway
 * because restricting to `calculation` would be an unjustified constant —
 * `relevant` and `constraint` can legally carry the same XPath, and
 * `relevantParser` already emits into `relevant`. Scanning them costs one
 * string search per cell.
 */
const READ_COLUMNS = [
  'calculation',
  'relevant',
  'constraint',
  'choice_filter',
  'default',
  'repeat_count',
] as const;

export interface FormForScan {
  formId: string;
  xlsform: XLSForm;
}

export interface ReadHit {
  key: string;
  formId: string;
  wrapper: ContextWrapper | null;
}

/** Channel 1 — scan every form's ref-bearing cells for context reads. */
export function scanFormsForContextReads(forms: readonly FormForScan[]): ReadHit[] {
  const hits: ReadHit[] = [];
  for (const { formId, xlsform } of forms) {
    for (const row of xlsform.survey) {
      // Structural rows (`begin group` / `end group`) carry no expressions,
      // but they are cheap to skip and skipping keeps parity with the
      // preflight rules' iteration.
      if (isStructural(row)) continue;
      for (const col of READ_COLUMNS) {
        const cell = row.extras[col];
        if (!cell) continue;
        for (const { key, wrapper } of harvestContextKeyReads(cell)) {
          hits.push({ key, formId, wrapper });
        }
      }
    }
  }
  return hits;
}

/* ==================== channel 2 — form eligibility ====================== */

/**
 * `summary.<key>` inside a form's `context.expression`.
 *
 * A regex rather than `parseContextExpression`, on purpose: the structured
 * parser splits on `&&` and drops anything it cannot classify into a single
 * `raw` rule, so a key inside an `||` branch or an unrecognised shape would
 * be invisible. Discovery only needs the names, and the names are
 * unambiguous in text.
 */
const SUMMARY_FLAG_RE = /\bsummary\.([A-Za-z_$][\w$]*)/g;

export interface EligibilityForScan {
  formId: string;
  /** The `context.expression` string from `<form>.properties.json`. */
  expression: string;
}

/** Channel 2 — scan form-eligibility expressions for `summary.<key>`. */
export function scanEligibilityForContextReads(
  entries: readonly EligibilityForScan[],
): ReadHit[] {
  const hits: ReadHit[] = [];
  for (const { formId, expression } of entries) {
    if (!expression) continue;
    const re = new RegExp(SUMMARY_FLAG_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(expression)) !== null) {
      hits.push({ key: m[1]!, formId, wrapper: null });
    }
  }
  return hits;
}

/* =============== channel 3 — the static definition scan ================= */

export interface SummaryFileForScan {
  /** Filename as it exists on disk — DISCOVERED, never assumed. Both
   *  `contact-summary.extras.js` and `contact-summary-extras.js` are real
   *  spellings (four customer configs use the dot, NSSD and all four of our
   *  own templates use the hyphen). */
  file: string;
  source: string;
}

export interface DefinitionHit {
  key: string;
  origin: 'definition-literal' | 'definition-assignment';
  conditional: boolean;
  expression: string | null;
  file: string;
}

export interface DefinitionScan {
  hits: DefinitionHit[];
  indeterminate: IndeterminateNote[];
  found: boolean;
}

/** Trim + truncate a source fragment for display in an honesty note. */
function evidence(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 120 ? `${one.slice(0, 117)}…` : one;
}

/**
 * `const|let|var context = <initializer>` — returns the initializer text
 * (to the end of the statement) and where it started. Only the FIRST such
 * binding is considered; a config that rebinds `context` twice is outside
 * what one hop can honestly resolve.
 */
function findContextBinding(
  src: string,
): { initializer: string; start: number } | null {
  // Search the BLANKED copy so a commented-out `const context = oldCtx(c)`
  // cannot win over the live binding. It did: the whole scan got pointed at a
  // dead helper and its keys were offered as the config's, with
  // `indeterminate: []` claiming the list was complete.
  const re = /\b(?:const|let|var)\s+context\s*=\s*/g;
  const m = re.exec(blankNonCode(src));
  if (!m) return null;
  const start = m.index + m[0].length;
  // Walk to the statement terminator at depth 0 so an initializer spanning
  // several lines (NSSD's `Object.assign({},\n  … ? … : {})`) is captured
  // whole.
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const sk = skipNonCodeAt(src, i);
    if (sk !== null) {
      i = sk;
      continue;
    }
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    } else if (c === ';' && depth === 0) break;
    i++;
  }
  return { initializer: src.slice(start, i), start };
}

/** `getContext(a, b)` → `getContext`, when the initializer is a bare call. */
function calleeOf(initializer: string): string | null {
  const m = /^([A-Za-z_$][\w$]*)\s*\(/.exec(initializer.trim());
  return m ? m[1]! : null;
}

/**
 * Body bounds of a function called `name`, whichever way it is written.
 *
 * All four shapes below are ordinary JS, so matching only `function NAME(`
 * made the one-hop indirection fail on an arrow-assigned helper — returning
 * zero keys AND a note claiming the definition was "not found in the
 * contact-summary files" when it was right there:
 *
 *   function getContext(a, b) { … }
 *   const getContext = (a, b) => { … }
 *   const getContext = function (a, b) { … }
 *   module.exports = { getContext(a, b) { … } }     // method shorthand
 *
 * Searched over the BLANKED source so a commented-out definition cannot win.
 */
function findFunctionBody(
  src: string,
  name: string,
): { start: number; end: number } | null {
  const code = blankNonCode(src);
  const patterns = [
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`),
    new RegExp(`\\b${name}\\s*=\\s*(?:async\\s*)?(?:function\\s*)?\\(`),
    new RegExp(`(?:^|[,{]\\s*)${name}\\s*\\(`, 'm'),
  ];
  for (const re of patterns) {
    const m = re.exec(code);
    if (!m) continue;
    const parenOpen = code.indexOf('(', m.index);
    if (parenOpen < 0) continue;
    const parenClose = matchBracket(code, parenOpen, '(', ')');
    if (parenClose < 0) continue;
    const brace = code.indexOf('{', parenClose);
    if (brace < 0) continue;
    // Only `=>` (or nothing) may sit between the parameter list and the body.
    // Anything else means this was a CALL, not a definition.
    const between = code.slice(parenClose + 1, brace).trim();
    if (between !== '' && between !== '=>') continue;
    const end = matchBracket(src, brace, '{', '}');
    if (end < 0) continue;
    return { start: brace, end };
  }
  return null;
}

/**
 * Does this initializer pull keys in from somewhere we can't read?
 * `Object.assign({}, f(…))` and `{...f(…)}` both do.
 */
function spreadFromCall(initializer: string): boolean {
  const m = /Object\.assign\s*\(/.exec(initializer);
  if (m) {
    const open = initializer.indexOf('(', m.index);
    const close = matchBracket(initializer, open, '(', ')');
    const args = splitTopLevel(initializer.slice(open + 1, close < 0 ? undefined : close));
    // Only an ARGUMENT that is a call hides keys. An object literal is fully
    // readable even when one of its VALUES is a call — the previous test
    // matched any `identifier(` anywhere in the argument list, so
    // `Object.assign({}, { alive: isAlive(c) })` was reported as hiding keys
    // and the UI told the author the list was incomplete when it was not.
    // Training someone to distrust a correct list is its own defect.
    return args.some((a) => {
      const t = a.trim();
      if (t === '' || t.startsWith('{')) return false;
      return /[A-Za-z_$][\w$]*\s*\(/.test(t);
    });
  }
  return /\.\.\.\s*[A-Za-z_$][\w$]*\s*\(/.test(initializer);
}

/** Split on top-level commas, ignoring those nested in brackets or non-code. */
function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < src.length) {
    const sk = skipNonCodeAt(src, i);
    if (sk !== null && sk > i) {
      i = sk;
      continue;
    }
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(src.slice(start));
  return parts;
}

/**
 * Scan a function body (or a whole module) for `context.<key> =` and
 * `context['<key>'] =` assignments, plus the shapes that are provably
 * unknowable.
 *
 * `conditional` is brace depth relative to `bodyStart`: an assignment
 * nested in an `if`, a loop or a block may or may not run for a given
 * contact. NSSD's own `getContext` puts 7 assignments at depth 0 and the
 * remaining 14 inside `if` blocks, which is exactly the distinction the UI
 * needs in order to say "only set for some contacts".
 */
function scanAssignments(
  src: string,
  bodyStart: number,
  bodyEnd: number,
  file: string,
): { hits: DefinitionHit[]; indeterminate: IndeterminateNote[] } {
  const hits: DefinitionHit[] = [];
  const indeterminate: IndeterminateNote[] = [];
  let depth = 0;
  let i = bodyStart;
  // `bodyStart` points AT the opening brace when scanning a function; step
  // over it so the body's own braces are depth 0.
  if (src[i] === '{') {
    i++;
  }
  while (i < bodyEnd) {
    const sk = skipNonCodeAt(src, i);
    if (sk !== null) {
      i = sk;
      continue;
    }
    const c = src[i];
    if (c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      depth--;
      i++;
      continue;
    }
    if (c === 'c' && src.startsWith('context', i)) {
      // Must be a whole identifier, not a suffix of `myContext`.
      const prev = i > 0 ? src[i - 1] : '';
      if (prev && /[\w$.]/.test(prev)) {
        i += 7;
        continue;
      }
      const rest = i + 7;
      // context.<ident> = (but not ==, ===)
      const dot = /^\.([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(src.slice(rest, rest + 200));
      if (dot) {
        const eq = rest + dot[0].length;
        hits.push({
          key: dot[1]!,
          origin: 'definition-assignment',
          conditional: depth > 0,
          expression: readRhs(src, eq, bodyEnd),
          file,
        });
        i = eq;
        continue;
      }
      // context[ … ] =
      if (src[rest] === '[') {
        const close = matchBracket(src, rest, '[', ']');
        if (close > 0) {
          const inner = src.slice(rest + 1, close).trim();
          // Scan PAST any amount of whitespace. A 3-character window meant
          // `context['lmp_date']    = 1` read as a non-assignment: the key was
          // dropped, and for a template-literal key the indeterminate note
          // went with it — a whole key family invisible while the scan
          // reported itself complete. The sibling dot-form path already
          // tolerated any spacing, which made this an oversight, not a rule.
          let probe = close + 1;
          while (probe < bodyEnd && /\s/.test(src[probe] ?? '')) probe++;
          const isAssign = src[probe] === '=' && src[probe + 1] !== '=';
          if (isAssign) {
            const literal = /^'([^']*)'$/.exec(inner) ?? /^"([^"]*)"$/.exec(inner);
            if (literal) {
              hits.push({
                key: literal[1]!,
                origin: 'definition-assignment',
                conditional: depth > 0,
                expression: readRhs(src, probe + 1, bodyEnd),
                file,
              });
            } else {
              indeterminate.push({
                reason: inner.startsWith('`') ? 'template-literal-key' : 'dynamic-key',
                evidence: `context[${evidence(inner)}] = …`,
                file,
              });
            }
          }
          i = close + 1;
          continue;
        }
      }
      i += 7;
      continue;
    }
    i++;
  }
  return { hits, indeterminate };
}

/** Source text of the right-hand side, up to the statement end at depth 0. */
function readRhs(src: string, from: number, limit: number): string | null {
  let i = from;
  let depth = 0;
  while (i < limit) {
    const sk = skipNonCodeAt(src, i);
    if (sk !== null) {
      i = sk;
      continue;
    }
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    } else if (c === ';' && depth === 0) break;
    else if (c === '\n' && depth === 0) {
      // A newline only ends the expression when what follows STARTS a new
      // statement. Breaking on every newline left `context.total =\n  a + b;`
      // with a null expression, so the picker's "computed from…" hint was
      // blank for any right-hand side wrapped across lines.
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j] ?? '')) j++;
      const rest = src.slice(j, j + 24);
      const startsStatement =
        rest === '' ||
        /^(context[.[]|const |let |var |return\b|if\s*\(|for\s*\(|\})/.test(rest);
      if (startsStatement) break;
    }
    i++;
  }
  const raw = src.slice(from, i).trim();
  return raw === '' ? null : raw;
}

/**
 * Channel 3 — the static definition scan.
 *
 * Handles, in order:
 *  1. `const context = { … }` and `context: { … }` in the export — already
 *     supported by `parseContactSummary`, whose scoping to the LAST
 *     `return` is what keeps the card-field `context: { count, total }`
 *     (a translation-interpolation context, nothing to do with the summary)
 *     out of the list. Reused rather than reimplemented for exactly that
 *     reason.
 *  2. `context.<key> = …` assignments in the same scope.
 *  3. ONE hop of indirection: `const context = getContext(a, b)` resolves
 *     `getContext` in any of the supplied files — which is what makes NSSD
 *     work, since its 21 keys live in the extras file, not the templated
 *     one. Deliberately not a general call-graph resolver (plan: "one hop
 *     is enough for NSSD; do not build one").
 *  4. Reporting what it cannot see.
 *
 * `files` should be every contact-summary file found on disk, templated
 * first. Pass the filenames as they actually are; nothing here assumes a
 * spelling.
 */
export function scanContextDefinitions(
  files: readonly SummaryFileForScan[],
): DefinitionScan {
  const hits: DefinitionHit[] = [];
  const indeterminate: IndeterminateNote[] = [];
  let found = false;

  const primary = files[0];
  if (!primary) return { hits, indeterminate, found };

  // (1) literal object, via the existing parser and its scoping protection.
  const parsed = parseContactSummary(primary.source);
  if (parsed.contextBounds) {
    found = true;
    for (const key of parsed.contextOrder) {
      hits.push({
        key,
        origin: 'definition-literal',
        conditional: false,
        expression: parsed.contextFlags[key] ?? null,
        file: primary.file,
      });
    }
  }

  // (2)+(3) find where `context` is bound and follow one hop if it is a call.
  const binding = findContextBinding(primary.source);
  let scanTarget: { src: string; start: number; end: number; file: string } | null = null;

  if (binding) {
    const callee = calleeOf(binding.initializer);
    if (callee) {
      for (const f of files) {
        const body = findFunctionBody(f.source, callee);
        if (body) {
          found = true;
          scanTarget = { src: f.source, start: body.start, end: body.end, file: f.file };
          break;
        }
      }
      if (!scanTarget) {
        // We know it is computed elsewhere but cannot find where. Say so
        // rather than reporting an empty list as complete.
        indeterminate.push({
          reason: 'spread-from-call',
          evidence: `context = ${evidence(binding.initializer)} — definition of ${callee}() not found in the contact-summary files`,
          file: primary.file,
        });
      }
    } else if (spreadFromCall(binding.initializer)) {
      found = true;
      indeterminate.push({
        reason: 'spread-from-call',
        evidence: `context = ${evidence(binding.initializer)}`,
        file: primary.file,
      });
    }
  }

  // Assignments: inside the resolved function when there was one hop,
  // otherwise across the primary file.
  const targets = scanTarget
    ? [scanTarget]
    : [{ src: primary.source, start: 0, end: primary.source.length, file: primary.file }];
  for (const t of targets) {
    const r = scanAssignments(t.src, t.start, t.end, t.file);
    if (r.hits.length > 0) found = true;
    hits.push(...r.hits);
    indeterminate.push(...r.indeterminate);

    // A nested `const context = Object.assign({}, f(…))` inside the resolved
    // body hides keys too — NSSD's getContext opens with exactly that.
    const innerBinding = findContextBinding(t.src.slice(t.start, t.end));
    if (innerBinding && spreadFromCall(innerBinding.initializer)) {
      indeterminate.push({
        reason: 'spread-from-call',
        evidence: `context = ${evidence(innerBinding.initializer)}`,
        file: t.file,
      });
    }
  }

  return { hits, indeterminate: dedupeNotes(indeterminate), found };
}

function dedupeNotes(notes: readonly IndeterminateNote[]): IndeterminateNote[] {
  const seen = new Set<string>();
  const out: IndeterminateNote[] = [];
  for (const n of notes) {
    const k = `${n.reason}|${n.evidence}|${n.file}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

/* ============================== the merge ============================== */

/**
 * Fold all three channels into one ranked list.
 *
 * Ranking is the confidence signal: keys something already reads come
 * first, most-read first, because a key six forms depend on is safer to
 * offer than one nothing touches. Definition-only keys follow
 * alphabetically — they are real and worth offering, just unproven.
 */
export function mergeContextScan(input: {
  formReads?: readonly ReadHit[];
  eligibilityReads?: readonly ReadHit[];
  definitions?: DefinitionScan;
}): ContextScan {
  const byKey = new Map<string, ContextKeyInfo>();
  const wrapperVotes = new Map<string, Map<ContextWrapper, number>>();

  const ensure = (key: string): ContextKeyInfo => {
    let e = byKey.get(key);
    if (!e) {
      e = {
        key,
        origins: [],
        usageCount: 0,
        usedBy: [],
        idiom: null,
        conditional: false,
        expression: null,
        definedIn: null,
      };
      byKey.set(key, e);
    }
    return e;
  };
  const addOrigin = (e: ContextKeyInfo, o: ContextKeyOrigin): void => {
    if (!e.origins.includes(o)) e.origins.push(o);
  };

  for (const hit of input.formReads ?? []) {
    const e = ensure(hit.key);
    addOrigin(e, 'form-calculation');
    e.usageCount++;
    if (!e.usedBy.includes(hit.formId)) e.usedBy.push(hit.formId);
    if (hit.wrapper) {
      let votes = wrapperVotes.get(hit.key);
      if (!votes) {
        votes = new Map();
        wrapperVotes.set(hit.key, votes);
      }
      votes.set(hit.wrapper, (votes.get(hit.wrapper) ?? 0) + 1);
    }
  }

  for (const hit of input.eligibilityReads ?? []) {
    const e = ensure(hit.key);
    addOrigin(e, 'form-eligibility');
    e.usageCount++;
    if (!e.usedBy.includes(hit.formId)) e.usedBy.push(hit.formId);
  }

  // A key is only "conditional" if EVERY definition of it is conditional.
  // One unconditional assignment means it always exists, whatever other
  // branches also set it — so this is an AND over hits, tracked explicitly
  // rather than folded in place, which would make the answer depend on the
  // order the hits arrived in.
  const allConditional = new Map<string, boolean>();
  for (const hit of input.definitions?.hits ?? []) {
    const e = ensure(hit.key);
    addOrigin(e, hit.origin);
    const prev = allConditional.get(hit.key);
    allConditional.set(hit.key, prev === undefined ? hit.conditional : prev && hit.conditional);
    // Keep the first expression/file we saw; an unconditional definition is
    // the more useful hint, so prefer it when one turns up later.
    // Never let a null overwrite a value we already have — the guard used to
    // reassign whenever the incoming hit was unconditional, which replaced a
    // good expression string with null, the opposite of the stated intent.
    if (hit.expression !== null && (e.expression === null || !hit.conditional)) {
      e.expression = hit.expression;
    }
    if (e.definedIn === null || !hit.conditional) e.definedIn = hit.file;
  }
  for (const [key, cond] of allConditional) {
    const e = byKey.get(key);
    if (e) e.conditional = cond;
  }

  for (const [key, votes] of wrapperVotes) {
    const e = byKey.get(key);
    if (!e) continue;
    let best: ContextWrapper | null = null;
    let bestN = 0;
    for (const [w, n] of votes) {
      if (n > bestN) {
        best = w;
        bestN = n;
      }
    }
    e.idiom = best;
  }

  const keys = [...byKey.values()].sort((a, b) => {
    if (a.usageCount !== b.usageCount) return b.usageCount - a.usageCount;
    return a.key.localeCompare(b.key);
  });

  return {
    keys,
    indeterminate: input.definitions?.indeterminate ?? [],
    definitionsFound: input.definitions?.found ?? false,
  };
}
