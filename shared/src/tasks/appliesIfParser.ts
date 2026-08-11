/**
 * Lift the common shapes of CHT task `appliesIf` / contact-summary flag
 * expressions into a small structured rule model the UI can render with
 * dropdowns and checkboxes.
 *
 * Surveyed gandaki + nssd, these are the patterns that show up:
 *
 *   if (!isTaskUser(user)) return false;
 *   if (!isAlive(contact.contact)) return false;   // gandaki's spelling
 *   if (!isAlive(contact)) return false;           // everyone else's
 *   if (isMuted(contact.contact)) return false;
 *   if (hasError(report)) return false;
 *   return contact.contact.role === 'patient';
 *   return contact.contact.gender !== 'male';
 *   return isActivePregnancy(contact.contact, contact.reports, report);
 *   return getField(report, 'surveillance.has_chronic_symptoms') === 'yes';
 *
 * The goal isn't a JS AST. It's pattern-matching the bodies that real
 * configs actually contain. Anything outside those patterns is returned
 * as a single 'raw' rule containing the entire body, and the UI shows it
 * in a code editor.
 */

export type AppliesIfRule =
  /*
   * The four "standard" CHT helpers. `args` is the author's OWN argument
   * text, captured verbatim, because which object the helper wants is the
   * PROJECT's decision, not ours (docs/principle-config-agnostic.md,
   * posture 1: never emit a token you didn't read).
   *
   * Measured across the four real configs plus our own cht-default
   * template: `isAlive(contact)` is what lumbini, nssd, moh-nepal and
   * cht-default write; only gandaki writes `isAlive(contact.contact)`, and
   * gandaki also passes a SECOND argument (`isAlive(contact.contact,
   * contact.reports)`). Substituting a fixed `contact.contact` was
   * therefore wrong for four projects out of five and lossy for the fifth.
   *
   * It was not cosmetic. cht-default's own tasks-extras.js defines
   *   function isAlive(contact) {
   *     return contact && contact.contact && !contact.contact.date_of_death;
   *   }
   * i.e. it takes the WRAPPER. Rewriting its call site to
   * `isAlive(contact.contact)` passes the doc, `contact.contact` is then
   * undefined, the helper returns falsy, the guard fires and the task
   * NEVER APPLIES — valid JS that compiles clean and silently disables
   * the task.
   *
   * `undefined` means "the UI built this rule and there is nothing to
   * preserve"; the serializer then derives the argument from the
   * function's own parameter names. See {@link defaultHelperArgs}.
   */
  | { kind: 'is_task_user'; args?: string }
  | { kind: 'is_alive'; negated: boolean; args?: string }
  | { kind: 'is_muted'; negated: boolean; args?: string }
  | { kind: 'has_error'; negated: boolean; args?: string }
  | { kind: 'helper'; name: string; args: string; negated: boolean }
  | { kind: 'contact_field'; field: string; op: '===' | '!==' | '>' | '<' | '>=' | '<='; value: string }
  | { kind: 'report_field'; field: string; op: '===' | '!==' | '>' | '<' | '>=' | '<='; value: string }
  /**
   * Presence check for a contact or report field. Positive form
   * ("field IS set") when negated=false; "field is NOT set" when
   * negated=true. Rendered as `!!<ref>` / `!<ref>`. Handles the
   * common CHT "gate on a field being non-empty" pattern that
   * users previously had to write as raw JS.
   */
  | { kind: 'field_presence'; source: 'contact' | 'report'; field: string; negated: boolean }
  /**
   * "The report's multi-select field includes this option" — the CHT
   * equivalent of the form side's `selected(${f}, 'v')`.
   *
   * A `select_multiple` answer arrives from `Utils.getField` as a SPACE-
   * SEPARATED string (`'vaginal_bleeding severe_headache'`), which is why
   * an `===` comparison against one option is silently wrong the moment a
   * second option is ticked. Emitted form:
   *
   *   positive: (Utils.getField(report, 'f') || '').split(' ').includes('v')
   *   guard   : !(Utils.getField(report, 'f') || '').split(' ').includes('v')
   *
   * `negated: false` means "must include". The `|| ''` is MANDATORY — an
   * unanswered field is `undefined`, and `undefined.split` throws inside
   * the rules engine, killing task generation for that contact.
   * `.includes()` on the split ARRAY (not `indexOf` on the string) is also
   * mandatory: substring matching would make option `issue` match
   * `no_issue`.
   *
   * Report-only by design — the contact side has no multi-select answers
   * and adding it would double the regex surface for no caller.
   * docs/NEXT.md item 4; closes Task R8, the geriatric spec's only GAP.
   */
  | { kind: 'report_field_includes'; field: string; value: string; negated: boolean }
  /**
   * Age check: compares (today − field's date) to a value in days /
   * weeks / months. Common CHT pattern for time-since scheduling
   * (e.g. "lmp_date was >= 42 weeks ago"). Emits inline JS Date
   * arithmetic with a fixed unit-multiplier — no project helper
   * required. Weeks = 604 800 000 ms, months = 2 629 800 000 ms
   * (30.4375 d avg — matches Utils.now-based schedulers).
   */
  | {
      kind: 'field_age';
      source: 'contact' | 'report';
      field: string;
      unit: 'days' | 'weeks' | 'months';
      op: '>=' | '<=' | '>' | '<' | '===' | '!==';
      value: number;
    }
  /**
   * Between-range age check: `min OP1 age OP2 max`. Common CHT
   * scheduling pattern ("task fires when LMP is 84-90 days old").
   * `minOp`/`maxOp` capture the endpoint strictness (>= / > for min,
   * <= / < for max) so round-trip preserves the user's original bounds
   * exactly. On parse, two adjacent `field_age` rules over the same
   * source/field/unit — one min-side, one max-side — are FUSED into a
   * single row so open+save doesn't split them into two lines.
   */
  | {
      kind: 'field_age_between';
      source: 'contact' | 'report';
      field: string;
      unit: 'days' | 'weeks' | 'months';
      min: number;
      max: number;
      minOp: '>=' | '>';
      maxOp: '<=' | '<';
    }
  /**
   * Unclassifiable expression, preserved verbatim. `fromGuard` records
   * WHERE it came from — that decides its polarity on serialize:
   *   - `fromGuard: true` — lifted from an `if (…) return false` guard
   *     condition; re-emitted in guard position (`if (text) { return
   *     false; }`), text unchanged.
   *   - absent/false — positive content (a `return …` conjunct, the
   *     whole-body fallback, or a UI-added "+ raw JS" row); re-emitted
   *     positively (verbatim body for statement-shaped text, else a
   *     `return …` conjunct).
   * Inferring this from `guardGroups === undefined` was the P0 re-audit
   * regression (geriatric re-audit 2026-08-05): solo guards carry an
   * undefined group id, so their raw conditions re-emitted as positive
   * `return …;` — silently inverted, valid JS, fail-open.
   */
  | { kind: 'raw'; text: string; fromGuard?: boolean };

