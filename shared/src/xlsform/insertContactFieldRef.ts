/**
 * Wave 2 · §5b helper — auto-create the hidden harvest `calculate` row for a
 * contact-form field the user just picked from a label's "insert contact
 * field" affordance.
 *
 * The idiom this codifies is the canonical CHT harvest pattern:
 *
 *   calculate  patient_name       calculation = ../inputs/contact/name
 *
 * i.e. a hidden `calculate` row named `patient_<field>` (or the field name
 * itself if it already carries the `patient_` prefix) whose `calculation`
 * cell reads `../inputs/contact/<field>`. The row is placed at the top
 * level of the survey **immediately after the outermost `end group inputs`**
 * — the placement cht-conf's own `pregnancy.xlsx` scaffold uses. Placing
 * the calc INSIDE `inputs/contact` would break the `../inputs/contact/...`
 * xpath (the `..` step would exit past `inputs`, so the ref no longer
 * resolves), so we deliberately keep the row outside the `inputs` block.
 *
 * The design note (docs/handoff-waves-1-3-2026-07-29.md §5) uses the
 * phrase "inside the `inputs/contact` group" as shorthand for "in the
 * inputs plumbing area"; the deployable xpath semantics force placement
 * as an `inputs` sibling.
 *
 * ## The half that was missing (P1-DEPLOY)
 *
 * This helper used to write ONLY the reference. The scaffold declares
 * exactly `_id` and `patient_id` under `inputs/contact`, each with its
 * matching calculate — which is why those two resolved and nothing else
 * did. Picking any other contact field emitted `../inputs/contact/<field>`
 * pointing at a node no form declared, and `validate-app-forms` fails the
 * ENTIRE run, so one bad reference in one form blocked every form and the
 * app settings from deploying:
 *
 *   ERROR  …_form_for_elder_population.xml contains invalid XPath:
 *          calculate for /data/patient_name contains [../inputs/contact/name]
 *   ERROR  One or more forms have failed validation.
 *
 * The invariant, in QA's framing: **the scaffold writes declaration and
 * reference as MATCHED PAIRS.** Measured over the four real configs' app
 * forms, every single `../inputs/*` reference is declared — zero exceptions
 * — so real configs hold that invariant and the tool was the only thing
 * that didn't. `contact/name` alone is declared in 60 forms and referenced
 * in 68.
 *
 * The trap that probably explains how it shipped: the scaffold DOES contain
 * a `name` row, but under `inputs/user/name` — the logged-in user's
 * username, a different group entirely. Anyone glancing at the scaffold
 * sees `name` and reasonably concludes it is declared. It wasn't, for
 * contacts.
 *
 * So: `name` now ships in the scaffold, and anything outside that set is
 * declared on demand here, in the SAME returned form so one gesture stays
 * one undo.
 *
 * Contract:
 *   - **Declares what it references.** A hidden row for `<field>` is added
 *     under `inputs/contact` when it isn't there already. When it cannot be
 *     (no such group, or a nested path), `undeclarableReason` says so
 *     instead of quietly emitting a reference that will dangle.
 *   - **Deduped by calculation cell.** If any existing `calculate` row
 *     already carries `../inputs/contact/<field>`, we reuse its `name` and
 *     do NOT insert a duplicate row. Re-picking the same contact field on a
 *     form that is already correct returns the SAME form instance, so
 *     callers can still fast-path on `result.form === form` — it now means
 *     "nothing needed doing". A form whose calc exists but whose
 *     declaration does not gets the declaration added, and so returns a new
 *     instance: that is the repair path for forms the tool broke earlier.
 *   - **Name-collision-safe.** If the derived name (`patient_<field>`) is
 *     already used by a DIFFERENT row (a pre-existing row named
 *     `patient_name` that harvests something else, or a user-authored
 *     question with the same name), we suffix `_2`, `_3`, … until a free
 *     name is found. The label token spliced into the label always uses
 *     the freshly-picked harvest name so the ref stays in lockstep.
 *   - **Pure.** The input form is not mutated. All array/object writes go
 *     into fresh copies.
 *
 * This helper does NOT touch label text — the caller is responsible for
 * splicing `${harvestName}` at the caret in the label the user is editing.
 * Keeping the two operations in a single caller-side `patch()` gives
 * atomic undo for "user clicked insert contact field" (both the calc row
 * and the label mutation land or roll back together).
 */
