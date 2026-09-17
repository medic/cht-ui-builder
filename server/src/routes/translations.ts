/**
 * Translations routes. Reads / writes `messages-<locale>.properties` files
 * under the project.
 *
 * Two conventional locations are scanned (matching what real CHT projects
 * ship):
 *   1. `<project>/translations/`
 *   2. `<project>/app_settings/forms/translations/`
 *
 * The route surfaces every file found and addresses saves by (dirPrefix,
 * locale) via the URL. Writes go through `updateProperty` +
 * `serializeProperties`, so unedited lines remain byte-identical on disk.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  parseProperties,
  serializeProperties,
  updateProperty,
  type PropertiesFile,
} from '@cht-ui/shared';
import { projectRootOrNull, resolveInsideProject } from '../state.js';

/** Relative directories, in scan order, that may contain translation files. */
const DIRS = ['translations', 'app_settings/forms/translations'] as const;

interface TranslationFile {
  /** Locale suffix from `messages-<locale>.properties`. */
  locale: string;
  /** Relative-to-project directory containing the file (POSIX-style). */
  dir: string;
  /** Relative-to-project path (POSIX-style). */
  path: string;
  entries: PropertiesFile;
}

interface UpdatePayload {
  updates: Array<{ key: string; value: string }>;
}

const LOCALE_RE = /^messages-([A-Za-z0-9_-]+)\.properties$/;

async function readDirSafe(abs: string): Promise<string[]> {
  try {
    return await fs.readdir(abs);
  } catch {
    return [];
  }
}

async function readTextSafe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Discover every translation file under the two known directories. Returns
 * files in scan order: root `translations/` first, then the nested one, and
 * within each dir alphabetically by locale. Locale collisions between the two
 * dirs are surfaced as separate entries (rare but valid — the UI addresses
 * each by its `dir`).
 */
async function scanTranslationFiles(projectPath: string): Promise<TranslationFile[]> {
  const out: TranslationFile[] = [];
  for (const relDir of DIRS) {
    const absDir = path.join(projectPath, relDir);
    const names = await readDirSafe(absDir);
    const localeFiles = names
      .map((n) => ({ name: n, match: LOCALE_RE.exec(n) }))
      .filter((x): x is { name: string; match: RegExpExecArray } => x.match !== null)
      .sort((a, b) => a.match[1]!.localeCompare(b.match[1]!));
    for (const { name, match } of localeFiles) {
      const abs = path.join(absDir, name);
      const raw = await readTextSafe(abs);
      if (raw === null) continue;
      out.push({
        locale: match[1]!,
        dir: relDir,
        path: `${relDir}/${name}`,
        entries: parseProperties(raw),
      });
    }
  }
  return out;
}

function isUpdatePayload(body: unknown): body is UpdatePayload {
  if (!body || typeof body !== 'object') return false;
  const u = (body as { updates?: unknown }).updates;
  if (!Array.isArray(u)) return false;
  return u.every(
    (row) =>
      row !== null &&
      typeof row === 'object' &&
      typeof (row as { key: unknown }).key === 'string' &&
      typeof (row as { value: unknown }).value === 'string',
  );
}

export async function registerTranslationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/translations', async (req, reply) => {
    const root = await projectRootOrNull(req);
    if (!root) return reply.code(400).send({ error: 'No project is open.' });
    try {
      const files = await scanTranslationFiles(root);
      return { files };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.put<{ Params: { locale: string }; Body: unknown; Querystring: { dir?: string } }>(
    '/api/translations/:locale',
    async (req, reply) => {
      const locale = req.params.locale;
      if (!LOCALE_RE.test(`messages-${locale}.properties`)) {
        return reply.code(400).send({ error: `invalid locale: ${locale}` });
      }
      if (!isUpdatePayload(req.body)) {
        return reply.code(400).send({ error: 'body must be { updates: {key,value}[] }' });
      }
      const requestedDir = req.query.dir;
      // Resolve which file to update. If ?dir= is given, honour it (must be
      // one of the two known dirs); otherwise pick the first dir on disk
      // that contains this locale. Wave 2 §4 — when NO existing file is
      // found for the locale, fall back to creating a new file in the
      // canonical `translations/` dir so the Add-language chip bar can
      // register a brand-new locale without a manual `touch`. Callers
      // that don't want the auto-create behavior can still pass ?dir=
      // pinning the exact location.
      let targetRel: string | null = null;
      let createIfMissing = false;
      if (requestedDir !== undefined) {
        if (!(DIRS as readonly string[]).includes(requestedDir)) {
          return reply.code(400).send({ error: `unknown translations dir: ${requestedDir}` });
        }
        targetRel = `${requestedDir}/messages-${locale}.properties`;
        // ?dir= pinning: create-if-missing is opt-in there too (harmless
        // — the previous behavior was a 400 on a missing file, so any
        // caller supplying ?dir= for a non-existent file was broken
        // anyway).
        createIfMissing = true;
      } else {
        for (const d of DIRS) {
          const rel = `${d}/messages-${locale}.properties`;
          try {
            await fs.access(await resolveInsideProject(req, rel));
            targetRel = rel;
            break;
          } catch {
            // try next
          }
        }
        if (targetRel === null) {
          // Fall back to creating a new file in the canonical dir.
          targetRel = `${DIRS[0]}/messages-${locale}.properties`;
          createIfMissing = true;
        }
      }
      let abs: string;
      try {
        abs = await resolveInsideProject(req, targetRel);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      let raw = await readTextSafe(abs);
      if (raw === null) {
        if (!createIfMissing) {
          return reply.code(400).send({ error: `file missing: ${targetRel}` });
        }
        // Materialize an empty file (empty PropertiesFile serializes to
        // ''). We also need to ensure the directory exists — a fresh
        // project may not carry `translations/` yet.
        try {
          await fs.mkdir(path.dirname(abs), { recursive: true });
        } catch (e) {
          return reply
            .code(500)
            .send({ error: `could not create translations dir: ${(e as Error).message}` });
        }
        raw = '';
      }
      let file = parseProperties(raw);
      for (const { key, value } of req.body.updates) {
        file = updateProperty(file, key, value);
      }
      const next = serializeProperties(file);
      const tmp = `${abs}.tmp`;
      await fs.writeFile(tmp, next, 'utf8');
      await fs.rename(tmp, abs);
      return { ok: true, path: targetRel };
    },
  );
}