/** ms per unit for field_age. `months` is 30.4375 d — matches how CHT's
 *  Utils.now / addDate treat month rounding. */
const UNIT_MS: Record<'days' | 'weeks' | 'months', number> = {
  days: 86_400_000,
  weeks: 604_800_000,
  months: 2_629_800_000,
};

export interface ParsedAppliesIf {
  /** The function's signature parameters in declaration order, e.g. ['contact', 'report']. */
  params: string[];
  /** Ordered rules; AND-combined. */
  rules: AppliesIfRule[];
  /**
   * Parallel to `rules`. Rules sharing the same non-undefined group id were
   * lifted from a single `if (A || B || ...) return false` guard and will be
   * re-grouped back into that shape on serialize — so opening + saving a
   * helper without edits produces a no-op diff. Rules added by the UI get
   * `undefined` and serialize as their own `if(...) return false` line.
   *
   * SEMANTICS NOTE: a `||`-joined GUARD is an AND of the displayed
   * positive rules — the task applies iff every guard alternative is
   * false. Formatting metadata only; all guardGroup rules combine with
   * AND like everything else.
   */
  guardGroups: Array<number | undefined>;
  /**
   * Parallel to `rules` — the OR-authoring channel (geriatric handoff §3).
   * Rules sharing the same non-undefined id are OR-COMBINED among
   * themselves (and AND-combined with the rest): the task applies when
   * ANY of them holds. Serialized as `if (!A && !B) { return false; }` —
   * the inverted guards joined with `&&`, which is exactly ¬(A ∨ B).
   *
   * (The handoff sketched reusing the `if (A || B)` guard shape, but that
   * shape is an AND of positives — see the guardGroups note above. A
   * correct OR needs the `&&` guard; the parser lifts that shape back
   * into the same OR group, so parse→serialize→parse is stable.)
   *
   * A rule is never in both a guardGroup and an orGroup.
   */
  orGroups: Array<number | undefined>;
  /** True if any rule fell back to raw — UI should offer a "Raw" tab. */
  hasRawFallback: boolean;
  /** Original source body (between the function's braces). */
  body: string;
}

const HELPER_NAMES_STANDARD = new Set(['isAlive', 'isMuted', 'hasError', 'isTaskUser']);

/** Parse a function or arrow expression source string. */
export function parseAppliesIf(source: string): ParsedAppliesIf {
  const trimmed = source.trim();
  // function (a, b) { body }
  // (a, b) => { body }
  // a => { body }
  // (a, b) => expr     (concise — wrap as a return)
  const fnMatch = /^function\s*[a-zA-Z_$]*\s*\(([^)]*)\)\s*\{([\s\S]*)\}\s*$/m.exec(trimmed);
  const arrowBlock = /^\(?([^)]*)\)?\s*=>\s*\{([\s\S]*)\}\s*$/m.exec(trimmed);
  const arrowConcise = /^\(?([^)]*)\)?\s*=>\s*([\s\S]*)\s*$/m.exec(trimmed);

  let params: string[] = [];
  let body = '';
  if (fnMatch && fnMatch[1] !== undefined && fnMatch[2] !== undefined) {
    params = splitParams(fnMatch[1]);
    body = fnMatch[2];
  } else if (arrowBlock && arrowBlock[1] !== undefined && arrowBlock[2] !== undefined) {
    params = splitParams(arrowBlock[1]);
    body = arrowBlock[2];
  } else if (arrowConcise && arrowConcise[1] !== undefined && arrowConcise[2] !== undefined) {
    params = splitParams(arrowConcise[1]);
    body = `return ${arrowConcise[2]};`;
  } else {
    return {
      params: [],
      rules: [{ kind: 'raw', text: trimmed }],
      guardGroups: [undefined],
      orGroups: [undefined],
      hasRawFallback: true,
      body: trimmed,
    };
  }

  const { rules, guardGroups, orGroups } = extractRules(body);
  const hasRawFallback = rules.some((r) => r.kind === 'raw');
  return { params, rules, guardGroups, orGroups, hasRawFallback, body };
}

