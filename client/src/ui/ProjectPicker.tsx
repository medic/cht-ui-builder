import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../state/store.js';
import { FolderBrowser } from './FolderBrowser.js';
import { NewProjectWizard } from './NewProjectWizard.js';

export function ProjectPicker() {
  const setProject = useApp((s) => s.setProject);
  const setError = useApp((s) => s.setError);
  const [pathInput, setPathInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);

  async function openPath(p: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.openProject(p);
      setProject(res.project);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    if (!pathInput.trim()) return;
    await openPath(pathInput.trim());
  }

  return (
    <div className="project-picker">
      <div className="card">
        <h1>CHT UI Builder</h1>
        <p className="subtitle">No-code editor for cht-conf project folders.</p>
        <p>
          Open a cht-conf project folder to begin — the directory containing{' '}
          <code>app_settings.json</code> and <code>forms/</code>.
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
              if (e.key === 'Enter') void open();
            }}
          />
          <button onClick={() => setBrowsing(true)} disabled={busy} className="secondary">
            Browse…
          </button>
          <button onClick={open} disabled={busy || !pathInput.trim()}>
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
        <p className="hint">
          The path must already exist on disk. On Windows, use backslashes. Forward slashes work
          too.
        </p>
        <hr className="divider" />
        <p className="muted">No project yet? Scaffold one from a starter template:</p>
        <button onClick={() => setCreating(true)} className="secondary" style={{ width: '100%' }}>
          ✨ Create new project…
        </button>
        {creating && <NewProjectWizard onCancel={() => setCreating(false)} />}
      </div>
    </div>
  );
}
