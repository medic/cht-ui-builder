<!--
The single plain-language work queue. Re-prioritised 2026-08-06 on PO directive:
"everything that needs to be fixed for the geriatric use case is first priority, forget
everything else for now" — ordered easiest to hardest. The safety batch is deferred (see
the caveat) and the general backlog is parked below. 2026-08-06.
-->

# What's next — geriatric use case first

**PO directive (2026-08-06): finish the geriatric use case before anything else. Ordered
easiest → hardest.** Everything else in this file is parked below the line.

Status: HEAD `7a0aa2e`. All 6 field notes, all 3 blocker features, and geriatric items **1–5**
shipped. Geriatric spec was **55 of 86 rows clean · 30 clumsy · 1 impossible**; item 4 closed the
impossible row, and item **8** (translation keys) is what still gates 17 task rows.

> ### ⚠️ One safety rule while the safety batch is deferred
> The known corruption bugs only bite when the tool **opens pre-existing hand-written
> JavaScript**. Everything you create *through the UI* is already in the tool's own shape
> and round-trips cleanly, so **building the geriatric app in a fresh project is safe.**
> Two rules: **(a) do not use Contact Summary → Helpers → "✎ edit body"** (31 of 31 real
> helper bodies fail to survive it), and **(b) don't open an existing hand-written task
> condition and save it.** Neither is needed for this build — cross-form values go through
> the structured *Context values* tab. Detail: `docs/reviews/p0-verification-30c3d92-2026-08-05.md`.

---

## ✅ Items 1–5 SHIPPED (`c66cfcb`, `7a0aa2e`) — and QA drove the forms end-to-end

**`client/tests/geriatric-build.spec.ts` builds the Integrated Health Assessment through the
real UI: 10 of 10 capabilities green on two consecutive runs**, every assertion re-parsed from
disk after save (not UI state). Form create, `age >= 60` eligibility, section with
"one screen", add Nepali, bilingual `select_one` + choices, relevance via the choice dropdown
(free-text input asserted **absent**), patient-name insert with auto-created harvest calc,
display image landing in `<form>-media/`, multi-field OR relevance, and the cross-form BMI
bridge. **The static audit's "highly buildable" verdict holds up under a real driver — no step
hit a missing affordance.**

```sh
pnpm --filter @cht-ui/shared build   # required: Vite serves shared/dist
pnpm --filter @cht-ui/client exec playwright test geriatric-build.spec.ts --reporter=line
```
Run the **whole file** — steps chain through disk state, so `--grep` on one mid-chain step is
order-dependent by design.

**Seven new findings the static audit missed** are folded into the list below as items
**A–G**. None is an impossibility; all are discoverability or ordering costs — but two
(**B**, **C**) are places a non-technical author still has to type an identifier or loses
their work.

## The geriatric list — easiest to hardest

> **Items 1–5 and F are DONE.** Start at **P1-DEPLOY** below, then **A**. Original numbering
> kept so older notes still line up.

**P1-DEPLOY. 🔴 "Insert contact field" emits a form that FAILS `cht convert`.** *(top priority —
the only thing between the geriatric build and fully no-code)*
Found by QA on a **live deploy** to a real CHT instance, invisible to every on-disk check.
The tool's own **+ insert → patient_name** creates the harvest `calculate` referencing
`../inputs/contact/patient_name`, but **never declares that node inside the `inputs/contact`
group** — so pyxform can't resolve the XPath and validation fails. A no-code user hits a wall
they cannot diagnose or fix. QA's manual repair was: declare the hidden input node, and rename
the calc.
**Three parts to the fix:**
1. **Generator** (`shared/src/xlsform/insertContactFieldRef.ts`) — when inserting a contact
   field, also add the corresponding node inside the `inputs/contact` group if it isn't already
   declared. Same edit, same undo.
2. **Preflight has a hole that whitelists this exact defect.** `danglingRefs.ts` treats any
   `../inputs/*` / `../inputs/contact/*` path as valid by assumption ("the runtime injects it").
   It doesn't — the node must be declared. → Validate those paths against the form's actual
   `inputs` block instead of waving them through.
3. **Raise the test bar** — see the process note below.

