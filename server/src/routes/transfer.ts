/**
 * Getting a project in and out of the server when the user's disk is not the
 * server's disk (docs/plans/hosted-authoring.md §6.4, §6.5, §8.5).
 *
 *   POST /api/projects/import-git          { url, name?, branch? }
 *   POST /api/projects/:id/export-git      { branch, message? }
 *   POST /api/projects/import-zip?name=    body: the zip bytes
 *   GET  /api/projects/:id/export.zip
 *
 * Git is the first-class path for real configs: clone in, edit, push a branch
 * the user reviews and merges — non-destructive, and an audit trail. Zip is
 * the fallback for people with no repo; zip export overwrites whatever is on
 * the user's disk with no diff.
 *
 * Both imports land in the user's projects dir and go through
 * `registerProject`, so an imported NSSD and a new-from-template project are
 * the same shape on disk (§6.3). Both apply the §6.5 exclusion list — lumbini
 * is 293 MB of which 280 MB is map tiles — and the size budget.
 *
 * Zip entry names are untrusted: every entry is normalised and must stay
 * inside the destination (zip-slip), absolute names and `..` are refused.
 *
 * The project root may be a subfolder of what was imported (nssd's `chis/`):
 * `findProjectRoot` looks two levels down for `app_settings/` and the entry
 * records both `path` (the project) and `repoRoot` (the clone) so export can
 * commit from the repo.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { IMPORT_MAX_BYTES, isInside, userProjectsDir } from '../config.js';
import { allocateProjectDir, getProject, registerProject, slugify } from '../state.js';

/** Never imported or exported. */
export const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'map-export', 'exports', 'backups']);

const GIT_TIMEOUT_MS = 5 * 60 * 1000;

function runGit(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = '';
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
      shell: os.platform() === 'win32',
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: e.message });
    });
  });
}

/** Strip `user:token@` from anything that looks like a URL, for logs and errors. */
export function redactUrl(s: string): string {
  return s.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1');
}

function isAllowedGitUrl(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url.trim());
}

const BRANCH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/$)(?!.*@\{)[A-Za-z0-9._\-/]+$/;

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === '.git') continue;
      total += await dirSize(path.join(dir, e.name));
    } else if (e.isFile()) {
      total += (await fs.stat(path.join(dir, e.name))).size;
    }
  }
  return total;
}

