/**
 * Hostile-fixture pins for the resolvedIf parser — safety batch item A4
 * (docs/handoff-nssd-safety-batch-2026-08-11.md).
 *
 * Run via `pnpm --filter @cht-ui/shared test` after a build (node --test
 * over dist), same as the other suites in this directory.
 *
 * HEAD classifies a body as the canonical "submitted in window" pattern by
 * SUBSTRING match on `isFormArraySubmittedInWindow` anywhere in the text,
 * then the serializer replaces the ENTIRE hand-written body with a template.
 * That drops, among other things, the CHT-canonical
 * `Math.max(Utils.addDate(dueDate, -X).getTime(), report.reported_date + 1)`
 * start clamp — a stale prior report then pre-resolves the task and the CHW
 * never sees it.
 *
 * Correct behavior pinned here (docs/principle-config-agnostic.md postures):
 *   - REFUSE/PRESERVE: a body that is not exactly the canonical
 *     single-return shape stays `raw` and round-trips byte-identical.
 *   - Recognition of the genuinely canonical shape must keep working
 *     (don't over-refuse).
 *
 * Tests marked `{ todo: true }` assert the CORRECT behavior and fail on
 * HEAD by design — flip todo off when the A4 fix lands. Every test calls
 * BOTH parseResolvedIf and serializeResolvedIf on non-canonical input
 * (memory: feedback_roundtrip_tests_must_call_serializer — the one prior
 * test for a shape that never called serialize shipped fail-open
 * corruption).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseResolvedIf, serializeResolvedIf } from './resolvedIfParser.js';

/* ============ REFUSE — near-canonical bodies must stay raw ============ */

