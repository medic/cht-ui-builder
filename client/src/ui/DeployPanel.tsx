/**
 * cht-conf integration panel. Surfaces every cht-conf action as a button,
 * grouped by category, with an inline log viewer that streams stdout/stderr
 * from the spawned binary via Server-Sent Events.
 *
 * Auth & target: deploy actions (anything that hits an instance) are gated
 * behind a target form (--local | --instance | --url) plus a username.
 * Passwords are typed each run and never persisted.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  runPreflight,
  type PreflightContext,
  type PreflightContextForm,
  type PreflightFix,
  type XLSForm,
} from '@cht-ui/shared';
import { api, type DeployConfig } from '../api.js';
import { useApp } from '../state/store.js';
import { PreflightPanel } from './PreflightPanel.js';

interface FriendlyHint {
  patternId: string;
  friendly: string;
  hint?: string;
  docsUrl?: string;
  knownUpstreamBug?: boolean;
  rawLine: string;
}

type Category =
  | 'validate'
  | 'compile'
  | 'convert'
  | 'compress'
  | 'backup'
  | 'upload'
  | 'danger'
  | 'utility';

interface Action {
  name: string;
  category: Category;
  requiresInstance: boolean;
  dangerous: boolean;
  label: string;
}

/**
 * cht-conf actions that accept positional `-- <basenames>` for targeted form
 * deploys. See docs/plans/deploy-targeted-forms.md §2. Each one is paired with
 * the form category whose basenames it consumes (app vs contact).
 */
const FORM_SCOPED_ACTIONS: Record<string, 'app' | 'contact'> = {
  'convert-app-forms': 'app',
  'upload-app-forms': 'app',
  'upload-contact-forms': 'contact',
};

interface FormListItem {
  formId: string;
  category: 'app' | 'contact';
  basename: string;
}

const CATEGORY_ORDER: Category[] = [
  'validate',
  'compile',
  'convert',
  'compress',
  'backup',
  'upload',
  'utility',
  'danger',
];

const CATEGORY_LABELS: Record<Category, string> = {
  validate: 'Validate / Health check',
  compile: 'Compile',
  convert: 'Convert (xlsx → xml)',
  compress: 'Compress media',
  backup: 'Backup from instance',
  upload: 'Deploy to instance',
  utility: 'Utility',
  danger: 'Danger zone',
};

/**
 * The one-click deploy pipeline's default step order. The server's
 * DEPLOY_STEPS (server/src/routes/deploy.ts) is the ALLOWLIST of what may
 * run; this is the subset one-click actually runs. Kept local because the
 * client only needs the names as strings.
 *
 * NOTE the two lists are not identical: the server also allows
 * `upload-resources`, which one-click does not run (pre-existing — see the
 * W2 commit message; icons/images therefore need the granular deploy).
 *
 * W2 — `upload-custom-translations` MUST be here, not just in the server
 * allowlist, or a one-click deploy leaves every translation string on disk
 * and the CHW reads the raw key. That is the delivery half of the
 * per-locale task titles (docs/NEXT.md item 8).
 */
const DEFAULT_DEPLOY_STEPS: readonly string[] = [
  'compile-app-settings',
  'convert-app-forms',
  'convert-contact-forms',
  'upload-app-forms',
  'upload-contact-forms',
  'upload-app-settings',
  'upload-custom-translations',
];

interface DeployRunStep {
  step: string;
  status: 'pending' | 'running' | 'success' | 'fail';
  stderrExcerpt?: string;
  translated?: FriendlyHint;
}

/**
 * Compact a stderr blob for inline display next to a failed step. Prefers
 * the last non-empty line (that's where cht-conf's actual error usually
 * lives); falls back to the last ~200 chars if the tail is empty.
 */
function excerptStderr(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return stderr.slice(-200);
  return lines[lines.length - 1]!;
}

const CATEGORY_HINTS: Record<Category, string> = {
  validate: 'Read-only checks. Safe to run anytime.',
  compile: 'Compiles app_settings.json from tasks.js, contact-summary, schedules.',
  convert: 'Builds form XML from XLSX. Run before deploying forms.',
  compress: 'Image / SVG / PNG optimisers. Local only.',
  backup: 'Reads from the configured CHT instance. Saves to ./backups.',
  upload: 'Writes to the configured CHT instance. Authenticate first.',
  utility: 'CSV imports, hierarchy moves, user provisioning.',
  danger: 'Destructive — irreversible. Requires explicit confirmation.',
};

