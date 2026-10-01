**Parent:** T9 (#9) · **Importance:** Must have · **Size:** M · **Depends on:** nothing. Unblocks 9e and 9g.

**Why.** The shared parser only recognises comparisons whose subject is `${field}`. Real configs write
validation rules against the answer itself as `.` (`. >= 0 and . <= 20`), and real relevants use
relative paths (`../lmp_approx`). Across 777 `constraint` rules in seven configs the builders open
**3**. Nothing in the UI can improve until the parser reads what real forms contain. This slice is
shared-only and carries the round-trip risk, so it ships alone, before any UI depends on it.

**Scope.**
- [ ] `relevantParser.ts`: accept `.` as a comparison subject. Values may be a number, a quoted string,
      `${field}`, `../field`, `today()`, `now()`, `today() ± N`, `date('…')`.
- [ ] Accept `../field` as an alias of `${field}` for subject and value. ⚠ Re-emit exactly as written;
      never rewrite `../field` to `${field}` or back.
- [ ] Recognise the function forms on `.` that real configs use: `string-length(.)`, `regex(., '…')`,
      `selected(., '…')`, `count-selected(.)`, `int(.)`, `int(format-date(., '%Y'))`,
      `max(coalesce(${a}, 0), …)`, `add-date(today(), …)`, `difference-in-months(., today())`,
      `decimal-date-time(.)`.
- [ ] Recognise `true`, `true()` and `1` as an always-true rule kind so the UI can label it. ⚠ Never
      rewritten.
- [ ] ⚠ Additive only. New rule kinds or new entry points; `parseRelevant` / `parseRelevantGrouped`
      return shapes seen by the five existing consumers do not change.
- [ ] The parse → serialize self-check stays authoritative: anything that does not re-serialize
      byte-identical is raw text. `.<=100` and `. <= 100` both round-trip unchanged.
- [ ] `node --test` round-trip case per new form in `shared/src/xlsform/`, each calling the serializer
      and starting from a non-canonical fixture.
- [ ] Convert the `../field` hostile fixtures from `{ todo: true }` to live for the byte-stability half;
      only the "opens as clauses" half stays todo until 9e / 9f.
- [ ] QA: measure the `../` vs `${}` share across the seven configs and record it in the plan folder.

**Not in scope.** Any UI. The preset recogniser (9e). The function catalogue (separate issue).

**Acceptance.**
1. `scripts/corpus-sweep.mjs` shows zero drift on all seven configs after the change.
2. A test over the 777-rule corpus reports how many `constraint` rules now parse structurally; the
   number is recorded in the README of the plan folder (target after 9e: about 705 of 726).
3. Every new round-trip test starts from a non-canonical fixture and asserts
   `serialize(parse(x)) === x`.
4. `pnpm typecheck` is clean with no change to any consumer of `parseRelevant`, which proves the
   widening is additive.

**Validate.**
```sh
pnpm --filter @cht-ui/shared build && pnpm --filter @cht-ui/shared test
pnpm typecheck && pnpm lint
node scripts/smoke-parser.mjs <config>/forms/app/pregnancy.xlsx   # Round-trip stable: YES
node scripts/corpus-sweep.mjs
```

Plan: `docs/plans/9_complex_logic_calculation_relevant_constraint/README.md` · Analysis: `validation-rules-v2.md` §"Proposed support" 1, §"Test plan". Line anchors against `bff69cb`: `relevantParser.ts:370` is the `${}`-only comparison regex.
