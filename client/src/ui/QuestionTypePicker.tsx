/**
 * Kobo-style question-type picker.
 *
 * A modal that shows a tile grid grouped by category. The user types a
 * question name, picks a tile, and the parent gets back the chosen
 * SurveyRow shape (with sensible default extras and an auto-generated
 * list_name token for select_one / select_multiple).
 *
 * This file is intentionally pure-presentational — no XLSForm parsing,
 * no store access. The parent decides whether picking commits immediately
 * or stages a draft.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { slugifyHierarchyId, type ReportFieldChoice } from '@cht-ui/shared';
import { ValidationPanel } from './ValidationPanel.js';
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  QUESTION_TYPE_TILES,
  type QuestionTypeTile,
  type TileCategory,
} from './QuestionTypeCatalog.js';

export interface PickerCommit {
  /** Final `type:` cell value (e.g. `select_one option_list_3`). */
  type: string;
  /** Initial `extras` (e.g. `{ appearance: 'likert' }`). */
  extras: Record<string, string>;
  /** Name typed in the picker (may be empty). */
  name: string;
  /**
   * Wave 2 §3b — label-first section authoring. When set (currently only
   * from `sectionMode`), the parent uses this friendly label as the
   * initial `labels.en` value on the created row. `name` is the
   * auto-derived slug. Undefined for the legacy add-question path.
   */
  label?: string;
  /**
   * Wave 2 §4 — add-time inline labels. One entry per active locale
   * (mirrors `labelLocales` passed in). Absent when the picker was
   * mounted without any `labelLocales` (legacy behavior — only the `en`
   * fallback). The parent uses this to seed the created row's
   * `labels` map, ensuring every active locale carries an entry (empty
   * string when the user didn't type one) so a translator's grid shows
   * the missing cell rather than dropping the row silently.
   */
  labels?: Record<string, string>;
  /** Tile id that was picked (for analytics / re-opening). */
  tileId: string;
  /**
   * For selects: a generated `list_name` token + the initial choice rows the
   * user added inline. Parent is responsible for appending them to
   * `form.choices` (we don't have access to it from here).
   */
  list?: {
    list_name: string;
    /**
     * Per-locale labels, keyed exactly like a survey row's (docs/NEXT.md
     * item F). Every ACTIVE locale gets an entry — empty string where the
     * author left it blank — so a new list's choices never render as a
     * missing row in the translator's grid, and a bilingual list needs no
     * detour through Translate → Choices.
     */
    choices: Array<{ name: string; labels: Record<string, string> }>;
  };
  /**
   * T9d (#17) — the configure step. Absent when the step was skipped
   * (one-click tiles, structural tiles, edit-type reopens). The parent
   * writes `required = yes`, `hint::<loc>`, `constraint` and
   * `constraint_message::<loc>` for the non-empty values only.
   */
  details?: {
    required: boolean;
    hints: Record<string, string>;
    constraint: string;
    constraintMessages: Record<string, string>;
  };
}