import type { SurveyRow, XLSForm } from './types.js';

/** Result of {@link insertContactFieldRef}. */
export interface InsertContactFieldRefResult {
  /** The updated form. Referentially equal to the input only when there was
   *  NOTHING to do — the calc row existed AND the input was already
   *  declared. Callers may still fast-path on identity; it now means "no
   *  change", which is what they actually wanted it to mean. */
  form: XLSForm;
  /** The name of the harvest calc row — either the freshly-created one or
   *  the pre-existing dedup target. This is the `name` the caller should
   *  splice into the label as `${<harvestName>}`. Empty string if the
   *  input `contactField` was blank / whitespace-only. */
  harvestName: string;
  /** `true` iff a new calc row was inserted; `false` if the dedupe path
   *  reused an existing row. Useful for toasts / analytics. */
  wasCreated: boolean;
  /** `true` iff the derived default name (`patient_<field>`) collided with
   *  a pre-existing row that was NOT a dedupe target, and the helper had
   *  to fall back to a numeric suffix. The caller can surface this as a
   *  soft warning ("saved as `patient_name_2`"). */
  hadNameCollision: boolean;
  /**
   * `true` iff a hidden DECLARATION row was added under `inputs/contact`
   * because the field wasn't declared there yet. This is the half that was
   * missing and made the emitted form undeployable — see the module doc.
   *
   * Note this also fires on a form whose harvest calc already exists but
   * whose declaration does not, i.e. a form the tool previously broke: the
   * insert repairs it. That is the one case where the dedupe path returns a
   * NEW form object rather than the input, so the referential-equality
   * fast-path means "nothing needed doing", not merely "the calc existed".
   */
  declaredInput: boolean;
  /**
   * `null` when the emitted reference is guaranteed to resolve. Otherwise a
   * plain sentence saying why the declaration could not be written, for the
   * caller to surface.
   *
   * We do NOT silently emit a reference we know will dangle — that is how
   * this shipped in the first place — but neither do we invent an `inputs`
   * or `contact` group in a form that has none, because the group carries
   * runtime meaning (`_id` with `appearance: select-contact` is what makes
   * CHT populate the block) and guessing at it would be a bigger
   * fabrication than declining. The preflight dangling-ref rule catches the
   * same case, so the author is told either way.
   */
  undeclarableReason: string | null;
}

/**
 * Derive the harvest calc row's `name` from the contact-form field name.
 *
 * The convention (grounded on `pregnancy.xlsx` and the diabetes-referral
 * fixture) is `patient_<field>`, with two micro-adjustments:
 *   - If the field already starts with `patient_`, use it verbatim
 *     (`patient_id` → `patient_id`, not `patient_patient_id`).
 *   - Strip leading underscores from otherwise-bare fields so `_id`
 *     doesn't become the ugly `patient__id`. Note this collapses `_id`
 *     onto `patient_id`; the caller's collision-guard suffixes if the
 *     underscored variant is already used elsewhere.
 */
export function deriveHarvestName(contactField: string): string {
  const f = contactField.trim();
  if (!f) return '';
  if (/^patient_/.test(f)) return f;
  const cleaned = f.replace(/^_+/, '');
  return `patient_${cleaned}`;
}

/**
 * Locate the survey index directly after the outermost `end group inputs`.
 * Returns `-1` if the survey has no top-level `inputs` block — in which
 * case the caller falls back to appending at the end of the survey.
 *
 * Only the outermost `inputs` group counts. A nested `inputs` inside some
 * other group is not the CHT plumbing block and would break the pattern.
 */
