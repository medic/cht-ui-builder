**Parent:** T9 (#9) · **Importance:** Must have · **Size:** L · **Depends on:** 9c (field picker), 9e (Validation panel).

**Why.** The pieces for authoring a condition exist, but the flow reads as a developer's debug panel:
pick a *column*, press `+ insert`, read the result back as `${lmp_approx} = 'approx_weeks'`. The
microcopy is `build:`, `— column —`, `× start over`, `value or ${other_field}`. The advanced panel is
one flat stack where "Compute the value as…" appears on a plain Number question. This slice is the
Validation panel generalised: one sentence-shaped editor per logic column, in plain English, with the
XPath available but not in the way.

**Scope.**
- [ ] One **inline rule editor per column** replacing both the strip and the modal for `relevant`
      and `choice_filter`: "Show this question when [field ▾] [is ▾] [value ▾]" and "Filter choices
      when …". Plain-English readback for every clause; XPath behind a "code" toggle. The column is
      implied by the field being edited, never chosen from a dropdown.
- [ ] and / or with one level of grouping kept exactly as shipped (flat chaining, `( group these )`,
      refuse flat mixed). Connector separate from operator.
- [ ] Advanced panel regrouped into **Logic / Display / Messages / Raw**; `required_message` beside
      `constraint_message`; "Compute the value as…" hidden unless the type is calculate or the author
      opts in.
- [ ] Remove the duplicated expression preview (toggle caption and code bar show the same string).
- [ ] Label grid: hide `NO_LABEL` on calculates; fix the colliding `label::hi insert` captions.
- [ ] ⚠ Every write still goes through `serializeAnyParsed`; the raw fallback stays sacred; a rule
      the editor cannot show opens as text and is saved exactly as written.

**Not in scope.** New rule kinds (9a). Validation presets (9e). Drag-reorder of clauses. Keyboard
chip polish (tracked in condition-builder.md v0.3 out-of-scope).

**Acceptance.**
1. The cold-start journey from the UX review runs end to end: open a real pregnancy form, add
   "show this when LMP is approximate" by picking, read it back in plain English, never see XPath
   unless the code toggle is pressed.
2. Existing relevants written with `../field` open as clauses (parser from 9a) and are re-emitted
   byte-identically when untouched.
3. Before / after screenshots of the one-clause path show the only visible delta is the sentence
   form and the microcopy; the emitted cell is unchanged.
4. Playwright: the field picker, readback and code toggle are exercised; the sheet cell is asserted
   on disk.
5. Open-and-save with zero edits leaves every column byte-identical.

**Validate.**
```sh
pnpm typecheck && pnpm lint
pnpm --filter @cht-ui/client test:e2e
node scripts/corpus-sweep.mjs
```

Plan: `docs/plans/9_complex_logic_calculation_relevant_constraint/README.md` · Analysis: `validation-rules-v2.md` §"UI/UX" findings 1, 4 to 9, 11; §"UX changes" 1, 5. `FormEditor.tsx:2250` (inline), `:2729` (modal) at `bff69cb`. Microcopy rules: `docs/plans/condition-builder.md` §10.
