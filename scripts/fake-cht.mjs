/**
 * Just enough of a CHT instance to sign in against (server/src/chtAuth.ts):
 * POST/DELETE /_session, GET /medic/org.couchdb.user:<name>, GET /api/v1/settings.
 * Used by scripts/hosted-acceptance.mjs, the hosted Playwright config and
 * server/src/chtAuth.test.ts — nothing real is needed to test hosted sign-in.
 *
 * Users (password is always `<name>-pass`):
 *   alice, bob   role program_officer → holds can_configure
 *   po-<anything> likewise — so each browser test can be a fresh account
 *   chw          role chw             → does not
 *   admin        CouchDB server admin: _admin in _session, no user-settings doc
 *
 *   node scripts/fake-cht.mjs [port]      standalone, default 5995
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const FAKE_CHT_USERS = {
  alice: ['program_officer'],
  bob: ['program_officer'],
  chw: ['chw'],
};
const SERVER_ADMINS = ['admin'];
const rolesOf = (name) =>
  FAKE_CHT_USERS[name] ?? (/^po-[a-z0-9-]+$/.test(name) ? ['program_officer'] : undefined);
const PERMISSIONS = { can_configure: ['program_officer'], can_edit: ['program_officer', 'chw'] };

export function startFakeCht(port = 0) {
  const sessions = new Map(); // cookie value → username
  const stats = { logins: 0, logouts: 0 };

  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const cookie = /AuthSession=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const who = cookie ? sessions.get(cookie) : undefined;
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/_session' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const { name, password } = JSON.parse(raw || '{}');
      const known = !!rolesOf(name) || SERVER_ADMINS.includes(name);
      if (!known || password !== `${name}-pass`)
        return send(401, { error: 'unauthorized', reason: 'Name or password is incorrect.' });
      const token = randomBytes(12).toString('hex');
      sessions.set(token, name);
      stats.logins++;
      const roles = SERVER_ADMINS.includes(name) ? ['_admin'] : rolesOf(name);
      return send(
        200,
        { ok: true, name, roles },
        { 'set-cookie': `AuthSession=${token}; Version=1; Path=/; HttpOnly` },
      );
    }
    if (url.pathname === '/_session' && req.method === 'DELETE') {
      if (cookie) sessions.delete(cookie);
      stats.logouts++;
      return send(200, { ok: true });
    }
    if (!who) return send(401, { error: 'unauthorized' });

    const userDoc = /^\/medic\/org\.couchdb\.user:(.+)$/.exec(url.pathname);
    if (userDoc && req.method === 'GET') {
      const name = decodeURIComponent(userDoc[1]);
      if (name !== who && !SERVER_ADMINS.includes(who)) return send(403, { error: 'forbidden' });
      if (!rolesOf(name)) return send(404, { error: 'not_found' });
      return send(200, {
        _id: `org.couchdb.user:${name}`,
        name,
        type: 'user-settings',
        roles: rolesOf(name),
      });
    }
    if (url.pathname === '/api/v1/settings' && req.method === 'GET') {
      return send(200, { permissions: PERMISSIONS });
    }
    return send(404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({
        url: `http://127.0.0.1:${p}`,
        stats,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cht = await startFakeCht(Number(process.argv[2] ?? 5995));
  console.log(`fake CHT listening on ${cht.url}`);
}
