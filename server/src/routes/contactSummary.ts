/**
 * Contact summary routes. Phase 0: read/write contact-summary.templated.js
 * and contact-summary.extras.js as text. P1C-bis adds structured editing of
 * the `context` block.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  inferContextWrapper,
  mergeContextScan,
  parseXlsForm,
  scanContextDefinitions,
  scanEligibilityForContextReads,
  scanFormsForContextReads,
  type ContextScan,
  type EligibilityForScan,
  type FormForScan,
} from '@cht-ui/shared';
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

const FILES = ['contact-summary.templated.js', 'contact-summary.extras.js'] as const;
type CSFile = (typeof FILES)[number];
function isCSFile(s: string): s is CSFile {
  return (FILES as readonly string[]).includes(s);
}

/**
 * Every contact-summary file actually present at the project root, templated
 * first.
 *
 * DISCOVERED rather than assumed, because the extras filename has two real
 * spellings and `FILES` above only names one of them:
 *
 *   contact-summary.extras.js   gandaki, lumbini, moh-nepal (both variants)
 *   contact-summary-extras.js   nssd/chis, AND all four templates we ship
 *
 * So the hardcoded list is blind to the extras file in NSSD and in every
 * project this tool generates itself. Context-key discovery has to follow the
 * indirection into that file — NSSD's 21 keys live there, not in the
 * templated one — so a wrong guess here is the difference between 70 keys and
 * zero. docs/principle-config-agnostic.md, posture 2.
 */
async function discoverContactSummaryFiles(): Promise<Array<{ file: string; source: string }>> {
  const root = await resolveInsideProject('.');
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const matches = entries.filter((e) => /^contact-summary[.-].*\.js$/i.test(e));
  // Templated first: it holds the `context` binding the scan starts from.
  matches.sort((a, b) => {
    const at = a.includes('templated') ? 0 : 1;
    const bt = b.includes('templated') ? 0 : 1;
    return at - bt || a.localeCompare(b);
  });
  const out: Array<{ file: string; source: string }> = [];
  for (const file of matches) {
    const source = await readTextSafe(path.join(root, file));
    if (source !== null) out.push({ file, source });
  }
  return out;
}

export async function registerContactSummaryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/contact-summary/files', async (_req, reply) => {
    try {
      const result: Record<CSFile, string | null> = {
        'contact-summary.templated.js': null,
        'contact-summary.extras.js': null,
      };
      for (const f of FILES) {
        const p = await resolveInsideProject(f);
        result[f] = await readTextSafe(p);
      }
      return result;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /**
   * Which context values does this config already compute?
   *
   * The picker used to report ZERO on config-nssd/chis, which has about 70.
   * Root cause: it read `contact-summary.templated.js` alone and looked only
   * for `const context = {` or a `context: {` literal, while NSSD's line 18
   * is `const context = getContext(thisContact, allReports)`. Nothing
   * matched, so it returned an empty list and said nothing about why.
   *
   * Three channels, consumption before definition — a key a deployed form
   * already reads is proven to work, whereas a static scan of the
   * contact-summary provably cannot enumerate dynamic keys, template-literal
   * key families or spreads from a call. Measured on NSSD: 63 from form
   * calculations, 7 from form eligibility, 21 from the static scan, union
   * ~70, of which 49 are visible ONLY through consumption.
   *
   * All read-only. Nothing here writes.
   */
  app.get('/api/contact-summary/context-keys', async (_req, reply) => {
    try {
      const summaryFiles = await discoverContactSummaryFiles();
      const definitions = scanContextDefinitions(summaryFiles);

      // Channels 1 + 2 walk the forms on disk. Deliberately the .xlsx
      // sources rather than the compiled .xml: measured, they carry the
      // identical keys, and this way discovery works on a project nobody has
      // run convert-app-forms on yet.
      const forms: FormForScan[] = [];
      const eligibility: EligibilityForScan[] = [];
      const wrapperEvidence: string[] = [];
      /** Forms we could not read, so the UI can say the list is incomplete. */
      const unreadable: string[] = [];

      for (const category of ['app', 'contact'] as const) {
        let dir: string;
        let entries: string[];
        try {
          dir = await resolveInsideProject(path.join('forms', category));
          entries = await fs.readdir(dir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (/^~\$/.test(entry)) continue; // Excel lock file
          const full = path.join(dir, entry);
          if (/\.xlsx$/i.test(entry)) {
            try {
              const buf = await fs.readFile(full);
              const xlsform = await parseXlsForm(buf);
              const formId = `${category}:${entry.replace(/\.xlsx$/i, '')}`;
              forms.push({ formId, xlsform });
              for (const row of xlsform.survey) {
                const cell = row.extras['calculation'];
                if (cell) wrapperEvidence.push(cell);
              }
            } catch {
              // An unparseable form must not blank the whole picker — but it
              // must not vanish either. Reported below, because a silently
              // shorter list still LOOKS authoritative, and the author who
              // cannot find the key that form uses concludes they misspelled
              // it. Same honesty rule as `indeterminate`.
              unreadable.push(`${category}/${entry}`);
              continue;
            }
          } else if (/\.properties\.json$/i.test(entry)) {
            const text = await readTextSafe(full);
            if (text === null) continue;
            try {
              const parsed: unknown = JSON.parse(text);
              const expression = (parsed as { context?: { expression?: unknown } })?.context
                ?.expression;
              if (typeof expression === 'string' && expression.trim() !== '') {
                eligibility.push({
                  formId: `${category}:${entry.replace(/\.properties\.json$/i, '')}`,
                  expression,
                });
              }
            } catch {
              continue;
            }
          }
        }
      }

      const scan: ContextScan = mergeContextScan({
        formReads: scanFormsForContextReads(forms),
        eligibilityReads: scanEligibilityForContextReads(eligibility),
        definitions,
      });

      return {
        ...scan,
        /** Files the scan actually read, so the UI can be specific. */
        summaryFiles: summaryFiles.map((f) => f.file),
        /**
         * Forms whose workbook could not be parsed. Their context reads are
         * missing from `keys`, so a non-empty list here means the answer is
         * incomplete for a reason that has nothing to do with the
         * contact-summary.
         */
        unreadableForms: unreadable,
        /**
         * The wrapper idiom this project already uses, so an insert can match
         * it instead of imposing ours. `null` when the project has no context
         * reads to learn from.
         */
        houseWrapper: inferContextWrapper(wrapperEvidence),
      };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.put<{ Params: { file: string }; Body: { content: string } }>(
    '/api/contact-summary/files/:file',
    async (req, reply) => {
      if (!isCSFile(req.params.file)) {
        return reply.code(400).send({ error: `unknown contact-summary file: ${req.params.file}` });
      }
      try {
        const p = await resolveInsideProject(req.params.file);
        await writeText(p, req.body.content);
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );
}
