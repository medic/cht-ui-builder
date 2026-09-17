/**
 * Project-scaffolding endpoints. Lists available starter templates and
 * creates a new cht-conf project folder by copying a template tree.
 *
 * Templates live in server/templates/<name>/ and are bundled with the
 * server. They're plain files — no token substitution at this stage —
 * because cht-conf doesn't care about a project name beyond the folder
 * basename.
 *
 * Where the copy lands depends on the mode (config.ts): hosted projects are
 * always created under the user's projects dir from a display name; desktop
 * callers name the folder. Either way the new project is registered and its
 * id returned, so the client opens it by id like any other.
 *
 * "Start blank" is the `empty` template: no contact types, no forms, nothing
 * to delete before building the use case nobody templated.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODE } from '../config.js';
import { allocateProjectDir, registerProject } from '../state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TemplateInfo {
  id: string;
  label: string;
  description: string;
  /** Form-count summary for the picker UI. */
  forms: { app: number; contact: number };
  /** True if this template ships starter content beyond the minimum scaffold. */
  hasStarterContent: boolean;
}

const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', 'templates');

/** Curated template metadata. Keep in sync with the directories in templates/. */
const TEMPLATE_REGISTRY: Record<string, Omit<TemplateInfo, 'id' | 'forms'>> = {
  empty: {
    label: 'Empty project',
    description:
      'Nothing pre-defined. Empty contact hierarchy, no contact types, no forms, no tasks, no contact-summary content. Pick this when you want to build everything from zero through the UI — including your very first place type.',
    hasStarterContent: false,
  },
  blank: {
    label: 'Blank project',
    description:
      'Minimal cht-conf scaffold: hierarchy with district / health_facility / patient, empty tasks.js and contact-summary. Start from here for a new program.',
    hasStarterContent: false,
  },
  'cht-default': {
    label: 'CHT baseline',
    description:
      'Imported from cht-core/config/default. A complete reference configuration: 4-type hierarchy (district_hospital / health_center / clinic / person), full permissions and roles, pregnancy / immunization / FP / death-reporting forms with translations, task rules, contact-summary cards. The same code that powers the default CHT instance — ready to deploy as-is or adapt.',
    hasStarterContent: true,
  },
  malaria: {
    label: 'Malaria surveillance (Nepal)',
    description:
      'CHW workflow for malaria case detection: district → municipality → health facility → patient. Includes the hierarchy, properties.json, translations (English + Nepali), a contact-summary that controls when the form appears, and a task that fires 3 days after a positive screening. The two XLSX form spreadsheets are scaffolded blank — see README.md inside the new project for the rows to add.',
    hasStarterContent: true,
  },
};

async function countFormsInTemplate(dir: string): Promise<{ app: number; contact: number }> {
  async function countXlsx(p: string): Promise<number> {
    try {
      const entries = await fs.readdir(p);
      return entries.filter((e) => e.toLowerCase().endsWith('.xlsx')).length;
    } catch {
      return 0;
    }
  }
  return {
    app: await countXlsx(path.join(dir, 'forms', 'app')),
    contact: await countXlsx(path.join(dir, 'forms', 'contact')),
  };
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      await copyDir(s, d);
    } else if (e.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function registerTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/templates', async () => {
    const dirs = await fs.readdir(TEMPLATES_DIR, { withFileTypes: true });
    const templates: TemplateInfo[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const meta = TEMPLATE_REGISTRY[d.name];
      if (!meta) continue;
      templates.push({
        id: d.name,
        ...meta,
        forms: await countFormsInTemplate(path.join(TEMPLATES_DIR, d.name)),
      });
    }
    // Registry order, not directory order: "Start blank" first.
    const order = Object.keys(TEMPLATE_REGISTRY);
    templates.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return { templates };
  });

  /**
   * Body: `{ template, name?, path? }`. Hosted: `name` (defaults to the
   * template id) picks the folder under the user's projects dir. Desktop:
   * `path` is the absolute target folder, as before.
   */
  app.post<{ Body: { template: string; name?: string; path?: string } }>(
    '/api/templates/create',
    {
      schema: {
        body: {
          type: 'object',
          required: ['template'],
          properties: {
            template: { type: 'string', minLength: 1 },
            name: { type: 'string' },
            path: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const tmpl = req.body.template;
      if (!TEMPLATE_REGISTRY[tmpl]) {
        return reply.code(400).send({ error: `Unknown template: ${tmpl}` });
      }
      const src = path.join(TEMPLATES_DIR, tmpl);
      if (!(await pathExists(src))) {
        return reply.code(500).send({ error: `Template directory missing on disk: ${src}` });
      }

      let target: string;
      let name = (req.body.name ?? '').trim();
      if (MODE === 'hosted') {
        if (!name) name = TEMPLATE_REGISTRY[tmpl].label;
        target = await allocateProjectDir(req.userId, name);
      } else {
        const p = (req.body.path ?? '').trim();
        if (!p) return reply.code(400).send({ error: 'path is required in desktop mode' });
        target = path.resolve(p);
        if (!name) name = path.basename(target);
        if (await pathExists(target)) {
          // Refuse to overwrite — too easy to clobber an existing project.
          const entries = await fs.readdir(target).catch(() => []);
          if (entries.length > 0) {
            return reply.code(400).send({
              error: `Target folder already exists and is non-empty: ${target}. Pick a new location or remove existing files first.`,
            });
          }
        }
      }
      try {
        await copyDir(src, target);
      } catch (e) {
        return reply.code(500).send({ error: (e as Error).message });
      }
      const entry = await registerProject(req.userId, {
        name,
        path: target,
        source: 'template',
        origin: tmpl,
      });
      return { ok: true, projectId: entry.id, ...(MODE === 'desktop' ? { path: target } : {}) };
    },
  );
}
