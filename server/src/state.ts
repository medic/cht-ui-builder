/**
 * Per-user project registry and per-request project resolution.
 *
 * There is no server-side "current project" any more. Every request names
 * the project it is about with the `x-project-id` header (or `?project=` for
 * the one EventSource route), and the server resolves that id inside the
 * requesting user's registry to a folder on disk. Two tabs editing two
 * projects never fight over a shared slot, and no filesystem path crosses the
 * wire (docs/plans/hosted-authoring.md §6.1).
 *
 * Layout, identical in both modes (config.ts):
 *
 *   DATA_ROOT/users/<userId>/registry.json      the entries below + deploy config
 *   DATA_ROOT/users/<userId>/projects/<folder>  hosted projects live here
 *
 * In desktop mode an entry's path may be anywhere on the machine (the user
 * opened it by path); in hosted mode `projectEntryFor` additionally refuses
 * any entry whose path is not under that user's projects dir, so a corrupted
 * or hand-edited registry still cannot reach another user's files.
 *
 * Desktop compatibility: the pre-registry server remembered one project in
 * ~/.cht-ui-builder/state.json. On first load the local registry imports it as
 * a `local` entry (and its deploy config), so the folder the user last had
 * open is still the first thing they see. GET /api/project with no header
 * falls back to the most recently opened entry in desktop mode only — that is
 * what keeps "reopen the browser, land in your project" working, and what the
 * Playwright suite's `POST /api/project/open` + fresh page relies on.
 */
import type { FastifyRequest } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DATA_ROOT,
  LOCAL_USER_ID,
  MODE,
  SAFE_ID_RE,
  isInside,
  userDir,
  userProjectsDir,
} from './config.js';

/**
 * Persistent cht-conf deploy target. Password is NEVER persisted —
 * the UI prompts each run.
 */
export interface DeployConfig {
  target: 'local' | 'instance' | 'url';
  /** Used when target === 'instance' (Medic-hosted: <name>.dev.medicmobile.org). */
  instance?: string;
  /** Used when target === 'url' (arbitrary URL). */
  url?: string;
  /** Username for `cht --user <name>`. */
  user?: string;
}

export type ProjectSource = 'local' | 'template' | 'import-git' | 'import-zip';

export interface ProjectEntry {
  id: string;
  /** Display name. Defaults to the folder basename. */
  name: string;
  /** Absolute path of the cht-conf project root (the dir holding app_settings/). */
  path: string;
  source: ProjectSource;
  /** For `template`: which one. For `import-git`: the clone URL. */
  origin?: string;
  /**
   * For `import-git` where the project root is a subfolder of the repo
   * (nssd's `chis/`): the clone dir, so export can commit + push from it.
   */
  repoRoot?: string;
  createdAt: string;
  lastOpenedAt: string;
}

interface RegistryFile {
  version: 1;
  projects: ProjectEntry[];
  deployConfig: DeployConfig | null;
  /**
   * Desktop only: the project a request with NO id resolves to — the folder
   * the user last had open. `null` means the user closed it (the picker
   * renders); `undefined` is a registry written before this field existed
   * and falls back to the most recently opened entry.
   */
  lastOpenedId?: string | null;
}

export class NoProjectError extends Error {
  status = 400;
  constructor(message = 'No project is open. Open a project first.') {
    super(message);
  }
}

/* ------------------------------ persistence ------------------------------ */

const registryFile = (userId: string) => path.join(userDir(userId), 'registry.json');

/** One write chain per user so concurrent requests cannot interleave writes. */
const chains = new Map<string, Promise<unknown>>();
function serialised<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    userId,
    next.catch(() => undefined),
  );
  return next;
}

