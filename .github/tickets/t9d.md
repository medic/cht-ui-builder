**Parent:** T9 (#9) · **Importance:** Must have · **Size:** M · **Depends on:** nothing. 9e fills the preset slot.

**Why.** Clicking a type tile in the add-question picker commits immediately. There is no step for
required, hint or validation, and the new row is appended after the hidden `__*` outputs, off-screen,
with no scroll and no highlight. The author does not know the question was added, let alone where.
This is a P0 cold-start blocker from the 2026-10-01 UX review.

**Scope.**
- [ ] A **configure step** between the type tile and commit: label (per visible language), required
      checkbox, hint, and a **Validation** slot. In this slice the slot shows the current constraint
      builder; 9e replaces it with presets. The step is skippable with one key for authors who want
      the one-click behaviour.
- [ ] Insert **after the current row**, or where "+ insert" was clicked, not at the end of the sheet.
      ⚠ Insert inside a group must keep the group's begin and end rows balanced.
- [ ] After commit, scroll to the new row and highlight it for a few seconds.
- [ ] Keep: one-click type tiles, language chips, the unsaved-changes guard.

**Not in scope.** Validation presets (9e). Field picker (9c). Changing which types the palette offers.

**Acceptance.**
1. Add **age** (integer) from the picker with required and a hint set in the configure step; the new
   row appears directly after the row the author was on, scrolled into view and highlighted.
2. The sheet on disk has the row in that position with `required` and `hint::<lang>` set; every
   other row is byte-identical.
3. Adding inside a group keeps `begin group` / `end group` paired (`structuralBalance` test passes).
4. Playwright covers the journey end to end.

**Validate.**
```sh
pnpm typecheck && pnpm lint
pnpm --filter @cht-ui/shared build && pnpm --filter @cht-ui/shared test
pnpm --filter @cht-ui/client test:e2e
```

Plan: `docs/plans/9_complex_logic_calculation_relevant_constraint/README.md` · Analysis: `validation-rules-v2.md` §"UI/UX" finding 3, §"UX changes" 4; `QuestionTypePicker.tsx`.