function splitParams(s: string): string[] {
  return s
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Walk the function body extracting guard clauses + the final return.
 * Anything we don't recognize lands as a single 'raw' rule with the rest
 * of the body so we never silently drop logic.
 */
function extractRules(body: string): {
  rules: AppliesIfRule[];
  guardGroups: Array<number | undefined>;
  orGroups: Array<number | undefined>;
} {
  const rules: AppliesIfRule[] = [];
  const guardGroups: Array<number | undefined> = [];
  const orGroups: Array<number | undefined> = [];
  let nextGroup = 0;
  let nextOrGroup = 0;
  // Walk the body finding `if (cond) return false;` (with balanced parens),
  // accumulating leftover content into `unprocessed`.
  let i = 0;
  let unprocessed = '';
  while (i < body.length) {
    const ifIdx = body.indexOf('if', i);
    if (ifIdx < 0) {
      unprocessed += body.slice(i);
      break;
    }
    // Must be `if` followed by whitespace or `(`.
    const next = body[ifIdx + 2];
    if (next !== ' ' && next !== '\t' && next !== '(' && next !== '\n') {
      unprocessed += body.slice(i, ifIdx + 1);
      i = ifIdx + 1;
      continue;
    }
    // Capture text before `if`.
    unprocessed += body.slice(i, ifIdx);
    // Find the opening paren.
    let parenStart = ifIdx + 2;
    while (parenStart < body.length && body[parenStart] !== '(') parenStart++;
    if (parenStart >= body.length) {
      unprocessed += body.slice(ifIdx);
      break;
    }
    // Find matching close paren via depth tracking (no string awareness — guards are short).
    let depth = 0;
    let j = parenStart;
    let parenEnd = -1;
    while (j < body.length) {
      const c = body[j];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          parenEnd = j;
          break;
        }
      }
      j++;
    }
    if (parenEnd < 0) {
      unprocessed += body.slice(ifIdx);
      break;
    }
    const cond = body.slice(parenStart + 1, parenEnd);
    // After `)`, expect optionally `{`, then `return false;`, then optionally `}`.
    let k = parenEnd + 1;
    while (k < body.length && /\s/.test(body[k] ?? '')) k++;
    let hasBrace = false;
    if (body[k] === '{') {
      hasBrace = true;
      k++;
      while (k < body.length && /\s/.test(body[k] ?? '')) k++;
    }
    const tail = body.slice(k);
    const retMatch = /^return\s+false\s*;?/.exec(tail);
    if (!retMatch) {
      // Not a guard — treat the whole `if (...)` as unprocessed and move on.
      unprocessed += body.slice(ifIdx, parenEnd + 1);
      i = parenEnd + 1;
      continue;
    }
    k += retMatch[0].length;
    while (k < body.length && /\s/.test(body[k] ?? '')) k++;
    if (hasBrace && body[k] === '}') k++;

    // Successfully matched a guard. Every raw produced from here on is
    // GUARD-ORIGIN: mark it explicitly so the serializer re-emits it in
    // guard position with unchanged polarity (P0-1, re-audit 2026-08-05).
    const markGuardRaw = (r: AppliesIfRule): AppliesIfRule =>
      r.kind === 'raw' ? { ...r, fromGuard: true } : r;
    // Split the condition on top-level ||.
    const subs = splitOrOperands(cond);
    if (subs.length > 1) {
      // `if (A || B) return false` — AND of the inverted positives.
      // Group id records the source formatting for a no-op re-serialize.
      const groupId = nextGroup++;
      for (const op of subs) {
        const rule = classifySimple(op);
        rules.push(markGuardRaw(invertGuardRule(rule)));
        guardGroups.push(groupId);
        orGroups.push(undefined);
      }
    } else {
      // No top-level `||` — check for the OR-group shape (geriatric §3):
      // `if (!A && !B) return false` ≡ "A OR B". Lift it only when EVERY
      // conjunct classifies (a raw conjunct can't be inverted back on
      // serialize); otherwise the whole condition stays one raw guard,
      // exactly as before this feature.
      const andSubs = splitAnd(cond);
      const classified = andSubs.map(classifySimple);
      if (andSubs.length > 1 && classified.every((r) => r.kind !== 'raw')) {
        const orId = nextOrGroup++;
        for (const r of classified) {
          rules.push(invertGuardRule(r));
          guardGroups.push(undefined);
          orGroups.push(orId);
        }
      } else {
        rules.push(markGuardRaw(invertGuardRule(classifySimple(cond))));
        guardGroups.push(undefined);
        orGroups.push(undefined);
      }
    }
    i = k;
  }

  // 2) Find the final `return <expr>;` if any.
  const returnRe = /return\s+([^;]+);?/g;
  let returnExpr: string | null = null;
  let rm: RegExpExecArray | null;
  while ((rm = returnRe.exec(unprocessed)) !== null) {
    const txt = rm[1]?.trim() ?? '';
    if (txt === 'true' || txt === 'false') continue;
    returnExpr = txt;
  }
  if (returnExpr) {
    const subs = splitAnd(returnExpr);
    for (const s of subs) {
      // A conjunct with top-level `||` (`return A || B && …`) is a
      // positive OR — lift it into an OR group when every alternative
      // classifies (geriatric §3); otherwise raw, as before.
      const orSubs = splitOrOperands(s);
      if (orSubs.length > 1) {
        const classified = orSubs.map(classifySimple);
        if (classified.every((r) => r.kind !== 'raw')) {
          const orId = nextOrGroup++;
          for (const r of classified) {
            rules.push(r);
            guardGroups.push(undefined);
            orGroups.push(orId);
          }
          continue;
        }
      }
      rules.push(classifySimple(s));
      guardGroups.push(undefined);
      orGroups.push(undefined);
    }
  }

  // 3) If we got nothing useful and the body has real content, fallback raw.
  if (rules.length === 0 && body.trim().length > 0) {
    rules.push({ kind: 'raw', text: body.trim() });
    guardGroups.push(undefined);
    orGroups.push(undefined);
  }
  // 4) Fuse adjacent `field_age` min/max pairs into a single `field_age_between`
  //    row so open+save doesn't split a between-range into two lines.
  return fuseFieldAgeBetween(rules, guardGroups, orGroups);
}

