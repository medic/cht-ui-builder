/**
 * Form routes: list, read, write XLSForms (and their properties.json).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { projectRootOrNull, resolveInsideProject } from '../state.js';
import { getParsedForm, invalidate as invalidateParsedForm } from '../parsedFormCache.js';
import {
  serializeXlsForm,
  buildAppFormScaffold,
  buildBlankFormScaffold,
  buildContactFormScaffold,
  buildContactForm,
  contactFormBasename,
  deriveFormName,
  slugifyHierarchyId,
  slugifyWithHyphens,
  type ContactTypeNode,
  type XLSForm,
} from '@cht-ui/shared';

/** Form categories the UI surfaces. */
type FormCategory = 'app' | 'contact';

interface FormListEntry {
  /** Unique id used in routes: "<category>:<filename-without-ext>" e.g. "app:pregnancy". */
  id: string;
  category: FormCategory;
  filename: string;
  hasProperties: boolean;
  hasXml: boolean;
}

function formId(category: FormCategory, basename: string): string {
  return `${category}:${basename}`;
}

/**
 * Sanitize an uploaded media filename (geriatric §2). Returns `null` for
 * anything that could escape the `<form>-media/` folder or hide as a
 * dotfile; otherwise a conservative `[A-Za-z0-9._-]` name (spaces and
 * exotic characters fold to `_`). Pure — unit-tested in
 * forms.media.test.ts; `resolveInsideProject` remains the write-time
 * backstop.
 */
export function sanitizeMediaFilename(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (/[/\\]/.test(trimmed) || trimmed.includes('..')) return null;
  const cleaned = trimmed.replace(/[^A-Za-z0-9._-]/g, '_');
  if (cleaned === '' || cleaned.startsWith('.')) return null;
  return cleaned;
}

function parseFormId(id: string): { category: FormCategory; basename: string } {
  const [cat, ...rest] = id.split(':');
  if ((cat !== 'app' && cat !== 'contact') || rest.length === 0) {
    throw new Error(`Invalid form id: ${id}`);
  }
  return { category: cat, basename: rest.join(':') };
}

