**Parent:** T9 (#9) · **Importance:** Must have · **Size:** L · **Depends on:** 9a (parser), 9d (configure step). 9f builds on it.

**Why.** Validation is where a program says what a correct answer is, and today the tool can show
3 of 777 real rules. With `.` readable (9a), about 97% of the real rules that are not `true`
placeholders fall into a dozen shapes a non-developer recognises by name: a number between two
values, a text of at most N characters, a date not in the future. This slice gives those shapes a
panel, replaces the two constraint builders that today accept different rule sets for the same
column, and makes the message the author sees the message the CHW will see.

**Scope.**
- [ ] One **Validation** panel, mounted in the add-question configure step (9d) and in the row editor,
      replacing both the inline strip and the "✎ build" modal for the `constraint` column.
- [ ] `constraint_message` and `required_message` per visible language, beside the **required**
      checkbox. Suggested message text per preset, editable.
- [ ] Number / Decimal: Between (both ends included by default, per-end toggle), Less than / Greater
      than (with "or equal"), At most / At least [another question]. Integer questions accept whole
      numbers only.
- [ ] Text: At most / At least / Exactly N characters; Allowed characters (script checklist seeded
      from the form's languages, digits only, no digits); Pattern box with a test field; BS year
      between N years ago and this year.
- [ ] Date / Date-time: Not in the future / Not in the past (⚠ `today()` for date, `now()` for
      date-time); On or after [question]; After all of [questions]; Within the last / next N
      days / weeks / months.
- [ ] Select many: [choice] must be chosen alone. Fixed value: This answer equals.
- [ ] Presets combine with "and".
- [ ] Opening an existing rule: exact preset match first, then the clause builder with **This answer**
      as subject, then plain text saved exactly as written.
- [ ] `true` / `true()` / `1` show "This rule always passes: no validation". ⚠ Never rewritten.
- [ ] ⚠ **The preset recogniser never normalises.** A rule displayed as "Between 70 and 100" but not
      edited is re-emitted as `. <= 100 and . >= 70`, its original operand order and spacing.
      Canonical output only for rules the author changed. The preset view is a projection; the
      stored text is kept alongside and wins on save unless the projection changed.
- [ ] Verify whether Enketo's `regex()` supports `\p{L}` before offering it; otherwise write
      explicit script ranges.

**Phase 2 (deferred, same issue).** Date on or after a fixed date; "[Other] alone" for any choice;
choose at least / at most N. About 15 more of the 726 real rules.

**Not in scope.** Relevance and choice_filter (9f). Cross-field rules beyond "vs another question";
the 6 real ones stay plain text. The function catalogue.

**Acceptance.**
1. Add **age** (integer) with Between 0 and 20 and a message in the picker; the sheet has
   `. >= 0 and . <= 20` and `constraint_message::en`; reopening shows the preset filled in.
2. Re-running the 777-rule count opens every Phase 1 row of the gap matrix as a preset or clause
   (about 705 of 726).
3. A form using every preset compiles with `cht-conf` in the Docker image.
4. Open-and-save with zero edits on every real config leaves every `constraint` byte-identical,
   **including those the panel displays as presets**.
5. Playwright drives at least one preset per type and asserts the emitted cell on disk.

**Validate.**
```sh
pnpm --filter @cht-ui/shared build && pnpm --filter @cht-ui/shared test
pnpm typecheck && pnpm lint
pnpm --filter @cht-ui/client test:e2e
node scripts/corpus-sweep.mjs
```

Plan: `docs/plans/9_complex_logic_calculation_relevant_constraint/README.md` · Analysis: `validation-rules-v2.md` §"Proposed support" 2 and 3, §"Gap matrix", §"Decisions".
