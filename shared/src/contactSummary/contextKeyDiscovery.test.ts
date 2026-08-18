/**
 * Three-channel context-key discovery
 * (docs/plans/pick-preexisting-context-values.md).
 *
 * ## Fixtures are distilled, not copied
 *
 * Every shape below is reduced from a real config on disk, hand-written
 * here. Customer configs are never committed as fixtures (QA rider,
 * docs/principle-config-agnostic.md) — and the plan is explicit that a tidy
 * fixture is why the picker reported zero keys in the first place, so these
 * keep the awkward parts: the delegation across files, assignments buried
 * in nested `if`s, template-literal key families, and the card-field
 * `context:` decoy.
 *
 * ## What the real configs produce, measured with this module
 *
 *              ch1 forms   ch2 eligibility   ch3 definitions   union
 *   nssd/chis        63                 7                21      70
 *   gandaki           3                 3                 6       9
 *   lumbini          31                 5                11      39
 *   moh-nepal         3                 3                 6       9
 *
 * NSSD's 21/63/7 match the plan's independently-measured figures exactly.
 * 49 of its 70 keys are visible ONLY through consumption — the `*_vax`
 * series, the ANC set and the `baby_*_ctx` families — which is the whole
 * argument for putting the consumption channels first.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  harvestContextKeyReads,
  mergeContextScan,
  scanContextDefinitions,
  scanEligibilityForContextReads,
  scanFormsForContextReads,
  type FormForScan,
} from './contextKeyDiscovery.js';
import type { SurveyRow, XLSForm } from '../xlsform/types.js';

const CTX = (k: string) => `instance('contact-summary')/context/${k}`;

/* ------------------------------- helpers -------------------------------- */

function calcRow(name: string, calculation: string): SurveyRow {
  return { rowId: `r_${name}`, type: 'calculate', name, labels: { en: '' }, extras: { calculation } };
}

function form(formId: string, rows: SurveyRow[]): FormForScan {
  const xlsform: XLSForm = {
    locales: ['en'],
    surveyHeaders: { ordered: ['type', 'name', 'label::en', 'calculation'], labelLocales: ['en'] },
    choicesHeaders: { ordered: ['list_name', 'name', 'label::en'], labelLocales: ['en'] },
    survey: rows,
    choices: [],
    settings: {
      form_title: formId,
      form_id: formId,
      version: '',
      default_language: 'en',
      extras: {},
    },
    extraSheets: [],
  };
  return { formId, xlsform };
}

/* ================== channel 1 — reads inside form cells ================== */

test('ch1: harvests a whole-cell read together with its wrapper idiom', () => {
  const hits = harvestContextKeyReads(`once(${CTX('previous_bmi_ctx')})`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.key, 'previous_bmi_ctx');
  assert.equal(hits[0]?.wrapper, 'read-once');
});

test('ch1: finds a key used INSIDE a larger expression, with no wrapper', () => {
  // recognizeReference anchors on the whole trimmed cell, so relying on it
  // alone would miss this entirely. Discovery wants every occurrence.
  const cell = `concat(${CTX('baby_name_1_ctx')}, ' ', \${surname})`;
  const hits = harvestContextKeyReads(cell);
  assert.deepEqual(hits, [{ key: 'baby_name_1_ctx', wrapper: null }]);
});

test('ch1: a fallback cell names the same key twice but counts ONCE', () => {
  // `if(REF, REF, .)` and `if(REF != '', REF, .)` repeat the key by
  // construction. Counting occurrences double-counted them and inverted the
  // usage ranking the picker sorts by — on NSSD, 79 real cells produced 147
  // hits, putting a 3-cell key above a 5-cell one.
  for (const cell of [
    `if(${CTX('sys_ctx')}, ${CTX('sys_ctx')}, .)`,
    `if(${CTX('sys_ctx')} != '', ${CTX('sys_ctx')}, .)`,
  ]) {
    const hits = harvestContextKeyReads(cell);
    assert.equal(hits.length, 1, cell);
    assert.equal(hits[0]?.key, 'sys_ctx', cell);
    assert.ok(hits[0]?.wrapper, 'the whole-cell wrapper still comes through');
  }
});

