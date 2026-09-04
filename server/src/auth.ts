/**
 * Identity for hosted mode (docs/plans/hosted-authoring.md §8.2).
 *
 * Durable identity, no roles: an account is an email + password; a session is
 * a random bearer token the client stores and sends on every request. Tokens
 * ride the `Authorization` header — the one place cross-origin cookies would
 * need SameSite=None + credentialed CORS, a header just works. The single
 * exception is the run-output SSE stream: `EventSource` cannot set headers, so
 * that route (and only that route) also accepts `?token=`.
 *
 * Storage is two JSON files under DATA_ROOT/auth. Passwords are scrypt-hashed
 * with a per-user salt; only the sha256 of a token is stored, so the files
 * leaking does not hand out live sessions. Writes are serialised through one
 * promise chain so concurrent sign-ups cannot clobber each other.
 *
 * Desktop mode has no accounts: the hook stamps every request with the
 * implicit local user and the sign-up / sign-in routes answer 400.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { authDir, LOCAL_USER_ID, MODE, SESSION_TTL_MS } from './config.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every /api request. */
    userId: string;
  }
}

export interface UserRecord {
  id: string;
  email: string;
  /** `<saltHex>:<hashHex>` */
  passwordHash: string;
  createdAt: string;
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

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, '')}`;
}

export interface PublicUser {
  id: string;
  email: string;
}

function publicUser(u: UserRecord): PublicUser {
  return { id: u.id, email: u.email };
}

export async function signup(
  emailRaw: string,
  password: string,
): Promise<{ user: PublicUser; token: string }> {
  const email = normaliseEmail(emailRaw);
  if (!EMAIL_RE.test(email)) throw new AuthError(400, 'Enter a valid email address.');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new AuthError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  }
  const passwordHash = await hashPassword(password);
  const user = await serialised(async () => {
    const file = await readJson<UsersFile>(USERS(), { users: [] });
    if (file.users.some((u) => u.email === email)) {
      throw new AuthError(409, 'An account with that email already exists. Sign in instead.');
    }
    const u: UserRecord = { id: newId('u'), email, passwordHash, createdAt: new Date().toISOString() };
    file.users.push(u);
    await writeJson(USERS(), file);
    return u;
  });
  const token = await issueToken(user.id);
  return { user: publicUser(user), token };
}

export async function login(
  emailRaw: string,
  password: string,
): Promise<{ user: PublicUser; token: string }> {
  const email = normaliseEmail(emailRaw);
  const file = await readJson<UsersFile>(USERS(), { users: [] });
  const user = file.users.find((u) => u.email === email);
  // Same message either way — do not reveal which emails have accounts.
  if (!user || !(await verifyPassword(password ?? '', user.passwordHash))) {
    throw new AuthError(401, 'Email or password is incorrect.');
  }
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
  const u = users.users.find((x) => x.id === s.userId);
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
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/signup', '/api/auth/login', '/api/auth/me']);
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
    if (MODE === 'desktop') return { mode: MODE, user: { id: LOCAL_USER_ID, email: null } };
    const token = tokenFromRequest(req, false);
    const user = token ? await userForToken(token) : null;
    return { mode: MODE, user };
  });

  app.post<{ Body: { email?: string; password?: string } }>('/api/auth/signup', async (req, reply) => {
    if (MODE === 'desktop') return reply.code(400).send({ error: 'Accounts are not used in desktop mode.' });
    try {
      return await signup(req.body?.email ?? '', req.body?.password ?? '');
    } catch (e) {
      return sendAuthError(reply, e);
    }
  });

  app.post<{ Body: { email?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
    if (MODE === 'desktop') return reply.code(400).send({ error: 'Accounts are not used in desktop mode.' });
    try {
      return await login(req.body?.email ?? '', req.body?.password ?? '');
    } catch (e) {
      return sendAuthError(reply, e);
    }
  });

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