/**
 * Look for adjacent pairs of `field_age` rules that together form a bounded
 * range on the same source/field/unit, and collapse them into one
 * `field_age_between` rule. Two rules are fuseable when:
 *   - both are `field_age` with matching source + field + unit
 *   - one carries a min-side op (`>=` / `>`) and the other a max-side op
 *     (`<=` / `<`) — order doesn't matter
 *   - AND either share the same non-undefined guardGroup (came from a single
 *     `if (A || B) return false`) OR both have undefined guardGroup and are
 *     adjacent in the return-form path (`return A && B`).
 * Runs left-to-right, greedy; any rule that doesn't fuse is left alone.
 */
function fuseFieldAgeBetween(
  rules: AppliesIfRule[],
  guardGroups: Array<number | undefined>,
  orGroups: Array<number | undefined>,
): {
  rules: AppliesIfRule[];
  guardGroups: Array<number | undefined>;
  orGroups: Array<number | undefined>;
} {
  const outRules: AppliesIfRule[] = [];
  const outGroups: Array<number | undefined> = [];
  const outOrGroups: Array<number | undefined> = [];
  const MIN_OPS = new Set(['>=', '>']);
  const MAX_OPS = new Set(['<=', '<']);
  let i = 0;
  while (i < rules.length) {
    const a = rules[i]!;
    const b = rules[i + 1];
    const ga = guardGroups[i];
    const gb = guardGroups[i + 1];
    if (
      a.kind === 'field_age' &&
      b &&
      b.kind === 'field_age' &&
      a.source === b.source &&
      a.field === b.field &&
      a.unit === b.unit &&
      (ga === gb || (ga === undefined && gb === undefined)) &&
      // NEVER fuse OR-joined rules (geriatric §3): a between is an AND
      // range; two OR'd field_age rules ("< 84 OR > 90") are its
      // complement — fusing would silently invert the author's logic.
      orGroups[i] === undefined &&
      orGroups[i + 1] === undefined
    ) {
      const aIsMin = MIN_OPS.has(a.op);
      const bIsMax = MAX_OPS.has(b.op);
      const aIsMax = MAX_OPS.has(a.op);
      const bIsMin = MIN_OPS.has(b.op);
      if (aIsMin && bIsMax) {
        outRules.push({
          kind: 'field_age_between',
          source: a.source,
          field: a.field,
          unit: a.unit,
          min: a.value,
          max: b.value,
          minOp: a.op as '>=' | '>',
          maxOp: b.op as '<=' | '<',
        });
        outGroups.push(ga);
        outOrGroups.push(undefined);
        i += 2;
        continue;
      }
      if (aIsMax && bIsMin) {
        outRules.push({
          kind: 'field_age_between',
          source: a.source,
          field: a.field,
          unit: a.unit,
          min: b.value,
          max: a.value,
          minOp: b.op as '>=' | '>',
          maxOp: a.op as '<=' | '<',
        });
        outGroups.push(ga);
        outOrGroups.push(undefined);
        i += 2;
        continue;
      }
    }
    outRules.push(a);
    outGroups.push(ga);
    outOrGroups.push(orGroups[i]);
    i++;
  }
  return { rules: outRules, guardGroups: outGroups, orGroups: outOrGroups };
}

/** Splits `a || b || c` at top level; honors parens. */
function splitOrOperands(expr: string): string[] {
  return splitAtTopLevel(expr, ['||']);
}
/** Splits `a && b && c` at top level. */
function splitAnd(expr: string): string[] {
  return splitAtTopLevel(expr, ['&&']);
}