test('ch1: two DIFFERENT keys in one cell are both counted', () => {
  // Deduping is per-key, not per-cell — a cell reading two keys really does
  // read two keys.
  const hits = harvestContextKeyReads(`concat(${CTX('a')}, ' ', ${CTX('b')})`);
  assert.deepEqual(
    hits.map((h) => h.key).sort(),
    ['a', 'b'],
  );
});

test('ch1: a cell with no context read costs nothing and yields nothing', () => {
  for (const cell of ['', '${age} * 2', '../inputs/contact/name', 'coalesce(${a}, .)']) {
    assert.deepEqual(harvestContextKeyReads(cell), [], cell);
  }
});

test('ch1: scans every form and counts usage per key', () => {
  const forms = [
    form('anc_visit', [
      calcRow('lmp', `if(${CTX('lmp_date_8601')} != '', ${CTX('lmp_date_8601')}, .)`),
      calcRow('bmi', `once(${CTX('previous_bmi_ctx')})`),
    ]),
    form('pnc_visit', [calcRow('lmp2', `once(${CTX('lmp_date_8601')})`)]),
  ];
  const hits = scanFormsForContextReads(forms);
  const lmp = hits.filter((h) => h.key === 'lmp_date_8601');
  // One per CELL: the guarded cell counts once despite naming the key twice.
  assert.equal(lmp.length, 2);
  assert.deepEqual([...new Set(lmp.map((h) => h.formId))], ['anc_visit', 'pnc_visit']);
});

test('ch1: reads in relevant / constraint are found too', () => {
  // Measured, all 132 real occurrences sit in `calculation`. The other
  // columns are scanned anyway rather than hardcoding that observation.
  const rows: SurveyRow[] = [
    {
      rowId: 'r1',
      type: 'string',
      name: 'q',
      labels: { en: 'Q' },
      extras: { relevant: `${CTX('show_pregnancy_form')} = 'true'` },
    },
  ];
  const hits = scanFormsForContextReads([form('f', rows)]);
  assert.deepEqual(
    hits.map((h) => h.key),
    ['show_pregnancy_form'],
  );
});

/* ================ channel 2 — reads in form eligibility ================= */

test('ch2: finds summary.<key> in an && chain', () => {
  // The real shape from nssd's breast_cancer_followup.properties.json.
  const expression =
    "contact.contact_type === 'c82_person' && contact.gender ==='female' && " +
    '!contact.muted && !contact.date_of_death && summary.show_breast_cancer_followup_form';
  const hits = scanEligibilityForContextReads([{ formId: 'breast_cancer_followup', expression }]);
  assert.deepEqual(
    hits.map((h) => h.key),
    ['show_breast_cancer_followup_form'],
  );
});

test('ch2: finds keys the structured parser would drop — || branches, negation', () => {
  // A regex over the raw text on purpose: parseContextExpression splits on
  // && and collapses anything it cannot classify into one `raw` rule, so a
  // key inside an || branch would be invisible to it.
  const hits = scanEligibilityForContextReads([
    { formId: 'f', expression: 'summary.a || (!summary.b && summary.c)' },
  ]);
  assert.deepEqual(hits.map((h) => h.key).sort(), ['a', 'b', 'c']);
});

test('ch2: an empty or absent expression is not an error', () => {
  assert.deepEqual(scanEligibilityForContextReads([{ formId: 'f', expression: '' }]), []);
  assert.deepEqual(scanEligibilityForContextReads([]), []);
});

/* ============== channel 3 — the static definition scan ================== */

/**
 * The NSSD shape, distilled: the templated file computes nothing itself and
 * delegates to `getContext` in the EXTRAS file, which opens with an
 * Object.assign spread, sets seven keys unconditionally, then more inside
 * nested `if`s, and builds a family of keys from a template literal.
 */
const NSSD_TEMPLATED = `const thisContact = contact;
const allReports = reports;
const context = getContext(thisContact, allReports);

const fields = [
  { label: 'contact.age', value: thisContact.date_of_birth, width: 4 },
  // The decoy: a translation-interpolation context on a card field. It is
  // NOT the summary context and must never be offered as a pickable key.
  { label: 'contact.profile.visit', value: 'contact.profile.visits.of',
    context: { count: countVisits(allReports), total: 8 }, translate: true },
];

module.exports = {
  fields: fields,
  cards: [],
  context: context,
};
`;