async function readRegistry(userId: string): Promise<RegistryFile> {
  try {
    const raw = await fs.readFile(registryFile(userId), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RegistryFile>;
    return {
      version: 1,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      deployConfig: parsed.deployConfig ?? null,
      lastOpenedId: parsed.lastOpenedId,
    };
  } catch {
    return await migrateLegacyState(userId);
  }
}

async function writeRegistry(userId: string, reg: RegistryFile): Promise<void> {
  const file = registryFile(userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(reg, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Desktop only: import ~/.cht-ui-builder/state.json (the single-slot state
 * this module replaced) into a fresh registry. Leaves the old file in place.
 */
async function migrateLegacyState(userId: string): Promise<RegistryFile> {
  const empty: RegistryFile = { version: 1, projects: [], deployConfig: null };
  if (MODE !== 'desktop' || userId !== LOCAL_USER_ID) return empty;
  try {
    const raw = await fs.readFile(path.join(DATA_ROOT, 'state.json'), 'utf8');
    const legacy = JSON.parse(raw) as { projectPath?: string | null; deployConfig?: DeployConfig | null };
    const reg: RegistryFile = { ...empty, deployConfig: legacy.deployConfig ?? null };
    if (legacy.projectPath && (await dirExists(legacy.projectPath))) {
      const now = new Date().toISOString();
      const entry: ProjectEntry = {
        id: newProjectId(),
        name: path.basename(legacy.projectPath),
        path: path.resolve(legacy.projectPath),
        source: 'local',
        createdAt: now,
        lastOpenedAt: now,
      };
      reg.projects.push(entry);
      reg.lastOpenedId = entry.id;
    }
    await writeRegistry(userId, reg);
    return reg;
  } catch {
    return empty;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/* -------------------------------- registry -------------------------------- */

export function newProjectId(): string {
  return `p_${randomBytes(8).toString('base64url').replace(/[^A-Za-z0-9]/g, '')}`;
}

export async function listProjects(userId: string): Promise<Array<ProjectEntry & { exists: boolean }>> {
  const reg = await readRegistry(userId);
  const out = await Promise.all(
    reg.projects.map(async (p) => ({ ...p, exists: await dirExists(p.path) })),
  );
  return out.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

export async function getProject(userId: string, projectId: string): Promise<ProjectEntry | null> {
  if (!SAFE_ID_RE.test(projectId)) return null;
  const reg = await readRegistry(userId);
  return reg.projects.find((p) => p.id === projectId) ?? null;
}

/**
 * Register a project. An existing entry with the same path is reused (opening
 * the same folder twice is one project). Returns the entry.
 */
export async function registerProject(
  userId: string,
  input: Omit<ProjectEntry, 'id' | 'createdAt' | 'lastOpenedAt'>,
): Promise<ProjectEntry> {
  const abs = path.resolve(input.path);
  if (MODE === 'hosted' && !isInside(userProjectsDir(userId), abs)) {
    throw new Error('hosted projects must live under the user projects dir');
  }
  return serialised(userId, async () => {
    const reg = await readRegistry(userId);
    const now = new Date().toISOString();
    const existing = reg.projects.find((p) => path.resolve(p.path) === abs);
    if (existing) {
      existing.lastOpenedAt = now;
      reg.lastOpenedId = existing.id;
      await writeRegistry(userId, reg);
      return existing;
    }
    const entry: ProjectEntry = { ...input, path: abs, id: newProjectId(), createdAt: now, lastOpenedAt: now };
    reg.projects.push(entry);
    reg.lastOpenedId = entry.id;
    await writeRegistry(userId, reg);
    return entry;
  });
}

export async function touchProject(userId: string, projectId: string): Promise<ProjectEntry | null> {
  return serialised(userId, async () => {
    const reg = await readRegistry(userId);
    const p = reg.projects.find((x) => x.id === projectId);
    if (!p) return null;
    p.lastOpenedAt = new Date().toISOString();
    reg.lastOpenedId = p.id;
    await writeRegistry(userId, reg);
    return p;
  });
}

/**
 * Desktop: "Change project". A request with no project id no longer resolves
 * to anything, so a fresh tab (or a reload) lands on the picker instead of
 * straight back inside the project just closed. Tabs that still name the
 * project by id keep working.
 */
export async function clearLastOpened(userId: string): Promise<void> {
  await serialised(userId, async () => {
    const reg = await readRegistry(userId);
    reg.lastOpenedId = null;
    await writeRegistry(userId, reg);
  });
}

export async function renameProject(userId: string, projectId: string, name: string): Promise<ProjectEntry | null> {
  return serialised(userId, async () => {
    const reg = await readRegistry(userId);
    const p = reg.projects.find((x) => x.id === projectId);
    if (!p) return null;
    p.name = name;
    await writeRegistry(userId, reg);
    return p;
  });
}

/**
 * Forget a project. Files are deleted only when they live under this user's
 * projects dir — a desktop entry pointing at the user's own folder is only
 * ever forgotten, never removed from disk.
 */
export async function removeProject(
  userId: string,
  projectId: string,
  deleteFiles: boolean,
): Promise<{ removed: boolean; deletedFiles: boolean }> {
  const entry = await serialised(userId, async () => {
    const reg = await readRegistry(userId);
    const i = reg.projects.findIndex((x) => x.id === projectId);
    if (i === -1) return null;
    const [p] = reg.projects.splice(i, 1);
    if (reg.lastOpenedId === projectId) reg.lastOpenedId = null;
    await writeRegistry(userId, reg);
    return p!;
  });
  if (!entry) return { removed: false, deletedFiles: false };
  const target = entry.repoRoot ?? entry.path;
  const projectsDir = userProjectsDir(userId);
  const owned = isInside(projectsDir, target) && path.resolve(target) !== path.resolve(projectsDir);
  if (deleteFiles && owned) {
    await fs.rm(target, { recursive: true, force: true });
    return { removed: true, deletedFiles: true };
  }
  return { removed: true, deletedFiles: false };
}

/**
 * Pick a fresh folder under the user's projects dir for a project called
 * `name`: slugified, suffixed on collision. Creates the projects dir.
 */
export async function allocateProjectDir(userId: string, name: string): Promise<string> {
  const base = slugify(name) || 'project';
  const root = userProjectsDir(userId);
  await fs.mkdir(root, { recursive: true });
  let candidate = path.join(root, base);
  for (let n = 2; await exists(candidate); n++) candidate = path.join(root, `${base}-${n}`);
  return candidate;
}

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------- deploy config ------------------------------ */

export async function getDeployConfig(userId: string): Promise<DeployConfig | null> {
  return (await readRegistry(userId)).deployConfig ?? null;
}

export async function setDeployConfig(userId: string, cfg: DeployConfig | null): Promise<void> {
  await serialised(userId, async () => {
    const reg = await readRegistry(userId);
    reg.deployConfig = cfg;
    await writeRegistry(userId, reg);
  });
}

/* ------------------------- per-request resolution ------------------------ */

export const PROJECT_HEADER = 'x-project-id';

/** The project id a request names, from the header or `?project=`. */
export function projectIdFromRequest(req: FastifyRequest): string | null {
  const h = req.headers[PROJECT_HEADER];
  const fromHeader = Array.isArray(h) ? h[0] : h;
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader;
  const q = (req.query as Record<string, unknown> | undefined)?.project;
  if (typeof q === 'string' && q) return q;
  return null;
}

/**
 * Resolve the request's project entry, or null when none is named. Desktop
 * mode falls back to the most recently opened project when no id is given.
 */
export async function projectEntryFor(req: FastifyRequest): Promise<ProjectEntry | null> {
  const userId = req.userId || (MODE === 'desktop' ? LOCAL_USER_ID : '');
  if (!userId) return null;
  const id = projectIdFromRequest(req);
  let entry: ProjectEntry | null = null;
  if (id) {
    entry = await getProject(userId, id);
  } else if (MODE === 'desktop') {
    const reg = await readRegistry(userId);
    if (reg.lastOpenedId === null) {
      entry = null; // closed explicitly — the picker renders
    } else if (reg.lastOpenedId) {
      entry = reg.projects.find((p) => p.id === reg.lastOpenedId) ?? null;
    } else {
      const all = await listProjects(userId);
      entry = all.find((p) => p.exists) ?? null;
    }
  }
  if (!entry) return null;
  if (MODE === 'hosted' && !isInside(userProjectsDir(userId), entry.path)) return null;
  return entry;
}

/** The absolute project root for this request, or null. */
export async function projectRootOrNull(req: FastifyRequest): Promise<string | null> {
  const entry = await projectEntryFor(req);
  if (!entry) return null;
  return (await dirExists(entry.path)) ? entry.path : null;
}

/** The absolute project root for this request; throws NoProjectError otherwise. */
export async function projectRootFor(req: FastifyRequest): Promise<string> {
  const root = await projectRootOrNull(req);
  if (!root) throw new NoProjectError();
  return root;
}

/**
 * Resolve a path inside the request's project, refusing any path that
 * escapes the project root (path traversal protection).
 */
export async function resolveInsideProject(req: FastifyRequest, relative: string): Promise<string> {
  const root = await projectRootFor(req);
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path ${relative} escapes project root`);
  }
  return resolved;
}
