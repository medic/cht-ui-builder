**Importance:** Improvement · **Size:** M · **Depends on:** nothing. Related: T9 (#9), but not part of it.

**Why.** Every expression field in the editor is a bare text box. A typo in a field name, a function
CHT does not run, or `constraint_message:en` written with one colon is caught only when `cht-conf`
compiles the form, often by someone else. Real configs use **44 distinct functions**, 9 of them
CHT-only. "Support all of ODK" visually is not realistic; a catalogue that powers autocomplete and
checks in the text editor is, and it covers every column at once.

**Scope.**
- [ ] `shared/`: ODK + CHT function catalogue: name, arity, return type, CHT-only flag, one-line doc.
- [ ] Autocomplete in every expression field (relevant, constraint, calculation, choice_filter,
      default, repeat_count) for function names and `${field}` references.
- [ ] Checks shown inline, never blocking save: unknown function, wrong argument count, unknown
      `${field}`, `constraint_message:en` with one colon, ODK features CHT does not run.
- [ ] ⚠ Display only. No expression is rewritten; the raw fallback stays untouched.

**Not in scope.** New visual presets. Evaluating expressions.

**Acceptance.**
1. Typing `sel` in a constraint field offers `selected(` with its arity and doc.
2. `${lmp_aprox}` (misspelt) shows an inline warning naming the nearest real field; the save still
   writes exactly what was typed.
3. The catalogue is a `node --test`-covered data module with the 44 functions found in real configs.

**Validate.**
```sh
pnpm --filter @cht-ui/shared build && pnpm --filter @cht-ui/shared test
pnpm typecheck && pnpm lint
```

Analysis: `docs/plans/9_complex_logic_calculation_relevant_constraint/validation-rules-v2.md` §"Supporting all of ODK".