const NSSD_EXTRAS = `function getContext(thisContact, allReports) {
  const context = Object.assign({},
    getAge(thisContact) <= 5 ? getChildVaccinations(thisContact, allReports) : {});

  context.alive = isAlive(thisContact);
  context.has_become_form = isBecomeFormSubmitted(thisContact, allReports);
  context.show_pregnancy_form = isReadyForNewPregnancy(thisContact, allReports);

  if (thisContact.contact_type === 'c82_person' && getAge(thisContact) >= 30) {
    const hasNcdRecord = allReports.some(r => ['hypertension_screening'].includes(r.form));
    if (hasNcdRecord) {
      context.previous_bmi_ctx = getMostRecentBMIFromReports(allReports);
      const { systolic, diastolic } = getLatestBloodPressure(allReports, 'hypertension_screening');
      context.sys_ctx = systolic;
      context.dia_ctx = diastolic;
    }
  }

  if (isPostnatal(thisContact, allReports)) {
    for (let i = 1; i <= maxNumberOfBabies; i++) {
      context[\`baby_name_\${i}_ctx\`] = deliveryInfo(reports, i - 1, 'baby_name');
      context[\`baby_status_\${i}_ctx\`] = deliveryInfo(reports, i - 1, 'baby_status');
    }
  }

  return context;
}
`;

test('ch3: follows the indirection across files and finds the assignments', () => {
  // This is the case that reported ZERO before: the templated file holds no
  // context literal at all, so the old detector bailed with contextBounds
  // null and nobody was told why.
  const scan = scanContextDefinitions([
    { file: 'contact-summary.templated.js', source: NSSD_TEMPLATED },
    { file: 'contact-summary-extras.js', source: NSSD_EXTRAS },
  ]);
  assert.equal(scan.found, true);
  assert.deepEqual(
    [...new Set(scan.hits.map((h) => h.key))].sort(),
    ['alive', 'dia_ctx', 'has_become_form', 'previous_bmi_ctx', 'show_pregnancy_form', 'sys_ctx'],
  );
  // And it says which file, so an author can go look.
  for (const h of scan.hits) assert.equal(h.file, 'contact-summary-extras.js');
});

test('ch3: conditional is true only for assignments nested in a branch', () => {
  const scan = scanContextDefinitions([
    { file: 'contact-summary.templated.js', source: NSSD_TEMPLATED },
    { file: 'contact-summary-extras.js', source: NSSD_EXTRAS },
  ]);
  const byKey = new Map(scan.hits.map((h) => [h.key, h]));
  for (const k of ['alive', 'has_become_form', 'show_pregnancy_form']) {
    assert.equal(byKey.get(k)?.conditional, false, `${k} is set unconditionally`);
  }
  for (const k of ['previous_bmi_ctx', 'sys_ctx', 'dia_ctx']) {
    assert.equal(byKey.get(k)?.conditional, true, `${k} is only set inside an if`);
  }
});

test('ch3: the card-field `context: { count, total }` decoy is NOT offered', () => {
  // The trap the plan calls out. A file-wide scan for `context\\s*:\\s*\\{`
  // would offer `count` and `total` as pickable context keys.
  const scan = scanContextDefinitions([
    { file: 'contact-summary.templated.js', source: NSSD_TEMPLATED },
    { file: 'contact-summary-extras.js', source: NSSD_EXTRAS },
  ]);
  const keys = scan.hits.map((h) => h.key);
  assert.equal(keys.includes('count'), false, 'count is a translation arg, not a context key');
  assert.equal(keys.includes('total'), false, 'total is a translation arg, not a context key');
});

test('ch3: reports what it provably cannot see', () => {
  const scan = scanContextDefinitions([
    { file: 'contact-summary.templated.js', source: NSSD_TEMPLATED },
    { file: 'contact-summary-extras.js', source: NSSD_EXTRAS },
  ]);
  const reasons = scan.indeterminate.map((n) => n.reason);
  assert.ok(reasons.includes('template-literal-key'), 'the baby_* families are a key FAMILY');
  assert.ok(reasons.includes('spread-from-call'), 'Object.assign pulls keys from elsewhere');
  // The evidence has to be specific enough to act on.
  const tpl = scan.indeterminate.find((n) => n.reason === 'template-literal-key');
  assert.match(tpl?.evidence ?? '', /baby_name|baby_status/);
});

