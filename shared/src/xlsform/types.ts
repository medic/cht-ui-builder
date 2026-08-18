/**
 * XLSForm domain types.
 *
 * Phase 0 only edits a small subset of XLSForm columns. Everything else is
 * preserved verbatim through the `extras` map on each row, so we never lose
 * CHT-specific columns like `appearance`, `instance::tag`, `db-object`, etc.
 */

/** A label cell, indexed by locale (the `xx` in `label::xx`). */
export type LocaleMap = Record<string, string>;

/**
 * A row in the `survey` sheet.
 *
 * Known fields are typed; everything else (including columns added by CHT
 * extensions or future XLSForm versions) lives in `extras`.
 */
export interface SurveyRow {
  /** Stable row identifier assigned by the parser. Not persisted to the xlsx. */
  rowId: string;
  type: string;
  name: string;
  /** label::xx columns, indexed by locale code. */
  labels: LocaleMap;
  /** required column (truthy string in xlsform: "yes" / "true" / a calculation). */
  required?: string;
  /**
   * Any columns the parser did not interpret. Keys are the original header
   * strings (e.g., "relevant", "appearance", "instance::tag", "calculation").
   * Saved back verbatim.
   */
  extras: Record<string, string>;
}

/** A row in the `choices` sheet. */
export interface ChoiceRow {
  rowId: string;
  list_name: string;
  name: string;
  labels: LocaleMap;
  /** Preserves other columns like filter-category, image, etc. */
  extras: Record<string, string>;
}

/** The single-row `settings` sheet. */
export interface FormSettings {
  form_title?: string;
  form_id?: string;
  version?: string;
  default_language?: string;
  /** Anything else (style, path, instance_name, sms_keyword, etc.). */
  extras: Record<string, string>;
}

/**
 * Any sheet we don't recognize is preserved as raw cell data so we can
 * write it back unchanged on save (e.g., gandaki's `choices-backup`).
 */
export interface RawSheet {
  name: string;
  /** Original header order, including blanks. */
  headers: (string | null)[];
  /** Rows including the header row at index 0. Cells preserved as strings. */
  rows: (string | null)[][];
}

/**
 * In-memory representation of one XLSForm file.
 *
 * Round-trip invariant: parse(serialize(parse(xlsx))) === parse(xlsx) for
 * any xlsx the editor doesn't modify.
 */
export interface XLSForm {
  /** Locales discovered across all sheets (e.g. ["en", "ne"]). */
  locales: string[];
  /** Headers of the survey sheet, in original order, with unknown headers preserved. */
  surveyHeaders: SurveyHeaderInfo;
  /** Headers of the choices sheet. */
  choicesHeaders: ChoicesHeaderInfo;
  survey: SurveyRow[];
  choices: ChoiceRow[];
  settings: FormSettings;
  /** Any sheet other than survey/choices/settings. Preserved verbatim. */
  extraSheets: RawSheet[];
}

/**
 * Records the original header layout of the survey sheet so we can write
 * back in the same column order on save.
 */
export interface SurveyHeaderInfo {
  /** Headers in original order. */
  ordered: string[];
  /** Locales for which label columns exist, in original order. */
  labelLocales: string[];
}

export interface ChoicesHeaderInfo {
  ordered: string[];
  labelLocales: string[];
}

/**
 * Recognizes a `select_one X` / `select_multiple X` row's type cell and
 * captures the list-name in group 2. Single source of truth — the condition
 * builder's `buildFieldChoices` re-uses this so there is no duplicate regex.
 */
export const SELECT_TYPE_RE = /^(select_one|select_multiple)\s+(\S+)/i;

/** Question types we treat as "real" (vs grouping/structural rows). */
export const QUESTION_TYPES = [
  'text',
  'string',
  'integer',
  'decimal',
  'date',
  'time',
  'dateTime',
  'select_one',
  'select_multiple',
  'calculate',
  'hidden',
  'note',
  'image',
  'audio',
  'video',
  'geopoint',
  'barcode',
] as const;

/** Structural rows that don't take user input but define form structure. */
export const STRUCTURAL_TYPES = ['begin group', 'end group', 'begin repeat', 'end repeat'] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];
export type StructuralType = (typeof STRUCTURAL_TYPES)[number];

