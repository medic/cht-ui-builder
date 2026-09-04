/**
 * Hierarchy routes: read/write app_settings/base_settings.json's
 * place_hierarchy_types and contact_types, plus forms/contact/place-types.json.
 *
 * Round-trip rule: we touch only the fields we know about. Every other
 * key in base_settings.json is preserved verbatim.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInsideProject } from '../state.js';

interface ContactType {
  id: string;
  name_key?: string;
  group_key?: string;
  create_key?: string;
  edit_key?: string;
  icon?: string;
  parents?: string[];
  person?: boolean;
  primary_contact_key?: string;
  count_visits?: boolean;
  create_form?: string;
  edit_form?: string;
  // Anything else stays in the source JSON.
  [k: string]: unknown;
}

interface BaseSettings {
  place_hierarchy_types?: string[];
  contact_types?: ContactType[];
  [k: string]: unknown;
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(p: string, value: unknown): Promise<void> {
  // Ensure the parent dir exists before the atomic-write (.tmp + rename).
  // The hierarchy editor writes `forms/contact/place-types.json` even on
  // projects where `forms/contact/` doesn't exist yet — typically the
  // empty-template / Quick-hierarchy-creator flow. Without the mkdir the
  // `fs.writeFile(tmp, …)` throws ENOENT and base_settings.json has
  // already been updated, leaving a partially-saved hierarchy on disk.
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, p);
}

export async function registerHierarchyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/hierarchy', async (req, reply) => {
    let settingsPath;
    let placeTypesPath;
    try {
      settingsPath = await resolveInsideProject(req, path.join('app_settings', 'base_settings.json'));
      placeTypesPath = await resolveInsideProject(req, path.join('forms', 'contact', 'place-types.json'));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const settings = (await readJson<BaseSettings>(settingsPath)) ?? {};
    const placeTypes = (await readJson<Record<string, string>>(placeTypesPath)) ?? {};
    return {
      place_hierarchy_types: settings.place_hierarchy_types ?? [],
      contact_types: settings.contact_types ?? [],
      place_types_display: placeTypes,
    };
  });

  app.put<{
    Body: {
      place_hierarchy_types: string[];
      contact_types: ContactType[];
      place_types_display: Record<string, string>;
    };
  }>('/api/hierarchy', async (req, reply) => {
    let settingsPath;
    let placeTypesPath;
    try {
      settingsPath = await resolveInsideProject(req, path.join('app_settings', 'base_settings.json'));
      placeTypesPath = await resolveInsideProject(req, path.join('forms', 'contact', 'place-types.json'));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const settings = (await readJson<BaseSettings>(settingsPath)) ?? {};
    settings.place_hierarchy_types = req.body.place_hierarchy_types;
    // Auto-fill missing create_form / edit_form on every contact_type.
    // Pre-fix the AddTypeForm + Quick Hierarchy Creator both omitted
    // these fields on PERSON types, which meant CHT showed no
    // "+ New <person>" affordance inside the parent place — the type
    // existed but couldn't be added to. The creation paths now write
    // both fields; this server-side fill handles EXISTING configs
    // (saved before that fix) so opening + saving an older hierarchy
    // retroactively makes person types creatable. Non-destructive:
    // existing values are NEVER overwritten — we only fill blanks.
    settings.contact_types = req.body.contact_types.map((t) => {
      const out: ContactType = { ...t };
      if (!out.create_form) out.create_form = `form:contact:${out.id}:create`;
      if (!out.edit_form) out.edit_form = `form:contact:${out.id}:edit`;
      return out;
    });
    await writeJson(settingsPath, settings);
    await writeJson(placeTypesPath, req.body.place_types_display);
    return { ok: true };
  });
}
