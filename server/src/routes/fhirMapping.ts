/**
 * FHIR mapping routes — read/write `fhir-mapping.json` at the project root.
 *
 * V1 of the Standard-codes feature (docs/plans/fhir-v1-workbench.md PR1).
 * The MVP (commit 880139d) shipped the read-only `shared/src/fhir/` data
 * layer; this route is the FIRST writer of `fhir-mapping.json` and MUST
 * honor the round-trip contract the MVP types reserve:
 *
 *   1. Canonical serializer (sorted keys, LF, trailing `\n`, no BOM)
 *      from `serializeFhirMapping`.
 *   2. **Compare-before-write** — read the existing bytes, return early
 *      if `serializeFhirMapping(next) === existingBytes`. Opening +
 *      leaving the workbench on an already-canonical sidecar is a
 *      byte-identical no-op (no spurious mtime bump).
 *   3. **Atomic tmp+rename** matching the pattern in
 *      `server/src/routes/hierarchy.ts:45-49`. Never use a non-atomic
 *      `fs.writeFile` — a crash mid-write would leave a truncated
 *      sidecar.
 *   4. **Codec-built live keys** (`encodeQuestionKey` /
 *      `encodeChoiceKey`) — NEVER string concat of `formId + '/' + name`.
 *      A name legally containing `/` or `%` would false-orphan a
 *      live confirmed binding through string concat (MVP §3 item 6).
 *
 * The route is the ONLY file `fhir-mapping.json` ever has written to it
 * — no other byte on disk changes as a side-effect. The first save of
 * a foreign-formatted sidecar (4-space indent, CRLF, unsorted keys) is
 * a legitimate one-time canonicalization; subsequent saves are exact
 * no-ops on byte-identical content.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyStarterPack,
  encodeChoiceKey,
  encodeQuestionKey,
  parseFhirMapping,
  reconcileFhirMapping,
  serializeFhirMapping,
  type FhirMapping,
} from '@cht-ui/shared';
import { loadStarterPack } from '@cht-ui/shared/dist/fhir/loadStarterPack.js';
import { resolveInsideProject } from '../state.js';
import { getParsedForm, directorySignature } from '../parsedFormCache.js';

const SIDECAR_FILENAME = 'fhir-mapping.json';

/** Empty mapping returned when the sidecar is absent. The shared parser
 *  requires `schemaVersion`, so we hand it the canonical empty shape
 *  rather than `{}` — future schema bumps add their own defaults here. */
function emptyMapping(): FhirMapping {
  return parseFhirMapping(
    JSON.stringify({
      schemaVersion: 1,
      questionMappings: {},
      choiceMappings: {},
      orphans: [],
    }),
  );
}

/**
 * Walk every `forms/app/*.xlsx` and `forms/contact/*.xlsx` and produce
 * the codec-keyed list of every live binding the picker could attach a
 * code to (questions + select choices). The route uses this list as the
 * input to `reconcileFhirMapping` so renamed/deleted rows are relocated
 * to `orphans[]` losslessly (never silently dropped).
 *
 * Critical: live keys MUST be produced by the codec — never by string
 * concat — or a name legally containing `/` or `%` false-orphans its
 * own confirmed binding (MVP §3 item 6). The codec strings here are
 * the same ones the V1 PUT will compare against.
 */
/**
 * Tier-1b derived-result cache. `buildLiveKeys` walks every app+contact
 * form on every `/api/fhir-mapping` GET — even with per-form parse
 * caching, iterating + encoding adds up. We cache the result keyed by a
 * cheap stat-only signature of both forms directories: if nothing under
 * `forms/app` or `forms/contact` has been touched since last GET, the
 * previous live-keys array is byte-equivalent and we skip the work
 * entirely.
 *
 * Keyed by projectPath so a project switch invalidates naturally.
 */
const liveKeysCache = new Map<string, { signature: string; liveKeys: string[] }>();

async function buildLiveKeys(projectPath: string): Promise<string[]> {
  const [appSig, contactSig] = await Promise.all([
    directorySignature(path.join(projectPath, 'forms/app')),
    directorySignature(path.join(projectPath, 'forms/contact')),
  ]);
  const signature = `app=${appSig ?? '∅'}|contact=${contactSig ?? '∅'}`;
  const hit = liveKeysCache.get(projectPath);
  if (hit && hit.signature === signature) return hit.liveKeys;

  const liveKeys = new Set<string>();
  for (const [category, dirName] of [
    ['app', 'forms/app'],
    ['contact', 'forms/contact'],
  ] as const) {
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(projectPath, dirName));
    } catch {
      continue;
    }
    const xlsxFiles = entries.filter((e) => e.toLowerCase().endsWith('.xlsx'));
    for (const filename of xlsxFiles) {
      const basename = filename.replace(/\.xlsx$/i, '');
      const formId = `${category}:${basename}`;
      let form;
      try {
        // Parsed-form cache routes this through stat-only fast path on
        // warm reads (~1 ms) vs ~105 ms cold.
        form = await getParsedForm(path.join(projectPath, dirName, filename));
      } catch {
        // Unparseable workbook — best-effort; skip silently so the
        // reconcile doesn't drop everything else.
        continue;
      }
      // Question-level keys: every named survey row (structural rows
      // have empty `name` in cht-default — `encodeQuestionKey` would
      // still encode them but they aren't mappable, so skip).
      for (const r of form.survey) {
        if (!r.name) continue;
        liveKeys.add(encodeQuestionKey(formId, r.name));
      }
      // Choice-level keys: every (list_name, choice.name) the form's
      // choices sheet carries. Used by PR3's choice-level mapping.
      for (const c of form.choices) {
        if (!c.list_name || !c.name) continue;
        liveKeys.add(encodeChoiceKey(formId, c.list_name, c.name));
      }
    }
  }
  const result = Array.from(liveKeys);
  liveKeysCache.set(projectPath, { signature, liveKeys: result });
  return result;
}