/**
 * Canonicalise a structural type cell, tolerating the UNDERSCORE spelling.
 *
 * pyxform accepts `begin_group` / `end_group` / `begin_repeat` / `end_repeat`
 * as well as the space-separated forms, and real configs use both. Measured
 * across the four real configs plus the cht-default template, over every
 * form in `forms/app` and `forms/contact`:
 *
 *   993  begin group        61  begin_group
 *   969  end group          85  end_group
 *    17  begin repeat        3  begin_repeat
 *    16  end repeat          4  end_repeat
 *
 * 29 real forms carry an underscore spelling, almost all of them NSSD app
 * forms. Treating those rows as non-structural makes every group-nesting walk
 * silently wrong on exactly the config this tool is aimed at: the stack never
 * pops, so paths computed from it are garbage in both directions.
 *
 * Returns the space-separated canonical form, or the trimmed lowercase input
 * unchanged when it is not a structural marker.
 */
export function canonicalStructuralType(type: string): string {
  const t = type.trim().toLowerCase();
  const m = /^(begin|end)[ _](group|repeat)$/.exec(t);
  return m ? `${m[1]} ${m[2]}` : t;
}

/**
 * The structural role of a row, for code that walks group nesting.
 * `null` for anything that is not a begin/end marker.
 *
 * Prefer this over comparing `row.type` to `'begin group'` — that misses the
 * underscore spelling, which 29 real forms use. See
 * {@link canonicalStructuralType}.
 */
export function structuralKind(
  row: SurveyRow,
): { edge: 'begin' | 'end'; of: 'group' | 'repeat' } | null {
  const t = canonicalStructuralType(row.type);
  const m = /^(begin|end) (group|repeat)$/.exec(t);
  if (!m) return null;
  return { edge: m[1] as 'begin' | 'end', of: m[2] as 'group' | 'repeat' };
}

/** True if the row's type is a structural marker (begin/end group/repeat). */
export function isStructural(row: SurveyRow): boolean {
  return (STRUCTURAL_TYPES as readonly string[]).includes(
    canonicalStructuralType(row.type),
  );
}

/**
 * Types that carry user-facing content a content editor / translator might
 * want to edit even in "Simple mode": question fields plus notes. Calculates
 * and hidden rows are intentionally excluded — they're plumbing.
 */
const SIMPLE_MODE_VISIBLE_TYPES = new Set<string>([
  'text',
  'string',
  'integer',
  'decimal',
  'date',
  'time',
  'datetime',
  'select_one',
  'select_multiple',
  'note',
  'image',
  'audio',
  'video',
  'geopoint',
  'barcode',
]);

/**
 * True if the row should be hidden from the editor when the user has
 * selected "Simple" mode. This is a UI-only filter; the underlying
 * form.survey array is never mutated.
 *
 * Type-only check — does not know which group the row lives in. Prefer
 * {@link computeSimpleHiddenRowIds} when the survey is available, because
 * it can also classify by position (everything inside CHT's `inputs/`
 * block is plumbing regardless of type).
 *
 * NOTE: every `calculate` is hidden here, by design — this predicate
 * answers "is this a question a clinician ANSWERS?", which is what the
 * FHIR workbench's mappable-row denominator needs (`fhir/coverage.ts`).
 * The form editor asks a different question — "does the AUTHOR need to
 * see this row?" — and a calculate the author wrote is emphatically yes.
 * That's {@link computeAuthoringHiddenRowIds}.
 */
export function isHiddenInSimpleMode(row: SurveyRow): boolean {
  const t = row.type.trim().toLowerCase();
  if ((STRUCTURAL_TYPES as readonly string[]).includes(canonicalStructuralType(t))) return true;
  // select_one / select_multiple carry a list name in the type cell
  // (e.g. "select_one sex_options"), so match the visible-type set on the
  // base token — otherwise every select question is wrongly hidden in
  // Simple mode. Single-token types (text, integer, note…) are unaffected.
  const baseType = t.split(/\s+/)[0] ?? t;
  return !SIMPLE_MODE_VISIBLE_TYPES.has(baseType);
}

/** CHT context-injection group name. Calculates inside it are plumbing
 *  (they pull `contact.*` / `user.*` data and never carry a clinician's
 *  answer), so Simple mode hides them while keeping other calculates —
 *  which usually feed reports / tasks / contact-summary — visible. */
const CHT_INPUTS_GROUP = 'inputs';

