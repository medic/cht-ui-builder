/**
 * XLSForm scaffolds seeded into newly-created forms (plan
 * docs/plans/survey-groups-and-scaffold.md Part B).
 *
 * Two variants per category:
 *   - **Default app scaffold (B1)** — the canonical `inputs` plumbing
 *     block (user + contact + linking calculates) every CHT report
 *     form needs. Comes from the cht-conf "Input data available in
 *     forms" convention; cross-checked against
 *     `server/templates/cht-default/forms/app/*.xlsx`.
 *   - **Default contact scaffold (B2)** — a contact-type group +
 *     parent/contact_type plumbing. Defaults to `person`; the planner
 *     answered open question §1 with "default + rename" (Part A makes
 *     renaming trivial).
 *   - **Blank scaffold (B3)** — explicit empty survey; offered as the
 *     escape hatch for a power user starting from scratch.
 *
 * The scaffold builders return an `XLSForm` ready for `serializeXlsForm`.
 * Round-trip stability is the only contract: a scaffold serialized
 * then parsed must produce the same `survey` rows (modulo regenerated
 * rowIds) — the round-trip test pins it.
 */
import { type ChoiceRow, type SurveyRow, type XLSForm } from './types.js';

/** Build a `SurveyRow` with sensible defaults. Hides the boilerplate
 *  of the structural+extras shape so the scaffold tables read top-to-bottom
 *  like the spreadsheet equivalent. */
function row(
  rowIdSeed: string,
  type: string,
  name: string,
  label: string,
  extras: Record<string, string> = {},
): SurveyRow {
  return {
    rowId: rowIdSeed,
    type,
    name,
    labels: label ? { en: label } : { en: '' },
    extras,
  };
}

const APP_SURVEY_HEADERS = [
  'type',
  'name',
  'label::en',
  'required',
  'relevant',
  'calculation',
  'appearance',
  'default',
];

const CONTACT_SURVEY_HEADERS = ['type', 'name', 'label::en', 'required', 'appearance'];

/**
 * §B1 — app-form `inputs` scaffold + standard linking calculates.
 * Verbatim shape per plan §B1:
 *
 *   begin group   inputs   field-list   relevant=./source = 'user'
 *     hidden      source   default=user
 *     begin group user
 *       hidden    contact_id
 *       hidden    facility_id
 *       hidden    name
 *     end group   user
 *     begin group contact
 *       string    _id      appearance="select-contact type-person"
 *       hidden    patient_id
 *       hidden    name
 *     end group   contact
 *   end group     inputs
 *   calculate     patient_uuid          calculation=../inputs/contact/_id
 *   calculate     patient_id            calculation=../inputs/contact/patient_id
 *   calculate     created_by            calculation=../inputs/user/name
 *   calculate     created_by_person_uuid calculation=../inputs/user/contact_id
 */
