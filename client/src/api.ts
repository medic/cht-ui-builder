/* global window, document, fetch, Response, Storage, URL, URLSearchParams, File, FileReader, Event, RequestInit, TextDecoder */
/**
 * Thin client for the Fastify server. All routes are proxied through
 * /api/* by Vite in dev; same-origin in production — or, when the client is
 * hosted apart from the API (Vercel + a container), prefixed with
 * VITE_API_BASE. This module is the single outbound chokepoint: every request
 * carries the session's bearer token and the tab's project id from here.
 *
 * The project id lives in sessionStorage, so each TAB pins its own project:
 * two tabs edit two configs without a server-side "current project" to fight
 * over (docs/plans/hosted-authoring.md §6.1). The token lives in localStorage
 * so signing in once covers every tab.
 */
import type { ContextScan, ContextWrapper, XLSForm } from '@cht-ui/shared';
import type { FormListEntry, ProjectInfo, ServerMode } from './state/store.js';

export interface DeployConfig {
  target: 'local' | 'instance' | 'url';
  instance?: string;
  url?: string;
  user?: string;
}

const API_BASE = (
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE ?? ''
).replace(/\/$/, '');
const TOKEN_KEY = 'cht-ui-builder.token';
const PROJECT_KEY = 'cht-ui-builder.projectId';

function storageGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(store: Storage, key: string, value: string | null): void {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    /* storage unavailable (private mode) — the in-memory session still works for this page */
  }
}

/** Per-browser token and per-tab project id. */
export const session = {
  getToken: () => storageGet(window.localStorage, TOKEN_KEY),
  setToken: (t: string | null) => storageSet(window.localStorage, TOKEN_KEY, t),
  getProjectId: () => storageGet(window.sessionStorage, PROJECT_KEY),
  setProjectId: (id: string | null) => storageSet(window.sessionStorage, PROJECT_KEY, id),
};

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const token = session.getToken();
  if (token) h.authorization = `Bearer ${token}`;
  const pid = session.getProjectId();
  if (pid) h['x-project-id'] = pid;
  return h;
}

/**
 * URL for an EventSource, which cannot set headers: the token and project id
 * ride the query string instead (the server accepts that on stream routes only).
 */
export function streamUrl(path: string): string {
  const qs = new URLSearchParams();
  const token = session.getToken();
  if (token) qs.set('token', token);
  const pid = session.getProjectId();
  if (pid) qs.set('project', pid);
  const q = qs.toString();
  return apiUrl(`${path}${q ? (path.includes('?') ? '&' : '?') + q : ''}`);
}

