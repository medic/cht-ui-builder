/**
 * cht-conf integration: catalog of supported actions, spawn the bundled
 * `cht` binary against the currently-open project, stream stdout/stderr
 * back to the client via SSE.
 *
 * cht-conf has no programmatic Node API for its CLI actions, so we spawn
 * the binary. cht-conf is bundled as a server dep so we don't depend on
 * what's installed in the project folder.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { projectRootOrNull, getDeployConfig, setDeployConfig, type DeployConfig } from '../state.js';
import { matchErrorPattern } from '../cht-conf/errorPatterns.js';
import { isDryRunEnabled, runDryRun } from '../cht-conf/dryRun.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ActionMeta {
  name: string;
  category: 'validate' | 'compile' | 'convert' | 'compress' | 'backup' | 'upload' | 'danger' | 'utility';
  /** True if the action talks to a CHT instance (needs deploy target + auth). */
  requiresInstance: boolean;
  /** True if the action is potentially destructive — needs an extra confirm. */
  dangerous: boolean;
  /** Short human label for the UI. */
  label: string;
}

/**
 * Curated metadata for every action shipped by cht-conf v3.18.x. The
 * catalog is hand-written rather than auto-discovered so we can tag
 * category + safety. Unknown actions added by future cht-conf versions
 * are surfaced under 'utility' by the route handler.
 */