export function DeployPanel() {
  const [actions, setActions] = useState<Action[]>([]);
  const [binaryAvailable, setBinaryAvailable] = useState<boolean>(true);
  const [chtConfVersion, setChtConfVersion] = useState<string | null>(null);
  const [config, setConfig] = useState<DeployConfig | null>(null);
  const [password, setPassword] = useState('');
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  // Targeted-deploy state: which forms exist + which are changed in git.
  // pickerAction is set when the user clicks a form-scoped action; the picker
  // hands selected basenames back to launch() as `extraArgs = ['--', ...names]`.
  const [allForms, setAllForms] = useState<FormListItem[]>([]);
  const [changedFormIds, setChangedFormIds] = useState<Set<string>>(new Set());
  const [hasGit, setHasGit] = useState<boolean>(false);
  const [pickerAction, setPickerAction] = useState<Action | null>(null);
  // Bridge between picker confirm and the password-gate detour: when a
  // form-scoped action needs a password, the picker's chosen extraArgs have
  // to survive across pendingAction → launch().
  const [pickerExtraArgsForPending, setPickerExtraArgsForPending] = useState<string[] | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [hints, setHints] = useState<FriendlyHint[]>([]);
  const [dryRun, setDryRun] = useState(false);
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Inline result of the Test-connection probe. Tracked separately from
  // the cht-conf run log so the user can see the auth/version result
  // even after they start an unrelated action and the log scrolls.
  const [connectionResult, setConnectionResult] = useState<
    | null
    | {
        ok: boolean;
        status?: number;
        version?: string;
        couchVersion?: string;
        authenticatedAs?: string;
        error?: string;
        redactedUrl: string;
        at: number;
      }
  >(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Preflight — parsed forms cache keyed by formId. Loaded once on mount for
  // every form the project ships; individual form saves elsewhere invalidate
  // by re-fetching via the "reload preflight" affordance (implicit here —
  // navigating away and back re-runs the effect). The shared runner is pure,
  // so as long as the cache is fresh the panel reflects reality.
  const [preflightForms, setPreflightForms] = useState<PreflightContextForm[]>([]);

  // One-click deploy state. Kept parallel to the per-action `running` /
  // `lines` state so a power-user macro run and the one-click run never
  // stomp each other's log — the one-click flow has its own progress + hint
  // buffers, wired to a distinct NDJSON stream.
  const [deploySteps, setDeploySteps] = useState<Set<string>>(new Set(DEFAULT_DEPLOY_STEPS));
  const [deployRunning, setDeployRunning] = useState(false);
  const [deployProgress, setDeployProgress] = useState<DeployRunStep[]>([]);
  const [overridePreflight, setOverridePreflight] = useState(false);

  async function runTestConnection(): Promise<void> {
    setTestingConnection(true);
    setConnectionResult(null);
    try {
      const r = await api.testConnection(password);
      setConnectionResult({ ...r, at: Date.now() });
    } catch (e) {
      setConnectionResult({
        ok: false,
        error: (e as Error).message,
        redactedUrl: '',
        at: Date.now(),
      });
    } finally {
      setTestingConnection(false);
    }
  }

  useEffect(() => {
    void api.chtConfActions().then((r) => {
      setActions(r.actions);
      setBinaryAvailable(r.binaryAvailable);
      setChtConfVersion(r.version);
    });
    void api.getDeployConfig().then((r) => setConfig(r.config ?? { target: 'local' }));
    void api.listForms().then((r) => {
      setAllForms(
        r.forms.map((f) => ({
          formId: f.id,
          category: f.category,
          basename: f.filename.replace(/\.xlsx$/i, ''),
        })),
      );
    });
    void api.getChangedForms().then((r) => {
      setHasGit(r.git);
      setChangedFormIds(new Set(r.changed.map((c) => c.formId)));
    });
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  // Preflight — fetch every form once and parse-cache it for the shared
  // runner. Uses `allForms` as the source-of-truth; each `api.getForm` call
  // is independent so we fan them out in parallel and settle to whatever
  // succeeded (a single failing form doesn't blank the panel). The
  // required-files probe stays null this cycle — no server route exists
  // yet, and the shared runner's contract is "null → skip the pack".
  useEffect(() => {
    if (allForms.length === 0) {
      setPreflightForms([]);
      return;
    }
    let alive = true;
    void Promise.allSettled(
      allForms.map(async (f) => ({
        formId: f.basename,
        xlsform: (await api.getForm(f.formId)).form as XLSForm,
        isContactForm: f.category === 'contact',
      })),
    ).then((results) => {
      if (!alive) return;
      const out: PreflightContextForm[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') out.push(r.value);
      }
      setPreflightForms(out);
    });
    return () => {
      alive = false;
    };
  }, [allForms]);

  const preflightCtx: PreflightContext = useMemo(
    () => ({ forms: preflightForms, requiredFiles: null }),
    [preflightForms],
  );

  const preflightErrorCount = useMemo(
    () => runPreflight(preflightCtx).filter((r) => r.severity === 'error').length,
    [preflightCtx],
  );

  async function saveConfig(next: DeployConfig) {
    setConfig(next);
    try {
      await api.setDeployConfig(next);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Route a preflight fix descriptor to the appropriate editor. This is
   * navigation + hand-off only — the actual mutation happens in the
   * FormEditor / HierarchyEditor. `formId` in preflight fix descriptors
   * is the form BASENAME (see PreflightContextForm.formId); the app's
   * View shape uses the composite id `app:<basename>` / `contact:<basename>`,
   * so we resolve back to a FormListEntry.id via `allForms`.
   */
  function handlePreflightFix(fix: PreflightFix) {
    if (fix.kind === 'rename-row') {
      const match = allForms.find((f) => f.basename === fix.formId);
      if (!match) {
        // eslint-disable-next-line no-undef
        window.alert(`Could not find form "${fix.formId}" — reload and try again.`);
        return;
      }
      // Existing jump-to-row pattern: setView opens FormEditor; FormEditor's
      // local revealRowId channel takes over once the row id is in the URL /
      // hash slot. This cycle we drop into the form; the highlighted-row
      // scroll follow-up needs a store-level revealRowId slot and is called
      // out as a shared non-goal in owned-deploy-pipeline.md §Non-goals.
      useApp.getState().setView({ kind: 'form', id: match.formId });
      return;
    }
    if (fix.kind === 'regenerate-contact-form') {
      // eslint-disable-next-line no-undef
      window.alert(
        `Regenerating contact form "${fix.formId}" — opening the hierarchy editor. ` +
          'Click "Generate contact forms…" and choose "Regenerate (overwrite existing)".',
      );
      useApp.getState().setView({ kind: 'hierarchy' });
      return;
    }
    if (fix.kind === 'stub-file') {
      // Stubbing missing files needs a server-side write route
      // (POST /api/preflight/stub-file); until that lands, surface the
      // intended action so the user can drop in the file by hand. Same
      // content lives in server/templates/blank/ per the templates-ship-
      // required-minimal memory.
      // eslint-disable-next-line no-undef
      window.alert(
        `Missing required file: ${fix.path}\n\n` +
          `This project is missing ${fix.path}. To scaffold it, run:\n\n` +
          `  cht-conf-init\n\n` +
          `or copy the template from server/templates/blank/${fix.path} into the project root.`,
      );
      return;
    }
    if (fix.kind === 'add-choice-list') {
      const match = allForms.find((f) => f.basename === fix.formId);
      if (!match) {
        // eslint-disable-next-line no-undef
        window.alert(`Could not find form "${fix.formId}" — reload and try again.`);
        return;
      }
      useApp.getState().setView({ kind: 'form', id: match.formId });
      return;
    }
  }

  /**
   * One-click owned-deploy pipeline. Streams NDJSON from POST /api/deploy/run;
   * updates the per-step progress list as events arrive. This flow is
   * distinct from the per-macro runs above — it uses HTTP streaming, not
   * SSE-subscribe-by-runId, and populates its own progress buffer instead
   * of the shared log. The existing per-step buttons still work unchanged.
   */
  async function runOneClickDeploy() {
    if (!config) return;
    setError(null);
    const steps = DEFAULT_DEPLOY_STEPS.filter((s) => deploySteps.has(s));
    if (steps.length === 0) {
      setError('Pick at least one step to run.');
      return;
    }
    // Resolve the deploy URL the same way testConnection does. --local
    // points at the medic docker default; --instance expands to the
    // dev.medicmobile.org convention; --url passes through.
    let url: string;
    if (config.target === 'local') url = 'https://localhost:5988';
    else if (config.target === 'instance' && config.instance) {
      url = `https://${config.instance}.dev.medicmobile.org`;
    } else if (config.target === 'url' && config.url) url = config.url;
    else {
      setError('Deploy target is not configured.');
      return;
    }
    if (!config.user) {
      setError('Enter a user in the deploy target form above.');
      return;
    }
    if (!password) {
      setError('Enter the deploy password first.');
      return;
    }
    setDeployRunning(true);
    setDeployProgress(steps.map((s) => ({ step: s, status: 'pending' })));
    // One-click means "just push my config". cht-conf's upload actions abort
    // with an interactive overwrite prompt (which has no TTY here → the step
    // dies) whenever a doc on the instance was last touched outside cht-conf.
    // `--force` skips that confirmation so the one-gesture deploy actually
    // completes. The granular per-action deploy below stays non-forced.
    const FORCE_STEPS = new Set([
      'upload-app-forms',
      'upload-contact-forms',
      'upload-app-settings',
      'upload-resources',
      // Same reason as the others: the action calls cht-conf's
      // `warnUploadOverwrite`, which prompts interactively when the
      // instance's `messages-<locale>` doc was last touched outside
      // cht-conf. With no TTY the step would die, so one-click forces.
      'upload-custom-translations',
    ]);
    const extraArgs: Record<string, string[]> = {};
    for (const s of steps) if (FORCE_STEPS.has(s)) extraArgs[s] = ['--force'];
    try {
      for await (const evt of api.deployRun({
        url,
        user: config.user,
        password,
        steps,
        extraArgs,
      })) {
        const kind = evt['event'];
        if (kind === 'step-start') {
          const step = String(evt['step']);
          setDeployProgress((prev) =>
            prev.map((s) => (s.step === step ? { ...s, status: 'running' } : s)),
          );
        } else if (kind === 'step-success') {
          const step = String(evt['step']);
          setDeployProgress((prev) =>
            prev.map((s) => (s.step === step ? { ...s, status: 'success' } : s)),
          );
        } else if (kind === 'step-error') {
          const step = String(evt['step']);
          const stderr = typeof evt['stderr'] === 'string' ? (evt['stderr'] as string) : '';
          const translated = evt['translated'] as FriendlyHint | undefined;
          setDeployProgress((prev) =>
            prev.map((s) =>
              s.step === step
                ? {
                    ...s,
                    status: 'fail',
                    stderrExcerpt: excerptStderr(stderr),
                    translated,
                  }
                : s,
            ),
          );
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeployRunning(false);
    }
  }

  async function runAction(action: Action) {
    setError(null);
    if (action.dangerous) {
      const ok = window.confirm(
        `"${action.label}" is destructive and will affect the configured CHT instance.\n\nContinue?`,
      );
      if (!ok) return;
    }
    // Form-scoped actions (convert-app-forms, upload-app-forms,
    // upload-contact-forms) open the picker first; default-all preserves
    // today's whole-config behaviour, and "Select changed" narrows it.
    if (action.name in FORM_SCOPED_ACTIONS) {
      // Refresh git changes whenever the picker opens — the working tree may
      // have advanced since the panel mounted.
      void api.getChangedForms().then((r) => {
        setHasGit(r.git);
        setChangedFormIds(new Set(r.changed.map((c) => c.formId)));
      });
      setPickerAction(action);
      return;
    }
    if (action.requiresInstance && !password) {
      setPendingAction(action);
      return;
    }
    await launch(action, password);
  }

  /**
   * Resume launching after the form picker confirms. Splits in two paths
   * because requiresInstance actions still need the password gate, and we
   * have to forward `extraArgs` through that gate too.
   */
  function launchFromPicker(action: Action, basenames: string[]) {
    setPickerAction(null);
    const extraArgs = basenames.length > 0 ? ['--', ...basenames] : undefined;
    if (action.requiresInstance && !password) {
      setPendingAction(action);
      setPickerExtraArgsForPending(extraArgs ?? null);
      return;
    }
    void launch(action, password, extraArgs);
  }

  async function runMacro(macro: DeployMacroSpec) {
    setError(null);
    const needsPassword = macro.actions.some(
      (a) => actions.find((x) => x.name === a)?.requiresInstance,
    );
    if (needsPassword && !password) {
      setError(`"${macro.label}" needs a password — enter one above first.`);
      return;
    }
    // Extra confirm for the broadest deploy — it touches forms AND settings
    // on the live instance. Forms-only and settings-only macros don't
    // double-confirm; this is just for "Deploy everything".
    if (macro.id === 'deploy-everything') {
      const ok = window.confirm(
        `"${macro.label}" will upload app forms AND app settings to the configured CHT instance. Continue?`,
      );
      if (!ok) return;
    }
    setLines([]);
    setHints([]);
    setExitCode(null);
    setRunning(true);
    try {
      const res = await api.runChtConfSequence(macro.actions, needsPassword ? password : undefined, dryRun);
      setRunId(res.runId);
      streamRun(res.runId);
    } catch (e) {
      setError((e as Error).message);
      setRunning(false);
    }
  }

  async function launch(action: Action, pw: string, extraArgs?: string[]) {
    setError(null);
    setLines([]);
    setHints([]);
    setExitCode(null);
    setRunning(true);
    try {
      const res = await api.runChtConfAction(
        action.name,
        action.requiresInstance ? pw : undefined,
        extraArgs,
        dryRun,
      );
      setRunId(res.runId);
      streamRun(res.runId);
    } catch (e) {
      setError((e as Error).message);
      setRunning(false);
    }
  }

  function streamRun(id: string) {
    eventSourceRef.current?.close();
    const es = new EventSource(`/api/cht-conf/runs/${encodeURIComponent(id)}/stream`);
    eventSourceRef.current = es;
    es.addEventListener('line', (e) => {
      const { line } = JSON.parse((e as MessageEvent).data) as { line: string };
      setLines((prev) => [...prev, line]);
    });
    es.addEventListener('hint', (e) => {
      const hint = JSON.parse((e as MessageEvent).data) as FriendlyHint;
      setHints((prev) => [...prev, hint]);
    });
    es.addEventListener('done', (e) => {
      const { exitCode: code } = JSON.parse((e as MessageEvent).data) as { exitCode: number | null };
      setRunning(false);
      setExitCode(code);
      es.close();
    });
    es.onerror = () => {
      es.close();
      setRunning(false);
    };
  }

  async function cancelRun() {
    if (!runId) return;
    try {
      await api.cancelChtConfRun(runId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const grouped = new Map<Category, Action[]>();
  for (const a of actions) {
    if (!grouped.has(a.category)) grouped.set(a.category, []);
    grouped.get(a.category)!.push(a);
  }

  return (
    <div className="deploy-panel">
      <header className="page-header">
        <h1>Deploy</h1>
        <div className="row gap">
          <span className="muted small">
            cht-conf {chtConfVersion ?? '?'}{' '}
            {!binaryAvailable && <span className="badge warn">binary missing</span>}
          </span>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {/* Tier 0 — preflight validator ("Ready to deploy?"). Runs cht-conf's
          hard gates BEFORE cht-conf, so a non-coder never sees a raw
          pyxform trace. onFix routes each fix descriptor to the correct
          editor; the actual mutation happens there (per-fix commentary in
          handlePreflightFix). See docs/plans/preflight-validator.md. */}
      <PreflightPanel ctx={preflightCtx} onFix={handlePreflightFix} />

      <DeployTargetForm
        config={config}
        password={password}
        onChangePassword={setPassword}
        onChangeConfig={saveConfig}
        onTestConnection={() => void runTestConnection()}
        testingConnection={testingConnection}
        connectionResult={connectionResult}
      />

      {/* Onboarding §5 — deploy-readiness checklist. Non-blocking; the
          deploy buttons stay enabled regardless. The point is to flag
          the silent-failure mode (hierarchy empty / contact form missing
          for a defined type / no app forms shipped) BEFORE the author
          pushes to the instance. The checklist + the user's "I see it,
          deploy anyway" is the gate. */}
      <DeployReadinessChecklist allForms={allForms} hasGit={hasGit} />

      <DeployMacros
        running={running}
        password={password}
        binaryAvailable={binaryAvailable}
        onRun={(macro) => void runMacro(macro)}
      />

      {/* Tier 0 — one-click owned deploy pipeline (POST /api/deploy/run).
          Additive: the per-step buttons and per-macro buttons still work.
          Gated on preflight-error count === 0; "Deploy anyway" is the
          escape hatch for power users who know what they're doing. */}
      <OneClickDeployBar
        binaryAvailable={binaryAvailable}
        running={deployRunning}
        preflightErrorCount={preflightErrorCount}
        overridePreflight={overridePreflight}
        onToggleOverride={() => setOverridePreflight((v) => !v)}
        steps={DEFAULT_DEPLOY_STEPS}
        selectedSteps={deploySteps}
        onToggleStep={(step) =>
          setDeploySteps((prev) => {
            const next = new Set(prev);
            if (next.has(step)) next.delete(step);
            else next.add(step);
            return next;
          })
        }
        progress={deployProgress}
        onRun={() => void runOneClickDeploy()}
      />

      <div className="card" style={{ padding: '10px 14px' }}>
        <label className="row gap" style={{ alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          <strong>Dry-run mode</strong>
          <span className="muted small">
            replay scripted output, do not contact cht-conf or the instance — useful to rehearse a deploy or to demo the tool
          </span>
        </label>
      </div>

      {pendingAction && (
        <div className="card">
          <p>
            <strong>Enter password</strong> for <code>{config?.user ?? '(no user)'}</code> to run{' '}
            <code>{pendingAction.name}</code>
            {pickerExtraArgsForPending && pickerExtraArgsForPending.length > 1 && (
              <>
                {' '}on{' '}
                <code>{pickerExtraArgsForPending.slice(1).join(' ')}</code>
              </>
            )}
            .
          </p>
          <div className="row gap">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && password) {
                  void launch(pendingAction, password, pickerExtraArgsForPending ?? undefined);
                  setPendingAction(null);
                  setPickerExtraArgsForPending(null);
                }
              }}
            />
            <button
              onClick={() => {
                void launch(pendingAction, password, pickerExtraArgsForPending ?? undefined);
                setPendingAction(null);
                setPickerExtraArgsForPending(null);
              }}
              disabled={!password}
            >
              Run
            </button>
            <button
              className="link"
              onClick={() => {
                setPendingAction(null);
                setPickerExtraArgsForPending(null);
              }}
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {pickerAction && (
        <DeployFormPicker
          action={pickerAction}
          category={FORM_SCOPED_ACTIONS[pickerAction.name]!}
          allForms={allForms}
          changedFormIds={changedFormIds}
          hasGit={hasGit}
          config={config}
          onConfirm={(basenames) => launchFromPicker(pickerAction, basenames)}
          onCancel={() => setPickerAction(null)}
        />
      )}

      <div className="deploy-grid">
        {CATEGORY_ORDER.filter((c) => (grouped.get(c)?.length ?? 0) > 0).map((cat) => (
          <section
            key={cat}
            className={`deploy-category ${cat === 'danger' ? 'is-danger' : ''}`}
          >
            <h3>{CATEGORY_LABELS[cat]}</h3>
            <p className="muted small">{CATEGORY_HINTS[cat]}</p>
            <div className="deploy-actions">
              {(grouped.get(cat) ?? []).map((a) => (
                <button
                  key={a.name}
                  className={`action-btn ${a.dangerous ? 'danger' : ''}`}
                  onClick={() => void runAction(a)}
                  disabled={running}
                  title={a.name}
                >
                  <span className="action-label">{a.label}</span>
                  <code className="action-code">{a.name}</code>
                  {a.requiresInstance && <span className="badge small">needs instance</span>}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      <section className="deploy-log">
        <div className="row gap log-toolbar">
          <h3>Log</h3>
          {running && (
            <button className="link danger" onClick={() => void cancelRun()}>
              Cancel run
            </button>
          )}
          {!running && exitCode !== null && (
            <span className={`badge ${exitCode === 0 ? '' : 'warn'}`}>
              Exit code: {exitCode}
            </span>
          )}
          {lines.length > 0 && (
            <button className="link" onClick={() => { setLines([]); setHints([]); }} disabled={running}>
              clear
            </button>
          )}
        </div>

        {hints.length > 0 && (
          <div className="deploy-hints">
            {hints.map((h, i) => (
              <div
                key={`${h.patternId}-${i}`}
                className={`deploy-hint${h.knownUpstreamBug ? ' known-bug' : ''}`}
              >
                <div className="deploy-hint-head">
                  <strong>{h.friendly}</strong>
                  {h.knownUpstreamBug && (
                    <span
                      className="badge small"
                      title="This is a known cht-conf upstream bug — not caused by your project files."
                    >
                      upstream — tracked
                    </span>
                  )}
                </div>
                {h.hint && <p className="deploy-hint-body">{h.hint}</p>}
                {h.docsUrl && (
                  <p className="deploy-hint-link">
                    <a href={h.docsUrl} target="_blank" rel="noreferrer">
                      open docs / upstream issue ↗
                    </a>
                  </p>
                )}
                <details className="deploy-hint-raw">
                  <summary>raw output that triggered this</summary>
                  <code>{h.rawLine}</code>
                </details>
              </div>
            ))}
          </div>
        )}
        <pre className="log-view">
          {lines.length === 0 ? (
            <span className="muted">No output yet. Click an action above to run it.</span>
          ) : (
            lines.join('\n')
          )}
          <div ref={logEndRef} />
        </pre>
      </section>
    </div>
  );
}

function DeployTargetForm(props: {
  config: DeployConfig | null;
  password: string;
  onChangePassword: (v: string) => void;
  onChangeConfig: (c: DeployConfig) => void;
  onTestConnection: () => void;
  testingConnection: boolean;
  connectionResult: null | {
    ok: boolean;
    status?: number;
    version?: string;
    couchVersion?: string;
    authenticatedAs?: string;
    error?: string;
    redactedUrl: string;
    at: number;
  };
}) {
  const { config } = props;
  if (!config) return <p className="muted">Loading deploy config…</p>;

  return (
    <section className="deploy-target card">
      <h3>Deploy target</h3>
      <div className="row gap">
        <label>
          <input
            type="radio"
            name="target"
            checked={config.target === 'local'}
            onChange={() => props.onChangeConfig({ ...config, target: 'local' })}
          />
          <strong>--local</strong> (localhost:5985)
        </label>
        <label>
          <input
            type="radio"
            name="target"
            checked={config.target === 'instance'}
            onChange={() => props.onChangeConfig({ ...config, target: 'instance' })}
          />
          <strong>--instance</strong>
          <input
            value={config.instance ?? ''}
            onChange={(e) => props.onChangeConfig({ ...config, instance: e.target.value })}
            placeholder="e.g. demo (→ demo.dev.medicmobile.org)"
            disabled={config.target !== 'instance'}
          />
        </label>
        <label>
          <input
            type="radio"
            name="target"
            checked={config.target === 'url'}
            onChange={() => props.onChangeConfig({ ...config, target: 'url' })}
          />
          <strong>--url</strong>
          <input
            value={config.url ?? ''}
            onChange={(e) => props.onChangeConfig({ ...config, url: e.target.value })}
            placeholder="https://your-instance.medicmobile.org"
            disabled={config.target !== 'url'}
            style={{ minWidth: 280 }}
          />
        </label>
      </div>
      <div className="row gap">
        <label>
          <span>User</span>
          <input
            value={config.user ?? ''}
            onChange={(e) => props.onChangeConfig({ ...config, user: e.target.value })}
            placeholder="medic"
          />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            value={props.password}
            onChange={(e) => props.onChangePassword(e.target.value)}
            placeholder="never stored — typed each session"
          />
        </label>
      </div>
      <div className="row gap">
        <button
          onClick={props.onTestConnection}
          className="secondary"
          disabled={props.testingConnection}
        >
          {props.testingConnection ? 'Testing…' : '🔌 Test connection'}
        </button>
        <span className="muted small">
          Hits <code>&lt;target&gt;/api/info</code> directly with your user + password
          — no cht-conf, no version gate.
        </span>
      </div>
      {props.connectionResult && (
        <div
          className={`deploy-test-result ${props.connectionResult.ok ? 'ok' : 'fail'}`}
          role="status"
        >
          {props.connectionResult.ok ? (
            <>
              <strong>✓ Connection OK.</strong>{' '}
              {props.connectionResult.authenticatedAs && (
                <>
                  Authenticated as{' '}
                  <code>{props.connectionResult.authenticatedAs}</code>.{' '}
                </>
              )}
              {props.connectionResult.version && (
                <>
                  CHT <code>{props.connectionResult.version}</code>
                  {props.connectionResult.couchVersion && (
                    <>
                      {' '}
                      / CouchDB <code>{props.connectionResult.couchVersion}</code>
                    </>
                  )}
                  .
                </>
              )}
            </>
          ) : (
            <>
              <strong>✗ Could not connect.</strong> {props.connectionResult.error}
            </>
          )}
          {props.connectionResult.redactedUrl && (
            <div className="muted small">
              probed <code>{props.connectionResult.redactedUrl}</code>
            </div>
          )}
        </div>
      )}
      <p className="muted small">
        Password is held in memory only, not saved to disk. Target + user persist in
        <code> ~/.cht-ui-builder/state.json</code>.
        Need a local CHT to test against? See{' '}
        <a
          href="https://docs.communityhealthtoolkit.org/contribute/code/dev-environment/"
          target="_blank"
          rel="noreferrer"
        >
          Run a local CHT
        </a>
        {' '}— Docker image starts on{' '}
        <code>localhost:5988</code> and the <code>--local</code> radio points at it.
      </p>
    </section>
  );
}

/* -------------------- Deploy macros (chained runs) -------------------- */

interface DeployMacroSpec {
  id: string;
  label: string;
  description: string;
  /** Ordered cht-conf action names to run. */
  actions: string[];
  /** Marks macros that touch the CHT instance. */
  needsInstance: boolean;
}

const DEPLOY_MACROS: DeployMacroSpec[] = [
  {
    id: 'deploy-forms',
    label: 'Deploy app forms',
    description: 'validate → convert → upload',
    actions: ['validate-app-forms', 'convert-app-forms', 'upload-app-forms'],
    needsInstance: true,
  },
  {
    id: 'deploy-contact-forms',
    label: 'Deploy contact forms',
    description: 'validate → convert → upload (the place/person create+edit forms)',
    actions: [
      'validate-contact-forms',
      'convert-contact-forms',
      'upload-contact-forms',
    ],
    needsInstance: true,
  },
  {
    id: 'deploy-settings',
    label: 'Deploy app settings',
    description: 'compile → upload',
    actions: ['compile-app-settings', 'upload-app-settings'],
    needsInstance: true,
  },
  {
    id: 'deploy-everything',
    label: 'Deploy everything',
    description: 'validate → compile → convert (app + contact) → upload (app + contact) → upload settings',
    actions: [
      // App forms first — the "Available on X" context refers to the app form.
      'validate-app-forms',
      'compile-app-settings',
      'convert-app-forms',
      'upload-app-forms',
      // Contact forms — without these, every contact_type's create_form
      // promise in base_settings.json points at a non-existent form doc
      // on the instance (silent breakage: the instance accepts the
      // app_settings but can't actually OPEN any contact-creation form).
      'validate-contact-forms',
      'convert-contact-forms',
      'upload-contact-forms',
      // Settings last so the hierarchy / contact_types references resolve
      // to real form docs at lookup time.
      'upload-app-settings',
    ],
    needsInstance: true,
  },
  {
    id: 'validate-only',
    label: 'Validate everything (no upload)',
    description: 'validate → compile → convert (app + contact) — safe rehearsal',
    actions: [
      'validate-app-forms',
      'compile-app-settings',
      'convert-app-forms',
      'validate-contact-forms',
      'convert-contact-forms',
    ],
    needsInstance: false,
  },
];

/**
 * Pre-built macros that chain the most common cht-conf sequences. The
 * individual-button grid below still exists for power users; this is the
 * "what most people actually need" shortcut layer.
 */
function DeployMacros(props: {
  running: boolean;
  password: string;
  binaryAvailable: boolean;
  onRun: (macro: DeployMacroSpec) => void;
}) {
  return (
    <section className="deploy-macros card">
      <h3>Common deploys</h3>
      <p className="muted small">
        One click runs a sequence of cht-conf actions in order, streaming everything to the log.
        Stops on the first failure.
      </p>
      <div className="deploy-macros-grid">
        {DEPLOY_MACROS.map((m) => {
          const missingPassword = m.needsInstance && !props.password;
          const disabled = props.running || !props.binaryAvailable || missingPassword;
          return (
            <button
              key={m.id}
              className="deploy-macro-btn"
              onClick={() => props.onRun(m)}
              disabled={disabled}
              title={missingPassword ? 'Enter the password above first' : m.actions.join(' → ')}
            >
              <span className="deploy-macro-label">{m.label}</span>
              <span className="deploy-macro-desc">{m.description}</span>
              <span className="deploy-macro-steps">
                {m.actions.map((a, i) => (
                  <span key={a} className="deploy-macro-step">
                    {i > 0 && <span className="muted"> → </span>}
                    <code>{a}</code>
                  </span>
                ))}
              </span>
              {missingPassword && (
                <span className="muted small" style={{ color: '#b45309' }}>
                  ⚠ enter password above first
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------- Targeted-form picker ------------------------- */

/**
 * Build the cht-conf `--target ...` prefix the way the server's buildArgs
 * does, but redacted for display: passwords appear as `***`. Kept in sync
 * with [server/src/routes/cht-conf.ts:buildArgs] — the goal is "the user can
 * read this line and predict what the server will spawn." See
 * docs/plans/deploy-targeted-forms.md §2: command-preview honesty matters
 * for non-technical owners who decide whether to click Run.
 */
function previewTargetPrefix(config: DeployConfig | null): string {
  if (!config) return '';
  if (config.target === 'local') return '--local';
  if (config.target === 'instance' && config.instance) {
    const userFlag = config.user ? ` --user=${config.user}` : '';
    return `--instance=${config.instance}${userFlag}`;
  }
  if (config.target === 'url' && config.url) {
    try {
      // eslint-disable-next-line no-undef
      const u = new URL(config.url);
      const userinfo = config.user ? `${encodeURIComponent(config.user)}:***@` : '';
      return `--url=${u.protocol}//${userinfo}${u.host}${u.pathname}${u.search}`;
    } catch {
      return `--url=${config.url}`;
    }
  }
  return '';
}

/**
 * Modal-ish checklist for targeted form deploys. Default = every form in the
 * action's category checked (preserves today's whole-config behaviour); the
 * "Select changed (N)" button narrows it to working-tree changes from
 * `git status`. The command preview at the bottom mirrors exactly what the
 * server will spawn (with the password redacted).
 *
 * Out of scope here: chaining convert→upload as one click. The plan defers
 * that to a sequence-endpoint follow-up (see §4); MVP = two clicks of the
 * picker against the two actions.
 */
function DeployFormPicker(props: {
  action: Action;
  category: 'app' | 'contact';
  allForms: FormListItem[];
  changedFormIds: Set<string>;
  hasGit: boolean;
  config: DeployConfig | null;
  onConfirm: (basenames: string[]) => void;
  onCancel: () => void;
}) {
  const eligible = props.allForms.filter((f) => f.category === props.category);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(eligible.map((f) => f.basename)),
  );

  const changedInCategory = eligible.filter((f) => props.changedFormIds.has(f.formId));
  const noneSelected = selected.size === 0;
  const allSelected = selected.size === eligible.length && eligible.length > 0;

  function toggle(basename: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(basename)) next.delete(basename);
      else next.add(basename);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(eligible.map((f) => f.basename)));
  }
  function selectNone() {
    setSelected(new Set());
  }
  function selectChanged() {
    setSelected(new Set(changedInCategory.map((f) => f.basename)));
  }

  // Command preview — the server's buildArgs will append `-- <names>` after
  // the action when extraArgs is non-empty. If the user un-selects everything,
  // the cht-conf default (all forms) kicks in — surface that explicitly so
  // they aren't surprised by a blank checklist running the whole category.
  const targetPrefix = previewTargetPrefix(props.config);
  const selectedBasenames = eligible
    .filter((f) => selected.has(f.basename))
    .map((f) => f.basename);
  const cmd = noneSelected || allSelected
    ? `cht ${targetPrefix} ${props.action.name}`.trim()
    : `cht ${targetPrefix} ${props.action.name} -- ${selectedBasenames.join(' ')}`.trim();

  return (
    <div className="card">
      <div className="row gap" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>
          {props.action.label} — pick forms
        </h3>
        <button className="link" onClick={props.onCancel}>cancel</button>
      </div>
      <p className="muted small">
        Default is every {props.category} form — leave as-is to deploy the whole category
        (same as before). Narrow it to deploy only the forms you changed.
      </p>

      <div className="row gap" style={{ flexWrap: 'wrap' }}>
        <button className="link" onClick={selectAll} disabled={allSelected}>
          select all
        </button>
        <button className="link" onClick={selectNone} disabled={noneSelected}>
          deselect all
        </button>
        {props.hasGit && (
          <button
            className="link"
            onClick={selectChanged}
            disabled={changedInCategory.length === 0}
            title={
              changedInCategory.length === 0
                ? 'No working-tree changes in this category'
                : `Check exactly the ${changedInCategory.length} changed ${props.category} form(s)`
            }
          >
            Select changed ({changedInCategory.length})
          </button>
        )}
      </div>

      {eligible.length === 0 ? (
        <p className="muted">No {props.category} forms found in this project.</p>
      ) : (
        <ul className="deploy-form-picker">
          {eligible.map((f) => {
            const isChanged = props.changedFormIds.has(f.formId);
            return (
              <li key={f.formId}>
                <label className="row gap" style={{ alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selected.has(f.basename)}
                    onChange={() => toggle(f.basename)}
                  />
                  <code>{f.basename}</code>
                  {isChanged && <span className="badge small">changed</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className="deploy-cmd-preview">
        <div className="muted small">Command preview:</div>
        <pre><code>{cmd}</code></pre>
        {noneSelected && eligible.length > 0 && (
          <p className="muted small">
            Nothing selected — cht-conf will deploy <strong>all {props.category} forms</strong>{' '}
            (default behaviour when no <code>--</code> args are passed).
          </p>
        )}
      </div>

      <div className="row gap">
        <button
          onClick={() => props.onConfirm(noneSelected || allSelected ? [] : selectedBasenames)}
          disabled={eligible.length === 0}
        >
          {noneSelected || allSelected
            ? `Run ${props.action.name} (all)`
            : `Run on ${selectedBasenames.length} form${selectedBasenames.length === 1 ? '' : 's'}`}
        </button>
        <button className="link" onClick={props.onCancel}>cancel</button>
      </div>
    </div>
  );
}

/* --------------------- Deploy-readiness checklist --------------------- */

/**
 * Onboarding §5 — pre-deploy readiness checklist. NON-BLOCKING by design:
 * CHT will run on the legacy default hierarchy if `contact_types` is
 * empty, and a missing contact form / app form / task isn't a deploy
 * error — it's a silent runtime drift. The checklist surfaces these
 * before the author pushes, so they're seen-and-acknowledged rather
 * than discovered in field.
 *
 * Checks (each cheap; we fetch hierarchy once on mount):
 *   1. Hierarchy: ≥1 contact_type defined.
 *   2. Contact form per place type: every non-person type has a
 *      `<type>-create.xlsx`. (`-edit` is optional in v1.)
 *   3. ≥1 app form exists.
 *   4. `tasks.js` present.
 *
 * Deeper checks (do app-form `select-contact type-X` references
 * resolve to defined types?) are deferred — they'd need a survey
 * scan per form, which is too much for the checklist phase.
 */
function DeployReadinessChecklist(props: {
  allForms: FormListItem[];
  hasGit: boolean;
}) {
  const project = useApp((s) => s.project);
  type ContactTypeRow = { id: string; person?: boolean };
  const [contactTypes, setContactTypes] = useState<ContactTypeRow[] | null>(null);
  const [hierarchyError, setHierarchyError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .getHierarchy()
      .then((h) => {
        if (!alive) return;
        setContactTypes(h.contact_types as unknown as ContactTypeRow[]);
      })
      .catch((e: Error) => {
        if (alive) setHierarchyError(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!project) return null;

  const hierarchyKnown = contactTypes !== null;
  const placeTypes = (contactTypes ?? []).filter((t) => !t.person);
  const contactFormBasenames = new Set(
    props.allForms
      .filter((f) => f.category === 'contact')
      .map((f) => f.basename.toLowerCase()),
  );
  const missingCreateForms = placeTypes.filter(
    (t) => !contactFormBasenames.has(`${t.id.toLowerCase()}-create`),
  );

  type CheckState = 'pass' | 'fail' | 'unknown' | 'info';
  interface Check {
    label: string;
    state: CheckState;
    detail?: string;
  }

  const checks: Check[] = [
    {
      label: 'Hierarchy defined (≥1 contact type)',
      state: hierarchyError
        ? 'unknown'
        : !hierarchyKnown
          ? 'unknown'
          : (contactTypes ?? []).length > 0
            ? 'pass'
            : 'fail',
      detail: hierarchyError
        ? hierarchyError
        : !hierarchyKnown
          ? 'loading…'
          : (contactTypes ?? []).length === 0
            ? 'CHT will fall back to the legacy default hierarchy. Forms referencing undefined types fail silently at runtime.'
            : `${(contactTypes ?? []).length} types defined.`,
    },
    {
      label: 'Contact create-form per place type',
      state: !hierarchyKnown
        ? 'unknown'
        : placeTypes.length === 0
          ? 'info'
          : missingCreateForms.length === 0
            ? 'pass'
            : 'fail',
      detail: !hierarchyKnown
        ? 'loading…'
        : placeTypes.length === 0
          ? 'No place types yet — add them in Hierarchy.'
          : missingCreateForms.length === 0
            ? `${placeTypes.length} place types, all have a create form.`
            : `Missing: ${missingCreateForms.map((t) => `${t.id}-create.xlsx`).join(', ')}.`,
    },
    {
      label: 'App forms exist',
      state: project.hasAppForms ? 'pass' : 'info',
      detail: project.hasAppForms
        ? `${props.allForms.filter((f) => f.category === 'app').length} app forms.`
        : 'No app forms yet — the user-facing reports/visits live here.',
    },
    {
      label: 'tasks.js present',
      state: project.hasTasks ? 'pass' : 'info',
      detail: project.hasTasks
        ? 'tasks.js is defined.'
        : 'No tasks defined — tasks.js controls follow-up reminders + workflows.',
    },
    {
      label: 'Git project (for "Select changed" + deploy traceability)',
      state: props.hasGit ? 'pass' : 'info',
      detail: props.hasGit
        ? 'Working tree is a git repo — targeted deploys can use changed-only.'
        : 'Not a git repo — Select-changed is unavailable.',
    },
  ];

  const fails = checks.filter((c) => c.state === 'fail').length;
  const passes = checks.filter((c) => c.state === 'pass').length;
  const totalGated = checks.filter((c) => c.state === 'pass' || c.state === 'fail').length;

  return (
    <section className="card deploy-readiness">
      <header className="row gap" style={{ alignItems: 'baseline' }}>
        <strong>Deploy-readiness checklist</strong>
        <span className="muted small">
          {passes}/{totalGated} passing{fails > 0 ? `, ${fails} need attention` : ''} —
          non-blocking; deploy buttons stay enabled.
        </span>
      </header>
      <ul className="deploy-readiness-list">
        {checks.map((c, i) => (
          <li key={i} className={`deploy-readiness-row state-${c.state}`}>
            <span className="deploy-readiness-glyph" aria-hidden="true">
              {c.state === 'pass' ? '✓' : c.state === 'fail' ? '✗' : c.state === 'unknown' ? '…' : 'ⓘ'}
            </span>
            <span className="deploy-readiness-label">{c.label}</span>
            {c.detail && <span className="muted small">— {c.detail}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ----------------------- One-click deploy pipeline ----------------------- */

/**
 * Tier 0 owned-deploy pipeline bar. One button runs the full sequence
 * (compile → convert → upload) through POST /api/deploy/run and streams
 * per-step progress inline. Gated on preflight errors === 0, with a
 * "Deploy anyway" escape link for power users.
 *
 * Kept as an additive layer over the existing per-step and per-macro
 * buttons — none of the older paths are replaced.
 */
function OneClickDeployBar(props: {
  binaryAvailable: boolean;
  running: boolean;
  preflightErrorCount: number;
  overridePreflight: boolean;
  onToggleOverride: () => void;
  steps: readonly string[];
  selectedSteps: Set<string>;
  onToggleStep: (step: string) => void;
  progress: DeployRunStep[];
  onRun: () => void;
}) {
  const preflightBlocked = props.preflightErrorCount > 0 && !props.overridePreflight;
  const disabled = props.running || !props.binaryAvailable || preflightBlocked;

  const glyph: Record<DeployRunStep['status'], string> = {
    pending: '◌',
    running: '▶',
    success: '✓',
    fail: '✕',
  };

  return (
    <section className="card deploy-oneclick">
      <header className="row gap" style={{ alignItems: 'baseline' }}>
        <strong>One-click deploy</strong>
        <span className="muted small">
          runs the owned pipeline (compile → convert → upload) as a single
          streamed request — no runId to track
        </span>
      </header>
      <div className="row gap" style={{ flexWrap: 'wrap' }}>
        {props.steps.map((s) => (
          <label
            key={s}
            className="row gap"
            style={{ alignItems: 'center', cursor: 'pointer', fontSize: 13 }}
          >
            <input
              type="checkbox"
              checked={props.selectedSteps.has(s)}
              onChange={() => props.onToggleStep(s)}
              disabled={props.running}
            />
            <code>{s}</code>
          </label>
        ))}
      </div>
      <div className="row gap" style={{ alignItems: 'center' }}>
        <button
          onClick={props.onRun}
          disabled={disabled}
          title={
            preflightBlocked
              ? `${props.preflightErrorCount} preflight error(s) — fix them or click "Deploy anyway"`
              : 'Run the owned deploy pipeline'
          }
        >
          {props.running ? 'Deploying…' : 'Deploy'}
        </button>
        {preflightBlocked && (
          <>
            <span className="muted small">
              {props.preflightErrorCount} preflight error(s) blocking —
            </span>
            <button
              type="button"
              className="link"
              onClick={props.onToggleOverride}
              disabled={props.running}
            >
              Deploy anyway
            </button>
          </>
        )}
        {props.preflightErrorCount > 0 && props.overridePreflight && (
          <span className="muted small">
            (override on — preflight errors ignored)
          </span>
        )}
      </div>
      {props.progress.length > 0 && (
        <ul className="deploy-oneclick-progress">
          {props.progress.map((s) => (
            <li key={s.step} className={`deploy-oneclick-step state-${s.status}`}>
              <span className="deploy-oneclick-glyph" aria-hidden="true">
                {glyph[s.status]}
              </span>
              <code className="deploy-oneclick-name">{s.step}</code>
              {s.status === 'fail' && s.translated && (
                <span className="deploy-oneclick-friendly">
                  <strong>{s.translated.friendly}</strong>
                  {s.translated.hint && <> — {s.translated.hint}</>}
                </span>
              )}
              {s.status === 'fail' && !s.translated && s.stderrExcerpt && (
                <span className="deploy-oneclick-stderr">{s.stderrExcerpt}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