async function readError(res: Response): Promise<string> {
  let detail = '';
  try {
    const errBody = (await res.json()) as { error?: string };
    detail = errBody.error ?? '';
  } catch {
    detail = await res.text();
  }
  return `${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`;
}

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(input), {
    ...init,
    headers: {
      ...(typeof init?.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    // An expired or revoked token: drop it and let the shell show sign-in.
    if (res.status === 401 && session.getToken()) {
      session.setToken(null);
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new Error(await readError(res));
  }
  return (await res.json()) as T;
}

/** Fired on window when the server rejects the stored token. */
export const UNAUTHORIZED_EVENT = 'cht-ui-builder:unauthorized';

export interface SessionInfo {
  mode: ServerMode;
  user: { id: string; email: string | null } | null;
}

export interface ProjectListEntry {
  id: string;
  name: string;
  source: 'local' | 'template' | 'import-git' | 'import-zip';
  origin?: string;
  createdAt: string;
  lastOpenedAt: string;
  exists: boolean;
  /** Desktop mode only. */
  path?: string;
}

type OpenResult = { open: boolean; project: ProjectInfo; projectId: string };

export const api = {
  health: () => jsonFetch<{ ok: boolean; time: string }>('/api/health'),

  /* ---------------------------------- auth --------------------------------- */

  me: () => jsonFetch<SessionInfo>('/api/auth/me'),

  signup: (email: string, password: string) =>
    jsonFetch<{ user: { id: string; email: string }; token: string }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    jsonFetch<{ user: { id: string; email: string }; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () => jsonFetch<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  /* -------------------------------- projects ------------------------------- */

  /** The project this tab names (or, desktop only, the last one opened). */
  getProject: () =>
    jsonFetch<{ open: boolean; project?: ProjectInfo; projectId?: string; error?: string }>(
      '/api/project',
    ),

  listProjects: () =>
    jsonFetch<{ mode: ServerMode; projects: ProjectListEntry[] }>('/api/projects'),

  openProjectById: (id: string) =>
    jsonFetch<OpenResult>('/api/projects/open', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  /** Desktop only: open a folder on this machine by absolute path. */
  openProject: (path: string) =>
    jsonFetch<OpenResult>('/api/project/open', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  /** Desktop: forget the "last opened" fallback so a reload lands on the picker. Hosted: no-op. */
  closeProject: () => jsonFetch<{ open: boolean }>('/api/project/close', { method: 'POST' }),

  renameProject: (id: string, name: string) =>
    jsonFetch<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  /** Forget a project; `deleteFiles` also removes it from the server's disk (hosted). */
  deleteProject: (id: string, deleteFiles: boolean) =>
    jsonFetch<{ ok: true; removed: boolean; deletedFiles: boolean }>(
      `/api/projects/${encodeURIComponent(id)}${deleteFiles ? '?files=1' : ''}`,
      { method: 'DELETE' },
    ),

  importGit: (url: string, name?: string, branch?: string) =>
    jsonFetch<{ ok: true; projectId: string; subdir: string | null }>('/api/projects/import-git', {
      method: 'POST',
      body: JSON.stringify({ url, name: name || undefined, branch: branch || undefined }),
    }),

  exportGit: (id: string, branch: string, message?: string) =>
    jsonFetch<{ ok: true; branch: string; committed: boolean; output: string }>(
      `/api/projects/${encodeURIComponent(id)}/export-git`,
      { method: 'POST', body: JSON.stringify({ branch, message }) },
    ),

  importZip: async (file: File, name: string) => {
    const res = await fetch(apiUrl(`/api/projects/import-zip?name=${encodeURIComponent(name)}`), {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/zip' },
      body: file,
    });
    if (!res.ok) throw new Error(await readError(res));
    return (await res.json()) as { ok: true; projectId: string; subdir: string | null };
  },

  /** Download the project as a zip (excluding node_modules, .git, map exports). */
  downloadZip: async (id: string, filename: string) => {
    const res = await fetch(apiUrl(`/api/projects/${encodeURIComponent(id)}/export.zip`), {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(await readError(res));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.zip') ? filename : `${filename}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  browse: (path: string) =>
    jsonFetch<{
      path: string;
      parent: string | null;
      entries: Array<{ name: string; isDirectory: boolean; isProjectRoot: boolean }>;
    }>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  browseShortcuts: () =>
    jsonFetch<{ shortcuts: Array<{ label: string; path: string }> }>('/api/browse/shortcuts'),

  browseSearch: (path: string, query: string) =>
    jsonFetch<{ results: Array<{ path: string; name: string; isProjectRoot: boolean }> }>(
      `/api/browse/search?path=${encodeURIComponent(path)}&query=${encodeURIComponent(query)}`,
    ),

  browseMkdir: (path: string, name: string) =>
    jsonFetch<{ path: string }>('/api/browse/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    }),

  chtConfActions: () =>
    jsonFetch<{
      actions: Array<{
        name: string;
        category:
          | 'validate'
          | 'compile'
          | 'convert'
          | 'compress'
          | 'backup'
          | 'upload'
          | 'danger'
          | 'utility';
        requiresInstance: boolean;
        dangerous: boolean;
        label: string;
      }>;
      binaryAvailable: boolean;
      version: string | null;
    }>('/api/cht-conf/actions'),

  getDeployConfig: () =>
    jsonFetch<{ config: DeployConfig | null }>('/api/cht-conf/config'),

  setDeployConfig: (config: DeployConfig) =>
    jsonFetch<{ ok: true; config: DeployConfig }>('/api/cht-conf/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  /**
   * Direct connection probe — hits the deploy target's `/api/info`
   * endpoint with basic auth. Bypasses cht-conf, so it doesn't break
   * every time cht-conf publishes a new release.
   */
  testConnection: (password: string) =>
    jsonFetch<{
      ok: boolean;
      status?: number;
      version?: string;
      couchVersion?: string;
      authenticatedAs?: string;
      error?: string;
      redactedUrl: string;
    }>('/api/cht-conf/test-connection', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  runChtConfAction: (action: string, password?: string, extraArgs?: string[], dryRun?: boolean) =>
    jsonFetch<{ ok: true; runId: string; dryRun?: boolean }>('/api/cht-conf/run', {
      method: 'POST',
      body: JSON.stringify({ action, password, extraArgs, dryRun }),
    }),

  /** Chained-run macro — runs N cht-conf actions sequentially as one streamed run. */
  runChtConfSequence: (actions: string[], password?: string, dryRun?: boolean) =>
    jsonFetch<{ ok: true; runId: string }>('/api/cht-conf/run-sequence', {
      method: 'POST',
      body: JSON.stringify({ actions, password, dryRun }),
    }),

  /**
   * Owned deploy pipeline — POST /api/deploy/run. Consumes the server's
   * NDJSON stream and yields one parsed event object per line. Distinct
   * from `runChtConfSequence`, which uses the runId + SSE subscribe
   * pattern; this route is single-request, single-response, streaming.
   *
   * Callers can `for await (const evt of api.deployRun(payload))` and
   * dispatch by `evt.event`. Events are typed as `unknown` here — the
   * server-side envelope shape is deploy.ts's DeployRunEvent, but keeping
   * this signature loose avoids cross-workspace type coupling for a
   * single-consumer route.
   */
  async *deployRun(payload: {
    url: string;
    user: string;
    password: string;
    steps: string[];
    extraArgs?: Record<string, string[]>;
  }): AsyncGenerator<Record<string, unknown>, void, void> {
    const res = await fetch(apiUrl('/api/deploy/run'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) throw new Error(await readError(res));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        yield JSON.parse(line) as Record<string, unknown>;
      }
    }
    const tail = buf.trim();
    if (tail.length > 0) yield JSON.parse(tail) as Record<string, unknown>;
  },

  getChtConfRun: (runId: string) =>
    jsonFetch<{
      id: string;
      action: string;
      startedAt: number;
      endedAt: number | null;
      exitCode: number | null;
      lines: string[];
      running: boolean;
    }>(`/api/cht-conf/runs/${encodeURIComponent(runId)}`),

  cancelChtConfRun: (runId: string) =>
    jsonFetch<{ ok: true }>(`/api/cht-conf/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }),

  listTemplates: () =>
    jsonFetch<{
      templates: Array<{
        id: string;
        label: string;
        description: string;
        forms: { app: number; contact: number };
        hasStarterContent: boolean;
      }>;
    }>('/api/templates'),

  /**
   * Scaffold a project from a template. Hosted: `name` picks the folder under
   * the user's projects dir. Desktop: `path` is the absolute target folder.
   * Either way the new project is registered; open it with `openProjectById`.
   */
  createFromTemplate: (template: string, opts: { name?: string; path?: string }) =>
    jsonFetch<{ ok: true; projectId: string; path?: string }>('/api/templates/create', {
      method: 'POST',
      body: JSON.stringify({ template, ...opts }),
    }),

  listForms: () => jsonFetch<{ forms: FormListEntry[] }>('/api/forms'),

  /** Working-tree changed forms via `git status --porcelain forms/`. Non-git
   *  projects come back as `{ git: false, changed: [] }` — the Deploy UI uses
   *  this to hide the "Select changed" quick-pick. See
   *  docs/plans/deploy-targeted-forms.md §3. */
  getChangedForms: () =>
    jsonFetch<{
      git: boolean;
      changed: Array<{ category: 'app' | 'contact'; basename: string; formId: string }>;
    }>('/api/forms/changed'),

  getForm: (id: string) =>
    jsonFetch<{ id: string; form: XLSForm; properties: unknown }>(
      `/api/forms/${encodeURIComponent(id)}`,
    ),

  saveForm: (id: string, form: XLSForm, properties?: unknown) =>
    jsonFetch<{ ok: true }>(`/api/forms/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ form, properties }),
    }),

  /**
   * Create a new form. The dialog flow (FormsIndex.doCreate) resolves the
   * filename client-side via `deriveFormName` (slugify + auto-suffix on
   * collision) and passes it as the positional plus the friendly title in
   * `opts.title`. The positional is ALWAYS sent as `basename`, so every
   * caller hits the server's strict path: an explicit basename that
   * already exists answers 409 (audit item 15) — a legacy 2-arg caller
   * passing an exact name must never be silently handed `foo_2`. The
   * server's title-driven auto-suffix path only serves callers that send
   * `title` without a basename (raw HTTP / older clients).
   */
  createForm: (
    category: 'app' | 'contact',
    basenameOrTitle: string,
    scaffold: 'default' | 'blank' = 'default',
    opts?: { title?: string },
  ) =>
    jsonFetch<{ ok: true; id: string; basename: string }>('/api/forms/create', {
      method: 'POST',
      body: JSON.stringify({
        category,
        title: opts?.title,
        basename: basenameOrTitle,
        scaffold,
      }),
    }),

  /**
   * Geriatric §2 — upload a display image for a form. The server writes
   * it to `forms/<category>/<basename>-media/<filename>` (the CHT
   * convention folder `cht-conf upload-app-forms` attaches) and returns
   * the sanitized filename to store in the row's `media::image` cell.
   * Sent as base64 JSON — the files are small illustrations and the
   * server stack has no multipart parser; the on-disk contract is
   * identical.
   */
  uploadFormMedia: async (formId: string, file: File) => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('Could not read the selected file.'));
      r.readAsDataURL(file);
    });
    const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return jsonFetch<{ ok: true; filename: string }>(
      `/api/forms/${encodeURIComponent(formId)}/media`,
      {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, dataBase64 }),
      },
    );
  },

  /** Batch contact-form generator (offered from the Hierarchy editor).
   *  See docs/plans/contact-form-generator.md. Skip-not-overwrite is a
   *  hard contract on the server; the client submits the (type,variant)
   *  list + the current contact_types snapshot. */
  generateContactForms: (body: {
    requests: Array<{ type: string; variant: 'create' | 'edit'; displayName?: string }>;
    contactTypes: Array<{ id: string; person?: boolean; parents?: string[] }>;
    locales?: string[];
    /** When true, existing contact forms are clobbered (UI must confirm
     *  first). Default false preserves the skip-not-overwrite contract. */
    overwrite?: boolean;
  }) =>
    jsonFetch<{
      ok: true;
      written: number;
      overwritten: number;
      skipped: number;
      invalid: number;
      failed: number;
      report: Array<{
        type: string;
        variant: 'create' | 'edit';
        basename: string;
        status: 'written' | 'overwritten' | 'skipped' | 'invalid' | 'failed';
        message?: string;
        previousBytes?: number;
        warnings: string[];
      }>;
    }>('/api/forms/generate-contact', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteForm: (id: string) =>
    jsonFetch<{ ok: true }>(`/api/forms/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getHierarchy: () =>
    jsonFetch<{
      place_hierarchy_types: string[];
      contact_types: Array<Record<string, unknown> & { id: string }>;
      place_types_display: Record<string, string>;
    }>('/api/hierarchy'),

  saveHierarchy: (body: {
    place_hierarchy_types: string[];
    contact_types: Array<Record<string, unknown> & { id: string }>;
    place_types_display: Record<string, string>;
  }) =>
    jsonFetch<{ ok: true }>('/api/hierarchy', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  getTaskFiles: () =>
    jsonFetch<Record<'tasks.js' | 'task-schedules.js' | 'tasks-extras.js', string | null>>(
      '/api/tasks/files',
    ),

  saveTaskFile: (file: 'tasks.js' | 'task-schedules.js' | 'tasks-extras.js', content: string) =>
    jsonFetch<{ ok: true }>(`/api/tasks/files/${encodeURIComponent(file)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  getContactSummaryFiles: () =>
    jsonFetch<
      Record<'contact-summary.templated.js' | 'contact-summary.extras.js', string | null>
    >('/api/contact-summary/files'),

  /**
   * Which context values does this config already compute? Union of three
   * channels — form calculations, form eligibility, and a static scan of the
   * contact-summary — plus the wrapper idiom the project already uses.
   * See shared/src/contactSummary/contextKeyDiscovery.ts.
   */
  getContactSummaryContextKeys: () =>
    jsonFetch<
      ContextScan & {
        summaryFiles: string[];
        /** Forms whose workbook could not be parsed, so their reads are absent. */
        unreadableForms: string[];
        houseWrapper: ContextWrapper | null;
      }
    >('/api/contact-summary/context-keys'),

  saveContactSummaryFile: (
    file: 'contact-summary.templated.js' | 'contact-summary.extras.js',
    content: string,
  ) =>
    jsonFetch<{ ok: true }>(`/api/contact-summary/files/${encodeURIComponent(file)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  // FHIR V1 — Standard codes mapping (docs/plans/fhir-v1-workbench.md).
  // GET returns the reconciled mapping (orphans relocated from a stale
  // store); PUT writes the canonical bytes via compare-before-write +
  // atomic tmp+rename. Sidecar lives at <project>/fhir-mapping.json.
  getFhirMapping: () =>
    jsonFetch<{ mapping: import('@cht-ui/shared').FhirMapping }>('/api/fhir-mapping'),

  saveFhirMapping: (mapping: import('@cht-ui/shared').FhirMapping) =>
    jsonFetch<{ ok: true; written: boolean }>('/api/fhir-mapping', {
      method: 'PUT',
      body: JSON.stringify({ mapping }),
    }),

  /** Fetch the bundled cht-mch-v1 starter pack — used by the workbench
   *  to enumerate dictionaries + render dictionary-filtered code
   *  suggestions in the two-step picker. */
  getFhirPack: () =>
    jsonFetch<{ pack: import('@cht-ui/shared').StarterPack }>('/api/fhir-mapping/pack'),

  /** List the vendored terminology dictionaries with their entry counts +
   *  version pins. Backs the picker's step-1 button row — buttons render
   *  regardless of `available`; an unavailable dictionary just searches
   *  to empty. See docs/plans/fhir-pack-population.md. */
  listFhirDictionaries: () =>
    jsonFetch<{
      systems: Array<{
        systemId: import('@cht-ui/shared').DictionarySystemId;
        system: string;
        available: boolean;
        count: number | null;
        version: string | null;
      }>;
    }>('/api/fhir/dictionary/list'),

  /** Read every `messages-<locale>.properties` file the project ships. The
   *  server surfaces the parsed line list per file; the client only needs
   *  the (key, value) entries to render the grid. */
  getTranslations: () =>
    jsonFetch<{
      files: Array<{
        locale: string;
        dir: string;
        path: string;
        entries: import('@cht-ui/shared').PropertiesFile;
      }>;
    }>('/api/translations'),

  /** Batched save for one locale: {updates} pairs are applied via
   *  `updateProperty` on the server, so every unedited line stays
   *  byte-identical on disk. `dir` disambiguates when the same locale exists
   *  in both `translations/` and `app_settings/forms/translations/`. */
  putTranslations: (
    locale: string,
    updates: Array<{ key: string; value: string }>,
    dir?: string,
  ) =>
    jsonFetch<{ ok: true; path: string }>(
      `/api/translations/${encodeURIComponent(locale)}${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`,
      {
        method: 'PUT',
        body: JSON.stringify({ updates }),
      },
    ),

  /** Debounced search over one dictionary. The picker calls this on every
   *  keystroke (after a debounce window); sub-50 ms per call by design. */
  searchFhirDictionary: (params: {
    system: import('@cht-ui/shared').DictionarySystemId;
    q: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams({ system: params.system, q: params.q });
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.offset !== undefined) qs.set('offset', String(params.offset));
    return jsonFetch<{
      system: string;
      systemId: import('@cht-ui/shared').DictionarySystemId;
      dictionaryVersion: string | null;
      total: number;
      entries: Array<{ code: string; display: string; aliases: string[] }>;
      available: boolean;
    }>(`/api/fhir/dictionary/search?${qs.toString()}`);
  },
};
