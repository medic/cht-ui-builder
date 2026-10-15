/**
 * Log a person in against a CHT instance with their CHT credentials — the
 * same checks cht-user-management makes (src/lib/cht-session.ts there):
 *
 *   1. POST <instance>/_session            the password is right
 *   2. GET  <instance>/medic/org.couchdb.user:<name>   their CHT roles
 *   3. GET  <instance>/api/v1/settings     which roles hold which permissions
 *
 * and they are let in when they are an admin or every required permission is
 * granted to one of their roles. The CHT session cookie is used for those two
 * reads and then dropped (DELETE /_session); nothing from CHT is stored, and
 * the UI Builder session that follows is the app's own bearer token.
 */
/* global fetch, AbortSignal -- Node 22 globals; the lint config only declares the older ones */
import { URL } from 'node:url';

/** Roles CHT treats as all-permissions, as in cht-user-management. */
export const ADMIN_ROLES = ['_admin', 'admin'];

const TIMEOUT_MS = 15_000;

export class ChtLoginError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ChtIdentity {
  instance: string;
  username: string;
  roles: string[];
}

export async function loginToCht(
  instance: string,
  username: string,
  password: string,
  requiredPermissions: string[],
): Promise<ChtIdentity> {
  const host = new URL(instance).host;
  const url = (p: string) => `${instance}/${p}`;

  let cookie: string;
  let sessionRoles: string[] = [];
  try {
    const res = await fetch(url('_session'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name: username, password }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) throw new ChtLoginError(401, 'Username or password is incorrect.');
    if (!res.ok) throw new ChtLoginError(502, `${host} refused the sign-in (HTTP ${res.status}).`);
    const auth = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .find((c) => c.startsWith('AuthSession='));
    if (!auth) throw new ChtLoginError(502, `${host} did not return a session.`);
    cookie = auth;
    const body = (await res.json().catch(() => ({}))) as { roles?: unknown };
    if (Array.isArray(body.roles))
      sessionRoles = body.roles.filter((r): r is string => typeof r === 'string');
  } catch (e) {
    throw asLoginError(e, host);
  }

  try {
    const get = async (p: string) =>
      fetch(url(p), {
        headers: { cookie, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

    // A CouchDB server admin has no user-settings doc; their _session roles
    // (which include _admin) are enough. Everyone else is described by it.
    const userRes = await get(`medic/org.couchdb.user:${encodeURIComponent(username)}`);
    let docRoles: string[] = [];
    if (userRes.ok) {
      const doc = (await userRes.json()) as { roles?: unknown };
      if (Array.isArray(doc.roles))
        docRoles = doc.roles.filter((r): r is string => typeof r === 'string');
    } else if (userRes.status !== 404) {
      throw new ChtLoginError(
        502,
        `Could not read your CHT user from ${host} (HTTP ${userRes.status}).`,
      );
    }
    const roles = [...new Set([...sessionRoles, ...docRoles])];

    if (!roles.some((r) => ADMIN_ROLES.includes(r))) {
      const settingsRes = await get('api/v1/settings');
      if (!settingsRes.ok) {
        throw new ChtLoginError(
          403,
          `${host} would not share its permissions with this user (HTTP ${settingsRes.status}).`,
        );
      }
      const settings = (await settingsRes.json()) as { permissions?: Record<string, unknown> };
      const missing = missingPermissions(roles, settings.permissions ?? {}, requiredPermissions);
      if (missing.length) {
        throw new ChtLoginError(403, `Your CHT user on ${host} is missing: ${missing.join(', ')}.`);
      }
    }
    return { instance, username, roles };
  } catch (e) {
    throw asLoginError(e, host);
  } finally {
    // Best effort: the session was only needed for the reads above. Awaited
    // (briefly) so a login never leaves a live CHT session behind it.
    await fetch(url('_session'), {
      method: 'DELETE',
      headers: { cookie },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }
}

/** Required permissions that none of `roles` is granted in `permissions`. */
export function missingPermissions(
  roles: string[],
  permissions: Record<string, unknown>,
  required: string[],
): string[] {
  return required.filter((p) => {
    const granted = permissions[p];
    return !(Array.isArray(granted) && granted.some((r) => roles.includes(r as string)));
  });
}

function asLoginError(e: unknown, host: string): ChtLoginError {
  if (e instanceof ChtLoginError) return e;
  const name = (e as Error)?.name;
  if (name === 'TimeoutError' || name === 'AbortError')
    return new ChtLoginError(504, `${host} did not answer in time.`);
  return new ChtLoginError(502, `Could not reach ${host}.`);
}
