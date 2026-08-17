/**
 * Hostile-fixture pins for the actions parser/serializer (handoff items B3
 * and B1, docs/handoff-nssd-safety-batch-2026-08-11.md).
 *
 * Run: `pnpm --filter @cht-ui/shared build && pnpm --filter @cht-ui/shared test`
 *
 * Two places real configs diverge from the canonical shape this parser was
 * written against:
 *
 * - B3: `form` is not always a string literal. Real configs route form ids
 *   through a form-constants module (`form: GERIATRIC_FOLLOWUP`,
 *   `form: FORM_CONSTANTS.x`). HEAD blanks the model's `form` AND shadows
 *   the original token in extras; serializeActions then emits BOTH — a
 *   duplicate `form:` key (fails the config's own lint gate), and because
 *   the LAST key wins in a JS object literal, the stale constant silently
 *   overrides any form change the user makes in the picker.
 * - B1: bare `report.<field>` appears 0 times in 4,000+ lines of real rules
 *   code and is undefined at runtime (proven in the live geriatric probe).
 *   The accessors that exist are `Utils.getField(report, '<group.path>')`
 *   (dominant; `Utils` is a global in tasks.js — no import) and
 *   `report.fields.<name>`. A newly AUTHORED report-source mapping must
 *   emit one of those; a hand-written accessor that was READ from the file
 *   must go back verbatim, whichever shape it uses.
 *
 * The tests pin the CORRECT config-agnostic behavior (preserve what you
 * read; derive runtime-valid tokens for what you write; refuse what you
 * can't model — all-or-nothing per body). The ones HEAD fails are
 * `{ todo: true }` and flip to normal tests when the fix lands.
 *
 * Fixtures are deliberately NON-CANONICAL — identifier / member-expression
 * form values, 1-arg modifyContent, `report.fields.*` RHS, Utils.getField
 * bodies — so every assertion exercises parse AND serialize on shapes the
 * code didn't assume, not just idempotence on already-canonical text
 * (idempotent corruption is the known failure mode here).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseActions,
  serializeActions,
  tryParseSimpleMappings,
  type TaskAction,
} from './actionsParser.js';

/** Occurrences of a `form:` key in emitted source. The fixtures keep the
 *  word `form` out of modifyContent bodies and string values so a plain
 *  count is reliable. */
function countFormKeys(out: string): number {
  return (out.match(/\bform\s*:/g) ?? []).length;
}

/* ============================ B3 — non-string `form` values ============================ */

// B3: HEAD blanks `form` in the model, shadows the token in extras, and
// serializeActions emits BOTH — `form: ''` plus `form: GERIATRIC_FOLLOWUP`.
// Correct behavior: the key appears exactly once, carrying the original
// token verbatim. Flip todo off when the fix lands.
test('B3 §1: identifier form value — no-op round-trip emits the form key exactly once with the original token', { todo: true }, () => {
  const src = `[{ type: 'report', form: GERIATRIC_FOLLOWUP, modifyContent: function (content) { content.age_bucket = report.fields.age_bucket; } }]`;
  const out = serializeActions(parseActions(src));
  assert.equal(countFormKeys(out), 1, `duplicate form key in: ${out}`);
  assert.ok(out.includes('GERIATRIC_FOLLOWUP'), 'original token must be preserved verbatim');
  assert.ok(!out.includes("form: ''"), 'must not emit a blanked form value');
});

// B3: the user-facing consequence of the duplicate key — at HEAD an edit to
// `form` is emitted BEFORE the shadowed constant, so at runtime the stale
// constant wins and the user's change is silently discarded. Correct
// behavior: one form key, referencing the new form only.
// Flip todo off when the fix lands.
test('B3 §2: identifier form value — a user form change is emitted once and not shadowed by the stale constant', { todo: true }, () => {
  const src = `[{ type: 'report', form: GERIATRIC_FOLLOWUP, modifyContent: function (content) { content.age_bucket = report.fields.age_bucket; } }]`;
  const parsed = parseActions(src);
  parsed.actions[0]!.form = 'geriatric_referral';
  const out = serializeActions(parsed);
  assert.equal(countFormKeys(out), 1, `duplicate form key in: ${out}`);
  assert.ok(out.includes('geriatric_referral'), "the user's chosen form must be emitted");
  assert.ok(
    !out.includes('GERIATRIC_FOLLOWUP'),
    'the replaced constant must not survive as a shadowing duplicate key',
  );
});

// B3: same defect with the other real shape — a member expression into a
// form-constants map. Flip todo off when the fix lands.
test('B3 §3: member-expression form value — same single-key contract, token verbatim', { todo: true }, () => {
  const src = `[{ form: FORM_CONSTANTS.geriatric_followup, modifyContent: function (content) { content.follow_up_count = event.days; }, priority: 'high' }]`;
  const out = serializeActions(parseActions(src));
  assert.equal(countFormKeys(out), 1, `duplicate form key in: ${out}`);
  assert.ok(out.includes('FORM_CONSTANTS.geriatric_followup'), 'member expression preserved verbatim');
  assert.ok(!out.includes("form: ''"), 'must not emit a blanked form value');
  // Unrelated extras still ride along untouched.
  assert.ok(out.includes("priority: 'high'"));
});

