<!--
Dev handoff. Building the geriatric use case for real inside config-nssd/chis (branch
954_geriatric) surfaced findings beyond the 2026-08-11 readiness audit and build protocol.
This is the punch-list: what the no-code editor could and couldn't do, verified live against
this specific config, not assumed from the older docs. 2026-08-12.
-->

# Geriatric-in-NSSD build — hand-edits, findings, and what's still open

Build order followed `docs/nssd-build-protocol.md`. Scope: only the two new forms
(`geriatric_health_assessment`, `geriatric_referral_followup`) and the one new task — the 29
existing tasks, 19 contact forms, Hierarchy, and Contact-Summary Helpers/Cards were never opened.
`git -C config-nssd diff --stat` was run after every save; every collateral change was reverted
before the next step. Confirmed via `git diff` at each checkpoint: zero existing lines in
`tasks.js` were touched — pure addition throughout.

## Re-verified against current HEAD, not the 2026-08-11 audit

Two items the audit/build-protocol called broken are now fixed — don't carry the old caution
forward:

- **Alive/muted guard on a new task**: the build protocol said this "breaks on a NEW task too."
  It doesn't anymore — `appliesIfParser.ts` now preserves the real helper argument (A2 landed),
  and `AppliesIfBuilder.tsx` already has "+ alive check" / "+ muted check" buttons. Built with zero
  hand-editing.
- **Full eligibility gate** (`contact.contact_type === 'c82_person' && ageInYears(contact) >= 60 &&
  !contact.muted && !contact.date_of_death`): fully buildable via the Properties context-builder's
  "+ contact type" / "+ age" / "+ not muted" / "+ not deceased" buttons. The 2026-08-06/08-10
  scratch demos only used `+ age` — the fuller predicate set already existed, it just wasn't used.

Two items are confirmed still broken (hostile-fixture status checked directly, not assumed):

- `resolvedIfParser.hostile.test.ts` — A4 cases (`Math.max(..., report.reported_date + 1)` start
  clamp) are still `{ todo: true }`.
- `actionsParser.hostile.test.ts` — B1 (bare `report.<field>`) and B3 (non-string form value) are
  still `{ todo: true }`.

## Hand-edits made (all in `client/tests/geriatric-nssd-*.spec.ts`, documented inline at the call site)

1. **Inputs-block scaffold.** `buildAppFormScaffold` (`shared/src/xlsform/scaffolds.ts`) hardcodes
   a generic `inputs` block (extra `user` group, `_id` as `string`+`select-contact`, no
   `date_of_birth`, wrong `patient_id` calc source) that deviates from NSSD's convention on 4 of 6
   elements — already flagged in the build protocol's Phase 1 table. Fixed via direct splice,
   verbatim-matched to `hypertension_screening.xlsx`.
2. **The literal `"NO_LABEL"` requirement — new finding, not in the prior audit.** pyxform
   hard-errors ("no label or hint") on an unlabeled `db:person` row. NSSD's real forms satisfy this
   with the literal string `"NO_LABEL"` on every structural row inside `contact` (confirmed against
   raw cell bytes, not an empty-cell-handling artifact) — `source`/`source_id` get real descriptive
   labels, `contact` itself gets `"Contact"`. Skipping this produces a hard compile error first
   (`_id`), then a benign "Group has no label" warning (`contact`) once `_id` is fixed. Reproduced
   and fixed live against real pyxform (`cht convert-app-forms`).
3. **Receiver-row placement.** `"+ add inside"` on the `inputs` accordion nests new rows inside the
   innermost EXISTING group (`contact`), never as direct `inputs` children — reproduces the
   2026-08-10 finding exactly, this time on an NSSD-shaped `inputs` block with no `user` group to
   blame it on. CHT binds task-delivered `content.<key>` to `inputs/<key>` direct children only.
   Relocated via script after the UI step.
4. **Convention choice, not a hand-edit avoided one:** NSSD's *dominant* receiver-node pattern
   (12 of 20 keys) is a top-level `instance::tag = hidden` row named `<field>_ctx`. The tool cannot
   author this at all — confirmed by reading `FormEditor.tsx`: the "Raw column overrides" panel
   only edits extras a row *already has*, never adds a new key. Used the *older* but still-valid
   inside-`inputs` same-named convention (8 of 20 keys) instead, since that one IS achievable
   through the visual UI. **Product gap**: the editor should support authoring `instance::tag`
   receiver nodes so the dominant convention becomes available too.