test('ch3: filename spelling is never assumed — both real spellings work', () => {
  // Four customer configs use `contact-summary.extras.js`; NSSD and all
  // four templates we ship use `contact-summary-extras.js`. The old route
  // hardcoded the dot and was therefore blind to its own templates.
  for (const extrasName of ['contact-summary-extras.js', 'contact-summary.extras.js']) {
    const scan = scanContextDefinitions([
      { file: 'contact-summary.templated.js', source: NSSD_TEMPLATED },
      { file: extrasName, source: NSSD_EXTRAS },
    ]);
    assert.equal(scan.found, true, extrasName);
    assert.ok(scan.hits.some((h) => h.key === 'alive'), extrasName);
    assert.ok(
      scan.hits.every((h) => h.file === extrasName),
      `definitions must be attributed to ${extrasName}`,
    );
  }
});

test('ch3: the plain literal shape still works and is unconditional', () => {
  const src = `const context = {
  show_pregnancy_form: isReadyForNewPregnancy(contact, reports),
  alive: isAlive(contact),
};
module.exports = { fields: [], cards: [], context: context };
`;
  const scan = scanContextDefinitions([{ file: 'contact-summary.templated.js', source: src }]);
  assert.equal(scan.found, true);
  assert.deepEqual(scan.hits.map((h) => h.key).sort(), ['alive', 'show_pregnancy_form']);
  for (const h of scan.hits) {
    assert.equal(h.origin, 'definition-literal');
    assert.equal(h.conditional, false);
  }
  // The RHS comes back so the UI can show "computed from…".
  const alive = scan.hits.find((h) => h.key === 'alive');
  assert.equal(alive?.expression, 'isAlive(contact)');
});

test('ch3: bracket-with-string-literal is a key; a computed bracket is not', () => {
  const src = `function getContext(c, r) {
  const context = {};
  context['snake_key'] = 1;
  context["double_quoted"] = 2;
  context[someVar] = 3;
  return context;
}
const context = getContext(contact, reports);
`;
  const scan = scanContextDefinitions([{ file: 'cs.js', source: src }]);
  assert.deepEqual(scan.hits.map((h) => h.key).sort(), ['double_quoted', 'snake_key']);
  assert.deepEqual(
    scan.indeterminate.map((n) => n.reason),
    ['dynamic-key'],
  );
});

test('ch3: context.x === y is a comparison, not an assignment', () => {
  const src = `function getContext(c, r) {
  const context = {};
  if (context.alive === true) { doThing(); }
  if (context.other == 1) { doThing(); }
  context.real_key = 1;
  return context;
}
const context = getContext(contact, reports);
`;
  const scan = scanContextDefinitions([{ file: 'cs.js', source: src }]);
  assert.deepEqual(scan.hits.map((h) => h.key), ['real_key']);
});

test('ch3: a similarly-named variable is not mistaken for context', () => {
  const src = `function getContext(c, r) {
  const context = {};
  const myContext = {};
  myContext.not_a_key = 1;
  subContext.also_not = 2;
  context.real_key = 3;
  return context;
}
const context = getContext(contact, reports);
`;
  const scan = scanContextDefinitions([{ file: 'cs.js', source: src }]);
  assert.deepEqual(scan.hits.map((h) => h.key), ['real_key']);
});

test('ch3: assignments inside comments and strings are ignored', () => {
  const src = `function getContext(c, r) {
  const context = {};
  // context.commented_out = 1;
  /* context.block_commented = 2; */
  const doc = 'context.in_a_string = 3;';
  context.real_key = 4;
  return context;
}
const context = getContext(contact, reports);
`;
  const scan = scanContextDefinitions([{ file: 'cs.js', source: src }]);
  assert.deepEqual(scan.hits.map((h) => h.key), ['real_key']);
});