async function listFormsInDir(dir: string, category: FormCategory): Promise<FormListEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const xlsxFiles = entries.filter((e) => e.toLowerCase().endsWith('.xlsx'));
  const out: FormListEntry[] = [];
  for (const f of xlsxFiles) {
    const basename = f.replace(/\.xlsx$/i, '');
    const propsPath = path.join(dir, `${basename}.properties.json`);
    const xmlPath = path.join(dir, `${basename}.xml`);
    out.push({
      id: formId(category, basename),
      category,
      filename: f,
      hasProperties: await fileExists(propsPath),
      hasXml: await fileExists(xmlPath),
    });
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function pathsForForm(req: FastifyRequest, category: FormCategory, basename: string) {
  const dir = await resolveInsideProject(req, path.join('forms', category));
  return {
    xlsx: path.join(dir, `${basename}.xlsx`),
    xml: path.join(dir, `${basename}.xml`),
    properties: path.join(dir, `${basename}.properties.json`),
  };
}

/**
 * Pure resolver for the create-form route. Extracted so we can unit-test
 * the client↔server collision handshake without spinning Fastify + disk.
 *
 * Contract (matches docs/handoff-waves-1-3-2026-07-29.md §Wave 1 · 1):
 *  - When the client resolved a `basename` (its `FormsIndex.doCreate` runs
 *    `deriveFormName(title, existingBasenamesInCategory)` first — e.g.
 *    "Patient Age" twice → `patient_age_2`), the server honors it
 *    verbatim (defensively re-slugified so a malicious/legacy client can't
 *    smuggle raw user text through as a filename) — but a basename whose
 *    slug ALREADY EXISTS (case-insensitive; win32/macOS filesystems) is a
 *    `conflict` → the route answers 409. That's the strict contract
 *    explicit-basename callers rely on (audit item 15): an exact name is
 *    a demand, never silently rewritten to `foo_2`. Re-deriving from
 *    `title` here without the `existing` set would collapse the client's
 *    suffix back to `patient_age` and trip that conflict.
 *  - When only `title` is present (legacy call shape), collision-resolve
 *    server-side using the provided `existing` list so the same second-
 *    create still gets a `_2` suffix — auto-suffixing is the intended
 *    no-code behavior for the title-driven path ONLY.
 *  - Falls back to `title` as the display name; `basename` alone is
 *    also acceptable (returns friendly title = basename in that case).
 *
 * Returns `{ basename, humanTitle }` on success, `{ error }` on failure —
 * with `conflict: true` when the failure is an explicit-basename duplicate
 * (route maps it to 409 instead of 400).
 */
export interface ResolvedFormName {
  basename: string;
  humanTitle: string;
}
export function resolveCreateFormBasename(
  title: string | undefined,
  rawBasename: string | undefined,
  existing: readonly string[],
  category: FormCategory = 'app',
): ResolvedFormName | { error: string; conflict?: boolean } {
  const trimmedTitle = (title ?? '').trim();
  const trimmedRaw = (rawBasename ?? '').trim();
  if (trimmedTitle === '' && trimmedRaw === '') {
    return { error: 'title or basename is required' };
  }
  const humanTitle = trimmedTitle !== '' ? trimmedTitle : trimmedRaw;
  // Contact forms preserve hyphens — the on-disk contract is
  // `<type>-create.xlsx` / `<type>-edit.xlsx` (buildContactForm's
  // contactFormBasename + the batch generator's shape check). Folding
  // `-` to `_` for this category made conformant manual creation
  // impossible (audit P0-2).
  const allowHyphens = category === 'contact';

  // Prefer the client-resolved basename when supplied. Re-slugify
  // defensively — the API contract lets older callers pass raw text as
  // `basename`, and we never want unsanitised input to hit the filesystem.
  // NEVER auto-suffix here: the dialog client has already resolved
  // collisions with its full view of the folder (honour its suffix), and
  // a legacy caller passing an exact basename relies on the strict
  // "already exists → 409" contract (audit item 15) — silently handing
  // back `foo_2` would break its follow-up reads. Case-insensitive match:
  // win32/macOS filesystems treat `Patient_Age.xlsx` and `patient_age.xlsx`
  // as the same file (audit item 9).
  if (trimmedRaw !== '') {
    const slug = allowHyphens ? slugifyWithHyphens(trimmedRaw) : slugifyHierarchyId(trimmedRaw);
    if (slug === '') {
      return {
        error:
          'Could not derive a filename from that basename. Provide ASCII letters (e.g. "pregnancy_registration").',
      };
    }
    const takenLower = new Set(existing.map((n) => n.toLowerCase()));
    if (takenLower.has(slug.toLowerCase())) {
      return { error: `Form ${slug} already exists`, conflict: true };
    }
    return { basename: slug, humanTitle };
  }

  // Title-only path (legacy client). Fold the caller-listed `existing`
  // basenames in so a second create with the same title also gets a
  // numeric suffix instead of hitting the 409.
  const derived = deriveFormName(trimmedTitle, existing, { allowHyphens });
  if (derived.basename === '') {
    return {
      error:
        'Could not derive a filename from that title. Provide ASCII letters (e.g. "Pregnancy Registration") — pure non-Latin scripts have no ASCII form.',
    };
  }
  return { basename: derived.basename, humanTitle };
}

/** List `.xlsx` basenames in a directory. Returns `[]` if the dir doesn't
 *  exist yet (the create route mkdirs after resolving, so a fresh project
 *  has an empty existing-set). */
async function listExistingXlsxBasenames(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.toLowerCase().endsWith('.xlsx'))
    .map((e) => e.replace(/\.xlsx$/i, ''));
}

/**
 * Add a FORMS.<UPPER>: ['<basename>'] entry to form-constants.js and append
 * the basename to APP_FORMS. Best-effort: bails silently if the file
 * doesn't exist or doesn't match the expected shape.
 */