async function hasAppSettings(dir: string): Promise<boolean> {
  for (const rel of [path.join('app_settings', 'base_settings.json'), 'app_settings.json']) {
    try {
      await fs.access(path.join(dir, rel));
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/** The cht-conf project root within `dir`: itself, or one folder up to two levels down. */
export async function findProjectRoot(dir: string): Promise<string | null> {
  if (await hasAppSettings(dir)) return dir;
  const found: string[] = [];
  async function walk(d: string, depth: number) {
    if (depth > 2) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || EXCLUDED_DIRS.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (await hasAppSettings(full)) found.push(full);
      else await walk(full, depth + 1);
    }
  }
  await walk(dir, 1);
  found.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return found[0] ?? null;
}

function repoNameFromUrl(url: string): string {
  const last = url.replace(/\/+$/, '').split('/').pop() ?? 'project';
  return last.replace(/\.git$/i, '');
}

/* --------------------------------- zip ---------------------------------- */

/** Normalise a zip entry name; null when it must be refused or skipped. */
export function safeEntryPath(entryName: string): string | null {
  const norm = entryName.replace(/\\/g, '/');
  if (!norm || norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.includes('\0')) return null;
  const parts = norm.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  if (parts.some((p) => EXCLUDED_DIRS.has(p))) return null;
  return parts.join('/');
}

/**
 * If every entry shares one top-level folder (a zip *of* a folder), strip it
 * so the project lands at the destination root.
 */
function commonRoot(paths: string[]): string | null {
  const tops = new Set(paths.map((p) => p.split('/')[0]!));
  if (tops.size !== 1) return null;
  const [top] = tops;
  // Only a folder prefix counts — a zip with a single top-level FILE has none.
  return paths.every((p) => p.includes('/')) ? top! : null;
}

async function extractZip(buffer: Buffer, dest: string): Promise<{ files: number; bytes: number }> {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const named = entries
    .map((e) => ({ e, rel: safeEntryPath(e.entryName) }))
    .filter((x): x is { e: AdmZip.IZipEntry; rel: string } => x.rel !== null);
  if (named.length === 0) throw new Error('The zip contains no usable files.');
  const root = commonRoot(named.map((x) => x.rel));
  let bytes = 0;
  let files = 0;
  for (const { e, rel } of named) {
    const stripped = root ? rel.slice(root.length + 1) : rel;
    if (!stripped) continue;
    const target = path.resolve(dest, stripped);
    if (!isInside(dest, target) || target === path.resolve(dest)) {
      throw new Error(`Refusing zip entry that escapes the project: ${e.entryName}`);
    }
    const data = e.getData();
    bytes += data.length;
    if (bytes > IMPORT_MAX_BYTES) {
      throw new Error(`The zip expands past the ${Math.round(IMPORT_MAX_BYTES / 1e6)} MB budget.`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    files++;
  }
  return { files, bytes };
}

async function addDirToZip(zip: AdmZip, dir: string, prefix: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (EXCLUDED_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) await addDirToZip(zip, full, rel);
    else if (e.isFile()) zip.addFile(rel, await fs.readFile(full));
  }
}

/* -------------------------------- routes -------------------------------- */

function fail(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).send({ error: redactUrl(message) });
}

export async function registerTransferRoutes(app: FastifyInstance): Promise<void> {
  // Raw zip bodies. Only this module's import route consumes them.
  app.addContentTypeParser(
    ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: IMPORT_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.post<{ Body: { url?: string; name?: string; branch?: string } }>(
    '/api/projects/import-git',
    async (req, reply) => {
      const url = (req.body?.url ?? '').trim();
      if (!isAllowedGitUrl(url)) {
        return fail(reply, 400, 'Enter an http(s) git URL. Private repos: https://<user>:<token>@host/org/repo.git');
      }
      const branch = (req.body?.branch ?? '').trim();
      if (branch && !BRANCH_RE.test(branch)) return fail(reply, 400, 'Invalid branch name.');
      const name = (req.body?.name ?? '').trim() || repoNameFromUrl(url);
      const dest = await allocateProjectDir(req.userId, name);

      const args = ['clone', '--depth', '1', '--single-branch'];
      if (branch) args.push('--branch', branch);
      args.push('--', url, dest);
      const clone = await runGit(args, userProjectsDir(req.userId));
      if (clone.code !== 0) {
        await fs.rm(dest, { recursive: true, force: true });
        return fail(reply, 400, `git clone failed:\n${clone.out.trim()}`);
      }
      // Budget check after the fact: git cannot filter by size on clone.
      const size = await dirSize(dest);
      if (size > IMPORT_MAX_BYTES) {
        await fs.rm(dest, { recursive: true, force: true });
        return fail(
          reply,
          400,
          `Repository is ${Math.round(size / 1e6)} MB, over the ${Math.round(IMPORT_MAX_BYTES / 1e6)} MB budget. Move map-export / exports / backups out of the repo or import a zip without them.`,
        );
      }
      const root = await findProjectRoot(dest);
      if (!root) {
        await fs.rm(dest, { recursive: true, force: true });
        return fail(reply, 400, 'No cht-conf project found (looked for app_settings/ up to two folders deep).');
      }
      const entry = await registerProject(req.userId, {
        name,
        path: root,
        source: 'import-git',
        origin: redactUrl(url),
        repoRoot: dest,
      });
      return { ok: true, projectId: entry.id, subdir: path.relative(dest, root) || null };
    },
  );

  app.post<{ Params: { id: string }; Body: { branch?: string; message?: string } }>(
    '/api/projects/:id/export-git',
    async (req, reply) => {
      const entry = await getProject(req.userId, req.params.id);
      if (!entry) return fail(reply, 404, 'Project not found.');
      if (!entry.repoRoot) return fail(reply, 400, 'This project was not imported from git. Download it as a zip instead.');
      const branch = (req.body?.branch ?? '').trim();
      if (!BRANCH_RE.test(branch)) return fail(reply, 400, 'Enter a branch name (letters, digits, . _ - /).');
      const message = (req.body?.message ?? '').trim() || 'Edited with CHT UI Builder';
      const repo = entry.repoRoot;
      const identity = [
        '-c',
        'user.name=CHT UI Builder',
        '-c',
        `user.email=${req.userId}@users.cht-ui-builder.invalid`,
      ];
      const log: string[] = [];
      const add = await runGit(['add', '-A', '--', '.'], repo);
      log.push(add.out);
      if (add.code !== 0) return fail(reply, 500, `git add failed:\n${add.out}`);
      const commit = await runGit([...identity, 'commit', '-m', message], repo);
      log.push(commit.out);
      const nothing = /nothing to commit/i.test(commit.out);
      if (commit.code !== 0 && !nothing) return fail(reply, 500, `git commit failed:\n${commit.out}`);
      const push = await runGit(['push', 'origin', `HEAD:refs/heads/${branch}`], repo);
      log.push(push.out);
      if (push.code !== 0) return fail(reply, 400, `git push failed:\n${push.out}`);
      return { ok: true, branch, committed: !nothing, output: redactUrl(log.join('\n').trim()) };
    },
  );

  app.post<{ Querystring: { name?: string }; Body: Buffer }>(
    '/api/projects/import-zip',
    async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return fail(reply, 400, 'Send the zip file as the request body (Content-Type: application/zip).');
      }
      const name = (req.query.name ?? '').trim() || 'imported-project';
      const dest = await allocateProjectDir(req.userId, name);
      try {
        await fs.mkdir(dest, { recursive: true });
        await extractZip(body, dest);
      } catch (e) {
        await fs.rm(dest, { recursive: true, force: true });
        return fail(reply, 400, (e as Error).message);
      }
      const root = await findProjectRoot(dest);
      if (!root) {
        await fs.rm(dest, { recursive: true, force: true });
        return fail(reply, 400, 'No cht-conf project found in the zip (looked for app_settings/ up to two folders deep).');
      }
      const entry = await registerProject(req.userId, {
        name,
        path: root,
        source: 'import-zip',
        ...(root !== dest ? { repoRoot: dest } : {}),
      });
      return { ok: true, projectId: entry.id, subdir: path.relative(dest, root) || null };
    },
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id/export.zip', async (req, reply) => {
    const entry = await getProject(req.userId, req.params.id);
    if (!entry) return fail(reply, 404, 'Project not found.');
    const zip = new AdmZip();
    await addDirToZip(zip, entry.path, '');
    const filename = `${slugify(entry.name) || 'project'}.zip`;
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(zip.toBuffer());
  });
}
