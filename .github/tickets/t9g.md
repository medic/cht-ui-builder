**Parent:** T9 (#9) · **Importance:** Must have · **Size:** M · **Depends on:** 9a. Closes #9 together with 9b to 9f.

**Why.** The June ticket's scope mostly shipped under three other plans, but its checklist was never
updated and two of its four acceptance criteria were never run. Before #9 can close, somebody has to
check the claims against the code and against a live instance, not against the plan documents.

**Scope.**
- [ ] Verify and tick the shipped items in #9: decision-table calculation, and / or with one level of
      grouping, references to an earlier answer, a contact field and a contact-summary value by
      picking, raw escape. For each, name the test that proves it.
- [ ] Acceptance 3: one automated test drives **all four** builders (relevant, constraint,
      choice_filter, calculation) and asserts the emitted cells on disk. Today `condition-builder.spec.ts`
      and the geriatric specs cover relevant and calculation; add constraint and choice_filter, or
      show where they are already covered.
- [ ] Acceptance 4: a condition authored through the picker **matches at runtime** on a live CHT
      instance, verified with real data. Reuse the live-flow harness from the geriatric task specs
      (`geriatric-nssd-live-flow.spec.ts`) or the Docker image's cht-conf toolchain; assert that the
      question shows or hides, and that a constraint rejects, for a submitted record.
- [ ] Record the 777-rule open count after 9a and after 9e in the plan folder README.
- [ ] Anything found missing is filed as its own small issue under #9, not fixed inside this one,
      unless it is under an hour.

**Not in scope.** New features. Phase 2 presets.

**Acceptance.**
1. Every checkbox in #9's original scope is ticked with a link to the test or commit that proves it,
   or an open sub-issue that will.
2. One Playwright spec drives all four builders and asserts cells on disk.
3. A live-instance check for one relevance and one constraint is automated or, if not automatable,
   recorded step by step with the record ids used.
4. The README status table in the plan folder is updated to match.

**Validate.**
```sh
pnpm --filter @cht-ui/client test:e2e
node scripts/corpus-sweep.mjs
```

Plan: `docs/plans/9_complex_logic_calculation_relevant_constraint/README.md` §"Status of the original T9 scope".