async function maintainFormConstants(req: FastifyRequest, basename: string): Promise<void> {
  let p: string;
  try {
    p = await resolveInsideProject(req, 'form-constants.js');
  } catch {
    return;
  }
  let src: string;
  try {
    src = await fs.readFile(p, 'utf8');
  } catch {
    return;
  }
  const constName = basename.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();

  // 1) Add `FORMS.<constName>: ['<basename>'],` inside the `const FORMS = { ... }` block if not present.
  const formsOpen = src.search(/const\s+FORMS\s*=\s*\{/);
  if (formsOpen >= 0) {
    const braceOpen = src.indexOf('{', formsOpen);
    const braceClose = findMatchingBrace(src, braceOpen);
    if (braceClose > 0) {
      const block = src.slice(braceOpen, braceClose);
      if (!new RegExp(`\\b${constName}\\s*:`).test(block)) {
        // Insert before the closing brace; preserve trailing comma style.
        const before = src.slice(0, braceClose);
        const after = src.slice(braceClose);
        const trimmed = before.replace(/\s*$/, '');
        const needsComma = !trimmed.endsWith(',') && !trimmed.endsWith('{');
        const insertion = `${needsComma ? ',' : ''}\n  ${constName}: ['${basename}']\n`;
        src = trimmed + insertion + after;
      }
    }
  }

  // 2) Add basename to APP_FORMS array if present.
  const appFormsMatch = /APP_FORMS\s*:\s*\[([^\]]*)\]/.exec(src);
  if (appFormsMatch && appFormsMatch[1] !== undefined) {
    const existing = appFormsMatch[1];
    if (!new RegExp(`['"\`]${basename}['"\`]`).test(existing)) {
      const trimmed = existing.replace(/\s*,\s*$/, '');
      const sep = trimmed.trim().length > 0 ? ', ' : '';
      const replaced = src.replace(
        appFormsMatch[0],
        `APP_FORMS: [${trimmed}${sep}'${basename}']`,
      );
      src = replaced;
    }
  }

  await fs.writeFile(p, src, 'utf8');
}

function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Run a git subprocess against the project folder, returning stdout + exit code.
 * Uses `shell: true` on Windows because `git` resolves through Git-for-Windows'
 * shim. Captures errors silently — callers treat non-zero exit as "not a git
 * repo / unavailable" rather than throwing.
 */
function runGit(projectPath: string, gitArgs: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('git', ['-C', projectPath, ...gitArgs], {
      shell: os.platform() === 'win32',
      windowsHide: true,
    });
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('close', (code) => resolve({ stdout, code }));
    child.on('error', () => resolve({ stdout: '', code: -1 }));
    // Unused but referenced to satisfy strictness:
    void stderr;
  });
}

interface ChangedForm {
  category: FormCategory;
  basename: string;
  formId: string;
}

/**
 * Parse `git status --porcelain -- forms/` stdout into a deduplicated list of
 * changed form xlsx files. Exported for unit-testing; callers should use
 * `detectChangedForms` which handles the git subprocess.
 *
 * Handles:
 * - Modified/Added/Deleted/Untracked: `XY forms/app/pregnancy.xlsx`
 * - Renames: `R  forms/app/old.xlsx -> forms/app/new.xlsx` (destination wins)
 * - Quoted paths (git uses C-escapes + quotes when the path has special chars)
 */
export function parseGitPorcelain(stdout: string): ChangedForm[] {
  const seen = new Set<string>();
  const changed: ChangedForm[] = [];
  for (const rawLine of stdout.split('\n')) {
    if (rawLine.length < 4) continue;
    // Porcelain format: `XY <path>` or `XY <old> -> <new>` for renames.
    // Path starts at col 3 (after two status chars + space). For renames we
    // care about the destination side.
    let rel = rawLine.slice(3);
    const arrow = rel.indexOf(' -> ');
    if (arrow >= 0) rel = rel.slice(arrow + 4);
    // Quoted paths use C-style escapes; strip the surrounding quotes (good
    // enough for our regex match — we don't need byte-exact reconstruction).
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
    const m = /^forms\/(app|contact)\/([^/]+)\.xlsx$/i.exec(rel);
    if (!m) continue;
    const category = m[1] as FormCategory;
    const basename = m[2]!;
    const id = formId(category, basename);
    if (seen.has(id)) continue;
    seen.add(id);
    changed.push({ category, basename, formId: id });
  }
  changed.sort((a, b) => a.formId.localeCompare(b.formId));
  return changed;
}

