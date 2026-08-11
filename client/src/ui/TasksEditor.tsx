/**
 * Tasks editor (P1C).
 *
 * Strategy: parse the exported array literal in tasks.js with the shared
 * parseTaskFile(). Show each task as an editable card. On save, we
 * regenerate the array body and replace it inside the original source
 * via byte-range edits — imports and helpers outside the array stay
 * untouched.
 *
 * Function-valued fields (appliesIf, resolvedIf, dueDate, modifyContent)
 * are edited in a code textarea per task. The visual JS rule builder is
 * a stretch in MVP; for now a code editor is correct enough.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  deriveTaskTitleKey,
  inferTaskSeparator,
  slugifyTaskName,
  jsSingleQuoteString,
  rebuildTaskFile,
  looksLikeTranslationKey,
  parseTaskFile,
  type FieldValue,
  type ParsedTaskFile,
  type TaskEntry,
} from '@cht-ui/shared';
import { api } from '../api.js';
import { useApp } from '../state/store.js';
import { useHistory } from '../state/useHistory.js';
import { showUndoToast } from './UndoToast.js';
import { AppliesIfBuilder } from './AppliesIfBuilder.js';
import { EventsEditor } from './EventsEditor.js';
import { ResolvedWhenPicker } from './ResolvedWhenPicker.js';
import { ActionsEditor } from './ActionsEditor.js';
import { parseAppliesToType } from './useReportFormFields.js';

type FileKey = 'tasks.js' | 'task-schedules.js' | 'tasks-extras.js';
const SECONDARY_FILES: FileKey[] = ['task-schedules.js', 'tasks-extras.js'];

interface TasksState {
  raw: Record<FileKey, string | null>;
  parsed: ParsedTaskFile | null;
}

/**
 * The project's translation files, read ONCE for the whole editor
 * (docs/NEXT.md item 8). Fetched here rather than inside `TaskCard` because
 * a card renders per task — an 18-task config would otherwise fire 18
 * identical GETs.
 */
interface TranslationsSnapshot {
  /** Locale codes the project ships, in discovery order. `['en']` when none. */
  locales: string[];
  /** locale → the dir its file lives in, so a PUT rewrites the SAME file
   *  instead of creating a sibling in the other candidate dir. */
  dirs: Record<string, string>;
  /** locale → key → value, as currently on disk. */
  values: Record<string, Record<string, string>>;
  /** Every key defined in any locale — the collision set for key derivation. */
  allKeys: string[];
}

const EMPTY_TX: TranslationsSnapshot = { locales: ['en'], dirs: {}, values: {}, allKeys: [] };

