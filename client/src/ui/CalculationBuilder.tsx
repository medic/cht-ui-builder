/**
 * Editor for an XLSForm `calculation` cell (the value-producing column).
 *
 * Tier 1 of docs/plans/calculation-builder.md v0.2. The cell can take
 * four authoring shapes, exposed via an a11y radio tablist:
 *
 *   - **Single value** — a bare `${field}` reference, an xpath path, or
 *     a literal (string or number) with visible auto-quote. Covers 205 of
 *     258 distinct cells in the cht-default corpus (plan §6).
 *   - **If-then table** — a DMN-style decision table; nested
 *     `if(C1, V1, if(C2, V2, ... ELSE))`. Rules are matched first-to-last.
 *   - **Common calculation** — a templates gallery that seeds the cell
 *     with a canonical recipe. Tier 1 ships exactly one: "Age from date
 *     of birth" (corpus-grounded, 1 occurrence).
 *   - **Raw** — verbatim XLSForm expression, escape hatch for everything
 *     outside the supported grammar. The same path the §3.1 self-check
 *     routes unstable structured candidates to.
 *
 * Round-trip contract (plan §3.1, §3.3): every save flows through the
 * `parseCalculation` self-check at the store boundary, so anything
 * outside the supported shapes is preserved verbatim. A present cell is
 * NEVER deleted on save — the `'single'` empty-collapse path only fires
 * for genuinely-empty source.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  parseCalculation,
  serializeCalculation,
  parseRelevant,
  serializeRelevant,
  recognizeReference,
  emitContactInput,
  emitContactSummary,
  emitFieldRef,
  type CalculationRule,
  type ContextKeyInfo,
  type ContextWrapper,
  type ReportFieldChoice,
  type ParsedCalculation,
  type ParsedExpression,
} from '@cht-ui/shared';
import { useApp } from '../state/store.js';
import { RelevantRuleBuilder } from './RelevantRuleBuilder.js';
import {
  useContactSummaryBridgeKeys,
  useContextKeyScan,
  type ContextBridgeKey,
  type ContextKeyScan,
} from './useContactSummaryContextKeys.js';

/**
 * Say plainly when the offered list is not the whole story.
 *
 * docs/plans/pick-preexisting-context-values.md is explicit about this:
 * "Never present a partial list as complete." A config can build context
 * keys in ways static analysis provably cannot enumerate — a
 * `context[key] = value` loop, a template-literal family like
 * `baby_name_${i}_ctx`, or a spread from another function. NSSD does all
 * three. If we stay quiet, a key that exists at runtime but isn't listed
 * reads to the author as their own spelling mistake.
 *
 * Renders nothing when there is nothing to disclose, so the common case
 * stays uncluttered.
 */
function ContextKeyHonestyNote(props: { scan: ContextKeyScan | null }): JSX.Element | null {
  const scan = props.scan;
  if (!scan) return null;

  // Distinct from "found none": we could not locate the context object at
  // all. Reporting an empty list here is exactly the bug this feature fixes.
  if (!scan.definitionsFound && scan.keys.length === 0) {
    return (
      <p className="muted small wrapper-help">
        Couldn’t find this config’s contact-summary <code>context</code>
        {scan.summaryFiles.length > 0 ? ` in ${scan.summaryFiles.join(', ')}` : ''}. You can still
        type a key — it just won’t be checked.
      </p>
    );
  }

  if (scan.indeterminate.length === 0) return null;

  const families = scan.indeterminate.some((n) => n.reason === 'template-literal-key');
  return (
    <p className="muted small wrapper-help">
      This config also builds some values dynamically
      {families ? ' (whole families of them, named from the data)' : ''}, which can’t be listed
      here. The list above is what we can see, not everything that exists — type a key directly if
      you know it.
    </p>
  );
}

/**
 * The secondary text shown beside a context key in the picker.
 *
 * Two things worth saying, both from the scan:
 *  - **Proof of use.** A key six forms already read is safer to offer than
 *    one nothing reads, and 49 of NSSD's 70 keys are only visible BECAUSE a
 *    form reads them.
 *  - **Conditional.** Some keys are only set for some contacts (NSSD gates
 *    `previous_bmi_ctx` on age >= 30 plus an existing NCD record), and static
 *    analysis cannot tell "doesn't apply to her" from "you spelled it wrong".
 *    Saying so is the honest version.
 */
function contextKeyHint(k: ContextKeyInfo): string {
  const parts: string[] = [];
  if (k.usageCount > 0) {
    const n = k.usedBy?.length ?? 0;
    parts.push(n === 1 ? 'used by 1 form' : `used by ${n} forms`);
  } else if (k.origins?.length) {
    parts.push('defined, not yet used in a form');
  }
  if (k.conditional) parts.push('only set for some contacts');
  return parts.join(' · ');
}

interface Props {
  value: string;
  fieldOptions: string[];
  /** Per-field choice options ({name, label}) for this form's selects, so
   *  the NESTED condition editor's value cell is a dropdown instead of a
   *  type-it-yourself box. Same map the relevant/constraint/choice_filter
   *  builders already get; forwarding it here is docs/NEXT.md item 3, which
   *  unblocks the IHA "which is high / normal" if-then texts and the
   *  hidden-flag route the referral-follow-up rows need. */
  fieldChoiceOptions?: Record<string, ReportFieldChoice[]>;
  /** Contact-form field names available for the "Contact input field" kind
   *  (Tier 1.5). UNION of the project's parsed contact forms with a
   *  known-minimal fallback set (_id, name, patient_id, …). May be empty;
   *  the picker still allows free-type via the datalist. */
  inputContactFields?: string[];
  /** Contact-summary `context` keys available for the "Contact-summary
   *  value" kind (Tier 1.5). Sourced from
   *  parseContactSummary(src).contextOrder via useContactSummaryContextKeys.
   *  May be empty; the picker still allows free-type. */
  contextKeys?: string[];
  onSave: (v: string) => void;
  onCancel: () => void;
  title?: string;
}

