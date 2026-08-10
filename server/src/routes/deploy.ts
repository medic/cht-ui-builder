/**
 * Owned deploy pipeline — `POST /api/deploy/run`.
 *
 * A single sequenced flow that composes the individual cht-conf actions
 * (compile-app-settings → convert-* → upload-*) behind one call, streams
 * per-step progress as NDJSON, and stops on the first failure.
 *
 * Why a separate route: the existing `POST /api/cht-conf/run-sequence` in
 * cht-conf.ts speaks a run-id + SSE-subscribe pattern (the log tails a
 * shared buffer keyed by runId). This route is the "one gesture, one
 * streaming response" flow — a distinct concern, distinct shape, distinct
 * tests. Same underlying spawn + friendly-error translator; different
 * envelope.
 *
 * Streaming shape: NDJSON. One JSON per line on the response body:
 *   { event: 'start',       steps: DeployStep[] }
 *   { event: 'step-start',  step: DeployStep, action: string, index, total, cmd }
 *   { event: 'step-line',   step: DeployStep, stream: 'stdout'|'stderr', line }
 *   { event: 'step-hint',   step: DeployStep, hint: ErrorHint }
 *   { event: 'step-success',step: DeployStep, exitCode: number }
 *   { event: 'step-error',  step: DeployStep, exitCode, stderr, translated? }
 *   { event: 'done',        ok: boolean }
 *
 * On step failure the pipeline emits step-error (with BOTH raw stderr and
 * a translated summary when a pattern matches) then a final done{ok:false}
 * and stops — no subsequent steps run.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { getProjectPath } from '../state.js';
import { matchErrorPattern } from '../cht-conf/errorPatterns.js';
import { buildUrlWithCreds, chtBinary } from './cht-conf.js';

/**
 * The steps this pipeline knows how to run. Names mirror the cht-conf
 * action names so the friendly-error translator + docs both apply.
 */
export const DEPLOY_STEPS = [
  'compile-app-settings',
  'convert-app-forms',
  'convert-contact-forms',
  'upload-app-forms',
  'upload-contact-forms',
  'upload-app-settings',
  'upload-resources',
  // W2 — without this, everything the tool writes into
  // `translations/messages-<locale>.properties` stays on disk and the CHW
  // sees the raw translation key instead of the string. That is the whole
  // delivery path for task titles (docs/NEXT.md item 8), so a one-click
  // deploy that omits it ships nothing.
  //
  // Position matches cht-conf's own canonical order, which runs
  // upload-custom-translations after upload-resources (its
  // `src/lib/main.js` defaultActions). It is independent of
  // compile/upload-app-settings — it writes `messages-<locale>` docs
  // straight to the instance database.
  //
  // Safe to run unconditionally: cht-conf's action resolves
  // `<project>/translations` and, when that directory is absent, logs
  // `Could not find custom translations dir` and RETURNS — it does not
  // throw (verified in cht-conf 6.5.0
  // `src/fn/upload-custom-translations.js`). Empty message values are
  // likewise only warned about; only placeholder/messageformat errors are
  // fatal. So projects with no translations keep deploying exactly as
  // before, just with one extra skipped step.
  'upload-custom-translations',
] as const;

export type DeployStep = (typeof DEPLOY_STEPS)[number];

/**
 * Steps that talk to the target instance — need URL + credentials. The
 * convert-* / compile-app-settings steps are purely local.
 */
const UPLOAD_STEPS = new Set<DeployStep>([
  'upload-app-forms',
  'upload-contact-forms',
  'upload-app-settings',
  'upload-resources',
  'upload-custom-translations',
]);

export interface DeployRunBody {
  url: string;
  user: string;
  password: string;
  steps: DeployStep[];
  /** Per-step extra CLI args, keyed by step name. */
  extraArgs?: Record<string, string[]>;
}

export interface StepArgs {
  /** The args passed to `cht`, credentials embedded. */
  args: string[];
  /** Same args with the password replaced by `***` for logging. */
  loggedArgs: string[];
}

/**
 * Pure: build the argv for a single step. Exported for the test suite —
 * this is where the pipeline's URL / credential handling lives, and a
 * regression here silently leaks passwords into the log.
 */
export function buildStepArgs(
  step: DeployStep,
  creds: { url: string; user: string; password: string },
  extras: string[] = [],
): StepArgs {
  const args: string[] = [];
  const loggedArgs: string[] = [];
  if (UPLOAD_STEPS.has(step)) {
    const { actual, redacted } = buildUrlWithCreds(creds.url, creds.user, creds.password);
    args.push(`--url=${actual}`);
    loggedArgs.push(`--url=${redacted}`);
  }
  args.push(step);
  args.push(...extras);
  loggedArgs.push(step);
  loggedArgs.push(...extras);
  return { args, loggedArgs };
}

interface ErrorHint {
  patternId: string;
  friendly: string;
  hint?: string;
  docsUrl?: string;
  knownUpstreamBug?: boolean;
  rawLine: string;
}

/**
 * Scan an accumulated stderr blob for the first recognised error pattern.
 * Returns null if nothing matched — the raw stderr is still surfaced by
 * the caller so the user can drill down.
 */
export function translateStderr(stderr: string): ErrorHint | null {
  for (const rawLine of stderr.split(/\r?\n/)) {
    const m = matchErrorPattern(rawLine);
    if (m) {
      return {
        patternId: m.pattern.id,
        friendly: m.pattern.friendly(m.match),
        hint: m.pattern.hint?.(m.match),
        docsUrl: m.pattern.docsUrl,
        knownUpstreamBug: Boolean(m.pattern.knownUpstreamBug),
        rawLine,
      };
    }
  }
  return null;
}