> **⚠️ Process lesson (third instance of the same pattern).** This feature **passed our audit
> with 9 flow tests** — structural balance, idempotence, round-trip, rename-lockstep — and every
> one of them passed while the output was undeployable, because none of them ran the converter.
> Same shape as the round-trip bug that shipped under a 603/603-green suite. **`cht convert`
> (pyxform) must be part of the definition of "works" for anything that generates form rows** —
> at minimum a CI leg that converts the generated fixtures. On-disk assertions cannot see this
> class of defect.

> **Note on QA's other hand-edits — not product bugs.** The `contact-summary.templated.js`
> `return` → `module.exports` change and the missing `targets.js` / `resources.json` / `.eslintrc`
> stubs were **test-fixture artifacts**: QA built inside `client/tests/fixtures/mini-config`,
> which predates the "templates ship required minimal files" directive. All four real templates
> already ship them correctly (verified). **But one real gap hides inside it:** the tool happily
> edited a contact-summary file that compiles to a silent no-op and warned nobody → add a
> preflight check for a contact-summary that exports nothing. Worth fixing the fixture too so it
> stops manufacturing false findings.

**A. Stop seeding `true &&` into every new form's eligibility.** *(one line)*
The app-form scaffold writes `context.expression = 'true'` (`server/src/routes/forms.ts:565`),
so an authored condition emits as `"true && ageInYears(contact) >= 60"`. Harmless but it's
what the MOH reviewer reads. Also stop writing `"icon": ""`.

**B. Fix the cross-form source picker + let the user leave a dirty page.** *(~10 lines — highest
value of the new findings)*
Two bugs that compound: **(i)** Contact Summary → Context values sources its form dropdown from
the Zustand `forms` slice, which **only `FormsIndex` populates on mount**
(`ReportFieldPicker.tsx:44-55`) — so reaching Context values directly after a page load shows
**no dropdown at all** and degrades to a hand-typed field path (verified: cold nav → 0 pickers;
visit Forms first → 2 pickers with real options). **(ii)** While Contact Summary has unsaved
changes the sidebar is **inert** — clicking a nav item does nothing, with no confirm and no
toast — so you can't even go to Forms to work around (i) without reloading and losing the edit.
→ Load the forms list wherever it's needed (or on app start), and make blocked navigation say
so. **This is the last place a non-technical author must type an identifier to finish the IHA.**

**C. Make a new section visible in Simple mode.** *(small)*
Empirically confirmed: after clicking **+ Section** — a Simple-mode toolbar button — the
section accordion is **not rendered in Simple mode**, so the thing you just created vanishes,
and "+ add inside" exists only in Full. QA's driver has to switch to Full to author inside a
section. This undoes half the value of the groups work (your original Note 3). See
`computeAuthoringHiddenRowIds` (`shared/src/xlsform/simpleMode.ts` + its tests).

**D. Auto-derive choice names in the add-question picker.** *(small)*
The picker's configure-list step is two raw inputs (`QuestionTypePicker.tsx:627-658`) with no
label-first slugify, and the question `name` field likewise ("e.g. has_fever") — while the
**inline** choices editor already auto-derives via `ChoiceNameInput`. QA had to type
`yes_fail` / `no_pass` by hand. Contradicts the standing "names are auto-derived, never typed"
decision; reuse `ChoiceNameInput`'s `fromLabel`.

**E. Order a new `calculate` so it can be referenced.** *(small-medium — blocks IHA R3)*
`+ Question` inserts at `defaultInsertIndex`, which is the start of the trailing depth-0
calculate run — so a note added *after* a calculate actually lands **above** it, and the
calculate never appears in the insert-field menu's "earlier fields" list. QA needed a manual
**move up** to make `${bmi}` offerable. This is exactly the BMI/BP/sugar → note-text flow
(IHA R3, RF R2).

**F. Per-locale choice labels at add time.** *(small-medium)*
The add picker has one label column (acknowledged at `FormEditor.tsx:966`), so Nepali choice
labels need a detour to Translate → Choices — ~6 extra interactions per list, and **every**
geriatric select needs it.

