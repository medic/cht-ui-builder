**Parent:** T9 (#9) · **Importance:** Must have · **Size:** M · **Depends on:** nothing. 9f builds on it.

**Why.** The "show this question when" field dropdown lists about 230 rows of a real pregnancy form in
sheet order: every `*_note`, every `r_*` summary row, every hidden `__*` output and plumbing calculate,
with no search, no labels and no grouping. A program officer looking for "LMP approximate" cannot find
it. This is one of the three P0 cold-start blockers from the 2026-10-01 UX review, and T9's first
acceptance criterion ("every value can be picked") cannot be met while the picker is unusable.

**Scope.**
- [ ] Field picker shows **label and name**, searchable by either, grouped by the section (group) the
      field sits in.
- [ ] Notes, `r_*` rows, `__*` rows and plumbing calculates hidden by default behind a
      "show technical rows" toggle. Search over technical rows still works when the toggle is on.
- [ ] Choice values show their **labels** in value pickers and in readback; the saved sheet keeps the
      names. ⚠ Display only; no XLSForm bytes change.
- [ ] Same component wherever a field is picked for a rule: inline strip, modal, calculation builder,
      and the value cell when the value is another field.
- [ ] Dependency-aware ordering stays authoritative: the picker never offers a field defined after
      the current row (`shared/src/xlsform/dependencies.ts`).

**Not in scope.** The sentence-shaped rule editor (9f). The parser (9a). Reordering fields.

**Acceptance.**
1. On a real 280-row form, typing "lmp" in the picker lists the LMP fields by label and name within
   one keystroke sequence; nothing technical appears until "show technical rows" is on.
2. A select question's value picker shows choice labels; the sheet cell written is the choice name.
3. Playwright: the picker finds `lmp_approx` by typing "lmp"; the emitted cell is unchanged from the
   current builder's output.
4. Open-and-save with zero edits leaves every column byte-identical.

**Validate.**
```sh
pnpm typecheck && pnpm lint
pnpm --filter @cht-ui/client test:e2e
node scripts/corpus-sweep.mjs
```

Plan: `docs/plans/9_complex_logic_calculation_relevant_constraint/README.md` · Analysis: `validation-rules-v2.md` §"UI/UX: condition authoring review" findings 2, 4, 6; `FormEditor.tsx:1260` (`earlierFields`) at `bff69cb`.
