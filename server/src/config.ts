/**
 * Server mode and on-disk layout. Read once from the environment.
 *
 * Two modes, one codebase (docs/plans/hosted-authoring.md §4: "the desktop
 * app stays"):
 *
 *   desktop  (default)  one implicit user, projects anywhere on this machine,
 *                       opened by absolute path or the folder browser.
 *                       State under ~/.cht-ui-builder/.
 *   hosted              many users behind bearer-token auth; every project is
 *                       created, imported or cloned INTO
 *                       DATA_ROOT/users/<userId>/projects/<folder>, and no
 *                       filesystem path ever crosses the wire. The folder
 *                       browser and open-by-path routes are not registered.
 *
 * The layout is identical in both modes so every route resolves a project the
 * same way; only what may be *registered* differs.
 */
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';

export type ServerMode = 'desktop' | 'hosted';

export const MODE: ServerMode = process.env.CHT_UI_MODE === 'hosted' ? 'hosted' : 'desktop';

export const DATA_ROOT: string =
  MODE === 'hosted'
    ? path.resolve(process.env.DATA_ROOT ?? '/data')
    : path.resolve(process.env.DATA_ROOT ?? path.join(os.homedir(), '.cht-ui-builder'));

/** The one user in desktop mode. */
export const LOCAL_USER_ID = 'local';

/** Serve client/dist from this server (single-container deployment). */
export const SERVE_CLIENT = process.env.SERVE_CLIENT === '1';

/** Extra CORS origins (comma-separated), e.g. the Vercel deployment of the client. */
export const CORS_ORIGINS: string[] = (process.env.CORS_ORIGIN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Hosted sign-in is against a CHT instance, the way cht-user-management does
 * it: a person logs in with their CHT username and password, and is let in if
 * that instance says they hold every permission in CHT_REQUIRED_PERMISSIONS
 * (admins always are). Only instances listed here can be logged in against —
 * otherwise the login form would relay passwords to any URL a caller names.
 *
 *   CHT_INSTANCES             comma-separated base URLs, e.g.
 *                             https://a.dev.medicmobile.org,https://b.dev.medicmobile.org
 *   CHT_REQUIRED_PERMISSIONS  comma-separated, default can_configure
 */
export const CHT_INSTANCES: string[] = parseInstances(process.env.CHT_INSTANCES ?? '');

export const CHT_REQUIRED_PERMISSIONS: string[] = (
  process.env.CHT_REQUIRED_PERMISSIONS ?? 'can_configure'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function parseInstances(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const u = new URL(s); // throws on garbage: better at boot than at the first login
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
      throw new Error(`CHT_INSTANCES: not http(s): ${s}`);
    if (u.username || u.password)
      throw new Error(`CHT_INSTANCES: credentials are not allowed in ${u.host}`);
    const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    if (!out.includes(base)) out.push(base);
  }
  return out;
}

/** Session lifetime for hosted bearer tokens. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-project size budget on import (docs/plans/hosted-authoring.md §6.5). */
export const IMPORT_MAX_BYTES = Number(process.env.IMPORT_MAX_BYTES ?? 100 * 1024 * 1024);

/**
 * User ids are path segments. Auth generates them; this is the guard every
 * layout function applies so a forged id can never leave DATA_ROOT/users.
 */
export const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function assertSafeId(id: string, what = 'id'): string {
  if (!SAFE_ID_RE.test(id)) throw new Error(`invalid ${what}`);
  return id;
}

export function userDir(userId: string): string {
  return path.join(DATA_ROOT, 'users', assertSafeId(userId, 'user id'));
}

export function userProjectsDir(userId: string): string {
  return path.join(userDir(userId), 'projects');
}

export function authDir(): string {
  return path.join(DATA_ROOT, 'auth');
}

/** True when `child` is `parent` or lies beneath it (after resolution). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