function splitAtTopLevel(expr: string, ops: string[]): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (depth === 0) {
      for (const op of ops) {
        if (expr.slice(i, i + op.length) === op) {
          out.push(expr.slice(last, i).trim());
          i += op.length - 1;
          last = i + 1;
          break;
        }
      }
    }
  }
  out.push(expr.slice(last).trim());
  return out.filter(Boolean);
}

/** Classify a single bare expression (no &&/|| at top level). */
function classifySimple(expr: string): AppliesIfRule {
  const e = expr.trim();

  // field_presence — `!!<ref>` (positive: is set) or `!<ref>` (positive:
  // is not set). Checked FIRST (before the leading-`!` strip) so a
  // `!getField(report, 'X')` guard is recognized as field_presence
  // rather than being stripped to `getField(...)` and caught by the
  // helper-fn regex below. `getField(report,'X')` and `contact.contact.X`
  // are the two allowed refs.
  const bangBangReport = /^!!(?:Utils\.)?getField\(\s*report\s*,\s*'([^']+)'\s*\)$/.exec(e);
  if (bangBangReport && bangBangReport[1]) {
    return { kind: 'field_presence', source: 'report', field: bangBangReport[1], negated: false };
  }
  const bangReport = /^!(?:Utils\.)?getField\(\s*report\s*,\s*'([^']+)'\s*\)$/.exec(e);
  if (bangReport && bangReport[1]) {
    return { kind: 'field_presence', source: 'report', field: bangReport[1], negated: true };
  }
  const bangBangContact = /^!!contact\.contact\.([a-zA-Z_$][\w$.]*)$/.exec(e);
  if (bangBangContact && bangBangContact[1]) {
    return { kind: 'field_presence', source: 'contact', field: bangBangContact[1], negated: false };
  }
  const bangContact = /^!contact\.contact\.([a-zA-Z_$][\w$.]*)$/.exec(e);
  if (bangContact && bangContact[1]) {
    return { kind: 'field_presence', source: 'contact', field: bangContact[1], negated: true };
  }

  // report_field_includes — `(Utils.getField(report,'f') || '').split(' ')
  // .includes('v')`, optionally `!`-prefixed. Checked HERE, before the
  // leading-`!` strip, for the same reason field_presence is: after the
  // strip the text starts with `(` and would match nothing, falling to raw.
  //
  // Deliberately strict and fully anchored. Other spellings a human might
  // hand-write — no `|| ''`, `.indexOf(v) >= 0`, double-quoted literals —
  // are NOT accepted here and fall through to raw, where they are
  // preserved verbatim. Canonicalizing them would be a silent rewrite, and
  // `.indexOf` → `.includes` would additionally change the semantics
  // (substring vs whole token).
  const includesMatch =
    /^(!?)\(\s*(?:Utils\.)?getField\(\s*report\s*,\s*'([^']+)'\s*\)\s*\|\|\s*''\s*\)\.split\(' '\)\.includes\('([^']*)'\)$/.exec(
      e,
    );
  if (includesMatch && includesMatch[2] !== undefined && includesMatch[3] !== undefined) {
    return {
      kind: 'report_field_includes',
      field: includesMatch[2],
      value: includesMatch[3],
      negated: includesMatch[1] === '!',
    };
  }

  // Strip leading ! for negation tracking.
  let negated = false;
  let stripped = e;
  if (stripped.startsWith('!')) {
    negated = true;
    stripped = stripped.slice(1).trim();
  }

  // isAlive(...) / isMuted(...) / hasError(...) / isTaskUser(user)
  const fn = /^([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)$/.exec(stripped);
  if (fn && fn[1]) {
    const name = fn[1];
    // Capture the argument text so serialization can hand it back
    // unchanged — see the AppliesIfRule docstring.
    const args = (fn[2] ?? '').trim();
    if (name === 'isTaskUser') return { kind: 'is_task_user', args };
    if (name === 'isAlive') return { kind: 'is_alive', negated, args };
    if (name === 'isMuted') return { kind: 'is_muted', negated, args };
    if (name === 'hasError') return { kind: 'has_error', negated, args };
    return { kind: 'helper', name, args: fn[2] ?? '', negated };
  }

  // contact.contact.X === 'Y'  or  contact.contact.X !== 'Y'
  const contactCmp =
    /^contact\.contact\.([a-zA-Z_$][\w$.]*)\s*(===|!==|==|!=)\s*'([^']*)'$/.exec(stripped);
  if (contactCmp && contactCmp[1] && contactCmp[2] && contactCmp[3] !== undefined) {
    return {
      kind: 'contact_field',
      field: contactCmp[1],
      op: normalizeOp(contactCmp[2]),
      value: contactCmp[3],
    };
  }

  // contact.contact.X OP NUMBER (numeric)
  const contactCmpNum =
    /^contact\.contact\.([a-zA-Z_$][\w$.]*)\s*(>=|<=|===|!==|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(
      stripped,
    );
  if (contactCmpNum && contactCmpNum[1] && contactCmpNum[2] && contactCmpNum[3]) {
    return {
      kind: 'contact_field',
      field: contactCmpNum[1],
      op: normalizeOp(contactCmpNum[2]),
      value: contactCmpNum[3],
    };
  }

  // getField(report, 'X') === 'Y'
  const reportCmp =
    /^(?:Utils\.)?getField\(\s*report\s*,\s*'([^']+)'\s*\)\s*(===|!==|==|!=)\s*'([^']*)'$/.exec(stripped);
  if (reportCmp && reportCmp[1] && reportCmp[2] && reportCmp[3] !== undefined) {
    return {
      kind: 'report_field',
      field: reportCmp[1],
      op: normalizeOp(reportCmp[2]),
      value: reportCmp[3],
    };
  }

  // getField(report, 'X') OP NUMBER (numeric)
  const reportCmpNum =
    /^(?:Utils\.)?getField\(\s*report\s*,\s*'([^']+)'\s*\)\s*(>=|<=|===|!==|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(
      stripped,
    );
  if (reportCmpNum && reportCmpNum[1] && reportCmpNum[2] && reportCmpNum[3]) {
    return {
      kind: 'report_field',
      field: reportCmpNum[1],
      op: normalizeOp(reportCmpNum[2]),
      value: reportCmpNum[3],
    };
  }

  // field_age: (Date.now() - new Date(<ref>).getTime()) / <ms> <op> <n>
  // Matches parenthesized form the serializer emits. `<ref>` is either
  // getField(report, 'X') or contact.contact.X. `<op>` and `<n>` land
  // in the rule verbatim (unit is inferred from <ms>).
  //
  // Regex captures: 1=ref, 2=ms, 3=op, 4=number.
  const ageRe = new RegExp(
    '^\\(Date\\.now\\(\\)\\s*-\\s*new Date\\(' +
      '((?:Utils\\.)?getField\\(\\s*report\\s*,\\s*\'[^\']+\'\\s*\\)|contact\\.contact\\.[a-zA-Z_$][\\w$.]*)' +
      '\\)\\.getTime\\(\\)\\)\\s*/\\s*(\\d+)\\s*' +
      '(>=|<=|===|!==|==|!=|>|<)\\s*' +
      '(-?\\d+(?:\\.\\d+)?)$',
  );
  const ageMatch = ageRe.exec(stripped);
  if (ageMatch && ageMatch[1] && ageMatch[2] && ageMatch[3] && ageMatch[4]) {
    const refRaw = ageMatch[1];
    const ms = Number(ageMatch[2]);
    // Unit inferred from ms. If a project hand-edited the multiplier
    // to something we don't recognize, fall through to raw so the
    // custom value survives round-trip.
    let unit: 'days' | 'weeks' | 'months' | null = null;
    for (const [k, v] of Object.entries(UNIT_MS)) {
      if (v === ms) {
        unit = k as 'days' | 'weeks' | 'months';
        break;
      }
    }
    if (unit) {
      const source: 'contact' | 'report' =
        refRaw.startsWith('getField(') || refRaw.startsWith('Utils.getField(') ? 'report' : 'contact';
      const field =
        source === 'report'
          ? /'([^']+)'/.exec(refRaw)?.[1] ?? ''
          : refRaw.slice('contact.contact.'.length);
      return {
        kind: 'field_age',
        source,
        field,
        unit,
        op: normalizeOp(ageMatch[3]),
        value: Number(ageMatch[4]),
      };
    }
  }

  return { kind: 'raw', text: e };
}

