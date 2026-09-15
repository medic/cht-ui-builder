/**
 * Global app state. Tracks the currently open project, which view is
 * active, and a small in-memory cache of loaded resources (forms, hierarchy,
 * tasks, contact summary).
 *
 * State that is "saving" or "dirty" is also held here so that the chrome
 * (save button, dirty indicator) can render off a single source of truth.
 */
import { create } from 'zustand';

/**
 * Optional deep-link target for the Contact Summary editor's sub-tabs.
 * The Wave 3 · Note 6 empty-state link in `CalculationBuilder`'s
 * "From another form" picker source group uses this to jump straight
 * into the Context values tab, so the user isn't dumped on the default
 * (Context flags) tab and left to hunt. When omitted, the editor
 * lands on its usual default.
 */
export type ContactSummarySubView = 'flags' | 'values' | 'cards' | 'helpers' | 'raw';

export type View =
  | { kind: 'no-project' }
  | { kind: 'project-overview' }
  | { kind: 'hierarchy' }
  | { kind: 'form'; id: string }
  | { kind: 'forms-index' }
  | { kind: 'tasks' }
  | { kind: 'contact-summary'; subView?: ContactSummarySubView }
  | { kind: 'flowchart'; id: string }
  | { kind: 'decisions' }
  | { kind: 'deploy' }
  | { kind: 'standard-codes' }
  | { kind: 'translations' };

export type ServerMode = 'desktop' | 'hosted';

/** Who the server thinks we are, and which mode it runs in. */
export interface SessionState {
  mode: ServerMode;
  user: { id: string; email: string | null } | null;
}

export interface ProjectInfo {
  /** Registry id; the api layer sends it as x-project-id on every request. */
  id: string;
  /** Empty in hosted mode — no filesystem path crosses the wire. */
  path: string;
  name: string;
  source: 'local' | 'template' | 'import-git' | 'import-zip';
  hasAppSettings: boolean;
  hasAppForms: boolean;
  hasContactForms: boolean;
  hasTasks: boolean;
  hasContactSummary: boolean;
  /**
   * Choice values indexed by surveyed field name, scanned from every
   * `forms/contact/*.xlsx` at project open. Lets the form condition builder
   * surface a values dropdown for `inputs/contact/<name>`-style calculates
   * whose underlying select_one lives in a different form. Read-only.
   */
  contactFieldChoices: Record<string, string[]>;
}

export interface FormListEntry {
  id: string;
  category: 'app' | 'contact';
  filename: string;
  hasProperties: boolean;
  hasXml: boolean;
}

interface AppState {
  /** null until /api/auth/me has answered. */
  session: SessionState | null;
  project: ProjectInfo | null;
  view: View;
  forms: FormListEntry[];
  /** dirty[resourceKey] = true when there are unsaved edits. */
  dirty: Record<string, boolean>;
  /** saving[resourceKey] = true while a save request is in flight. */
  saving: Record<string, boolean>;
  /** Last error message, shown in the chrome. */
  lastError: string | null;
  /** Sidebar tabs the author has collapsed away, by tab id. */
  hiddenTabs: ReadonlySet<string>;

  setSession(s: SessionState | null): void;
  setProject(p: ProjectInfo | null): void;
  setView(v: View): void;
  setForms(f: FormListEntry[]): void;
  setDirty(key: string, value: boolean): void;
  setSaving(key: string, value: boolean): void;
  setError(message: string | null): void;
  toggleTab(id: string): void;
  showAllTabs(): void;
}

/**
 * Which sidebar tabs are collapsed away. A view preference, not project data:
 * a team working only on forms should not have to scroll past tabs it never
 * opens, but nothing is removed and a tick box brings any of them straight
 * back. Kept per browser, so it survives a reload without following the
 * project to anyone else.
 */
const HIDDEN_TABS_KEY = 'cht-ui-builder.hiddenTabs';

/**
 * Tabs collapsed for someone who has never chosen. The current focus is
 * forms, so a fresh browser lands on Overview / Hierarchy / Forms / Deploy
 * and the rest are one tick away in the Tabs panel.
 *
 * Note this is the default, never an override: a stored list always wins,
 * including an empty one. "I ticked them all back on" has to survive a
 * reload, which it would not if an empty set fell through to these.
 */
const DEFAULT_HIDDEN_TABS: readonly string[] = [
  'tasks',
  'contact-summary',
  'translations',
  'decisions',
  'standard-codes',
];

// `globalThis` rather than `window`: eslint.config.js declares Node globals
// for **/*.{ts,tsx} and no browser ones, so `window` here would be a fresh
// no-undef error. `globalThis` is standard at ecmaVersion 2022 and types the
// same under lib.dom.
function loadHiddenTabs(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage.getItem(HIDDEN_TABS_KEY);
    if (!raw) return new Set(DEFAULT_HIDDEN_TABS);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_HIDDEN_TABS);
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    // Unreadable (private mode, cleared storage, hand-edited value) — treat it
    // as "no choice made" rather than failing to render the sidebar.
    return new Set(DEFAULT_HIDDEN_TABS);
  }
}

function saveHiddenTabs(ids: ReadonlySet<string>): void {
  try {
    globalThis.localStorage.setItem(HIDDEN_TABS_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage unavailable — the choice still holds for this page */
  }
}

export const useApp = create<AppState>((set) => ({
  session: null,
  project: null,
  view: { kind: 'no-project' },
  forms: [],
  dirty: {},
  saving: {},
  lastError: null,
  hiddenTabs: loadHiddenTabs(),

  setSession: (s) => set({ session: s }),
  setProject: (p) => set({ project: p, view: p ? { kind: 'project-overview' } : { kind: 'no-project' } }),
  setView: (v) => set({ view: v }),
  setForms: (f) => set({ forms: f }),
  setDirty: (key, value) =>
    set((state) => ({ dirty: { ...state.dirty, [key]: value } })),
  setSaving: (key, value) =>
    set((state) => ({ saving: { ...state.saving, [key]: value } })),
  setError: (message) => set({ lastError: message }),
  toggleTab: (id) =>
    set((state) => {
      const next = new Set(state.hiddenTabs);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveHiddenTabs(next);
      return { hiddenTabs: next };
    }),
  showAllTabs: () =>
    set(() => {
      const next = new Set<string>();
      saveHiddenTabs(next);
      return { hiddenTabs: next };
    }),
}));

export function isAnyDirty(state: Record<string, boolean>): boolean {
  return Object.values(state).some(Boolean);
}
