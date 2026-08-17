/**
 * Safety batch A1 — hostile-by-construction formula-cell fixtures.
 *
 * NSSD was the first real config with Excel formula cells in its forms, but
 * formula cells come from *how a human authored a spreadsheet*, not from a
 * project convention — any config can carry them
 * (docs/principle-config-agnostic.md, docs/handoff-nssd-safety-batch-2026-08-11.md §A1).
 *
 * The defect: exceljs's `FormulaValue._copyModel` tests each cached model
 * field for *truthiness* when building `cell.value`, so a formula whose
 * cached result is `false` loses the result entirely and `cellToString`
 * falls through to returning the formula SOURCE text. `relevant` `=FALSE()`
 * becomes the string `"FALSE()"` — pyxform then emits
 * `relevant="FALSE()"`, an undefined XPath function that breaks the form at
 * runtime (19 of 34 NSSD contact forms). A `Date` cached result survives
 * truthiness but is stringified via `Date.prototype.toString()`, turning
 * `settings.version` `=NOW()` into a host-timezone banner string.
 *
 * Both corruptions are IDEMPOTENT — parse → serialize → parse is stable on
 * the corrupted output — so no round-trip stability test can catch them.
 * Every test here builds a real xlsx buffer with exceljs, re-reads it
 * through `parseXlsForm` (the module's own entry point, exercising the real
 * exceljs read path), runs `serializeXlsForm`, and asserts on the PARSED
 * and EMITTED cell content, never on idempotence.
 *
 * Tests marked `{ todo: true }` pin the CORRECT config-agnostic behavior
 * that HEAD does not yet implement — flip todo off when the A1 fix lands.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseXlsForm } from './parse.js';
import { serializeXlsForm } from './serialize.js';
import ExcelJS from 'exceljs';

/* ------------------------ helpers ------------------------ */

/** Write a hand-built workbook to a Buffer — the same bytes a human-authored
 *  xlsx would carry, so `parseXlsForm` exercises the real exceljs read path
 *  (formula-model reconstruction included), not a hand-constructed model. */
async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** Re-read a serialized buffer with raw ExcelJS so assertions land on the
 *  actual emitted cells (what would hit disk / git), bypassing the parser. */
async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buf as any);
  return wb;
}

function getSheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  let found: ExcelJS.Worksheet | undefined;
  wb.eachSheet((s) => {
    if (s.name.toLowerCase() === name.toLowerCase()) found = s;
  });
  if (!found) throw new Error(`sheet ${name} not found in buffer`);
  return found;
}

/**
 * The hostile formula fixture — three formula cells a spreadsheet author
 * plausibly leaves behind, none of which is the canonical plain-string
 * shape the parser assumes:
 *
 *   - survey D2 `relevant`      = `=FALSE()` with cached result `false`
 *     (falsy → exceljs drops the result from `cell.value`)
 *   - survey E3 `calculation`   = `=1+1` with cached result `2` (truthy)
 *   - settings C2 `version`     = `=NOW()` with a cached Date result,
 *     date-formatted (as real spreadsheets style it, which is what makes
 *     exceljs reconstruct the result as a `Date` instance on read)
 */
async function buildFormulaFixture(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const survey = wb.addWorksheet('survey');
  survey.addRow(['type', 'name', 'label::en', 'relevant', 'calculation']);
  survey.addRow(['text', 'q1', 'Question 1', '', '']);
  survey.getCell('D2').value = { formula: 'FALSE()', result: false };
  survey.addRow(['calculate', 'calc1', '', '', '']);
  survey.getCell('E3').value = { formula: '1+1', result: 2 };

  const choices = wb.addWorksheet('choices');
  choices.addRow(['list_name', 'name', 'label::en']);
  choices.addRow(['yesno', 'yes', 'Yes']);

  const settings = wb.addWorksheet('settings');
  settings.addRow(['form_title', 'form_id', 'version', 'default_language']);
  settings.addRow(['Hostile', 'hostile', '', 'en']);
  const version = settings.getCell('C2');
  version.value = { formula: 'NOW()', result: new Date(Date.UTC(2026, 1, 13, 4, 43, 23)) };
  version.numFmt = 'yyyy-mm-dd hh:mm:ss';

  return toBuffer(wb);
}

/* ===== 1. A1: cached-false formula must parse to the result, not the source ===== */

// HEAD returns the formula source ('FALSE()') because exceljs's truthiness
// filter strips the cached `false` from `cell.value` before `cellToString`
// ever sees it. Correct behavior: read the result off the Cell
// (`cell.result`) and emit 'false' — a defined XPath value.
// Batch item A1 — flip todo off when the fix lands.
test('A1: formula cell with cached FALSE result parses to "false", never the source text "FALSE()"', { todo: true }, async () => {
  const form = await parseXlsForm(await buildFormulaFixture());

  const q1 = form.survey.find((r) => r.name === 'q1');
  assert.ok(q1, 'fixture row q1 must survive parsing');
  assert.equal(
    q1!.extras['relevant'],
    'false',
    'parsed relevant must be the cached result "false" (a defined XPath value), not the formula source "FALSE()" (an undefined XPath function)',
  );

  // And the bytes that land in git: serialize and read the emitted cell raw.
  // Idempotence would pass on the corruption — the emitted CONTENT is the pin.
  const emitted = await serializeXlsForm(form);
  const ws = getSheet(await loadWorkbook(emitted), 'survey');
  assert.equal(
    ws.getCell('D2').value,
    'false',
    'emitted relevant cell must be "false", not the formula source',
  );
});

/* ===== 2. A1: Date-result formula must not emit host-timezone String(Date) ===== */

