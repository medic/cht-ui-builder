/**
 * FormEditor — the Phase 0 centerpiece.
 *
 * Loads an XLSForm from the server, lets the user:
 *  - add, remove, reorder (drag or up/down) survey rows
 *  - edit row name, type, required, and all locale labels
 *  - add, remove, reorder choices in a list; edit choice labels
 *  - edit form settings (title, version, default language)
 *  - run dependency analysis on the current order and surface violations
 *
 * Things this editor *deliberately doesn't* touch in Phase 0:
 *  - relevant / calculation / constraint expressions (read-only, displayed but not edited)
 *  - properties.json (saved verbatim if loaded; UI editor lands in P1B)
 */
import { Fragment, useEffect, useMemo, useReducer, useRef, useState, type ReactElement } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  QUESTION_TYPES,
  STRUCTURAL_TYPES,
  SELECT_TYPE_RE,
  computeAuthoringHiddenRowIds,
  isStructural,
  inferFieldKind,
  validateOrdering,
  predictViolationsForMove,
  violationsByRowId,
  diffXlsForms,
  findStructuralViolations,
  planSurveyMove,
  planUngroup,
  defaultInsertIndex,
  extractListName,
  renameListInType,
  renameChoiceValue,
  renameSurveyRow,
  insertContactFieldRef,
  slugifyHierarchyId,
  validateContextExpression,
  type StructuralViolation,
  type FieldKind,
  type OrderingViolation,
  type SurveyRow,
  type ChoiceRow,
  type XLSForm,
  type XLSFormDiff,
  conditionBuilderReducer,
  initialConditionBuilderState,
  isDraftComplete,
  isDraftEmpty,
  isInsertReady,
  serializeBuilderState,
  fieldsTypicalForOp,
  opsTypicalForKind,
  detectStaleLineageBlocks,
  type Clause,
  type ClauseOp,
  type ConditionColumn,
  type ReportFieldChoice,
  type Subgroup,
  inputsBlockRowIds,} from '@cht-ui/shared';
import { api } from '../api.js';
import { useApp } from '../state/store.js';
import { RelevantRuleBuilder } from './RelevantRuleBuilder.js';
import { AppearancePicker } from './AppearancePicker.js';
import { CalculationBuilder } from './CalculationBuilder.js';
import { PropertiesEditor, type FormProperties } from './PropertiesEditor.js';
import { useContactFormFields } from './useContactFormFields.js';
import { useContactSummaryContextKeys } from './useContactSummaryContextKeys.js';
import { FormPreview } from './FormPreview.js';
import { SaveDiffModal } from './SaveDiffModal.js';
import { QuestionTypePicker } from './QuestionTypePicker.js';
import { findTileForRowType } from './QuestionTypeCatalog.js';
import { LineageBuilder } from './LineageBuilder.js';
import { InlineChoicesEditor } from './InlineChoicesEditor.js';
import { ChoiceNameInput } from './ChoiceNameInput.js';
import { InsertLabelRefButton } from './InsertLabelRefButton.js';
import { useHistory } from '../state/useHistory.js';
import { showUndoToast } from './UndoToast.js';

