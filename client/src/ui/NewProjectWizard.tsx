/**
 * New-project wizard: pick a template, name it (hosted) or place it on disk
 * (desktop), scaffold a cht-conf project and open it. Three steps:
 *
 *   1. Choose a template — "Start blank" is the `empty` template and is a
 *      first-class entry point, not a fallback (docs/plans/hosted-authoring.md §2)
 *   2. Hosted: a name. Desktop: a target folder (text input or FolderBrowser)
 *   3. Confirm + scaffold + open
 *
 * The wizard does NOT generate XLSForm files — templates ship the scaffolding
 * (base_settings, tasks.js, contact-summary, properties.json, translations)
 * and the user creates forms via "+ App form" after the project opens.
 */
import { useEffect, useState } from 'react';
import { api, session } from '../api.js';
import { useApp } from '../state/store.js';
import { FolderBrowser } from './FolderBrowser.js';

interface Template {
  id: string;
  label: string;
  description: string;
  forms: { app: number; contact: number };
  hasStarterContent: boolean;
}

export function NewProjectWizard(props: { onCancel: () => void; initialTemplate?: string }) {
  const hosted = useApp((s) => s.session?.mode === 'hosted');
  const setProject = useApp((s) => s.setProject);
  const setError = useApp((s) => s.setError);
  const [step, setStep] = useState<1 | 2 | 3>(props.initialTemplate ? 2 : 1);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [picked, setPicked] = useState<string>(props.initialTemplate ?? 'blank');
  const [parentPath, setParentPath] = useState('');
  const [projectName, setProjectName] = useState(hosted ? '' : 'my-cht-project');
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listTemplates()
      .then((r) => setTemplates(r.templates))
      .catch((e: Error) => setLocalError(e.message));
  }, []);

  const targetPath = !hosted && parentPath && projectName ? joinPath(parentPath, projectName) : '';
  const step2Ready = hosted ? projectName.trim().length > 0 : Boolean(parentPath && projectName);
  const pickedTemplate = templates.find((t) => t.id === picked);

  async function scaffold() {
    if (!step2Ready) {
      setLocalError(hosted ? 'Name the project first.' : 'Pick a parent folder and a project name first.');
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      const created = await api.createFromTemplate(
        picked,
        hosted ? { name: projectName.trim() } : { path: targetPath, name: projectName.trim() },
      );
      // Open it so the user lands inside the new project immediately.
      const opened = await api.openProjectById(created.projectId);
      session.setProjectId(opened.projectId);
      setProject(opened.project);
      props.onCancel();
    } catch (e) {
      setLocalError((e as Error).message);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={props.onCancel}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{picked === 'empty' ? 'Start a blank CHT project' : 'Create a new CHT project'}</h2>
          <button className="link" onClick={props.onCancel}>
            ✕
          </button>
        </div>

        <div className="wizard-steps">
          <Step n={1} label="Template" active={step === 1} done={step > 1} onClick={() => setStep(1)} />
          <Step
            n={2}
            label={hosted ? 'Name' : 'Location'}
            active={step === 2}
            done={step > 2}
            onClick={() => setStep(2)}
          />
          <Step n={3} label="Confirm" active={step === 3} done={false} onClick={() => setStep(3)} />
        </div>

        <div className="modal-body">
          {localError && <div className="error-banner">{localError}</div>}

          {step === 1 && (
            <>
              <p className="muted">
                Pick a starter. <strong>Start blank</strong> has nothing pre-defined — the honest
                starting point for a use case nobody has templated. Richer templates ship a
                hierarchy, tasks and contact-summary so you don't write them from scratch.
              </p>
              <div className="template-grid">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    className={`template-card ${picked === t.id ? 'selected' : ''}`}
                    onClick={() => setPicked(t.id)}
                  >
                    <h3>{t.label}</h3>
                    <p className="muted small">{t.description}</p>
                    {t.hasStarterContent && <span className="badge">starter content</span>}
                  </button>
                ))}
                {templates.length === 0 && <p className="muted">Loading templates…</p>}
              </div>
            </>
          )}

          {step === 2 && hosted && (
            <div className="form-row">
              <label htmlFor="new-project-name">Project name</label>
              <input
                id="new-project-name"
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="e.g. Flood response 2026"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && step2Ready) setStep(3);
                }}
              />
              <p className="muted small">You can rename it later. The name is yours; nothing else depends on it.</p>
            </div>
          )}

          {step === 2 && !hosted && (
            <>
              <p className="muted">
                Where on disk should the project live? The folder will be created as{' '}
                <code>parent / project-name</code>. If it already exists and is non-empty,
                scaffolding will refuse to overwrite.
              </p>
              <div className="form-row">
                <label>Parent folder</label>
                <div className="row gap">
                  <input
                    type="text"
                    value={parentPath}
                    onChange={(e) => setParentPath(e.target.value)}
                    placeholder="e.g. D:\medic"
                    style={{ flex: 1 }}
                  />
                  <button className="secondary" onClick={() => setBrowsing(true)}>
                    Browse…
                  </button>
                </div>
              </div>
              <div className="form-row">
                <label>Project name</label>
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="e.g. malaria-nepal"
                  pattern="[A-Za-z0-9_-]+"
                />
                <p className="muted small">
                  Use letters, numbers, dashes, underscores only. This becomes the folder name.
                </p>
              </div>
              {targetPath && (
                <p className="muted small">
                  → Will create <code>{targetPath}</code>
                </p>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <h3>Ready to scaffold</h3>
              <table className="confirm-table">
                <tbody>
                  <tr>
                    <td>Template</td>
                    <td>
                      <code>{picked}</code> — {pickedTemplate?.label}
                    </td>
                  </tr>
                  <tr>
                    <td>{hosted ? 'Name' : 'Target folder'}</td>
                    <td>
                      <code>{hosted ? projectName.trim() : targetPath}</code>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="muted small">
                After scaffolding, the project will open automatically. You can then add forms,
                edit the hierarchy, and check it with the real cht-conf toolchain.
              </p>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="secondary" onClick={props.onCancel}>
            Cancel
          </button>
          {step > 1 && (
            <button className="secondary" onClick={() => setStep((step - 1) as 1 | 2)}>
              ← Back
            </button>
          )}
          {step < 3 && (
            <button
              onClick={() => setStep((step + 1) as 2 | 3)}
              disabled={step === 1 ? !picked : !step2Ready}
            >
              Next →
            </button>
          )}
          {step === 3 && (
            <button onClick={() => void scaffold()} disabled={busy || !step2Ready}>
              {busy ? 'Scaffolding…' : 'Create project'}
            </button>
          )}
        </div>

        {browsing && (
          <FolderBrowser
            initialPath={parentPath || undefined}
            onCancel={() => setBrowsing(false)}
            onSelect={(p) => {
              setBrowsing(false);
              setParentPath(p);
            }}
          />
        )}
      </div>
    </div>
  );
}

function Step(props: {
  n: number;
  label: string;
  active: boolean;
  done: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`wizard-step ${props.active ? 'active' : ''} ${props.done ? 'done' : ''}`}
      onClick={props.onClick}
    >
      <span className="step-num">{props.done ? '✓' : props.n}</span>
      <span className="step-label">{props.label}</span>
    </button>
  );
}

function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  const sep = /^[A-Za-z]:[\\/]/.test(parent) ? '\\' : '/';
  if (parent.endsWith('\\') || parent.endsWith('/')) return parent + name;
  return parent + sep + name;
}