interface Props {
  /** Title text on the modal header. */
  title?: string;
  /** Initial value of the name field. */
  initialName?: string;
  /** When set, that tile id is pre-selected on open (used by edit-type flow). */
  initialTileId?: string;
  /**
   * Simple/Full filter — when "simple", tiles marked `hiddenInSimple` are
   * filtered out of the grid. That is now just `hidden` and the
   * `lineage_block` sentinel: Group and Repeat were unhidden in Wave 1 /
   * audit item 15, and Calculate in docs/NEXT.md item 1.
   */
  mode?: 'simple' | 'full';
  /** Form category — used to filter tiles that don't apply to the
   *  current form variant. Per docs/plans/hierarchy-block-generator.md
   *  §4.8 + §8.7 the lineage block is **app/report only** (variant A);
   *  variant B for contact-edit forms is deferred. */
  formCategory?: 'app' | 'contact';
  /**
   * Existing `list_name`s in this form, used to offer "reuse existing list"
   * for select_one / select_multiple. Empty array hides the reuse UI.
   */
  existingLists?: string[];
  /** Suggested list_name when the user picks select_one / multiple. */
  defaultListNameSeed?: string;
  /** Hide the "name" field (used when re-typing an existing row). */
  hideNameField?: boolean;
  /** Label on the primary commit button. Defaults to "Add question". */
  commitLabel?: string;
  /**
   * Wave 2 §3b — "+ Add section" flow. When true, the picker skips the
   * tile grid entirely and shows a section-authoring form: a friendly
   * LABEL input (slug auto-derived via `slugifyHierarchyId`), an
   * appearance toggle for "Show all on one screen" (= `field-list`),
   * and commits a `begin group` tile. Prevents users from having to
   * discover the Structure category before they can create a section.
   */
  sectionMode?: boolean;
  /**
   * Wave 2 §4 — active locales the form declares (drives the add-time
   * inline label inputs). One stacked `<input>` renders per entry; the
   * captured values are threaded through the commit's `labels` map so
   * the parent can seed the created row with an entry per locale (empty
   * string for locales the user didn't fill in). Empty / omitted →
   * legacy single-language behavior with the built-in `en` input.
   */
  labelLocales?: string[];
  /**
   * T9d (#17) — fields the Validation slot's "✎ build" modal may reference:
   * the uniquely-named, non-plumbing rows BEFORE the insert position, in
   * sheet order (the same list the row card computes as `earlierFields`).
   * Absent → the slot is a plain expression box.
   */
  fieldOptions?: string[];
  fieldChoiceOptions?: Record<string, ReportFieldChoice[]>;
  /**
   * T9d — when true, a question tile commits on the click, as before the
   * configure step existed. The step's "always skip this step" box flips
   * it through `onOneClickTilesChange`; the parent persists it.
   */
  oneClickTiles?: boolean;
  onOneClickTilesChange?: (next: boolean) => void;
  onCancel: () => void;
  onCommit: (commit: PickerCommit) => void;
}

type PickerStep = 'pick-type' | 'configure-list' | 'configure';

