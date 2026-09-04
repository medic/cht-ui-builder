/**
 * Server entry point. Fastify on port 5174 by default; client (Vite) on 5173.
 *
 * The server is responsible for filesystem I/O against the user's project
 * folders. It exposes a small REST surface; all editing logic lives in the
 * client. Every request names its project with `x-project-id` (state.ts) and,
 * in hosted mode, its user with a bearer token (auth.ts). See config.ts for
 * the two modes.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORS_ORIGINS, DATA_ROOT, MODE, SERVE_CLIENT } from './config.js';
import { registerAuth } from './auth.js';
import { registerProjectRoutes } from './routes/project.js';
import { registerBrowseRoutes } from './routes/browse.js';
import { registerTransferRoutes } from './routes/transfer.js';
import { registerFormRoutes } from './routes/forms.js';
import { registerHierarchyRoutes } from './routes/hierarchy.js';
import { registerTasksRoutes } from './routes/tasks.js';
import { registerContactSummaryRoutes } from './routes/contactSummary.js';
import { registerChtConfRoutes } from './routes/cht-conf.js';
import { registerDeployRoutes } from './routes/deploy.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerFhirMappingRoutes } from './routes/fhirMapping.js';
import { registerDictionaryRoutes } from './routes/dictionaries.js';
import { registerTranslationRoutes } from './routes/translations.js';

const PORT = Number(process.env.PORT ?? 5174);
const HOST = process.env.HOST ?? (MODE === 'hosted' ? '0.0.0.0' : '127.0.0.1');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/dist/index.js → <repo>/client/dist
const CLIENT_DIST = path.resolve(__dirname, '..', '..', 'client', 'dist');

async function main() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(cors, {
    // The Vite dev server runs on 5173; in production both serve from the same
    // origin unless the client is hosted elsewhere (CORS_ORIGIN).
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173', ...CORS_ORIGINS],
    methods: ['GET', 'PUT', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-project-id'],
    exposedHeaders: ['content-disposition'],
  });

  app.get('/api/health', async () => ({ ok: true, mode: MODE, time: new Date().toISOString() }));

  // Stamps req.userId; in hosted mode rejects unauthenticated /api requests.
  await registerAuth(app);

  await registerProjectRoutes(app);
  // Browsing the server's filesystem is a desktop-only feature by design.
  if (MODE === 'desktop') await registerBrowseRoutes(app);
  await registerTransferRoutes(app);
  await registerFormRoutes(app);
  await registerHierarchyRoutes(app);
  await registerTasksRoutes(app);
  await registerContactSummaryRoutes(app);
  await registerChtConfRoutes(app);
  await registerDeployRoutes(app);
  await registerTemplateRoutes(app);
  await registerFhirMappingRoutes(app);
  await registerDictionaryRoutes(app);
  await registerTranslationRoutes(app);

  // Single-container deployment: serve the built client from this origin.
  if (SERVE_CLIENT && fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    await app.register(fastifyStatic, { root: CLIENT_DIST, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: `Route ${req.method}:${req.url} not found` });
    });
    app.log.info(`serving client from ${CLIENT_DIST}`);
  } else if (SERVE_CLIENT) {
    app.log.warn(`SERVE_CLIENT=1 but ${CLIENT_DIST}/index.html is missing — build the client first`);
  }

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`UI Builder server (${MODE} mode, data at ${DATA_ROOT}) listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