function findInsertAfterInputsEnd(survey: SurveyRow[]): number {
  const stack: string[] = [];
  for (let i = 0; i < survey.length; i++) {
    const r = survey[i]!;
    const t = r.type.trim().toLowerCase();
    if (t === 'begin group' || t === 'begin repeat') {
      stack.push(r.name);
      continue;
    }
    if (t === 'end group' || t === 'end repeat') {
      const closed = stack.pop();
      // Top-level `inputs` closing → insertion point is right after it.
      if (closed === 'inputs' && stack.length === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

/**
 * Locate the `contact` group nested directly inside the outermost `inputs`
 * group, returning the index of its `end group` row — the point a new
 * declaration is spliced in front of.
 *
 * Returns `-1` when there is no such group. Only the outermost `inputs` is
 * considered, and only a `contact` group at its top level; a `contact` group
 * somewhere else in the survey is not the CHT plumbing block and writing
 * into it would not make `../inputs/contact/<field>` resolve.
 */
function findInputsContactEnd(survey: SurveyRow[]): number {
  const stack: string[] = [];
  for (let i = 0; i < survey.length; i++) {
    const r = survey[i]!;
    const t = r.type.trim().toLowerCase();
    if (t === 'begin group' || t === 'begin repeat') {
      stack.push(r.name);
      continue;
    }
    if (t === 'end group' || t === 'end repeat') {
      const closed = stack.pop();
      // `contact` closing while `inputs` is the only thing still open.
      if (closed === 'contact' && stack.length === 1 && stack[0] === 'inputs') {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Is `field` already declared as a row inside `inputs/contact`?
 *
 * SCOPED on purpose. A survey-wide name check would answer the wrong
 * question in both directions: a top-level question named `name` does not
 * make `../inputs/contact/name` resolve, and the scaffold legitimately
 * carries `patient_id` twice — once as the declared input and once as the
 * top-level harvest calc — which a global check would read as a collision.
 */
function isDeclaredInInputsContact(survey: SurveyRow[], field: string): boolean {
  const stack: string[] = [];
  for (const r of survey) {
    const t = r.type.trim().toLowerCase();
    if (t === 'begin group' || t === 'begin repeat') {
      stack.push(r.name);
      continue;
    }
    if (t === 'end group' || t === 'end repeat') {
      stack.pop();
      continue;
    }
    if (stack.length === 2 && stack[0] === 'inputs' && stack[1] === 'contact' && r.name === field) {
      return true;
    }
  }
  return false;
}

/**
 * Ensure the harvest `calculate` row for `contactField` exists in `form`
 * and return the name to splice into the caller's label.
 *
 * See module doc for the full contract.
 */
export function insertContactFieldRef(
  form: XLSForm,
  contactField: string,
): InsertContactFieldRefResult {
  const field = contactField.trim();
  if (!field) {
    return {
      form,
      harvestName: '',
      wasCreated: false,
      hadNameCollision: false,
      declaredInput: false,
      undeclarableReason: null,
    };
  }

  const targetCalc = `../inputs/contact/${field}`;

  /* ---- the declaration half: make sure `../inputs/contact/<field>` exists.
   *
   * This runs BEFORE the calc work so both halves land in the one returned
   * form, which is what gives the caller atomic undo for a single "insert
   * contact field" gesture.
   */
  let working = form;
  let declaredInput = false;
  let undeclarableReason: string | null = null;

  if (!isDeclaredInInputsContact(form.survey, field)) {
    if (field.includes('/')) {
      // A nested path like `parent/_id`. Real configs do declare these
      // (`contact/parent/_id` appears in 16 forms), but placing one means
      // synthesising the intermediate groups, and the pickers only ever
      // offer flat field names — so refuse loudly rather than guess.
      undeclarableReason =
        `"${field}" is a nested path. Declare it under inputs/contact yourself, ` +
        `or the reference will not resolve.`;
    } else {
      const endIdx = findInputsContactEnd(form.survey);
      if (endIdx < 0) {
        undeclarableReason =
          'This form has no inputs/contact group, so the contact field cannot be ' +
          'declared. Add the standard inputs block first, or the reference will ' +
          'not resolve.';
      } else {
        // Empty per-locale labels, matching the harvest calc below: a hidden
        // plumbing row has no user-facing text, and inventing an English
        // label would push a token the project never wrote into a config
        // that may not be in English.
        const labels: Record<string, string> = {};
        for (const loc of form.surveyHeaders.labelLocales) labels[loc] = '';
        if (Object.keys(labels).length === 0) labels['en'] = '';

        const declRow: SurveyRow = {
          rowId: `input_contact_${field}_${form.survey.length + 1}`,
          type: 'hidden',
          name: field,
          labels,
          extras: {},
        };
        working = {
          ...form,
          survey: [
            ...form.survey.slice(0, endIdx),
            declRow,
            ...form.survey.slice(endIdx),
          ],
        };
        declaredInput = true;
      }
    }
  }
  // From here on, `working` is the form under construction — the parameter
  // is left alone so the "pure, never mutates the input" contract is
  // obvious at a glance.

  // Dedup by calc cell: if any existing calculate row carries this exact
  // reference, reuse it — no new row and no name change. Note this returns
  // `working`, not the input: a form whose calc exists but whose
  // declaration did not still gets repaired here.
  for (const r of working.survey) {
    if (r.type.trim().toLowerCase() !== 'calculate') continue;
    const c = (r.extras['calculation'] ?? '').trim();
    if (c === targetCalc) {
      return {
        form: working,
        harvestName: r.name,
        wasCreated: false,
        hadNameCollision: false,
        declaredInput,
        undeclarableReason,
      };
    }
  }

  // Choose a name. Prefer `patient_<field>`; suffix if that's already
  // used by a row that is NOT our dedupe target (we already ruled that
  // out above).
  const defaultName = deriveHarvestName(field);
  // Survey-wide for the HARVEST name, which is a top-level row and so
  // really does share one namespace with every other top-level question.
  // (The declaration check above is scoped instead — different question.)
  const usedNames = new Set<string>();
  for (const r of working.survey) {
    if (r.name) usedNames.add(r.name);
  }
  let harvestName = defaultName;
  let hadNameCollision = false;
  if (usedNames.has(defaultName)) {
    hadNameCollision = true;
    // Numeric-suffix loop mirrors deriveFormName's collision resolution.
    // Bounded to keep static analysis happy — hitting 99 collisions on a
    // single field name is not a realistic scenario.
    let picked = false;
    for (let i = 2; i < 100; i++) {
      const candidate = `${defaultName}_${i}`;
      if (!usedNames.has(candidate)) {
        harvestName = candidate;
        picked = true;
        break;
      }
    }
    if (!picked) {
      // Extreme fallback — nothing was free within the bounded loop.
      // Use a timestamp-tagged name so the insert still succeeds; the
      // caller's label splice keeps the ref in lockstep.
      harvestName = `${defaultName}_${Date.now()}`;
    }
  }

  // Seed the label map with an empty string per active locale so the row
  // stays visible in the translator's grid (Wave 2 §4 pattern for new
  // rows). The harvest calc has no user-facing label, but an empty per-
  // locale cell keeps the missing-glyph logic uniform.
  const labels: Record<string, string> = {};
  for (const loc of working.surveyHeaders.labelLocales) {
    labels[loc] = '';
  }
  // If the form has no locales configured yet (edge — new blank form),
  // still emit an `en` slot so the label map is well-formed.
  if (Object.keys(labels).length === 0) labels['en'] = '';

  const newRow: SurveyRow = {
    // Deterministic-enough rowId; the parser regenerates rowIds anyway
    // (they aren't persisted to xlsx), so uniqueness within the session
    // is all that's needed.
    rowId: `harvest_${harvestName}_${working.survey.length + 1}`,
    type: 'calculate',
    name: harvestName,
    labels,
    extras: { calculation: targetCalc },
  };

  // Placement — right after the outermost `end group inputs`. If there's
  // no `inputs` block at all, append at the end (the caller's form is
  // unusual, but we still produce a syntactically valid survey).
  let insertAt = findInsertAfterInputsEnd(working.survey);
  if (insertAt < 0) insertAt = working.survey.length;

  const nextSurvey = [
    ...working.survey.slice(0, insertAt),
    newRow,
    ...working.survey.slice(insertAt),
  ];

  return {
    form: { ...working, survey: nextSurvey },
    harvestName,
    wasCreated: true,
    hadNameCollision,
    declaredInput,
    undeclarableReason,
  };
}
