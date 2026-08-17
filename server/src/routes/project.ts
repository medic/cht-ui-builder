/**
 * Project routes: open, close, current state, list project files at a glance.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getProjectPath, setProjectPath } from '../state.js';
import { isPlaceholderFormFile } from '@cht-ui/shared';
import { getParsedForm, directorySignature } from '../parsedFormCache.js';

/** Minimal shape returned to the client when describing a project. */
interface ProjectInfo {
  path: string;
  name: string;
  hasAppSettings: boolean;
  hasAppForms: boolean;
  hasContactForms: boolean;
  hasTasks: boolean;
  hasContactSummary: boolean;
  /**
   * Choices reachable from contact-injected fields. Keyed by the surveyed
   * field's `name` (e.g. "sex"); the value is the ordered list of choice
   * `name`s from the corresponding select_one / select_multiple row in any
   * `forms/contact/*.xlsx`. Used by the FormEditor condition builder to
   * surface a values dropdown for `inputs/contact/<name>`-style calculates
   * whose source row lives in a different form. Last-write-wins on name
   * collision across contact forms (documented limitation; path-suffix
   * matching is a future-sprint refinement).
   */
  contactFieldChoices: Record<string, string[]>;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function dirHasFiles(p: string, extensions: string[]): Promise<boolean> {
  try {
    const entries = await fs.readdir(p);
    return entries.some((e) => extensions.some((ext) => e.toLowerCase().endsWith(ext)));
  } catch {
    return false;
  }
}

async function describeProject(projectPath: string): Promise<ProjectInfo> {
  return {
    path: projectPath,
    name: path.basename(projectPath),
    hasAppSettings: await fileExists(path.join(projectPath, 'app_settings', 'base_settings.json')),
    hasAppForms: await dirHasFiles(path.join(projectPath, 'forms', 'app'), ['.xlsx']),
    hasContactForms: await dirHasFiles(path.join(projectPath, 'forms', 'contact'), ['.xlsx']),
    hasTasks: await fileExists(path.join(projectPath, 'tasks.js')),
    hasContactSummary: await fileExists(path.join(projectPath, 'contact-summary.templated.js')),
    contactFieldChoices: await scanContactFieldChoices(projectPath),
  };
}

/**
 * Tier-1b derived-result cache for `scanContactFieldChoices`. Keyed by the
 * project path + the contact-forms directory signature (stat-only). If no
 * `.xlsx` under `forms/contact` has changed, the previous result is
 * byte-equivalent and we skip the merged-map work entirely.
 */
const contactChoicesCache = new Map<
  string,
  { signature: string; choices: Record<string, string[]> }
>();

/**
 * Walks `forms/contact/*.xlsx` and indexes their select_one / select_multiple
 * rows into `{ [rowName]: choiceNames[] }`. Pure read; no XLSForm bytes are
 * mutated. Failures (unreadable directory, bad workbook) degrade silently to
 * an empty map — the condition builder's free-text fallback remains the
 * safety net.
 */
async function scanContactFieldChoices(
  projectPath: string,
): Promise<Record<string, string[]>> {
  const contactDir = path.join(projectPath, 'forms', 'contact');
  const signature = (await directorySignature(contactDir)) ?? '∅';
  const hit = contactChoicesCache.get(projectPath);
  if (hit && hit.signature === signature) return hit.choices;

  let entries: string[];
  try {
    entries = await fs.readdir(contactDir);
  } catch {
    contactChoicesCache.set(projectPath, { signature, choices: {} });
    return {};
  }
  const xlsxFiles = entries
    .filter((e) => e.toLowerCase().endsWith('.xlsx'))
    // `PLACE_TYPE-create.xlsx` is cht-conf's place-type SCAFFOLD, not a
    // contact form — the literal token is substituted when someone adds a
    // place type, and it is the only contact form cht-conf never compiles to
    // .xml. Parsing it as real leaked 11 choice values that exist on no
    // actual contact into this map (measured on gandaki and on our own
    // cht-default template). See shared/src/xlsform/placeholderForms.ts.
    .filter((e) => !isPlaceholderFormFile(e));
  // Parallelize per-form parsing (mirrors the forms.ts listing pattern).
  // Per-form parse routes through the shared cache; cold-start does N
  // parses, warm reads do N stats.
  const perForm = await Promise.all(
    xlsxFiles.map(async (filename) => {
      try {
        const form = await getParsedForm(path.join(contactDir, filename));
        // Index this form's choices sheet: list_name → choice names.
        const listToValues = new Map<string, string[]>();
        for (const c of form.choices) {
          if (!c.list_name || !c.name) continue;
          if (!listToValues.has(c.list_name)) listToValues.set(c.list_name, []);
          listToValues.get(c.list_name)!.push(c.name);
        }
        // Walk this form's survey rows and pick out the selects.
        const local: Record<string, string[]> = {};
        for (const r of form.survey) {
          if (!r.name) continue;
          const m = r.type.trim().match(/^(select_one|select_multiple)\s+(\S+)/i);
          if (!m) continue;
          const vals = listToValues.get(m[2]!);
          if (vals && vals.length > 0) local[r.name] = vals;
        }
        return local;
      } catch {
        // Unparseable workbook → skip silently; this is best-effort enrichment.
        return {};
      }
    }),
  );
  // Merge (last-write-wins on collision — documented limitation).
  const merged: Record<string, string[]> = {};
  for (const local of perForm) Object.assign(merged, local);
  contactChoicesCache.set(projectPath, { signature, choices: merged });
  return merged;
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/project', async () => {
    const projectPath = await getProjectPath();
    if (!projectPath) return { open: false };
    const exists = await fileExists(projectPath);
    if (!exists) {
      await setProjectPath(null);
      return { open: false, error: 'previous project path no longer exists' };
    }
    // eslint-disable-next-line no-undef
    const t0 = performance.now();
    const project = await describeProject(projectPath);
    // eslint-disable-next-line no-undef
    app.log.info({ ms: +(performance.now() - t0).toFixed(1) }, 'GET /api/project (describeProject)');
    return { open: true, project };
  });

  app.post<{ Body: { path: string } }>(
    '/api/project/open',
    {
      schema: {
        body: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      const requested = req.body.path;
      const abs = path.resolve(requested);
      if (!(await fileExists(abs))) {
        return reply.code(400).send({ error: `Path does not exist: ${abs}` });
      }
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: `Path is not a directory: ${abs}` });
      }
      await setProjectPath(abs);
      // eslint-disable-next-line no-undef
      const t0 = performance.now();
      const project = await describeProject(abs);
      // eslint-disable-next-line no-undef
      app.log.info({ ms: +(performance.now() - t0).toFixed(1) }, 'POST /api/project/open (describeProject)');
      return { open: true, project };
    },
  );

  app.post('/api/project/close', async () => {
    await setProjectPath(null);
    return { open: false };
  });

  app.get('/api/browse/shortcuts', async () => {
    const home = os.homedir();
    const shortcuts: Array<{ label: string; path: string }> = [{ label: 'Home', path: home }];
    if (process.platform === 'win32') {
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const root = `${letter}:\\`;
        if (await fileExists(root)) shortcuts.push({ label: root, path: root });
      }
    } else {
      shortcuts.push({ label: '/', path: '/' });
    }
    return { shortcuts };
  });

  app.get<{ Querystring: { path?: string; query?: string } }>(
    '/api/browse/search',
    async (req, reply) => {
      const root = (req.query.path ?? '').trim();
      const query = (req.query.query ?? '').trim().toLowerCase();
      if (!root) return reply.code(400).send({ error: 'path is required' });
      if (!query) return { results: [] };
      const abs = path.resolve(root);
      if (!(await fileExists(abs))) {
        return reply.code(400).send({ error: `Path does not exist: ${abs}` });
      }
      const results: Array<{ path: string; name: string; isProjectRoot: boolean }> = [];
      const MAX_RESULTS = 200;
      const MAX_DEPTH = 6;
      async function walk(dir: string, depth: number): Promise<void> {
        if (results.length >= MAX_RESULTS || depth > MAX_DEPTH) return;
        let entries: import('node:fs').Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (results.length >= MAX_RESULTS) return;
          if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
          const full = path.join(dir, e.name);
          if (e.name.toLowerCase().includes(query)) {
            results.push({
              path: full,
              name: e.name,
              isProjectRoot: await isProjectRoot(full),
            });
          }
          await walk(full, depth + 1);
        }
      }
      await walk(abs, 0);
      return { results };
    },
  );

  app.get<{ Querystring: { path?: string } }>('/api/browse', async (req, reply) => {
    const requested = (req.query.path ?? '').trim();
    if (!requested) {
      if (process.platform === 'win32') {
        const drives: string[] = [];
        for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
          const root = `${letter}:\\`;
          if (await fileExists(root)) drives.push(root);
        }
        return { path: '', parent: null, entries: drives.map((d) => ({ name: d, isDirectory: true, isProjectRoot: false })) };
      }
      return { path: '/', parent: null, entries: await listDirEntries('/') };
    }
    const abs = path.resolve(requested);
    if (!(await fileExists(abs))) {
      return reply.code(400).send({ error: `Path does not exist: ${abs}` });
    }
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) {
      return reply.code(400).send({ error: `Path is not a directory: ${abs}` });
    }
    const parent = path.dirname(abs);
    return {
      path: abs,
      parent: parent === abs ? null : parent,
      entries: await listDirEntries(abs),
    };
  });

  app.post<{ Body: { path: string; name: string } }>(
    '/api/browse/mkdir',
    {
      schema: {
        body: {
          type: 'object',
          required: ['path', 'name'],
          properties: {
            path: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const parent = path.resolve(req.body.path.trim());
      const name = req.body.name.trim();
      // Reject anything that could escape the parent or isn't a plain folder name.
      if (name === '.' || name === '..' || /[\\/]/.test(name) || name.includes('\0')) {
        return reply.code(400).send({ error: `Invalid folder name: ${req.body.name}` });
      }
      if (!(await fileExists(parent))) {
        return reply.code(400).send({ error: `Parent folder does not exist: ${parent}` });
      }
      if (!(await fs.stat(parent)).isDirectory()) {
        return reply.code(400).send({ error: `Parent is not a directory: ${parent}` });
      }
      const target = path.join(parent, name);
      // Defense in depth: the new folder must land directly under the parent.
      if (path.dirname(target) !== parent) {
        return reply.code(400).send({ error: `Invalid folder name: ${req.body.name}` });
      }
      if (await fileExists(target)) {
        return reply.code(409).send({ error: `A folder named "${name}" already exists here.` });
      }
      try {
        await fs.mkdir(target);
      } catch (e) {
        return reply.code(500).send({ error: `Could not create folder: ${(e as Error).message}` });
      }
      return { path: target };
    },
  );
}

async function isProjectRoot(p: string): Promise<boolean> {
  return fileExists(path.join(p, 'app_settings', 'base_settings.json'));
}

async function listDirEntries(
  dir: string,
): Promise<Array<{ name: string; isDirectory: boolean; isProjectRoot: boolean }>> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(
    dirs.map(async (e) => ({
      name: e.name,
      isDirectory: true,
      isProjectRoot: await isProjectRoot(path.join(dir, e.name)),
    })),
  );
}