test('ch3: no context at all reports found=false, NOT an empty success', () => {
  // Today's bug is exactly this going unreported: an empty list looks
  // identical to "this config computes nothing".
  const scan = scanContextDefinitions([
    { file: 'contact-summary.templated.js', source: 'module.exports = { fields: [], cards: [] };' },
  ]);
  assert.equal(scan.found, false);
  assert.deepEqual(scan.hits, []);
});

test('ch3: delegation to a function we cannot find says so out loud', () => {
  const scan = scanContextDefinitions([
    {
      file: 'contact-summary.templated.js',
      source: 'const context = buildContext(contact, reports);\nmodule.exports = { context };',
    },
  ]);
  assert.equal(scan.indeterminate.length, 1);
  assert.equal(scan.indeterminate[0]?.reason, 'spread-from-call');
  assert.match(scan.indeterminate[0]?.evidence ?? '', /buildContext/);
});

test('ch3: no files at all degrades quietly', () => {
  const scan = scanContextDefinitions([]);
  assert.deepEqual(scan, { hits: [], indeterminate: [], found: false });
});

/* ============================== the merge =============================== */

test('merge: proven-by-use keys rank first, most-read first', () => {
  const scan = mergeContextScan({
    formReads: [
      { key: 'lmp_date_8601', formId: 'a', wrapper: 'guarded-fallback' },
      { key: 'lmp_date_8601', formId: 'b', wrapper: 'guarded-fallback' },
      { key: 'sys_ctx', formId: 'a', wrapper: 'fallback-to-current' },
    ],
    eligibilityReads: [{ key: 'show_pregnancy_form', formId: 'c', wrapper: null }],
    definitions: {
      hits: [
        {
          key: 'never_read',
          origin: 'definition-assignment',
          conditional: false,
          expression: 'x()',
          file: 'cs.js',
        },
      ],
      indeterminate: [],
      found: true,
    },
  });
  assert.deepEqual(
    scan.keys.map((k) => k.key),
    ['lmp_date_8601', 'show_pregnancy_form', 'sys_ctx', 'never_read'],
  );
  assert.equal(scan.keys[0]?.usageCount, 2);
  assert.deepEqual(scan.keys[0]?.usedBy, ['a', 'b']);
  assert.equal(scan.keys[0]?.idiom, 'guarded-fallback');
  // The unread one is still offered, just last and with no proof of use.
  const unread = scan.keys.find((k) => k.key === 'never_read');
  assert.equal(unread?.usageCount, 0);
  assert.equal(unread?.idiom, null);
});

test('merge: a key found by several channels carries every origin', () => {
  const scan = mergeContextScan({
    formReads: [{ key: 'alive', formId: 'f1', wrapper: 'none' }],
    eligibilityReads: [{ key: 'alive', formId: 'f2', wrapper: null }],
    definitions: {
      hits: [
        {
          key: 'alive',
          origin: 'definition-assignment',
          conditional: false,
          expression: 'isAlive(c)',
          file: 'cs.js',
        },
      ],
      indeterminate: [],
      found: true,
    },
  });
  assert.equal(scan.keys.length, 1);
  assert.deepEqual(scan.keys[0]?.origins, [
    'form-calculation',
    'form-eligibility',
    'definition-assignment',
  ]);
  assert.equal(scan.keys[0]?.usageCount, 2);
  assert.equal(scan.keys[0]?.expression, 'isAlive(c)');
});

test('merge: conditional is an AND over definitions, whatever the order', () => {
  // One unconditional assignment means the key always exists. Folding this
  // in place made the answer depend on which hit arrived first.
  const cond = {
    key: 'k',
    origin: 'definition-assignment' as const,
    conditional: true,
    expression: 'a()',
    file: 'cs.js',
  };
  const uncond = { ...cond, conditional: false, expression: 'b()' };
  for (const hits of [
    [cond, uncond],
    [uncond, cond],
  ]) {
    const scan = mergeContextScan({ definitions: { hits, indeterminate: [], found: true } });
    assert.equal(scan.keys[0]?.conditional, false, 'an unconditional definition wins');
    assert.equal(scan.keys[0]?.expression, 'b()', 'and its expression is the useful hint');
  }
  const onlyCond = mergeContextScan({
    definitions: { hits: [cond], indeterminate: [], found: true },
  });
  assert.equal(onlyCond.keys[0]?.conditional, true);
});