export function buildAppFormScaffold(opts: { basename: string; title?: string }): XLSForm {
  const r = (
    i: number,
    type: string,
    name: string,
    label: string,
    extras: Record<string, string> = {},
  ) => row(`scaffold_${i}`, type, name, label, extras);

  const survey: SurveyRow[] = [
    r(0, 'begin group', 'inputs', '', { appearance: 'field-list', relevant: `./source = 'user'` }),
    r(1, 'hidden', 'source', 'Source', { default: 'user' }),
    r(2, 'begin group', 'user', ''),
    r(3, 'hidden', 'contact_id', 'Contact id'),
    r(4, 'hidden', 'facility_id', 'Facility id'),
    r(5, 'hidden', 'name', 'Username'),
    r(6, 'end group', 'user', ''),
    r(7, 'begin group', 'contact', ''),
    r(8, 'string', '_id', 'Patient ID', { appearance: 'select-contact type-person' }),
    r(9, 'hidden', 'patient_id', 'Medic ID'),
    // `name` completes the CHT docs' "typical inputs group" of
    // `_id` / `patient_id` / `name`, and restores the matched-pair
    // invariant: the scaffold declares exactly what its calculates read.
    //
    // It was missing, and that was a deploy blocker rather than an
    // omission. `insertContactFieldRef` writes only the REFERENCE half
    // (`../inputs/contact/name`), so picking the patient's name produced a
    // dangling XPath, and `validate-app-forms` fails the ENTIRE run — one
    // bad reference in one form blocks every form and the app settings:
    //
    //   ERROR  …_form_for_elder_population.xml contains invalid XPath:
    //          calculate for /data/patient_name contains [../inputs/contact/name]
    //
    // Measured across the four real configs' app forms: `contact/name` is
    // declared in 60 forms and referenced in 68 — the third most common
    // input path after `patient_id` (68) and `_id` (61). And of every
    // `../inputs/*` reference in those forms, ZERO are undeclared. Real
    // configs always pair the two; the tool was the only thing that didn't.
    //
    // Deliberately just this one row, not the wider cht-core set (PO
    // decision, 2026-08-14): `short_name`, `date_of_birth` and `sex` are
    // real but far less used, and putting them in every new form that will
    // never reference them is clutter. Anything outside this set is
    // declared on demand — see `insertContactFieldRef`.
    r(10, 'hidden', 'name', 'Patient name'),
    r(11, 'end group', 'contact', ''),
    r(12, 'end group', 'inputs', ''),
    r(13, 'calculate', 'patient_uuid', 'Patient UUID', {
      calculation: '../inputs/contact/_id',
    }),
    r(14, 'calculate', 'patient_id', 'Patient ID', {
      calculation: '../inputs/contact/patient_id',
    }),
    r(15, 'calculate', 'created_by', 'Created by user', {
      calculation: '../inputs/user/name',
    }),
    r(16, 'calculate', 'created_by_person_uuid', 'Creator uuid', {
      calculation: '../inputs/user/contact_id',
    }),
  ];

  return baseForm(opts.basename, survey, [], APP_SURVEY_HEADERS, opts.title);
}

/**
 * §B2 — contact-form scaffold (create variant). Defaults `contact_type`
 * to `person`; the user can rename via the group's name field
 * (Part A makes group renaming trivial). Edit-variant scaffold (with
 * the hydrated parent group) is deferred — the create path is the
 * one new-form-create exercises.
 */
export function buildContactFormScaffold(opts: {
  basename: string;
  contactType?: string;
  title?: string;
}): XLSForm {
  const ct = opts.contactType ?? 'person';
  const r = (
    i: number,
    type: string,
    name: string,
    label: string,
    extras: Record<string, string> = {},
  ) => row(`scaffold_${i}`, type, name, label, extras);

  const survey: SurveyRow[] = [
    r(0, 'begin group', ct, ''),
    r(1, 'hidden', 'parent', 'Parent Id'),
    r(2, 'hidden', 'contact_type', 'Contact type', { default: ct }),
    r(3, 'end group', ct, ''),
  ];

  return baseForm(opts.basename, survey, [], CONTACT_SURVEY_HEADERS, opts.title);
}

/** §B3 — explicit empty scaffold; what the editor produces today. */
export function buildBlankFormScaffold(opts: {
  basename: string;
  title?: string;
  category: 'app' | 'contact';
}): XLSForm {
  const headers = opts.category === 'app' ? APP_SURVEY_HEADERS : CONTACT_SURVEY_HEADERS;
  return baseForm(opts.basename, [], [], headers, opts.title);
}

function baseForm(
  basename: string,
  survey: SurveyRow[],
  choices: ChoiceRow[],
  surveyHeaders: string[],
  /**
   * Human title (e.g. "Patient Age"). Present when the create dialog
   * collected a friendly title alongside the auto-slugified `basename`;
   * absent for older callers that only had the basename. Falls back to
   * `basename` so the form_title cell is never empty.
   */
  title?: string,
): XLSForm {
  return {
    locales: ['en'],
    surveyHeaders: { ordered: surveyHeaders, labelLocales: ['en'] },
    choicesHeaders: { ordered: ['list_name', 'name', 'label::en'], labelLocales: ['en'] },
    survey,
    choices,
    settings: {
      form_title: title && title.trim() !== '' ? title : basename,
      form_id: basename,
      // Caller (server route) supplies the version; scaffolds are
      // deterministic strings only, no Date.now() leak.
      version: '',
      default_language: 'en',
      extras: { style: 'pages' },
    },
    extraSheets: [],
  };
}