const ACTION_CATALOG: ActionMeta[] = [
  // validate
  { name: 'validate-app-forms',      category: 'validate', requiresInstance: false, dangerous: false, label: 'Validate app forms' },
  { name: 'validate-contact-forms',  category: 'validate', requiresInstance: false, dangerous: false, label: 'Validate contact forms' },
  { name: 'validate-collect-forms',  category: 'validate', requiresInstance: false, dangerous: false, label: 'Validate Collect forms' },
  { name: 'validate-training-forms', category: 'validate', requiresInstance: false, dangerous: false, label: 'Validate training forms' },
  { name: 'check-for-updates',       category: 'validate', requiresInstance: true,  dangerous: false, label: 'Check cht-conf version' },
  { name: 'check-git',               category: 'validate', requiresInstance: false, dangerous: false, label: 'Check git status' },
  // compile
  { name: 'compile-app-settings',    category: 'compile', requiresInstance: false, dangerous: false, label: 'Compile app settings' },
  // convert
  { name: 'convert-app-forms',       category: 'convert', requiresInstance: false, dangerous: false, label: 'Convert app forms (xlsx → xml)' },
  { name: 'convert-contact-forms',   category: 'convert', requiresInstance: false, dangerous: false, label: 'Convert contact forms (xlsx → xml)' },
  { name: 'convert-collect-forms',   category: 'convert', requiresInstance: false, dangerous: false, label: 'Convert Collect forms' },
  { name: 'convert-training-forms',  category: 'convert', requiresInstance: false, dangerous: false, label: 'Convert training forms' },
  // compress
  { name: 'compress-images',         category: 'compress', requiresInstance: false, dangerous: false, label: 'Compress images' },
  { name: 'compress-pngs',           category: 'compress', requiresInstance: false, dangerous: false, label: 'Compress PNGs' },
  { name: 'compress-svgs',           category: 'compress', requiresInstance: false, dangerous: false, label: 'Compress SVGs' },
  // backup (reads from instance)
  { name: 'backup-app-settings',     category: 'backup', requiresInstance: true, dangerous: false, label: 'Backup app settings from instance' },
  { name: 'backup-all-forms',        category: 'backup', requiresInstance: true, dangerous: false, label: 'Backup all forms from instance' },
  // upload (writes to instance)
  { name: 'upload-app-settings',         category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload app settings' },
  { name: 'upload-app-forms',            category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload app forms' },
  { name: 'upload-contact-forms',        category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload contact forms' },
  { name: 'upload-collect-forms',        category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload Collect forms' },
  { name: 'upload-training-forms',       category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload training forms' },
  { name: 'upload-resources',            category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload resources (icons / images)' },
  { name: 'upload-branding',             category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload branding' },
  { name: 'upload-partners',             category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload partner logos' },
  { name: 'upload-custom-translations',  category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload custom translations' },
  { name: 'upload-privacy-policies',     category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload privacy policies' },
  { name: 'upload-extension-libs',       category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload extension libs' },
  { name: 'upload-docs',                 category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload generated docs' },
  { name: 'upload-sms-from-csv',         category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload SMS from CSV' },
  { name: 'upload-database-indexes',     category: 'upload', requiresInstance: true, dangerous: false, label: 'Upload database indexes' },
  // utility
  { name: 'csv-to-docs',             category: 'utility', requiresInstance: false, dangerous: false, label: 'Convert CSVs to docs' },
  { name: 'edit-contacts',           category: 'utility', requiresInstance: true,  dangerous: true,  label: 'Edit contacts (bulk)' },
  { name: 'move-contacts',           category: 'utility', requiresInstance: true,  dangerous: true,  label: 'Move contacts in hierarchy' },
  { name: 'merge-contacts',          category: 'utility', requiresInstance: true,  dangerous: true,  label: 'Merge contacts (lineage)' },
  { name: 'create-users',            category: 'utility', requiresInstance: true,  dangerous: true,  label: 'Create users' },
  // danger
  { name: 'delete-all-forms',        category: 'danger', requiresInstance: true, dangerous: true, label: 'Delete ALL forms from instance' },
  { name: 'delete-forms',            category: 'danger', requiresInstance: true, dangerous: true, label: 'Delete selected forms from instance' },
  { name: 'delete-contacts',         category: 'danger', requiresInstance: true, dangerous: true, label: 'Delete contacts (irreversible)' },
];

interface ErrorHint {
  patternId: string;
  friendly: string;
  hint?: string;
  docsUrl?: string;
  /** True for known upstream cht-conf bugs — UI badges these differently. */
  knownUpstreamBug?: boolean;
  /** The raw line that triggered the hint (for cross-reference). */
  rawLine: string;
}

type RunUpdate =
  | { kind: 'line'; line: string }
  | { kind: 'hint'; hint: ErrorHint }
  | { kind: 'done'; exitCode: number | null };

interface RunState {
  id: string;
  action: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  /** Buffered log lines, capped at MAX_LINES. */
  lines: string[];
  /** Buffered friendly hints, replayed on reconnect. */
  hints: ErrorHint[];
  /** Subscribers receiving SSE updates. */
  listeners: Set<(update: RunUpdate) => void>;
  child: ChildProcess | null;
}

const runs = new Map<string, RunState>();
const MAX_LINES = 5000;

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function chtBinary(): string {
  // The cht-conf binary is installed as a dep of this server workspace.
  // server/dist/routes/cht-conf.js → server/node_modules/.bin/cht.cmd
  const serverRoot = path.resolve(__dirname, '..', '..');
  const isWindows = os.platform() === 'win32';
  return path.join(serverRoot, 'node_modules', '.bin', isWindows ? 'cht.cmd' : 'cht');
}

/**
 * Build the URL with userinfo spliced in. cht-conf only honors `--user` when
 * paired with `--instance` (it throws "The --user switch must be accompanied
 * with --instance" in `get-api-url.js`). For `--url` mode it reads credentials
 * verbatim from the URL string, so we have to embed `user:password@`. We
 * `encodeURIComponent` both halves so shell metachars (`&`, `|`, `^`) survive
 * the Windows `shell: true` spawn, and cht-conf's `new URL(...)` decodes them
 * back to the originals.
 */
export function buildUrlWithCreds(
  rawUrl: string,
  user: string | undefined,
  password: string | undefined,
): { actual: string; redacted: string } {
  // eslint-disable-next-line no-undef
  const u = new URL(rawUrl);
  if (!user) {
    const s = u.toString();
    return { actual: s, redacted: s };
  }
  const encUser = encodeURIComponent(user);
  const encPwd = password ? encodeURIComponent(password) : '';
  const userinfoActual = encPwd ? `${encUser}:${encPwd}` : encUser;
  const userinfoRedacted = encPwd ? `${encUser}:***` : encUser;
  const tail = `${u.host}${u.pathname}${u.search}${u.hash}`;
  return {
    actual: `${u.protocol}//${userinfoActual}@${tail}`,
    redacted: `${u.protocol}//${userinfoRedacted}@${tail}`,
  };
}

function buildArgs(
  action: string,
  deploy: DeployConfig | null,
  password: string | undefined,
  extras: string[],
): { args: string[]; loggedArgs: string[] } {
  const args: string[] = [];
  const loggedArgs: string[] = [];
  // Deploy targeting flags only added when the action needs an instance.
  const meta = ACTION_CATALOG.find((a) => a.name === action);
  if (meta?.requiresInstance && deploy) {
    if (deploy.target === 'local') {
      args.push('--local');
      loggedArgs.push('--local');
    } else if (deploy.target === 'instance' && deploy.instance) {
      args.push(`--instance=${deploy.instance}`);
      loggedArgs.push(`--instance=${deploy.instance}`);
      // cht-conf accepts `--user=` only with `--instance` (then prompts for
      // the password, which we satisfy via stdin below).
      if (deploy.user) {
        args.push(`--user=${deploy.user}`);
        loggedArgs.push(`--user=${deploy.user}`);
      }
    } else if (deploy.target === 'url' && deploy.url) {
      const { actual, redacted } = buildUrlWithCreds(deploy.url, deploy.user, password);
      args.push(`--url=${actual}`);
      loggedArgs.push(`--url=${redacted}`);
    }
  }
  args.push(action);
  args.push(...extras);
  loggedArgs.push(action);
  loggedArgs.push(...extras);
  return { args, loggedArgs };
}

function pushLine(state: RunState, line: string): void {
  if (state.lines.length >= MAX_LINES) state.lines.shift();
  state.lines.push(line);
  for (const fn of state.listeners) fn({ kind: 'line', line });

  // Additive translation: never mutate or drop the raw line. If the line
  // matches a recognized pattern, also emit a hint event with the friendly
  // summary + optional workaround.
  const match = matchErrorPattern(line);
  if (match) {
    // De-duplicate hints across consecutive lines that match the same
    // pattern id — pyxform tracebacks are noisy and we don't want six
    // copies of the same friendly summary.
    const last = state.hints[state.hints.length - 1];
    if (!last || last.patternId !== match.pattern.id) {
      const hint: ErrorHint = {
        patternId: match.pattern.id,
        friendly: match.pattern.friendly(match.match),
        hint: match.pattern.hint?.(match.match),
        docsUrl: match.pattern.docsUrl,
        knownUpstreamBug: Boolean(match.pattern.knownUpstreamBug),
        rawLine: line,
      };
      state.hints.push(hint);
      for (const fn of state.listeners) fn({ kind: 'hint', hint });
    }
  }
}

function finishRun(state: RunState, exitCode: number | null): void {
  state.endedAt = Date.now();
  state.exitCode = exitCode;
  state.child = null;
  for (const fn of state.listeners) fn({ kind: 'done', exitCode });
  state.listeners.clear();
}

function attachStreams(state: RunState, child: ChildProcess): void {
  let stdoutBuf = '';
  let stderrBuf = '';
  const onChunk = (buf: Buffer, which: 'stdout' | 'stderr') => {
    const text = buf.toString('utf8');
    if (which === 'stdout') {
      stdoutBuf += text;
      let i;
      while ((i = stdoutBuf.indexOf('\n')) !== -1) {
        pushLine(state, stdoutBuf.slice(0, i));
        stdoutBuf = stdoutBuf.slice(i + 1);
      }
    } else {
      stderrBuf += text;
      let i;
      while ((i = stderrBuf.indexOf('\n')) !== -1) {
        pushLine(state, `[stderr] ${stderrBuf.slice(0, i)}`);
        stderrBuf = stderrBuf.slice(i + 1);
      }
    }
  };
  child.stdout?.on('data', (b: Buffer) => onChunk(b, 'stdout'));
  child.stderr?.on('data', (b: Buffer) => onChunk(b, 'stderr'));
  child.on('close', (code) => {
    if (stdoutBuf) pushLine(state, stdoutBuf);
    if (stderrBuf) pushLine(state, `[stderr] ${stderrBuf}`);
    finishRun(state, code);
  });
  child.on('error', (err) => {
    pushLine(state, `[error] ${err.message}`);
    finishRun(state, -1);
  });
}

/**
 * Direct connection probe — bypass cht-conf entirely. The UI's "Test
 * connection" button used to run `cht-conf check-for-updates`, but that
 * action's whole job is to fail when the local cht-conf binary is behind
 * the latest published version — every cht-conf release breaks the
 * editor's connection test, even when the instance itself is reachable.
 *
 * Probe targets (in order):
 *   1. `GET /_session` — CouchDB session endpoint, present on every
 *      CHT install (CHT runs on Couch). Returns 200 + `userCtx.name`
 *      matching our user on auth success; 401 on bad auth. This is
 *      the universal auth gate.
 *   2. `GET /api/deploy-info` — CHT-specific; returns the deployed
 *      CHT + Couch versions. Optional follow-up after _session
 *      succeeds; older CHT may 404 here and we still report success
 *      from the session check.
 *
 * Self-signed certs (the `*.local-ip.medicmobile.org` dev pattern)
 * are accepted — this is a connection test, not a TLS guarantee.
 */
interface ConnectionProbeResult {
  ok: boolean;
  status?: number;
  /** CHT version, if /api/deploy-info responded. Best-effort. */
  version?: string;
  /** Couch version, if /api/deploy-info responded. Best-effort. */
  couchVersion?: string;
  /** The username CouchDB reported back via /_session.userCtx.name —
   *  useful confirmation that auth actually applied (not just that the
   *  server replied 200 with `name: null` for an open Couch). */
  authenticatedAs?: string;
  /** Diagnostic message — populated on failure. */
  error?: string;
  /** The URL probed (base only), with the password replaced by `***`. */
  redactedUrl: string;
}

interface RawProbeResponse {
  status: number;
  body: string;
}

function httpRequest(
  targetPath: string,
  base: URL,
  auth: string | undefined,
): Promise<RawProbeResponse> {
  return new Promise<RawProbeResponse>((resolve, reject) => {
    const isHttps = base.protocol === 'https:';
    const opts: https.RequestOptions = {
      method: 'GET',
      hostname: base.hostname,
      port: base.port || (isHttps ? 443 : 80),
      path: targetPath,
      auth,
      headers: { Accept: 'application/json' },
      // Local CHT instances ship self-signed certs against host names
      // like `127-0-0-1.local-ip.medicmobile.org` — this is a connection
      // probe, not a TLS guarantee, so don't reject on cert mismatch.
      ...(isHttps ? { rejectUnauthorized: false } : {}),
    };
    const client = isHttps ? https : http;
    const req = client.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += String(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error('Request timed out after 10s'));
    });
    req.end();
  });
}

function probeConnection(
  targetUrl: string,
  user: string | undefined,
  password: string | undefined,
): Promise<ConnectionProbeResult> {
  let base: URL;
  try {
    base = new URL(targetUrl);
  } catch (e) {
    return Promise.resolve({
      ok: false,
      error: `Bad URL: ${(e as Error).message}`,
      redactedUrl: targetUrl,
    });
  }
  const auth = user ? `${user}:${password ?? ''}` : undefined;
  const redacted = (() => {
    const c = new URL(base.toString());
    if (user) c.username = encodeURIComponent(user);
    if (password) c.password = '***';
    return c.toString();
  })();

  return (async () => {
    // 1) The auth gate: /_session. Universal across CHT versions.
    let sessionRes: RawProbeResponse;
    try {
      sessionRes = await httpRequest('/_session', base, auth);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      return {
        ok: false,
        error: msg.includes('ENOTFOUND')
          ? 'Host not found — check the URL.'
          : msg.includes('ECONNREFUSED')
            ? 'Connection refused — is the instance running and reachable on this network?'
            : msg.includes('CERT_')
              ? `TLS certificate problem: ${msg}`
              : msg,
        redactedUrl: redacted,
      };
    }

    if (sessionRes.status === 401) {
      return {
        ok: false,
        status: 401,
        error: 'Authentication failed (HTTP 401). Check the user + password.',
        redactedUrl: redacted,
      };
    }
    if (sessionRes.status < 200 || sessionRes.status >= 300) {
      return {
        ok: false,
        status: sessionRes.status,
        error:
          sessionRes.status === 404
            ? 'Reached the host but /_session 404\'d — is the URL pointing at a CHT / CouchDB instance?'
            : `HTTP ${sessionRes.status}${sessionRes.body ? `: ${sessionRes.body.slice(0, 200)}` : ''}`,
        redactedUrl: redacted,
      };
    }

    // /_session returned 2xx. Parse userCtx for the authenticated-as name.
    let authenticatedAs: string | undefined;
    try {
      const j = JSON.parse(sessionRes.body) as {
        userCtx?: { name?: string | null };
      };
      authenticatedAs = j.userCtx?.name ?? undefined;
    } catch {
      // 2xx but non-JSON — odd for /_session, but treat as reachable.
    }
    if (auth && !authenticatedAs) {
      // Sent credentials, got 200, but userCtx.name is null → Couch
      // accepted the request without applying our basic auth. Surface
      // as ambiguous success rather than silent failure.
      return {
        ok: false,
        status: sessionRes.status,
        error:
          '/_session returned 200 but userCtx.name was empty — credentials may not have applied (cookie session? CORS?). Try clearing cookies on the target.',
        redactedUrl: redacted,
      };
    }

    // 2) Best-effort version info via /api/deploy-info. Missing or 404
    // is non-fatal — we still report success from the session check.
    let version: string | undefined;
    let couchVersion: string | undefined;
    try {
      const di = await httpRequest('/api/deploy-info', base, auth);
      if (di.status >= 200 && di.status < 300) {
        try {
          const j = JSON.parse(di.body) as {
            version?: string;
            base_version?: string;
            couchdb_version?: string;
          };
          version = j.version ?? j.base_version;
          couchVersion = j.couchdb_version;
        } catch {
          /* non-JSON body — skip version */
        }
      }
    } catch {
      /* deploy-info unreachable — skip; session probe already succeeded */
    }

    return {
      ok: true,
      status: sessionRes.status,
      authenticatedAs,
      version,
      couchVersion,
      redactedUrl: redacted,
    };
  })();
}

/** Resolve the deploy config to a base URL the probe can hit. */
function deployTargetBaseUrl(cfg: DeployConfig | null): string | null {
  if (!cfg) return null;
  if (cfg.target === 'local') return 'http://localhost:5988';
  if (cfg.target === 'instance' && cfg.instance) {
    return `https://${cfg.instance}.dev.medicmobile.org`;
  }
  if (cfg.target === 'url' && cfg.url) return cfg.url;
  return null;
}

export async function registerChtConfRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/cht-conf/actions', async () => {
    return {
      actions: ACTION_CATALOG,
      binaryAvailable: await fileExists(chtBinary()),
      version: await readChtConfVersion(),
    };
  });

  app.get('/api/cht-conf/config', async (req) => {
    return { config: (await getDeployConfig(req.userId)) ?? null };
  });

  app.post<{ Body: { password?: string } }>(
    '/api/cht-conf/test-connection',
    async (req, reply) => {
      const cfg = (await getDeployConfig(req.userId)) ?? null;
      const baseUrl = deployTargetBaseUrl(cfg);
      if (!baseUrl) {
        return reply.code(400).send({
          ok: false,
          error: 'No deploy target configured — pick --local, --instance, or --url first.',
        } satisfies Partial<ConnectionProbeResult>);
      }
      return await probeConnection(baseUrl, cfg!.user, req.body?.password);
    },
  );

  app.put<{ Body: DeployConfig }>('/api/cht-conf/config', async (req) => {
    await setDeployConfig(req.userId, req.body);
    return { ok: true, config: req.body };
  });

  app.post<{ Body: { action: string; password?: string; extraArgs?: string[]; dryRun?: boolean } }>(
    '/api/cht-conf/run',
    async (req, reply) => {
      const projectPath = await projectRootOrNull(req);
      if (!projectPath) return reply.code(400).send({ error: 'No project open' });
      const meta = ACTION_CATALOG.find((a) => a.name === req.body.action);
      if (!meta) return reply.code(400).send({ error: `Unknown action: ${req.body.action}` });

      const deploy = await getDeployConfig(req.userId);
      const { args, loggedArgs } = buildArgs(
        req.body.action,
        deploy,
        req.body.password,
        req.body.extraArgs ?? [],
      );
      const id = newRunId();
      const state: RunState = {
        id,
        action: req.body.action,
        cwd: projectPath,
        startedAt: Date.now(),
        endedAt: null,
        exitCode: null,
        lines: [],
        hints: [],
        listeners: new Set(),
        child: null,
      };
      runs.set(id, state);

      // Dry-run path: skip the spawn entirely and replay a scripted fixture.
      // Triggers on per-request dryRun=true OR env CHT_UI_DRY_RUN=1. Used by
      // Playwright + manual UI testing without a real CHT instance.
      const dryRun = req.body.dryRun === true || isDryRunEnabled();
      if (dryRun) {
        pushLine(state, `[dry-run] cht ${loggedArgs.join(' ')}`);
        pushLine(state, `(cwd: ${projectPath})`);
        void (async () => {
          const result = await runDryRun(req.body.action);
          for (const line of result.lines) pushLine(state, line);
          finishRun(state, result.exitCode);
        })().catch((e: Error) => {
          pushLine(state, `[dry-run error] ${e.message}`);
          finishRun(state, -1);
        });
        return { ok: true, runId: id, dryRun: true };
      }

      pushLine(state, `$ cht ${loggedArgs.join(' ')}`);
      pushLine(state, `(cwd: ${projectPath})`);

      const env: NodeJS.ProcessEnv = { ...process.env };
      // cht-conf reads COUCH_URL / CHT_URL but mostly uses --user prompt;
      // we pipe the password to stdin below when supplied.
      if (req.body.password && deploy?.user) {
        // cht-conf reads from process.env.COUCH_PASSWORD as a fallback in
        // some actions; setting it covers cases where prompt-bypass works.
        env.COUCH_PASSWORD = req.body.password;
      }

      // Windows: spawning a `.cmd` directly raises EINVAL — need shell: true
      // so cmd.exe can interpret the batch wrapper. POSIX: shell: false is
      // safer (no quoting surprises in args).
      const child = spawn(chtBinary(), args, {
        cwd: projectPath,
        env,
        shell: os.platform() === 'win32',
        windowsHide: true,
      });
      state.child = child;
      // Send password followed by newline to satisfy interactive prompts.
      if (req.body.password) {
        child.stdin?.write(`${req.body.password}\n`);
      }
      child.stdin?.end();
      attachStreams(state, child);

      return { ok: true, runId: id };
    },
  );

  /**
   * Chained-run macro. Runs N actions sequentially under a single runId so
   * the client can stream one log. Stops on first non-zero exit code.
   * Useful for "Deploy this form" which is really
   * validate → compile → convert → upload-app-forms → upload-app-settings.
   */
  app.post<{ Body: { actions: string[]; password?: string; dryRun?: boolean } }>(
    '/api/cht-conf/run-sequence',
    async (req, reply) => {
      const projectPath = await projectRootOrNull(req);
      if (!projectPath) return reply.code(400).send({ error: 'No project open' });
      if (!Array.isArray(req.body.actions) || req.body.actions.length === 0) {
        return reply.code(400).send({ error: 'actions must be a non-empty array' });
      }
      // Validate every action is known.
      for (const name of req.body.actions) {
        if (!ACTION_CATALOG.find((a) => a.name === name)) {
          return reply.code(400).send({ error: `Unknown action: ${name}` });
        }
      }
      const deploy = await getDeployConfig(req.userId);
      const dryRun = req.body.dryRun === true || isDryRunEnabled();
      const id = newRunId();
      const state: RunState = {
        id,
        action: `sequence(${req.body.actions.join(',')})`,
        cwd: projectPath,
        startedAt: Date.now(),
        endedAt: null,
        exitCode: null,
        lines: [],
        hints: [],
        listeners: new Set(),
        child: null,
      };
      runs.set(id, state);

      // Kick off async run loop — don't await; return runId immediately so
      // the client can subscribe to the SSE stream.
      void (async () => {
        const total = req.body.actions.length;
        for (let i = 0; i < total; i++) {
          const action = req.body.actions[i]!;
          pushLine(state, '');
          pushLine(state, `── step ${i + 1}/${total}: ${action} ──`);

          if (dryRun) {
            const result = await runDryRun(action);
            pushLine(state, `[dry-run] cht ${action}`);
            for (const line of result.lines) pushLine(state, line);
            if (result.exitCode !== 0) {
              pushLine(state, `✖ step ${i + 1}/${total} (${action}) failed with exit code ${result.exitCode}. Stopping.`);
              finishRun(state, result.exitCode);
              return;
            }
            pushLine(state, `✓ step ${i + 1}/${total} (${action}) OK`);
            continue;
          }

          const { args, loggedArgs } = buildArgs(
            action,
            deploy ?? null,
            req.body.password,
            [],
          );
          pushLine(state, `$ cht ${loggedArgs.join(' ')}`);

          const env: NodeJS.ProcessEnv = { ...process.env };
          if (req.body.password && deploy?.user) {
            env.COUCH_PASSWORD = req.body.password;
          }
          const child = spawn(chtBinary(), args, {
            cwd: projectPath,
            env,
            shell: os.platform() === 'win32',
            windowsHide: true,
          });
          state.child = child;
          if (req.body.password) child.stdin?.write(`${req.body.password}\n`);
          child.stdin?.end();

          // Wire output to the shared state — but use a per-step promise so
          // we don't finish the macro until each child closes.
          const exitCode = await new Promise<number | null>((resolve) => {
            let stdoutBuf = '';
            let stderrBuf = '';
            child.stdout?.on('data', (b: Buffer) => {
              stdoutBuf += b.toString('utf8');
              let nl;
              while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
                pushLine(state, stdoutBuf.slice(0, nl));
                stdoutBuf = stdoutBuf.slice(nl + 1);
              }
            });
            child.stderr?.on('data', (b: Buffer) => {
              stderrBuf += b.toString('utf8');
              let nl;
              while ((nl = stderrBuf.indexOf('\n')) !== -1) {
                pushLine(state, `[stderr] ${stderrBuf.slice(0, nl)}`);
                stderrBuf = stderrBuf.slice(nl + 1);
              }
            });
            child.on('close', (code) => {
              if (stdoutBuf) pushLine(state, stdoutBuf);
              if (stderrBuf) pushLine(state, `[stderr] ${stderrBuf}`);
              resolve(code);
            });
            child.on('error', (err) => {
              pushLine(state, `[error] ${err.message}`);
              resolve(-1);
            });
          });

          if (exitCode !== 0) {
            pushLine(state, `✖ step ${i + 1}/${total} (${action}) failed with exit code ${exitCode}. Stopping.`);
            finishRun(state, exitCode);
            return;
          }
          pushLine(state, `✓ step ${i + 1}/${total} (${action}) OK`);
        }
        pushLine(state, '');
        pushLine(state, `✓ all ${total} step(s) completed`);
        finishRun(state, 0);
      })().catch((e: Error) => {
        pushLine(state, `[macro error] ${e.message}`);
        finishRun(state, -1);
      });

      return { ok: true, runId: id };
    },
  );

  app.get<{ Params: { runId: string } }>('/api/cht-conf/runs/:runId', async (req, reply) => {
    const state = runs.get(req.params.runId);
    if (!state) return reply.code(404).send({ error: 'Run not found' });
    return {
      id: state.id,
      action: state.action,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      exitCode: state.exitCode,
      lines: state.lines,
      hints: state.hints,
      running: state.endedAt === null,
    };
  });

  app.get<{ Params: { runId: string } }>(
    '/api/cht-conf/runs/:runId/stream',
    async (req: FastifyRequest<{ Params: { runId: string } }>, reply: FastifyReply) => {
      const state = runs.get(req.params.runId);
      if (!state) return reply.code(404).send({ error: 'Run not found' });

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders();

      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // Replay buffered lines + hints first so a late subscriber sees the
      // same friendly translations the original viewer saw.
      for (const line of state.lines) send('line', { line });
      for (const hint of state.hints) send('hint', hint);
      if (state.endedAt !== null) {
        send('done', { exitCode: state.exitCode });
        reply.raw.end();
        return reply;
      }

      const listener = (update: RunUpdate) => {
        if (update.kind === 'done') {
          send('done', { exitCode: update.exitCode });
          reply.raw.end();
        } else if (update.kind === 'hint') {
          send('hint', update.hint);
        } else {
          send('line', { line: update.line });
        }
      };
      state.listeners.add(listener);

      req.raw.on('close', () => {
        state.listeners.delete(listener);
      });
      return reply;
    },
  );

  app.post<{ Params: { runId: string } }>('/api/cht-conf/runs/:runId/cancel', async (req, reply) => {
    const state = runs.get(req.params.runId);
    if (!state) return reply.code(404).send({ error: 'Run not found' });
    if (state.child) {
      state.child.kill('SIGTERM');
      pushLine(state, '[cancelled by user]');
    }
    return { ok: true };
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readChtConfVersion(): Promise<string | null> {
  try {
    const serverRoot = path.resolve(__dirname, '..', '..');
    const pkg = JSON.parse(
      await fs.readFile(path.join(serverRoot, 'node_modules', 'cht-conf', 'package.json'), 'utf8'),
    ) as { version: string };
    return pkg.version;
  } catch {
    return null;
  }
}
