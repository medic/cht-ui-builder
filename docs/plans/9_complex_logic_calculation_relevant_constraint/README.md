<!--
Epic plan for T9 (medic/cht-ui-builder#9). Written 2026-10-01 by the planner acting as PO.
This folder holds the main plan (this file), the analysis it rests on, and nothing else.
Per-slice ticket bodies live in .github/tickets/t9a.md … t9g.md and are filed as sub-issues of #9.
-->

# T9 — Complex logic: calculation, relevance, constraint

**Status:** epic, in progress · sub-issues #14 to #20 filed 2026-10-01 · **Ticket:** [medic/cht-ui-builder#9](https://github.com/medic/cht-ui-builder/issues/9) ·
**Branch convention:** one short branch per sub-issue off `master` (`9a_parser_dot_subject`, …), not one long-lived T9 branch.

**Documents in this folder**

| File | What it is |
| --- | --- |
| `README.md` (this) | The epic plan: what shipped, what is left, how it is sliced, what "done" means. |
| [`validation-rules-v2.md`](./validation-rules-v2.md) | The analysis: 777 real `constraint` rules across seven configs, the gap matrix, the UI/UX review of condition authoring, decisions. Live copy: <https://claude.ai/code/artifact/729e0b55-c812-4c2d-af84-7f85c4107469> (rev 49, v2). |

Earlier, planner-locked plans that shipped parts of T9 stay where they are and are linked below. Where a line number is cited anywhere in this folder it is against `origin/master` at `bff69cb` (2026-10-01).

## Why this is an epic now

T9 was filed in June as one L ticket with four builders. Since then three plans shipped most of the builders, and a 2026-10-01 audit of real configs found that the builders open **3 of the 777** real validation rules and that the authoring flow fails a cold-start user at three points. The remaining work is too large and too varied for one PR: a shared-parser change with round-trip risk, a new Validation panel, a field-picker rewrite, an add-question flow change, and an audit of the original acceptance. Each is independently shippable and testable, so each becomes a sub-issue.

## Status of the original T9 scope (audited 2026-10-01 against `bff69cb`)

| Original scope item | Status | Where |
| --- | --- | --- |
| Visual builder for *show this question when…*: pick field, operator, value from real options | **Shipped** (audited 2026-10-01, 9g). `../field` rules open since 9a (#24); the searchable, grouped field picker is 9c (#25); the sentence-shaped editor is 9f (#19, open). | [condition-builder.md](../condition-builder.md) v0.3 · `condition-builder.spec.ts`, `parser-dot-subject.spec.ts`, `field-picker.spec.ts`, `four-builders.spec.ts` |
| Same for *accept the answer only if…* and *filter choices when…* | **Shipped** for constraint (the Validation panel, 9e #27: 575 of 777 real constraints open fully as presets, 61 partly); choice_filter uses the strip (`four-builders.spec.ts`) until 9f. | `ValidationPanel.tsx`, `validation-panel.spec.ts`, `four-builders.spec.ts` |
| Builder for *compute the value as…*, including a decision-table form | **Shipped.** Tier 0 gate, Tier 1 single-value and templates, Tier 1.5 "Reference a value", If-then table (`decision_table` shape). | [calculation-builder.md](../calculation-builder.md) · [calc-reference-builder.md](../calc-reference-builder.md) · `06fd035` `36e6f78` `4362567` `c66cfcb` |
| *and* / *or* with one level of grouping | **Shipped.** Flat chaining plus `( group these )`; the serializer cannot emit flat mixed combinators. | condition-builder Slice 2.A–C · `0b332bd` `3aa66ff` `2770f2a` |
| Reference values from elsewhere by picking: earlier answer, contact field, contact-summary value | **Shipped.** `../inputs/contact/*` and `instance('contact-summary')/context/*` clauses; the context-key picker offers the values the config already computes. | `908ddd9` `be8279f` `e4fbab1` `7a0aa2e` `b96e5b1` · [pick-preexisting-context-values.md](../pick-preexisting-context-values.md) |
| Raw escape that preserves what it cannot model | **Shipped.** Parse → serialize self-check; anything that does not re-serialize byte-identical stays raw text. | `relevantParser.ts` (`isRawFallback`), `scripts/corpus-sweep.mjs` |
| Acceptance 1: every value pickable, no typed identifiers | **Met in the strip and the panel** (9c #25: searchable picker, "another question" value mode, choice labels; 9e #27: presets). The modal keeps an optional custom-name escape until 9f (#19) retires it. | `field-picker.spec.ts`, `validation-panel.spec.ts` |
| Acceptance 2: unrepresentable expressions round-trip byte-identically | **Met.** Corpus sweep output identical to `master` on every slice; cell-level `serialize(parse(x)) === x` on 0 / 3919 drift (9a #24, 9e #27). | `scripts/corpus-sweep.mjs`, `relevantParser.selfSubject.roundtrip.test.ts`, `presets.test.ts` |
| Acceptance 3: one automated test drives all four builders and asserts cells on disk | **Met** (9g #28). One journey: strip → relevant and choice_filter, Validation panel → constraint + message, calculation builder → calculation; every cell read back through the API after a UI save. | `four-builders.spec.ts` |
| Acceptance 4: a picked condition matches at runtime on a live instance | **Met** (9g #28). A relevance and a constraint authored by picking, deployed with cht-conf 6.5.0 inside the image to the local CHT 5.2.0 instance; as the CHW the question hides, shows after "Pass", rejects 25 with the authored message, accepts 10 → report `01a0f7da-9c2b-766d-90aa-3aabfd8dd6be` (2026-10-01). | `live-instance-check.spec.ts` |

Also found, and not in the June ticket: two reopen defects in the clause codec (`conditionReducer.ts:507`), and the add-question step sets no validation and appends the new row off-screen.

## Progress log

| Date | Slice | State | Measured |
| --- | --- | --- | --- |
| 2026-10-01 | 9b (#15) | PR [#23](https://github.com/medic/cht-ui-builder/pull/23), branch `9b_reopen_truthy_answered` | `${f}` / `not(${f})` get a parser kind (`truthy`); `${f} != ''` opens via `Clause.source`. 21 real `relevant` cells open as clauses that were raw before. |
| 2026-10-01 | 9a (#14) | PR [#24](https://github.com/medic/cht-ui-builder/pull/24), branch `9a_parser_dot_subject`, stacked on #23 | See the count below. |
| 2026-10-01 | 9c (#16) | PR [#25](https://github.com/medic/cht-ui-builder/pull/25), branch `9c_field_picker`, off `master` | `shared/src/xlsform/fieldMeta.ts` + `client/src/ui/SurveyFieldPicker.tsx`: search by label or name, section optgroups, technical rows behind a toggle, choice labels in the value picker and readback, "another question" value mode. The v0.3 typical/other partition and "Show all fields" are gone; op-typicality orders within a section. Harvest calculates (`../inputs/contact/x`) stay pickable. Found: a focus-width change on the search box ate the "+ insert" click. |
| 2026-10-01 | 9d (#17) | PR [#26](https://github.com/medic/cht-ui-builder/pull/26), branch `9d_add_question_configure`, off `master` | Configure step (required, hint per language, Validation slot = expression + "✎ build" modal + message per language; 9e fills it with presets), "add without details", remembered "always skip". `insertIndexAfterRow` in `surveyEdits.ts`: "+ Question" lands after the focused row (a begin row → first child). New row scrolled, focused, flashed. Playwright profile seeds the skip preference ON for the legacy build specs; the new spec clears it. |

| 2026-10-01 | 9e (#18) | PR [#27](https://github.com/medic/cht-ui-builder/pull/27), branch `9e_validation_panel`, cut from the 9a tip with 9d merged in (stacked on #24 and #26) | `shared/src/validation/presets.ts` (preset model, recogniser, emitter; `source` per item wins on save) + `client/src/ui/ValidationPanel.tsx` (replaces the constraint expression field, the strip's constraint column and the modal for that column; mounted in the 9d configure step). Parser gained optional `ParsedExpression.separators` so chains broken across a newline or a double space open. Every preset compiles with pyxform 4.5 `xls2xform`. See the count below. |

| 2026-10-01 | 9g (#20) | PR [#28](https://github.com/medic/cht-ui-builder/pull/28), branch `9g_audit_close`, stacked on #27 | `four-builders.spec.ts` (acceptance 3) and `live-instance-check.spec.ts` (acceptance 4: deploy with cht-conf in the image, drive the local CHT 5.2.0 as the CHW; report `01a0f7da-9c2b-766d-90aa-3aabfd8dd6be`). The status table above and the #9 checklist are updated. Every preset also compiles with cht-conf `convert-app-forms` in the image. |

| 2026-10-02 | 9f (#19) | PR [#29](https://github.com/medic/cht-ui-builder/pull/29), branch `9f_sentence_editor`, cut from the 9g tip with `9c_field_picker` merged in (stacked on #28) | Advanced panel regrouped Logic / Display / Messages / Raw. One sentence-shaped editor per logic column ("Show this question when …", "Filter the choice list when …"), plain-English readback from the first clause using question and choice labels, XPath and the "✎ build" modal behind a per-column "code" toggle (a rule the editor cannot show opens with its XPath visible), collapsed rows summarise logic in words, "Compute the value as…" only on calculate rows or on request. Bytes unchanged (`../lmp_date != ''` re-emits as written). `sentence-editor.spec.ts` covers acceptance 1 and 3. Also: captioned demo recordings for every slice (`client/tests/t9-demos/`, `playwright.demo.config.ts` → `client/demo/t9/<ticket>.webm`), and the `string` checkbox regression in `geriatric-build 9` from the 9c picker's second checkbox is fixed in the specs. |

**777-rule count after 9e** (same seven configs, `constraint` column, through `parseValidation` → `serializeValidation`):

| | Cells |
| --- | ---: |
| open entirely as presets | **575** |
| presets plus one plain-text item | 61 |
| `true` / `true()` / `1` placeholders, labelled "always passes" | 51 |
| plain text only | 90 |
| drift (serialize ∘ parse) | 0 |
| parser-level structured (any kind, no raw part) | 730 (682 before separators) |

Against the 726 non-placeholder rules that is 636 fully or partly as presets (target was about 705). What stays plain text: mixed `and` / `or` inside `not(…)` (the 27-cell nssd ethnicity rule and the 8 `primary_condition` / `secondary_condition` ones), curly quotes (`’none’`, 5), `decimal-date-time` / `date-time(floor(…))` arithmetic (about 20), `add-date(today(), 0, 0, -N)` (5; the function's argument order is not modelled), the 6 cross-field rules, and `int(.) > int(${f}) + 9` (16, one `code` item next to three presets). Phase 2 presets (fixed date, "[Other] alone" via the `or` spelling, choose at least/at most N) cover 15 more.

**All seven slices are in PRs.** Merge order: #23 → #24 → #25 → #26 → #27 → #28 → #29; each later PR is stacked on the previous one, so its diff collapses to its own commit once the predecessor lands. Four e2e failures pre-date the epic on master (`demo.spec.ts` 1 and 4, `geriatric-build.spec.ts` 7 and 8) and are not in scope.

**777-rule count after 9a** (seven analysis configs, `constraint` column, "opens" = `parseRelevantGrouped` returns no raw part):

| Column | Cells | Open fully structured | Before 9a |
| --- | ---: | ---: | ---: |
| `constraint` | 777 | **682** (51 are `true` / `true()` / `1` placeholders, so 631 of the 726 real rules; target after 9e was about 705) | 3 |
| `relevant` | 3050 | 1839 | 1674 |
| `choice_filter` | 92 | 2 (8 more partially) | 2 |

Drift (`serializeAnyParsed(parseRelevantGrouped(x)) === x`) is 0 of 3919 cells; before 9a it was 37, all all-raw chains with a double space around `and` that the split-and-rejoin path reformatted (fixed in 9a by running the self-check on raw chains too).

**`../` vs `${}` share** (same three columns, same configs): 410 relative references against 4433 `${}` references (8.5%); 329 of 3919 cells carry at least one `../field`, 9 cells mix both spellings, and none of them is a `../inputs/…` contact-input path. Per config, `../` is concentrated in lumbini and nssd relevants.

**Still raw after 9a** (23 distinct constraint texts, 94 cells): a newline before `and` (8 texts, incl. the 27-cell nssd ethnicity rule), a double space in the chain (6), curly quotes `’none’` (1), `and` / `or` mixed inside `not(…)` (3), and a few `if(…)` / three-level groupings. All stay byte-identical. The chain-level spacing ones are a candidate for a chain `source` in 9e if the preset recogniser needs them.

## Invariants every slice inherits

These are not per-slice choices. A sub-issue that violates one is not done, whatever its own acceptance says.

1. **No normalising.** A rule the UI *displays* as a preset or clause is re-emitted in its original spelling, operand order and spacing unless the author changed it. The preset view is a projection over the parsed rule; the stored text is kept alongside and wins on save unless the projection changed. This is the failure shape that made `isAlive` always-true across 26 real tasks.
2. **The self-check stays authoritative.** Anything that does not satisfy `serialize(parse(x)) === x` is raw text, never a partial parse. Parser widening is additive: new entry points or new rule kinds, never a change to what existing consumers receive.
3. **Round-trip tests exercise the serializer and start from non-canonical fixtures** (`.<=100`, `. <= 100 and . >= 70`, `(.)>=1 and (.)<=7`). A parser-only test, or a fixture that is already canonical, cannot detect normalisation. Open-and-save with zero edits on every real config leaves every `constraint` and `relevant` byte-identical.
4. **Wording.** These are builder gaps, not CHT gaps. `regex()`, `string-length()`, `count-selected()` run fine in pyxform, Enketo and CHT. "Plain text only" means the builder cannot show the rule.

Validate commands for any slice that touches `shared/`:

```sh
pnpm --filter @cht-ui/shared build
pnpm --filter @cht-ui/shared test
pnpm typecheck && pnpm lint
node scripts/smoke-parser.mjs <config>/forms/app/pregnancy.xlsx   # Round-trip stable: YES
node scripts/corpus-sweep.mjs                                      # no drift on all seven configs
```

## Slices and dependencies

```
9b reopen defects ─────────────────────────────── (independent, ship first)

9a parser: `.` and `../field` ──┬── 9e Validation panel ──┬── 9f sentence editor (relevant, choice_filter)
9d add-question configure step ─┘                         │
9c field picker ──────────────────────────────────────────┘

9a ─────────────────────────────── 9g audit and close the original scope
```

| # | Slice | Depends on | Size | Ticket body |
| --- | --- | --- | --- | --- |
| 9a | Parser: `.` as subject, `../field` alias, function forms on `.`, serializer-exercising round-trip tests, corpus sweep | nothing | M | [#14](https://github.com/medic/cht-ui-builder/issues/14) · [t9a.md](../../../.github/tickets/t9a.md) |
| 9b | Reopen defects at `ruleToClause`: raw emission of "has an answer" / "is not selected"; dropped `answered` | nothing · quick win | S | [#15](https://github.com/medic/cht-ui-builder/issues/15) · [t9b.md](../../../.github/tickets/t9b.md) |
| 9c | Searchable, grouped field picker; technical rows hidden; choice labels in pickers and readback | nothing | M | [#16](https://github.com/medic/cht-ui-builder/issues/16) · [t9c.md](../../../.github/tickets/t9c.md) |
| 9d | Add-question configure step (required, hint, preset slot); insert after the current row; scroll and highlight | nothing (9e fills the slot) | M | [#17](https://github.com/medic/cht-ui-builder/issues/17) · [t9d.md](../../../.github/tickets/t9d.md) |
| 9e | Validation panel: presets per type, messages per language, preset recogniser, replaces both constraint builders | 9a, 9d | L | [#18](https://github.com/medic/cht-ui-builder/issues/18) · [t9e.md](../../../.github/tickets/t9e.md) |
| 9f | Sentence-shaped inline rule editor for relevant and choice_filter; advanced panel regrouped Logic / Display / Messages / Raw | 9c, 9e | L | [#19](https://github.com/medic/cht-ui-builder/issues/19) · [t9f.md](../../../.github/tickets/t9f.md) |
| 9g | Audit and close the original scope: constraint and choice_filter e2e, runtime match on a live instance, tick the June checklist | 9a | M | [#20](https://github.com/medic/cht-ui-builder/issues/20) · [t9g.md](../../../.github/tickets/t9g.md) |

**Order of work.** 9b and 9a first (no dependencies; 9a unblocks 9e and 9g). 9c and 9d can run in parallel with 9a. 9e after 9a and 9d. 9f last. 9g whenever 9a is in.

**Phase 2 presets** (date on or after a fixed date; "[Other] alone" for any choice; choose at least / at most N) stay as a deferred checklist inside 9e. They cover about 15 more of the 726 real rules.

## Filed outside T9

Two items from the analysis are not about authoring logic and go in as separate issues:

- **Function catalogue and expression checks** (`Type: Improvement`): ODK + CHT function names, arity, return type, CHT-only flag; autocomplete and warnings in every expression field (unknown function, wrong arity, unknown `${field}`, `constraint_message:en` with one colon). [#21](https://github.com/medic/cht-ui-builder/issues/21) · [t-function-catalogue.md](../../../.github/tickets/t-function-catalogue.md)
- **Project picker: "Forget all missing"** and no toast for a stale last-opened path (`Quick win`). [#22](https://github.com/medic/cht-ui-builder/issues/22) · [t-project-picker-forget-missing.md](../../../.github/tickets/t-project-picker-forget-missing.md)

## Definition of done for the epic

Issue #9 closes when all seven sub-issues are closed and these hold together, on a real config:

1. Every value in every builder can be picked; no path requires typing an identifier or a reference expression (June acceptance 1).
2. An expression the builder cannot represent round-trips byte-identically (June acceptance 2; met today, must stay met).
3. One automated test drives all four builders and asserts the emitted cells on disk (June acceptance 3).
4. A condition authored through the picker matches at runtime on a live instance, verified with real data (June acceptance 4).
5. Add **age** (integer) with Between 0 and 20 and a message in the picker; the sheet has `. >= 0 and . <= 20` and `constraint_message::en`; reopening shows the preset filled in.
6. Re-running the 777-rule count opens every Phase 1 row of the gap matrix (about 705 of 726).
7. A form using every preset compiles with `cht-conf`.
8. Open-and-save with zero edits on every real config leaves every `constraint` byte-identical, including those shown as presets.