// HEAD emits `Date.prototype.toString()` — "Fri Feb 13 2026 10:28:23
// GMT+0545 (Nepal Time)" on this machine — which is nondeterministic across
// host timezones and useless as a settings.version. The fix needs a Date
// branch that emits a deterministic serial-preserving form (Excel serial or
// ISO); at minimum it must be neither the toString() form nor the source.
// Batch item A1 — flip todo off when the fix lands.
test('A1: NOW() formula with cached Date result parses to a serial-preserving form, not String(Date)', { todo: true }, async () => {
  const form = await parseXlsForm(await buildFormulaFixture());

  const assertVersionShape = (v: string, where: string): void => {
    assert.notEqual(v, 'NOW()', `${where}: must never emit the formula source`);
    assert.ok(
      !/GMT/.test(v),
      `${where}: must not be the host-timezone Date.toString() form, got ${JSON.stringify(v)}`,
    );
    assert.ok(
      /^\d+(\.\d+)?$/.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v),
      `${where}: must be a deterministic serial-preserving form (Excel serial number or ISO date), got ${JSON.stringify(v)}`,
    );
  };

  assertVersionShape(form.settings.version ?? '', 'parsed settings.version');

  const emitted = await serializeXlsForm(form);
  const cell = getSheet(await loadWorkbook(emitted), 'settings').getCell('C2').value;
  assertVersionShape(cell === null || cell === undefined ? '' : String(cell), 'emitted version cell');
});

/* ===== 3. A1: truthy formula result parses to the result string (green pin) ===== */

// HEAD already gets this right — the truthy cached result survives exceljs's
// `_copyModel` filter, so `cellToString` returns String(result). Pinned as a
// regression guard so the A1 fix (switching to `cell.result`) cannot regress
// the case that works today.
test('A1: formula cell with truthy cached result (=1+1 → 2) parses and re-emits as "2"', async () => {
  const form = await parseXlsForm(await buildFormulaFixture());

  const calc1 = form.survey.find((r) => r.name === 'calc1');
  assert.ok(calc1, 'fixture row calc1 must survive parsing');
  assert.equal(
    calc1!.extras['calculation'],
    '2',
    'parsed calculation must be the cached result "2", not the formula source "1+1"',
  );

  const emitted = await serializeXlsForm(form);
  const ws = getSheet(await loadWorkbook(emitted), 'survey');
  assert.equal(ws.getCell('E3').value, '2', 'emitted calculation cell must be the result "2"');
});

/* ===== 4. A1: readRawSheet must not inflate styled-but-empty rows ===== */

// A raw (unknown) sheet like gandaki/NSSD's `choices-backup` often carries
// formatting touched far below the real content — a style-only cell at row
// 900 makes exceljs report rowCount=900 while actualRowCount stays 6.
// HEAD iterates `eachRow({ includeEmpty: true })` and inflates the parsed
// RawSheet (NSSD: 63 → 1000 rows), and the serializer then writes every
// phantom row back out. Correct behavior: bound the rows by actual content.
// Batch item A1 (readRawSheet clause) — flip todo off when the fix lands.
test('A1: raw sheet with 5 data rows + style-only cell at row 900 parses bounded by content, not 900 rows', { todo: true }, async () => {
  const wb = new ExcelJS.Workbook();

  const survey = wb.addWorksheet('survey');
  survey.addRow(['type', 'name', 'label::en']);
  survey.addRow(['text', 'q1', 'Question 1']);
  const choices = wb.addWorksheet('choices');
  choices.addRow(['list_name', 'name', 'label::en']);
  const settings = wb.addWorksheet('settings');
  settings.addRow(['form_title', 'form_id', 'version', 'default_language']);
  settings.addRow(['Hostile', 'hostile', '1', 'en']);

  const backup = wb.addWorksheet('choices-backup');
  backup.addRow(['list_name', 'name', 'label::en']);
  for (let i = 1; i <= 5; i++) backup.addRow(['yesno', `opt_${i}`, `Option ${i}`]);
  // The hostile touch: formatting far below the content, no value anywhere.
  backup.getCell('A900').numFmt = '@';

  const form = await parseXlsForm(await toBuffer(wb));
  const raw = form.extraSheets.find((s) => s.name === 'choices-backup');
  assert.ok(raw, 'choices-backup must be preserved as an extra sheet');
  assert.deepEqual(
    raw!.headers,
    ['list_name', 'name', 'label::en'],
    'raw sheet headers must be read from the real header row',
  );
  // All five real data rows survive…
  for (let i = 1; i <= 5; i++) {
    assert.ok(
      raw!.rows.some((r) => r[1] === `opt_${i}` && r[2] === `Option ${i}`),
      `raw sheet must keep data row opt_${i}`,
    );
  }
  // …and nothing beyond actual content is invented (header + 5 data rows;
  // a small allowance so the pin doesn't depend on which bounding fix —
  // includeEmpty:false vs actualRowCount — the dev picks).
  assert.ok(
    raw!.rows.length <= 10,
    `raw sheet must be bounded by actual content, got ${raw!.rows.length} rows`,
  );

  // The emitted bytes must be bounded too — HEAD writes all 900 phantom
  // rows back out, bloating every save of a form it never edited.
  const emitted = await serializeXlsForm(form);
  const ws = getSheet(await loadWorkbook(emitted), 'choices-backup');
  assert.ok(
    ws.rowCount <= 10,
    `emitted choices-backup must be bounded by actual content, got ${ws.rowCount} rows`,
  );
  assert.equal(ws.getCell('B6').value, 'opt_5', 'emitted sheet must still carry the last real data row');
});
