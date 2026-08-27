/**
 * Smoke test for the parsers/serializers.
 *
 * Usage:
 *   node scripts/smoke-parser.mjs <path/to/some.xlsx>
 *   node scripts/smoke-parser.mjs <path/to/fhir-mapping.json>
 *
 * The script branches on file extension:
 *   .xlsx → XLSForm round-trip (AST stability)
 *   .json → fhir-mapping idempotence (canonical serializer is a fixpoint)
 *
 * Default: XLSForm path against gandaki/pregnancy.xlsx.
 *
 * Goal: prove that parse → serialize → parse produces a stable result. Any
 * drift indicates the serializer is silently dropping or moving data.
 *
 * Note: this script is run with Node, so it imports the COMPILED `shared`
 * package from `shared/dist/`. Build first with: pnpm --filter @cht-ui/shared build
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// This repo ships no CHT config; point the smoke test at a real one.
const target = process.argv[2] ?? process.env.CHT_FORM;
if (!target) {
  console.error(
    'Usage: node scripts/smoke-parser.mjs <path-to-form.xlsx>\n' +
      '   or: CHT_FORM=<path-to-form.xlsx> node scripts/smoke-parser.mjs',
  );
  process.exit(2);
}

const ext = path.extname(target).toLowerCase();

if (ext === '.json') {
  const { parseFhirMapping, serializeFhirMapping } = await import('../shared/dist/index.js');
  console.log('# Reading', target);
  const source = await readFile(target, 'utf8');
  const out1 = serializeFhirMapping(parseFhirMapping(source));
  const out2 = serializeFhirMapping(parseFhirMapping(out1));
  const idempotent = out1 === out2;
  const noOpOnOwnOutput = out1 === source;
  console.log(`## Round-trip stable: ${idempotent ? 'YES' : 'NO'}`);
  console.log(
    `## No-op on input (input was already canonical): ${noOpOnOwnOutput ? 'YES' : 'NO (canonicalized once)'}`,
  );
  if (!idempotent) {
    console.error('Idempotence failed — the serializer is not a fixpoint on its own output.');
    process.exit(1);
  }
  console.log('OK');
} else {
  const { parseXlsForm, serializeXlsForm, validateOrdering, buildDependencyMap } = await import(
    '../shared/dist/index.js'
  );

function summarize(form) {
  return {
    locales: form.locales,
    surveyRows: form.survey.length,
    choiceRows: form.choices.length,
    extraSheets: form.extraSheets.map((s) => s.name),
    settings: { ...form.settings, extras: undefined },
    surveyHeaders: form.surveyHeaders.ordered,
    choicesHeaders: form.choicesHeaders.ordered,
    firstFiveRows: form.survey.slice(0, 5).map((r) => ({
      type: r.type,
      name: r.name,
      labels: r.labels,
      extras: r.extras,
    })),
  };
}

console.log('# Reading', target);
const buf = await readFile(target);
const form1 = await parseXlsForm(buf);
const s1 = summarize(form1);
console.log('## Parse #1:');
console.log(JSON.stringify(s1, null, 2));

const violations = validateOrdering(form1);
console.log(`## Ordering violations in current order: ${violations.length}`);
if (violations.length > 0 && violations.length <= 5) {
  for (const v of violations) {
    console.log(
      `  - row #${v.rowIndex} references ${v.reference} (defined at #${v.definingRowIndex}) in column ${v.column}`,
    );
  }
}

const depMap = buildDependencyMap(form1);
let depCount = 0;
for (const refs of depMap.values()) depCount += refs.length;
console.log(`## Dependency edges: ${depCount}`);

const out = await serializeXlsForm(form1);
const form2 = await parseXlsForm(out);
const s2 = summarize(form2);

// Equality check.
const same = JSON.stringify(s1) === JSON.stringify(s2);
console.log(`## Round-trip stable: ${same ? 'YES' : 'NO'}`);
if (!same) {
  console.error('Round-trip drift detected.');
  // Diff first few rows for debugging.
  for (let i = 0; i < Math.min(form1.survey.length, form2.survey.length); i++) {
    const a = JSON.stringify(form1.survey[i]);
    const b = JSON.stringify(form2.survey[i]);
    if (a !== b) {
      console.error(`Row ${i} drift:`);
      console.error('  before:', a);
      console.error('  after :', b);
      if (i > 5) break;
    }
  }
    process.exit(1);
  }
  console.log('OK');
}