export function TasksEditor() {
  const setError = useApp((s) => s.setError);
  const setDirty = useApp((s) => s.setDirty);
  const setSaving = useApp((s) => s.setSaving);
  const dirty = useApp((s) => s.dirty['tasks'] ?? false);
  const saving = useApp((s) => s.saving['tasks'] ?? false);

  const history = useHistory<TasksState>({
    onUndo: () => setDirty('tasks', true),
    onRedo: () => setDirty('tasks', true),
  });
  const state = history.current;
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'structured' | 'raw'>('structured');
  const [activeRawFile, setActiveRawFile] = useState<FileKey>('tasks.js');
  // docs/NEXT.md item 8 — the project's translation files, plus the strings
  // the author has typed but not yet saved. Titles are edited as STRINGS
  // here and flushed to `messages-<locale>.properties` on Save.
  const [tx, setTx] = useState<TranslationsSnapshot>(EMPTY_TX);
  const [pendingTx, setPendingTx] = useState<Record<string, Record<string, string>>>({});
  // Locales the author added in this session. A project can DECLARE a
  // language in base_settings (cht-default enables `ne`) while shipping only
  // `messages-en.properties` — so sourcing the input list from the files
  // alone would render English-only and leave no way to type the Nepali
  // title. Adding one here materializes the input immediately; the file
  // itself is created by the first save (the PUT's create-if-missing path).
  const [extraLocales, setExtraLocales] = useState<string[]>([]);

  const txWithExtras: TranslationsSnapshot = useMemo(
    () => ({
      ...tx,
      locales: [...tx.locales, ...extraLocales.filter((l) => !tx.locales.includes(l))],
    }),
    [tx, extraLocales],
  );

  /**
   * How many tasks point at each title key. Real configs DO share one key
   * across entries — cht-default reuses `task.anc.pregnancy_home_visit.title`
   * on two tasks — and because the strings live outside tasks.js, editing the
   * title on one card would silently rewrite the other task's title too. The
   * field warns instead of pretending the edit is local.
   */
  const titleKeyUses = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of state?.parsed?.entries ?? []) {
      const t = e.fields['title'];
      const key = t?.kind === 'string' ? t.value.trim() : '';
      if (key) counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [state?.parsed?.entries]);

  /**
   * The project's existing task `name`s — evidence for how THIS project spells
   * identifiers (docs/principle-config-agnostic.md, posture 2: Derive). Task
   * names matter alongside the title keys because a project can already carry
   * tasks while defining no translations at all, in which case the names are
   * the only evidence there is.
   */
  const taskNames = useMemo(
    () =>
      (state?.parsed?.entries ?? [])
        .map((e) => {
          const n = e.fields['name'];
          return n?.kind === 'string' ? n.value.trim() : '';
        })
        .filter(Boolean),
    [state?.parsed?.entries],
  );

  function addLocale(raw: string) {
    const locale = raw.trim().toLowerCase();
    // Same shape the translations route validates (`messages-<locale>`).
    if (!/^[a-z]{2,3}([-_][a-z0-9]+)?$/i.test(locale)) {
      setError(`"${raw}" is not a language code (try "ne", "fr", "pt_BR").`);
      return;
    }
    if (txWithExtras.locales.includes(locale)) return;
    setExtraLocales((prev) => [...prev, locale]);
  }

  /** Stage one locale's string for a key. Marks the editor dirty so Save
   *  lights up even when `tasks.js` itself did not change (editing the EN
   *  text of an existing key touches only the .properties file). */
  function setTranslation(key: string, locale: string, value: string) {
    setPendingTx((prev) => ({ ...prev, [locale]: { ...(prev[locale] ?? {}), [key]: value } }));
    setDirty('tasks', true);
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getTaskFiles()
      .then((res) => {
        if (!alive) return;
        const tasksSrc = res['tasks.js'] ?? '';
        const parsed = tasksSrc ? parseTaskFile(tasksSrc) : null;
        history.reset({ raw: res, parsed });
        setLoading(false);
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
        setLoading(false);
      });

    // docs/NEXT.md item 8 — translations load INDEPENDENTLY of tasks.js.
    // Deliberately its own promise chain, not a `.then` on the one above: a
    // project with no translations dir is completely normal (the title field
    // then falls back to a single `en` input, and the first save CREATES
    // `translations/messages-en.properties` via the server's
    // create-if-missing path), so this failing must never surface an error
    // or leave the editor stuck on "Loading…".
    api
      .getTranslations()
      .then((t) => {
        if (!alive || !t) return;
        const locales: string[] = [];
        const dirs: Record<string, string> = {};
        const values: Record<string, Record<string, string>> = {};
        const allKeys = new Set<string>();
        for (const f of t.files) {
          // First file wins per locale: `getTranslations` scans the root
          // `translations/` dir before the nested one, and root is the only
          // dir cht-conf's upload-custom-translations actually reads.
          if (dirs[f.locale] !== undefined) continue;
          locales.push(f.locale);
          dirs[f.locale] = f.dir;
          const byKey: Record<string, string> = {};
          for (const line of f.entries) {
            if (line.kind === 'entry') {
              byKey[line.key] = line.value;
              allKeys.add(line.key);
            }
          }
          values[f.locale] = byKey;
        }
        setTx({
          locales: locales.length > 0 ? locales : ['en'],
          dirs,
          values,
          allKeys: [...allKeys],
        });
      })
      .catch(() => {
        /* no translations in this project — keep the `en`-only fallback */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setError]);

  function patchState(next: TasksState) {
    history.patch(next);
    setDirty('tasks', true);
  }
  function patchEntry(idx: number, next: TaskEntry) {
    if (!state?.parsed) return;
    const entries = state.parsed.entries.map((e, i) => (i === idx ? next : e));
    patchState({ ...state, parsed: { ...state.parsed, entries } });
  }
  function removeEntry(idx: number) {
    if (!state?.parsed) return;
    const target = state.parsed.entries[idx];
    const label =
      (target?.fields['name']?.kind === 'string' && target.fields['name'].value) || `task ${idx + 1}`;
    const snapshotId = history.currentSnapshotId;
    patchState({
      ...state,
      parsed: { ...state.parsed, entries: state.parsed.entries.filter((_, i) => i !== idx) },
    });
    showUndoToast({ message: `Deleted task "${label}"`, onUndo: () => history.jumpTo(snapshotId) });
  }
  function addEntry() {
    if (!state?.parsed) return;
    const newEntry: TaskEntry = {
      bounds: { start: 0, end: 0 },
      source: '{}',
      fields: {
        name: { kind: 'string', value: 'new_task' },
        title: { kind: 'string', value: 'task.new_task.title' },
        icon: { kind: 'string', value: 'icon-task' },
        appliesTo: { kind: 'string', value: 'reports' },
        appliesToType: { kind: 'array', raw: '[]' },
        appliesIf: { kind: 'function', raw: 'function (contact, report) {\n  return true;\n}' },
        // SINGLE quotes: these `raw` strings are emitted verbatim into
        // tasks.js, and CHT's eslint config enforces `quotes: ['error',
        // 'single']`. Double quotes here made EVERY tool-created task fail
        // `compile-app-settings` ("Strings must use singlequote" → "Webpack
        // warnings when building nools"), i.e. the first step of every
        // deploy — found by the item-8 live-deploy spec. Same class as the
        // bug `jsSingleQuoteString` was introduced to prevent.
        events: { kind: 'array', raw: "[{ id: 'new_task', days: 0, start: 0, end: 0 }]" },
        actions: { kind: 'array', raw: "[{ form: 'new_form' }]" },
      },
    };
    patchState({
      ...state,
      parsed: { ...state.parsed, entries: [...state.parsed.entries, newEntry] },
    });
  }
  function patchRaw(file: FileKey, content: string) {
    if (!state) return;
    const nextRaw = { ...state.raw, [file]: content };
    let parsed = state.parsed;
    if (file === 'tasks.js') parsed = parseTaskFile(content);
    patchState({ raw: nextRaw, parsed });
  }

  async function save() {
    if (!state) return;
    setSaving('tasks', true);
    try {
      // Rebuild tasks.js if we have a parsed view; else write the raw text.
      let nextTasks = state.raw['tasks.js'] ?? '';
      if (state.parsed && state.parsed.arrayBounds && view === 'structured') {
        nextTasks = rebuildTaskFile(state.parsed);
      }

      // docs/NEXT.md item 8 — TRANSLATIONS FIRST, then tasks.js. A key
      // pointing at strings that exist is recoverable; a string file with no
      // referencing key is harmless. The reverse order can ship a task whose
      // title renders as a raw key. If any PUT throws we bail BEFORE writing
      // tasks.js, so there is no half-state.
      //
      // `dir` is pinned to the file the locale already lives in, so a
      // project whose files sit in `app_settings/forms/translations/` is
      // rewritten in place rather than gaining a second file in
      // `translations/`. A locale with no file yet is sent WITHOUT a dir,
      // which makes the server create the canonical `translations/` one.
      for (const [locale, updatesByKey] of Object.entries(pendingTx)) {
        const updates = Object.entries(updatesByKey).map(([key, value]) => ({ key, value }));
        if (updates.length === 0) continue;
        await api.putTranslations(locale, updates, tx.dirs[locale]);
      }

      await api.saveTaskFile('tasks.js', nextTasks);
      for (const f of SECONDARY_FILES) {
        const c = state.raw[f];
        if (c !== null) await api.saveTaskFile(f, c);
      }
      setDirty('tasks', false);
      // Fold the flushed strings into the on-disk snapshot so a second save
      // does not re-send them, and so the inputs keep showing what shipped.
      if (Object.keys(pendingTx).length > 0) {
        setTx((prev) => {
          const values = { ...prev.values };
          const dirs = { ...prev.dirs };
          const allKeys = new Set(prev.allKeys);
          const locales = [...prev.locales];
          for (const [locale, byKey] of Object.entries(pendingTx)) {
            values[locale] = { ...(values[locale] ?? {}), ...byKey };
            for (const k of Object.keys(byKey)) allKeys.add(k);
            if (!locales.includes(locale)) locales.push(locale);
            // A locale we just created now lives in the canonical dir.
            if (dirs[locale] === undefined) dirs[locale] = 'translations';
          }
          return { locales, dirs, values, allKeys: [...allKeys] };
        });
        setPendingTx({});
      }
      // Re-parse what was just written and snapshot it as the new baseline.
      history.reset({
        raw: { ...state.raw, 'tasks.js': nextTasks },
        parsed: nextTasks ? parseTaskFile(nextTasks) : state.parsed,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving('tasks', false);
    }
  }

  if (loading) return <div className="loading">Loading tasks…</div>;
  if (!state) return <div className="loading">No tasks data.</div>;

  return (
    <div className="tasks-editor">
      <header className="page-header sticky-header">
        <h1>Tasks</h1>
        <div className="row gap">
          <button
            className="link"
            onClick={history.undo}
            disabled={!history.canUndo}
            title="Undo (Ctrl+Z)"
            aria-label="Undo last edit"
          >
            ↶ Undo
          </button>
          <button
            className="link"
            onClick={history.redo}
            disabled={!history.canRedo}
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
          >
            ↷ Redo
          </button>
          <button onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      </header>

      <div className="tabs">
        <button className={view === 'structured' ? 'active' : ''} onClick={() => setView('structured')}>
          Structured ({state.parsed?.entries.length ?? 0})
        </button>
        <button className={view === 'raw' ? 'active' : ''} onClick={() => setView('raw')}>
          Raw files
        </button>
      </div>

      {view === 'structured' && (
        <>
          {!state.parsed?.arrayBounds && (
            <p className="muted">
              Couldn&apos;t locate <code>module.exports = [ ... ]</code> in tasks.js. Edit raw text in
              the &quot;Raw files&quot; tab.
            </p>
          )}
          {state.parsed?.arrayBounds && (
            <div className="task-cards">
              {state.parsed.entries.map((entry, idx) => (
                <TaskCard
                  key={idx}
                  entry={entry}
                  onChange={(e) => patchEntry(idx, e)}
                  onRemove={() => removeEntry(idx)}
                  titleKeyUses={titleKeyUses}
                  taskNames={taskNames}
                  tx={txWithExtras}
                  pendingTx={pendingTx}
                  setTranslation={setTranslation}
                  addLocale={addLocale}
                />
              ))}
              <button onClick={addEntry}>+ Add task</button>
            </div>
          )}
        </>
      )}

      {view === 'raw' && (
        <>
          <div className="tabs">
            {(['tasks.js', ...SECONDARY_FILES] as FileKey[]).map((f) => (
              <button
                key={f}
                className={activeRawFile === f ? 'active' : ''}
                onClick={() => setActiveRawFile(f)}
              >
                {f}
                {state.raw[f] === null && <em className="muted"> (missing)</em>}
              </button>
            ))}
          </div>
          <textarea
            className="code-editor"
            value={state.raw[activeRawFile] ?? ''}
            onChange={(e) => patchRaw(activeRawFile, e.target.value)}
            spellCheck={false}
          />
        </>
      )}
    </div>
  );
}

/* --------------------------- Task card UI --------------------------- */

function TaskCard(props: {
  entry: TaskEntry;
  onChange: (e: TaskEntry) => void;
  onRemove: () => void;
  /** docs/NEXT.md item 8 — fetched once by the editor, not per card. */
  titleKeyUses: Record<string, number>;
  /** Sibling task names — separator evidence for name/key derivation. */
  taskNames: string[];
  tx: TranslationsSnapshot;
  pendingTx: Record<string, Record<string, string>>;
  setTranslation: (key: string, locale: string, value: string) => void;
  addLocale: (locale: string) => void;
}) {
  const { entry } = props;
  const [expanded, setExpanded] = useState(true);

  function setField(name: string, value: FieldValue) {
    props.onChange({ ...entry, fields: { ...entry.fields, [name]: value } });
  }
  function clearField(name: string) {
    const nextFields = { ...entry.fields };
    delete nextFields[name];
    props.onChange({ ...entry, fields: nextFields });
  }
  function getRawNoQuote(name: string): string {
    const v = entry.fields[name];
    if (!v) return '';
    if (v.kind === 'array' || v.kind === 'object' || v.kind === 'function' || v.kind === 'unknown')
      return v.raw;
    return '';
  }
  const appliesToType = useMemo(
    () => parseAppliesToType(getRawNoQuote('appliesToType')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entry.fields['appliesToType']],
  );
  function getString(name: string): string {
    const v = entry.fields[name];
    if (!v) return '';
    if (v.kind === 'string') return v.value;
    if (v.kind === 'identifier') return v.value;
    if (v.kind === 'unknown') return v.raw;
    return '';
  }
  function getRaw(name: string): string {
    const v = entry.fields[name];
    if (!v) return '';
    if (v.kind === 'array' || v.kind === 'object' || v.kind === 'function' || v.kind === 'unknown')
      return v.raw;
    if (v.kind === 'string') return jsSingleQuoteString(v.value);
    if (v.kind === 'number') return String(v.value);
    if (v.kind === 'boolean') return String(v.value);
    if (v.kind === 'identifier') return v.value;
    return '';
  }

  return (
    <div className="task-card">
      <header className="row gap">
        <button className="link" onClick={() => setExpanded(!expanded)}>
          {expanded ? '▾' : '▸'}
        </button>
        <strong>{getString('name') || '(unnamed task)'}</strong>
        <span className="muted">— {getString('title')}</span>
        <button className="link danger" onClick={props.onRemove}>
          delete
        </button>
      </header>
      {expanded && (
        <div className="task-fields">
          <TaskNameField
            value={getString('name')}
            onChange={(v) => setField('name', { kind: 'string', value: v })}
            separator={inferTaskSeparator(props.taskNames)}
          />
          <TaskTitleField
            value={getString('title')}
            onChange={(v) => setField('title', { kind: 'string', value: v })}
            taskName={getString('name')}
            taskNames={props.taskNames}
            sharedWith={Math.max(0, (props.titleKeyUses[getString('title').trim()] ?? 1) - 1)}
            tx={props.tx}
            pendingTx={props.pendingTx}
            setTranslation={props.setTranslation}
            addLocale={props.addLocale}
          />
          <ScalarField label="icon" value={getString('icon')} onChange={(v) => setField('icon', { kind: 'string', value: v })} />
          <PriorityField
            value={getString('priority')}
            label={getString('priorityLabel')}
            onChangeValue={(v) =>
              v === ''
                ? clearField('priority')
                : setField('priority', { kind: 'string', value: v })
            }
            onChangeLabel={(v) =>
              v === ''
                ? clearField('priorityLabel')
                : setField('priorityLabel', { kind: 'string', value: v })
            }
          />
          <ScalarField
            label="appliesTo"
            value={getString('appliesTo')}
            onChange={(v) => setField('appliesTo', { kind: 'string', value: v })}
            placeholder="contacts or reports"
          />
          <AppliesToTypeField
            value={getRaw('appliesToType')}
            onChange={(v) => setField('appliesToType', { kind: 'array', raw: v })}
          />
          <AppliesIfWithBuilder
            value={getRaw('appliesIf')}
            appliesToType={appliesToType}
            onChange={(v) => setField('appliesIf', { kind: 'function', raw: v })}
          />
          <ResolvedIfWithPicker
            value={getRaw('resolvedIf')}
            appliesToType={appliesToType}
            onChange={(v) => {
              // If the user picked an identifier, store as identifier; else as function.
              const looksLikeIdentifier = /^[a-zA-Z_$][\w$]*$/.test(v.trim());
              setField(
                'resolvedIf',
                looksLikeIdentifier
                  ? { kind: 'identifier', value: v.trim() }
                  : { kind: 'function', raw: v },
              );
            }}
          />
          <EventsWithEditor
            value={getRaw('events')}
            appliesToType={appliesToType}
            onChange={(v) => {
              // If the raw text starts with [, it's an array literal; else a generator expression.
              const isArrayShape = v.trim().startsWith('[');
              setField(
                'events',
                isArrayShape ? { kind: 'array', raw: v } : { kind: 'unknown', raw: v },
              );
            }}
          />
          <ActionsWithEditor
            value={getRaw('actions')}
            appliesToType={appliesToType}
            onChange={(v) => {
              const isArrayShape = v.trim().startsWith('[');
              setField(
                'actions',
                isArrayShape ? { kind: 'array', raw: v } : { kind: 'unknown', raw: v },
              );
            }}
          />
          <details>
            <summary>Other recognized fields</summary>
            {Object.entries(entry.fields)
              .filter(
                ([k]) =>
                  ![
                    'name',
                    'title',
                    'icon',
                    'priority',
                    'priorityLabel',
                    'appliesTo',
                    'appliesToType',
                    'appliesIf',
                    'resolvedIf',
                    'events',
                    'actions',
                  ].includes(k),
              )
              .map(([k, v]) => (
                <RawField
                  key={k}
                  label={k}
                  value={getRaw(k)}
                  onChange={(val) =>
                    setField(k, v.kind === 'string'
                      ? { kind: 'string', value: val }
                      : v.kind === 'function'
                        ? { kind: 'function', raw: val }
                        : { kind: 'unknown', raw: val })
                  }
                />
              ))}
          </details>
        </div>
      )}
    </div>
  );
}

/* --------------------- Inline wrapped builders --------------------- */

function AppliesIfWithBuilder(props: {
  value: string;
  onChange: (v: string) => void;
  appliesToType: string[];
}) {
  const [showBuilder, setShowBuilder] = useState(false);
  return (
    <label className="expr-field">
      <span className="expr-label">
        <code>appliesIf</code>
        <em className="muted"> — function returning true when this task should fire</em>
        <button className="link" onClick={(e) => { e.preventDefault(); setShowBuilder(true); }}>
          ✎ build
        </button>
      </span>
      <textarea
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="code-editor short"
        spellCheck={false}
      />
      {showBuilder && (
        <AppliesIfBuilder
          value={props.value}
          appliesToType={props.appliesToType}
          onCancel={() => setShowBuilder(false)}
          onSave={(v) => {
            props.onChange(v);
            setShowBuilder(false);
          }}
        />
      )}
    </label>
  );
}

function ResolvedIfWithPicker(props: {
  value: string;
  onChange: (v: string) => void;
  appliesToType: string[];
}) {
  return (
    <label className="expr-field">
      <span className="expr-label">
        <code>resolvedIf</code>
        <em className="muted"> — when this returns true the task disappears</em>
      </span>
      <ResolvedWhenPicker
        value={props.value}
        onChange={props.onChange}
        appliesToType={props.appliesToType}
      />
    </label>
  );
}

function EventsWithEditor(props: {
  value: string;
  onChange: (v: string) => void;
  appliesToType: string[];
}) {
  return (
    <label className="expr-field">
      <span className="expr-label">
        <code>events</code>
        <em className="muted"> — when the task is due relative to the trigger</em>
      </span>
      <EventsEditor
        value={props.value}
        onChange={props.onChange}
        appliesToType={props.appliesToType}
      />
    </label>
  );
}

function ActionsWithEditor(props: {
  value: string;
  onChange: (v: string) => void;
  appliesToType: string[];
}) {
  const forms = useApp((s) => s.forms);
  const formOptions = forms
    .filter((f) => f.category === 'app')
    .map((f) => f.filename.replace(/\.xlsx$/i, ''));
  return (
    <label className="expr-field">
      <span className="expr-label">
        <code>actions</code>
        <em className="muted"> — which form opens when the task is tapped</em>
      </span>
      <ActionsEditor
        value={props.value}
        formOptions={formOptions}
        onChange={props.onChange}
        appliesToType={props.appliesToType}
      />
    </label>
  );
}

function ScalarField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="expr-field">
      <span className="expr-label">
        <code>{props.label}</code>
      </span>
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
      />
    </label>
  );
}