type Mode = 'single' | 'if-then' | 'common' | 'raw';

/** The 4-mode tablist labels (plan v0.2 §3). Keep the order stable —
 *  the tablist iterates this array in declaration order. */
const MODE_LABELS: Record<Mode, string> = {
  single: 'Single value',
  'if-then': 'If-then table',
  common: 'Common calculation',
  raw: 'Raw',
};

/** Derive the initial mode from the raw cell value. Empty cells default
 *  to the templates gallery (plan §3 "templates gallery FIRST on an
 *  empty cell"); recognizable references open in Single regardless of
 *  what `parseCalculation` thinks of the shape; everything else routes
 *  by parsed shape.
 *
 *  Punch-list §H1: pre-fix this only consulted `parsed.shape`, which
 *  meant a wrapped reference like `if(ref, ref, .)` (parses as
 *  decision_table) opened in the If-then table panel and `once( ref )`
 *  (parses as single but the recognizer didn't tolerate whitespace) fell
 *  through to Custom expression. Both now route to Single → Reference
 *  via `recognizeReference` BEFORE consulting the parsed shape. */
function initialModeFor(parsed: ParsedCalculation): Mode {
  const trimmed = parsed.raw.trim();
  // §H1 — recognizer FIRST. A recognized reference always opens in
  // Single mode (the SingleValuePanel renders the right sub-picker),
  // independent of the parser's shape verdict.
  if (trimmed !== '' && recognizeReference(trimmed)) return 'single';
  if (parsed.shape === 'raw') return 'raw';
  if (parsed.shape === 'decision_table') return 'if-then';
  // shape === 'single'. Empty otherwise (genuinely-empty source) → show
  // the gallery so the user sees the recipes immediately.
  if (parsed.otherwise.trim() === '') return 'common';
  return 'single';
}

/* ============================== templates ================================ */

interface CalcTemplate {
  /** Stable identifier used as the keyed list key. */
  id: string;
  /** Short title (button label + heading). */
  title: string;
  /** One-line description shown beneath the title. */
  description: string;
  /**
   * Whether this template needs a `${field}` argument the user picks at
   * insert time. The picker presents `fieldOptions` filtered by `accepts`.
   */
  fieldArg?: { label: string; accepts?: (name: string) => boolean };
  /** Build the cell text given the chosen field (or '' if none required). */
  build: (field: string) => string;
  /** Hint at the produced shape so the post-insert mode switch is correct. */
  resultMode: Mode;
}

/** Canonical Age-from-DOB recipe (plan v0.2 §3 — "1 recipe with corpus
 *  support"). Uses the `difference-in-months / div 12` form — the most
 *  widely-used age-in-years pattern in cht-default. The recipe round-trips
 *  byte-stable through the `'single'` self-check (Bucket A test pins it). */
const AGE_FROM_DOB: CalcTemplate = {
  id: 'age-from-dob',
  title: 'Age from date of birth',
  description: 'Whole-year age, recalculated against today’s date.',
  fieldArg: {
    label: 'Date-of-birth field',
    accepts: (n) => /dob|date_of_birth|birth/i.test(n),
  },
  build: (field) => `floor( difference-in-months( \${${field}}, today() ) div 12 )`,
  resultMode: 'single',
};

const TEMPLATES: ReadonlyArray<CalcTemplate> = [AGE_FROM_DOB];

/* ========================== typed output value =========================== */

/**
 * Detect the user-intended kind of an output cell so the typed-output
 * affordance can show the right control + auto-quote indicator. This is
 * purely a UI hint — the underlying string is what gets serialized.
 */
/**
 * The kind of value a single-value calculation cell carries. Drives the
 * SingleValuePanel's radiogroup. Three new kinds in Tier 1.5:
 *   - `contact-input` — the patient-link pattern (`../inputs/contact/X`).
 *   - `contact-summary` — `instance('contact-summary')/context/<key>` with
 *     an optional `none` / fallback-to-current / read-once wrapper.
 *   - the other four (`literal`, `number`, `field-ref`, `expression`) are
 *     unchanged from Tier 1.
 */
type OutputKind =
  | 'literal'
  | 'number'
  | 'field-ref'
  | 'contact-input'
  | 'contact-summary'
  | 'cross-form'
  | 'expression';

/** Subset the table-cell TypedOutputInput renders radios for. Unchanged
 *  from Tier 1 — adding contact-input/contact-summary to the decision-table
 *  output is explicitly out of scope (plan §95). */
const TYPED_OUTPUT_KINDS: ReadonlyArray<'literal' | 'number' | 'field-ref'> = [
  'literal',
  'number',
  'field-ref',
];

function inferOutputKind(raw: string): OutputKind {
  const v = raw.trim();
  if (v === '') return 'literal';
  // Tier 1.5 — try the reference recognizer FIRST so the picker re-hydrates
  // contact-input / contact-summary / field-ref cells into their own radio
  // (independent of whatever parseCalculation labels the shape).
  const ref = recognizeReference(v);
  if (ref) {
    if (ref.kind === 'contact-input') return 'contact-input';
    if (ref.kind === 'contact-summary') return 'contact-summary';
    if (ref.kind === 'field-ref') return 'field-ref';
  }
  if (/^'[^']*'$/.test(v) || /^"[^"]*"$/.test(v)) return 'literal';
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'number';
  return 'expression';
}

/** Strip surrounding single/double quotes for display in the literal input.
 *  The serializer re-adds them via `autoQuoteLiteral`. */
function unquoteLiteral(raw: string): string {
  const v = raw.trim();
  if (/^'(.*)'$/.test(v)) return v.slice(1, -1);
  if (/^"(.*)"$/.test(v)) return v.slice(1, -1);
  return v;
}