function normalizeOp(op: string): '===' | '!==' | '>' | '<' | '>=' | '<=' {
  if (op === '==' || op === '===') return '===';
  if (op === '!=' || op === '!==') return '!==';
  if (op === '>=') return '>=';
  if (op === '<=') return '<=';
  if (op === '>') return '>';
  return '<';
}

/** Op that inverts the given op for guard-clause rewriting. */
function invertOp(op: '===' | '!==' | '>' | '<' | '>=' | '<='): typeof op {
  switch (op) {
    case '===': return '!==';
    case '!==': return '===';
    case '>': return '<=';
    case '<': return '>=';
    case '>=': return '<';
    case '<=': return '>';
  }
}

/** Render the right-hand side of a field comparison: quote strings, bare numbers. */
function fmtCmpValue(op: '===' | '!==' | '>' | '<' | '>=' | '<=', value: string): string {
  if (op === '===' || op === '!==') return `'${value}'`;
  return value;
}

/**
 * Convert a guard rule (which expressed when to EXIT early) into the
 * positive form (the condition that MUST hold). E.g. guard `!isAlive(x)`
 * becomes "is_alive: not negated".
 */
function invertGuardRule(r: AppliesIfRule): AppliesIfRule {
  switch (r.kind) {
    case 'is_alive':
    case 'is_muted':
    case 'has_error':
    case 'helper':
    case 'field_presence':
    case 'report_field_includes':
      return { ...r, negated: !r.negated };
    case 'contact_field':
    case 'report_field':
    case 'field_age':
      return { ...r, op: invertOp(r.op) };
    case 'field_age_between':
      // Not reached in the parse path — fusion runs AFTER invertGuardRule,
      // so the parser only ever hands single field_age rules to this
      // function. But for exhaustiveness (and safety if a caller builds a
      // ParsedAppliesIf by hand and hands it in), flipping a between rule
      // means "invert the range" — which is a disjunction, not another
      // between. We treat it as identity; the fusion step never feeds this
      // path in practice.
      return r;
    case 'is_task_user':
      // Guards usually check `!isTaskUser(user)` → the rule is "is task user". Negation
      // doesn't apply here; treat presence as the positive requirement.
      return r;
    case 'raw':
      return r;
  }
}

