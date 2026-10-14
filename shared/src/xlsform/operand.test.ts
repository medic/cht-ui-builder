/**
 * T9a (#14) — the operand grammar behind `.`-subject rules.
 *
 * Positive cases assert the tree AND that canonical serialization is what
 * the design says; negative cases pin what stays outside the grammar (and
 * therefore raw text upstream).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  isSelfOperand,
  operandFields,
  parseOperand,
  serializeOperand,
  type Operand,
} from './operand.js';

test('operand: `.` is self, with or without parens', () => {
  assert.deepEqual(parseOperand('.'), { kind: 'self' });
  const wrapped = parseOperand('(.)');
  assert.ok(wrapped && isSelfOperand(wrapped));
  assert.equal(serializeOperand(wrapped!), '(.)');
});

test('operand: `${f}` and `../f` are the same field with different spellings, re-emitted as written', () => {
  assert.deepEqual(parseOperand('${lmp_date}'), { kind: 'field', name: 'lmp_date', spelling: 'braces' });
  assert.deepEqual(parseOperand('../lmp_date'), { kind: 'field', name: 'lmp_date', spelling: 'relative' });
  assert.equal(serializeOperand(parseOperand('../lmp_date')!), '../lmp_date');
  assert.equal(serializeOperand(parseOperand('${lmp_date}')!), '${lmp_date}');
});

test('operand: literals keep their text', () => {
  assert.deepEqual(parseOperand('36.50'), { kind: 'number', text: '36.50' });
  assert.deepEqual(parseOperand('-1'), { kind: 'number', text: '-1' });
  assert.deepEqual(parseOperand("'none'"), { kind: 'string', value: 'none', quote: "'" });
  assert.deepEqual(parseOperand('"a b"'), { kind: 'string', value: 'a b', quote: '"' });
  assert.equal(serializeOperand(parseOperand("'x'")!), "'x'");
});

test('operand: nested calls and arithmetic with canonical spacing', () => {
  const src = "int(format-date(today(),'%Y'))+57";
  const o = parseOperand(src);
  assert.ok(o);
  assert.equal(o!.kind, 'binary');
  assert.equal(serializeOperand(o!), "int(format-date(today(), '%Y')) + 57");

  const max = parseOperand('max(coalesce(${a},0),coalesce(${b},0))');
  assert.equal(serializeOperand(max!), 'max(coalesce(${a}, 0), coalesce(${b}, 0))');
  assert.deepEqual(operandFields(max!), ['a', 'b']);

  const div = parseOperand('floor( difference-in-months( ${dob}, today() ) div 12 )');
  assert.equal(serializeOperand(div!), 'floor(difference-in-months(${dob}, today()) div 12)');
});

test('operand: `today() - 30` and `today() - ${f}` are binary nodes', () => {
  const a = parseOperand('today() - 30') as Operand;
  assert.equal(a.kind, 'binary');
  const b = parseOperand('today()-${f}') as Operand;
  assert.equal(b.kind, 'binary');
  assert.equal(serializeOperand(b), 'today() - ${f}');
});

test('operand: outside the grammar → null (unknown function, multi-segment path, unterminated string, dangling operator)', () => {
  assert.equal(parseOperand('frobnicate(.)'), null);
  assert.equal(parseOperand('../inputs/contact/sex'), null);
  assert.equal(parseOperand('../a/b'), null);
  assert.equal(parseOperand("'unterminated"), null);
  assert.equal(parseOperand('. +'), null);
  assert.equal(parseOperand(''), null);
  assert.equal(parseOperand('instance(\'contact-summary\')/context/x'), null);
});