// B3: the full no-op contract — a constant form plus a body the model can't
// represent is entirely made of preserved tokens, so open→save must be
// byte-identical. HEAD fails only on the form key (the body already
// round-trips via the raw fallback). Flip todo off when the fix lands.
test('B3 §4: constant form + unrepresentable body — no-op round-trip is byte-identical', { todo: true }, () => {
  const src = `[{ form: GERI_REFERRAL, modifyContent: function (content, contact, report) { if (report.fields.risk_level) { content.risk_level = report.fields.risk_level; } } }]`;
  const out = serializeActions(parseActions(src));
  assert.equal(out, src);
});

/* ============================ B1 — report-field accessor emission ============================ */

// B1: DERIVE — when the editor authors a mapping row sourced from a report
// field, today's authoring surface (the client MappingSourcePicker) writes
// bare `report.<field>` into sourceExpr and the serializer emits it
// verbatim — an accessor that is undefined at runtime. Correct behavior:
// whatever function turns a report-sourced row into emitted JS must produce
// `Utils.getField(report, '<path>')` (dominant real shape) or
// `report.fields.<name>` — never bare `report.<field>`. At HEAD the only
// such function in shared is serializeActions, so the pin targets it with
// the model state the picker creates today; if the fix lands as a separate
// accessor builder (client-called), re-target this pin at that builder.
// Flip todo off when the fix lands.
test('B1 §1: an editor-authored report-source mapping emits a runtime-valid accessor, never bare report.<field>', { todo: true }, () => {
  const authored: TaskAction = {
    form: 'geriatric_followup',
    passesVisitWindow: false,
    modifyContentMappings: [{ targetField: 'chest_pain', sourceExpr: 'report.chest_pain' }],
    extras: {},
  };
  const out = serializeActions({ shape: 'array', actions: [authored], raw: '' });
  const runtimeValid =
    /Utils\.getField\(report,\s*'chest_pain'\)/.test(out) ||
    /\breport\.fields\.chest_pain\b/.test(out);
  assert.ok(
    runtimeValid,
    `expected Utils.getField(report, 'chest_pain') or report.fields.chest_pain, got: ${out}`,
  );
  assert.doesNotMatch(out, /report\.chest_pain/, 'bare report.<field> is undefined at runtime');
  // The emitted accessor must survive a re-open unchanged (structured or
  // raw-fallback — either route, no degradation back to a bare access).
  const reopened = serializeActions(parseActions(out));
  assert.doesNotMatch(reopened, /report\.chest_pain/);
});

test("B1 §2: PRESERVE — a hand-written Utils.getField(report, '<group.path>') body survives parse→serialize verbatim", () => {
  // NSSD's dominant shape: `Utils` global, group-qualified dotted path,
  // 1-arg function — three things the canonical fixture never had. The
  // call-parens RHS is outside the structured-mapping grammar, so at HEAD
  // this must take the raw-fallback route and come back byte-preserved.
  // (Pinned as substrings, not whole-string equality, so the pin survives
  // if the B1 fix later teaches the structured grammar this shape.)
  const src = `[{ form: 'geriatric_followup', modifyContent: function (content) { content.chest_pain_ctx = Utils.getField(report, 'danger_signs.chest_pain'); } }]`;
  const parsed = parseActions(src);
  assert.equal(parsed.shape, 'array');
  const out = serializeActions(parsed);
  assert.ok(
    out.includes("content.chest_pain_ctx = Utils.getField(report, 'danger_signs.chest_pain');"),
    `accessor must be preserved verbatim, got: ${out}`,
  );
  assert.doesNotMatch(out, /report\.danger_signs/, 'must not degrade to a bare report access');
  assert.ok(out.includes("form: 'geriatric_followup'"));
});

test('B1 §3: PRESERVE — report.fields.<name> RHS (the other real accessor) round-trips as a structured mapping, verbatim', () => {
  // No parens, so this one IS inside the structured grammar — the mapping
  // must carry the RHS bytes untouched, and serialize must emit them back.
  const fn = `function (content) { content.mobility = report.fields.mobility; }`;
  const mappings = tryParseSimpleMappings(fn);
  assert.ok(mappings, 'report.fields RHS should parse as a structured mapping');
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0]!.sourceExpr, 'report.fields.mobility');

  const src = `[{ form: 'geriatric_followup', modifyContent: ${fn} }]`;
  const parsed = parseActions(src);
  const out = serializeActions(parsed);
  assert.ok(out.includes('content.mobility = report.fields.mobility;'), `got: ${out}`);
  // And the emitted form re-opens to the same structured mapping — the
  // editor can keep round-tripping its own output.
  const reparsed = parseActions(out);
  assert.deepEqual(reparsed.actions[0]!.modifyContentMappings, [
    { targetField: 'mobility', sourceExpr: 'report.fields.mobility' },
  ]);
});

test('B1 §4: REFUSE — an unrepresentable body (declaration + control flow + helper call) round-trips byte-identical, all-or-nothing', () => {
  // Declarations and `if` are permanently outside the structured grammar
  // (the reject-list is the load-bearing safety net), so this body must
  // land in customModifyContent whole and come back byte-for-byte —
  // including the bare `report._id`, which was READ from the file and so
  // must be re-emitted even though we'd never AUTHOR a bare access (B1 §1).
  const src = `[{ form: 'geri_referral', modifyContent: function (content, contact, report) { const reason = Utils.getField(report, 'referral.reason'); if (reason) { content.referral_reason = reason; } content.source_id = report._id; }, priority: 'high' }]`;
  const parsed = parseActions(src);
  const a = parsed.actions[0]!;
  assert.ok(a.customModifyContent, 'body must take the raw-fallback route whole');
  assert.equal(a.modifyContentMappings, undefined, 'no partial structured capture');
  assert.equal(serializeActions(parsed), src);
});
