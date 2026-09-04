/* global window, File */
/**
 * The first screen: this user's projects, and every way to get a new one.
 *
 *   • open one from the list (the registry the server keeps per user)
 *   • start blank / from a template (NewProjectWizard)
 *   • import from a git URL, or upload a zip
 *   • desktop only: open any folder on this machine by path or browser
 *
 * Opening pins the project to THIS tab (sessionStorage) — see api.ts.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, session, type ProjectListEntry } from '../api.js';
import { useApp } from '../state/store.js';
import { FolderBrowser } from './FolderBrowser.js';
import { NewProjectWizard } from './NewProjectWizard.js';

export function ProjectPicker() {
  const sess = useApp((s) => s.session);
  const hosted = sess?.mode === 'hosted';
  const setProject = useApp((s) => s.setProject);
  const setSession = useApp((s) => s.setSession);
  const setError = useApp((s) => s.setError);

  const [projects, setProjects] = useState<ProjectListEntry[] | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [wizard, setWizard] = useState<null | { template?: string }>(null);
  const [importing, setImporting] = useState<null | 'git' | 'zip'>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.listProjects();
      setProjects(r.projects);
    } catch (e) {
      setProjects([]);
      setError((e as Error).message);
    }
  }, [setError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function openId(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.openProjectById(id);
      session.setProjectId(res.projectId);
      setProject(res.project);
    } catch (e) {
      setError((e as Error).message);
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  async function openPath(p: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.openProject(p);
      session.setProjectId(res.projectId);
      setProject(res.project);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function forget(p: ProjectListEntry) {
    const ok = window.confirm(
      hosted
        ? `Delete "${p.name}" and all its files from this server?\n\nDownload a zip first if you want to keep it.`
        : `Remove "${p.name}" from this list?\n\nThe folder stays on disk; you can open it again by path.`,
    );
    if (!ok) return;
    try {
      await api.deleteProject(p.id, hosted);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function signOut() {
    try {
      await api.logout();
    } catch {
      /* token may already be dead */
    }
    session.setToken(null);
    session.setProjectId(null);
    setSession({ mode: 'hosted', user: null });
  }

  return (
    <div className="project-picker">
      <div className="card wide">
        <div className="picker-header">
          <div>
            <h1>CHT UI Builder</h1>
            <p className="subtitle">
              {hosted
                ? 'Build a Community Health Toolkit app in your browser. Nothing to install.'
                : 'No-code editor for cht-conf project folders.'}
            </p>
          </div>
          {hosted && sess?.user && (
            <div className="picker-user muted small">
              {sess.user.email}
              <button type="button" className="link" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          )}
        </div>

        <section>
          <h2>Your projects</h2>
          {projects === null && <p className="muted">Loading…</p>}
          {projects !== null && projects.length === 0 && (
            <p className="muted">
              Nothing yet. Start blank, pick a template, or import a config below.
            </p>
          )}
          {projects && projects.length > 0 && (
            <ul className="project-list" data-testid="project-list">
              {projects.map((p) => (
                <li key={p.id} className={`project-row ${p.exists ? '' : 'missing'}`}>
                  <button
                    type="button"
                    className="project-open"
                    disabled={busy || !p.exists}
                    onClick={() => void openId(p.id)}
                    title={p.path ?? p.name}
                  >
                    <strong>{p.name}</strong>
                    <span className="meta muted small">
                      {sourceLabel(p)}
                      {p.path ? ` · ${p.path}` : ''}
                      {!p.exists ? ' · folder missing' : ''}
                      {` · opened ${relativeTime(p.lastOpenedAt)}`}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="link danger small"
                    onClick={() => void forget(p)}
                    title={hosted ? 'Delete this project from the server' : 'Remove from this list'}
                  >
                    {hosted ? 'Delete' : 'Forget'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>New project</h2>
          <div className="picker-actions">
            <button type="button" onClick={() => setWizard({ template: 'empty' })} disabled={busy}>
              ✨ Start blank
            </button>
            <button type="button" className="secondary" onClick={() => setWizard({})} disabled={busy}>
              📋 From a template…
            </button>
            <button type="button" className="secondary" onClick={() => setImporting('git')} disabled={busy}>
              ⤓ Import from git…
            </button>
            <button type="button" className="secondary" onClick={() => setImporting('zip')} disabled={busy}>
              🗜 Import a zip…
            </button>
          </div>
        </section>

        {!hosted && (
          <section>
            <h2>Open a folder on this computer</h2>
            <p className="muted small">
              The directory containing <code>app_settings/</code> and <code>forms/</code>.
            </p>
            <label htmlFor="project-path">Project folder (absolute path)</label>
            <div className="row">
              <input
                id="project-path"
                type="text"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                placeholder="W:\path\to\cht-config"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && pathInput.trim()) void openPath(pathInput.trim());
                }}
              />
              <button type="button" onClick={() => setBrowsing(true)} disabled={busy} className="secondary">
                Browse…
              </button>
              <button
                type="button"
                onClick={() => void openPath(pathInput.trim())}
                disabled={busy || !pathInput.trim()}
              >
                {busy ? 'Opening…' : 'Open'}
              </button>
            </div>
            {browsing && (
              <FolderBrowser
                initialPath={pathInput.trim() || undefined}
                onCancel={() => setBrowsing(false)}
                onSelect={(p) => {
                  setBrowsing(false);
                  setPathInput(p);
                  void openPath(p);
                }}
              />
            )}
          </section>
        )}

        {hosted && (
          <p className="hint">
            A test platform for trying CHT. Your projects are yours — download a zip any time and
            deploy it to your own CHT instance. Do not enter real patient data here.
          </p>
        )}

        {wizard && (
          <NewProjectWizard initialTemplate={wizard.template} onCancel={() => setWizard(null)} />
        )}
        {importing === 'git' && (
          <ImportGitDialog
            onCancel={() => setImporting(null)}
            onDone={(id) => {
              setImporting(null);
              void openId(id);
            }}
          />
        )}
        {importing === 'zip' && (
          <ImportZipDialog
            onCancel={() => setImporting(null)}
            onDone={(id) => {
              setImporting(null);
              void openId(id);
            }}
          />
        )}
      </div>
    </div>
  );
}

function sourceLabel(p: ProjectListEntry): string {
  switch (p.source) {
    case 'template':
      return p.origin === 'empty' ? 'started blank' : `from template ${p.origin ?? ''}`.trim();
    case 'import-git':
      return `from ${p.origin ?? 'git'}`;
    case 'import-zip':
      return 'from zip';
    default:
      return 'local folder';
  }
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function ImportGitDialog(props: { onCancel: () => void; onDone: (projectId: string) => void }) {
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.importGit(url.trim(), name.trim() || undefined, branch.trim() || undefined);
      props.onDone(r.projectId);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={props.onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Import from git</h2>
          <button className="link" onClick={props.onCancel}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}
          <p className="muted small">
            Clones the repository here. If the cht-conf project is in a subfolder (e.g.{' '}
            <code>chis/</code>) it is found automatically. Edits can be pushed back as a branch
            from the project overview. For a private repository use{' '}
            <code>https://user:token@host/org/repo.git</code>.
          </p>
          <div className="form-row">
            <label>Repository URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/org/cht-config.git"
              autoFocus
            />
          </div>
          <div className="row gap">
            <div className="form-row" style={{ flex: 1 }}>
              <label>Branch (optional)</label>
              <input type="text" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="default" />
            </div>
            <div className="form-row" style={{ flex: 1 }}>
              <label>Project name (optional)</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="from the URL" />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="secondary" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button onClick={() => void go()} disabled={busy || !url.trim()}>
            {busy ? 'Cloning…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportZipDialog(props: { onCancel: () => void; onDone: (projectId: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.importZip(file, name.trim() || file.name.replace(/\.zip$/i, ''));
      props.onDone(r.projectId);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={props.onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Import a zip</h2>
          <button className="link" onClick={props.onCancel}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}
          <p className="muted small">
            A zip of a cht-conf project folder (the one holding <code>app_settings/</code> and{' '}
            <code>forms/</code>). <code>node_modules</code>, <code>.git</code> and map exports are
            skipped.
          </p>
          <div className="form-row">
            <label>Zip file</label>
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !name) setName(f.name.replace(/\.zip$/i, ''));
              }}
            />
          </div>
          <div className="form-row">
            <label>Project name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <div className="modal-footer">
          <button className="secondary" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button onClick={() => void go()} disabled={busy || !file}>
            {busy ? 'Uploading…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