/**
 * `title` is almost always a translation key (e.g. `task.malaria.followup.title`)
 * resolved against the project's `messages-<locale>.properties` files. The
 * raw key shape is non-obvious to non-developers, so we detect the key
 * pattern and surface a hint pointing at where the actual EN/NE strings
 * need to live. Doesn't gate the input — the user can still type a raw
 * string for hardcoded titles.
 */
function TaskTitleField(props: {
  /** The raw `title` field from tasks.js — a translation key or a literal. */
  value: string;
  onChange: (v: string) => void;
  taskName: string;
  /** Sibling task names — evidence for the derived key's separator. */
  taskNames: string[];
  /** How many OTHER tasks share this title key (0 = exclusive). */
  sharedWith: number;
  tx: TranslationsSnapshot;
  pendingTx: Record<string, Record<string, string>>;
  setTranslation: (key: string, locale: string, value: string) => void;
  addLocale: (locale: string) => void;
}) {
  const { value, onChange, taskName, tx, pendingTx, setTranslation } = props;
  const raw = value.trim();
  const isKey = looksLikeTranslationKey(raw);

  /** What to show in a locale's input: a pending edit wins over disk. */
  const shown = (locale: string, key: string): string =>
    pendingTx[locale]?.[key] ?? tx.values[locale]?.[key] ?? '';

  // Does the key resolve anywhere? Drives the "no translations found" note.
  const resolvesSomewhere =
    isKey &&
    tx.locales.some(
      (l) => tx.values[l]?.[raw] !== undefined || pendingTx[l]?.[raw] !== undefined,
    );

  // The key we actually write under. `addEntry` seeds `task.new_task.title`
  // BEFORE the author has named the task, so while that key still has no
  // strings anywhere we adopt the one derived from the current name — there
  // is nothing to orphan yet. The moment any string exists (on disk OR
  // pending) the key FREEZES: renaming it then would orphan those strings,
  // the same trap as renaming a field mid-collection.
  const derivedKey = deriveTaskTitleKey(
    taskName || 'task',
    tx.allKeys.filter((k) => k !== raw),
    props.taskNames,
  ).key;
  const writeKey = isKey && !resolvesSomewhere && derivedKey ? derivedKey : raw;

  /**
   * Promote a LITERAL (or empty) title to a translated one: derive the key,
   * carry the literal across as the first locale's string so nothing the
   * author typed is lost, and swap the field to the key. Derivation happens
   * HERE and only here — once the field holds a key it is never re-derived,
   * because renaming the key would orphan the strings (same trap as renaming
   * a field mid-collection).
   */
  function makeTranslatable() {
    const { key } = deriveTaskTitleKey(taskName || 'task', tx.allKeys, props.taskNames);
    if (!key) return;
    const primary = tx.locales[0] ?? 'en';
    if (raw !== '') setTranslation(key, primary, raw);
    onChange(key);
  }

  if (!isKey) {
    // Literal title — what plenty of real configs ship. Keep it editable as
    // one plain input and OFFER the translated form; never convert silently.
    return (
      <label className="expr-field">
        <span className="expr-label">
          <code>title</code>
          <em className="muted"> — what the CHW sees in their task list</em>
        </span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Follow up with the patient"
        />
        <span className="muted small" style={{ marginTop: 4 }}>
          This title is the same in every language.{' '}
          <button
            type="button"
            className="link"
            onClick={makeTranslatable}
            title="Store this title in the project's translation files so it can differ per language"
          >
            Make it translatable
          </button>
        </span>
      </label>
    );
  }

  // Translated title: ONE INPUT PER LOCALE, exactly like the per-locale
  // choice labels (8eda602). The author types strings; the key underneath is
  // an advanced read-only detail.
  return (
    <label className="expr-field">
      <span className="expr-label">
        <code>title</code>
        <em className="muted"> — what the CHW sees, per language</em>
      </span>
      <div className="qtype-labels-field">
        {tx.locales.map((loc) => (
          <label key={loc} className="qtype-locale-label">
            <span className="locale-tag">{loc}</span>
            <input
              value={shown(loc, writeKey)}
              onChange={(e) => {
                // Adopt the derived key on the first keystroke, so the string
                // and the key it lives under are written together.
                if (writeKey !== raw) onChange(writeKey);
                setTranslation(writeKey, loc, e.target.value);
              }}
              placeholder={loc === tx.locales[0] ? 'Eye check follow-up' : `title (${loc})`}
              aria-label={`Task title in ${loc}`}
            />
          </label>
        ))}
      </div>
      <span className="row gap" style={{ marginTop: 4, alignItems: 'center' }}>
        <button
          type="button"
          className="link small"
          onClick={() => {
            // eslint-disable-next-line no-alert
            const next = window.prompt(
              'Language code to add (e.g. ne for Nepali, fr for French):',
            );
            if (next) props.addLocale(next);
          }}
          title="Add another language for task titles. The project's messages file for it is created on save."
        >
          + language
        </button>
        {!resolvesSomewhere && (
          <span className="muted small">
            No translations for this title yet — type it above and it is created on save.
          </span>
        )}
      </span>
      {props.sharedWith > 0 && (
        <span className="rule-row-warning" style={{ marginTop: 4 }}>
          <strong>
            Shared with {props.sharedWith} other task{props.sharedWith === 1 ? '' : 's'}.
          </strong>{' '}
          They all read this same title, so editing it here changes theirs too.
        </span>
      )}
      {/* The key stays visible as a read-only detail so a power user can see
          what actually shipped, without ever having to type it. */}
      <span className="muted small" style={{ marginTop: 4 }}>
        Saved in the project&apos;s translation files as <code>{writeKey}</code>.
      </span>
    </label>
  );
}

