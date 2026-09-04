/**
 * Acceptance for hosted, multi-user authoring (docs/plans/hosted-authoring.md §12),
 * at the API level. Spawns the built server twice — once per mode — against
 * throwaway data dirs, then drives it with fetch:
 *
 *   hosted   two users sign up; A starts blank and adds a form; B imports the
 *            mini-config fixture as a zip; A cannot list, open or read B's
 *            project by any route; both projects answer independently (two
 *            tabs, two projects); B exports a zip; a zip-slip entry is refused;
 *            no filesystem path crosses the wire; delete removes the files.
 *   desktop  no accounts; open-by-path works; a fresh request with no project
 *            id falls back to the last-opened project; the folder browser is
 *            registered.
 *
 * Usage:  node scripts/hosted-acceptance.mjs        (server must be built)
 * Exits nonzero on the first failed assertion.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SERVER = path.join(REPO, 'server', 'dist', 'index.js');
const FIXTURE = path.join(REPO, 'client', 'tests', 'fixtures', 'mini-config');
const AdmZip = createRequire(path.join(REPO, 'server', 'package.json'))('adm-zip');

if (!existsSync(SERVER)) {
  console.error(`server not built: ${SERVER}`);
  process.exit(2);
}

let failures = 0;
function check(cond, label, extra = '') {
  if (cond) console.log(`ok    ${label}`);
  else {
    failures++;
    console.error(`FAIL  ${label}${extra ? `\n      ${extra}` : ''}`);
  }
}

async function startServer(mode, dataRoot, port) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CHT_UI_MODE: mode, DATA_ROOT: dataRoot, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => (log += b));
  child.stderr.on('data', (b) => (log += b));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return { child, base, log: () => log };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`server (${mode}) did not start:\n${log}`);
}

function client(base, token, projectId) {
  const headers = () => ({
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(projectId ? { 'x-project-id': projectId } : {}),
  });
  return {
    async json(method, url, body, extraHeaders = {}) {
      const res = await fetch(base + url, {
        method,
        headers: { ...headers(), ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
      let data = null;
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: res.status, data, headers: res.headers };
    },
    async raw(url) {
      const res = await fetch(base + url, { headers: headers() });
      return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') };
    },
    with(pid) {
      return client(base, token, pid);
    },
  };
}

function zipOfFixture(rootName) {
  const z = new AdmZip();
  z.addLocalFolder(FIXTURE, rootName);
  return z.toBuffer();
}

/* ------------------------------- hosted --------------------------------- */

