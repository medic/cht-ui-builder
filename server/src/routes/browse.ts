/**
 * Filesystem browsing for DESKTOP mode only: list drives / folders, search
 * for project roots, make a folder for a new project.
 *
 * These routes resolve any absolute path the client names and list it. On a
 * shared server that is a filesystem browser for the container and a way to
 * reach another user's directory, so `index.ts` registers this module only
 * when MODE === 'desktop' (docs/plans/hosted-authoring.md §6.2). Hosted
 * projects are addressed by id through the registry instead.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isProjectRoot(p: string): Promise<boolean> {
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

export async function registerBrowseRoutes(app: FastifyInstance): Promise<void> {
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
        return {
          path: '',
          parent: null,
          entries: drives.map((d) => ({ name: d, isDirectory: true, isProjectRoot: false })),
        };
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