/** Wrap a user-typed literal in single quotes (XLSForm convention). Empty
 *  string maps to `''` so the cell isn't accidentally deleted by an empty
 *  output slot. */
function autoQuoteLiteral(raw: string): string {
  return `'${raw.replace(/'/g, "\\'")}'`;
}

/* ============================ main component ============================= */

export function CalculationBuilder(props: Props) {
  const [parsed, setParsed] = useState<ParsedCalculation>(() => parseCalculation(props.value));
  const [mode, setMode] = useState<Mode>(() => initialModeFor(parseCalculation(props.value)));
  const [rawText, setRawText] = useState<string>(props.value);
  const [singleValue, setSingleValue] = useState<string>(() => {
    const p = parseCalculation(props.value);
    return p.shape === 'single' ? p.otherwise : '';
  });
  const [editingCondIdx, setEditingCondIdx] = useState<number | null>(null);

  // Rehydrate from props.value whenever it changes (modal can re-open
  // on a different cell). Mode follows the parsed shape.
  useEffect(() => {
    const p = parseCalculation(props.value);
    setParsed(p);
    setRawText(props.value);
    setSingleValue(p.shape === 'single' ? p.otherwise : '');
    setMode(initialModeFor(p));
  }, [props.value]);

  /* -------------------------- table-mode actions -------------------------- */

  function patch(next: ParsedCalculation) {
    setParsed(next);
  }
  function patchRule(idx: number, updater: (r: CalculationRule) => CalculationRule) {
    if (parsed.shape !== 'decision_table') return;
    patch({ ...parsed, rules: parsed.rules.map((r, i) => (i === idx ? updater(r) : r)) });
  }
  function addRule() {
    // First rule promotes a single-value cell into a decision table.
    const base: ParsedCalculation =
      parsed.shape === 'decision_table'
        ? parsed
        : {
            shape: 'decision_table',
            rules: [],
            otherwise: parsed.otherwise,
            raw: parsed.raw,
          };
    patch({
      ...base,
      rules: [...base.rules, { condition: parseRelevant(''), output: "''" }],
    });
  }
  function removeRule(idx: number) {
    if (parsed.shape !== 'decision_table') return;
    patch({ ...parsed, rules: parsed.rules.filter((_, i) => i !== idx) });
  }

  /* --------------------------- template insert --------------------------- */

  function applyTemplate(template: CalcTemplate, field: string): void {
    const text = template.build(field);
    setRawText(text);
    setSingleValue(text);
    setParsed(parseCalculation(text));
    setMode(template.resultMode);
  }

  /* ------------------------------- save ---------------------------------- */

  function save() {
    if (mode === 'raw') {
      props.onSave(rawText);
      return;
    }
    if (mode === 'single') {
      // Single-value path: persist the user-edited single value verbatim.
      // The parent's setExtra normalizes a length-0 cell to a delete, so a
      // genuinely-empty `singleValue` collapses cleanly.
      props.onSave(singleValue);
      return;
    }
    if (mode === 'common') {
      // Templates panel; nothing to save directly — a template click
      // already updated `singleValue`/`rawText` and switched the mode.
      props.onSave(singleValue || rawText);
      return;
    }
    // 'if-then' table
    props.onSave(serializeCalculation(parsed));
  }

  /* ------------------------------ derived -------------------------------- */

  /** The string we'd save right now, used by both `Result:` and the
   *  collapsible compiled-expression panel. */
  const currentSerialized: string = useMemo(() => {
    if (mode === 'raw') return rawText;
    if (mode === 'single') return singleValue;
    if (mode === 'common') return singleValue || rawText;
    return serializeCalculation(parsed);
  }, [mode, rawText, singleValue, parsed]);

  const resultReadback = useMemo(
    () => describeCalculation(currentSerialized),
    [currentSerialized],
  );

  /* ------------------------------- render -------------------------------- */

  return (
    <div className="rule-builder-modal" role="dialog" aria-label="Calculation builder">
      <div className="rule-builder-card calc-card">
        <header className="row gap">
          <h3>{props.title ?? 'Calculation builder'}</h3>
          <button className="link" onClick={props.onCancel}>cancel</button>
        </header>

        {/* a11y tablist — radio semantics via aria-pressed on each tab. */}
        <div role="tablist" aria-label="Calculation mode" className="row gap calc-modes">
          {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? 'active' : 'link'}
              onClick={() => setMode(m)}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>

        {mode === 'single' && (
          <SingleValuePanel
            value={singleValue}
            onChange={setSingleValue}
            fieldOptions={props.fieldOptions}
            inputContactFields={props.inputContactFields ?? []}
            contextKeys={props.contextKeys ?? []}
            onCancel={props.onCancel}
          />
        )}

        {mode === 'if-then' && (
          <DecisionTablePanel
            parsed={parsed}
            patch={patch}
            patchRule={patchRule}
            addRule={addRule}
            removeRule={removeRule}
            fieldOptions={props.fieldOptions}
            onEditCondition={setEditingCondIdx}
          />
        )}

        {mode === 'common' && (
          <TemplatesGallery
            templates={TEMPLATES}
            fieldOptions={props.fieldOptions}
            onApply={applyTemplate}
          />
        )}

        {mode === 'raw' && (
          <textarea
            className="code-editor medium"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            spellCheck={false}
            aria-label="Raw XLSForm expression"
          />
        )}

        {/* Plain-language Result: readback above the compiled-expression
            collapsible. Visible across all modes so the user can compare
            authoring vs. evaluated meaning at a glance (plan §3). */}
        <ResultReadback summary={resultReadback} expression={currentSerialized} />

        <footer className="row gap end">
          <button onClick={save}>Save</button>
          <button className="link" onClick={props.onCancel}>cancel</button>
        </footer>

        {editingCondIdx !== null &&
          mode === 'if-then' &&
          parsed.shape === 'decision_table' &&
          parsed.rules[editingCondIdx] && (
            <RelevantRuleBuilder
              column={`rule #${editingCondIdx + 1} condition`}
              value={serializeRelevant(parsed.rules[editingCondIdx]!.condition)}
              fieldOptions={props.fieldOptions}
              // docs/NEXT.md item 3 — this mount was the last condition
              // editor still typing values by hand. `inputContactFields` /
              // `contextKeys` were already props here but never forwarded,
              // so a contact-summary row parsed out of an existing
              // calculation rendered with an empty key list too.
              fieldChoiceOptions={props.fieldChoiceOptions}
              inputContactFields={props.inputContactFields}
              contextKeys={props.contextKeys}
              onCancel={() => setEditingCondIdx(null)}
              onSave={(v) => {
                patchRule(editingCondIdx, (r) => ({ ...r, condition: parseRelevant(v) }));
                setEditingCondIdx(null);
              }}
            />
          )}
      </div>
    </div>
  );
}

