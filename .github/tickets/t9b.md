**Parent:** T9 (#9) · **Importance:** Must have · **Size:** S · **Depends on:** nothing. Quick win.

**Why.** The inline builder can **write** "has an answer" (`${field}`) and "is not selected"
(`not(${field})`) but cannot **reopen** them: the row comes back as "hand-written" with every control
disabled. A rule the tool itself produced must open in the tool. Two distinct causes share one choke
point, verified by QA against `shared/dist`.

**Scope.**
- [ ] Case (a): `clauseToRule` (`conditionReducer.ts:489-490`) emits both clauses as `kind: 'raw'`
      from the outset, so on reopen they parse as raw and `ruleToClause` (`:507`) returns null. Give
      them real rule kinds and map them back to clauses.
- [ ] Case (b): `${f} != ''` and `${f} = ''` parse **cleanly** as `kind: 'answered'` (reachable from
      the modal's "+ answered check") and are dropped at the same `:507`. Map `answered` to a clause.
- [ ] ⚠ Pin the two cases separately. A fixture using bare `${f}` exercises the raw path, not the
      answered path; one test cannot cover both.
- [ ] ⚠ No change to serialized output for existing rules. The fix is in the reopen direction; the
      bytes written for "has an answer" stay `${field}`.

**Not in scope.** Any widening of the parser (9a). Any UI change beyond the controls becoming
enabled on reopen.

**Acceptance.**
1. Write "has an answer" and "is not selected" through the inline builder, save, reopen: both show
   as clauses with controls enabled.
2. A form containing `${f} != ''` in `relevant` opens in the clause builder as "has an answer".
3. Two new reducer tests, one per case, fail on `bff69cb` and pass after the fix.
4. Open-and-save with zero edits leaves every `relevant` byte-identical (`scripts/corpus-sweep.mjs`).

**Validate.**
```sh
pnpm --filter @cht-ui/shared build && pnpm --filter @cht-ui/shared test
pnpm typecheck && pnpm lint
node scripts/corpus-sweep.mjs
```

Plan: `docs/plans/9_complex_logic_calculation_relevant_constraint/README.md` · Analysis: `validation-rules-v2.md` §"Defects found during the review".