/**
 * Discover which form xlsx files differ from the working tree's git baseline.
 * Used by the Deploy panel's "Select changed" quick-pick — see
 * docs/plans/deploy-targeted-forms.md §3. Returns `git: false` when the
 * project isn't a git repo (UI hides the button); otherwise the deduped list
 * of changed `forms/app/*.xlsx` + `forms/contact/*.xlsx`. Uses
 * `git status --porcelain` so unstaged + just-saved files are included
 * (the working-tree definition of "what I changed since last commit").
 */
async function detectChangedForms(projectPath: string): Promise<{ git: boolean; changed: ChangedForm[] }> {
  const probe = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
  if (probe.code !== 0 || probe.stdout.trim() !== 'true') {
    return { git: false, changed: [] };
  }
  const status = await runGit(projectPath, ['status', '--porcelain', '--', 'forms/']);
  if (status.code !== 0) return { git: true, changed: [] };
  return { git: true, changed: parseGitPorcelain(status.stdout) };
}

export async function registerFormRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/forms', async (req, reply) => {
    const projectPath = await projectRootOrNull(req);
    if (!projectPath) return reply.code(400).send({ error: 'No project open' });
    const appDir = path.join(projectPath, 'forms', 'app');
    const contactDir = path.join(projectPath, 'forms', 'contact');
    const [appForms, contactForms] = await Promise.all([
      listFormsInDir(appDir, 'app'),
      listFormsInDir(contactDir, 'contact'),
    ]);
    return { forms: [...appForms, ...contactForms] };
  });

  app.get('/api/forms/changed', async (req, reply) => {
    const projectPath = await projectRootOrNull(req);
    if (!projectPath) return reply.code(400).send({ error: 'No project open' });
    return detectChangedForms(projectPath);
  });

  /**
   * Geriatric §2 — display-image upload. Writes the file into the CHT
   * convention folder `forms/<category>/<basename>-media/` (sibling of
   * the .xlsx; `cht-conf upload-app-forms` picks it up as a form
   * attachment) and returns the sanitized filename for the row's
   * `media::image` cell. Body is base64 JSON (small illustration files;
   * no multipart parser in this stack — the on-disk contract is the
   * same). `bodyLimit` is raised for the route; base64 inflates ~4/3.
   */
  app.post<{ Params: { id: string }; Body: { filename?: string; dataBase64?: string } }>(
    '/api/forms/:id/media',
    { bodyLimit: 15 * 1024 * 1024 },
    async (req, reply) => {
      let parts;
      try {
        parts = parseFormId(decodeURIComponent(req.params.id));
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      const { filename, dataBase64 } = req.body ?? {};
      if (!filename || !dataBase64) {
        return reply.code(400).send({ error: 'filename and dataBase64 are required' });
      }
      const safe = sanitizeMediaFilename(filename);
      if (!safe) {
        return reply.code(400).send({
          error: `Invalid media filename "${filename}" — no path separators or leading dots.`,
        });
      }
      // The target form must exist — media belongs to a form, and this
      // also pins `basename` to a real on-disk name.
      const paths = await pathsForForm(req, parts.category, parts.basename);
      if (!(await fileExists(paths.xlsx))) {
        return reply.code(404).send({ error: `Form ${req.params.id} not found` });
      }
      let buf: Buffer;
      try {
        buf = Buffer.from(dataBase64, 'base64');
      } catch {
        return reply.code(400).send({ error: 'dataBase64 is not valid base64' });
      }
      if (buf.length === 0) {
        return reply.code(400).send({ error: 'Empty file' });
      }
      const mediaDir = await resolveInsideProject(req, 
        path.join('forms', parts.category, `${parts.basename}-media`),
      );
      await fs.mkdir(mediaDir, { recursive: true });
      // Path-traversal backstop on the final joined path too.
      await resolveInsideProject(req, 
        path.join('forms', parts.category, `${parts.basename}-media`, safe),
      );
      await fs.writeFile(path.join(mediaDir, safe), buf);
      return { ok: true, filename: safe };
    },
  );

  app.get<{ Params: { id: string } }>('/api/forms/:id', async (req, reply) => {
    let parts;
    try {
      parts = parseFormId(decodeURIComponent(req.params.id));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const paths = await pathsForForm(req, parts.category, parts.basename);
    if (!(await fileExists(paths.xlsx))) {
      return reply.code(404).send({ error: `Form file missing: ${paths.xlsx}` });
    }
    // Routed through the parsed-form cache — warm reads skip the ~105 ms
    // parse and just `fs.stat` the file. See parsedFormCache.ts.
    const form = await getParsedForm(paths.xlsx);
    let properties: unknown = null;
    if (await fileExists(paths.properties)) {
      try {
        properties = JSON.parse(await fs.readFile(paths.properties, 'utf8'));
      } catch {
        properties = null;
      }
    }
    return { id: req.params.id, form, properties };
  });

  app.put<{ Params: { id: string }; Body: { form: XLSForm; properties?: unknown } }>(
    '/api/forms/:id',
    async (req, reply) => {
      let parts;
      try {
        parts = parseFormId(decodeURIComponent(req.params.id));
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      const paths = await pathsForForm(req, parts.category, parts.basename);
      // Serialize and write atomically (write to tmp, rename).
      const buf = await serializeXlsForm(req.body.form);
      const tmp = `${paths.xlsx}.tmp`;
      await fs.writeFile(tmp, buf);
      await fs.rename(tmp, paths.xlsx);
      // Bust the parsed-form cache — mtime keys cover external edits but
      // Windows mtime resolution can be coarser than the gap between our
      // own write and the next read, so explicit eviction is mandatory.
      invalidateParsedForm(paths.xlsx);
      if (req.body.properties !== undefined && req.body.properties !== null) {
        const propBuf = JSON.stringify(req.body.properties, null, 2);
        await fs.writeFile(paths.properties, propBuf, 'utf8');
      }
      return { ok: true };
    },
  );

  app.post<{
    Body: {
      category: FormCategory;
      /** Human-facing title (e.g. "Patient Age"). Preferred input; the
       *  server derives the filename basename from it via slugify. */
      title?: string;
      /** Legacy / advanced: caller passes an already-slugified basename.
       *  Kept for the api.createForm(category, basename, ...) shape older
       *  callers use. When both are provided, `title` wins for form_title
       *  and `basename` is used verbatim as the filename (after being
       *  defensively re-slugified — no more rejecting friendly input). */
      basename?: string;
      scaffold?: 'default' | 'blank';
    };
  }>(
    '/api/forms/create',
    async (req, reply) => {
      const { category, title, basename: rawBasename } = req.body;
      const scaffoldKind = req.body.scaffold ?? 'default';
      if (category !== 'app' && category !== 'contact') {
        return reply.code(400).send({ error: 'category must be "app" or "contact"' });
      }
      if (scaffoldKind !== 'default' && scaffoldKind !== 'blank') {
        return reply.code(400).send({ error: 'scaffold must be "default" or "blank"' });
      }
      // Resolve filename basename via the pure helper. When the client
      // already resolved a `basename` (its FormsIndex.doCreate slugifies
      // + suffixes against the current forms list), we honour it after a
      // defensive re-slugify. Only fall back to deriving from the title
      // when the client sent title-only — in which case we still fold the
      // on-disk basenames into the collision set so a legacy title-only
      // caller isn't silently downgraded to a 409.
      const dir = await resolveInsideProject(req, path.join('forms', category));
      await fs.mkdir(dir, { recursive: true });
      const existingBasenames = await listExistingXlsxBasenames(dir);
      const resolved = resolveCreateFormBasename(title, rawBasename, existingBasenames, category);
      if ('error' in resolved) {
        // Explicit-basename duplicates are the strict-contract 409
        // (audit item 15); every other resolution failure is a 400.
        return reply.code(resolved.conflict ? 409 : 400).send({ error: resolved.error });
      }
      const { basename, humanTitle } = resolved;
      const paths = await pathsForForm(req, category, basename);
      if (await fileExists(paths.xlsx)) {
        // Race backstop only — the collision-resolution above (both
        // client-side pre-flight and the title-only fallback) should
        // have already picked a free basename. If we hit this, another
        // writer landed a file with the same basename between the
        // readdir and the writeFile.
        return reply.code(409).send({ error: `Form ${basename} already exists` });
      }
      // Per plan docs/plans/survey-groups-and-scaffold.md Part B: pick
      // the scaffold by category + user choice. Default scaffolds carry
      // the canonical inputs/contact-type plumbing the user otherwise has
      // to hand-type; `blank` is the escape hatch (§B3). Threading the
      // human title lets form_title hold the friendly text ("Patient Age")
      // while form_id + filename get the slug (patient_age).
      const scaffold: XLSForm =
        scaffoldKind === 'blank'
          ? buildBlankFormScaffold({ basename, title: humanTitle, category })
          : category === 'app'
            ? buildAppFormScaffold({ basename, title: humanTitle })
            : buildContactFormScaffold({ basename, title: humanTitle });
      scaffold.settings.version = new Date().toISOString().slice(0, 10);
      const buf = await serializeXlsForm(scaffold);
      await fs.writeFile(paths.xlsx, buf);
      invalidateParsedForm(paths.xlsx);
      if (category === 'app') {
        const props = {
          title: [{ locale: 'en', content: humanTitle }],
          context: { person: true, place: false, expression: 'true' },
          icon: '',
        };
        await fs.writeFile(paths.properties, JSON.stringify(props, null, 2), 'utf8');
      }
      await maintainFormConstants(req, basename);
      return { ok: true, id: formId(category, basename), basename };
    },
  );

  /**
   * Batch generator: offered from the Hierarchy editor. Per `(type,
   * variant)` request: compute the hyphen basename, call
   * `buildContactForm` (set settings.form_id = 'contact:<type>:<variant>'
   * via the colon convention — already done by the shared builder),
   * skip if a file with that basename already exists (HARD rule from
   * plan §3 — we NEVER clobber a contact form), otherwise stamp
   * `version`, serialize, write, invalidate the parsed-form cache.
   *
   * Returns a per-file report so the modal can show "written: N,
   * skipped: M (already existed)" + per-entry warnings from the
   * builder (root place, orphan person, unknown type).
   *
   * Deliberately does NOT call `maintainFormConstants` — that helper is
   * app-report-form specific (FORMS.<UPPER> + APP_FORMS), and contact
   * forms have their own runtime convention (CHT looks them up by
   * filename / form_id, not via a constants module).
   */
  app.post<{
    Body: {
      requests: Array<{ type: string; variant: 'create' | 'edit'; displayName?: string }>;
      contactTypes: ContactTypeNode[];
      locales?: string[];
      /**
       * Default false — preserves the original skip-not-overwrite contract.
       * When true, existing contact forms are clobbered with freshly
       * generated content (e.g. to pick up a fixed generator's emit,
       * like the 3-hop `../../../inputs/user/...` XPath in commit
       * f0f0e20 which couldn't reach already-generated files). The UI
       * is expected to confirm the overwrite with the user first; the
       * server just enforces explicitness via this flag.
       */
      overwrite?: boolean;
    };
  }>('/api/forms/generate-contact', async (req, reply) => {
    const { requests, contactTypes, locales, overwrite } = req.body;
    const overwriteMode = overwrite === true;
    if (!Array.isArray(requests) || requests.length === 0) {
      return reply.code(400).send({ error: 'requests must be a non-empty array' });
    }
    if (!Array.isArray(contactTypes)) {
      return reply.code(400).send({ error: 'contactTypes must be an array' });
    }

    // Ensure the contact-forms dir exists exactly once for the batch.
    const dir = await resolveInsideProject(req, path.join('forms', 'contact'));
    await fs.mkdir(dir, { recursive: true });
    // The route stamps the version once per batch so a multi-file
    // generate-run produces uniform metadata.
    const versionStamp = new Date().toISOString().slice(0, 10);

    interface GenReport {
      type: string;
      variant: 'create' | 'edit';
      basename: string;
      status: 'written' | 'overwritten' | 'skipped' | 'invalid' | 'failed';
      message?: string;
      /** Set on `overwritten` — size of the file before we replaced it
       *  (~useful for the UI's diff summary; full byte-diff is excessive). */
      previousBytes?: number;
      warnings: string[];
    }
    const report: GenReport[] = [];

    for (const reqEntry of requests) {
      const basename = contactFormBasename(reqEntry.type, reqEntry.variant);
      const entry: GenReport = {
        type: reqEntry.type,
        variant: reqEntry.variant,
        basename,
        status: 'written',
        warnings: [],
      };
      if (!/^[a-zA-Z0-9_-]+$/.test(basename)) {
        entry.status = 'invalid';
        entry.message = `Invalid basename "${basename}" — contact type id must be alphanumeric (plus _, -).`;
        report.push(entry);
        continue;
      }
      const paths = await pathsForForm(req, 'contact', basename);
      const existed = await fileExists(paths.xlsx);
      if (existed && !overwriteMode) {
        // Default skip-not-overwrite (plan §3 hard rule). NEVER clobber
        // an existing contact form unless the caller explicitly asked.
        entry.status = 'skipped';
        entry.message = 'File already exists — left untouched.';
        report.push(entry);
        continue;
      }
      try {
        let previousBytes: number | undefined;
        if (existed) {
          // Stat the previous file so the UI can show a one-line diff
          // summary (size delta) without us having to track byte-level
          // diffs across binary xlsx blobs.
          try {
            const st = await fs.stat(paths.xlsx);
            previousBytes = st.size;
          } catch {
            /* race / vanished — non-fatal */
          }
        }
        const built = buildContactForm(contactTypes, {
          type: reqEntry.type,
          variant: reqEntry.variant,
          displayName: reqEntry.displayName,
          locales,
        });
        entry.warnings = built.warnings;
        built.form.settings.version = versionStamp;
        const buf = await serializeXlsForm(built.form);
        await fs.writeFile(paths.xlsx, buf);
        invalidateParsedForm(paths.xlsx);
        // Overwrite also invalidates the previously-converted .xml so a
        // stale convert-app-forms output can't ship in place of the new
        // .xlsx the next time the user runs convert-contact-forms.
        if (existed && (await fileExists(paths.xml))) {
          await fs.unlink(paths.xml);
        }
        if (existed) {
          entry.status = 'overwritten';
          entry.previousBytes = previousBytes;
        }
      } catch (e) {
        entry.status = 'failed';
        entry.message = (e as Error).message;
      }
      report.push(entry);
    }

    return {
      ok: true,
      report,
      written: report.filter((r) => r.status === 'written').length,
      overwritten: report.filter((r) => r.status === 'overwritten').length,
      skipped: report.filter((r) => r.status === 'skipped').length,
      invalid: report.filter((r) => r.status === 'invalid').length,
      failed: report.filter((r) => r.status === 'failed').length,
    };
  });

  app.delete<{ Params: { id: string } }>('/api/forms/:id', async (req, reply) => {
    let parts;
    try {
      parts = parseFormId(decodeURIComponent(req.params.id));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const paths = await pathsForForm(req, parts.category, parts.basename);
    for (const p of [paths.xlsx, paths.xml, paths.properties]) {
      if (await fileExists(p)) await fs.unlink(p);
    }
    invalidateParsedForm(paths.xlsx);
    return { ok: true };
  });
}