/* =========================== single-value panel ========================== */

const VALUE_KINDS: ReadonlyArray<OutputKind> = [
  'literal',
  'number',
  'field-ref',
  'contact-input',
  'contact-summary',
  'cross-form',
  'expression',
];

/** Known-minimal fallback contact-input fields when the project's contact
 *  forms surface nothing usable (plan §3 — diabetes_referral's inputs group
 *  is collapsed). Free-type via the datalist always remains available. */
const FALLBACK_CONTACT_FIELDS: ReadonlyArray<string> = [
  '_id',
  'name',
  'patient_id',
  'date_of_birth',
  'sex',
  'parent/_id',
  'phone',
];

const CONTEXT_WRAPPER_LABELS: Record<ContextWrapper, string> = {
  none: 'Just the value',
  'fallback-to-current': 'Use my current answer if empty',
  'guarded-fallback': 'Use my current answer if not set',
  coalesce: 'First one that has a value',
  'read-once': 'Read once',
};

/** §H4 — plain-language help text for each wrapper option, surfaced as a
 *  one-line description under the wrapper select. Bhishan couldn't tell
 *  what "Read once" meant; these read for a non-coder.
 *
 *  `guarded-fallback` and `coalesce` were added once measurement showed
 *  they are 58 of the 132 real context reads on disk — and the only idiom
 *  two of the four configs use at all. See calcReference.ts. */
const CONTEXT_WRAPPER_HELP: Record<ContextWrapper, string> = {
  none: 'Read the value from the contact summary every time the form is opened.',
  'fallback-to-current':
    'If the contact summary has a value, use it; otherwise keep whatever the user has typed here. Example: `if(ctx, ctx, .)`.',
  'guarded-fallback':
    'Same as above, but tests explicitly for "not set" first. This is the spelling most configs use. Example: `if(ctx != \'\', ctx, .)`.',
  coalesce:
    'Use the contact-summary value if it has one, otherwise keep the current answer — written as one function. Example: `coalesce(ctx, .)`.',
  'read-once':
    'Read the value the first time the form is opened; the user can then edit it without it being overwritten. Example: `once(ctx)`.',
};