/** Render rules back 
to a JS function body. */
export function serializeAppliesIf(parsed: ParsedAppliesIf): string {
  const lines: string[] = [];
  const params = parsed.params.join(', ');
  lines.push(`function (${params}) {`);

  // Group adjacent rules that share a non-undefined guardGroup id back into
  // a single `if (A || B || ...) return false` so original sources don't
  // diff just from open+save. OR groups (geriatric §3) take precedence:
  // adjacent rules sharing an orGroup id emit ONE `if (!A && !B) { return
  // false; }` guard — ¬(A ∨ B) — which the parser lifts back into the
  // same OR group, so authoring round-trips by construction.
  const groups: Array<{
    groupId: number | undefined;
    orId: number | undefined;
    rules: AppliesIfRule[];
  }> = [];
  parsed.rules.forEach((rule, idx) => {
    const gid = parsed.guardGroups?.[idx];
    const oid = parsed.orGroups?.[idx];
    const last = groups[groups.length - 1];
    if (oid !== undefined && last && last.orId === oid) {
      last.rules.push(rule);
    } else if (
      oid === undefined &&
      gid !== undefined &&
      last &&
      last.orId === undefined &&
      last.groupId === gid
    ) {
      last.rules.push(rule);
    } else {
      groups.push({ groupId: gid, orId: oid, rules: [rule] });
    }
  });

  // Raw rules carry their polarity in `fromGuard` (P0-1, re-audit
  // 2026-08-05 — inferring it from `guardGroups === undefined` inverted
  // solo raw guards): guard-origin raws re-emit in guard position with
  // unchanged text; POSITIVE raws (return conjuncts, whole-body fallback,
  // UI "+ raw JS" rows) re-emit as body/return content — never as a
  // guard, which would both invert their meaning and produce invalid JS
  // for statement-shaped text (`if (return true;) …`).
  const bodyRaws: string[] = [];
  const exprRaws: string[] = [];
  const STATEMENT_RE = /(^|[^\w$])return\b|;/;
  // P0-2 — operands joined into a compound guard must parenthesize any
  // operand carrying the OTHER operator at top level, or precedence
  // silently rewrites the logic (`X < 84 || X > 90 && …`). Operands
  // without mixed precedence stay unwrapped so existing sources remain
  // byte-stable on no-op open+save.
  const parenFor = (g: string, join: '&&' | '||'): string => {
    const other = join === '&&' ? splitOrOperands(g) : splitAnd(g);
    return other.length > 1 ? `(${g})` : g;
  };

  for (const group of groups) {
    if (group.orId === undefined && group.groupId === undefined) {
      for (const rule of group.rules) {
        if (rule.kind === 'raw' && !rule.fromGuard) {
          const t = rule.text.trim();
          if (t === '') continue;
          // Statement-shaped raw (whole-body fallback, hand-typed
          // `return …;`) is re-emitted verbatim as body; a bare
          // expression joins the final positive return.
          if (STATEMENT_RE.test(t)) bodyRaws.push(t);
          else exprRaws.push(t);
          continue;
        }
        const g = ruleToGuardSource(rule, parsed.params);
        if (g) lines.push(`  if (${g}) { return false; }`);
      }
      continue;
    }
    const guards = group.rules
      .map((r) => ruleToGuardSource(r, parsed.params))
      .filter((g): g is string => Boolean(g));
    if (guards.length === 0) continue;
    if (group.orId !== undefined && guards.length > 1) {
      lines.push(`  if (${guards.map((g) => parenFor(g, '&&')).join(' && ')}) { return false; }`);
    } else if (group.groupId !== undefined && guards.length > 1) {
      lines.push(`  if (${guards.map((g) => parenFor(g, '||')).join(' || ')}) { return false; }`);
    } else {
      for (const guard of guards) {
        lines.push(`  if (${guard}) { return false; }`);
      }
    }
  }

  for (const b of bodyRaws) {
    for (const line of b.split('\n')) lines.push(`  ${line.trim() === '' ? '' : line.trim()}`);
  }
  if (exprRaws.length > 0) {
    lines.push(`  return ${exprRaws.join(' && ')};`);
  } else if (!bodyRaws.some((b) => /(^|[^\w$])return\b/.test(b))) {
    lines.push('  return true;');
  }
  lines.push('}');
  return lines.join('\n');
}

/**
 * What to pass a standard helper when the UI built the rule and there is no
 * authored text to preserve. DERIVED from the body's own signature rather
 * than hardcoded: `appliesIf(contact, report)` gets `isAlive(contact)` /
 * `hasError(report)`, and a project whose params are `(c, r)` gets
 * `isAlive(c)` — which is what every real config except gandaki writes, and
 * is right by construction rather than by coincidence.
 *
 * `isTaskUser` is the exception: `user` is a rules-engine global, not a
 * parameter, so there is nothing to derive it from. All five real
 * occurrences spell it `user`.
 */