async function hosted() {
  const data = mkdtempSync(path.join(os.tmpdir(), 'cht-ui-hosted-'));
  const srv = await startServer('hosted', data, 5291);
  try {
    const anon = client(srv.base);
    check((await anon.json('GET', '/api/projects')).status === 401, 'hosted: unauthenticated request is 401');
    check((await anon.json('GET', '/api/browse/shortcuts')).status === 401, 'hosted: browse is not reachable unauthenticated');
    check((await anon.json('GET', '/api/auth/me')).data.mode === 'hosted', 'hosted: /api/auth/me reports the mode');

    const a = await anon.json('POST', '/api/auth/signup', { email: 'a@example.org', password: 'password-a' });
    check(a.status === 200 && a.data.token, 'user A signs up');
    check((await anon.json('POST', '/api/auth/signup', { email: 'A@Example.org', password: 'password-a' })).status === 409, 'duplicate email (case-insensitive) is 409');
    check((await anon.json('POST', '/api/auth/login', { email: 'a@example.org', password: 'wrong-wrong' })).status === 401, 'wrong password is 401');
    check((await anon.json('POST', '/api/auth/signup', { email: 'c@example.org', password: 'short' })).status === 400, 'short password is refused');
    const b = await anon.json('POST', '/api/auth/signup', { email: 'b@example.org', password: 'password-b' });
    check(b.status === 200 && b.data.token, 'user B signs up');

    const A = client(srv.base, a.data.token);
    const B = client(srv.base, b.data.token);
    check((await A.json('GET', '/api/browse/shortcuts')).status === 404, 'hosted: browse routes are not registered even when signed in');

    // A starts blank.
    const created = await A.json('POST', '/api/templates/create', { template: 'empty', name: 'Flood response 2026' });
    check(created.status === 200 && created.data.projectId, 'A starts blank (empty template)', JSON.stringify(created.data));
    const pa = created.data.projectId;
    const openedA = await A.json('POST', '/api/projects/open', { id: pa });
    check(openedA.status === 200 && openedA.data.project.name === 'Flood response 2026', 'A opens the project by id');
    check(openedA.data.project.path === '', 'hosted: no filesystem path in the project description');
    const Ap = A.with(pa);
    const form = await Ap.json('POST', '/api/forms/create', { category: 'app', basename: 'flood_survey', title: 'Flood survey', scaffold: 'default' });
    check(form.status === 200 && form.data.id === 'app:flood_survey', 'A adds a form to it');
    check((await Ap.json('GET', '/api/forms')).data.forms.some((f) => f.id === 'app:flood_survey'), 'A sees the form listed');

    // B imports the mini-config fixture as a zip (zip OF a folder → root stripped).
    const imp = await B.json('POST', '/api/projects/import-zip?name=Mini%20config', zipOfFixture('mini-config'), { 'content-type': 'application/zip' });
    check(imp.status === 200 && imp.data.projectId, 'B imports mini-config from a zip', JSON.stringify(imp.data));
    const pb = imp.data.projectId;
    const Bp = B.with(pb);
    const bForms = await Bp.json('GET', '/api/forms');
    check(bForms.status === 200 && bForms.data.forms.length > 0, 'B sees the imported forms', JSON.stringify(bForms.data).slice(0, 200));
    check(!bForms.data.forms.some((f) => f.id === 'app:flood_survey'), 'B does not see A\'s form (two projects, two tabs)');

    // Isolation.
    check((await A.json('POST', '/api/projects/open', { id: pb })).status === 404, 'A cannot open B\'s project');
    check((await A.with(pb).json('GET', '/api/forms')).status === 400, 'A cannot read B\'s forms by naming B\'s project id');
    check((await A.with(pb).json('GET', `/api/forms/${encodeURIComponent(bForms.data.forms[0].id)}`)).status === 400, 'A cannot read one of B\'s forms');
    check((await A.json('GET', `/api/projects/${pb}/export.zip`)).status === 404, 'A cannot export B\'s project');
    check((await A.json('DELETE', `/api/projects/${pb}?files=1`)).status === 404, 'A cannot delete B\'s project');
    const listA = await A.json('GET', '/api/projects');
    check(listA.data.projects.length === 1 && listA.data.projects[0].id === pa, 'A lists only their own project');
    check(!JSON.stringify(listA.data).includes('"path"'), 'hosted: no path in the project list');

    // Export.
    const exp = await B.raw(`/api/projects/${pb}/export.zip`);
    check(exp.status === 200 && (exp.type ?? '').includes('application/zip'), 'B downloads the project as a zip');
    const names = new AdmZip(exp.buf).getEntries().map((e) => e.entryName);
    check(names.includes('app_settings/base_settings.json'), 'export zip has the project at its root', names.slice(0, 5).join(', '));

    // Zip-slip.
    const evil = new AdmZip();
    evil.addFile('../../evil.txt', Buffer.from('x'));
    evil.addFile('ok/app_settings/base_settings.json', Buffer.from('{}'));
    const slip = await B.json('POST', '/api/projects/import-zip?name=slip', evil.toBuffer(), { 'content-type': 'application/zip' });
    check(slip.status === 200 || slip.status === 400, 'zip-slip import is handled');
    const escaped = readdirSync(data).includes('evil.txt') || readdirSync(path.join(data, 'users')).includes('evil.txt');
    check(!escaped, 'zip-slip entry never lands outside the project');

    // Expired/garbage token.
    check((await client(srv.base, 'not-a-token').json('GET', '/api/projects')).status === 401, 'garbage token is 401');

    // Delete with files.
    const del = await A.json('DELETE', `/api/projects/${pa}?files=1`);
    check(del.status === 200 && del.data.deletedFiles === true, 'A deletes their project with files');
    const userDirs = readdirSync(path.join(data, 'users'));
    const aProjects = userDirs.flatMap((u) => {
      const p = path.join(data, 'users', u, 'projects');
      return existsSync(p) ? readdirSync(p) : [];
    });
    check(!aProjects.some((d) => d.startsWith('flood-response')), 'deleted project folder is gone from disk');
  } finally {
    srv.child.kill();
    rmSync(data, { recursive: true, force: true });
  }
}

/* ------------------------------- desktop -------------------------------- */

async function desktop() {
  const data = mkdtempSync(path.join(os.tmpdir(), 'cht-ui-desktop-'));
  const projDir = path.join(data, 'proj');
  cpSync(FIXTURE, projDir, { recursive: true });
  const srv = await startServer('desktop', path.join(data, 'state'), 5292);
  try {
    const c = client(srv.base);
    check((await c.json('GET', '/api/auth/me')).data.user?.id === 'local', 'desktop: implicit local user, no sign-in');
    check((await c.json('GET', '/api/project')).data.open === false, 'desktop: nothing open on a fresh state');
    const opened = await c.json('POST', '/api/project/open', { path: projDir });
    check(opened.status === 200 && opened.data.projectId, 'desktop: open by absolute path', JSON.stringify(opened.data).slice(0, 200));
    check(opened.data.project.path === projDir, 'desktop: the path IS returned (it is the user\'s own disk)');
    const again = await c.json('POST', '/api/project/open', { path: projDir });
    check(again.data.projectId === opened.data.projectId, 'desktop: opening the same folder twice is one registry entry');
    const fallback = await c.json('GET', '/api/project');
    check(fallback.data.open === true && fallback.data.projectId === opened.data.projectId, 'desktop: no project id → last-opened project (fresh tab lands where you were)');
    check((await c.json('GET', '/api/forms')).status === 200, 'desktop: routes work with no x-project-id (fallback)');
    check((await c.with(opened.data.projectId).json('GET', '/api/forms')).status === 200, 'desktop: routes work with x-project-id');
    check((await c.with('p_nope').json('GET', '/api/forms')).status === 400, 'desktop: an unknown project id is refused, not silently redirected');
    check((await c.json('GET', '/api/browse/shortcuts')).status === 200, 'desktop: folder browser is available');
    const forgot = await c.json('DELETE', `/api/projects/${opened.data.projectId}?files=1`);
    check(forgot.data.removed === true && forgot.data.deletedFiles === false, 'desktop: forgetting never deletes a folder the user opened by path');
    check(existsSync(path.join(projDir, 'app_settings')), 'desktop: the folder is still on disk');
  } finally {
    srv.child.kill();
    rmSync(data, { recursive: true, force: true });
  }
}

await hosted();
await desktop();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll hosted-authoring acceptance checks passed.');