**G. Make the UI testable.** *(small, pays for itself)*
There is **no `data-testid` anywhere**; four of QA's failures were selector drift. Highest
value: `.create-form` inputs, the add-question modal inputs, the media file input, the CS
context-value card. Also `"Survey (N)"` is ambiguous (editor tab bar *and* the Translate scope
switcher both render it → strict-mode violations) and `.page-header` exists on every screen, so
waiting on it is a false readiness signal. Needed before this spec can be a trustworthy CI gate.

**1. Unhide the Calculate tile.** *(one line — ✅ SHIPPED `c66cfcb`)*
`QuestionTypeCatalog.ts:314` — `hiddenInSimple: true`. Every cross-form pull (BMI, BP,
blood sugar) needs a calculate row, so today a non-technical user must discover the
Advanced toggle first. Same one-line unhide we did for Groups.
→ Affects: IHA R3, RF R1/R2, and every hidden-flag workaround.

**2. Fix the test that locks in the wrong answer.** *(small — ✅ SHIPPED `c66cfcb`)*
`client/tests/geriatric-blockers.spec.ts:104-119` asserts an **equals** comparison against
a `select_multiple` field as if it were correct. Add a `select_one` pass/fail field to
`client/tests/fixtures/build-mini-config.mjs` and repoint the test at it, so #4 can fix the
real behaviour without fighting a green test.

**3. Wire the choice dropdowns into the calculation builder's condition editor.** *(✅ SHIPPED `c66cfcb`)*
`CalculationBuilder.tsx:387-396` mounts the same condition builder as everywhere else but
**without** `fieldChoiceOptions`, so its values are still type-it-yourself. Also give the
`calculation` field the same prop at `FormEditor.tsx:2174-2184` (relevant/constraint/
choice_filter already have it).
→ Unblocks the IHA R3 "which is high / normal" if-then texts **and** the hidden-flag route
the referral-follow-up rows need. One edit, two problems.