function SingleValuePanel(props: {
  value: string;
  onChange: (v: string) => void;
  fieldOptions: string[];
  inputContactFields: string[];
  contextKeys: string[];
  onCancel: () => void;
}) {
  const bridgeKeys = useContactSummaryBridgeKeys();
  const bridgeKeySet = useMemo(() => new Set(bridgeKeys.map((b) => b.key)), [bridgeKeys]);
  // The three-channel scan: what this config already computes, ranked by how
  // many forms already read each key, plus the wrapper idiom the project
  // itself uses and an honest note about what static analysis cannot see.
  const ctxScan = useContextKeyScan();
  const detectedRef = recognizeReference(props.value);
  // Wave 3 · Note 6 — a `contact-summary` reference whose key is a known
  // bridge AND whose wrapper is `fallback-to-current` is a cross-form
  // bridge calc. Route it to the dedicated "From another form" radio so
  // the user sees the labeled source form, not just the ctx key.
  const isCrossFormBridge =
    detectedRef?.kind === 'contact-summary' &&
    detectedRef.wrapper === 'fallback-to-current' &&
    bridgeKeySet.has(detectedRef.argument);
  const detectedKind: OutputKind = isCrossFormBridge ? 'cross-form' : inferOutputKind(props.value);
  const [activeKind, setActiveKind] = useState<OutputKind>(detectedKind);
  // Resync when the underlying value changes from outside (template insert,
  // mode switch). Cheap effect — `detectedKind` is a pure string check.
  useEffect(() => setActiveKind(detectedKind), [detectedKind]);

  // Contact-summary wrapper state. Initialized from the recognizer; reset
  // when the user explicitly picks the contact-summary kind from scratch.
  const [contextWrapper, setContextWrapper] = useState<ContextWrapper>(
    detectedRef?.kind === 'contact-summary' ? detectedRef.wrapper : 'none',
  );
  useEffect(() => {
    if (detectedRef?.kind === 'contact-summary') setContextWrapper(detectedRef.wrapper);
  }, [detectedRef]);
  // When there is nothing to re-hydrate, start from the idiom this project
  // already uses rather than a constant of ours. Measured, there is no right
  // constant: nssd writes if(REF, REF, .), gandaki and moh-nepal write
  // if(REF != '', REF, .), lumbini writes coalesce(REF, .).
  const houseWrapper = ctxScan?.houseWrapper ?? null;
  useEffect(() => {
    if (!detectedRef && houseWrapper) setContextWrapper(houseWrapper);
  }, [detectedRef, houseWrapper]);

  // Union of project-discovered contact fields + the known-minimal
  // fallback; free-type is always honored via the datalist.
  const contactInputFieldList = useMemo(() => {
    const merged = new Set<string>([...FALLBACK_CONTACT_FIELDS, ...props.inputContactFields]);
    return Array.from(merged).sort();
  }, [props.inputContactFields]);

  // Per-kind argument values pulled from the recognizer when applicable;
  // otherwise empty so the picker shows a "pick a…" prompt.
  const contactInputField =
    detectedRef?.kind === 'contact-input' ? detectedRef.argument : '';
  const contactSummaryKey =
    detectedRef?.kind === 'contact-summary' ? detectedRef.argument : '';

  function pickContactInput(field: string): void {
    props.onChange(field ? emitContactInput(field) : '');
  }
  function pickContactSummary(key: string, wrapper: ContextWrapper): void {
    setContextWrapper(wrapper);
    props.onChange(key ? emitContactSummary(key, wrapper) : '');
  }
  function pickCrossFormKey(key: string): void {
    // Bridge calcs always use the fallback-to-current wrapper: if the
    // contact-summary's bridge value is `undefined` (patient has no
    // report of that form yet), the user's typed answer is preserved.
    // This is the whole point of the wrapper for the cross-form pattern.
    props.onChange(key ? emitContactSummary(key, 'fallback-to-current') : '');
  }

  return (
    <fieldset className="single-value-panel">
      <legend className="muted">
        The cell evaluates to a single value. Pick what kind of value you want
        and the builder writes the right XLSForm syntax for you.
      </legend>
      <div className="row gap value-kind-radios">
        {VALUE_KINDS.map((k) => (
          <label key={k} className="kind-radio" title={kindHelp(k)}>
            <input
              type="radio"
              name="single-value-kind"
              value={k}
              checked={activeKind === k}
              onChange={() => setActiveKind(k)}
              aria-describedby={`kind-help-${k}`}
            />
            <span>{kindLabel(k)}</span>
          </label>
        ))}
      </div>
      {/* §H4 — surface the chosen kind's helper text immediately under the
          radiogroup so the user knows what the kind PRODUCES without
          hovering. The id matches `aria-describedby` on each radio. */}
      <p id={`kind-help-${activeKind}`} className="muted small kind-help">
        {kindHelp(activeKind)}
      </p>

      {activeKind === 'literal' && (
        <label className="row gap" style={{ alignItems: 'center' }}>
          <span className="muted">Text:</span>
          <input
            value={unquoteLiteral(props.value)}
            onChange={(e) => props.onChange(autoQuoteLiteral(e.target.value))}
            placeholder="e.g. yes"
            aria-label="Literal text value"
          />
          <code className="muted" title="Auto-quoted to XLSForm string form">
            saved as <strong>{autoQuoteLiteral(unquoteLiteral(props.value)) || "''"}</strong>
          </code>
        </label>
      )}

      {activeKind === 'number' && (
        <label className="row gap" style={{ alignItems: 'center' }}>
          <span className="muted">Number:</span>
          <input
            type="number"
            value={/^-?\d+(\.\d+)?$/.test(props.value.trim()) ? props.value.trim() : ''}
            onChange={(e) => props.onChange(e.target.value)}
            placeholder="0"
            aria-label="Numeric value"
          />
        </label>
      )}

      {activeKind === 'field-ref' && (
        <label className="row gap" style={{ alignItems: 'center' }}>
          <span className="muted">Field:</span>
          <select
            value={extractFieldName(props.value)}
            onChange={(e) =>
              props.onChange(e.target.value ? emitFieldRef(e.target.value) : '')
            }
            aria-label="Field reference"
          >
            <option value="">— pick a field —</option>
            {props.fieldOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <code className="muted">saved as <strong>{props.value || '${field}'}</strong></code>
        </label>
      )}

      {activeKind === 'contact-input' && (
        <div className="row gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="row gap" style={{ alignItems: 'center' }}>
            <span className="muted">Contact field:</span>
            <input
              list="cb-contact-input-fields"
              value={contactInputField}
              onChange={(e) => pickContactInput(e.target.value.trim())}
              placeholder="e.g. _id or patient_name"
              aria-label="Contact input field"
            />
            <datalist id="cb-contact-input-fields">
              {contactInputFieldList.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </label>
          <code className="muted">
            saved as <strong>{props.value || '../inputs/contact/field'}</strong>
          </code>
        </div>
      )}

      {activeKind === 'contact-summary' && (
        <div className="contact-summary-picker">
          <div className="row gap" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="row gap" style={{ alignItems: 'center' }}>
              <span className="muted">Context key:</span>
              <input
                list="cb-context-keys"
                value={contactSummaryKey}
                onChange={(e) => pickContactSummary(e.target.value.trim(), contextWrapper)}
                placeholder={props.contextKeys[0] ?? 'e.g. glucometer_ctx'}
                aria-label="Contact-summary context key"
              />
              <datalist id="cb-context-keys">
                {/* The scan's order IS the confidence signal — keys real
                    forms already read come first, most-read first — so it is
                    preserved rather than sorted. The label shows the proof of
                    use and flags keys that only exist for some contacts. */}
                {(ctxScan?.keys ?? props.contextKeys.map((k) => ({ key: k }) as ContextKeyInfo)).map(
                  (k) => (
                    <option key={k.key} value={k.key} label={contextKeyHint(k)} />
                  ),
                )}
              </datalist>
            </label>
            <label className="row gap" style={{ alignItems: 'center' }}>
              <span className="muted">Wrapper:</span>
              <select
                value={contextWrapper}
                onChange={(e) =>
                  pickContactSummary(contactSummaryKey, e.target.value as ContextWrapper)
                }
                aria-label="Contact-summary wrapper"
                aria-describedby="cs-wrapper-help"
              >
                {/* Iterated, not hand-listed: the previous three literal
                    options are why `guarded-fallback` and `coalesce` were
                    unreachable from the UI after the recognizer learned
                    them. */}
                {(Object.keys(CONTEXT_WRAPPER_LABELS) as ContextWrapper[]).map((w) => (
                  <option key={w} value={w} title={CONTEXT_WRAPPER_HELP[w]}>
                    {CONTEXT_WRAPPER_LABELS[w]}
                    {w === houseWrapper ? ' — this config’s usual style' : ''}
                  </option>
                ))}
              </select>
            </label>
            <code className="muted">
              saved as <strong>{props.value || "instance('contact-summary')/context/key"}</strong>
            </code>
          </div>
          {/* §H4 — surface the chosen wrapper's help text. Bhishan
              couldn't tell what "Read once" meant from the dropdown
              alone; the helper makes the semantics legible. */}
          <p id="cs-wrapper-help" className="muted small wrapper-help">
            {CONTEXT_WRAPPER_HELP[contextWrapper]}
          </p>
          <ContextKeyHonestyNote scan={ctxScan} />
        </div>
      )}

      {activeKind === 'cross-form' && (
        <CrossFormPicker
          value={props.value}
          bridgeKeys={bridgeKeys}
          onPick={pickCrossFormKey}
          onCancel={props.onCancel}
        />
      )}

      {activeKind === 'expression' && (
        <label className="row gap" style={{ alignItems: 'flex-start' }}>
          <span className="muted">Expression:</span>
          <textarea
            className="code-editor small"
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            placeholder="e.g. floor((today() - ${dob}) div 365.25)"
            aria-label="Custom XLSForm expression"
            rows={2}
          />
        </label>
      )}
    </fieldset>
  );
}

/**
 * Wave 3 · Note 6 — the "From another form (via contact summary)" picker
 * source group. Lists the bridge keys defined in the Contact Summary
 * editor's Context values sub-tab; selecting one emits the
 * `fallback-to-current`-wrapped bridge calc via the existing engine.
 *
 * Empty-state carries a deep link that switches the app view to the
 * Contact Summary editor's Context values sub-tab, so the user isn't
 * dumped on the default (flags) tab and left to hunt.
 */
function CrossFormPicker(props: {
  value: string;
  bridgeKeys: ContextBridgeKey[];
  onPick: (key: string) => void;
  onCancel: () => void;
}) {
  const setView = useApp((s) => s.setView);
  const detectedRef = recognizeReference(props.value);
  const currentKey =
    detectedRef?.kind === 'contact-summary' ? detectedRef.argument : '';

  if (props.bridgeKeys.length === 0) {
    return (
      <div className="cross-form-empty">
        <p className="muted">
          No cross-form values defined yet. Define one in the Contact
          Summary editor&apos;s <strong>Context values</strong> tab, then
          come back and pick it here.
        </p>
        <button
          type="button"
          className="link"
          onClick={() => {
            // Close the modal first so the sidebar's dirty-check
            // prompt (if any) speaks for the form, not the calc modal.
            props.onCancel();
            setView({ kind: 'contact-summary', subView: 'values' });
          }}
        >
          Define a context value in Contact Summary →
        </button>
      </div>
    );
  }

  return (
    <div className="cross-form-picker">
      <label className="row gap" style={{ alignItems: 'center' }}>
        <span className="muted">Cross-form value:</span>
        <select
          value={currentKey}
          onChange={(e) => props.onPick(e.target.value)}
          aria-label="Cross-form context value"
        >
          <option value="">— pick a value —</option>
          {props.bridgeKeys.map((b) => (
            <option key={b.key} value={b.key}>
              {b.key} — latest {b.sourceField} from {b.sourceForm}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        If the patient has no matching report yet, the user&apos;s typed
        answer is kept (fallback-to-current wrapper).
      </p>
      <code className="muted">
        saved as <strong>{props.value || "if(ctx, ctx, .)"}</strong>
      </code>
    </div>
  );
}

function kindLabel(k: OutputKind): string {
  switch (k) {
    case 'literal':
      return 'Text';
    case 'number':
      return 'Number';
    case 'field-ref':
      return 'Another field in this form';
    case 'contact-input':
      return 'From the patient / household';
    case 'contact-summary':
      return 'From the contact summary';
    case 'cross-form':
      return 'From another form (via contact summary)';
    case 'expression':
      return 'Custom XPath';
  }
}

/** §H4 — one-line helper text shown under each kind's radio so the
 *  user knows what KIND of value the option produces. Mirrors the
 *  ExpressionField friendly-label + raw-tag pattern: the label is
 *  intent-focused, the helper points at the concrete artifact. */
function kindHelp(k: OutputKind): string {
  switch (k) {
    case 'literal':
      return 'A fixed piece of text. Auto-quoted as `\'text\'`.';
    case 'number':
      return 'A fixed number. Saved without quotes.';
    case 'field-ref':
      return 'Reuse another row\'s answer from this same form. Saved as `${field}`.';
    case 'contact-input':
      return 'Pull a value the form was launched with (patient ID, name, date of birth). Saved as `../inputs/contact/<field>`.';
    case 'contact-summary':
      return 'Pull a flag computed by the contact summary (gestational age, latest BP, …). Saved as `instance(\'contact-summary\')/context/<key>`.';
    case 'cross-form':
      return 'Pull the latest value from another form (e.g. BMI from the Diabetes screening form). Defined in Contact Summary → Context values.';
    case 'expression':
      return 'Hand-write any XPath. Use this only when none of the above fit.';
  }
}

function extractFieldName(raw: string): string {
  const m = raw.trim().match(/^\$\{([^}]+)\}$/);
  return m ? m[1]! : '';
}

/* ========================== decision-table panel ========================= */

function DecisionTablePanel(props: {
  parsed: ParsedCalculation;
  patch: (next: ParsedCalculation) => void;
  patchRule: (idx: number, u: (r: CalculationRule) => CalculationRule) => void;
  addRule: () => void;
  removeRule: (idx: number) => void;
  fieldOptions: string[];
  onEditCondition: (idx: number) => void;
}) {
  const { parsed } = props;
  return (
    <>
      <p className="muted">
        First matching rule wins. If no rule matches, the &quot;otherwise&quot; value is used.
      </p>
      <table className="decision-table">
        <thead>
          <tr>
            <th style={{ width: 24 }}>#</th>
            <th>If…</th>
            <th style={{ width: 260 }}>Then output</th>
            <th style={{ width: 60 }}></th>
          </tr>
        </thead>
        <tbody>
          {parsed.shape === 'decision_table' &&
            parsed.rules.map((rule, idx) => (
              <tr key={idx}>
                <td>{idx + 1}</td>
                <td>
                  <div className="row gap">
                    <code className="cond-preview">
                      {serializeConditionSummary(rule.condition) || '(empty)'}
                    </code>
                    <button
                      className="link"
                      onClick={() => props.onEditCondition(idx)}
                      aria-label={`edit condition for rule ${idx + 1}`}
                      title="Edit condition"
                    >
                      ✎ edit
                    </button>
                  </div>
                </td>
                <td>
                  <TypedOutputInput
                    value={rule.output}
                    fieldOptions={props.fieldOptions}
                    onChange={(v) => props.patchRule(idx, (r) => ({ ...r, output: v }))}
                  />
                </td>
                <td>
                  <button
                    className="link danger"
                    onClick={() => props.removeRule(idx)}
                    aria-label={`remove rule ${idx + 1}`}
                    title="Remove rule"
                  >
                    × remove
                  </button>
                </td>
              </tr>
            ))}
          <tr className="otherwise-row">
            <td colSpan={2} style={{ textAlign: 'right' }}>
              <strong>otherwise</strong>
            </td>
            <td>
              <TypedOutputInput
                value={parsed.otherwise}
                fieldOptions={props.fieldOptions}
                onChange={(v) => props.patch({ ...parsed, otherwise: v })}
              />
            </td>
            <td></td>
          </tr>
        </tbody>
      </table>
      <div className="row gap toolbar">
        <button onClick={props.addRule}>+ Rule</button>
      </div>
    </>
  );
}

/* ========================== typed output (Tier 1) ======================== */

/**
 * Typed-output replacement for the bare `<input placeholder="'yes' or 5">`
 * in the decision table. Picks a control based on the value's current
 * shape, with three explicit kind tabs so the user knows what's being
 * saved. Visible auto-quote indicator on the literal kind.
 */
function TypedOutputInput(props: {
  value: string;
  fieldOptions: string[];
  onChange: (v: string) => void;
}) {
  const detected = inferOutputKind(props.value);
  // Clamp the broader detected kind down to the three TypedOutputInput
  // renders. References/expressions all collapse to 'literal' as a safe
  // default — the table-cell output kinds stay narrow per plan §95.
  const initialKind: 'literal' | 'number' | 'field-ref' = TYPED_OUTPUT_KINDS.includes(
    detected as 'literal' | 'number' | 'field-ref',
  )
    ? (detected as 'literal' | 'number' | 'field-ref')
    : 'literal';
  const [kind, setKind] = useState<'literal' | 'number' | 'field-ref'>(initialKind);
  // Re-sync the active kind radio when the underlying value changes shape
  // (e.g. the user picked a template that swapped the cell to a field-ref).
  useEffect(() => setKind(initialKind), [initialKind]);

  // Tier-1.5 A2 — native <fieldset>/<input type=radio> for free keyboard
  // nav. Stable group name per-row keeps multiple table cells independent.
  const groupName = useMemo(
    () => `typed-output-${Math.random().toString(36).slice(2, 9)}`,
    [],
  );

  return (
    <fieldset className="typed-output">
      <legend className="visually-hidden">Output kind</legend>
      <div className="row gap typed-output-kinds">
        {TYPED_OUTPUT_KINDS.map((k) => (
          <label key={k} className="kind-radio">
            <input
              type="radio"
              name={groupName}
              value={k}
              checked={kind === k}
              onChange={() => setKind(k)}
            />
            <span>{kindLabel(k)}</span>
          </label>
        ))}
      </div>
      {kind === 'literal' && (
        <div className="row gap" style={{ alignItems: 'center' }}>
          <input
            value={unquoteLiteral(props.value)}
            onChange={(e) => props.onChange(autoQuoteLiteral(e.target.value))}
            placeholder="yes"
            aria-label="Literal text"
          />
          <code className="muted typed-output-hint">
            saved as <strong>{autoQuoteLiteral(unquoteLiteral(props.value)) || "''"}</strong>
          </code>
        </div>
      )}
      {kind === 'number' && (
        <input
          type="number"
          value={/^-?\d+(\.\d+)?$/.test(props.value.trim()) ? props.value.trim() : ''}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder="0"
          aria-label="Numeric output"
        />
      )}
      {kind === 'field-ref' && (
        <select
          value={extractFieldName(props.value)}
          onChange={(e) =>
            props.onChange(e.target.value ? emitFieldRef(e.target.value) : '')
          }
          aria-label="Field reference"
        >
          <option value="">— pick a field —</option>
          {props.fieldOptions.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      )}
    </fieldset>
  );
}

/* ============================== templates =============================== */

function TemplatesGallery(props: {
  templates: ReadonlyArray<CalcTemplate>;
  fieldOptions: string[];
  onApply: (t: CalcTemplate, field: string) => void;
}) {
  return (
    <div className="templates-gallery">
      <p className="muted">
        Pick a recipe to seed this calculation. You can edit it freely
        afterwards in any of the other modes.
      </p>
      {props.templates.map((t) => (
        <TemplateCard
          key={t.id}
          template={t}
          fieldOptions={props.fieldOptions}
          onApply={(field) => props.onApply(t, field)}
        />
      ))}
    </div>
  );
}

function TemplateCard(props: {
  template: CalcTemplate;
  fieldOptions: string[];
  onApply: (field: string) => void;
}) {
  const { template } = props;
  const accepts = template.fieldArg?.accepts;
  const candidates = useMemo(
    () => (accepts ? props.fieldOptions.filter(accepts) : props.fieldOptions),
    [accepts, props.fieldOptions],
  );
  const [chosen, setChosen] = useState<string>(() => candidates[0] ?? '');
  useEffect(() => {
    if (!chosen && candidates[0]) setChosen(candidates[0]);
  }, [candidates, chosen]);

  return (
    <section className="template-card" aria-labelledby={`tpl-${template.id}-title`}>
      <h4 id={`tpl-${template.id}-title`}>{template.title}</h4>
      <p className="muted">{template.description}</p>
      {template.fieldArg && (
        <label className="row gap" style={{ alignItems: 'center' }}>
          <span className="muted">{template.fieldArg.label}:</span>
          <select
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
            aria-label={template.fieldArg.label}
          >
            {candidates.length === 0 && <option value="">— no matching field —</option>}
            {candidates.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="row gap">
        <button
          type="button"
          onClick={() => props.onApply(chosen)}
          disabled={Boolean(template.fieldArg) && !chosen}
        >
          Insert
        </button>
        <code className="muted preview">
          {chosen ? template.build(chosen) : template.build('field')}
        </code>
      </div>
    </section>
  );
}

/* ============================ Result readback ============================ */

function ResultReadback(props: { summary: string; expression: string }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="calc-result">
      <div className="row gap">
        <strong className="muted">Result:</strong>
        <span>{props.summary}</span>
        <button
          type="button"
          className="link"
          onClick={() => setShowRaw((s) => !s)}
          aria-expanded={showRaw}
        >
          {showRaw ? 'hide XLSForm expression' : 'show XLSForm expression'}
        </button>
      </div>
      {showRaw && (
        <pre className="preview" aria-label="Compiled XLSForm expression">
          {props.expression || '(empty)'}
        </pre>
      )}
    </div>
  );
}

/** Plain-language summary of what an XLSForm calculation expression
 *  produces. Best-effort for the recognized shapes; falls through to a
 *  generic message for anything else (raw mode keeps the truth in the
 *  collapsible `<pre>` below).  */
function describeCalculation(expr: string): string {
  const trimmed = expr.trim();
  if (trimmed === '') return 'Empty — the cell will be cleared on save.';
  // Bare field reference.
  const fieldRef = trimmed.match(/^\$\{([^}]+)\}$/);
  if (fieldRef) return `Uses the value of \${${fieldRef[1]!}}.`;
  // Quoted string literal.
  if (/^'[^']*'$/.test(trimmed) || /^"[^"]*"$/.test(trimmed)) {
    return `Always evaluates to ${trimmed}.`;
  }
  // Numeric literal.
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return `Always evaluates to ${trimmed}.`;
  // Recognized Age-from-DOB shape.
  if (/^floor\(\s*difference-in-months\(\s*\$\{[^}]+\},\s*today\(\)\s*\)\s*div\s*12\s*\)$/.test(trimmed)) {
    return 'Whole-year age computed against today’s date.';
  }
  // If-chain prose, mirroring the relevant-rule serializer's style.
  if (trimmed.startsWith('if(')) {
    const parsed = parseCalculation(trimmed);
    if (parsed.shape === 'decision_table') {
      const ruleProse = parsed.rules
        .map((r, i) => `rule ${i + 1}: when ${conditionProse(r.condition)}, output ${r.output}`)
        .join('; ');
      return `${ruleProse}; otherwise ${parsed.otherwise}.`;
    }
  }
  return 'Hand-written XLSForm expression (no plain-language preview).';
}

function conditionProse(cond: ParsedExpression): string {
  if (cond.rules.length === 0) return '(empty)';
  const parts = cond.rules.map((r) => {
    if (r.kind === 'comparison') {
      const v = r.valueIsString ? r.value : r.value;
      return `\${${r.field}} ${r.op} ${v}`;
    }
    if (r.kind === 'selected') {
      return `${r.negated ? 'not ' : ''}\${${r.field}} includes ${r.value}`;
    }
    if (r.kind === 'answered') {
      return `\${${r.field}} ${r.negated ? 'is empty' : 'is answered'}`;
    }
    if (r.kind === 'age') {
      return `age of \${${r.field}} ${r.op} ${r.value} years`;
    }
    if (r.kind === 'date_offset') {
      return `\${${r.field}} ${r.comparator === 'more_than' ? '>' : '<'} ${r.amount} ${r.unit} ${r.direction === 'ago' ? 'ago' : 'from now'}`;
    }
    // Phase 1b — contact-input / contact-summary cross-form comparison
    // rules. Render with a human-readable LHS that makes the source of
    // the value obvious in the decisions sign-off view.
    if (r.kind === 'contact-input-comparison') {
      const v = r.valueIsString ? `'${r.value}'` : r.value;
      return `contact.${r.field} ${r.op} ${v}`;
    }
    if (r.kind === 'contact-summary-comparison') {
      const v = r.valueIsString ? `'${r.value}'` : r.value;
      const lhs =
        r.wrapper === 'read-once'
          ? `once(summary.${r.contextKey})`
          : r.wrapper === 'fallback-to-current'
            ? `summary.${r.contextKey} or current`
            : `summary.${r.contextKey}`;
      return `${lhs} ${r.op} ${v}`;
    }
    return r.text;
  });
  return parts.join(` ${cond.combinator} `);
}

/* ============================== helpers ================================= */

/** Short human summary of a condition for the table cell. */
function serializeConditionSummary(cond: ParsedExpression): string {
  if (cond.rules.length === 0) return '';
  return conditionProse(cond);
}