export function QuestionTypePicker(props: Props) {
  const mode = props.mode ?? 'full';
  const [step, setStep] = useState<PickerStep>('pick-type');
  const [name, setName] = useState(props.initialName ?? '');
  const [activeTileId, setActiveTileId] = useState<string | undefined>(props.initialTileId);
  const [filter, setFilter] = useState<'all' | 'cht'>('all');
  const [search, setSearch] = useState('');
  const [listChoice, setListChoice] = useState<'new' | string>('new');
  const [newListName, setNewListName] = useState(() =>
    suggestListName(props.defaultListNameSeed ?? props.initialName ?? 'options'),
  );
  // docs/NEXT.md item F — each draft choice carries a label PER LOCALE,
  // keyed by locale code (same convention as the question-label state
  // below, so re-ordering `labelLocales` can't rebind typed values to the
  // wrong locale). Previously one label column meant every bilingual list
  // needed a detour to Translate → Choices.
  const [draftChoices, setDraftChoices] = useState<
    Array<{ name: string; labels: Record<string, string> }>
  >([
    { name: '', labels: {} },
    { name: '', labels: {} },
  ]);
  // Wave 2 §4 — add-time inline label per active locale. Keyed by locale
  // code so re-orderings of the parent's `labelLocales` prop don't rebind
  // typed values to the wrong locale. Every active locale gets an entry
  // (even if empty) so the commit downstream can seed the row with an
  // entry per locale — a missing key downstream would drop the row from a
  // translator's grid when the form re-loads. The `en` slot survives even
  // when the picker was mounted without `labelLocales` (legacy shape).
  const activeLocales = useMemo(() => {
    const list = props.labelLocales ?? [];
    return list.length > 0 ? list : ['en'];
  }, [props.labelLocales]);
  const [localeLabels, setLocaleLabels] = useState<Record<string, string>>({});
  // Wave 2 §3b — section-mode state. `sectionLabel` is the friendly name
  // the user types; `sectionSlug` is derived via `slugifyHierarchyId`
  // (same helper Quick Hierarchy Creator / deriveFormName use, so the
  // shape of "type friendly, auto-slug" is consistent across the tool).
  // `sectionAppearance` toggles the `field-list` XLSForm appearance.
  // `sectionKind` (audit item 15 resolution) lets the same entry point
  // author a Repeat — "+ Section" used to bypass the tile grid entirely,
  // making `begin_repeat` unreachable from it.
  // T9d (#17) — the configure step's state: required, a hint per active
  // locale, and the Validation slot (constraint + a message per locale).
  // In this slice the slot is the existing "✎ build" modal over a plain
  // expression box; 9e replaces it with presets.
  const [required, setRequired] = useState(false);
  const [hints, setHints] = useState<Record<string, string>>({});
  const [constraint, setConstraint] = useState('');
  const [constraintMessages, setConstraintMessages] = useState<Record<string, string>>({});
  const [sectionLabel, setSectionLabel] = useState('');
  const [sectionAppearance, setSectionAppearance] = useState<'default' | 'field-list'>('default');
  const [sectionKind, setSectionKind] = useState<'group' | 'repeat'>('group');
  const sectionSlug = useMemo(() => slugifyHierarchyId(sectionLabel), [sectionLabel]);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sectionLabelInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (props.sectionMode) {
      sectionLabelInputRef.current?.focus();
      return;
    }
    if (props.hideNameField) {
      searchInputRef.current?.focus();
    } else {
      nameInputRef.current?.focus();
    }
  }, [props.hideNameField, props.sectionMode]);

  // Escape to dismiss.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        props.onCancel();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const tiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return QUESTION_TYPE_TILES.filter((t) => {
      if (mode === 'simple' && t.hiddenInSimple) return false;
      if (filter === 'cht' && !t.chtOnly) return false;
      // Plan §4.8 + §8.7 — `lineage_block` is app/report-only (variant A).
      // The contact-edit variant (B) was DEFERRED at v1; hide the tile
      // when authoring a contact form so the user can't pick a tile that
      // would generate an invalid block for their form category.
      if (t.id === 'lineage_block' && props.formCategory === 'contact') return false;
      if (q && !t.label.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [mode, filter, search, props.formCategory]);

  const byCategory = useMemo(() => {
    const map = new Map<TileCategory, QuestionTypeTile[]>();
    for (const t of tiles) {
      if (!map.has(t.category)) map.set(t.category, []);
      map.get(t.category)!.push(t);
    }
    return map;
  }, [tiles]);

  const activeTile = activeTileId
    ? QUESTION_TYPE_TILES.find((t) => t.id === activeTileId)
    : undefined;

  /**
   * T9d (#17) — tiles that never get the configure step: structure (a
   * group has no answer to require or validate), the lineage sentinel,
   * hidden rows, and any re-type of an existing row (labels, required and
   * rules already live on that row).
   */
  function skipsConfigure(tile: QuestionTypeTile): boolean {
    if (props.hideNameField) return true;
    if (props.oneClickTiles) return true;
    const t = tile.xlsformType.trim().toLowerCase();
    return (
      tile.id === 'lineage_block' ||
      tile.id === 'hidden' ||
      t === 'begin group' ||
      t === 'begin repeat'
    );
  }

  function handlePick(tile: QuestionTypeTile) {
    setActiveTileId(tile.id);
    if (tile.needsListName) {
      // Reseed the suggested list name from the latest typed name.
      setNewListName(suggestListName(name || tile.id, props.existingLists ?? []));
      setStep('configure-list');
      return;
    }
    if (skipsConfigure(tile)) {
      // Kobo parity: single-click commits a tile that needs no further setup.
      // Defer to the next tick so React flushes the activeTileId state first
      // (so the closure in commit() sees the just-clicked tile).
      requestAnimationFrame(() => commitFor(tile));
      return;
    }
    setStep('configure');
  }

  /** The configure step's values, or undefined when the step was skipped. */
  function detailsFor(tile: QuestionTypeTile): PickerCommit['details'] {
    if (skipsConfigure(tile)) return undefined;
    const trimmedHints: Record<string, string> = {};
    const trimmedMessages: Record<string, string> = {};
    for (const loc of activeLocales) {
      trimmedHints[loc] = (hints[loc] ?? '').trim();
      trimmedMessages[loc] = (constraintMessages[loc] ?? '').trim();
    }
    return {
      required,
      hints: trimmedHints,
      constraint: constraint.trim(),
      constraintMessages: trimmedMessages,
    };
  }

  function commitFor(tile: QuestionTypeTile, skipDetails = false) {
    let typeCell = tile.xlsformType;
    let list: PickerCommit['list'] | undefined;
    if (tile.needsListName) {
      const chosenList =
        listChoice === 'new' ? newListName.trim() || 'options' : listChoice;
      typeCell = `${tile.xlsformType} ${chosenList}`;
      if (listChoice === 'new') {
        list = {
          list_name: chosenList,
          choices: draftChoices
            .map((c) => {
              // Pack an entry for every ACTIVE locale, never a missing key
              // — a missing key drops the choice from that locale's column
              // in the translator's grid instead of showing it as blank.
              const labels: Record<string, string> = {};
              for (const loc of activeLocales) labels[loc] = (c.labels[loc] ?? '').trim();
              return { name: c.name.trim(), labels };
            })
            .filter((c) => c.name || Object.values(c.labels).some(Boolean)),
        };
      }
    }
    // Wave 2 §4 — pack an entry per ACTIVE locale (never a missing key)
    // so downstream `handlePickerCommit` can materialize an empty string
    // for every locale the form declares. `labels[loc] === ''` is the
    // authoring-time "missing" cue TranslationsEditor's "!" glyph is
    // built around; a truly missing key would drop the row from the
    // translator's grid entirely.
    const labels: Record<string, string> = {};
    for (const loc of activeLocales) {
      labels[loc] = (localeLabels[loc] ?? '').trim();
    }
    props.onCommit({
      type: typeCell,
      extras: { ...(tile.defaultExtras ?? {}) },
      name,
      tileId: tile.id,
      list,
      labels,
      details: skipDetails ? undefined : detailsFor(tile),
    });
  }

  function commit() {
    if (!activeTile) return;
    // T9d — a select's choices step leads into the configure step, like a
    // tile click does; the configure step itself commits.
    if (step === 'configure-list' && !skipsConfigure(activeTile)) {
      setStep('configure');
      return;
    }
    commitFor(activeTile);
  }

  function addChoiceRow() {
    setDraftChoices((rows) => [...rows, { name: '', labels: {} }]);
  }
  function updateChoiceName(idx: number, name: string) {
    setDraftChoices((rows) => rows.map((r, i) => (i === idx ? { ...r, name } : r)));
  }
  function updateChoiceLabel(idx: number, locale: string, label: string) {
    setDraftChoices((rows) =>
      rows.map((r, i) => (i === idx ? { ...r, labels: { ...r.labels, [locale]: label } } : r)),
    );
  }
  function removeChoiceRow(idx: number) {
    setDraftChoices((rows) => rows.filter((_, i) => i !== idx));
  }

  const canCommitFromPickType = Boolean(activeTile && !activeTile.needsListName);

  // Wave 2 §3b — commit a section (or, audit item 15, a repeat). Uses the
  // shared `begin_group` / `begin_repeat` tile catalog entries so
  // `handlePickerCommit`'s existing begin+end pair insert machinery
  // (FormEditor.tsx:844) stays authoritative — it already pairs both
  // kinds. We only supply the label + slug + optional appearance override.
  function commitSection() {
    const tileId = sectionKind === 'repeat' ? 'begin_repeat' : 'begin_group';
    const beginGroupTile = QUESTION_TYPE_TILES.find((t) => t.id === tileId);
    if (!beginGroupTile) return;
    const label = sectionLabel.trim();
    const slug = sectionSlug;
    if (!label || !slug) return;
    const extras: Record<string, string> = { ...(beginGroupTile.defaultExtras ?? {}) };
    // `field-list` is one-screen-per-GROUP semantics; a repeat gets its
    // own screen per iteration, so the toggle only applies to sections
    // (the checkbox is hidden for repeats below).
    if (sectionKind === 'group' && sectionAppearance === 'field-list') {
      extras.appearance = 'field-list';
    }
    // Build the per-locale labels map: the section title lands in the
    // form's FIRST active locale; other locales get the translations
    // typed in the additional inputs (or '' — a visible missing cell in
    // the translator grid). Passing a proper `labels` map keeps
    // `seedLabels` off its en-hardcoded fallback path (audit P1-6).
    const labels: Record<string, string> = {};
    for (const loc of activeLocales) {
      labels[loc] = (localeLabels[loc] ?? '').trim();
    }
    labels[activeLocales[0] ?? 'en'] = label;
    props.onCommit({
      type: beginGroupTile.xlsformType,
      extras,
      name: slug,
      label,
      labels,
      tileId: beginGroupTile.id,
    });
  }
  const canCommitSection = Boolean(sectionLabel.trim() && sectionSlug);

  return (
    <div className="qtype-backdrop" onMouseDown={(e) => {
      if (e.target === e.currentTarget) props.onCancel();
    }}>
      <div className="qtype-modal" role="dialog" aria-label={props.sectionMode ? 'Add section' : 'Pick question type'}>
        <div className="qtype-header">
          <h2>{props.title ?? (props.sectionMode ? 'Add section' : 'Add question')}</h2>
          <button className="link" onClick={props.onCancel} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Wave 2 §3b — section-mode short-form. Skips the tile grid
             (the Structure category is the only choice) and captures the
             friendly label. The slug is auto-derived via
             `slugifyHierarchyId`; users never type an XLSForm identifier
             (mirrors the label-first pattern from ChoiceNameInput /
             CreateFormDialog). */}
        {props.sectionMode && (
          <>
            {/* Audit item 15 — Section vs Repeat choice. "+ Section" skips
                 the tile grid, so without this the (now-unhidden)
                 begin_repeat tile was unreachable from the toolbar's
                 primary structural entry point. */}
            <fieldset className="qtype-name-field">
              <legend className="muted small">What kind of block?</legend>
              <label className="row gap" style={{ alignItems: 'center' }}>
                <input
                  type="radio"
                  name="section-kind"
                  value="group"
                  checked={sectionKind === 'group'}
                  onChange={() => setSectionKind('group')}
                />
                <span>
                  <strong>Section</strong>{' '}
                  <span className="muted small">— asked once, groups related questions</span>
                </span>
              </label>
              <label className="row gap" style={{ alignItems: 'center' }}>
                <input
                  type="radio"
                  name="section-kind"
                  value="repeat"
                  checked={sectionKind === 'repeat'}
                  onChange={() => setSectionKind('repeat')}
                />
                <span>
                  <strong>Repeat</strong>{' '}
                  <span className="muted small">
                    — asked once per item (e.g. per medication, per child)
                  </span>
                </span>
              </label>
            </fieldset>
            <label className="qtype-name-field">
              <span>{sectionKind === 'repeat' ? 'Repeat title' : 'Section title'}</span>
              <input
                ref={sectionLabelInputRef}
                value={sectionLabel}
                onChange={(e) => setSectionLabel(e.target.value)}
                placeholder="e.g. Danger signs"
                autoComplete="off"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canCommitSection) {
                    e.preventDefault();
                    commitSection();
                  }
                }}
              />
              <span className="muted small">
                {sectionSlug ? (
                  <>
                    Saved as <code>{sectionSlug}</code>
                  </>
                ) : (
                  <>Type a friendly name — used as the section heading.</>
                )}
              </span>
            </label>
            {/* Audit P1-6 — a bilingual form gets one heading input per
                 ADDITIONAL locale (the primary title above lands in the
                 first active locale). Empty = a visible missing cell in
                 the translator grid, never a stray label::en column. */}
            {activeLocales.length > 1 && (
              <fieldset className="qtype-labels-field">
                <span className="qtype-labels-legend">
                  {sectionKind === 'repeat' ? 'Repeat' : 'Section'} heading in other languages
                </span>
                {activeLocales.slice(1).map((loc) => (
                  <label key={loc} className="qtype-locale-label">
                    <span className="muted small">label::{loc}</span>
                    <input
                      value={localeLabels[loc] ?? ''}
                      onChange={(e) =>
                        setLocaleLabels((prev) => ({ ...prev, [loc]: e.target.value }))
                      }
                      placeholder="Add translation…"
                      autoComplete="off"
                    />
                  </label>
                ))}
              </fieldset>
            )}
            {sectionKind === 'group' && (
              <label className="qtype-name-field">
                <input
                  type="checkbox"
                  checked={sectionAppearance === 'field-list'}
                  onChange={(e) =>
                    setSectionAppearance(e.target.checked ? 'field-list' : 'default')
                  }
                />{' '}
                Show all questions on one screen{' '}
                <span className="muted small">
                  (XLSForm <code>field-list</code> appearance)
                </span>
              </label>
            )}
            <div className="qtype-actions">
              <button className="link" onClick={props.onCancel}>
                Cancel
              </button>
              <button onClick={commitSection} disabled={!canCommitSection}>
                {sectionKind === 'repeat' ? 'Add repeat' : (props.commitLabel ?? 'Add section')}
              </button>
            </div>
          </>
        )}

        {!props.sectionMode && step === 'pick-type' && (
          <>
            {!props.hideNameField && (
              <label className="qtype-name-field">
                <span>Question name</span>
                <input
                  ref={nameInputRef}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. has_fever, patient_age"
                  autoComplete="off"
                />
                <span className="muted small">
                  Used in expressions as <code>${'${' + (name || 'name') + '}'}</code>. No spaces.
                </span>
              </label>
            )}

            {/* Wave 2 §4 — add-time inline labels, one input per active
                 locale. Rendered only when the picker is in ADD mode
                 (hideNameField is set only on edit-type reopens, which
                 re-type an existing row and leave labels alone). Stacked
                 layout mirrors the row card's labels-grid. Empty inputs
                 still ship an entry so translators see a missing cue
                 rather than a dropped row. */}
            {!props.hideNameField && (
              <div className="qtype-labels-field">
                <span className="qtype-labels-legend">Label{activeLocales.length > 1 ? 's' : ''}</span>
                {activeLocales.map((loc) => (
                  <label key={loc} className="qtype-locale-label">
                    <span className="locale-tag">label::{loc}</span>
                    <input
                      value={localeLabels[loc] ?? ''}
                      onChange={(e) =>
                        setLocaleLabels((prev) => ({ ...prev, [loc]: e.target.value }))
                      }
                      placeholder={
                        activeLocales.length > 1
                          ? `Question text in ${loc}`
                          : 'What the user reads (e.g. "Do you feel chest pain?")'
                      }
                      autoComplete="off"
                    />
                  </label>
                ))}
                {activeLocales.length > 1 && (
                  <span className="muted small">
                    Leave a locale blank and it will show a missing-translation cue in the
                    editor.
                  </span>
                )}
              </div>
            )}

            <div className="qtype-toolbar">
              <input
                ref={searchInputRef}
                className="qtype-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search types…"
                autoComplete="off"
              />
              <div className="qtype-filter">
                <label>
                  <input
                    type="radio"
                    checked={filter === 'all'}
                    onChange={() => setFilter('all')}
                  />
                  All
                </label>
                <label>
                  <input
                    type="radio"
                    checked={filter === 'cht'}
                    onChange={() => setFilter('cht')}
                  />
                  CHT-only
                </label>
              </div>
            </div>

            <div className="qtype-grid-scroll">
              {CATEGORY_ORDER.filter((c) => (byCategory.get(c)?.length ?? 0) > 0).map((cat) => (
                <section key={cat} className="qtype-cat">
                  <h3>{CATEGORY_LABELS[cat]}</h3>
                  <div className="qtype-grid">
                    {(byCategory.get(cat) ?? []).map((tile) => (
                      <button
                        key={tile.id}
                        type="button"
                        className={`qtype-tile${activeTileId === tile.id ? ' active' : ''}`}
                        onClick={() => handlePick(tile)}
                        title={tile.description}
                      >
                        <span className="qtype-tile-icon">{tile.icon}</span>
                        <span className="qtype-tile-label">{tile.label}</span>
                        <span className="qtype-tile-hint">{tile.description}</span>
                        {tile.chtOnly && <span className="qtype-badge">CHT</span>}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {tiles.length === 0 && (
                <p className="muted">No tiles match "{search}". Clear the search to see all.</p>
              )}
            </div>

            <div className="qtype-actions">
              <button className="link" onClick={props.onCancel}>
                Cancel
              </button>
              <button
                onClick={commit}
                disabled={!canCommitFromPickType}
                title={
                  !activeTile
                    ? 'Pick a type tile first'
                    : activeTile.needsListName
                      ? 'Click "Next: choices" instead'
                      : ''
                }
              >
                {props.commitLabel ?? 'Add question'}
              </button>
            </div>
          </>
        )}

        {!props.sectionMode && step === 'configure-list' && activeTile && (
          <>
            <p className="muted">
              <strong>{activeTile.label}</strong> needs a list of options. Add them now or pick
              an existing list.
            </p>

            {(props.existingLists?.length ?? 0) > 0 && (
              <div className="qtype-list-choice">
                <label>
                  <input
                    type="radio"
                    checked={listChoice === 'new'}
                    onChange={() => setListChoice('new')}
                  />
                  Create new list
                </label>
                {(props.existingLists ?? []).map((l) => (
                  <label key={l}>
                    <input
                      type="radio"
                      checked={listChoice === l}
                      onChange={() => setListChoice(l)}
                    />
                    Reuse <code>{l}</code>
                  </label>
                ))}
              </div>
            )}

            {listChoice === 'new' && (
              <>
                <label className="qtype-name-field">
                  <span>List name</span>
                  <input
                    value={newListName}
                    onChange={(e) => setNewListName(e.target.value)}
                    placeholder="options"
                  />
                  <span className="muted small">
                    Identifier used in <code>{activeTile.xlsformType} {newListName || 'name'}</code>.
                  </span>
                </label>

                {/* docs/NEXT.md item F — one label column PER ACTIVE
                     LOCALE. A bilingual list used to need ~6 extra
                     interactions via Translate → Choices, on every select
                     in the form. The grid widens with the locale count;
                     the single-locale case is unchanged visually. */}
                <div
                  className="qtype-choices-edit"
                  style={
                    {
                      '--qtype-choice-locales': activeLocales.length,
                    } as React.CSSProperties
                  }
                >
                  <div className="qtype-choices-head">
                    <span>name</span>
                    {activeLocales.map((loc) => (
                      <span key={loc}>
                        label{activeLocales.length > 1 ? `::${loc}` : ''} (shown to user)
                        {loc === activeLocales[activeLocales.length - 1]
                          ? ' — press Enter to add another'
                          : ''}
                      </span>
                    ))}
                    <span />
                  </div>
                  {draftChoices.map((row, i) => (
                    <div key={i} className="qtype-choice-row">
                      <input
                        value={row.name}
                        onChange={(e) => updateChoiceName(i, e.target.value)}
                        placeholder="yes"
                        aria-label={`Choice ${i + 1} name`}
                      />
                      {activeLocales.map((loc, li) => (
                        <input
                          key={loc}
                          value={row.labels[loc] ?? ''}
                          onChange={(e) => updateChoiceLabel(i, loc, e.target.value)}
                          placeholder={li === 0 ? 'Yes' : `Yes (${loc})`}
                          aria-label={`Choice ${i + 1} label in ${loc}`}
                          onKeyDown={(e) => {
                            // Enter on the LAST locale of the LAST row adds
                            // another choice, so a keyboard author can run
                            // straight down the list.
                            if (
                              e.key === 'Enter' &&
                              li === activeLocales.length - 1 &&
                              i === draftChoices.length - 1 &&
                              (row.name || Object.values(row.labels).some(Boolean))
                            ) {
                              e.preventDefault();
                              addChoiceRow();
                            }
                          }}
                        />
                      ))}
                      <button
                        className="link danger"
                        onClick={() => removeChoiceRow(i)}
                        disabled={draftChoices.length <= 1}
                        aria-label="Remove choice"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button className="link" onClick={addChoiceRow}>
                    + Add choice
                  </button>
                </div>
              </>
            )}

            <div className="qtype-actions">
              <button className="link" onClick={() => setStep('pick-type')}>
                ← Back
              </button>
              <button onClick={commit}>
                {skipsConfigure(activeTile) ? (props.commitLabel ?? 'Add question') : 'Next: details'}
              </button>
            </div>
          </>
        )}

        {/* T9d (#17) — the configure step between the type tile and the
             commit: required, a hint per visible language, and the
             Validation slot. Enter anywhere commits; "add without details"
             is the one-click behaviour for this question; "always skip"
             remembers that choice. */}
        {!props.sectionMode && step === 'configure' && activeTile && (
          <div
            className="qtype-configure"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.target as { tagName?: string }).tagName !== 'TEXTAREA') {
                e.preventDefault();
                commitFor(activeTile);
              }
            }}
          >
            <p className="muted">
              <span className="qtype-tile-icon">{activeTile.icon}</span>{' '}
              <strong>{activeTile.label}</strong>
              {name ? (
                <>
                  {' '}
                  — <code>{name}</code>
                </>
              ) : null}
              . Set the details now, or add it as is.
            </p>

            <label className="qtype-name-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
                autoFocus
              />
              Required — the form cannot be submitted without an answer
            </label>

            <div className="qtype-labels-field">
              <span className="qtype-labels-legend">Hint{activeLocales.length > 1 ? 's' : ''}</span>
              {activeLocales.map((loc) => (
                <label key={loc} className="qtype-locale-label">
                  <span className="locale-tag">hint::{loc}</span>
                  <input
                    value={hints[loc] ?? ''}
                    onChange={(e) => setHints((prev) => ({ ...prev, [loc]: e.target.value }))}
                    placeholder={
                      activeLocales.length > 1
                        ? `Help text shown under the question, in ${loc}`
                        : 'Help text shown under the question (optional)'
                    }
                    autoComplete="off"
                  />
                </label>
              ))}
            </div>

            {/* T9e (#18) — the Validation panel: presets per question type,
                 a message per language. The choices typed in the previous
                 step feed "[choice] must be chosen alone". */}
            <ValidationPanel
              compact
              questionType={
                activeTile.needsListName
                  ? `${activeTile.xlsformType} ${listChoice === 'new' ? newListName.trim() || 'options' : listChoice}`
                  : activeTile.xlsformType
              }
              value={constraint}
              onChange={setConstraint}
              locales={activeLocales}
              messages={constraintMessages}
              onMessageChange={(loc, v) => setConstraintMessages((prev) => ({ ...prev, [loc]: v }))}
              fieldOptions={props.fieldOptions ?? []}
              choices={
                listChoice === 'new'
                  ? draftChoices
                      .filter((c) => c.name.trim())
                      .map((c) => ({
                        name: c.name.trim(),
                        label: (c.labels[activeLocales[0] ?? 'en'] ?? '').trim() || c.name.trim(),
                      }))
                  : []
              }
            />

            <div className="qtype-actions">
              <button
                className="link"
                onClick={() => setStep(activeTile.needsListName ? 'configure-list' : 'pick-type')}
              >
                ← Back
              </button>
              {props.onOneClickTilesChange && (
                <label className="muted small" style={{ marginRight: 'auto' }}>
                  <input
                    type="checkbox"
                    checked={Boolean(props.oneClickTiles)}
                    onChange={(e) => props.onOneClickTilesChange?.(e.target.checked)}
                  />{' '}
                  Always skip this step
                </label>
              )}
              <button
                className="link"
                onClick={() => commitFor(activeTile, true)}
                title="Add the question with no details (one click, as before)"
              >
                add without details
              </button>
              <button onClick={() => commitFor(activeTile)}>
                {props.commitLabel ?? 'Add question'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function suggestListName(seed: string, existing: string[] = []): string {
  const base =
    seed
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'options';
  const used = new Set(existing);
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}