**4. Add the "any of these options" operator.** *(✅ SHIPPED `c66cfcb` — closes the only impossible row; UNTESTED by QA's form probe, needs a task-side check)*
The eye-examination task must fire when **any** of 5 external-eye findings is ticked, but the
task condition builder offers only equals / not-equals / greater / less — silently wrong for
a checkbox question, and currently one click away. Add an `includes` / "any of" rule kind to
`shared/src/tasks/appliesIfParser.ts` (parse + serialize + round-trip test — the form side
already does this as `selected()`, mirror it), **and gate the choice dropdown on the field's
type**, not just on the operator (`AppliesIfBuilder.tsx:552`).
→ Closes Task R8, the single hard GAP in the whole spec.
⚠️ This touches the module with a history of silent-corruption bugs. Additive rule kind only;
**round-trip test must call the serializer** on non-canonical input.

**5. Replace the context-key text box with a picker.** *(✅ SHIPPED `7a0aa2e`)*
`RelevantRuleBuilder.tsx:545-551` (and `:490-501`) still take the cross-form context key as
free text via a datalist. Make it a real dropdown of defined context values with an
"orphaned / no longer exists" badge — the pattern already exists in `ReportFieldPicker.tsx:124-153`.
→ Removes the last typing from the 8 referral-follow-up rows.

**6. Let users add a language-specific image.** *(small)*
`MediaImageField` (`FormEditor.tsx:2441-2452`) renders a control for `media::image` plus any
`media::image::<lang>` column **already present**, but there's no way to create one. Add it to
the existing **Add language** flow (adding a locale optionally offers per-language images),
mirroring how that flow already creates `label::<lang>`.
→ Only matters when an illustration has text baked into it; the chair-rise image is
language-neutral so nothing in the spec is blocked. Included because you asked for it.

**7. Text styling controls for labels and hints.** *(small-medium — cosmetic but spec'd)*
The spec asks for Medic colour codes (red/green/blue) and bold on ~9 note/hint rows. CHT
supports this via markdown and inline HTML in labels — `**bold**` and
`<span style="color: red;">…</span>` (confirmed in the CHT styling reference) — so today it
means hand-typing HTML.
→ Add a small toolbar on the label/hint input: **B** wraps the selection in `**…**`; a colour
picker wraps it in the `<span style="color: …">` form. Same caret-splice mechanics as the
existing insert-field button.

**8. Create a translation key, with suggestions.** *(medium — the biggest single win)*
Task titles need a hand-typed identifier (`task.geriatric.eye_followup.title`) and the
translations screen can only edit keys that already exist on disk — so a bilingual task title
can't be made in the tool at all. **This alone blocks 17 of the 18 tasks.**
→ "+ Add translation key" as a grouped dropdown: **(a)** keys your config references but no
file defines (computable from tasks/targets/contact types), **(b)** CHT's conventions filled
in with your real task names (`task.<name>.title`), **(c)** CHT core keys, **(d)** custom,
validated. Plus: the task title becomes a **picker showing the readable string** ("ANC
follow-up") with inline Nepali + English entry. Writes into every locale file.
Full spec: `docs/handoff-argpreserve-and-translations-2026-08-06.md` §2.

**9. "Stop the form here."** *(medium)*
IHA R1 (patient declines consent) and RF R16 ("Form close") have no primitive. Today you wrap
every following section in a condition on the consent answer — which works but is laborious
and easy to get wrong as the form grows.
→ A "stop unless…" macro that generates that group relevance for the user.

**10. Icon picker.** *(medium)*
Form icons are typed ids (`PropertiesEditor.tsx`). Needs a small `resources.json` editor +
icon list to pick from. Overlaps a request from the wider squad
(`docs/reviews/july16-meeting-synthesis.md` addendum, gap B).

**11. Cross-form values in one gesture.** *(hardest)*
Pulling BMI / BP / blood sugar from the screening forms takes ~7 steps per value across two
editors (define bridge in Contact Summary → calculate in the form → reference in a label).
The referral-follow-up linkage needs ~7 bridges. It all works; it's just far from one action.
→ A single "pull a value from another form" flow that creates the bridge, the calculation and
the reference together.

### If you can only do a few
**#4** (closes the impossible row), **#8** (unblocks 17 tasks), **#3** (one edit, two
problems), **#1** (one line). Those four are the difference between "can't finish" and
"finished, with some clumsiness."

### Setup prerequisites (not code)
- The **Hypertension and Diabetes screening forms must exist in the same project** — the
  BMI/BP/sugar pulls read their latest reports.
- Build in a **fresh project** (see the safety rule above).

---
---

# PARKED — resume after the geriatric work

## Safety batch (was first priority until 2026-08-06)
Full detail: `docs/reviews/p0-verification-30c3d92-2026-08-05.md`. Deferred on PO directive;
the safety rule at the top of this file is what makes that safe. Do it before pointing the
tool at an **existing** hand-written config.
- **A1. Gate the Helpers tab** — only offer "✎ edit body" for bodies the tool can round-trip;
  **delete the false "nothing is dropped" line** (`AppliesIfBuilder.tsx:207`); diff on save.
  *(~1 hour, highest value in this batch)*
- **A2. Stop dropping unrecognised code** — flip the fallback so anything unrecognised keeps
  the whole body verbatim (`appliesIfParser.ts:344`).
- **A3. Never rewrite the author's arguments** — record the real argument, emit it unchanged;
  don't classify a call whose arguments don't match. **A3b:** stop showing that plumbing —
  plain-language rule rows, generated-code preview behind a closed disclosure. Spec:
  `docs/handoff-argpreserve-and-translations-2026-08-06.md` §1/§1b.
- **A4.** Add `server/templates/malaria/tasks.js` + a cht-default helper body as
  byte-stability fixtures. **A5.** Parenthesize the third join (`appliesIfParser.ts:777`).
  **A6.** Fix `DecisionsView.tsx:471-472` rendering conditions inverted on the sign-off screen.

## Housekeeping
Wire the server tests (72) into CI; triage the 8 pre-existing failing browser specs (expect
CI red until then); fix the code-style config (110 errors) and re-enable the check;
`.gitignore` the stray `cht-district-form.png`.

## General backlog
Nested condition grouping beyond one level (**decided 2026-08-06: keep as is** — one level
covers every real task; if it ever changes, converge on the form-side condition engine rather
than growing the task-side one); OR-group-with-age-range collapses to raw on reopen;
"wrap these questions into a section" (needs multi-select); media cleanup (delete route +
orphan-file warning); and the squad's MVP asks — freeze variable names on deployed forms,
assign a form to a role, live preview as an editing surface
(`docs/reviews/july16-meeting-synthesis.md` addendum).
