/**
 * Tell a cht-conf FORM TEMPLATE apart from a real form.
 *
 * `forms/contact/PLACE_TYPE-create.xlsx` is not a contact form. It is
 * cht-conf's own scaffold template, where the literal token `PLACE_TYPE` is
 * substituted when someone adds a new place type. Parsing it as a real form
 * means its placeholder questions leak into every list built from "the
 * project's contact fields".
 *
 * ## Measured
 *
 * Across seven project roots — the four real configs plus the three
 * templates we ship that carry forms — scanning both `forms/app` and
 * `forms/contact`, `.xlsx` and `.xml`: the ONLY form basenames containing
 * any uppercase character at all are `PLACE_TYPE-create` and
 * `PLACE_TYPE-edit`. Every real form is lowercase snake_case
 * (`c82_person-create`, `district_hospital-edit`, `pregnancy`, …).
 *
 * They are also the only contact forms with no compiled `.xml` sibling,
 * which is the objective sign cht-conf never converts them.
 *
 * The pollution this causes, measured by diffing the field names the
 * templates contribute against the ones real contact forms contribute:
 *
 *   gandaki      18 field names + 11 choice values that exist NOWHERE else
 *   cht-default  14 field names + 11 choice values
 *   nssd          0 (its real forms happen to cover the same names)
 *
 * The phantoms are things like `custom_place_name_label_translator`,
 * `place_type_translation`, `generated_name_translation_temp` — plausible
 * enough to pick from a dropdown, and attached to no real contact.
 *
 * That mattered more once `insertContactFieldRef` started DECLARING the
 * field you pick: picking a phantom would write a real-looking
 * `inputs/contact` node for a field no contact has.
 *
 * ## Why an ALL-CAPS token rather than the literal "PLACE_TYPE"
 *
 * The all-caps placeholder is cht-conf's convention, not one customer's
 * habit — the same class of platform fact as `inputs/meta` being
 * runtime-injected. Matching the shape rather than the one instance means a
 * future `CONTACT_TYPE-create.xlsx` is handled without another special
 * case, and the measurement above says the shape has zero false positives on
 * every real form we have.
 */

/**
 * An ALL-CAPS placeholder token of four or more characters, as its own
 * segment of the basename. Four is the floor so a real form could still be
 * called something like `anc-A1` without being mistaken for a template.
 */
const PLACEHOLDER_TOKEN_RE = /(?:^|[^A-Za-z0-9])[A-Z][A-Z0-9_]{3,}(?:[^A-Za-z0-9]|$)/;

/**
 * True when `filename` is a cht-conf form TEMPLATE rather than a real form.
 *
 * Accepts a bare basename or a full filename; the extension is ignored.
 * Callers should skip these when harvesting field names, choice values or
 * anything else presented as "what this project contains".
 *
 * Deliberately NOT used to hide the file from the forms index — it exists on
 * disk, cht-conf put it there, and a power user may want to look at it. The
 * defect is it being treated as a source of real contact fields.
 */
export function isPlaceholderFormFile(filename: string): boolean {
  const basename = filename
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/\.(xlsx|xml|properties\.json)$/i, '');
  return PLACEHOLDER_TOKEN_RE.test(basename);
}