const PRIORITY_LEVELS = [
  { value: '', label: '— default (medium) —' },
  { value: 'high', label: 'high' },
  { value: 'medium', label: 'medium' },
  { value: 'low', label: 'low' },
];

/**
 * Renders the optional task `priority` field as a typed dropdown plus an
 * optional `priorityLabel` (also a translation key). Setting empty value
 * deletes the fields entirely so the round-trip stays minimal — the JS
 * serializer drops absent keys, matching the way unprioritised tasks ship.
 */
function PriorityField(props: {
  value: string;
  label: string;
  onChangeValue: (v: string) => void;
  onChangeLabel: (v: string) => void;
}) {
  const looksLikeLabelKey = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/i.test(props.label.trim());
  return (
    <label className="expr-field">
      <span className="expr-label">
        <code>priority</code>
        <em className="muted"> — affects sort order and color in the CHW task list</em>
      </span>
      <div className="row gap" style={{ flexWrap: 'wrap' }}>
        <select
          value={props.value}
          onChange={(e) => props.onChangeValue(e.target.value)}
          className="type-select"
        >
          {PRIORITY_LEVELS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <input
          value={props.label}
          onChange={(e) => props.onChangeLabel(e.target.value)}
          placeholder="priorityLabel (translation key, optional)"
          style={{ flex: 1, minWidth: 240 }}
        />
      </div>
      {props.label && looksLikeLabelKey && (
        <span className="muted small" style={{ marginTop: 4 }}>
          📖 priorityLabel is also a translation key — same .properties files as title.
        </span>
      )}
    </label>
  );
}

/**
 * Task `name` field with label-first auto-slugify. Follows the pattern
 * from Quick Hierarchy Creator + FormEditor's NameInput
 * (decision_nocode_names_autoderived): the user types a friendly
 * label; we slugify a valid identifier below the input, muted; the id
 * itself is only editable via "advanced". This is the task's internal
 * id (used by CHT to key the rules engine) — CHT never surfaces it to
 * end users, so it should read like a code label ("anc-follow-up")
 * not like the human phrase.
 *
 * The slugified suggestion is shown as a live "saved as `<id>`" hint.
 * Click "use this" (or blur when the current value is empty / whitespace)
 * to commit the slug. Existing tasks with a hand-picked name are left
 * alone unless the user hits the button.
 */
function TaskNameField(props: {
  value: string;
  onChange: (v: string) => void;
  /** The separator this project already uses — see inferTaskSeparator. */
  separator: '_' | '-';
}) {
  const [advanced, setAdvanced] = useState<boolean>(false);
  const trimmed = props.value.trim();
  const isValid = trimmed === '' || /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(trimmed);
  const looksLikeIdentifier = isValid && trimmed !== '';
  // Suggest a slug when the current value is non-identifier-shaped (has
  // spaces, punctuation, etc). CHT accepts either separator, so we spell the
  // suggestion the way THIS project already spells its task ids rather than
  // imposing one. (The comment that used to sit here claimed cht-default
  // prefers `-`; it does not — `anc.pregnancy_home_visit.known_lmp` — and
  // that mistake is what put hyphens in our generated title keys.)
  const suggested = !looksLikeIdentifier ? slugifyTaskName(trimmed, props.separator) : '';

  return (
    <label className="expr-field">
      <span className="expr-label">
        <code>name</code>
        <em className="muted">
          {' '}— internal id CHT uses to key this task; safe identifier only
        </em>
      </span>
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={advanced ? 'task_name' : 'e.g. ANC follow-up'}
        className={!isValid ? 'invalid' : ''}
      />
      <span className="muted small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {looksLikeIdentifier ? (
          <>
            valid id · <code>{trimmed}</code>
          </>
        ) : suggested ? (
          <>
            saved as <code>{suggested}</code>
            <button
              type="button"
              className="link"
              onClick={() => props.onChange(suggested)}
              title="Replace with the slugified id"
            >
              use this
            </button>
          </>
        ) : trimmed === '' ? (
          <>type a friendly label — we'll derive the id</>
        ) : (
          <>
            <strong style={{ color: '#dc2626' }}>id needed</strong> — type a
            label-free identifier (letters, digits, <code>_</code>, <code>-</code>)
          </>
        )}
        <button
          type="button"
          className="link"
          onClick={() => setAdvanced((v) => !v)}
        >
          {advanced ? 'label-first' : 'advanced'}
        </button>
      </span>
    </label>
  );
}