export function FormEditor({ formId }: { formId: string }) {
  const setError = useApp((s) => s.setError);
  const setDirty = useApp((s) => s.setDirty);
  const setSaving = useApp((s) => s.setSaving);
  const dirty = useApp((s) => s.dirty[formId] ?? false);
  const saving = useApp((s) => s.saving[formId] ?? false);

  const formHistory = useHistory<XLSForm>({ onUndo: () => setDirty(formId, true), onRedo: () => setDirty(formId, true) });
  const form = formHistory.current;
  /** Snapshot of the form as it was loaded from disk; used to diff before save. */
  const [originalForm, setOriginalForm] = useState<XLSForm | null>(null);
  const [properties, setProperties] = useState<FormProperties | null>(null);
  const [tab, setTab] = useState<'survey' | 'choices' | 'settings' | 'properties' | 'translate'>(
    'survey',
  );
  const [loading, setLoading] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const [pendingSaveDiff, setPendingSaveDiff] = useState<XLSFormDiff | null>(null);
  // §H3 follow-up — click-to-jump channel. The Structural-issues popover lives in
  // the page header; clicking a row item sets `revealRowId`, which SurveyTab
  // observes to flip into Full mode (structural plumbing is hidden in Simple)
  // and scroll/flash/focus the target row. SurveyTab clears it via
  // `onRevealConsumed` so the same row can be re-clicked later.
  const [revealRowId, setRevealRowId] = useState<string | null>(null);
  const contactForms = useContactFormFields();
  // Tier 1.5 — flatten the contact-form field lists into a single deduped
  // name list for the calc builder's "Contact input field" reference kind.
  // Mirrors the FALLBACK_CONTACT_FIELDS union the builder does internally;
  // exposing the project-discovered list keeps the picker fresh while the
  // fallback covers projects whose contact forms collapse their inputs.
  const inputContactFields = useMemo(() => {
    const set = new Set<string>();
    for (const f of contactForms) for (const n of f.fields) set.add(n);
    return Array.from(set).sort();
  }, [contactForms]);
  const contextKeys = useContactSummaryContextKeys();

  // Load form on mount or when id changes.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getForm(formId)
      .then((res) => {
        if (!alive) return;
        formHistory.reset(res.form);
        // Deep clone so subsequent edits don't mutate the snapshot.
        setOriginalForm(JSON.parse(JSON.stringify(res.form)) as XLSForm);
        setProperties((res.properties ?? null) as FormProperties | null);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId, setError]);

  function patch(next: XLSForm) {
    formHistory.patch(next);
    setDirty(formId, true);
  }
  const undo = formHistory.undo;
  const redo = formHistory.redo;
  const canUndo = formHistory.canUndo;
  const canRedo = formHistory.canRedo;
  // Reset history when the user opens a different form.
  useEffect(() => {
    formHistory.reset(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId]);

  function requestSave() {
    if (!form || !originalForm) return;
    // §A6 — refuse to save an unbalanced survey. The validator is read-only
    // and ran moments ago for the violations banner; re-running here guards
    // against any race where the UI banner lagged a mutation.
    const structural = findStructuralViolations(form.survey);
    if (structural.length > 0) {
      const first = structural[0]!;
      setError(
        `Can't save — the form has unbalanced groups/repeats. First issue: ${first.message}`,
      );
      return;
    }
    // Wave 1 · Note 2 — refuse to write an invalid `context.expression`
    // to properties.json (e.g. an empty age operand, which the inline
    // ContextExpressionBuilder warning surfaces but cannot itself block).
    // Deploy would otherwise choke on `ageInYears(contact) >= ` at
    // `cht-conf compile-app-settings`; catching it here surfaces the
    // author-visible fix at save time.
    const contextExpr = properties?.context?.expression;
    if (typeof contextExpr === 'string') {
      const contextErrors = validateContextExpression(contextExpr);
      if (contextErrors.length > 0) {
        setError(
          `Can't save — properties.json context expression has issues. First: ${contextErrors[0]}`,
        );
        return;
      }
    }
    setPendingSaveDiff(diffXlsForms(originalForm, form));
  }

  async function performSave() {
    if (!form) return;
    setPendingSaveDiff(null);
    setSaving(formId, true);
    try {
      await api.saveForm(formId, form, properties ?? undefined);
      setOriginalForm(JSON.parse(JSON.stringify(form)) as XLSForm);
      setDirty(formId, false);
      // Reset history — what just got saved is the new baseline. Otherwise
      // an undo after save would resurrect un-saved-but-undone state.
      formHistory.reset(form);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(formId, false);
    }
  }

  const violations = useMemo(() => (form ? validateOrdering(form) : []), [form]);
  const violationsByRow = useMemo(() => violationsByRowId(violations), [violations]);
  // §A4 structural-balance — read-only analysis, recomputed on every edit
  // so the banner reflects the current edit immediately. Empty array
  // means a balanced survey.
  const structuralViolations: StructuralViolation[] = useMemo(
    () => (form ? findStructuralViolations(form.survey) : []),
    [form],
  );

  if (loading) return <div className="loading">Loading {formId}…</div>;
  if (!form) return <div className="loading">No form data.</div>;

  return (
    <div className="form-editor">
      <header className="page-header sticky-header">
        <div>
          <h1>{form.settings.form_title ?? form.settings.form_id ?? formId}</h1>
          <code className="form-id">{formId}</code>
        </div>
        <div className="row gap">
          {structuralViolations.length > 0 && (
            <StructuralIssuesBadge
              violations={structuralViolations}
              onJumpToRow={(rowId) => {
                setTab('survey');
                setRevealRowId(rowId);
              }}
            />
          )}
          {violations.length > 0 && (
            <span className="badge warn">{violations.length} ordering issue(s)</span>
          )}
          <button
            className="link"
            onClick={undo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            aria-label="Undo last edit"
          >
            ↶ Undo
          </button>
          <button
            className="link"
            onClick={redo}
            disabled={!canRedo}
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
          >
            ↷ Redo
          </button>
          <button className={showPreview ? 'link active' : 'link'} onClick={() => setShowPreview(!showPreview)}>
            {showPreview ? 'Hide preview' : 'Show preview'}
          </button>
          <button onClick={requestSave} disabled={!dirty || saving}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
          <button
            className="link"
            onClick={() => useApp.getState().setView({ kind: 'deploy' })}
            disabled={dirty}
            title={dirty ? 'Save first to enable deploy' : 'Open Deploy panel — deploy this form to the configured CHT instance'}
          >
            🚀 Deploy
          </button>
        </div>
      </header>

      {pendingSaveDiff && (
        <SaveDiffModal
          diff={pendingSaveDiff}
          onConfirm={() => void performSave()}
          onCancel={() => setPendingSaveDiff(null)}
        />
      )}

      <div className="tabs">
        <button className={tab === 'survey' ? 'active' : ''} onClick={() => setTab('survey')}>
          Survey ({form.survey.length})
        </button>
        <button className={tab === 'choices' ? 'active' : ''} onClick={() => setTab('choices')}>
          Choices ({form.choices.length})
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          Settings
        </button>
        <button className={tab === 'translate' ? 'active' : ''} onClick={() => setTab('translate')}>
          Translate
        </button>
        {properties !== null && (
          <button
            className={tab === 'properties' ? 'active' : ''}
            onClick={() => setTab('properties')}
          >
            Properties
          </button>
        )}
      </div>

      {tab === 'survey' && (
        <div className={`survey-with-preview${showPreview ? ' with-preview' : ''}`}>
          <SurveyTab
            form={form}
            patch={patch}
            undo={undo}
            getSnapshotId={() => formHistory.currentSnapshotId}
            jumpTo={formHistory.jumpTo}
            violationsByRow={violationsByRow}
            inputContactFields={inputContactFields}
            contextKeys={contextKeys}
            revealRowId={revealRowId}
            onRevealConsumed={() => setRevealRowId(null)}
            onRequestReveal={setRevealRowId}
            formCategory={formId.startsWith('contact:') ? 'contact' : 'app'}
            formId={formId}
          />
          {showPreview && (
            <div className="preview-pane">
              <FormPreview form={form} />
            </div>
          )}
        </div>
      )}
      {tab === 'choices' && (
        <ChoicesTab
          form={form}
          patch={patch}
          undo={undo}
          getSnapshotId={() => formHistory.currentSnapshotId}
          jumpTo={formHistory.jumpTo}
        />
      )}
      {tab === 'settings' && <SettingsTab form={form} patch={patch} />}
      {tab === 'translate' && <TranslateTab form={form} patch={patch} />}
      {tab === 'properties' && properties !== null && (
        <PropertiesEditor
          value={properties}
          locales={form.locales.length > 0 ? form.locales : ['en']}
          contactForms={contactForms}
          summaryFlags={contextKeys}
          onChange={(p) => {
            setProperties(p);
            setDirty(formId, true);
          }}
          onClose={() => setTab('survey')}
        />
      )}
    </div>
  );
}

/* ------------------------------ Survey tab ------------------------------ */

/**
 * Page-header badge surfacing the §A4/§A6 structural-balance violations.
 *
 * Pre-fix (punch-list §H3): a non-interactive `<span>` whose detail
 * lived only in `title=` — unreachable by keyboard / touch / screen
 * reader, and only the FIRST of N issues ever reached the error banner
 * via the save guard. Now: a real `<button>` that toggles a focusable
 * popover listing EVERY violation, each naming the implicated row by
 * index and showing the full diagnostic message. Closes via Escape or
 * outside-click; the trigger announces both the count and a screen-
 * reader-friendly aria-expanded.
 */
function StructuralIssuesBadge(props: {
  violations: StructuralViolation[];
  onJumpToRow: (rowId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // eslint-disable-next-line no-undef
  const triggerRef = useRef<HTMLButtonElement>(null);
  // eslint-disable-next-line no-undef
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on Escape or outside-click — minimal popover pattern, no
  // dependency on a UI library. The popover stays anchored to the
  // page-header position via CSS (position: absolute).
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line no-undef
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    // eslint-disable-next-line no-undef
    function onClick(e: MouseEvent) {
      // eslint-disable-next-line no-undef
      const t = e.target as Node | null;
      if (
        popoverRef.current &&
        t &&
        !popoverRef.current.contains(t) &&
        !triggerRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    }
    // eslint-disable-next-line no-undef
    window.addEventListener('keydown', onKey);
    // eslint-disable-next-line no-undef
    window.addEventListener('mousedown', onClick);
    return () => {
      // eslint-disable-next-line no-undef
      window.removeEventListener('keydown', onKey);
      // eslint-disable-next-line no-undef
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const n = props.violations.length;
  return (
    <div className="structural-issues-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="badge danger structural-issues-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${n} structural issue${n === 1 ? '' : 's'} — click for details, save blocked`}
        onClick={() => setOpen((s) => !s)}
      >
        {n} structural issue{n === 1 ? '' : 's'} — save blocked
      </button>
      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Structural issues"
          className="structural-issues-popover"
        >
          <h4>Structural issues — fix before saving</h4>
          <ol>
            {props.violations.map((v) => (
              <li key={`${v.index}-${v.rowId}-${v.kind}`}>
                <button
                  type="button"
                  className="link structural-issue-jump"
                  onClick={() => {
                    props.onJumpToRow(v.rowId);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  <strong>Row {v.index + 1}:</strong> {v.message}
                </button>
              </li>
            ))}
          </ol>
          <p className="muted small">
            Save is blocked until the form is structurally balanced. Click an issue to jump
            to the row (switches to Full mode automatically).
          </p>
        </div>
      )}
    </div>
  );
}

function SurveyTab(props: {
  form: XLSForm;
  patch: (next: XLSForm) => void;
  undo: () => void;
  /** Capture the current snapshot id so toast Undo can jump back exactly. */
  getSnapshotId: () => number;
  jumpTo: (id: number) => void;
  violationsByRow: Map<string, OrderingViolation[]>;
  /** Tier 1.5 — pre-derived contact-input field list + contact-summary
   *  context keys, threaded down to each SurveyRowCard for the calc
   *  builder's reference kinds. */
  inputContactFields: string[];
  contextKeys: string[];
  /** §H3 follow-up — when the page-header Structural-issues popover requests
   *  a jump, FormEditor sets this to the target rowId. The effect below flips
   *  mode to Full (structural rows are hidden in Simple), scrolls the row's
   *  DOM anchor into view, pulses a `.row-flash` outline, and focuses the row
   *  so screen readers announce it. Cleared via `onRevealConsumed` once the
   *  scroll completes so the same row can be re-clicked. */
  revealRowId: string | null;
  onRevealConsumed: () => void;
  /** Upward channel — SurveyTab requests a reveal after a multi-row insert
   *  (e.g. the lineage block) so the existing two-phase mode-flip /
   *  scroll / flash / focus effect in this component handles the rest. */
  onRequestReveal: (rowId: string) => void;
  /** Form category derived from formId (e.g. `app:death_report` → `app`).
   *  Used to filter form-variant-specific tiles in QuestionTypePicker —
   *  notably the `lineage_block` tile that is app-only at v1
   *  (docs/plans/hierarchy-block-generator.md §4.8 + §8.7). */
  formCategory: 'app' | 'contact';
  /** Full form id (`app:iha_assessment`) — the media upload route needs
   *  category + basename to target `forms/<cat>/<basename>-media/`
   *  (geriatric §2). */
  formId: string;
}) {
  const { form, patch, violationsByRow, revealRowId, onRevealConsumed } = props;
  const undo = props.undo;
  // §A4 surfaces structural-violation refusals via the shared error
  // toast so the user sees why a move was blocked.
  const setError = useApp((s) => s.setError);
  const [mode, setMode] = useState<'simple' | 'full'>('simple');

  // §H3 follow-up — click-to-jump effect. Runs when the header popover sets
  // `revealRowId`. Two-phase by design: if we're in Simple, structural rows
  // are hidden, so the first run flips mode to 'full' and returns; React
  // re-runs the effect after the re-render commits and that second run does
  // the actual scroll/flash/focus. We wait one animation frame so the new
  // DOM is painted before querySelector runs (avoids racing the dnd-kit
  // SortableContext re-mount). No-ops gracefully if the row anchor isn't
  // found — an unbalanced survey can render oddly.
  useEffect(() => {
    if (!revealRowId) return;
    if (mode !== 'full') {
      setMode('full');
      return;
    }
    // `CSS` from dnd-kit shadows the global, so reach for the global
    // CSSOM `CSS.escape` via `window`.
    // eslint-disable-next-line no-undef
    const raf = window.requestAnimationFrame(() => {
      const el =
        // eslint-disable-next-line no-undef
        (document.querySelector(
          // eslint-disable-next-line no-undef
          `[data-row-id="${window.CSS.escape(revealRowId)}"]`,
          // eslint-disable-next-line no-undef
        ) as HTMLElement | null);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('row-flash');
        el.focus({ preventScroll: true });
        // eslint-disable-next-line no-undef
        window.setTimeout(() => el.classList.remove('row-flash'), 1600);
      }
      onRevealConsumed();
    });
    return () => {
      // eslint-disable-next-line no-undef
      window.cancelAnimationFrame(raf);
    };
  }, [revealRowId, mode, onRevealConsumed]);
  // Begin-row IDs the user has explicitly TOGGLED via the group header.
  // The set stores "flip from default" intent — a group whose name is in
  // DEFAULT_COLLAPSED_GROUP_NAMES (`inputs`) is collapsed by default and
  // toggling it ADDS its id to flip to expanded; a plain group is expanded
  // by default and toggling it ADDS its id to flip to collapsed. See the
  // `collapsed: …` computation in walkChildren. Keying by begin rowId
  // (not name) lets multiple nested groups share a name without sharing
  // collapse state.
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() => new Set());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Map a field name → ordered list of choice `name`s if it's a select_one /
  // select_multiple, so the expression builder can present a value dropdown.
  // Project-level contact-form choices are merged underneath so contact-
  // injected fields (e.g. `inputs/contact/sex`) get their values too;
  // form-local selects win on collision.
  const contactFieldChoices = useApp((s) => s.project?.contactFieldChoices);
  const fieldChoices = useMemo(
    () => buildFieldChoices(form.survey, form.choices, contactFieldChoices),
    [form.survey, form.choices, contactFieldChoices],
  );
  // Geriatric §1 — the same map WITH labels ({name, label} per choice),
  // for the RelevantRuleBuilder's value dropdowns ("label shown, name
  // stored"). Form-local selects only — contact-injected fields come
  // name-only from the server scan and keep the plain-name display via
  // `fieldChoices` above.
  const fieldChoiceOptions = useMemo(
    () => buildFieldChoiceOptions(form.survey, form.choices, form.surveyHeaders.labelLocales),
    [form.survey, form.choices, form.surveyHeaders.labelLocales],
  );

  // Map field name → FieldKind for the type-aware soft filter (plan v0.3).
  // Choice-upgrade: a row with non-empty `fieldChoices[name]` (a Slice 1
  // contact-injected `select_one` calculate, or this form's own select)
  // classifies as 'choice' regardless of its raw `row.type`, so the op
  // picker keeps `includes`/`does not include` typical for it. Names not
  // present in the survey but present in `fieldChoices` get a defensive
  // 'choice' entry too (they aren't in `fieldOptions`, but it keeps the
  // map consistent for downstream lookups). This is pure render data —
  // never reaches `clauseToRule`/`serializeAnyParsed` (Lal/Developer A5).
  const fieldKinds = useMemo<Record<string, FieldKind>>(() => {
    const out: Record<string, FieldKind> = {};
    for (const r of form.survey) {
      if (!r.name) continue;
      const baseKind = inferFieldKind(r.type);
      const hasChoices = (fieldChoices[r.name]?.length ?? 0) > 0;
      out[r.name] = hasChoices ? 'choice' : baseKind;
    }
    for (const name of Object.keys(fieldChoices)) {
      if (!(name in out)) out[name] = 'choice';
    }
    return out;
  }, [form.survey, fieldChoices]);

  // Group consecutive rows that fall inside a "collapsed" begin/end group block.
  // In Simple mode we don't collapse — we just hide non-user-facing rows.
  // `computeAuthoringHiddenRowIds` is the AUTHOR-side hide set: calculates
  // that merely re-export `../inputs/…` stay hidden (so a fresh Default form
  // still opens empty), but a calculate the author wrote — every cross-form
  // pull — stays visible, which is what makes the Calculate tile usable in
  // Simple mode at all (docs/NEXT.md item 1). The stricter
  // `computeSimpleHiddenRowIds` remains the FHIR workbench's oracle.
  const simpleHiddenIds = useMemo(
    () => (mode === 'simple' ? computeAuthoringHiddenRowIds(form.survey) : new Set<string>()),
    [form.survey, mode],
  );
  const displayItems = buildDisplayItems(form.survey, mode, collapsedGroupIds, simpleHiddenIds);
  // Flatten the recursive tree into the list of row IDs currently
  // visible (expanded). Collapsed groups contribute zero rows (the entire
  // begin..end subtree is hidden from the DndContext).
  const visibleRowIds = useMemo(() => flattenVisibleRowIds(displayItems), [displayItems]);
  const hiddenSimpleCount = simpleHiddenIds.size;

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    // §B2 — all structural decision logic lives in shared/planSurveyMove
    // so it's unit-tested and stays consistent with the §A6 save-guard
    // oracle. The caller is now thin: dispatch, surface error message
    // on reject, prompt for dependency-violation on leaf-ok.
    const plan = planSurveyMove(form.survey, String(active.id), String(over.id));
    if (plan.kind === 'rejected') {
      // Silent no-op for the same-row case; surface the message
      // otherwise so the user sees WHY their drop was refused.
      if (plan.reason !== 'rows-not-found' || String(active.id) !== String(over.id)) {
        setError(plan.message);
      }
      return;
    }

    // Predict dependency violations; if any, confirm with the user.
    // (Skipped for group-as-unit moves — the dependency validator is
    // per-row and a group move's per-row impact is harder to summarize;
    // the save-time validator still catches a broken survey.)
    if (!plan.isGroupMove) {
      const newIndex = form.survey.findIndex((r) => r.rowId === over.id);
      const broken = predictViolationsForMove(form, String(active.id), newIndex);
      if (broken.length > 0) {
        const ok = window.confirm(
          `Moving this row will break dependency on: ${broken.join(', ')}.\n\n` +
            `These fields are referenced in the row's expressions but defined later. Move anyway?`,
        );
        if (!ok) return;
      }
    }
    patch({ ...form, survey: plan.next });
  }

  // Phase-2 picker draft. Held in local state so the row doesn't enter
  // form.survey (and the dnd-kit SortableContext / dependency validator)
  // until the user picks a type. When `pickerMode` is 'edit' the picker
  // re-types the row whose rowId is `pickerEditRowId` instead of inserting.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerEditRowId, setPickerEditRowId] = useState<string | null>(null);
  // Wave 2 §3b — "+ Add section" opens the same picker in section-mode
  // (skips the tile grid, jumps to a label-first section-authoring form).
  // The commit path still routes through `handlePickerCommit`, which auto-
  // pairs begin/end via the existing (unchanged) machinery.
  const [pickerSectionMode, setPickerSectionMode] = useState(false);
  // §A3 — when the user clicks "+ add inside <group>", remember the index
  // we should insert the new row(s) at. `null` means "append to the end"
  // (the legacy default). Cleared after every commit/cancel.
  const [pendingInsertIndex, setPendingInsertIndex] = useState<number | null>(null);
  // Lineage builder modal — opened when the user picks the `lineage_block`
  // tile in QuestionTypePicker. The insert index is captured BEFORE the
  // picker clears `pendingInsertIndex` (otherwise the lineage block
  // silently appends to the form end — see docs/plans/hierarchy-block-
  // generator.md critical gotchas).
  const [lineageBuilderOpen, setLineageBuilderOpen] = useState(false);
  const [lineageInsertIndex, setLineageInsertIndex] = useState<number | null>(null);
  const [lineageHierarchy, setLineageHierarchy] = useState<
    import('./LineageBuilder.js').LineageBuilderHierarchy | null
  >(null);
  const [lineageHierarchyError, setLineageHierarchyError] = useState<string | null>(null);
  // Fetch the project's hierarchy lazily — only when the lineage builder
  // opens. Cached after first fetch; the editor doesn't re-fetch on
  // every open because contact_types rarely change mid-session, and a
  // stale read is preferable to a flash of nothing. The Hierarchy
  // editor's own save invalidates by reloading the panel, which mounts
  // a fresh FormEditor anyway.
  useEffect(() => {
    if (!lineageBuilderOpen || lineageHierarchy || lineageHierarchyError) return;
    let alive = true;
    api
      .getHierarchy()
      .then((h) => {
        if (!alive) return;
        setLineageHierarchy({
          // The API returns contact_types as a loose record; the shape
          // is structurally compatible with ContactTypeNode (id +
          // optional parents + person flag). Trust the server schema.
          contact_types: h.contact_types as unknown as import(
            '@cht-ui/shared'
          ).ContactTypeNode[],
          place_types_display: h.place_types_display,
        });
      })
      .catch((e: Error) => {
        if (!alive) return;
        setLineageHierarchyError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [lineageBuilderOpen, lineageHierarchy, lineageHierarchyError]);

  /** Plan §5 — non-destructive staleness detection. Re-runs whenever the
   *  hierarchy fetch resolves or the survey changes; never auto-rewrites.
   *  An entry per lineage block whose stored signature disagrees with
   *  what `buildHierarchyBlock` would emit today. Surfaced as a yellow
   *  chip on the relevant accordion header. */
  const staleLineageRowIds = useMemo(() => {
    if (!lineageHierarchy) return new Set<string>();
    const drift = detectStaleLineageBlocks(
      form.survey,
      lineageHierarchy.contact_types,
    );
    return new Set(drift.map((d) => d.rowId));
  }, [form.survey, lineageHierarchy]);

  // Trigger a one-time hierarchy fetch on mount so the staleness badge
  // doesn't only appear after the builder modal has been opened. Cached
  // afterwards — see the modal-open effect for re-use semantics.
  useEffect(() => {
    if (lineageHierarchy || lineageHierarchyError) return;
    let alive = true;
    api
      .getHierarchy()
      .then((h) => {
        if (!alive) return;
        setLineageHierarchy({
          contact_types: h.contact_types as unknown as import(
            '@cht-ui/shared'
          ).ContactTypeNode[],
          place_types_display: h.place_types_display,
        });
      })
      .catch((e: Error) => {
        if (!alive) return;
        setLineageHierarchyError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [lineageHierarchy, lineageHierarchyError]);

  /** True when the form has an `inputs/contact` group the lineage block
   *  can splice into. The LineageBuilder modal uses this to render a
   *  non-blocking heads-up when the splice will land somewhere else. */
  const formHasInputsContact = useMemo(() => {
    // Walk the survey looking for `begin group contact` nested inside
    // `begin group inputs`. Cheap structural scan — early-exit when
    // both are found.
    const stack: string[] = [];
    for (const r of form.survey) {
      const t = r.type.trim().toLowerCase();
      if (t === 'begin group' || t === 'begin repeat') {
        stack.push(r.name);
        if (
          r.name === 'contact' &&
          stack.length >= 2 &&
          stack[stack.length - 2] === 'inputs'
        ) {
          return true;
        }
      } else if (t === 'end group' || t === 'end repeat') {
        stack.pop();
      }
    }
    return false;
  }, [form.survey]);
  const existingListNames = useMemo(() => {
    const s = new Set<string>();
    for (const c of form.choices) if (c.list_name) s.add(c.list_name);
    return [...s].sort();
  }, [form.choices]);

  function addQuestion(insertIndex?: number) {
    setPickerEditRowId(null);
    setPendingInsertIndex(insertIndex ?? null);
    setPickerSectionMode(false);
    setPickerOpen(true);
  }

  /**
   * Wave 2 §3b — open the picker in section-authoring mode. Reuses the
   * same commit path (`handlePickerCommit` → begin/end pair splice), so
   * balance / undo / toast machinery is unchanged. Distinguished only by
   * the picker's UX (label-first, no tile grid, appearance toggle).
   */
  function addSection(insertIndex?: number) {
    setPickerEditRowId(null);
    setPendingInsertIndex(insertIndex ?? null);
    setPickerSectionMode(true);
    setPickerOpen(true);
  }

  function handlePickerCommit(commit: import('./QuestionTypePicker.js').PickerCommit) {
    setPickerOpen(false);
    // Wave 2 §3b — the section-mode flag is a picker-only concern; clear
    // it on every commit so the next open of the picker starts in the
    // default (question) flow. Section-authored commits still enter the
    // begin-group branch below via the same shared machinery.
    setPickerSectionMode(false);
    // Lineage handoff — the picker's `lineage_block` tile is a sentinel
    // that opens a second modal (LineageBuilder) instead of committing a
    // single row. Capture `pendingInsertIndex` into a dedicated lineage
    // slot BEFORE clearing it (the picker's normal cleanup would otherwise
    // wipe the insert position and the lineage block would silently
    // append to the form end — docs/plans/hierarchy-block-generator.md
    // critical gotcha).
    if (commit.tileId === 'lineage_block') {
      setLineageInsertIndex(pendingInsertIndex);
      setPendingInsertIndex(null);
      setPickerEditRowId(null);
      setLineageBuilderOpen(true);
      return;
    }
    if (pickerEditRowId) {
      // Edit mode: re-type an existing row. Preserve everything except
      // type and the appearance extras the new tile dictates. Any unrelated
      // extras (relevant/calculation/constraint/etc) are kept intact.
      patch({
        ...form,
        survey: form.survey.map((r) => {
          if (r.rowId !== pickerEditRowId) return r;
          const nextExtras: Record<string, string> = { ...r.extras };
          for (const [k, v] of Object.entries(commit.extras)) {
            if (v) nextExtras[k] = v;
            else delete nextExtras[k];
          }
          return { ...r, type: commit.type, extras: nextExtras };
        }),
      });
      setPickerEditRowId(null);
      return;
    }
    // Add mode: append a new row + (for selects) any inline choice rows.
    const counter = form.survey.length + 1;
    const stamp = `${form.survey.length + 1}`;
    const commitedType = commit.type.trim().toLowerCase();
    const isBeginGroup = commitedType === 'begin group';
    const isBeginRepeat = commitedType === 'begin repeat';

    // §A3 — splice the new row(s) at `pendingInsertIndex` if the user
    // came via "+ add inside" / "+ add row here", otherwise append. Two
    // helpers share the splice so the structural-pair and single-row
    // branches stay symmetric.
    const insertAt = pendingInsertIndex;
    setPendingInsertIndex(null);
    function spliceSurvey(rows: SurveyRow[]): SurveyRow[] {
      if (insertAt === null || insertAt < 0 || insertAt > form.survey.length) {
        return [...form.survey, ...rows];
      }
      return [...form.survey.slice(0, insertAt), ...rows, ...form.survey.slice(insertAt)];
    }

    // Wave 2 §4 — build the seed `labels` map for a new row. Every ACTIVE
    // form locale gets an entry (empty string when the user didn't type
    // one in the picker) so the row is visible in every locale's slot in
    // the translator's grid. §3b's section-mode commit still routes its
    // friendly `commit.label` through the `en` slot when the picker
    // didn't collect a per-locale map (older commit shape).
    const activeLocales = form.surveyHeaders.labelLocales.length > 0
      ? form.surveyHeaders.labelLocales
      : ['en'];
    function seedLabels(sectionFallback?: string): Record<string, string> {
      const out: Record<string, string> = {};
      const provided = commit.labels ?? {};
      for (const loc of activeLocales) {
        out[loc] = provided[loc] ?? '';
      }
      // §3b — section flow may not carry a labels map; seat the friendly
      // label in the form's FIRST ACTIVE locale. Hard-coding `en` here
      // injected a stray `label::en` column into non-en forms and left
      // the title outside the visible locale set (audit P1-6).
      if (sectionFallback !== undefined && !commit.labels) {
        const primary = activeLocales[0] ?? 'en';
        out[primary] = sectionFallback;
      }
      return out;
    }

    // §A1 — committing a structural tile inserts a MATCHED begin/end pair
    // as one edit. The picker only offers the `begin` tile; the user never
    // adds an `end` row directly. Without this, the picker emitted an
    // unbalanced survey that pyxform/cht-conf rejected on deploy
    // (docs/plans/survey-groups-and-scaffold.md §A1).
    if (isBeginGroup || isBeginRepeat) {
      const groupName = commit.name || `g${counter}`;
      // Wave 2 §3b — a section-mode commit carries a friendly LABEL; use
      // it as `labels.en` so the group renders with a real heading in
      // Enketo / CHT (structural rows tolerate label cells — pyxform
      // treats them as the group heading). Wave 2 §4 — additional active
      // locales are seeded as empty strings so a translator sees a
      // missing cell rather than the row dropping from the grid.
      const beginLabels = seedLabels(commit.label ?? '');
      // Ensure every active locale has an entry on the end row (empty
      // string) — pyxform ignores end-row labels but the extras-preserve
      // invariant means we should not synthesize a partial locale map.
      const endLabels: Record<string, string> = {};
      for (const loc of activeLocales) endLabels[loc] = '';
      const beginRow: SurveyRow = {
        rowId: `r_new_${stamp}_${counter}_begin`,
        type: commit.type,
        name: groupName,
        labels: beginLabels,
        required: '',
        extras: { ...commit.extras },
      };
      const endRow: SurveyRow = {
        rowId: `r_new_${stamp}_${counter}_end`,
        type: isBeginGroup ? 'end group' : 'end repeat',
        // CHT-conf convention: the `end` row repeats the group name so that
        // re-serialize keeps it. Some templates omit it; both round-trip.
        name: groupName,
        labels: endLabels,
        required: '',
        extras: {},
      };
      patch({ ...form, survey: spliceSurvey([beginRow, endRow]) });
      return;
    }

    const newRow: SurveyRow = {
      rowId: `r_new_${stamp}_${counter}`,
      type: commit.type,
      name: commit.name || `q${counter}`,
      labels: seedLabels(),
      required: '',
      extras: { ...commit.extras },
    };
    let nextChoices = form.choices;
    if (commit.list && commit.list.choices.length > 0) {
      // Wave 2 §4 — mirror the survey-side per-locale seed for inline
      // choice rows, so a new list's choices don't render a "!" for
      // every non-`en` locale on their first appearance.
      const choiceLocales = form.choicesHeaders.labelLocales.length > 0
        ? form.choicesHeaders.labelLocales
        : activeLocales;
      const additions: ChoiceRow[] = commit.list.choices.map((c, i) => {
        // docs/NEXT.md item F — the picker now collects a label PER LOCALE,
        // so they seat directly. (This used to funnel one label into the
        // default locale, which is why every bilingual list needed a
        // Translate → Choices detour afterwards.) Keys the CHOICES sheet
        // declares but the picker didn't collect are still materialized
        // empty, so nothing drops out of the translator's grid.
        const labels: Record<string, string> = {};
        for (const loc of choiceLocales) labels[loc] = c.labels[loc] ?? '';
        return {
          rowId: `c_new_${stamp}_${i}`,
          list_name: commit.list!.list_name,
          name: c.name || `opt_${i + 1}`,
          labels,
          extras: {},
        };
      });
      nextChoices = [...form.choices, ...additions];
    }
    patch({ ...form, survey: spliceSurvey([newRow]), choices: nextChoices });
  }

  /**
   * Handle the LineageBuilder modal's commit — splice the parent-chain
   * rows into the form, force the post-insert UX traps from the plan
   * (docs/plans/hierarchy-block-generator.md §4 + critical gotchas):
   *   1. Flip mode to Full — rows inside `inputs/` are hidden in Simple.
   *   2. Force-expand `inputs` (default-COLLAPSED) and `contact` so the
   *      user can actually see the new block.
   *   3. Reuse the existing `revealRowId` channel to scroll + flash +
   *      focus the outermost begin-group.
   *   4. Show an UndoToast with a single Undo for the whole splice.
   *
   * Atomicity: one `patch()` call carries the entire splice so undo
   * treats the block as one operation (the §4.1 contract).
   */
  function handleLineageCommit(commit: import('./LineageBuilder.js').LineageCommit) {
    const insertAt = lineageInsertIndex;
    setLineageInsertIndex(null);
    setLineageBuilderOpen(false);

    // Re-key the deterministic rowIds emitted by buildHierarchyBlock
    // (`lineage_0_begin`, `lineage_0_id`, …) so a second insert of the
    // same configuration doesn't collide with rows already on the form.
    // Plan §6: "the insert path re-keys to avoid collisions with existing
    // survey rows". A simple session-monotonic stamp keeps rowIds stable
    // through the rest of this edit session while guaranteeing uniqueness
    // across multiple inserts. The outermost begin-group's rowId is the
    // reveal anchor; we look it up in the rekey map so the upward signal
    // still points at the right row.
    const stamp = `${form.survey.length + 1}_${Math.floor(form.survey.length / 7) + 1}`;
    const rekeyMap = new Map<string, string>();
    const rekeyedRows = commit.rows.map((r) => {
      const next = `r_lineage_${stamp}_${r.rowId}`;
      rekeyMap.set(r.rowId, next);
      return { ...r, rowId: next };
    });
    const rekeyedOutermost =
      commit.outermostBeginRowId && rekeyMap.get(commit.outermostBeginRowId);

    // Snapshot id BEFORE patching, so the toast's Undo jumps back to
    // exactly that state regardless of edits the user makes before
    // clicking Undo (matches removeRow's pattern).
    const snapshotId = props.getSnapshotId();

    const nextSurvey =
      insertAt === null || insertAt < 0 || insertAt > form.survey.length
        ? [...form.survey, ...rekeyedRows]
        : [
            ...form.survey.slice(0, insertAt),
            ...rekeyedRows,
            ...form.survey.slice(insertAt),
          ];
    patch({ ...form, survey: nextSurvey });

    // Post-insert UX — every step is mandated by the plan's critical
    // gotchas list.
    //
    // (a) Mode flip — rows in `inputs/` are hidden in Simple. Without
    //     this, the user sees nothing change on click and reads it as
    //     a broken button.
    if (mode === 'simple') setMode('full');
    // (b) Force-expand `inputs` (in DEFAULT_COLLAPSED_GROUP_NAMES so its
    //     default state is COLLAPSED) and `contact` (default-expanded,
    //     but the user may have toggled it shut earlier). The collapse
    //     state stores "flip from default" intent: adding a default-
    //     collapsed group's begin-rowId expands it; removing a default-
    //     expanded group's begin-rowId restores its default expanded
    //     state. The lineage block lives inside `inputs/contact`, so
    //     surface both.
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      for (const r of nextSurvey) {
        const t = r.type.trim().toLowerCase();
        if (t !== 'begin group') continue;
        const isDefaultCollapsed = DEFAULT_COLLAPSED_GROUP_NAMES.has(r.name);
        if (r.name === 'inputs') {
          // Default-collapsed → ADD to flip to expanded.
          if (isDefaultCollapsed) next.add(r.rowId);
          else next.delete(r.rowId);
        } else if (r.name === 'contact') {
          // Default-expanded → REMOVE from set to ensure expanded.
          if (isDefaultCollapsed) next.add(r.rowId);
          else next.delete(r.rowId);
        }
      }
      return next;
    });
    // (c) Reveal the outermost begin-group — the existing `revealRowId`
    //     channel handles two-phase scroll/flash/focus (and force-flips
    //     mode to Full if (a) didn't already). Use the RE-KEYED rowId
    //     so the querySelector matches the row actually in the DOM.
    if (rekeyedOutermost) props.onRequestReveal(rekeyedOutermost);
    // (d) Toast — plan §4.1 mandates: "Added contact + N ancestor levels
    //     (N hidden linking rows CHT fills in automatically — health
    //     workers won't see them)." The hidden-row explanation is the
    //     load-bearing copy that prevents Bhishan's cold-start
    //     abandonment trigger ("I clicked the button and nothing
    //     changed"). Undo restores via `props.jumpTo(snapshotId)` so the
    //     stored snapshot wins over any later edits — matches removeRow.
    const d = commit.summary.depth;
    const levels = d === 0
      ? 'the contact link only'
      : `${d} ancestor level${d === 1 ? '' : 's'}`;
    // buildHierarchyBlock only emits `hidden` plus begin/end group rows
    // (no `calculate` — the existing scaffold owns those). Count just the
    // hidden plumbing rows so the toast's row count reflects what the
    // user will actually NOT see in the rendered form.
    const hiddenRowCount = rekeyedRows.filter(
      (r) => r.type.trim().toLowerCase() === 'hidden',
    ).length;
    const hiddenSuffix =
      hiddenRowCount > 0
        ? ` (${hiddenRowCount} hidden row${hiddenRowCount === 1 ? '' : 's'} CHT fills in automatically — health workers won't see them)`
        : '';
    showUndoToast({
      message: `Added "${commit.summary.leafLabel}" lineage — ${levels}${hiddenSuffix}`,
      onUndo: () => props.jumpTo(snapshotId),
    });
  }

  function openTypePickerFor(rowId: string) {
    setPickerEditRowId(rowId);
    setPickerOpen(true);
  }

  function updateRow(rowId: string, updater: (r: SurveyRow) => SurveyRow) {
    patch({
      ...form,
      survey: form.survey.map((r) => (r.rowId === rowId ? updater(r) : r)),
    });
  }

  function removeRow(rowId: string) {
    if (!form) return;
    const row = form.survey.find((r) => r.rowId === rowId);
    const label = row?.name || row?.type || rowId;
    // Capture the pre-delete snapshot id BEFORE patching, so the toast Undo
    // jumps back to exactly that state even if the user makes other edits
    // before clicking Undo.
    const snapshotId = props.getSnapshotId();
    patch({ ...form, survey: form.survey.filter((r) => r.rowId !== rowId) });
    showUndoToast({
      message: `Deleted "${label}"`,
      onUndo: () => props.jumpTo(snapshotId),
    });
  }

  function moveRow(rowId: string, direction: -1 | 1) {
    const idx = form.survey.findIndex((r) => r.rowId === rowId);
    if (idx < 0) return;
    const newIndex = idx + direction;
    if (newIndex < 0 || newIndex >= form.survey.length) return;
    const targetRowId = form.survey[newIndex]!.rowId;

    // §B2 — share the §A4 structural decision with onDragEnd via the
    // shared planner. The dependency-violation prompt stays here (the
    // planner doesn't know about the dependency validator).
    const plan = planSurveyMove(form.survey, rowId, targetRowId);
    if (plan.kind === 'rejected') {
      setError(plan.message);
      return;
    }
    if (!plan.isGroupMove) {
      const broken = predictViolationsForMove(form, rowId, newIndex);
      if (broken.length > 0) {
        const ok = window.confirm(
          `Moving this row will break dependency on: ${broken.join(', ')}. Move anyway?`,
        );
        if (!ok) return;
      }
    }
    patch({ ...form, survey: plan.next });
  }

  function toggleGroup(beginRowId: string) {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      // Stored as a "flip from default" intent — see DEFAULT_COLLAPSED_GROUP_NAMES.
      if (next.has(beginRowId)) next.delete(beginRowId);
      else next.add(beginRowId);
      return next;
    });
  }

  /**
   * §A5 Ungroup — remove the begin/end shell of a group, leaving its
   * children at the parent depth. Refuses if the input is unbalanced
   * (the begin has no matching end) — the §A6 banner already tells the
   * user to fix the imbalance first. Children stay in survey order, just
   * with the structural rows excised.
   *
   * (The plan also locks a "Group these" wrap affordance for N contiguous
   * rows; that requires a multi-select mechanism not in the editor yet
   * and is deferred to a follow-up slice. Plan §A5 wrap.)
   */
  function ungroup(beginRowId: string) {
    // §B2 — delegate to shared/planUngroup so the operation is unit-tested
    // and uses the same balance oracle the §A6 save-guard does.
    const plan = planUngroup(form.survey, beginRowId);
    if (plan.kind === 'rejected') {
      setError(plan.message);
      return;
    }
    patch({ ...form, survey: plan.next });
  }

  /**
   * Render a `DisplayItem` — a flat row card, or a (potentially nested)
   * group container that recursively renders its children. Pulled out so
   * the rendering walk can mirror the recursive `buildDisplayItems` walk
   * verbatim and so a group's children can themselves include groups
   * (plan §A2).
   */
  function renderItem(item: DisplayItem): ReactElement {
    if (item.kind === 'row') {
      const row = item.row;
      const idx = form.survey.findIndex((r) => r.rowId === row.rowId);
      // Rows inside the `inputs` block are withheld, and the list is deduped.
      // Both matter for the same reason: `${x}` resolves by NAME across the
      // whole survey, and the inputs block deliberately reuses names from
      // outside it — the scaffold has `inputs/user/name` and
      // `inputs/contact/name`, plus `inputs/contact/patient_id` next to a
      // top-level calculate called `patient_id`. Offering those let one click
      // splice a `${name}` that pyxform refuses to resolve, failing the whole
      // project. The harvest calculate is the sanctioned way to reach an input
      // and it sits outside the block, so it is still offered.
      const plumbingIds = inputsBlockRowIds(form.survey);
      // Only names that will actually RESOLVE. Withholding the inputs block is
      // not sufficient on its own: the scaffold's top-level `patient_id`
      // calculate shares its name with `inputs/contact/patient_id`, so
      // `${patient_id}` is ambiguous however few times the picker lists it.
      // The author who wants that value uses the contact-field insert, which
      // creates a uniquely-named harvest row.
      const nameCount = new Map<string, number>();
      for (const r of form.survey) {
        if (isStructural(r) || !r.name) continue;
        nameCount.set(r.name, (nameCount.get(r.name) ?? 0) + 1);
      }
      const earlierFields = [
        ...new Set(
          form.survey
            .slice(0, idx)
            .filter(
              (r) =>
                !isStructural(r) &&
                r.name &&
                !plumbingIds.has(r.rowId) &&
                nameCount.get(r.name) === 1,
            )
            .map((r) => r.name),
        ),
      ];
      return (
        <SurveyRowCard
          key={row.rowId}
          row={row}
          locales={form.surveyHeaders.labelLocales}
          violations={violationsByRow.get(row.rowId) ?? []}
          fieldOptions={earlierFields}
          fieldChoices={fieldChoices}
          fieldChoiceOptions={fieldChoiceOptions}
          fieldKinds={fieldKinds}
          formId={props.formId}
          inputContactFields={props.inputContactFields}
          contextKeys={props.contextKeys}
          form={form}
          patch={patch}
          update={(u) => updateRow(row.rowId, u)}
          remove={() => removeRow(row.rowId)}
          moveUp={() => moveRow(row.rowId, -1)}
          moveDown={() => moveRow(row.rowId, 1)}
          onChangeType={() => openTypePickerFor(row.rowId)}
        />
      );
    }
    // Group container — recursive. The begin/end rows are NOT rendered as
    // independent cards; their content (name + structural kind) is folded
    // into the header. Each nesting level indents its children by the CSS
    // padding-left on `.survey-group-children` (cumulative through the
    // DOM, so a depth-3 group is indented 3×).
    return (
      <SurveyGroupAccordion
        key={item.beginRowId}
        item={item}
        renderItem={renderItem}
        toggleGroup={toggleGroup}
        addQuestion={addQuestion}
        ungroup={ungroup}
        formSurvey={form.survey}
        staleLineageRowIds={staleLineageRowIds}
        updateRow={updateRow}
      />
    );
  }

  // Wave 2 §4 — Add-language handler. Registers a new locale on the form
  // (both the survey and choices sheets) and materializes a
  // `translations/messages-<locale>.properties` file on disk so the
  // Translate tab picks it up on next refresh. Idempotent: adding a
  // locale that already exists is a no-op. The server call is
  // fire-and-forget; failures surface via the shared error toast but
  // don't roll back the in-memory locale add (the user can still author
  // labels; a missing .properties file just means CHT falls back to key
  // text at runtime).
  function addLocale(locale: string): void {
    const norm = locale.trim().toLowerCase();
    if (!norm) return;
    // Already present — nothing to do.
    if (
      form.locales.includes(norm) &&
      form.surveyHeaders.labelLocales.includes(norm) &&
      form.choicesHeaders.labelLocales.includes(norm)
    ) {
      return;
    }
    const nextLocales = form.locales.includes(norm) ? form.locales : [...form.locales, norm];
    const nextSurveyLL = form.surveyHeaders.labelLocales.includes(norm)
      ? form.surveyHeaders.labelLocales
      : [...form.surveyHeaders.labelLocales, norm];
    const nextChoicesLL = form.choicesHeaders.labelLocales.includes(norm)
      ? form.choicesHeaders.labelLocales
      : [...form.choicesHeaders.labelLocales, norm];
    patch({
      ...form,
      locales: nextLocales,
      surveyHeaders: { ...form.surveyHeaders, labelLocales: nextSurveyLL },
      choicesHeaders: { ...form.choicesHeaders, labelLocales: nextChoicesLL },
    });
    // Kick off the messages-<locale>.properties creation in the
    // background. Doesn't block the UI edit; failures surface via the
    // shared error toast, and the file can be re-created by clicking
    // Add-language again (idempotent on the server too).
    void api
      .putTranslations(norm, [])
      .catch((e: Error) => setError(`Could not create messages-${norm}.properties: ${e.message}`));
  }

  return (
    <div className="survey-tab">
      {/* Wave 2 §4 — language chip bar. Shows the form's active locales
          as read-only chips + a "+ Add language" affordance that opens a
          curated locale picker (ISO 639-1 shortlist + free-text
          escape hatch). Adding a locale threads through `addLocale`
          which mutates `form.locales`/`labelLocales` for both sheets AND
          calls the server to create the .properties file. Missing state
          cue (the "!" glyph pattern from TranslationsEditor) is
          surfaced at the row-card label inputs — a chip here just names
          the locale. */}
      <LanguageChipBar locales={form.surveyHeaders.labelLocales} onAdd={addLocale} />

      <div className="row gap toolbar">
        <button onClick={() => addQuestion(defaultInsertIndex(form.survey))}>+ Question</button>
        {/* Wave 2 §3b — a first-class "+ Add section" toolbar entry beside
             "+ Question". Section-heavy forms (geriatric assessment, ANC)
             were unbuildable end-to-end when the Group tile was hidden in
             Simple mode; surfacing this as a peer toolbar action means a
             no-code author never has to know about the Structure category.
             The commit path routes through `handlePickerCommit` (begin+end
             pair splice, unchanged). */}
        <button
          onClick={() => addSection(defaultInsertIndex(form.survey))}
          title="Add a section (labelled group of related questions) or a repeat (asked once per item)"
        >
          + Section
        </button>
        <div className="row gap mode-toggle">
          <button
            className={mode === 'simple' ? 'active' : 'link'}
            onClick={() => setMode('simple')}
            title="Show only user-facing questions and notes"
          >
            Simple
          </button>
          <button
            className={mode === 'full' ? 'active' : 'link'}
            onClick={() => setMode('full')}
            title="Show every row including groups, hidden, calculate, and inputs"
          >
            Full
          </button>
        </div>
        {/* Only show the "N plumbing rows hidden" hint when there ARE
            visible rows. When Simple mode is empty (a freshly-scaffolded
            Default form), the empty-state below carries the message
            instead — §B1 cold-start fix. */}
        {mode === 'simple' && hiddenSimpleCount > 0 && displayItems.length > 0 && (
          <span className="muted small">
            {hiddenSimpleCount} plumbing row{hiddenSimpleCount === 1 ? '' : 's'} hidden (structural, hidden, inputs/ calculates) — switch to Full to edit.
          </span>
        )}
        {mode === 'full' && (
          <span className="muted small">
            Drag rows to reorder. Group drag handles move the whole group as one unit.
            Reorder is blocked if it would break dependencies or unbalance the form.
          </span>
        )}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={visibleRowIds} strategy={verticalListSortingStrategy}>
          <div className="survey-list">{displayItems.map(renderItem)}</div>
        </SortableContext>
      </DndContext>

      {/* §B1 — positive empty-state for the cold-start case. Simple
          mode + zero visible rows means either a freshly-scaffolded
          Default form (real plumbing exists, user just hasn't added
          questions yet) or a Blank form. Either way the right message
          is encouragement, not a "N rows hidden" warning. */}
      {mode === 'simple' && displayItems.length === 0 && (
        <div className="survey-empty-state">
          {hiddenSimpleCount > 0 ? (
            <>
              <p>
                <strong>Your form is ready.</strong> The standard patient-linking setup is in
                place ({hiddenSimpleCount} plumbing row
                {hiddenSimpleCount === 1 ? '' : 's'} — view in Full mode).
              </p>
              <p className="muted">Add your first question to start authoring.</p>
            </>
          ) : (
            <p className="muted">
              No questions yet. Click <strong>+ Question</strong> to add your first row.
            </p>
          )}
          <button
            type="button"
            className="primary"
            onClick={() => addQuestion(defaultInsertIndex(form.survey))}
          >
            + Add your first question
          </button>
        </div>
      )}

      {pickerOpen && (
        <QuestionTypePicker
          title={
            pickerSectionMode
              ? 'Add section or repeat'
              : pickerEditRowId
                ? 'Change question type'
                : 'Add question'
          }
          commitLabel={
            pickerSectionMode
              ? 'Add section'
              : pickerEditRowId
                ? 'Change type'
                : 'Add question'
          }
          mode={mode}
          sectionMode={pickerSectionMode}
          formCategory={props.formCategory}
          existingLists={existingListNames}
          // Wave 2 §4 — thread the form's active locales so the picker
          // renders one label input per locale at add-time. Fallback to
          // `en` if the form has never declared any (blank scaffolds).
          labelLocales={
            form.surveyHeaders.labelLocales.length > 0
              ? form.surveyHeaders.labelLocales
              : ['en']
          }
          hideNameField={Boolean(pickerEditRowId)}
          initialName={
            pickerEditRowId
              ? form.survey.find((r) => r.rowId === pickerEditRowId)?.name ?? ''
              : ''
          }
          initialTileId={
            pickerEditRowId
              ? findTileForRowType(
                  form.survey.find((r) => r.rowId === pickerEditRowId)?.type ?? '',
                  form.survey.find((r) => r.rowId === pickerEditRowId)?.extras['appearance'] ?? '',
                )?.id
              : undefined
          }
          defaultListNameSeed={pickerEditRowId ? undefined : undefined}
          onCancel={() => {
            setPickerOpen(false);
            setPickerEditRowId(null);
            setPendingInsertIndex(null);
            setPickerSectionMode(false);
          }}
          onCommit={handlePickerCommit}
        />
      )}

      {lineageBuilderOpen && (
        <>
          {lineageHierarchyError && (
            <div className="qtype-backdrop">
              <div className="qtype-modal lineage-builder-modal" role="dialog">
                <div className="qtype-header">
                  <h2>Couldn't load hierarchy</h2>
                </div>
                <p className="error-banner">{lineageHierarchyError}</p>
                <div className="qtype-actions">
                  <button
                    onClick={() => {
                      setLineageBuilderOpen(false);
                      setLineageInsertIndex(null);
                      setLineageHierarchyError(null);
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
          {!lineageHierarchyError && lineageHierarchy && (
            <LineageBuilder
              hierarchy={lineageHierarchy}
              formHasInputsContact={formHasInputsContact}
              onCancel={() => {
                setLineageBuilderOpen(false);
                setLineageInsertIndex(null);
              }}
              onCommit={handleLineageCommit}
            />
          )}
          {!lineageHierarchyError && !lineageHierarchy && (
            <div className="qtype-backdrop">
              <div className="qtype-modal lineage-builder-modal" role="dialog">
                <div className="qtype-header">
                  <h2>Add contact + ancestor lineage</h2>
                </div>
                <p className="muted">Loading project hierarchy…</p>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Group `name`s that start collapsed by default in Full mode. `inputs` is
 * the CHT plumbing block (`contact.*`/`user.*`-driven calculates) every
 * deployed form carries — almost never edited, so the editor tucks it away.
 * Other groups start expanded; the user can collapse any of them via the
 * group header.
 */
const DEFAULT_COLLAPSED_GROUP_NAMES = new Set(['inputs']);

/**
 * Recursively count every `kind: 'group'` DisplayItem under a given
 * subtree. Used by the lineage-block header to derive "N levels" from
 * the structural shape (rather than parsing the signature string).
 * Counts every nested begin/end pair — for a depth-3 lineage chain this
 * returns 2 (the 2 inner `parent` groups; the outermost itself is the
 * one calling this helper, so it adds itself externally).
 */
function countBeginGroups(items: DisplayItem[], acc: number): number {
  for (const i of items) {
    if (i.kind === 'group') {
      acc = countBeginGroups(i.children, acc + 1);
    }
  }
  return acc;
}

/** True for select_one / select_multiple / rank rows (list-bearing types). */
function isSelectRow(row: SurveyRow): boolean {
  const head = row.type.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return head === 'select_one' || head === 'select_multiple' || head === 'rank';
}

/**
 * Map a raw `row.type` cell (+ optional appearance) back to a human-friendly
 * tile label so the chip in SurveyRowCard reads as "Select one" instead of
 * "select_one yes_no". Falls back to the raw type when no catalog entry
 * matches (preserving the round-trip raw fallback for unrecognized types).
 */
function prettyTypeLabel(rawType: string, appearance: string): string {
  if (!rawType) return '(no type)';
  const tile = findTileForRowType(rawType, appearance);
  return tile?.label ?? rawType;
}

/**
 * Recursive display item — what the renderer walks. A `'row'` is a flat
 * survey row at the given `depth`; a `'group'` wraps its children
 * recursively and exposes the begin/end rowIds so drag/insert affordances
 * can find both bounds. Plan: docs/plans/survey-groups-and-scaffold.md §A2.
 */
type DisplayItem =
  | { kind: 'row'; row: SurveyRow; depth: number }
  | {
      kind: 'group';
      /** Group `name` (lifted from the begin row). Empty when the begin row
       *  has no name — still renders, just without a label chip. */
      name: string;
      /** `begin group` vs `begin repeat` — the renderer styles them
       *  differently and the "+ add inside" wording stays the same. */
      structuralType: 'group' | 'repeat';
      depth: number;
      /** Stable id of the begin row — used as the collapse-state key and
       *  React list key. */
      beginRowId: string;
      /** Stable id of the matching end row — needed by §A3 positional
       *  insert (place new rows at endRow's index) and §A4 group-as-unit
       *  drag (the begin..end slice is the unit). */
      endRowId: string;
      /** Number of rows strictly inside the group (excludes begin + end).
       *  Used by the collapsed-state header summary. */
      innerRowCount: number;
      children: DisplayItem[];
      collapsed: boolean;
      /** Set on lineage-generated outermost begin-groups (the ones
       *  buildHierarchyBlock stamps with `extras['cht-ui-lineage']`).
       *  When present the accordion renders with a friendly
       *  "Contact lineage (auto-generated)" label + a level count, and
       *  defaults to collapsed so the user sees "one tidy thing, not 21
       *  scary rows" (plan §4.4). The stored signature value lets us
       *  surface staleness drift downstream (§5). */
      lineageSignature?: string;
    };

// §B1 — `defaultInsertIndex` was lifted into shared (surveyEdits.ts) so
// the "insert before trailing linking calculates" contract is unit-
// testable. See defaultInsertIndex docs there.

/** Walk a `DisplayItem[]` tree and return every row ID currently
 *  visible (expanded). Collapsed groups contribute zero rows — the entire
 *  begin..end subtree is hidden from the DndContext + sortable. */
function flattenVisibleRowIds(items: DisplayItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === 'row') {
      out.push(it.row.rowId);
    } else if (!it.collapsed) {
      out.push(it.beginRowId);
      out.push(...flattenVisibleRowIds(it.children));
      out.push(it.endRowId);
    }
    // Collapsed groups contribute nothing — neither the begin/end pair
    // nor the children — so a sortable can't accidentally drop a row
    // inside a hidden group.
  }
  return out;
}

function buildDisplayItems(
  survey: SurveyRow[],
  mode: 'simple' | 'full',
  collapsedGroupIds: Set<string>,
  simpleHiddenIds: Set<string>,
): DisplayItem[] {
  if (mode === 'simple') {
    // Simple mode stays flat — structural rows are hidden via
    // simpleHiddenIds, and the user-facing rows render at depth 0.
    return survey
      .filter((r) => !simpleHiddenIds.has(r.rowId))
      .map((row): DisplayItem => ({ kind: 'row', row, depth: 0 }));
  }
  // Full mode — recursive depth-aware walk. Every balanced begin…end becomes
  // a nestable container; unbalanced surveys still walk safely (a stray
  // begin's children list keeps growing until the survey ends, and the
  // §A4 validator surfaces the imbalance via the page-header banner).
  const ctx = { survey, collapsedGroupIds, index: 0 };
  return walkChildren(ctx, 0);
}

interface WalkCtx {
  survey: SurveyRow[];
  collapsedGroupIds: Set<string>;
  index: number;
}

/** Walk forward from `ctx.index`, collecting display items at `depth`,
 *  until we hit a matching `end` (or run out of rows). The caller advances
 *  past the `end` row itself. */
function walkChildren(ctx: WalkCtx, depth: number): DisplayItem[] {
  const items: DisplayItem[] = [];
  while (ctx.index < ctx.survey.length) {
    const row = ctx.survey[ctx.index]!;
    const t = row.type.trim().toLowerCase();
    if (t === 'end group' || t === 'end repeat') {
      // Don't consume the end row — the caller (a recursive ascent or the
      // top-level loop) advances past it after the recursive return.
      return items;
    }
    if (t === 'begin group' || t === 'begin repeat') {
      const beginRow = row;
      const structuralType: 'group' | 'repeat' = t === 'begin group' ? 'group' : 'repeat';
      ctx.index++; // consume the begin row
      const children = walkChildren(ctx, depth + 1);
      // Either we hit a matching end (at ctx.index) or fell off the survey
      // (unbalanced). In the balanced case advance past the end row; in
      // the unbalanced case `endRow` is the last row we touched and we
      // leave it to the §A4 validator to surface.
      const endRow: SurveyRow | undefined = ctx.survey[ctx.index];
      if (endRow) {
        const endT = endRow.type.trim().toLowerCase();
        if (endT === 'end group' || endT === 'end repeat') ctx.index++;
      }
      // Plan §4.4 — the outermost `begin group parent` of a lineage block
      // is stamped with `extras['cht-ui-lineage']`. When that stamp is
      // present, the accordion is rendered as one tidy collapsed unit
      // labeled "Contact lineage (auto-generated)" rather than the bare
      // `parent` name. The signature also lets a later staleness check
      // surface drift (§5).
      const lineageSignature = beginRow.extras['cht-ui-lineage'];
      items.push({
        kind: 'group',
        name: beginRow.name,
        structuralType,
        depth,
        beginRowId: beginRow.rowId,
        endRowId: endRow ? endRow.rowId : beginRow.rowId,
        innerRowCount: children.length,
        children,
        // Collapse-state convention: a group is collapsed by default iff
        // its `name` is in DEFAULT_COLLAPSED_GROUP_NAMES (the CHT `inputs`
        // plumbing block) OR it carries a lineage signature (plan §4.4 —
        // "render as one collapsible unit"). The user-toggled set FLIPS
        // that default — toggling an `inputs` or lineage group EXPANDS
        // it, toggling a plain group COLLAPSES it.
        collapsed: (() => {
          const defaultCollapsed =
            DEFAULT_COLLAPSED_GROUP_NAMES.has(beginRow.name) || Boolean(lineageSignature);
          const userToggled = ctx.collapsedGroupIds.has(beginRow.rowId);
          return userToggled ? !defaultCollapsed : defaultCollapsed;
        })(),
        lineageSignature,
      });
      continue;
    }
    items.push({ kind: 'row', row, depth });
    ctx.index++;
  }
  return items;
}

/**
 * Render a (potentially nested) group accordion as a sortable unit.
 * The group as a whole is a useSortable target with the begin row's id;
 * its drag handle moves the entire begin..end slice (§A4 group-as-unit
 * drag) via the slice-aware onDragEnd handler in SurveyTab. The
 * children are rendered recursively through `renderItem` so nesting
 * keeps working at any depth.
 */
function SurveyGroupAccordion(props: {
  item: Extract<DisplayItem, { kind: 'group' }>;
  renderItem: (item: DisplayItem) => ReactElement;
  toggleGroup: (beginRowId: string) => void;
  addQuestion: (insertIndex?: number) => void;
  ungroup: (beginRowId: string) => void;
  formSurvey: SurveyRow[];
  /** RowIds of lineage-stamped begin-groups whose stored signature
   *  disagrees with the current hierarchy (plan §5). The header renders
   *  a non-destructive yellow chip on these rows so the author knows to
   *  re-open the LineageBuilder to regenerate. */
  staleLineageRowIds: Set<string>;
  /** Wave 2 §3b — mutate the begin row for the "Show all on one screen"
   *  toggle. Persists via `extras.appearance = 'field-list'`. */
  updateRow: (rowId: string, updater: (r: SurveyRow) => SurveyRow) => void;
}) {
  const { item } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.beginRowId });
  const style: import('react').CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  const isCollapsed = item.collapsed;
  const kindLabel =
    item.structuralType === 'repeat' ? 'begin repeat → end repeat' : 'begin group → end group';
  // Plan §4.4 — when this group is the outermost row of a lineage block
  // (carries `cht-ui-lineage` extras stamp), render it with a friendly
  // label + a level count and treat it as one tidy collapsible unit. The
  // underlying `name` is still `parent` for pyxform — only the displayed
  // header changes.
  const isLineageBlock = Boolean(item.lineageSignature);
  // Count nested `parent` group depth — equal to the lineage chain length
  // the author originally requested. The signature would be the canonical
  // source, but it's encoded; counting structurally avoids decoding the
  // signature format here.
  const lineageLevels = isLineageBlock
    ? countBeginGroups(item.children, 0) + 1
    : 0;

  // Wave 2 §3b — read the begin row so the header can render the
  // "Show all on one screen" toggle. The appearance cell is a
  // space-separated token list in XLSForm, so we treat presence of
  // `field-list` as the switch. Toggling preserves any other tokens
  // the user (or a future tile) may have set.
  const beginRow = props.formSurvey.find((r) => r.rowId === item.beginRowId);
  // First non-empty label across the row's locales, in column order.
  const groupTitle = beginRow
    ? Object.values(beginRow.labels).find((v) => v && v.trim() !== '')
    : undefined;
  const appearanceTokens = (beginRow?.extras['appearance'] ?? '')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const isFieldList = appearanceTokens.includes('field-list');
  function toggleFieldList(nextEnabled: boolean) {
    props.updateRow(item.beginRowId, (r) => {
      const tokens = (r.extras['appearance'] ?? '')
        .split(/\s+/)
        .filter((t) => t.length > 0);
      const rest = tokens.filter((t) => t !== 'field-list');
      const nextTokens = nextEnabled ? [...rest, 'field-list'] : rest;
      const nextExtras = { ...r.extras };
      if (nextTokens.length === 0) {
        delete nextExtras['appearance'];
      } else {
        nextExtras['appearance'] = nextTokens.join(' ');
      }
      return { ...r, extras: nextExtras };
    });
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`survey-group-accordion depth-${item.depth}${isLineageBlock ? ' lineage-block' : ''}`}
      data-structural-type={item.structuralType}
      data-row-id={item.beginRowId}
      tabIndex={-1}
    >
      <div className="survey-group-header-row">
        <button
          type="button"
          className="drag-handle group-drag-handle"
          aria-label={`Drag group "${item.name || '(unnamed)'}" — moves the whole group as one unit`}
          title="Drag to move the whole group as one unit"
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
        <button
          type="button"
          className="survey-group-header"
          onClick={() => props.toggleGroup(item.beginRowId)}
          aria-expanded={!isCollapsed}
          aria-controls={`group-children-${item.beginRowId}`}
          title={isCollapsed ? 'Expand group' : 'Collapse group'}
        >
          <span className="caret" aria-hidden="true">
            {isCollapsed ? '▸' : '▾'}
          </span>
          {isLineageBlock ? (
            <>
              <span className="lineage-block-label">
                🌳 Contact lineage <span className="muted small">(auto-generated)</span>
              </span>
              <span className="muted small">
                {lineageLevels} level{lineageLevels === 1 ? '' : 's'} — {item.innerRowCount}{' '}
                hidden row{item.innerRowCount === 1 ? '' : 's'}
              </span>
              {props.staleLineageRowIds.has(item.beginRowId) && (
                <span
                  className="lineage-stale-badge"
                  title="Hierarchy changed since this block was generated — re-open the lineage builder to refresh."
                >
                  ⚠ may be stale
                </span>
              )}
            </>
          ) : (
            <>
              {/* Wave 2 §3b — surface the friendly label when a section
                   carries one (label-first section-authoring); fall back
                   to the raw slug when no label was authored (existing
                   parsed forms). Falls through the row's locales in
                   column order — hard-coding `en` hid the title on
                   non-en forms (audit P1-6). */}
              {groupTitle ? (
                <>
                  <span className="survey-group-title">{groupTitle}</span>
                  <span className="muted small">
                    <code>{item.name || '(unnamed)'}</code> · {item.innerRowCount} row
                    {item.innerRowCount === 1 ? '' : 's'} inside ({kindLabel})
                  </span>
                </>
              ) : (
                <>
                  <code>{item.name || '(unnamed)'}</code>
                  <span className="muted small">
                    {item.innerRowCount} row{item.innerRowCount === 1 ? '' : 's'} inside ({kindLabel})
                  </span>
                </>
              )}
            </>
          )}
        </button>
        {/* Wave 2 §3b — "Show all on one screen" toggles the XLSForm
             `field-list` appearance on the begin-group row. Only exposed
             for `begin group` (not `begin repeat`, where field-list
             semantics differ). Lineage blocks hide the toggle — their
             appearance is auto-generated. */}
        {item.structuralType === 'group' && !isLineageBlock && (
          <label
            className="group-appearance-toggle muted small"
            title="Render every question in this section on the same screen (XLSForm field-list appearance)."
          >
            <input
              type="checkbox"
              checked={isFieldList}
              onChange={(e) => toggleFieldList(e.target.checked)}
            />{' '}
            Show all on one screen
          </label>
        )}
        {/* §A5 Ungroup — removes the begin/end shell, keeping children
            at the parent depth. Hidden behind a low-emphasis link so it
            doesn't compete with the header's collapse toggle. */}
        <button
          type="button"
          className="link group-ungroup"
          onClick={() => props.ungroup(item.beginRowId)}
          title="Remove this group's begin/end, keeping the rows inside"
        >
          ungroup
        </button>
      </div>
      {!isCollapsed && (
        <div id={`group-children-${item.beginRowId}`} className="survey-group-children">
          {/* Wave 2 §3b — empty-section placeholder. When the group has
               zero children, surface the "+ Add question" affordance
               (insert-at-index flow, §A3 — before the matching `end`
               row). Note (audit P1-7): the copy promises ONLY what
               works — there is no per-group droppable in the flat
               SortableContext, so a drag lands OUTSIDE the group; do not
               reintroduce "drag here" wording until a real useDroppable
               per group container ships. */}
          {item.children.length === 0 && !isLineageBlock ? (
            <div className="survey-group-empty">
              <p className="muted small">
                This section is empty —{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    const endIdx = props.formSurvey.findIndex(
                      (r) => r.rowId === item.endRowId,
                    );
                    if (endIdx < 0) return;
                    props.addQuestion(endIdx);
                  }}
                >
                  + Add question
                </button>
                .
              </p>
            </div>
          ) : (
            <>
              {item.children.map(props.renderItem)}
              {/* §A3 — "+ add inside" inserts a new row at the end of this group,
                   just BEFORE the matching `end` row. */}
              <button
                type="button"
                className="link survey-add-inside"
                onClick={() => {
                  const endIdx = props.formSurvey.findIndex((r) => r.rowId === item.endRowId);
                  if (endIdx < 0) return;
                  props.addQuestion(endIdx);
                }}
                title={`Insert a new row inside this ${item.structuralType}`}
              >
                + add inside {item.name || `(${item.structuralType})`}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SurveyRowCard(props: {
  row: SurveyRow;
  locales: string[];
  violations: OrderingViolation[];
  fieldOptions: string[];
  fieldChoices: Record<string, string[]>;
  /** Geriatric §1 — same map with labels, for RelevantRuleBuilder's value
   *  dropdowns (label shown, name stored). */
  fieldChoiceOptions: Record<string, ReportFieldChoice[]>;
  /** Geriatric §2 — full form id for the media-upload route. */
  formId: string;
  /** Coarse FieldKind per field name, for type-aware op/field soft-filter
   *  (plan v0.3). Names absent from this map are treated as 'unknown' at
   *  the picker (always-pass) — never silently mis-bucketed. */
  fieldKinds: Record<string, FieldKind>;
  /** Tier 1.5 — contact input field list and contact-summary context keys.
   *  Forwarded only to the calculation ExpressionField; the boolean
   *  builders ignore them. */
  inputContactFields: string[];
  contextKeys: string[];
  /** Whole form + patch, so the inline choices editor can mutate form.choices. */
  form: XLSForm;
  patch: (next: XLSForm) => void;
  update: (u: (r: SurveyRow) => SurveyRow) => void;
  remove: () => void;
  moveUp: () => void;
  moveDown: () => void;
  /** Opens the tile picker scoped to this row's type. */
  onChangeType: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Wave 2 §5 — per-locale label input refs so the "insert" popover can
  // splice `${...}` at the current caret. Keyed by locale so each label's
  // popover reads the caret from its own input, not a sibling locale's.
  const labelInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.row.rowId,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  const { row, violations } = props;
  const structural = isStructural(row);
  const expressionsPreview = ['relevant', 'calculation', 'constraint', 'appearance']
    .map((c) => (row.extras[c] ? `${c}: ${row.extras[c]}` : null))
    .filter(Boolean)
    .join('  ·  ');

  // Wave 2 §5a — splice `${name}` into the label at the tracked caret.
  // Row-scoped `props.update` is sufficient here — no form-level rows
  // are added.
  function spliceLabelToken(locale: string, token: string) {
    const input = labelInputRefs.current[locale];
    const caret =
      input && typeof input.selectionStart === 'number'
        ? input.selectionStart
        : (row.labels[locale] ?? '').length;
    props.update((r) => {
      const current = r.labels[locale] ?? '';
      const pos = Math.max(0, Math.min(caret, current.length));
      const next = current.slice(0, pos) + token + current.slice(pos);
      return { ...r, labels: { ...r.labels, [locale]: next } };
    });
  }

  // Wave 2 §5b — insert a contact-field reference. Delegates to the
  // shared helper for the harvest calc row (idempotent, structural
  // balance preserved) AND splices `${<harvestName>}` at the caret in
  // one form-level patch so undo restores both halves together.
  function insertContactFieldToken(locale: string, contactField: string) {
    const input = labelInputRefs.current[locale];
    const caret =
      input && typeof input.selectionStart === 'number'
        ? input.selectionStart
        : (row.labels[locale] ?? '').length;
    const result = insertContactFieldRef(props.form, contactField);
    if (!result.harvestName) return;
    // P1-DEPLOY: the helper now writes the `inputs/contact` DECLARATION as
    // well as the harvest calculate, in the same returned form, so the
    // single `props.patch` below keeps one gesture = one undo. When it
    // could not declare (no inputs/contact group, or a nested path) it says
    // why, and that has to reach the author — silently emitting a reference
    // that fails `validate-app-forms` for the whole project is exactly how
    // this shipped the first time.
    if (result.undeclarableReason) {
      const formBefore = props.form;
      showUndoToast({
        message: `Inserted, but: ${result.undeclarableReason}`,
        // Undo re-patches the form as it was before this insert. Longer
        // dwell than the default 6s because this one has to be read.
        onUndo: () => props.patch(formBefore),
        durationMs: 12000,
      });
    }
    const token = `\${${result.harvestName}}`;
    const nextForm = {
      ...result.form,
      survey: result.form.survey.map((r) => {
        if (r.rowId !== row.rowId) return r;
        const current = r.labels[locale] ?? '';
        const pos = Math.max(0, Math.min(caret, current.length));
        return {
          ...r,
          labels: { ...r.labels, [locale]: current.slice(0, pos) + token + current.slice(pos) },
        };
      }),
    };
    props.patch(nextForm);
  }

  function setExtra(key: string, value: string) {
    props.update((r) => {
      const nextExtras = { ...r.extras };
      if (value === '') delete nextExtras[key];
      else nextExtras[key] = value;
      return { ...r, extras: nextExtras };
    });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`survey-row${structural ? ' structural' : ''}${violations.length ? ' has-violation' : ''}`}
      data-row-id={props.row.rowId}
      tabIndex={-1}
    >
      <button className="drag-handle" {...attributes} {...listeners} aria-label="drag">
        ⋮⋮
      </button>
      <div className="row-fields">
        <div className="row gap">
          <button
            type="button"
            className="type-chip"
            onClick={props.onChangeType}
            title="Click to change question type"
          >
            <span className="type-chip-label">{prettyTypeLabel(row.type, row.extras['appearance'] ?? '')}</span>
            <code className="type-chip-raw">{row.type || '(no type)'}</code>
          </button>
          <NameInput
            value={row.name}
            onChange={(name) => props.update((r) => ({ ...r, name }))}
            onRename={(fromName, toName) => {
              // Atomic rename: change row.name AND rewrite every
              // ${fromName} reference across the form in one patch
              // (so undo restores both halves together).
              props.patch(renameSurveyRow(props.form, fromName, toName));
            }}
          />
          <label className="required-label">
            <input
              type="checkbox"
              checked={Boolean(row.required && row.required !== 'no' && row.required !== 'false')}
              onChange={(e) =>
                props.update((r) => ({ ...r, required: e.target.checked ? 'yes' : '' }))
              }
            />
            required
          </label>
          <div className="row gap row-actions">
            <button className="link" onClick={props.moveUp} aria-label="move up">↑</button>
            <button className="link" onClick={props.moveDown} aria-label="move down">↓</button>
            <button className="link danger" onClick={props.remove}>delete</button>
          </div>
        </div>
        <div className="labels-grid">
          {props.locales.map((loc) => {
            // Wave 2 §4 — authoring-time missing-translation cue. When a
            // sibling locale on THIS row carries a non-empty label but
            // this locale doesn't, show the same "!" glyph the Translate
            // tab uses so gaps are visible without switching tabs. The
            // check requires at least one sibling to have content — a
            // row where every locale is empty is a brand-new row, not a
            // missing translation.
            const thisEmpty = !row.labels[loc] || !row.labels[loc]!.trim();
            const anySiblingHasValue = props.locales.some(
              (other) =>
                other !== loc && row.labels[other] && row.labels[other]!.trim().length > 0,
            );
            const isMissing = thisEmpty && anySiblingHasValue;
            return (
              <label
                key={loc}
                className={`label-row${isMissing ? ' label-row-missing' : ''}`}
              >
                <span className="locale-tag">label::{loc}</span>
                {isMissing && (
                  <span
                    className="translations-missing-glyph"
                    aria-label="missing translation"
                    title="Missing translation in this locale"
                  >
                    !
                  </span>
                )}
                <input
                  ref={(el) => {
                    labelInputRefs.current[loc] = el;
                  }}
                  value={row.labels[loc] ?? ''}
                  onChange={(e) =>
                    props.update((r) => ({
                      ...r,
                      labels: { ...r.labels, [loc]: e.target.value },
                    }))
                  }
                  placeholder={isMissing ? 'Add translation…' : `label in ${loc}`}
                />
                {/* Wave 2 §5 — insert-field / insert-contact-field popover.
                     Suppressed on structural rows (begin/end group/repeat) —
                     their label cell is a section heading and doesn't take
                     `${...}` refs. */}
                {!structural && (
                  <InsertLabelRefButton
                    fieldOptions={props.fieldOptions}
                    contactFields={props.inputContactFields}
                    onInsertField={(name) => spliceLabelToken(loc, `\${${name}}`)}
                    onInsertContactField={(field) => insertContactFieldToken(loc, field)}
                  />
                )}
              </label>
            );
          })}
        </div>
        <button className="link expand-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? '▾ hide advanced' : '▸ show advanced'}
          {!expanded && expressionsPreview && <span className="muted"> — {expressionsPreview}</span>}
        </button>
        {expanded && (
          <div className="advanced-fields">
            {isSelectRow(row) && (
              <InlineChoicesEditor
                form={props.form}
                rowId={row.rowId}
                defaultLocale={props.locales[0] ?? 'en'}
                patch={props.patch}
              />
            )}
            <UnifiedConditionBuilder
              fieldOptions={props.fieldOptions}
              fieldChoices={props.fieldChoices}
              fieldKinds={props.fieldKinds}
              getColumn={(col) => row.extras[col] ?? ''}
              setColumn={(col, value) => setExtra(col, value)}
            />
            <ExpressionField
              label="relevant"
              friendlyLabel="Show this question when…"
              hint="leave blank to always show"
              helpText="XPath expression. The question is hidden until this is true. References other fields via ${name}."
              value={row.extras['relevant'] ?? ''}
              onChange={(v) => setExtra('relevant', v)}
              fieldOptions={props.fieldOptions}
              fieldChoiceOptions={props.fieldChoiceOptions}
              inputContactFields={props.inputContactFields}
              contextKeys={props.contextKeys}
            />
            <ExpressionField
              label="calculation"
              friendlyLabel="Compute the value as…"
              hint="for calculate or hidden fields"
              helpText="XPath that computes this field's value from other fields. Common for `calculate` rows; can also pre-fill a regular question."
              value={row.extras['calculation'] ?? ''}
              onChange={(v) => setExtra('calculation', v)}
              fieldOptions={props.fieldOptions}
              fieldChoiceOptions={props.fieldChoiceOptions}
              inputContactFields={props.inputContactFields}
              contextKeys={props.contextKeys}
            />
            <ExpressionField
              label="constraint"
              friendlyLabel="Accept the answer only if…"
              hint="validation rule"
              helpText="XPath. If the answer doesn't satisfy this, the form blocks submission and shows the constraint_message below."
              value={row.extras['constraint'] ?? ''}
              onChange={(v) => setExtra('constraint', v)}
              fieldOptions={props.fieldOptions}
              fieldChoiceOptions={props.fieldChoiceOptions}
              inputContactFields={props.inputContactFields}
              contextKeys={props.contextKeys}
            />
            {isSelectRow(row) && (
              <ExpressionField
                label="choice_filter"
                friendlyLabel="Filter the choice list when…"
                hint="only for select questions"
                helpText="XPath evaluated per choice row. Use the choices sheet's filter-category column with this to show only matching options."
                value={row.extras['choice_filter'] ?? ''}
                onChange={(v) => setExtra('choice_filter', v)}
                fieldOptions={props.fieldOptions}
              fieldChoiceOptions={props.fieldChoiceOptions}
                inputContactFields={props.inputContactFields}
                contextKeys={props.contextKeys}
              />
            )}
            <AppearanceField
              value={row.extras['appearance'] ?? ''}
              rowType={row.type}
              onChange={(v) => setExtra('appearance', v)}
            />
            <MediaImageField
              formId={props.formId}
              extras={row.extras}
              setExtra={setExtra}
            />
            <ExpressionField
              label="default"
              friendlyLabel="Default value"
              hint="pre-fill"
              helpText="Literal value or ${other_field} reference. Pre-fills the answer; the user can still change it."
              value={row.extras['default'] ?? ''}
              onChange={(v) => setExtra('default', v)}
            />
            {row.type.trim().toLowerCase() === 'begin repeat' && (
              <ExpressionField
                label="repeat_count"
                friendlyLabel="Number of repeats"
                hint="for begin repeat only"
                helpText="XPath that returns a number — how many times this group repeats. Common pattern: ${family_size}."
                value={row.extras['repeat_count'] ?? ''}
                onChange={(v) => setExtra('repeat_count', v)}
              />
            )}
            <details className="raw-extras">
              <summary>Hints &amp; error messages</summary>
              <div className="hints-grid">
                {props.locales.map((loc) => (
                  <ExpressionField
                    key={`hint-${loc}`}
                    label={`hint::${loc}`}
                    friendlyLabel={`Help text (${loc})`}
                    hint="shown under the question"
                    helpText="Plain text shown beneath the question label to guide the user. Optional."
                    value={row.extras[`hint::${loc}`] ?? ''}
                    onChange={(v) => setExtra(`hint::${loc}`, v)}
                  />
                ))}
                {row.extras['constraint'] &&
                  props.locales.map((loc) => (
                    <ExpressionField
                      key={`cmsg-${loc}`}
                      label={`constraint_message::${loc}`}
                      friendlyLabel={`Error message (${loc})`}
                      hint="when the constraint above fails"
                      helpText="Shown to the user when the constraint rejects their answer. Only meaningful when a constraint is set."
                      value={row.extras[`constraint_message::${loc}`] ?? ''}
                      onChange={(v) => setExtra(`constraint_message::${loc}`, v)}
                    />
                  ))}
              </div>
            </details>
            <details className="raw-extras">
              <summary>Raw column overrides (preserved from xlsx)</summary>
              {Object.entries(row.extras)
                .filter(
                  ([k]) =>
                    ![
                      'relevant',
                      'calculation',
                      'constraint',
                      'choice_filter',
                      'appearance',
                      'default',
                      'repeat_count',
                    ].includes(k) &&
                    !k.startsWith('hint::') &&
                    !k.startsWith('constraint_message::'),
                )
                .map(([k, v]) => (
                  <ExpressionField
                    key={k}
                    label={k}
                    hint=""
                    value={v}
                    onChange={(val) => setExtra(k, val)}
                  />
                ))}
            </details>
          </div>
        )}
        {!expanded && expressionsPreview && (
          <div className="expr-preview muted">{expressionsPreview}</div>
        )}
        {violations.length > 0 && (
          <div className="violation-banner">
            <strong>Dependency issue:</strong>{' '}
            references{' '}
            {violations.map((v, i) => (
              <span key={`${v.column}-${v.reference}-${i}`}>
                <code>{v.reference}</code>
                {' (defined later, in '}
                <code>{v.column}</code>
                {')'}
                {i < violations.length - 1 ? ', ' : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Survey-row `name` input with inline XLSForm-identifier validation +
 * one-click slugify + atomic-rename-all-refs.
 *
 * The `name` column must match `^[A-Za-z_][A-Za-z0-9_]*$` — anything
 * else (spaces, `?`, etc.) breaks pyxform on convert-app-forms with an
 * opaque "Reference expressions must only include question names"
 * error. Pre-fix, the editor let users type free strings here (PO
 * walkthrough trap — confusing `name` with `label`). Now we warn
 * inline and offer a Fix button that slugifies via the same shared
 * helper Quick Hierarchy Creator uses.
 *
 * The Fix button + a normal blur after editing call `onRename(old,
 * new)` rather than just `onChange(new)` so EVERY `${old}` reference
 * in the form's relevant/calculation/constraint/etc. is rewritten in
 * lockstep — no dangling refs left in other rows when a name changes.
 * Per-keystroke updates still go through `onChange` so the input
 * stays responsive without rewriting refs mid-type.
 */
function NameInput(props: {
  value: string;
  onChange: (v: string) => void;
  /** Atomic rename + ref-rewrite. Fired on blur (if name actually
   *  changed from focus baseline) and on Fix-button click. */
  onRename?: (fromName: string, toName: string) => void;
}) {
  const isValid = props.value === '' || /^[A-Za-z_][A-Za-z0-9_]*$/.test(props.value);
  const suggested = isValid ? '' : slugifyHierarchyId(props.value);
  // Capture the name at the start of an edit session (focus) so the
  // blur handler can fire onRename(focusValue, currentValue) — refs
  // get rewritten ONCE per edit session, not per keystroke.
  const focusBaselineRef = useRef<string | null>(null);

  function applyFix() {
    if (!suggested) return;
    // The visible value is the invalid name; rename FROM the current
    // (invalid) value TO the slugified suggestion, rewriting refs.
    if (props.onRename) {
      props.onRename(props.value, suggested);
    } else {
      props.onChange(suggested);
    }
    // Clear the focus baseline so the upcoming blur (if it fires)
    // doesn't double-rename from the now-stale baseline.
    focusBaselineRef.current = null;
  }

  return (
    <div className="name-input-wrap">
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onFocus={() => {
          focusBaselineRef.current = props.value;
        }}
        onBlur={() => {
          const baseline = focusBaselineRef.current;
          focusBaselineRef.current = null;
          if (baseline === null) return;
          if (baseline === props.value) return;
          if (!props.onRename) return;
          // Only fire the rename macro when both halves are non-empty;
          // an empty baseline or current can't drive a coherent
          // ${...} rewrite anyway.
          if (!baseline || !props.value) return;
          props.onRename(baseline, props.value);
        }}
        placeholder="name"
        className={`name-input${!isValid ? ' invalid' : ''}`}
        aria-invalid={!isValid || undefined}
        title={
          isValid
            ? undefined
            : `XLSForm names must be identifiers (no spaces, no '?'). pyxform will reject this on deploy.`
        }
      />
      {!isValid && (
        <span className="name-input-warning">
          <span aria-hidden="true">⚠ </span>
          not a valid id —{' '}
          {suggested ? (
            <button
              type="button"
              className="link"
              onClick={applyFix}
              title="Replace with the slugified id; rewrites every ${old} reference in the form to ${new} in the same step"
            >
              Fix → <code>{suggested}</code>
            </button>
          ) : (
            <span>type a label-free identifier (a-z, 0-9, _)</span>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Geriatric §2 — display-image support (`media::image`). The IHA
 * chair-rise instructional illustration (audit's only hard GAP) needs a
 * static image shown WITH a question/note — the Photo tile is capture,
 * not display. This control surfaces the `media::image` extras cell with
 * an Upload…/Clear pair: the file lands in the CHT convention folder
 * `forms/<category>/<basename>-media/` (a sibling of the .xlsx that
 * `cht-conf upload-app-forms` attaches automatically) and the cell holds
 * the bare filename. Round-trip is free: `media::image` is an ordinary
 * extras column the parser already preserves verbatim, and the serializer
 * appends new extras columns on save.
 *
 * Per-locale variants: an XLSForm may carry `media::image::<lang>`
 * columns (they parse as separate extras keys, not label-family). Any
 * such key already present on the row gets its own control; NEW images
 * default to the single un-localized `media::image` column.
 */
function MediaImageField(props: {
  formId: string;
  extras: Record<string, string>;
  setExtra: (key: string, value: string) => void;
}) {
  const setError = useApp((s) => s.setError);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Per-key refs, NOT DOM ids: every expanded row card renders this
  // component, so `id="media-upload-media::image"` collided across cards
  // and getElementById clicked the FIRST card's input — the filename
  // landed on the wrong row (re-audit P0-3).
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const keys = useMemo(() => {
    const localized = Object.keys(props.extras)
      .filter((k) => /^media::image::/i.test(k))
      .sort();
    return ['media::image', ...localized];
  }, [props.extras]);

  async function upload(key: string, file: File) {
    setBusyKey(key);
    try {
      const res = await api.uploadFormMedia(props.formId, file);
      props.setExtra(key, res.filename);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <>
      {keys.map((key) => {
        const value = props.extras[key] ?? '';
        return (
          <label key={key} className="expr-field">
            <span className="expr-label">
              <strong>Image{key === 'media::image' ? '' : ` (${key.split('::')[2]})`}</strong>
              <code className="raw-col-tag" title={`Raw XLSForm column: ${key}`}>
                {key}
              </code>
              <em className="muted">
                {' '}— picture shown with this question (e.g. an instructional illustration)
              </em>
            </span>
            <span className="row gap" style={{ alignItems: 'center' }}>
              <input
                value={value}
                onChange={(e) => props.setExtra(key, e.target.value)}
                placeholder="filename.png (in the form's -media folder)"
                style={{ flex: 1 }}
              />
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                ref={(el) => {
                  fileInputs.current[key] = el;
                }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(key, f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="link"
                disabled={busyKey === key}
                onClick={() => fileInputs.current[key]?.click()}
              >
                {busyKey === key ? 'Uploading…' : 'Upload…'}
              </button>
              {value && (
                <button type="button" className="link danger" onClick={() => props.setExtra(key, '')}>
                  Clear
                </button>
              )}
            </span>
          </label>
        );
      })}
    </>
  );
}

/**
 * Wrapper for the `appearance` column: text input + "Pick widgets" button
 * that opens AppearancePicker. The picker is a catalog of CHT and Enketo
 * appearance tokens; multiple tokens can be combined (space-separated).
 */
function AppearanceField(props: {
  value: string;
  rowType: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <label className="expr-field">
      <span className="expr-label">
        <code>appearance</code>
        <em className="muted">
          {' '}— widget hints (multiline, hidden, mrdt-verify, h1 blue, …).
        </em>
        <button
          className="link"
          onClick={(e) => {
            e.preventDefault();
            setOpen(true);
          }}
        >
          ✎ pick widgets
        </button>
      </span>
      <input value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      {open && (
        <AppearancePicker
          value={props.value}
          rowType={props.rowType}
          onChange={props.onChange}
          onCancel={() => setOpen(false)}
        />
      )}
    </label>
  );
}

/** Small text input for an arbitrary XLSForm expression column. */
function ExpressionField(props: {
  /** The raw XLSForm column name (e.g. "relevant"). Used as the data key. */
  label: string;
  /** Plain-English title shown to the user. Falls back to `label` if absent. */
  friendlyLabel?: string;
  /** Short hint shown next to the label. */
  hint: string;
  /** Long-form help text shown in a hover tooltip with a `❔` icon. */
  helpText?: string;
  value: string;
  onChange: (v: string) => void;
  /** When set, shows a "Build" button that opens the visual rule builder. */
  fieldOptions?: string[];
  /** Geriatric §1 — per-field {name, label} choices for the rule
   *  builder's value dropdowns. */
  fieldChoiceOptions?: Record<string, ReportFieldChoice[]>;
  /** Tier 1.5 — contact input field list for the calc builder's
   *  "Contact input field" reference kind. Forwarded to CalculationBuilder. */
  inputContactFields?: string[];
  /** Tier 1.5 — contact-summary context keys for the calc builder's
   *  "Contact-summary value" reference kind. Forwarded to CalculationBuilder. */
  contextKeys?: string[];
}) {
  const [showBuilder, setShowBuilder] = useState(false);
  const [showCalcBuilder, setShowCalcBuilder] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const supportsRelevant =
    props.fieldOptions !== undefined &&
    ['relevant', 'constraint', 'choice_filter'].includes(props.label);
  const supportsCalculation = props.fieldOptions !== undefined && props.label === 'calculation';
  const supportsBuilder = supportsRelevant || supportsCalculation;
  return (
    <label className="expr-field">
      <span className="expr-label">
        <strong>{props.friendlyLabel ?? props.label}</strong>
        {props.friendlyLabel && (
          <code className="raw-col-tag" title={`Raw XLSForm column: ${props.label}`}>
            {props.label}
          </code>
        )}
        {props.helpText && (
          <span className="help-icon" title={props.helpText} aria-label={props.helpText}>
            ❔
          </span>
        )}
        {props.hint && <em className="muted"> — {props.hint}</em>}
        {supportsBuilder && (
          <button
            className="link"
            onClick={(e) => {
              e.preventDefault();
              if (supportsCalculation) setShowCalcBuilder(true);
              else setShowBuilder(true);
            }}
          >
            ✎ build
          </button>
        )}
      </span>
      <input
        ref={inputRef}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />

      {showBuilder && props.fieldOptions && (
        <RelevantRuleBuilder
          column={props.label}
          value={props.value}
          fieldOptions={props.fieldOptions}
          fieldChoiceOptions={props.fieldChoiceOptions}
          inputContactFields={props.inputContactFields}
          contextKeys={props.contextKeys}
          onCancel={() => setShowBuilder(false)}
          onSave={(v) => {
            props.onChange(v);
            setShowBuilder(false);
          }}
        />
      )}
      {showCalcBuilder && props.fieldOptions && (
        <CalculationBuilder
          title="Calculation builder"
          value={props.value}
          fieldOptions={props.fieldOptions}
          fieldChoiceOptions={props.fieldChoiceOptions}
          inputContactFields={props.inputContactFields}
          contextKeys={props.contextKeys}
          onCancel={() => setShowCalcBuilder(false)}
          onSave={(v) => {
            props.onChange(v);
            setShowCalcBuilder(false);
          }}
        />
      )}
    </label>
  );
}

/**
 * Walks the survey + choices sheets to build a `name → choice-values` map.
 *
 * Two sources, in priority order (form-local wins on collision so the open
 * form's own select is never overridden by project-level context):
 *   1. `contactFieldChoices`: choices reachable from a select in any
 *      `forms/contact/*.xlsx`, scanned by the server at project open. Lets
 *      the condition builder surface a values dropdown for contact-injected
 *      fields like `inputs/contact/sex` whose underlying select_one lives
 *      in a different form. Optional — older server responses may omit it.
 *   2. This form's own select_one / select_multiple rows.
 *
 * Fields that resolve nowhere are absent from the result so the builder
 * falls back to the free-text input (the existing safety net).
 */
/**
 * Geriatric §1 — like `buildFieldChoices`, but keeps the display label:
 * field name → ordered `{name, label}` list for this form's own
 * select_one / select_multiple rows. Label = first non-empty label in the
 * form's locale order, falling back to the choice name (mirrors
 * `extractReportFieldInfos`'s label pick in shared).
 */
function buildFieldChoiceOptions(
  survey: SurveyRow[],
  choices: ChoiceRow[],
  locales: string[],
): Record<string, ReportFieldChoice[]> {
  const listToOptions = new Map<string, ReportFieldChoice[]>();
  for (const c of choices) {
    if (!c.list_name || !c.name) continue;
    let label = '';
    for (const loc of locales) {
      const v = c.labels[loc];
      if (v && v.trim() !== '') {
        label = v;
        break;
      }
    }
    if (!label) {
      label = Object.values(c.labels).find((v) => v && v.trim() !== '') ?? c.name;
    }
    if (!listToOptions.has(c.list_name)) listToOptions.set(c.list_name, []);
    listToOptions.get(c.list_name)!.push({ name: c.name, label });
  }
  const out: Record<string, ReportFieldChoice[]> = {};
  for (const r of survey) {
    if (!r.name) continue;
    const m = r.type.trim().match(SELECT_TYPE_RE);
    if (!m) continue;
    const opts = listToOptions.get(m[2]!);
    if (opts && opts.length > 0) out[r.name] = opts;
  }
  return out;
}

function buildFieldChoices(
  survey: SurveyRow[],
  choices: ChoiceRow[],
  contactFieldChoices?: Record<string, string[]>,
): Record<string, string[]> {
  // Start from project-level context (contact-form selects).
  const out: Record<string, string[]> = { ...(contactFieldChoices ?? {}) };

  // Overlay form-local selects so this form's own definitions win on collision.
  const listToValues = new Map<string, string[]>();
  for (const c of choices) {
    if (!c.list_name || !c.name) continue;
    if (!listToValues.has(c.list_name)) listToValues.set(c.list_name, []);
    listToValues.get(c.list_name)!.push(c.name);
  }
  for (const r of survey) {
    if (!r.name) continue;
    const m = r.type.trim().match(SELECT_TYPE_RE);
    if (!m) continue;
    const vals = listToValues.get(m[2]!);
    if (vals && vals.length > 0) out[r.name] = vals;
  }
  return out;
}

/**
 * Operators the visual condition builder offers. NOTE: `and` and `or` are
 * deliberately absent here — connectors live BETWEEN clauses (the
 * between-clause pill in stacked mode), never inside a single one. This
 * is the §3.7 structural guarantee: there is no UI path that can write
 * `${a}='x' or ${b}>10 and ${c}='y'` flat-mixed to row.extras. To mix
 * AND with OR, the user must press `( group these )` (commit C).
 */
type CondOp = ClauseOp;

const COND_OPS_NEED_FIELD: CondOp[] = [
  '=', '!=', '>', '<', '>=', '<=', 'selected', 'selected-not', 'not', 'ref',
];
const COND_OPS_NEED_VALUE: CondOp[] = ['=', '!=', '>', '<', '>=', '<=', 'selected', 'selected-not'];

// `calculation` is intentionally NOT in this list. It produces a VALUE,
// not a boolean, and is edited via the dedicated CalculationBuilder
// (mounted by ExpressionField when `supportsCalculation` holds). See
// docs/plans/calculation-builder.md v0.2 §3.6 — "double-door" fix.
const COLUMN_OPTIONS = [
  { value: 'relevant', label: 'Show when… (relevant)' },
  { value: 'constraint', label: 'Accept only if… (constraint)' },
  { value: 'choice_filter', label: 'Filter choices when… (choice_filter)' },
] as const;

/** Microcopy per plan §10. */
const CONNECTOR_LABELS = { and: 'and also', or: 'or instead' } as const;

/**
 * Comparison op → English. Used for the prose preview ("This row shows
 * when: sex is female and age is more than 18"). `today()` / `not(${field})`
 * / ref stay as code-style chips because there's no clean English form.
 */
const COMPARISON_PROSE: Record<'=' | '!=' | '>' | '<' | '>=' | '<=', string> = {
  '=': 'is',
  '!=': 'is not',
  '>': 'is more than',
  '<': 'is less than',
  '>=': 'is at least',
  '<=': 'is at most',
};

/**
 * Display-only natural-language labels for the op `<select>` (plan v0.3 §4,
 * v0.3-punchlist B1). The option `value`s remain the canonical `ClauseOp`
 * tokens — labels NEVER reach `clauseToRule`/`serializeAnyParsed`.
 *
 * **B1 fix (2026-06-15):** drop the trailing "value" from every comparison
 * label so the dropdown reads as a complete phrase, not a fragment.
 *
 * **User override (2026-06-15):** the four ordering operators (`>`, `<`,
 * `>=`, `<=`) stay as mathematical glyphs, NOT the verbose
 * `is more than` / `is at least` prose — they're universally readable and
 * leaning into NLP for them looked overdone. Equality/inequality keep
 * their plain-language form (`equals` / `is not`) since `=` / `!=` are
 * less obvious in isolation. The prose preview (`This row shows when:`)
 * still uses `COMPARISON_PROSE` verbatim for natural reading; dropdown
 * and preview differ only on the four ordering rows. Tracked so the
 * planner can revisit if the divergence proves confusing in usability.
 *
 * Banned tokens: `not(`, `today()`, `${field}`, `selected(`, `div`, `floor`.
 * None must appear in any label the user picks.
 */
const OPERATOR_LABELS: Record<ClauseOp, string> = {
  '=': 'equals',
  '!=': COMPARISON_PROSE['!='],
  '>': '>',
  '<': '<',
  '>=': '≥',
  '<=': '≤',
  selected: 'includes',
  'selected-not': 'does not include',
  not: 'is not selected',
  ref: 'has an answer',
  today: 'today',
};

function clauseToProse(c: Clause): string {
  if (c.op === '=' || c.op === '!=' || c.op === '>' || c.op === '<' || c.op === '>=' || c.op === '<=') {
    return `${c.field} ${COMPARISON_PROSE[c.op]} ${c.value}`;
  }
  if (c.op === 'selected') return `${c.field} includes ${c.value}`;
  if (c.op === 'selected-not') return `${c.field} does not include ${c.value}`;
  if (c.op === 'not') return `not(\${${c.field}})`;
  if (c.op === 'ref') return `\${${c.field}}`;
  return 'today()';
}

/**
 * Unified condition builder shown above the raw column inputs.
 *
 * Slice 2 commit B (docs/plans/condition-builder.md v0.2). The transient
 * state lives in `useReducer(conditionBuilderReducer, ...)`. The strip's
 * own op dropdown no longer carries `and`/`or` — those are the between-
 * clause connector pill in stacked mode, and the legacy fragment-append
 * path (`build()` returning ` and ` / ` or ` for direct string
 * concatenation) is gone. All writes to `row.extras[column]` flow through
 * `serializeBuilderState` → `serializeAnyParsed`.
 *
 * Layout:
 *   - **One-clause fidelity**: when `clauses.length===0 && draft empty`,
 *     OR `clauses.length===1 && draft empty && !rawFallback`, render a
 *     single horizontal strip — same column/field/value dropdowns,
 *     same free-text value fallback, same `+ insert` position as today.
 *     No chip group, no preview header.
 *   - **Stacked mode**: as soon as the chain has ≥2 clauses, OR the user
 *     starts a draft on top of a committed clause, show the committed
 *     clauses as chips with the between-clause connector pill, plus a
 *     prose preview header `This row shows when: …`.
 *   - **Raw fallback**: when the existing column value couldn't be cleanly
 *     parsed (mixed AND/OR without parens, three-level nesting, etc.),
 *     show the banner and keep chaining disabled; the existing text stays
 *     visible + editable in the ExpressionField below.
 */
function UnifiedConditionBuilder(props: {
  fieldOptions: string[];
  fieldChoices: Record<string, string[]>;
  /** FieldKind per field name. Missing keys fall through to 'unknown'
   *  (always-pass) — see plan v0.3 §3 never-de-emphasize contract. */
  fieldKinds: Record<string, FieldKind>;
  getColumn: (col: string) => string;
  setColumn: (col: string, value: string) => void;
}) {
  const [state, dispatch] = useReducer(conditionBuilderReducer, initialConditionBuilderState);

  // Whenever the user picks a column, hydrate the reducer from its
  // existing value. parseRelevantGrouped routes anything outside our
  // grammar to rawFallback (chaining disabled, text preserved).
  function onPickColumn(col: ConditionColumn | ''): void {
    const existingValue = col ? props.getColumn(col) : '';
    dispatch({ kind: 'set-column', column: col, existingValue });
  }

  function setDraft(partial: Partial<Clause>): void {
    dispatch({ kind: 'set-draft', partial });
  }

  // The connector picker default — only meaningful before a connector is
  // locked. After lock it's read-only and reflects the lock. In grouped
  // mode the active subgroup carries its own connector lock.
  const [connectorChoice, setConnectorChoice] = useState<'and' | 'or'>('and');

  /**
   * Resolve the locked connector for the current commit context. In flat
   * mode it's `state.lockedConnector`. In grouped mode it's the active
   * subgroup's `connector` (only locked once the subgroup has clauses).
   */
  function activeLockedConnector(): 'and' | 'or' | null {
    if (state.groups === null) return state.lockedConnector;
    const idx = state.activeGroupIndex;
    if (idx === null) return null;
    const active = state.groups[idx];
    return active && active.clauses.length > 0 ? active.connector : null;
  }

  function doAddAnother(): void {
    if (!isDraftComplete(state.draft)) return;
    const connector: 'and' | 'or' = activeLockedConnector() ?? connectorChoice;
    dispatch({ kind: 'commit-clause', connector });
  }

  function doInsert(): void {
    if (!state.column || !isInsertReady(state)) return;
    // Write the serialized chain to row.extras[column], replacing whatever's
    // there. Different from today's append-on-insert: chaining now produces
    // the FULL expression, so we own the column's value end-to-end.
    const out = serializeBuilderState(state);
    props.setColumn(state.column, out);
    // Reset the session by re-hydrating against the just-written value.
    dispatch({ kind: 'set-column', column: state.column, existingValue: out });
  }

  function doStartOver(): void {
    dispatch({ kind: 'start-over' });
  }

  function doUndoLastClause(): void {
    dispatch({ kind: 'pop-clause' });
  }

  function onGroupThese(): void {
    dispatch({ kind: 'enter-group-mode' });
  }

  function onFlatten(): void {
    dispatch({ kind: 'exit-group-mode' });
  }

  function onAddSubgroup(connector: 'and' | 'or'): void {
    dispatch({ kind: 'add-subgroup', connector });
  }

  /**
   * Switch the active subgroup. If the draft has been started but is not
   * yet complete, confirm with the user before discarding it — never
   * silently drop in-flight input (Lorena gate + Lal blocking #1).
   */
  function requestActiveGroupSwitch(index: number): void {
    const draftStarted = !isDraftEmpty(state.draft);
    const draftComplete = isDraftComplete(state.draft);
    if (draftStarted && !draftComplete) {
      // eslint-disable-next-line no-alert
      const ok = window.confirm('Discard the in-flight rule?');
      if (!ok) return;
      dispatch({ kind: 'set-draft', partial: { field: '', op: '=', value: '' } });
    }
    dispatch({ kind: 'set-active-group', index });
  }

  const choices = state.draft.field ? props.fieldChoices[state.draft.field] : undefined;
  const needsField = (COND_OPS_NEED_FIELD as string[]).includes(state.draft.op);
  const needsValue = (COND_OPS_NEED_VALUE as string[]).includes(state.draft.op);

  // ---- v0.3 type-aware soft filter --------------------------------------
  // Local UI state only — NEVER enters BuilderState or any serialization
  // path (Lal/Developer A7). If a saved/rehydrated field would be atypical
  // for the current op, default the toggle to ON so the saved selection is
  // never visually stranded.
  const [showAllFields, setShowAllFields] = useState(false);
  const kindOf = (n: string): FieldKind => props.fieldKinds[n] ?? 'unknown';

  // Op-first partition for the field picker. Active whenever the op takes
  // a field (so `today` doesn't activate filtering; the field select is
  // disabled in that case anyway). Selected field is forced into the
  // typical bucket so it always renders adjacent to the picker.
  const fieldHasOpHint = needsField;
  const splitFieldsByOp = fieldHasOpHint && !showAllFields;
  const typicalFields: string[] = [];
  const atypicalFields: string[] = [];
  if (splitFieldsByOp) {
    for (const name of props.fieldOptions) {
      if (name === state.draft.field) {
        typicalFields.push(name);
      } else if (fieldsTypicalForOp(state.draft.op, kindOf(name))) {
        typicalFields.push(name);
      } else {
        atypicalFields.push(name);
      }
    }
  }
  // Auto-relax: if the rehydrated/selected field is atypical for the
  // current op, surface it by forcing the flat list on next render. We
  // use a ref-like effect to flip the toggle exactly once per mismatch.
  useEffect(() => {
    if (!splitFieldsByOp) return;
    if (!state.draft.field) return;
    const k = kindOf(state.draft.field);
    if (!fieldsTypicalForOp(state.draft.op, k)) setShowAllFields(true);
    // intentionally narrow deps — only react to draft.field/op transitions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.draft.field, state.draft.op]);

  // Field-first partition for the op picker. Grouping only — every op
  // always stays in the DOM (no escape-hatch toggle needed; A6/A7).
  const fieldKindForOpPicker: FieldKind = state.draft.field ? kindOf(state.draft.field) : 'unknown';
  const splitOpsByField = state.draft.field !== '';
  const typicalOpsSet = splitOpsByField
    ? new Set(opsTypicalForKind(fieldKindForOpPicker))
    : null;
  // Stable display order — keep the canonical 11-op order; flag typical-vs-other.
  const opGroups: Array<{ label: string; ops: ClauseOp[] }> = (() => {
    const all: ClauseOp[] = ['=', '!=', '>', '<', '>=', '<=', 'selected', 'selected-not', 'not', 'ref', 'today'];
    if (!splitOpsByField || !typicalOpsSet) {
      return [{ label: 'all operators', ops: all }];
    }
    const typical = all.filter((o) => typicalOpsSet.has(o));
    const other = all.filter((o) => !typicalOpsSet.has(o));
    return [
      { label: 'Common operators', ops: typical },
      ...(other.length ? [{ label: 'Other operators', ops: other }] : []),
    ];
  })();

  // "Stacked" iff the FLAT chain has reached the chip threshold. Plan §4:
  // "the stacked-clause/chip UI only appears once a second clause exists."
  // In grouped mode the card stack always renders.
  const draftEmpty = isDraftEmpty(state.draft);
  const stacked = state.clauses.length >= 2 || (state.clauses.length >= 1 && !draftEmpty);

  const proseChips = state.clauses.map(clauseToProse);
  const draftProse = isDraftComplete(state.draft) ? clauseToProse(state.draft) : '…';

  // Group-mode derived state.
  const activeGroup: Subgroup | null =
    state.groups !== null && state.activeGroupIndex !== null
      ? (state.groups[state.activeGroupIndex] ?? null)
      : null;
  const activeSubgroupConnector = activeLockedConnector();
  const canGroupThese =
    state.groups === null &&
    state.clauses.length >= 2 &&
    state.lockedConnector !== null &&
    state.rawFallback === null;
  const canFlatten =
    state.groups !== null &&
    state.groups.filter((g) => g.clauses.length > 0).length <= 1;

  return (
    <div className="cond-strip cond-strip-unified">
      {state.rawFallback !== null && (
        <div
          className="muted"
          role="status"
          style={{ width: '100%', padding: '4px 0' }}
        >
          This rule was hand-written. Edit as text, or clear it to use the builder.
        </div>
      )}

      {/*
        Card stack — grouped mode. Each subgroup is its own bordered card;
        the active card commits the next clause from the strip below.
        Outer-connector pill renders between cards (or as a "+ add a
        second subgroup" affordance when only subgroup 1 exists).
      */}
      {state.groups !== null && state.rawFallback === null && (
        <div
          role="group"
          aria-label="Grouped conditions"
          className="cond-subgroup-stack"
          style={{ width: '100%' }}
        >
          <div className="muted ref-chips-hint" style={{ marginBottom: 4 }}>
            This row shows when:
          </div>
          {state.groups.map((sg, gi) => (
            <Fragment key={gi}>
              <section
                className={`cond-subgroup${gi === state.activeGroupIndex ? ' active' : ''}`}
                aria-current={gi === state.activeGroupIndex ? 'true' : undefined}
              >
                <button
                  type="button"
                  className="cond-subgroup-header"
                  aria-pressed={gi === state.activeGroupIndex}
                  tabIndex={gi === state.activeGroupIndex ? 0 : -1}
                  onClick={(e) => {
                    e.preventDefault();
                    if (gi !== state.activeGroupIndex) requestActiveGroupSwitch(gi);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const next = (gi + 1) % state.groups!.length;
                      requestActiveGroupSwitch(next);
                    }
                  }}
                >
                  subgroup {gi + 1}
                </button>
                <div
                  className="row gap"
                  style={{ flexWrap: 'wrap', alignItems: 'center' }}
                >
                  {sg.clauses.map((c, ci) => (
                    <span key={ci} className="row gap" style={{ alignItems: 'center' }}>
                      {ci > 0 && (
                        <span className="muted" style={{ fontSize: 12 }}>
                          {CONNECTOR_LABELS[sg.connector]}
                        </span>
                      )}
                      <code className="cond-preview">{clauseToProse(c)}</code>
                      <button
                        type="button"
                        className="link"
                        aria-label="remove rule"
                        title={
                          gi === state.activeGroupIndex && ci === sg.clauses.length - 1
                            ? 'Remove this rule'
                            : 'Switch to this subgroup to remove its last rule'
                        }
                        onClick={(e) => {
                          e.preventDefault();
                          if (
                            gi === state.activeGroupIndex &&
                            ci === sg.clauses.length - 1
                          ) {
                            doUndoLastClause();
                          }
                        }}
                        disabled={
                          gi !== state.activeGroupIndex ||
                          ci !== sg.clauses.length - 1
                        }
                      >
                        × remove rule
                      </button>
                    </span>
                  ))}
                  {sg.clauses.length === 0 && (
                    <span className="muted" style={{ fontSize: 12 }}>
                      (empty — build a rule in the strip below)
                    </span>
                  )}
                </div>
              </section>
              {/* Outer-connector pill row. Between subgroup 1 and subgroup
                  2 once both exist, OR as the "+ add second subgroup"
                  affordance when only subgroup 1 has at least one clause. */}
              {gi === 0 && state.groups!.length === 2 && (
                <div className="cond-outer-connector muted" style={{ fontSize: 12 }}>
                  {state.outerConnector !== null
                    ? CONNECTOR_LABELS[state.outerConnector]
                    : CONNECTOR_LABELS.and}
                </div>
              )}
              {gi === 0 &&
                state.groups!.length === 1 &&
                sg.clauses.length >= 1 && (
                  <div
                    className="cond-outer-connector row gap"
                    style={{ alignItems: 'center', fontSize: 12 }}
                  >
                    <span className="muted">Add another subgroup with:</span>
                    <button
                      type="button"
                      className="link"
                      title="Start a second subgroup joined by 'and also'"
                      onClick={(e) => {
                        e.preventDefault();
                        onAddSubgroup('and');
                      }}
                    >
                      {CONNECTOR_LABELS.and}
                    </button>
                    <button
                      type="button"
                      className="link"
                      title="Start a second subgroup joined by 'or instead'"
                      onClick={(e) => {
                        e.preventDefault();
                        onAddSubgroup('or');
                      }}
                    >
                      {CONNECTOR_LABELS.or}
                    </button>
                  </div>
                )}
            </Fragment>
          ))}
        </div>
      )}

      {/* Flat-mode chip row — only when not grouped. */}
      {state.groups === null && stacked && state.rawFallback === null && (
        <div style={{ width: '100%' }}>
          <div className="muted ref-chips-hint" style={{ marginBottom: 4 }}>
            This row shows when:{' '}
            {state.clauses.map((_, i) => (
              <span key={i}>
                {i > 0 && (
                  <span className="muted">
                    {' '}{CONNECTOR_LABELS[state.connectors[i - 1] ?? 'and']}{' '}
                  </span>
                )}
                <code className="cond-preview">{proseChips[i]}</code>
              </span>
            ))}
            {!draftEmpty && (
              <>
                <span className="muted">
                  {' '}{CONNECTOR_LABELS[state.lockedConnector ?? connectorChoice]}{' '}
                </span>
                <code className="cond-preview">{draftProse}</code>
              </>
            )}
          </div>
          <div
            role="group"
            aria-label="Conditions for showing this row"
            className="row gap"
            style={{ flexWrap: 'wrap', marginBottom: 6 }}
          >
            {state.clauses.map((c, i) => (
              <span key={i} className="row gap" style={{ alignItems: 'center' }}>
                {i > 0 && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {CONNECTOR_LABELS[state.connectors[i - 1] ?? 'and']}
                  </span>
                )}
                <code className="cond-preview">{clauseToProse(c)}</code>
                <button
                  type="button"
                  className="link"
                  aria-label="remove rule"
                  title="Remove this rule"
                  onClick={(e) => {
                    e.preventDefault();
                    if (i === state.clauses.length - 1) doUndoLastClause();
                  }}
                  disabled={i !== state.clauses.length - 1}
                >
                  × remove rule
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <span className="muted ref-chips-hint">build:</span>
      <select
        className="ref-chip-select"
        value={state.column}
        onChange={(e) => onPickColumn(e.target.value as ConditionColumn | '')}
        title="Which column to add the fragment to"
      >
        <option value="">— column —</option>
        {COLUMN_OPTIONS.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
      <select
        className="ref-chip-select"
        value={state.draft.field}
        onChange={(e) => setDraft({ field: e.target.value, value: '' })}
        title="Pick a field"
        disabled={state.rawFallback !== null || !needsField}
      >
        <option value="">— field —</option>
        {splitFieldsByOp ? (
          <>
            <optgroup label="Typical for this check">
              {typicalFields.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </optgroup>
            {atypicalFields.length > 0 && (
              <optgroup label="Other fields">
                {atypicalFields.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </optgroup>
            )}
          </>
        ) : (
          props.fieldOptions.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))
        )}
      </select>
      {/* "Show all fields" — persistent escape hatch (plan v0.3 §3). Only
          rendered when the op-first filter is actually active; otherwise
          it would be a confusing no-op. Local UI state, never persisted. */}
      {fieldHasOpHint && (
        <label
          className="muted"
          style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
          title="Show every field, including those less common for this check"
        >
          <input
            type="checkbox"
            checked={showAllFields}
            onChange={(e) => setShowAllFields(e.target.checked)}
            disabled={state.rawFallback !== null}
          />
          Show all fields
        </label>
      )}
      <select
        className="ref-chip-select"
        value={state.draft.op}
        onChange={(e) => setDraft({ op: e.target.value as ClauseOp, value: '' })}
        title="Pick what to add"
        disabled={state.rawFallback !== null}
      >
        {opGroups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.ops.map((op) => (
              <option key={op} value={op}>
                {OPERATOR_LABELS[op]}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {choices && choices.length > 0 ? (
        <select
          className="ref-chip-select"
          value={state.draft.value}
          onChange={(e) => setDraft({ value: e.target.value })}
          title="Pick a value from this field's choices"
          disabled={state.rawFallback !== null || !needsValue}
        >
          <option value="">— value —</option>
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="cond-value-input"
          value={state.draft.value}
          onChange={(e) => setDraft({ value: e.target.value })}
          placeholder="value or ${other_field}"
          disabled={state.rawFallback !== null || !needsValue}
        />
      )}

      {/* Between-clause connector picker. Visible whenever a chain is in
          play, OR in grouped mode whenever the active subgroup has at
          least one clause. Locked after the first connector is chosen
          (intra-subgroup or flat) so flat-mixed AND/OR is structurally
          impossible (§3.3). The `( group these )` button is the escape
          hatch for mixed combinators. */}
      {((state.groups === null &&
        (state.clauses.length >= 1 || state.lockedConnector !== null)) ||
        (state.groups !== null && activeGroup !== null && activeGroup.clauses.length >= 1)) && (
        <select
          className="ref-chip-select"
          value={activeSubgroupConnector ?? connectorChoice}
          onChange={(e) => setConnectorChoice(e.target.value as 'and' | 'or')}
          title={
            activeSubgroupConnector !== null
              ? 'Mixing "and also" with "or instead" needs grouping. Press ( group these ) to combine rules.'
              : 'How the next rule combines with this one'
          }
          disabled={activeSubgroupConnector !== null}
        >
          <option value="and">{CONNECTOR_LABELS.and}</option>
          <option value="or">{CONNECTOR_LABELS.or}</option>
        </select>
      )}

      <button
        type="button"
        className="link"
        onClick={(e) => {
          e.preventDefault();
          doAddAnother();
        }}
        disabled={state.rawFallback !== null || !isDraftComplete(state.draft)}
        title={
          state.rawFallback !== null
            ? 'Clear the hand-written text first to use the builder'
            : 'Stage this clause and keep building'
        }
      >
        + add another rule
      </button>
      {canGroupThese && (
        <button
          type="button"
          className="link"
          onClick={(e) => {
            e.preventDefault();
            onGroupThese();
          }}
          title="Collect the current rules into a group so you can add rules joined by the other connector"
        >
          ( group these )
        </button>
      )}
      {state.groups !== null && (
        <button
          type="button"
          className="link"
          onClick={(e) => {
            e.preventDefault();
            onFlatten();
          }}
          disabled={!canFlatten}
          title={
            canFlatten
              ? 'Collapse the group back into a flat chain'
              : 'Remove a subgroup before flattening'
          }
        >
          flatten
        </button>
      )}
      <button
        type="button"
        className="link"
        onClick={(e) => {
          e.preventDefault();
          doInsert();
        }}
        disabled={!isInsertReady(state)}
        title={
          state.column
            ? `Write the full chain to ${state.column}`
            : 'Pick a column first'
        }
      >
        + insert
      </button>
      <button
        type="button"
        className="link"
        onClick={(e) => {
          e.preventDefault();
          doStartOver();
        }}
        disabled={
          state.clauses.length === 0 &&
          draftEmpty &&
          state.groups === null
        }
        title="Clear the in-progress chain (does not touch the saved value)"
      >
        × start over
      </button>
      {(state.clauses.length > 0 ||
        (activeGroup !== null && activeGroup.clauses.length > 0)) && (
        <button
          type="button"
          className="link"
          onClick={(e) => {
            e.preventDefault();
            doUndoLastClause();
          }}
          title="Pop the last committed clause off the chain"
        >
          ↶ undo last clause
        </button>
      )}
    </div>
  );
}

/* ------------------------------ Choices tab ----------------------------- */

function ChoicesTab(props: {
  form: XLSForm;
  patch: (n: XLSForm) => void;
  undo: () => void;
  getSnapshotId: () => number;
  jumpTo: (id: number) => void;
}) {
  const { form, patch } = props;
  const grouped = useMemo(() => groupChoices(form.choices), [form.choices]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // Inline rename for a choice list header. Mirrors InlineChoicesEditor's
  // commitRename — same token-aware rewrite via renameListInType + matching
  // ChoiceRow.list_name update, but anchored at the ChoicesTab header
  // (the inline editor only sees ONE row at a time).
  const [renamingList, setRenamingList] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>('');

  function commitListRename(oldName: string) {
    const target = renameDraft.trim();
    if (!target || target === oldName) {
      setRenamingList(null);
      return;
    }
    // Collision check — duplicating an existing list name would silently
    // merge two unrelated choice sets into one. Block with an alert; the
    // user must pick a different name.
    const otherLists = grouped
      .map((g) => g.list_name)
      .filter((l) => l !== oldName);
    if (otherLists.includes(target)) {
      // eslint-disable-next-line no-undef
      window.alert(
        `A list named "${target}" already exists. Pick a different name.`,
      );
      return;
    }
    const usingRows = form.survey.filter(
      (r) => extractListName(r.type) === oldName,
    );
    const matchingChoices = form.choices.filter((c) => c.list_name === oldName);
    if (usingRows.length > 0 || matchingChoices.length > 0) {
      // eslint-disable-next-line no-undef
      const ok = window.confirm(
        `Rename "${oldName}" → "${target}"? This updates ${usingRows.length} question${usingRows.length === 1 ? '' : 's'} and ${matchingChoices.length} choice${matchingChoices.length === 1 ? '' : 's'}. Undoable until save.`,
      );
      if (!ok) return;
    }
    patch({
      ...form,
      survey: form.survey.map((r) =>
        extractListName(r.type) === oldName
          ? { ...r, type: renameListInType(r.type, oldName, target) }
          : r,
      ),
      choices: form.choices.map((c) =>
        c.list_name === oldName ? { ...c, list_name: target } : c,
      ),
    });
    setRenamingList(null);
  }

  function onChoiceDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = form.choices.findIndex((c) => c.rowId === active.id);
    const newIndex = form.choices.findIndex((c) => c.rowId === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    // Only allow reordering within the same list_name to keep grouping stable.
    if (form.choices[oldIndex]?.list_name !== form.choices[newIndex]?.list_name) return;
    patch({ ...form, choices: arrayMove(form.choices, oldIndex, newIndex) });
  }

  function addChoice(list_name: string) {
    const newRow: ChoiceRow = {
      rowId: `c_new_${Date.now()}_${form.choices.length + 1}`,
      list_name,
      name: '',
      labels: {},
      extras: {},
    };
    patch({ ...form, choices: [...form.choices, newRow] });
  }

  function addList() {
    const name = window.prompt('Choice list name (e.g. yes_no, primary_conditions)');
    if (!name) return;
    addChoice(name);
  }

  function updateChoice(rowId: string, updater: (r: ChoiceRow) => ChoiceRow) {
    patch({
      ...form,
      choices: form.choices.map((c) => (c.rowId === rowId ? updater(c) : c)),
    });
  }

  function removeChoice(rowId: string) {
    if (!form) return;
    const choice = form.choices.find((c) => c.rowId === rowId);
    const snapshotId = props.getSnapshotId();
    patch({ ...form, choices: form.choices.filter((c) => c.rowId !== rowId) });
    showUndoToast({
      message: `Deleted choice "${choice?.name || rowId}"`,
      onUndo: () => props.jumpTo(snapshotId),
    });
  }

  function moveChoice(rowId: string, direction: -1 | 1) {
    const idx = form.choices.findIndex((c) => c.rowId === rowId);
    if (idx < 0) return;
    const newIndex = idx + direction;
    if (newIndex < 0 || newIndex >= form.choices.length) return;
    patch({ ...form, choices: arrayMove(form.choices, idx, newIndex) });
  }

  return (
    <div className="choices-tab">
      <div className="row gap toolbar">
        <button onClick={addList}>+ Choice list</button>
        <span className="muted">Choices are grouped by list_name.</span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onChoiceDragEnd}>
        {grouped.map((g) => (
          // `data-list-name` is a STABLE handle: rename mode replaces the
          // <h3> with an input, so anything selecting the section by its
          // heading text stops matching the moment rename is clicked.
          <section key={g.list_name} className="choice-list" data-list-name={g.list_name}>
            <header className="row gap">
              {renamingList === g.list_name ? (
                <>
                  <input
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitListRename(g.list_name);
                      if (e.key === 'Escape') setRenamingList(null);
                    }}
                    placeholder="new list name"
                    aria-label={`Rename list ${g.list_name}`}
                  />
                  <button className="link" onClick={() => commitListRename(g.list_name)}>
                    save
                  </button>
                  <button className="link" onClick={() => setRenamingList(null)}>
                    cancel
                  </button>
                </>
              ) : (
                <>
                  <h3>{g.list_name}</h3>
                  <button
                    className="link"
                    onClick={() => {
                      setRenameDraft(g.list_name);
                      setRenamingList(g.list_name);
                    }}
                    title="Rename this list (trailing tokens like or_other are preserved)"
                  >
                    rename
                  </button>
                </>
              )}
              <button className="link" onClick={() => addChoice(g.list_name)}>
                + choice
              </button>
              <span className="muted">Drag rows to reorder within this list.</span>
            </header>
            <table className="choice-table">
              <thead>
                <tr>
                  <th></th>
                  <th>name</th>
                  {form.choicesHeaders.labelLocales.map((loc) => (
                    <th key={loc}>label::{loc}</th>
                  ))}
                  <th></th>
                </tr>
              </thead>
              <SortableContext
                items={g.rows.map((c) => c.rowId)}
                strategy={verticalListSortingStrategy}
              >
                <tbody>
                  {g.rows.map((c) => (
                    <SortableChoiceRow
                      key={c.rowId}
                      row={c}
                      locales={form.choicesHeaders.labelLocales}
                      update={(u) => updateChoice(c.rowId, u)}
                      remove={() => removeChoice(c.rowId)}
                      moveUp={() => moveChoice(c.rowId, -1)}
                      moveDown={() => moveChoice(c.rowId, 1)}
                      onRename={(oldName, newName) =>
                        patch(renameChoiceValue(form, c.list_name, oldName, newName))
                      }
                    />
                  ))}
                </tbody>
              </SortableContext>
            </table>
          </section>
        ))}
      </DndContext>
    </div>
  );
}

function SortableChoiceRow(props: {
  row: ChoiceRow;
  locales: string[];
  update: (u: (r: ChoiceRow) => ChoiceRow) => void;
  remove: () => void;
  moveUp: () => void;
  moveDown: () => void;
  /** Atomic choice-value rename + expression ref-rewrite. */
  onRename: (oldName: string, newName: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.row.rowId,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  const { row } = props;
  return (
    <tr ref={setNodeRef} style={style}>
      <td>
        <button className="drag-handle" {...attributes} {...listeners} aria-label="drag">
          ⋮⋮
        </button>
      </td>
      <td>
        <ChoiceNameInput
          value={row.name}
          onChange={(next) => props.update((r) => ({ ...r, name: next }))}
          onRename={({ oldName, newName }) => props.onRename(oldName, newName)}
          fromLabel={row.labels[props.locales[0] ?? ''] ?? ''}
        />
      </td>
      {props.locales.map((loc) => (
        <td key={loc}>
          <input
            value={row.labels[loc] ?? ''}
            onChange={(e) =>
              props.update((r) => ({ ...r, labels: { ...r.labels, [loc]: e.target.value } }))
            }
          />
        </td>
      ))}
      <td className="row gap">
        <button className="link" onClick={props.moveUp}>↑</button>
        <button className="link" onClick={props.moveDown}>↓</button>
        <button className="link danger" onClick={props.remove}>×</button>
      </td>
    </tr>
  );
}

function groupChoices(rows: ChoiceRow[]): Array<{ list_name: string; rows: ChoiceRow[] }> {
  const out: Array<{ list_name: string; rows: ChoiceRow[] }> = [];
  const idx = new Map<string, number>();
  for (const r of rows) {
    if (!idx.has(r.list_name)) {
      idx.set(r.list_name, out.length);
      out.push({ list_name: r.list_name, rows: [] });
    }
    const i = idx.get(r.list_name);
    if (i !== undefined) out[i]?.rows.push(r);
  }
  return out;
}

/* ----------------------------- Translate tab ----------------------------- */

/**
 * Side-by-side translation grid. One row per labeled survey/choice row,
 * one column per locale, free-text cells. Editing a cell mutates
 * `row.labels[locale]` and propagates via `patch()`. Saves through the
 * normal form-save path.
 *
 * Only rows with a non-empty `name` and at least one existing label are
 * shown — structural begin/end markers and unlabeled calculate rows are
 * hidden so translators see only what they need to translate.
 */
function TranslateTab(props: { form: XLSForm; patch: (n: XLSForm) => void }) {
  const { form, patch } = props;
  const locales = form.surveyHeaders.labelLocales.length > 0
    ? form.surveyHeaders.labelLocales
    : ['en'];
  const choiceLocales = form.choicesHeaders.labelLocales.length > 0
    ? form.choicesHeaders.labelLocales
    : ['en'];
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState<'survey' | 'choices' | 'all'>('survey');

  const f = filter.trim().toLowerCase();
  const surveyRows = form.survey.filter((r) => {
    if (!r.name) return false;
    const hasAnyLabel = Object.values(r.labels).some((v) => v && v.trim());
    if (!hasAnyLabel) return false;
    if (!f) return true;
    if (r.name.toLowerCase().includes(f)) return true;
    return Object.values(r.labels).some((v) => v && v.toLowerCase().includes(f));
  });
  const choiceRows = form.choices.filter((c) => {
    if (!f) return true;
    if (c.list_name.toLowerCase().includes(f) || c.name.toLowerCase().includes(f)) return true;
    return Object.values(c.labels).some((v) => v && v.toLowerCase().includes(f));
  });

  function updateSurveyLabel(rowId: string, locale: string, value: string) {
    patch({
      ...form,
      survey: form.survey.map((r) =>
        r.rowId === rowId ? { ...r, labels: { ...r.labels, [locale]: value } } : r,
      ),
    });
  }
  function updateChoiceLabel(idx: number, locale: string, value: string) {
    patch({
      ...form,
      choices: form.choices.map((c, i) =>
        i === idx ? { ...c, labels: { ...c.labels, [locale]: value } } : c,
      ),
    });
  }

  const missingCounts = locales.map((loc) => ({
    locale: loc,
    missing: surveyRows.filter((r) => !r.labels[loc] || !r.labels[loc]!.trim()).length,
  }));

  return (
    <div className="translate-tab">
      <div className="row gap toolbar">
        <input
          type="search"
          placeholder="Filter by name or label text…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1, maxWidth: 320 }}
        />
        <div className="row gap mode-toggle">
          <button
            className={scope === 'survey' ? 'active' : 'link'}
            onClick={() => setScope('survey')}
          >
            Survey ({surveyRows.length})
          </button>
          <button
            className={scope === 'choices' ? 'active' : 'link'}
            onClick={() => setScope('choices')}
          >
            Choices ({choiceRows.length})
          </button>
          <button className={scope === 'all' ? 'active' : 'link'} onClick={() => setScope('all')}>
            All
          </button>
        </div>
        <div className="row gap">
          {missingCounts.map((m) => (
            <span key={m.locale} className={`badge${m.missing > 0 ? ' warn' : ''}`}>
              {m.locale}: {m.missing} missing
            </span>
          ))}
        </div>
      </div>

      {(scope === 'survey' || scope === 'all') && (
        <section>
          <h3>Survey labels</h3>
          <table className="translate-grid">
            <thead>
              <tr>
                <th style={{ width: 180 }}>Field</th>
                {locales.map((loc) => (
                  <th key={loc}>label::{loc}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {surveyRows.map((r) => (
                <tr key={r.rowId}>
                  <td>
                    <code>{r.name}</code>
                    <div className="muted small">{r.type}</div>
                  </td>
                  {locales.map((loc) => (
                    <td key={loc}>
                      <textarea
                        value={r.labels[loc] ?? ''}
                        onChange={(e) => updateSurveyLabel(r.rowId, loc, e.target.value)}
                        rows={Math.max(1, Math.ceil((r.labels[loc]?.length ?? 0) / 50))}
                        placeholder={`(empty — translate from ${locales.find((l) => l !== loc && r.labels[l]) ?? 'en'})`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
              {surveyRows.length === 0 && (
                <tr>
                  <td colSpan={locales.length + 1} className="muted">
                    No survey rows match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {(scope === 'choices' || scope === 'all') && (
        <section>
          <h3>Choice labels</h3>
          <table className="translate-grid">
            <thead>
              <tr>
                <th style={{ width: 180 }}>List / choice</th>
                {choiceLocales.map((loc) => (
                  <th key={loc}>label::{loc}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {choiceRows.map((c, i) => (
                <tr key={`${c.list_name}:${c.name}:${i}`}>
                  <td>
                    <code>{c.list_name}</code> / <code>{c.name}</code>
                  </td>
                  {choiceLocales.map((loc) => (
                    <td key={loc}>
                      <textarea
                        value={c.labels[loc] ?? ''}
                        onChange={(e) => updateChoiceLabel(i, loc, e.target.value)}
                        rows={1}
                      />
                    </td>
                  ))}
                </tr>
              ))}
              {choiceRows.length === 0 && (
                <tr>
                  <td colSpan={choiceLocales.length + 1} className="muted">
                    No choices match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

/* ----------------------------- Settings tab ----------------------------- */

function SettingsTab(props: { form: XLSForm; patch: (n: XLSForm) => void }) {
  const { form, patch } = props;
  const s = form.settings;

  function set<K extends 'form_title' | 'form_id' | 'version' | 'default_language'>(
    key: K,
    value: string,
  ) {
    patch({ ...form, settings: { ...s, [key]: value } });
  }

  return (
    <div className="settings-tab">
      <label>
        <span>Form title</span>
        <input value={s.form_title ?? ''} onChange={(e) => set('form_title', e.target.value)} />
      </label>
      <label>
        <span>Form id</span>
        <input value={s.form_id ?? ''} onChange={(e) => set('form_id', e.target.value)} />
      </label>
      <label>
        <span>Version</span>
        <input value={s.version ?? ''} onChange={(e) => set('version', e.target.value)} />
      </label>
      <label>
        <span>Default language</span>
        <input
          value={s.default_language ?? ''}
          onChange={(e) => set('default_language', e.target.value)}
          placeholder="en"
        />
      </label>
      {Object.keys(s.extras).length > 0 && (
        <div className="settings-extras">
          <h3>Other settings (read-only in MVP)</h3>
          {Object.entries(s.extras).map(([k, v]) => (
            <div key={k} className="row gap">
              <code>{k}</code>
              <code>{v}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------- Language chip bar (Wave 2 §4) ---------------------- */

/**
 * A curated list of common locales for the Add-language picker. ISO 639-1
 * short codes + display names in the language's native form. Not
 * exhaustive by design — the picker also carries a free-text escape hatch
 * for any locale not in the list (e.g. `qu`, `bo`, or a regional variant
 * like `en-GB`). Order roughly reflects CHT-project frequency; the
 * escape hatch keeps this from being a hard gate.
 */
const CURATED_LOCALES: Array<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'ne', name: 'नेपाली (Nepali)' },
  { code: 'hi', name: 'हिन्दी (Hindi)' },
  { code: 'fr', name: 'Français (French)' },
  { code: 'es', name: 'Español (Spanish)' },
  { code: 'ar', name: 'العربية (Arabic)' },
  { code: 'sw', name: 'Kiswahili (Swahili)' },
  { code: 'pt', name: 'Português (Portuguese)' },
];

function localeDisplayName(code: string): string {
  const hit = CURATED_LOCALES.find((l) => l.code === code);
  return hit ? hit.name : code;
}

/**
 * Wave 2 §4 — language chip bar rendered above the survey editor. Each
 * currently-active locale renders as a read-only chip; the trailing
 * `+ Add language` button opens a small inline popover with the curated
 * shortlist + a free-text escape hatch. Selecting or entering a locale
 * dispatches `onAdd(code)`; the parent handles the store mutation +
 * .properties-file creation. Idempotent — passing a code that's already
 * in `locales` is a no-op upstream.
 */
function LanguageChipBar(props: { locales: string[]; onAdd: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const [customCode, setCustomCode] = useState('');
  const activeLocales = props.locales.length > 0 ? props.locales : ['en'];
  // Curated locales not already active — the shortlist buttons.
  const availableCurated = CURATED_LOCALES.filter((l) => !activeLocales.includes(l.code));

  function close() {
    setOpen(false);
    setCustomCode('');
  }

  function commitCustom() {
    // ISO 639-1 short code shape: 2–3 letters, optionally
    // hyphen/underscore + region tag (mirrors LABEL_HEADER_RE).
    const cleaned = customCode.trim().toLowerCase();
    if (!/^[a-z]{2,3}(?:[-_][A-Za-z0-9]+)?$/.test(cleaned)) return;
    props.onAdd(cleaned);
    close();
  }

  return (
    <div className="language-chip-bar">
      <span className="muted small language-chip-bar-legend">Languages:</span>
      {activeLocales.map((loc) => (
        <span key={loc} className="language-chip" title={localeDisplayName(loc)}>
          {localeDisplayName(loc)}
        </span>
      ))}
      <div className="language-chip-add-wrap">
        <button
          type="button"
          className="link language-chip-add"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Add a translation language to this form"
        >
          + Add language
        </button>
        {open && (
          <div className="language-chip-popover" role="dialog" aria-label="Add language">
            <p className="muted small">Pick a language to add to this form.</p>
            <ul className="language-chip-popover-list">
              {availableCurated.map((l) => (
                <li key={l.code}>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      props.onAdd(l.code);
                      close();
                    }}
                  >
                    <code>{l.code}</code> — {l.name}
                  </button>
                </li>
              ))}
              {availableCurated.length === 0 && (
                <li className="muted small">All shortlisted languages already added.</li>
              )}
            </ul>
            <div className="language-chip-custom">
              <label className="muted small">
                Or type an ISO 639-1 code (e.g. <code>bo</code>, <code>en-GB</code>):
              </label>
              <div className="row gap">
                <input
                  value={customCode}
                  onChange={(e) => setCustomCode(e.target.value)}
                  placeholder="xx"
                  autoComplete="off"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitCustom();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      close();
                    }
                  }}
                />
                <button type="button" onClick={commitCustom}>
                  Add
                </button>
                <button type="button" className="link" onClick={close}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
