/**
 * Getting the project OUT: download a zip, or push a branch back to the repo
 * it was imported from (docs/plans/hosted-authoring.md §6.4).
 *
 * Shown on the overview in both modes — the hosted user has no other way to
 * reach their files, and a desktop user may want a clean zip too.
 */
import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../state/store.js';

export function ProjectTransfer() {
  const project = useApp((s) => s.project);
  const [branch, setBranch] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<null | 'zip' | 'git'>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!project) return null;
  const fromGit = project.source === 'import-git';

  async function downloadZip() {
    setBusy('zip');
    setError(null);
    setResult(null);
    try {
      await api.downloadZip(project!.id, project!.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function pushBranch() {
    setBusy('git');
    setError(null);
    setResult(null);
    try {
      const r = await api.exportGit(project!.id, branch.trim(), message.trim() || undefined);
      setResult(
        `${r.committed ? 'Committed and pushed' : 'Nothing new to commit; pushed'} branch ${r.branch}. Review and merge it in your repository.\n\n${r.output}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="transfer">
      <h2>Take it with you</h2>
      <p className="muted small">
        Everything here is a plain cht-conf project folder. Download it and deploy to your own CHT
        with <code>cht --url … upload-app-settings upload-app-forms</code>
        {fromGit ? ', or push your edits back as a branch to review and merge.' : '.'}
      </p>
      <div className="row gap wrap">
        <button type="button" className="secondary" onClick={() => void downloadZip()} disabled={busy !== null}>
          {busy === 'zip' ? 'Preparing…' : '⬇ Download zip'}
        </button>
        {fromGit && (
          <>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="branch name, e.g. ui-builder/anc-edits"
              style={{ flex: 1, minWidth: 220 }}
            />
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="commit message (optional)"
              style={{ flex: 1, minWidth: 220 }}
            />
            <button type="button" onClick={() => void pushBranch()} disabled={busy !== null || !branch.trim()}>
              {busy === 'git' ? 'Pushing…' : '⤒ Push branch'}
            </button>
          </>
        )}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {result && <pre className="transfer-output small">{result}</pre>}
    </section>
  );
}
