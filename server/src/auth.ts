/**
 * Identity for hosted mode (docs/plans/hosted-authoring.md §8.2).
 *
 * People sign in with their CHT credentials against one of the CHT_INSTANCES,
 * the way cht-user-management does (chtAuth.ts makes the checks). There is no
 * sign-up and no password stored here: an account is just (instance, CHT
 * username), created on first successful login, and its id is derived from
 * that pair so the same person lands on the same projects every time.
 *
 * A session is a random bearer token the client stores and sends on every
 * request. Tokens ride the `Authorization` header — the one place cross-origin
 * cookies would need SameSite=None + credentialed CORS, a header just works.
 * The single exception is the run-output SSE stream: `EventSource` cannot set
 * headers, so that route (and only that route) also accepts `?token=`.
 *
 * Storage is two JSON files under DATA_ROOT/auth; only the sha256 of a token is
 * stored, so the files leaking does not hand out live sessions. Writes are
 * serialised through one promise chain so concurrent logins cannot clobber
 * each other.
 *
 * Desktop mode has no accounts: the hook stamps every request with the
 * implicit local user and the sign-in route answers 400.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { ChtLoginError, loginToCht } from './chtAuth.js';
import {
  authDir,
  CHT_INSTANCES,
  CHT_REQUIRED_PERMISSIONS,
  LOCAL_USER_ID,
  MODE,
  SESSION_TTL_MS,
} from './config.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every /api request. */
    userId: string;
  }
}

export interface UserRecord {
  id: string;
  /** CHT instance base URL, one of CHT_INSTANCES at the time of first login. */
  instance: string;
  /** CHT username on that instance. */
  username: string;
  createdAt: string;
  lastLoginAt: string;
}

interface UsersFile {
  users: UserRecord[];
}

interface SessionsFile {
  /** keyed by sha256(token) */
  sessions: Record<string, { userId: string; createdAt: number }>;
}

const USERS = () => path.join(authDir(), 'users.json');
const SESSIONS = () => path.join(authDir(), 'sessions.json');

let writeChain: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Stable per (instance, username), so re-logging-in finds the same projects.
 * base64url of a sha256 prefix: within SAFE_ID_RE and safe as a path segment.
 */
export function userIdFor(instance: string, username: string): string {
  return `u_${createHash('sha256').update(`${instance}\n${username}`).digest('base64url').slice(0, 24)}`;
}

export interface PublicUser {
  id: string;
  /** CHT username. */
  name: string;
  /** Host of the CHT instance the user signed in against. */
  instance: string;
}

function publicUser(u: UserRecord): PublicUser {
  return { id: u.id, name: u.username, instance: new URL(u.instance).host };
}

/** The instances a person may sign in against, for the sign-in form. */
export function signInInstances(): { url: string; label: string }[] {
  return CHT_INSTANCES.map((url) => ({ url, label: new URL(url).host }));
}

export async function login(
  instanceRaw: string,
  usernameRaw: string,
  password: string,
): Promise<{ user: PublicUser; token: string }> {
  const instance = CHT_INSTANCES.find((i) => i === String(instanceRaw ?? '').replace(/\/+$/, ''));
  if (!instance) throw new AuthError(400, 'Choose a CHT instance to sign in to.');
  // CHT usernames are lower case; people type them however they like.
  const username = String(usernameRaw ?? '')
    .trim()
    .toLowerCase();
  if (!username || typeof password !== 'string' || !password) {
    throw new AuthError(400, 'Enter your CHT username and password.');
  }
  try {
    await loginToCht(instance, username, password, CHT_REQUIRED_PERMISSIONS);
  } catch (e) {
    if (e instanceof ChtLoginError) throw new AuthError(e.status, e.message);
    throw e;
  }
  const id = userIdFor(instance, username);
  const user = await serialised(async () => {
    const file = await readJson<UsersFile>(USERS(), { users: [] });
    const now = new Date().toISOString();
    let u = file.users.find((x) => x.id === id);
    if (u) u.lastLoginAt = now;
    else {
      u = { id, instance, username, createdAt: now, lastLoginAt: now };
      file.users.push(u);
    }
    await writeJson(USERS(), file);
    return u;
  });
  const token = await issueToken(user.id);
  return { user: publicUser(user), token };
}

