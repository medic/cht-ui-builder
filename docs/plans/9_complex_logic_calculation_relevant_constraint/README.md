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
| Visual builder for *show this question when…*: pick field, operator, value from real options | **Partial.** Builder exists with type-aware ops and natural-language labels. It cannot open rules written with `../field`, which is how real forms write them, and the field picker is unusable at 230 rows. | [condition-builder.md](../condition-builder.md) v0.3 · commits `7a05b62` `0b332bd` `3aa66ff` `2770f2a` `f0095e1` |
| Same for *accept the answer only if…* and *filter choices when…* | **Partial.** Same component serves all three columns. Constraints are written against `.` (the answer itself), which the parser rejects, so 774 of 777 real constraints open as plain text. | `RelevantRuleBuilder.tsx`, `FormEditor.tsx:2250` (inline), `:2729` (modal) |
| Builder for *compute the value as…*, including a decision-table form | **Shipped.** Tier 0 gate, Tier 1 single-value and templates, Tier 1.5 "Reference a value", If-then table (`decision_table` shape). | [calculation-builder.md](../calculation-builder.md) · [calc-reference-builder.md](../calc-reference-builder.md) · `06fd035` `36e6f78` `4362567` `c66cfcb` |
| *and* / *or* with one level of grouping | **Shipped.** Flat chaining plus `( group these )`; the serializer cannot emit flat mixed combinators. | condition-builder Slice 2.A–C · `0b332bd` `3aa66ff` `2770f2a` |
| Reference values from elsewhere by picking: earlier answer, contact field, contact-summary value | **Shipped.** `../inputs/contact/*` and `instance('contact-summary')/context/*` clauses; the context-key picker offers the values the config already computes. | `908ddd9` `be8279f` `e4fbab1` `7a0aa2e` `b96e5b1` · [pick-preexisting-context-values.md](../pick-preexisting-context-values.md) |
| Raw escape that preserves what it cannot model | **Shipped.** Parse → serialize self-check; anything that does not re-serialize byte-identical stays raw text. | `relevantParser.ts` (`isRawFallback`), `scripts/corpus-sweep.mjs` |
| Acceptance 1: every value pickable, no typed identifiers | **Not met.** The field picker lists plumbing in sheet order with no search; the inline value cell still says `value or ${other_field}`. | validation-rules-v2 §UI/UX, findings 2 and 6 |
| Acceptance 2: unrepresentable expressions round-trip byte-identically | **Met.** Corpus sweep over seven configs shows no drift. | `scripts/corpus-sweep.mjs` |
| Acceptance 3: one automated test drives all four builders and asserts cells on disk | **Partial.** `condition-builder.spec.ts` and the geriatric specs cover relevant and calculation; constraint and choice_filter coverage to be confirmed in 9g. | `client/tests/` |
| Acceptance 4: a picked condition matches at runtime on a live instance | **Unverified.** Live-flow specs exist for tasks; nothing asserts a form relevance or constraint against a running CHT. | 9g |

Also found, and not in the June ticket: two reopen defects in the clause codec (`conditionReducer.ts:507`), and the add-question step sets no validation and appends the new row off-screen.

## Progress log

| Date | Slice | State | Measured |
| --- | --- | --- | --- |
| 2026-10-01 | 9b (#15) | PR [#23](https://github.com/medic/cht-ui-builder/pull/23), branch `9b_reopen_truthy_answered` | `${f}` / `not(${f})` get a parser kind (`truthy`); `${f} != ''` opens via `Clause.source`. 21 real `relevant` cells open as clauses that were raw before. |
| 2026-10-01 | 9a (#14) | PR [#24](https://github.com/medic/cht-ui-builder/pull/24), branch `9a_parser_dot_subject`, stacked on #23 | See the count below. |

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