// A4 — flip todo off when the fix lands.
test(
  'A4: Math.max start-clamp variant stays raw and round-trips byte-identical',
  { todo: true },
  () => {
    // The CHT-canonical clamp: ignore reports older than the triggering one.
    // Substring-matching HEAD lifts this to `submitted_in_window` and the
    // serializer swaps in the unclamped template — a stale prior report then
    // pre-resolves the task.
    const src = `function (contact, report, event, dueDate) {
  return isFormArraySubmittedInWindow(
    contact.reports,
    FORMS.HOME_VISIT_FOLLOWUP,
    Math.max(Utils.addDate(dueDate, -event.start).getTime(), report.reported_date + 1),
    Utils.addDate(dueDate, event.end + 1).getTime()
  );
}`;
    const parsed = parseResolvedIf(src);
    const out = serializeResolvedIf(parsed);
    assert.equal(parsed.kind, 'raw', 'not exactly the canonical shape → raw');
    assert.equal(out, src, 'hand-written body must be emitted byte-identical');
    assert.match(out, /Math\.max\(/, 'the start clamp must survive the round-trip');
    assert.match(out, /report\.reported_date \+ 1/);
  },
);

// A4 — flip todo off when the fix lands.
test(
  'A4: extra statement before the canonical return stays raw, byte-identical',
  { todo: true },
  () => {
    // All-or-nothing per body: the early-return is part of the author's
    // resolution logic. HEAD keeps only the template and silently drops it.
    const src = `function (contact, report, event, dueDate) {
  if (contact.contact.date_of_death) { return true; }
  return isFormArraySubmittedInWindow(
    contact.reports,
    FORMS.HOME_VISIT_FOLLOWUP,
    Utils.addDate(dueDate, -event.start).getTime(),
    Utils.addDate(dueDate, event.end + 1).getTime()
  );
}`;
    const parsed = parseResolvedIf(src);
    const out = serializeResolvedIf(parsed);
    assert.equal(parsed.kind, 'raw', 'more than a single return → raw');
    assert.equal(out, src);
    assert.match(out, /date_of_death/, 'the early-return guard must survive');
  },
);

// A4 — flip todo off when the fix lands.
test(
  'A4: identifier mentioned only in a comment stays raw (body calls a different helper)',
  { todo: true },
  () => {
    // HEAD's indexOf hits the comment, then reads the arg list of the NEXT
    // call it finds — classifying a countSubmissionsInWindow body as the
    // canonical pattern and replacing it wholesale on save.
    const src = `function (contact, report, event, dueDate) {
  // isFormArraySubmittedInWindow misses SMS submissions, so count reports directly
  return countSubmissionsInWindow(contact.reports, FORMS.HOME_VISIT_FOLLOWUP, dueDate) > 0;
}`;
    const parsed = parseResolvedIf(src);
    const out = serializeResolvedIf(parsed);
    assert.equal(parsed.kind, 'raw', 'a comment mention is not a call');
    assert.equal(out, src);
    assert.match(out, /countSubmissionsInWindow\(/, 'the real callee must survive');
  },
);

// A4 — flip todo off when the fix lands.
test(
  'A4: longer identifier containing the canonical name stays raw',
  { todo: true },
  () => {
    // A project helper whose name merely STARTS WITH the canonical
    // identifier. Substring-matching HEAD rewrites the call to the plain
    // helper — a silent semantic change to whatever "Strict" did.
    const src = `function (contact, report, event, dueDate) {
  return isFormArraySubmittedInWindowStrict(contact.reports, FORMS.HOME_VISIT_FOLLOWUP, event, dueDate);
}`;
    const parsed = parseResolvedIf(src);
    const out = serializeResolvedIf(parsed);
    assert.equal(parsed.kind, 'raw', 'the callee is a different identifier');
    assert.equal(out, src);
    assert.match(out, /isFormArraySubmittedInWindowStrict\(/);
  },
);

/* ====== Recognition — the canonical shape must NOT get over-refused ====== */

test('A4: genuinely canonical multi-line shape is recognized as structured', () => {
  const src = `function (contact, report, event, dueDate) {
  return isFormArraySubmittedInWindow(
    contact.reports,
    FORMS.HOME_VISIT_FOLLOWUP,
    Utils.addDate(dueDate, -event.start).getTime(),
    Utils.addDate(dueDate, event.end + 1).getTime()
  );
}`;
  const parsed = parseResolvedIf(src);
  assert.equal(parsed.kind, 'submitted_in_window');
  if (parsed.kind === 'submitted_in_window') {
    assert.equal(parsed.formsRef, 'FORMS.HOME_VISIT_FOLLOWUP');
  }
  // Serialize must emit a semantically equivalent canonical body: same
  // callee, same form ref, same window args.
  const out = serializeResolvedIf(parsed);
  assert.match(out, /return isFormArraySubmittedInWindow\(/);
  assert.match(out, /FORMS\.HOME_VISIT_FOLLOWUP/);
  assert.match(out, /Utils\.addDate\(dueDate, -event\.start\)\.getTime\(\)/);
  assert.match(out, /Utils\.addDate\(dueDate, event\.end \+ 1\)\.getTime\(\)/);
  // parse → serialize → parse lands on the same structure, and the
  // serializer's own output stays recognized (fixpoint).
  assert.deepEqual(parseResolvedIf(out), parsed);
  assert.equal(serializeResolvedIf(parseResolvedIf(out)), out);
});

test('A4: canonical single-return as a ONE-LINER is still recognized (formatting-insensitive)', () => {
  // Same structure, non-canonical formatting — an exact-match fix must be
  // structural, not whitespace-sensitive, or it over-refuses.
  const src = `function (contact, report, event, dueDate) {
  return isFormArraySubmittedInWindow(contact.reports, FORMS.HOME_VISIT_FOLLOWUP, Utils.addDate(dueDate, -event.start).getTime(), Utils.addDate(dueDate, event.end + 1).getTime());
}`;
  const parsed = parseResolvedIf(src);
  assert.equal(parsed.kind, 'submitted_in_window');
  if (parsed.kind === 'submitted_in_window') {
    assert.equal(parsed.formsRef, 'FORMS.HOME_VISIT_FOLLOWUP');
  }
  assert.deepEqual(parseResolvedIf(serializeResolvedIf(parsed)), parsed);
});

test('A4: quoted-string form ref is captured and re-emitted VERBATIM (project shape, not ours)', () => {
  // nssd-style: a bare string literal instead of a FORMS.* constant. The
  // DERIVE posture: the ref's shape belongs to the project — no rewriting
  // to a constant, no quote changes.
  const src = `function (contact, report, event, dueDate) {
  return isFormArraySubmittedInWindow(contact.reports, 'home_visit_followup', Utils.addDate(dueDate, -event.start).getTime(), Utils.addDate(dueDate, event.end + 1).getTime());
}`;
  const parsed = parseResolvedIf(src);
  assert.equal(parsed.kind, 'submitted_in_window');
  if (parsed.kind === 'submitted_in_window') {
    assert.equal(parsed.formsRef, "'home_visit_followup'");
  }
  const out = serializeResolvedIf(parsed);
  assert.match(out, /'home_visit_followup'/, 'single-quoted ref survives verbatim');
  assert.equal(/"home_visit_followup"/.test(out), false, 'no quote-style rewrite');
  assert.deepEqual(parseResolvedIf(out), parsed);
});

/* ============ PRESERVE — shapes HEAD already keeps raw ============ */

test('A4: bare helper identifier round-trips byte-identical', () => {
  // Real configs point resolvedIf at a named nools-extras helper.
  const src = 'hasVisitReportInWindow';
  const parsed = parseResolvedIf(src);
  assert.equal(parsed.kind, 'identifier');
  if (parsed.kind === 'identifier') {
    assert.equal(parsed.name, 'hasVisitReportInWindow');
  }
  assert.equal(serializeResolvedIf(parsed), src);
});

test('A4: hand-written body without the identifier stays raw, byte-identical', () => {
  const src = `function (contact, report) {
  return report.reported_date < contact.contact.last_visit_date;
}`;
  const parsed = parseResolvedIf(src);
  assert.equal(parsed.kind, 'raw');
  assert.equal(serializeResolvedIf(parsed), src);
});

test('A4: trailing comment mention with no call at all stays raw, byte-identical', () => {
  // The identifier appears after the last `(` in the body, so even HEAD's
  // substring match cannot find an arg list — pin that this keeps working.
  const src = `function (contact, report, event, dueDate) {
  return report.resolved; // TODO: switch to isFormArraySubmittedInWindow
}`;
  const parsed = parseResolvedIf(src);
  assert.equal(parsed.kind, 'raw');
  assert.equal(serializeResolvedIf(parsed), src);
});