/**
 * Group-aware version of {@link isHiddenInSimpleMode}. Returns the set of
 * `rowId`s that should be hidden in Simple mode for this survey.
 *
 * **Inside the CHT `inputs/` group, EVERY row is plumbing** — regardless
 * of type. The Part-B scaffold seeds a `string _id` inside
 * `inputs/contact` (the CHT patient-selector pattern); under the
 * pre-fix rule that string row leaked into Simple, making a brand-new
 * Default app form open as a single cryptic `_id` row labeled "Patient
 * ID" — Bhishan's signature cold-start abandonment trigger
 * (docs/plans/shipped-batch-triad-punchlist.md §B1). Treat any row
 * descended from `inputs/` as hidden in Simple, so a fresh Default form
 * opens genuinely empty and the user sees the "your form is ready"
 * empty state.
 *
 * Every other "plumbing" classification from {@link isHiddenInSimpleMode}
 * (structural, hidden, start/end/today, etc.) is applied unchanged.
 */
export function computeSimpleHiddenRowIds(survey: SurveyRow[]): Set<string> {
  const hidden = new Set<string>();
  const groupStack: string[] = [];
  for (const row of survey) {
    const t = row.type.trim().toLowerCase();

    // Pop before classifying an end marker, so rows after a closed group
    // no longer see it on the stack.
    if (t === 'end group' || t === 'end repeat') {
      groupStack.pop();
    }

    const insideInputs = groupStack.some((g) => g.toLowerCase() === CHT_INPUTS_GROUP);
    if (insideInputs) {
      // Every row inside `inputs/` is plumbing — Part-B scaffold seeds a
      // `string _id` there for the patient-selector pattern, which
      // pre-fix leaked into Simple mode. See §B1.
      hidden.add(row.rowId);
    } else if (isHiddenInSimpleMode(row)) {
      hidden.add(row.rowId);
    }

    // Push after classifying, so a `begin group inputs` row is not itself
    // considered "inside inputs" (it's structural and hidden anyway, but
    // this keeps the stack semantics clean).
    if (t === 'begin group' || t === 'begin repeat') {
      groupStack.push(row.name);
    }
  }
  return hidden;
}

/**
 * True when a `calculate` row exists only to re-export a value out of the
 * CHT `inputs/` block — i.e. its calculation is a bare path reference such
 * as `../inputs/contact/_id`. The Default app scaffold seeds four of these
 * (`patient_uuid`, `patient_id`, `created_by`, `created_by_person_uuid`)
 * at depth 0, OUTSIDE `inputs/`, and the lineage block generates more.
 * They are plumbing wherever they sit.
 *
 * Deliberately narrow: only a single unbroken path token counts. Anything
 * with an operator, function call, quote or `${…}` — `instance('contact-
 * summary')/context/bmi`, `${weight} div (${height} * ${height})` — is
 * author-written content, not plumbing. An EMPTY calculation (a row the
 * author just added and hasn't filled in) is also not plumbing, which is
 * what makes the Calculate tile usable in Simple mode.
 */
/**
 * Row ids that live INSIDE the outermost `inputs` group.
 *
 * These are never valid `${…}` targets. pyxform resolves `${x}` by name across
 * the whole survey, and the inputs block deliberately reuses names that also
 * appear outside it — the standard scaffold declares `inputs/user/name` AND
 * `inputs/contact/name`, and `inputs/contact/patient_id` alongside a top-level
 * calculate called `patient_id`. Offering those as pickable field references
 * produced `${name}` / `${patient_id}`, which pyxform refuses outright:
 *
 *   There has been a problem trying to replace ${name} with the XPath to the
 *   survey element named 'name'. There are multiple survey elements with this
 *   name.
 *
 * The sanctioned way to reach an input is the harvest calculate
 * (`../inputs/contact/<field>`), which `insertContactFieldRef` creates — and
 * that row sits outside the block, so it stays offerable.
 *
 * Measured: all 492 `(../)+inputs/…` references across the real configs use
 * the XPath form. Not one reaches an input through `${…}`, so nothing real is
 * lost by withholding them.
 */
export function inputsBlockRowIds(survey: readonly SurveyRow[]): Set<string> {
  const ids = new Set<string>();
  let depth = 0;
  for (const row of survey) {
    const k = structuralKind(row);
    if (k?.edge === 'begin') {
      if (depth > 0 || row.name === CHT_INPUTS_GROUP) depth++;
      continue;
    }
    if (k?.edge === 'end') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth > 0) ids.add(row.rowId);
  }
  return ids;
}