async function issueToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await serialised(async () => {
    const file = await readJson<SessionsFile>(SESSIONS(), { sessions: {} });
    const now = Date.now();
    for (const [k, s] of Object.entries(file.sessions)) {
      if (now - s.createdAt > SESSION_TTL_MS) delete file.sessions[k];
    }
    file.sessions[tokenKey(token)] = { userId, createdAt: now };
    await writeJson(SESSIONS(), file);
  });
  return token;
}

export async function logout(token: string): Promise<void> {
  await serialised(async () => {
    const file = await readJson<SessionsFile>(SESSIONS(), { sessions: {} });
    delete file.sessions[tokenKey(token)];
    await writeJson(SESSIONS(), file);
  });
}

export async function userForToken(token: string): Promise<PublicUser | null> {
  const sessions = await readJson<SessionsFile>(SESSIONS(), { sessions: {} });
  const s = sessions.sessions[tokenKey(token)];
  if (!s || Date.now() - s.createdAt > SESSION_TTL_MS) return null;
  const users = await readJson<UsersFile>(USERS(), { users: [] });
  // Pre-CHT-login records (email + password) have no instance: not a live account.
  const u = users.users.find((x) => x.id === s.userId && x.instance);
  return u ? publicUser(u) : null;
}

export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Bearer token from the header, falling back to `?token=` (SSE only). */
export function tokenFromRequest(req: FastifyRequest, allowQuery: boolean): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim() || null;
  if (allowQuery) {
    const q = (req.query as Record<string, unknown> | undefined)?.token;
    if (typeof q === 'string' && q) return q;
  }
  return null;
}

/** Routes that must work without a token. */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/instances',
  '/api/auth/login',
  '/api/auth/me',
]);
/** Routes that may take the token in the query string (EventSource cannot set headers). */
const QUERY_TOKEN_RE = /^\/api\/cht-conf\/runs\/[^/]+\/stream$/;

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.decorateRequest('userId', '');

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/')) return; // static client assets
    if (MODE === 'desktop') {
      req.userId = LOCAL_USER_ID;
      return;
    }
    const token = tokenFromRequest(req, QUERY_TOKEN_RE.test(url));
    const user = token ? await userForToken(token) : null;
    if (user) {
      req.userId = user.id;
      return;
    }
    if (PUBLIC_PATHS.has(url)) return;
    return reply.code(401).send({ error: 'Sign in to continue.' });
  });

  app.get('/api/auth/me', async (req) => {
    if (MODE === 'desktop')
      return { mode: MODE, user: { id: LOCAL_USER_ID, name: null, instance: null } };
    const token = tokenFromRequest(req, false);
    const user = token ? await userForToken(token) : null;
    return { mode: MODE, user };
  });

  app.get('/api/auth/instances', async () => ({
    instances: MODE === 'hosted' ? signInInstances() : [],
  }));

  app.post<{ Body: { instance?: string; username?: string; password?: string } }>(
    '/api/auth/login',
    async (req, reply) => {
      if (MODE === 'desktop')
        return reply.code(400).send({ error: 'Accounts are not used in desktop mode.' });
      try {
        return await login(
          req.body?.instance ?? '',
          req.body?.username ?? '',
          req.body?.password ?? '',
        );
      } catch (e) {
        return sendAuthError(reply, e);
      }
    },
  );

  app.post('/api/auth/logout', async (req) => {
    const token = tokenFromRequest(req, false);
    if (token) await logout(token);
    return { ok: true };
  });
}

function sendAuthError(reply: FastifyReply, e: unknown) {
  if (e instanceof AuthError) return reply.code(e.status).send({ error: e.message });
  return reply.code(500).send({ error: (e as Error).message });
}
