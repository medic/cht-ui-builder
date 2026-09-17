/**
 * Project routes: the per-user registry (list / open / rename / forget),
 * the project a request names, and desktop-only open-by-path. Folder browsing
 * lives in browse.ts and is registered only in desktop mode.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MODE } from '../config.js';
import {
  clearLastOpened,
  getProject,
  listProjects,
  projectEntryFor,
  registerProject,
  removeProject,
  renameProject,
  touchProject,
  type ProjectEntry,
} from '../state.js';
import { isPlaceholderFormFile } from '@cht-ui/shared';
import { getParsedForm, directorySignature } from '../parsedFormCache.js';

/** Minimal shape returned to the client when describing a project. */
export interface ProjectInfo {
  /** Registry id — what the client sends back as x-project-id. */
  id: string;
  /** Empty in hosted mode: no filesystem path crosses the wire. */
  path: string;
  name: string;
  source: ProjectEntry['source'];
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

async function describeProject(projectPath: string): Promise<Omit<ProjectInfo, 'id' | 'source'>> {
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

/** What the client needs to show a project: description + registry identity. */
export async function describeEntry(entry: ProjectEntry): Promise<ProjectInfo> {
  const info = await describeProject(entry.path);
  return {
    ...info,
    id: entry.id,
    name: entry.name,
    source: entry.source,
    // No filesystem path crosses the wire in hosted mode.
    path: MODE === 'hosted' ? '' : info.path,
  };
}

function publicEntry(p: ProjectEntry & { exists?: boolean }) {
  return {
    id: p.id,
    name: p.name,
    source: p.source,
    origin: p.origin,
    createdAt: p.createdAt,
    lastOpenedAt: p.lastOpenedAt,
    exists: p.exists ?? true,
    ...(MODE === 'desktop' ? { path: p.path } : {}),
  };
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The project this request names (x-project-id). In desktop mode with no
   * header this is the most recently opened project, so a fresh tab lands in
   * the folder the user last had open.
   */
  app.get('/api/project', async (req) => {
    const entry = await projectEntryFor(req);
    if (!entry) return { open: false };
    if (!(await fileExists(entry.path))) {
      return {
        open: false,
        error:
          MODE === 'desktop'
            ? `project folder no longer exists: ${entry.path}`
            : 'project folder no longer exists',
      };
    }
    // eslint-disable-next-line no-undef
    const t0 = performance.now();
    const project = await describeEntry(entry);
    // eslint-disable-next-line no-undef
    app.log.info({ ms: +(performance.now() - t0).toFixed(1) }, 'GET /api/project (describeProject)');
    return { open: true, project, projectId: entry.id };
  });

  /** This user's registry, most recently opened first. */
  app.get('/api/projects', async (req) => {
    const projects = await listProjects(req.userId);
    return { mode: MODE, projects: projects.map(publicEntry) };
  });

  app.post<{ Body: { id: string } }>(
    '/api/projects/open',
    {
      schema: {
        body: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      const existing = await getProject(req.userId, req.body.id);
      if (!existing) return reply.code(404).send({ error: 'Project not found.' });
      if (!(await fileExists(existing.path))) {
        return reply.code(400).send({ error: 'This project folder no longer exists.' });
      }
      const entry = (await touchProject(req.userId, req.body.id)) ?? existing;
      return { open: true, project: await describeEntry(entry), projectId: entry.id };
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string } }>(
    '/api/projects/:id',
    async (req, reply) => {
      const name = (req.body?.name ?? '').trim();
      if (!name) return reply.code(400).send({ error: 'name is required' });
      const entry = await renameProject(req.userId, req.params.id, name);
      if (!entry) return reply.code(404).send({ error: 'Project not found.' });
      return { ok: true, project: publicEntry(entry) };
    },
  );

  /**
   * Forget a project; `?files=1` also deletes it from disk when it lives
   * under this user's projects dir. A desktop folder the user opened by path
   * is only ever forgotten.
   */
  app.delete<{ Params: { id: string }; Querystring: { files?: string } }>(
    '/api/projects/:id',
    async (req, reply) => {
      const result = await removeProject(req.userId, req.params.id, req.query.files === '1');
      if (!result.removed) return reply.code(404).send({ error: 'Project not found.' });
      return { ok: true, ...result };
    },
  );

  if (MODE === 'desktop') {
    /** Desktop only: open a folder on this machine by absolute path. */
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
        const abs = path.resolve(req.body.path);
        if (!(await fileExists(abs))) {
          return reply.code(400).send({ error: `Path does not exist: ${abs}` });
        }
        const stat = await fs.stat(abs);
        if (!stat.isDirectory()) {
          return reply.code(400).send({ error: `Path is not a directory: ${abs}` });
        }
        const entry = await registerProject(req.userId, {
          name: path.basename(abs),
          path: abs,
          source: 'local',
        });
        // eslint-disable-next-line no-undef
        const t0 = performance.now();
        const project = await describeEntry(entry);
        // eslint-disable-next-line no-undef
        app.log.info({ ms: +(performance.now() - t0).toFixed(1) }, 'POST /api/project/open (describeProject)');
        return { open: true, project, projectId: entry.id };
      },
    );
  }

  /**
   * Closing: the tab forgets its project id client-side, and in desktop mode
   * the server also forgets which project a request with no id resolves to —
   * otherwise a reload after "Change project" lands straight back inside it.
   * Hosted mode has no such fallback, so there it is a no-op.
   */
  app.post('/api/project/close', async (req) => {
    if (MODE === 'desktop') await clearLastOpened(req.userId);
    return { open: false };
  });
}