5. **resolvedIf start clamp** (A4, confirmed still `{ todo: true }`): built the base
   "form submitted in window" shape via the picker, then hand-inserted
   `Math.max(Utils.addDate(dueDate, event.end + 1).getTime(), report.reported_date + 1)` — NSSD's
   own pattern, e.g. `tasks.js:197`.
6. **modifyContent source mapping** (B1/B3, confirmed still `{ todo: true }`): built the target
   keys via the picker, then rewrote every emitted `= report.refer_X` to
   `= Utils.getField(report, 'refer_X')` — NSSD's dominant real accessor (29 uses in `tasks.js`;
   `Utils` is a global, no import needed).
7. **appliesIf/events/actions indentation.** The tool's function-body serializer emits flat 2-space
   indentation regardless of the surrounding nesting depth, and single-line `if (...) { return
   false; }` guard clauses. NSSD's ESLint gate (run as part of `compile-app-settings`'s nools build)
   requires context-aware indentation (6-space for a function body one level inside a 4-space task
   entry) and multi-line brace style. **This blocks `compile-app-settings` outright** — not a style
   nit. Reformatted by hand to match an existing task's exact style before compile would pass.
8. **`form-constants.js` shape.** Confirmed on BOTH new forms: the tool appends
   `UPPERCASE_NAME: ['form_name']`; every one of NSSD's 32 existing entries is
   `lowercase_name: 'lowercase_name'`. Fixed by hand each time (Batch C item, already known —
   reconfirmed twice, still unfixed in the tool).

## A real logic bug caught during this build, not from the tool

Setting the appliesIf rule-builder's OR-connector pills programmatically in one pass set only 5 of
the 6 pills needed to OR-join all 7 `refer_*` flags — `refer_continence` landed as an unconditional
AND instead of joining the OR group. Caught by reading the actual preview text rather than trusting
the interaction had worked, and fixed by re-opening the builder and setting pills precisely (0-5 =
`or`, 6-7 = `and`, the latter guarding the alive/muted checks). A first attempt at the fix
overshot — setting *every* enabled pill to `or` merged the alive/muted checks into the same guard,
which would have made the task fire for almost any alive, non-muted patient regardless of flags.
Both the undershoot and the overshoot were caught by inspecting the live preview and the final
`tasks.js` output before saving forward, not assumed correct from the interaction sequence alone.
Whether the undershoot was a genuine timing race in the rule-builder's pill state or purely a
scripting issue wasn't fully isolated — worth a second pair of eyes if this pattern (bulk-setting
many sequential connector pills) shows up elsewhere.

## Operational findings (not code bugs, but change how you work here)

- **`convert-app-forms` has no working per-form scope in this cht-conf version (6.0.2).** Neither
  bare invocation nor `--forms=<name>` limits it — both regenerate `.xml` for all 35+ existing
  forms with thousands of changed lines each. There is no way to compile-check just the new form
  without touching everything else. The only safe pattern: run it, `git diff --stat`, revert every
  file except what you meant to touch, every single time.
- **The cold-nav gap extends to Tasks.** The already-known "visit Forms before Contact-Summary so
  the source-form dropdown populates" finding also applies to the Tasks editor's `appliesToType`
  "App forms" fieldset — it renders zero app forms (only contact types) until Forms has been
  visited at least once this session.
- **The sandbox CouchDB degradation recurred** (three concurrent CHT docker stacks running on this
  machine competing for RAM) — same `{badmatch,{error,enoent}}` / 500 symptom as the 2026-08-10
  probe, same fix (`docker restart <project>-couchdb-1 <project>-haproxy-1 <project>-api-1`, ~30s).

## Still open at time of writing

Live deploy to the local instance and the full runtime proof (task fires on a continence-only
failure — the exact leg the appliesIf bug above would have broken — branched follow-up, resolution)
was in progress when this doc was written; `client/tests/geriatric-nssd-live-flow.spec.ts` has the
scenario. The NSSD-native `chis/test/tasks/geriatric.spec.js` (cht-conf-test-harness, per the
project's own convention in `hypertension_screening_and_referral.spec.js`) has not been started —
its `form-inputs.js` fixture format is a positional array matching the survey's exact row order,
which needs to be authored against the final row order, not before it.