/** Read + parse the sidecar, returning the empty mapping when absent. */
async function readSidecar(sidecarPath: string): Promise<FhirMapping> {
  try {
    const raw = await fs.readFile(sidecarPath, 'utf8');
    return parseFhirMapping(raw);
  } catch (e) {
    // eslint-disable-next-line no-undef
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyMapping();
    // A malformed sidecar is a hard failure — better than silently
    // dropping confirmed mappings.
    throw e;
  }
}

/** Atomic tmp+rename write — same pattern as hierarchy.ts:45-49. The
 *  caller MUST have already done the compare-before-write check;
 *  this helper assumes the bytes have changed and writes them. */
async function writeSidecar(sidecarPath: string, content: string): Promise<void> {
  const tmp = `${sidecarPath}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, sidecarPath);
}

export async function registerFhirMappingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/fhir-mapping', async (req, reply) => {
    // Timing instrumentation — see docs/plans/perf-parse-cache.md targets:
    // warm `/api/fhir-mapping` < 200 ms (from ~7 s). Always-on so we
    // catch any regression in normal usage, not just measurement passes.
    // eslint-disable-next-line no-undef
    const t0 = performance.now();
    let sidecarPath: string;
    let projectPath: string;
    try {
      sidecarPath = await resolveInsideProject(req, SIDECAR_FILENAME);
      projectPath = path.dirname(sidecarPath);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const stored = await readSidecar(sidecarPath);
    // eslint-disable-next-line no-undef
    const tBeforeLive = performance.now();
    const liveKeys = await buildLiveKeys(projectPath);
    // eslint-disable-next-line no-undef
    const tAfterLive = performance.now();
    // Reconcile relocates any stored key not in `liveKeys` to
    // `orphans[]` losslessly. Pure (no I/O); the route doesn't write
    // the reconciled state on GET — it returns it for the workbench to
    // edit and PUT back.
    let reconciled = reconcileFhirMapping(stored, liveKeys);
    // V1 PR2 — auto-apply the bundled cht-mch-v1 pack as `suggested`
    // pre-fills (plan §C3). `applyStarterPack` is idempotent: it
    // skips any key the user has already touched, so re-running on
    // every GET is safe. The auto-applied state is returned to the
    // client but NOT written to disk — the user saves on Accept.
    // The `appliedAt` timestamp comes from the caller (route) per the
    // MVP non-determinism contract; the pack module never reads the
    // wall clock itself.
    try {
      const pack = loadStarterPack('cht-mch-v1');
      reconciled = applyStarterPack(reconciled, pack, new Date().toISOString());
    } catch {
      // Pack absent / load failure is non-fatal — the workbench still
      // works, just without pre-fills.
    }
    // eslint-disable-next-line no-undef
    const t1 = performance.now();
    app.log.info(
      { liveMs: +(tAfterLive - tBeforeLive).toFixed(1), totalMs: +(t1 - t0).toFixed(1), liveKeys: liveKeys.length },
      'GET /api/fhir-mapping',
    );
    return { mapping: reconciled };
  });

  /** PR2 helper — return the loaded starter pack so the client can
   *  surface the available dictionaries / concept list without
   *  having to import the Node-only loader. */
  app.get('/api/fhir-mapping/pack', async (req, reply) => {
    try {
      const pack = loadStarterPack('cht-mch-v1');
      return { pack };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  app.put<{ Body: { mapping: FhirMapping } }>(
    '/api/fhir-mapping',
    {
      schema: {
        body: {
          type: 'object',
          required: ['mapping'],
          properties: { mapping: { type: 'object' } },
        },
      },
    },
    async (req, reply) => {
      let sidecarPath: string;
      try {
        sidecarPath = await resolveInsideProject(req, SIDECAR_FILENAME);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      // Re-parse via the shared parser so the body's shape gets the
      // same defaults/validation the GET path applies. A malformed
      // body fails fast here.
      let normalized: FhirMapping;
      try {
        normalized = parseFhirMapping(JSON.stringify(req.body.mapping));
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      const next = serializeFhirMapping(normalized);
      // Round-trip §2 — compare-before-write. Spurious writes are a
      // bug: every save that produces the same bytes on disk must be
      // a no-op (no mtime bump, no `git diff`). Read the existing
      // bytes (treating ENOENT as ''), bail early when equal.
      let existing = '';
      try {
        existing = await fs.readFile(sidecarPath, 'utf8');
      } catch (e) {
        // eslint-disable-next-line no-undef
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (existing === next) {
        return { ok: true, written: false };
      }
      await writeSidecar(sidecarPath, next);
      return { ok: true, written: true };
    },
  );
}
