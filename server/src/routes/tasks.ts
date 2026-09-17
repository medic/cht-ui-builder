/**
 * Tasks routes: read/write tasks.js (and task-schedules.js, tasks-extras.js).
 *
 * For Phase 0 these are simple read-as-text / write-as-text. The structured
 * parser lands in P1C alongside the visual editor.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInsideProject } from '../state.js';

async function readTextSafe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function writeText(p: string, content: string): Promise<void> {
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, p);
}

const FILES = ['tasks.js', 'task-schedules.js', 'tasks-extras.js'] as const;
type TaskFile = (typeof FILES)[number];

function isTaskFile(s: string): s is TaskFile {
  return (FILES as readonly string[]).includes(s);
}

export async function registerTasksRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tasks/files', async (req, reply) => {
    try {
      const result: Record<TaskFile, string | null> = {
        'tasks.js': null,
        'task-schedules.js': null,
        'tasks-extras.js': null,
      };
      for (const f of FILES) {
        const p = await resolveInsideProject(req, f);
        result[f] = await readTextSafe(p);
      }
      return result;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.put<{ Params: { file: string }; Body: { content: string } }>(
    '/api/tasks/files/:file',
    async (req, reply) => {
      if (!isTaskFile(req.params.file)) {
        return reply.code(400).send({ error: `unknown task file: ${req.params.file}` });
      }
      try {
        const p = await resolveInsideProject(req, req.params.file);
        await writeText(p, req.body.content);
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );
}