test('merge: the per-key idiom is the majority of that key\'s reads', () => {
  const scan = mergeContextScan({
    formReads: [
      { key: 'k', formId: 'a', wrapper: 'read-once' },
      { key: 'k', formId: 'b', wrapper: 'guarded-fallback' },
      { key: 'k', formId: 'c', wrapper: 'guarded-fallback' },
    ],
  });
  assert.equal(scan.keys[0]?.idiom, 'guarded-fallback');
});

test('merge: indeterminate notes and definitionsFound survive the fold', () => {
  const scan = mergeContextScan({
    definitions: {
      hits: [],
      indeterminate: [{ reason: 'dynamic-key', evidence: 'context[key] = …', file: 'cs.js' }],
      found: true,
    },
  });
  assert.equal(scan.definitionsFound, true);
  assert.equal(scan.indeterminate.length, 1);
});

test('merge: nothing in, honest nothing out', () => {
  const scan = mergeContextScan({});
  assert.deepEqual(scan.keys, []);
  assert.deepEqual(scan.indeterminate, []);
  assert.equal(scan.definitionsFound, false, 'absent is not the same as empty');
});


/* =============== robustness: found by adversarial review ================
 *
 * Every case below silently LOST keys and reported the list as complete —
 * the one failure mode contextKeyDiscovery's own docstring forbids, because a
 * key that exists at runtime but is missing from the picker reads to the
 * author as their own spelling mistake. None was caught by the suite above;
 * all were found by review agents running the built module.
 */

test('robustness: a regex literal containing a quote does not swallow the file', () => {
  // `.replace(/'/g, '')` is ordinary contact-summary code. The quote inside
  // the regex used to open a phantom string that ran to end-of-file, so every
  // later assignment vanished with indeterminate: [].
  const src = `
const context = {};
context.alive = !contact.date_of_death;
const clean = (contact.name || '').replace(/'/g, '');
context.clean_name = clean;
context.show_pregnancy_form = true;
context.total_visit = 3;
module.exports = { fields: [], cards: [], context };
`;
  const scan = scanContextDefinitions([{ file: 'cs.js', source: src }]);
  assert.deepEqual(
    [...new Set(scan.hits.map((h) => h.key))].sort(),
    ['alive', 'clean_name', 'show_pregnancy_form', 'total_visit'],
  );
});

test('robustness: a division is still treated as code, not a regex', () => {
  // The other half of the JS `/` ambiguity. Getting this wrong the other way
  // would eat the rest of the line.
  const src = `
function getContext(c, r) {
  const context = {};
  context.ratio = c.weight / c.height;
  context.after = 1;
  return context;
}
const context = getContext(contact, reports);
`;
  const scan = scanContextDefinitions([{ file: 'cs.js', source: src }]);
  assert.deepEqual(scan.hits.map((h) => h.key), ['ratio', 'after']);
});

test('robustness: any amount of whitespace before `=` is still an assignment', () => {
  // A 3-character look-ahead meant `context['lmp_date']    = 1` read as a
  // non-assignment and the key was dropped.
  const src = `
function getContext(c, r) {
  const context = {};
  context['lmp_date']    = 1;
  context['edd']   = 2;
  context['ok'] = 3;
  return context;
}
const context = getContext(contact, reports);
`;
  const scan = scanContextDefinitions([{ file: 'cs.js', source: src }]);
  assert.deepEqual(scan.hits.map((h) => h.key).sort(), ['edd', 'lmp_date', 'ok']);
});

test('robustness: a widely-spaced template-literal key still raises the note', () => {
  // Worse than losing a key: losing the DISCLOSURE that a whole key family
  // exists, so the scan claimed completeness.
  const src = `
function getContext(c, r) {
  const context = {};
  for (let i = 1; i < 5; i++) context[\`baby_\${i}\`]    = i;
  return context;
}
const context = getContext(contact, reports);
`;
  const scan = scanContextDefinitions([{ file: 'cs.js', source: src }]);
  assert.deepEqual(
    scan.indeterminate.map((n) => n.reason),
    ['template-literal-key'],
  );
});