function defaultHelperArgs(kind: string, params: readonly string[]): string {
  switch (kind) {
    case 'has_error':
      return params[1] ?? 'report';
    case 'is_task_user':
      return 'user';
    default:
      return params[0] ?? 'contact';
  }
}

/** The author's own argument text, or a signature-derived default. */
function helperArgs(
  rule: { kind: string; args?: string },
  params: readonly string[],
): string {
  const authored = rule.args?.trim();
  return authored ? authored : defaultHelperArgs(rule.kind, params);
}

function ruleToGuardSource(rule: AppliesIfRule, params: readonly string[]): string | null {
  switch (rule.kind) {
    case 'is_task_user':
      return `!isTaskUser(${helperArgs(rule, params)})`;
    case 'is_alive': {
      const a = helperArgs(rule, params);
      return rule.negated ? `isAlive(${a})` : `!isAlive(${a})`;
    }
    case 'is_muted': {
      // Rule shape: `negated=true` means the positive requirement is "NOT muted".
      // The guard inverts that: exit if muted, i.e. `isMuted(...)`.
      const a = helperArgs(rule, params);
      return rule.negated ? `isMuted(${a})` : `!isMuted(${a})`;
    }
    case 'has_error': {
      // Same shape as is_muted — guard exits when the error IS present.
      const a = helperArgs(rule, params);
      return rule.negated ? `hasError(${a})` : `!hasError(${a})`;
    }
    case 'helper':
      // Guard form is the INVERSE of the positive rule, same as is_alive:
      // positive "helper must hold" (negated=false) → exit when it
      // doesn't → `!helper(...)`. The previous mapping emitted the
      // positive form here, so a `if (!isActivePregnancy(...)) return
      // false` guard round-tripped to `if (isActivePregnancy(...))` —
      // silently inverting the task on a no-op open+save (found by the
      // geriatric §3 serializer work, 2026-08-05).
      return rule.negated ? `${rule.name}(${rule.args})` : `!${rule.name}(${rule.args})`;
    case 'contact_field': {
      const cmp = invertOp(rule.op);
      return `contact.contact.${rule.field} ${cmp} ${fmtCmpValue(cmp, rule.value)}`;
    }
    case 'report_field': {
      const cmp = invertOp(rule.op);
      return `Utils.getField(report, '${rule.field}') ${cmp} ${fmtCmpValue(cmp, rule.value)}`;
    }
    case 'report_field_includes': {
      // Same polarity convention as field_presence below: the guard is the
      // INVERSE of the positive rule. negated=false ("must include") →
      // exit when it does NOT include → leading `!`. Getting this backwards
      // is the silent-inversion failure mode that bit the helper case, so
      // both directions are pinned by serializer-exercising tests.
      //
      // No extra parens needed around the `!`: member access and calls bind
      // tighter than unary `!`, so `!(A || '').split(' ').includes('v')`
      // parses as `!((( A || '').split(' ')).includes('v'))`.
      const expr = `(Utils.getField(report, '${rule.field}') || '').split(' ').includes('${rule.value}')`;
      return rule.negated ? expr : `!${expr}`;
    }
    case 'field_presence': {
      // Positive rule = "field IS set" (negated=false) or "NOT set"
      // (negated=true). Guard is the opposite: exit when the positive
      // condition FAILS. So negated=false → guard exits on "!<ref>";
      // negated=true → guard exits on "!!<ref>" (truthy).
      const ref =
        rule.source === 'report'
          ? `Utils.getField(report, '${rule.field}')`
          : `contact.contact.${rule.field}`;
      return rule.negated ? `!!${ref}` : `!${ref}`;
    }
    case 'field_age': {
      const ref =
        rule.source === 'report'
          ? `Utils.getField(report, '${rule.field}')`
          : `contact.contact.${rule.field}`;
      const ms = UNIT_MS[rule.unit];
      const cmp = invertOp(rule.op);
      return `(Date.now() - new Date(${ref}).getTime()) / ${ms} ${cmp} ${rule.value}`;
    }
    case 'field_age_between': {
      // Positive rule: min minOp age maxOp max (e.g. "84 ≤ age ≤ 90").
      // Guard = inverted disjunction: "age < min OR age > max" — but with
      // strictness flipped to match the endpoint's exclusivity.
      //   minOp >= → guard side: age < min      (invertOp on >=)
      //   minOp >  → guard side: age <= min     (invertOp on >)
      //   maxOp <= → guard side: age > max      (invertOp on <=)
      //   maxOp <  → guard side: age >= max     (invertOp on <)
      const ref =
        rule.source === 'report'
          ? `Utils.getField(report, '${rule.field}')`
          : `contact.contact.${rule.field}`;
      const ms = UNIT_MS[rule.unit];
      const ageExpr = `(Date.now() - new Date(${ref}).getTime()) / ${ms}`;
      const minGuardOp = invertOp(rule.minOp);
      const maxGuardOp = invertOp(rule.maxOp);
      return `${ageExpr} ${minGuardOp} ${rule.min} || ${ageExpr} ${maxGuardOp} ${rule.max}`;
    }
    case 'raw':
      return rule.text || null;
  }
}