/**
 * Visual picker for `appliesToType` — the array of form basenames /
 * contact-type ids the task scopes to. Pre-fix this was a raw textarea
 * where users had to hand-type `['person']` or `FORMS.PREGNANCY_REGISTRATION`
 * (DEV-HANDOFF #9 + task-builder-parity.md). Now it's a multi-select of
 * the project's actual app forms + contact types, with a raw escape
 * hatch for advanced syntax (`'report'`, `'contacts'`, `FORMS.X`, etc.).
 *
 * Mode auto-detects from the current raw value:
 *   - empty / pure string-literal array (`['a','b']`) → multi-select mode
 *   - anything else (FORMS.X, special tokens, free expressions) → raw mode
 *
 * Emit in multi-select mode: `[ 'name1', 'name2' ]` — the simplest shape
 * cht-conf accepts and that survives parseAppliesToType.
 */
function AppliesToTypeField(props: { value: string; onChange: (v: string) => void }) {
  const forms = useApp((s) => s.forms);

  // Stable list of pickable items, memoized off the upstream slice so
  // selector identity doesn't churn (lesson from c0c71a8).
  const appForms = useMemo(
    () =>
      forms
        .filter((f) => f.category === 'app')
        .map((f) => f.filename.replace(/\.xlsx$/i, ''))
        .sort(),
    [forms],
  );
  // Contact-types list — fetched once on mount via the hierarchy API
  // (same pattern PropertiesEditor uses for its ContextExpressionBuilder
  // dropdown). Tasks can scope to a contact type via appliesToType too,
  // so we offer both axes in the picker.
  const [contactTypeIds, setContactTypeIds] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .getHierarchy()
      .then((h) => {
        if (!alive) return;
        const ids = (h.contact_types as Array<{ id: string }>).map((t) => t.id).sort();
        setContactTypeIds(ids);
      })
      .catch(() => {
        /* hierarchy unavailable — picker just lists app forms */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Does the raw value look like a pure string-literal array (or empty)?
  // If yes, multi-select mode is safe; if no (FORMS.X / 'report' / weird),
  // start in raw mode so we don't truncate the user's expression.
  const isPureStringArray = useMemo(() => {
    const trimmed = props.value.trim();
    if (trimmed === '') return true;
    // Allow `[]`, `['a']`, `['a', 'b']`, double or single quotes; no
    // member-access / function-call / object-shorthand.
    if (!/^\[\s*(['"][^'"]+['"]\s*(,\s*['"][^'"]+['"]\s*)*)?\]$/.test(trimmed)) return false;
    return true;
  }, [props.value]);

  // Parsed picked set — falls back to parseAppliesToType for any value
  // (so even a raw-mode user sees their FORMS.X choices reflected in the
  // checkboxes when they flip to multi-select).
  const picked = useMemo(() => new Set(parseAppliesToType(props.value)), [props.value]);

  const [mode, setMode] = useState<'pick' | 'raw'>(isPureStringArray ? 'pick' : 'raw');
  // Track mode-source so we don't flip the user's mode out from under them
  // mid-edit when the auto-detect would prefer the other branch.
  const [modeTouched, setModeTouched] = useState(false);
  useEffect(() => {
    if (!modeTouched) setMode(isPureStringArray ? 'pick' : 'raw');
  }, [isPureStringArray, modeTouched]);

  function toggle(name: string) {
    const next = new Set(picked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    if (next.size === 0) {
      props.onChange('[]');
      return;
    }
    // Emit alphabetized for diff stability.
    const sorted = [...next].sort();
    const literal = `[ ${sorted.map((n) => `'${n}'`).join(', ')} ]`;
    props.onChange(literal);
  }

  return (
    <label className="expr-field">
      <span className="expr-label">
        <code>appliesToType</code>
        <em className="muted"> — which forms / contact types this task fires on</em>
      </span>
      <div className="row gap" style={{ marginBottom: 6 }}>
        <button
          type="button"
          className={mode === 'pick' ? 'active' : 'link'}
          onClick={() => {
            setMode('pick');
            setModeTouched(true);
          }}
          disabled={!isPureStringArray && mode === 'raw'}
          title={
            !isPureStringArray
              ? 'Current value uses FORMS.X or other advanced syntax — switch to multi-select would drop it. Clear the raw value first.'
              : undefined
          }
        >
          Multi-select
        </button>
        <button
          type="button"
          className={mode === 'raw' ? 'active' : 'link'}
          onClick={() => {
            setMode('raw');
            setModeTouched(true);
          }}
        >
          Raw JS
        </button>
      </div>
      {mode === 'pick' ? (
        <div className="applies-to-type-picker">
          {appForms.length === 0 && contactTypeIds.length === 0 ? (
            <p className="muted small">
              No app forms or contact types yet in this project.
            </p>
          ) : (
            <>
              {appForms.length > 0 && (
                <fieldset>
                  <legend className="muted small">
                    App forms <span>({appForms.length})</span>
                  </legend>
                  <div className="applies-to-type-grid">
                    {appForms.map((name) => (
                      <label key={name} className="row gap">
                        <input
                          type="checkbox"
                          checked={picked.has(name)}
                          onChange={() => toggle(name)}
                        />
                        <code>{name}</code>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              {contactTypeIds.length > 0 && (
                <fieldset>
                  <legend className="muted small">
                    Contact types <span>({contactTypeIds.length})</span>
                  </legend>
                  <div className="applies-to-type-grid">
                    {contactTypeIds.map((id) => (
                      <label key={id} className="row gap">
                        <input
                          type="checkbox"
                          checked={picked.has(id)}
                          onChange={() => toggle(id)}
                        />
                        <code>{id}</code>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </>
          )}
          <p className="muted small" style={{ marginTop: 4 }}>
            Emits a string-array literal. Switch to <strong>Raw JS</strong> for
            advanced syntax: <code>FORMS.X</code>, <code>'report'</code>,{' '}
            <code>'contacts'</code>.
          </p>
        </div>
      ) : (
        <>
          <textarea
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            className="code-editor short"
            spellCheck={false}
          />
          <span className="muted small">
            Advanced syntax. Example: <code>['person']</code>,{' '}
            <code>[FORMS.PREGNANCY_REGISTRATION, 'pregnancy']</code>,{' '}
            <code>'report'</code>.
          </span>
        </>
      )}
    </label>
  );
}

function RawField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  tall?: boolean;
}) {
  return (
    <label className="expr-field">
      <span className="expr-label">
        <code>{props.label}</code>
        {props.hint && <em className="muted"> — {props.hint}</em>}
      </span>
      <textarea
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className={`code-editor ${props.tall ? 'medium' : 'short'}`}
        spellCheck={false}
      />
    </label>
  );
}

/* ---------------------------- Serialization ---------------------------- */

/**
 * Rebuild tasks.js by splicing a regenerated array body into the original
 * source between arrayBounds. Imports and helpers outside the array stay
 * untouched.
 */
// The tasks.js serializer now lives in shared (`tasks/jsSerializer.ts`) so
// its byte-stability invariant can be pinned by a unit test against the real
// shipped templates. It used to be three private functions here, and it
// reprinted EVERY entry on every save — which silently dropped comments and
// truncated hand-written computed expressions in tasks the author never
// touched. See jsSerializer.test.ts for the no-op-save pin.