test('robustness: a commented-out binding does not win over the live one', () => {
  // The dead helper's keys were offered as the config's, and the two real keys
  // were never scanned.
  const scan = scanContextDefinitions([
    {
      file: 'templated.js',
      source: `
// legacy: const context = oldContext(contact);
const context = {};
context.alive = true;
context.show_pregnancy_form = true;
module.exports = { context };
`,
    },
    {
      file: 'extras.js',
      source: 'function oldContext(c) { const context = {}; context.legacy_only = 1; return context; }',
    },
  ]);
  const keys = scan.hits.map((h) => h.key).sort();
  assert.deepEqual(keys, ['alive', 'show_pregnancy_form']);
  assert.equal(keys.includes('legacy_only'), false, 'the dead helper is not the source');
});

test('robustness: getContext written as an arrow function still resolves', () => {
  // Arrow-assigned helpers are a common style. Matching only
  // `function NAME(` returned zero keys AND claimed the definition was not
  // found in the contact-summary files, when it was right there.
  const scan = scanContextDefinitions([
    { file: 'templated.js', source: 'const context = getContext(contact, reports);\nmodule.exports={context};' },
    {
      file: 'extras.js',
      source:
        'const getContext = (contact, reports) => { const context = {}; context.alive = true; context.show_pregnancy_form = true; return context; };',
    },
  ]);
  assert.equal(scan.found, true);
  assert.deepEqual(scan.hits.map((h) => h.key).sort(), ['alive', 'show_pregnancy_form']);
});

test('robustness: getContext as a method shorthand also resolves', () => {
  const scan = scanContextDefinitions([
    { file: 'templated.js', source: 'const context = getContext(contact, reports);' },
    {
      file: 'extras.js',
      source:
        'module.exports = { getContext(contact, reports) { const context = {}; context.alive = true; return context; } };',
    },
  ]);
  assert.equal(scan.found, true);
  assert.deepEqual(scan.hits.map((h) => h.key), ['alive']);
});

test('robustness: Object.assign of a readable literal is NOT reported as hidden', () => {
  // The spread test matched any `identifier(` in the argument list, so a call
  // used as an object VALUE looked like a call ARGUMENT. Telling an author the
  // list is incomplete when it is complete trains them to distrust a correct
  // list — its own defect.
  const scan = scanContextDefinitions([
    {
      file: 'cs.js',
      source: 'const context = Object.assign({}, { alive: isAlive(thisContact) });\nmodule.exports={context};',
    },
  ]);
  assert.deepEqual(scan.indeterminate, []);
});

test('robustness: Object.assign of a CALL is still reported as hidden', () => {
  // NSSD's real shape — the note must keep firing for it.
  const scan = scanContextDefinitions([
    {
      file: 'cs.js',
      source:
        'const context = Object.assign({}, getAge(c) <= 5 ? getChildVaccinations(c, r) : {});\nmodule.exports={context};',
    },
  ]);
  assert.deepEqual(
    scan.indeterminate.map((n) => n.reason),
    ['spread-from-call'],
  );
});

test('robustness: a right-hand side wrapped across lines still yields its text', () => {
  // Breaking on every newline left `expression: null`, so the picker's
  // "computed from…" hint was blank for any wrapped RHS.
  const src = `
function getContext(c, r) {
  const context = {};
  context.total =
    a + b;
  context.next = 1;
  return context;
}
const context = getContext(contact, reports);
`;
  const scan = scanContextDefinitions([{ file: 'cs.js', source: src }]);
  assert.equal(scan.hits.find((h) => h.key === 'total')?.expression, 'a + b');
  assert.equal(scan.hits.find((h) => h.key === 'next')?.expression, '1');
});

test('robustness: merge never lets a null expression overwrite a real one', () => {
  const scan = mergeContextScan({
    definitions: {
      hits: [
        {
          key: 'k',
          origin: 'definition-assignment',
          conditional: true,
          expression: 'good()',
          file: 'a.js',
        },
        {
          key: 'k',
          origin: 'definition-assignment',
          conditional: false,
          expression: null,
          file: 'a.js',
        },
      ],
      indeterminate: [],
      found: true,
    },
  });
  assert.equal(scan.keys[0]?.expression, 'good()');
  assert.equal(scan.keys[0]?.conditional, false, 'and the unconditional hit still wins on that');
});