export function isInputsPlumbingCalculate(row: SurveyRow): boolean {
  if (row.type.trim().toLowerCase() !== 'calculate') return false;
  const calc = (row.extras['calculation'] ?? '').trim();
  if (calc === '') return false;
  // A single path token — no whitespace, operators, calls or literals.
  if (!/^[A-Za-z0-9_./-]+$/.test(calc)) return false;
  return /(^|\/)inputs\//.test(calc);
}

/**
 * The form editor's Simple-mode hide set: {@link computeSimpleHiddenRowIds}
 * minus the calculates the AUTHOR wrote.
 *
 * Why this exists separately: the two callers ask different questions of
 * the same survey. `fhir/coverage.ts` asks "which rows can a clinician
 * answer?" — every calculate is excluded, and `coverage.test.ts` pins
 * that deliberately. The form editor asks "which rows does the author
 * need to see and edit?" — and hiding a calculate the author just added
 * makes the Calculate tile a trap: the row vanishes the moment it's
 * created, with only the "N plumbing rows hidden" counter ticking up.
 *
 * Cross-form pulls (BMI / BP / blood sugar via the contact-summary
 * bridge) are calculates, so Simple mode — the DEFAULT view — has to
 * show them for the geriatric flow to be buildable at all
 * (docs/NEXT.md item 1).
 *
 * Scaffold plumbing stays hidden via {@link isInputsPlumbingCalculate},
 * so a freshly-created Default app form still opens genuinely empty
 * (the §B1 cold-start invariant).
 */
export function computeAuthoringHiddenRowIds(survey: SurveyRow[]): Set<string> {
  const hidden = computeSimpleHiddenRowIds(survey);
  const insideInputs = inputsDescendantRowIds(survey);
  for (const row of survey) {
    if (row.type.trim().toLowerCase() !== 'calculate') continue;
    // Inside `inputs/` it is plumbing by position; outside, only when it
    // merely re-exports an inputs value.
    if (insideInputs.has(row.rowId)) continue;
    if (isInputsPlumbingCalculate(row)) continue;
    hidden.delete(row.rowId);
  }
  return hidden;
}

/** Row ids descended from the CHT `inputs/` group (exclusive of the
 *  `begin group inputs` row itself). Shared by the two hide-set builders
 *  so their notion of "inside inputs/" cannot drift apart. */
function inputsDescendantRowIds(survey: SurveyRow[]): Set<string> {
  const out = new Set<string>();
  const groupStack: string[] = [];
  for (const row of survey) {
    const t = row.type.trim().toLowerCase();
    if (t === 'end group' || t === 'end repeat') groupStack.pop();
    if (groupStack.some((g) => g.toLowerCase() === CHT_INPUTS_GROUP)) out.add(row.rowId);
    if (t === 'begin group' || t === 'begin repeat') groupStack.push(row.name);
  }
  return out;
}

/**
 * Coarse-grained kind a `SurveyRow.type` belongs to, used by the condition
 * builder to soft-filter the field and operator dropdowns. `unknown` is a
 * first-class always-pass bucket: contact-injected fields (no type metadata),
 * `calculate` rows (no inherent type), unrecognized/compound types, image /
 * audio / video, and structural rows all collapse to it so they are never
 * silently de-emphasized.
 */
export type FieldKind = 'text' | 'numeric' | 'date' | 'choice' | 'geo' | 'unknown';

/**
 * Classify a `SurveyRow.type` string (the raw cell, possibly carrying a
 * list-name suffix for selects) into a {@link FieldKind}. Exhaustive over
 * {@link QUESTION_TYPES}; everything else — empty, custom, structural —
 * falls through to `unknown` deliberately (Lorena's "no wrong bucket"
 * gate). Display-only signal; never feeds the parser/serializer.
 */
export function inferFieldKind(type: string): FieldKind {
  const t = type.trim().toLowerCase();
  if (t === '') return 'unknown';
  if (SELECT_TYPE_RE.test(type)) return 'choice';
  if (t === 'select_one' || t === 'select_multiple') return 'choice';
  switch (t) {
    case 'text':
    case 'string':
    case 'barcode':
    case 'note':
    case 'hidden':
      return 'text';
    case 'integer':
    case 'decimal':
      return 'numeric';
    case 'date':
    case 'time':
    case 'datetime':
      return 'date';
    case 'geopoint':
      return 'geo';
    case 'calculate':
    case 'image':
    case 'audio':
    case 'video':
      return 'unknown';
    default:
      return 'unknown';
  }
}