/**
 * Validate the request body's shape. Returns an error message string on
 * invalid input; null on success. System-boundary validation only — inner
 * helpers assume well-typed input.
 */
export function validateDeployRunBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'body must be an object';
  const b = body as Partial<DeployRunBody>;
  if (typeof b.url !== 'string' || b.url.length === 0) return 'url is required';
  if (typeof b.user !== 'string' || b.user.length === 0) return 'user is required';
  if (typeof b.password !== 'string') return 'password is required';
  if (!Array.isArray(b.steps) || b.steps.length === 0) return 'steps must be a non-empty array';
  for (const s of b.steps) {
    if (!DEPLOY_STEPS.includes(s as DeployStep)) return `unknown step: ${String(s)}`;
  }
  if (b.extraArgs !== undefined) {
    if (typeof b.extraArgs !== 'object' || b.extraArgs === null) {
      return 'extraArgs must be an object of step-name → string[]';
    }
    for (const [k, v] of Object.entries(b.extraArgs)) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        return `extraArgs[${k}] must be a string[]`;
      }
    }
  }
  return null;
}

interface Emitter {
  emit(event: Record<string, unknown>): void;
  end(): void;
}

/**
 * Spawn one step under the pipeline. Resolves with exit code + accumulated
 * stderr. Streams per-line stdout/stderr to the emitter as it arrives.
 */
function runStep(
  step: DeployStep,
  cwd: string,
  args: string[],
  password: string,
  emit: Emitter,
): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(chtBinary(), args, {
      cwd,
      env: { ...process.env, COUCH_PASSWORD: password },
      shell: os.platform() === 'win32',
      windowsHide: true,
    });

    // Feed password to any interactive prompt cht-conf may raise.
    child.stdin?.write(`${password}\n`);
    child.stdin?.end();

    let stdoutBuf = '';
    let stderrBuf = '';
    let stderrAll = '';
    const seenHintIds = new Set<string>();

    const emitLine = (stream: 'stdout' | 'stderr', line: string) => {
      emit.emit({ event: 'step-line', step, stream, line });
      const match = matchErrorPattern(line);
      if (match && !seenHintIds.has(match.pattern.id)) {
        seenHintIds.add(match.pattern.id);
        const hint: ErrorHint = {
          patternId: match.pattern.id,
          friendly: match.pattern.friendly(match.match),
          hint: match.pattern.hint?.(match.match),
          docsUrl: match.pattern.docsUrl,
          knownUpstreamBug: Boolean(match.pattern.knownUpstreamBug),
          rawLine: line,
        };
        emit.emit({ event: 'step-hint', step, hint });
      }
    };

    child.stdout?.on('data', (b: Buffer) => {
      stdoutBuf += b.toString('utf8');
      let i;
      while ((i = stdoutBuf.indexOf('\n')) !== -1) {
        emitLine('stdout', stdoutBuf.slice(0, i));
        stdoutBuf = stdoutBuf.slice(i + 1);
      }
    });
    child.stderr?.on('data', (b: Buffer) => {
      const text = b.toString('utf8');
      stderrAll += text;
      stderrBuf += text;
      let i;
      while ((i = stderrBuf.indexOf('\n')) !== -1) {
        emitLine('stderr', stderrBuf.slice(0, i));
        stderrBuf = stderrBuf.slice(i + 1);
      }
    });
    child.on('close', (code) => {
      if (stdoutBuf) emitLine('stdout', stdoutBuf);
      if (stderrBuf) emitLine('stderr', stderrBuf);
      resolve({ exitCode: code, stderr: stderrAll });
    });
    child.on('error', (err) => {
      stderrAll += err.message;
      emitLine('stderr', `[spawn error] ${err.message}`);
      resolve({ exitCode: -1, stderr: stderrAll });
    });
  });
}

export async function registerDeployRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/deploy/run',
    async (req: FastifyRequest<{ Body: DeployRunBody }>, reply: FastifyReply) => {
      const projectPath = await getProjectPath();
      if (!projectPath) return reply.code(400).send({ error: 'No project open' });

      const invalid = validateDeployRunBody(req.body);
      if (invalid) return reply.code(400).send({ error: invalid });

      const { url, user, password, steps, extraArgs } = req.body;

      reply.raw.setHeader('Content-Type', 'application/x-ndjson');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders();

      const emitter: Emitter = {
        emit(event) {
          reply.raw.write(`${JSON.stringify(event)}\n`);
        },
        end() {
          reply.raw.end();
        },
      };

      emitter.emit({ event: 'start', steps });

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const { args, loggedArgs } = buildStepArgs(
          step,
          { url, user, password },
          extraArgs?.[step] ?? [],
        );
        emitter.emit({
          event: 'step-start',
          step,
          action: step,
          index: i,
          total: steps.length,
          cmd: `cht ${loggedArgs.join(' ')}`,
        });

        const { exitCode, stderr } = await runStep(step, projectPath, args, password, emitter);

        if (exitCode !== 0) {
          const translated = translateStderr(stderr);
          emitter.emit({
            event: 'step-error',
            step,
            index: i,
            exitCode,
            stderr,
            ...(translated ? { translated } : {}),
          });
          emitter.emit({ event: 'done', ok: false });
          emitter.end();
          return reply;
        }

        emitter.emit({ event: 'step-success', step, index: i, exitCode });
      }

      emitter.emit({ event: 'done', ok: true });
      emitter.end();
      return reply;
    },
  );
}
