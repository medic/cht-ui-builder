<!--
The single plain-language work queue. Re-prioritised 2026-08-06 on PO directive:
"everything that needs to be fixed for the geriatric use case is first priority, forget
everything else for now" — ordered easiest to hardest. The safety batch is deferred (see
the caveat) and the general backlog is parked below. 2026-08-06.
-->

# What's next — geriatric use case first

> ## ⚡ Workflow probe result (QA, 2026-08-08) — **the full loop WORKS live.**
> Assessment → task → branched follow-up → resolution, built in the tool and proven on a real
> CHT instance (steps 1–6 green; 7–8 blocked by CouchDB memory pressure, not by the tool).
> Timing behaved exactly as warned: proven with the day-0 variant, then 15/30/15 restored and
> the task correctly sat in Draft until day 15. **Interaction cost: ~124 UI actions for the 7
> referral flags (~18 each), ~65 for the task, ~180 for the 12-row follow-up.**
> Findings filed below as **W1–W6**.
>
> ### 🔴 W1 re-opens the parked safety batch — the parking rationale no longer holds
> We parked the `appliesIfParser` safety batch on the reasoning that corruption *"only bites when
> the tool opens pre-existing hand-written JavaScript"* — i.e. imported configs only. **That is
> now false.** QA reproduced a silent no-op-save corruption of **`server/templates/cht-default/tasks.js`**
> — *our own template, shipped by our own wizard*: its computed
> `events: [...Array(21).keys()].map(generateEventForHomeVisit(...))` (line 136, confirmed) is
> truncated to a bare integer array, and 47 lines of comments/formatting are lost. **A user who
> picks cht-default and opens the Tasks panel corrupts their project.** Recommend un-parking at
> least this item.
>
> ### 🔴 W2 — item 8 is POINTLESS without a one-line deploy fix
> **`upload-custom-translations` is missing from the one-click deploy sequence** (`deploy.ts:40-46`
> — verified; note **`upload-resources` IS present**, so QA's finding is narrower than reported).
> The action exists as an individual step (`cht-conf.ts:73`); it just never runs in the sequence.
> **So bilingual task titles would be authored, written to `.properties`, and never uploaded —
> the CHW sees the raw key.** → **Add it to the sequence as part of item 8's definition of done.**
>
> ### W3 — `modifyContent` cannot be authored no-code (the capability we said was "built but untested")
> Three failures: the source picker emits `report.<field>` where CHT needs **`report.fields.*`**
> (undefined at runtime); switching a row to custom **resets it and demotes the whole table to
> read-only**; the only working path is the Raw JS hatch. This is the load-bearing joint for the
> task→form hand-off.
>
> **→ W3 + W4 are now specced as one feature: `docs/handoff-task-to-form-handoff-2026-08-08.md`
> — "make the task → form hand-off no-code". Next item after item 8 + W2.**
>
> ### W4 — the receiving `inputs` nodes can't be created either
> "+ add inside" on the `inputs` group drops rows into `inputs/user/`, where CHT's content-binding
> can't reach them (QA hand-relocated with a script). And delivered flags **aren't persisted** in
> the saved follow-up doc — the scaffold gates inputs on `source='user'` and Enketo clears
> non-relevant values on submit. Real configs solve this with harvest calculates, which the tool
> also can't author. **W3 + W4 together mean the task→form hand-off is not yet no-code.**
>
> ### W5 — `cht-default` doesn't compile as scaffolded
> `require('moment')` with **no `package.json`** (confirmed absent). The per-template compile
> guard never covered this template. Directly contradicts the "templates ship required minimal
> files" directive.
>
> ### W6 — spec answers QA was forced to invent (need customer sign-off)
> Hearing built as **OR** (sheet says "and"); **both** N6 tests trigger; nutrition branch kept
> as-written; weight **not** a trigger; window anchored on IHA submission. Still unresolved and
> worth escalating: **self-harm on a 30-day clock**, and the label-only choice values.
>
> ---
>
> # 🎯 CURRENT SINGLE FOCUS (PO, 2026-08-08): **item 8 only — the bilingual task title.**
> **Scope now includes W2** (add `upload-custom-translations` to the one-click deploy sequence) —
> without it the feature cannot reach a device.
> **Build nothing else until it lands.** One input per project locale on the task's Title
> field, exactly like the per-locale choice labels shipped in `8eda602`; the key is
> auto-derived and never shown. Full design + implementation notes:
> `docs/handoff-argpreserve-and-translations-2026-08-06.md` §2 (the **REVISED** box), and
> item **8** below.
>
> *Parked by this directive, not cancelled — and both still matter:* **P1-LOCALE-SEAT** (the
> `8eda602` regression that silently blanks choice labels on 11 imported configs, one of them a
> live NSSD production form) and **P1-DEPLOY** (insert-contact-field emits a form that fails
> `cht convert`). Neither fires unless someone adds a choice list to an affected imported form,
> or uses a patient-name insert — so parking them is safe for now. Pick them up next.

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

**P1-LOCALE-SEAT. 🔴 REGRESSION in `8eda602` (item F) — typed choice labels are silently dropped on imported configs.** *(~15 lines in one guarded branch — do this FIRST: it is a regression already on `origin` that can silently blank labels on a live production form)*

**Root cause — two lines disagreeing about which sheet they mean.** The picker is fed `form.surveyHeaders.labelLocales` (`FormEditor.tsx:1415-1419`) and packs one label per **survey** locale (`QuestionTypePicker.tsx:254-258`); the seat iterates `form.choicesHeaders.labelLocales` (`FormEditor.tsx:964-975`). Every typed key the **choices** sheet doesn't declare is dropped silently; every declared key the picker didn't collect is materialised as `''`.

Independently reproduced end-to-end (parse → picker → seat → serialize → re-read from disk bytes → **pyxform compile**):

| | Shape | Result | Regression? |
|---|---|---|---|
| **A** | choices sheet declares fewer locales | typed `{en,ne}` seats as `{"en":…}`; Nepali unreachable in the Choices *and* Translate tabs (both render from `choicesHeaders.labelLocales`) | **No** — parent produced the same XForm. It's a **false affordance**: the picker renders a `label::ne` input that goes nowhere. **0 of 249 real forms** — latent, not live. |
| **B** | choices sheet uses a **bare `label`** header (→ sentinel `'_'`, `parse.ts:281`) | seats `{"_":""}` → on disk `["list","weak",""]` → re-parses `{}`. XForm: `<item><name>weak</name></item>`, **no label in any language**. Parent emitted `<label>Weak</label>`. | **YES, genuine.** **11 real forms**, all with choice lists. |

**Two corrections to QA's framing:** B is **broader** — it also fires on a plain **monolingual** form (survey `label::en` + choices bare) and in the mirror direction; and **narrower** — a **fully**-bare form (both sheets bare) works correctly today and must keep working. Only the **mixed** shape breaks. **Locale-order mismatch is REFUTED** — labels are keyed, not positional; 13 real forms have reordered columns and all round-trip intact.

**Why this outranks a 4.4% hit rate:** it fires only on **imported real configs**, never on tool-created ones — i.e. aimed exactly at our moat. **One of the 11 is total loss:** `config-nssd/chis/forms/app/pregnancy_surveillance_form.xlsx`, a git-tracked **live NSSD production form with 90 choice rows across 14 lists** — the likeliest candidate anywhere for a 15th list. The other 10 lose only `en` (and post-commit still seat six genuine locales where the parent seated one). And **our own `cht-default` template ships 3 mismatched forms** (`templates.ts:73-82,147` is a verbatim `copyDir`), so a wizard-created project can inherit the trap on day one. Nothing catches it downstream: pyxform only **warns**, `errorPatterns.ts` classifies no warnings at all, and `preflight/rules/selectChoices.ts:23-35` counts rows, never labels — so blank choice labels reach CHW devices.

**KEEP AND FIX — do not revert.** On the aligned shape (235/249 forms, 100% of tool-created) item F is a real win: QA's at-scale run authored 16 bilingual lists inline, 39/39 Nepali labels on disk.

### Fix spec
**(a) Seat the sentinel-safe union** at `FormEditor.tsx:964-975`: union `choicesHeaders.labelLocales` with every key the picker typed, **existing columns first** (deterministic append), then keep `labels[loc] = c.labels[loc] ?? ''`. Filter `'_'` out of the union **unless it is all we have** (the fully-bare form, which must stay a no-op).
**(b) Extend `choicesHeaders.labelLocales` in the SAME `patch()`** — append-only, preserving order; mirror `addLocale` (`:1276-1283`). **QA's proposal misses this**, and without it the Nepali reaches disk but stays **invisible in-session**, because the Choices tab (`:3653`, `:3668`) and Translate tab (`:3772`, `:3901`, `:3912`) both render from that array. **Never remove `'_'`** from it.
**(c) NEVER map a real locale onto `'_'`.** The intuitive "put the default locale in the bare `label` column" refinement is **a new data-loss bug**, proven against pyxform 4.5.0: without `default_language` it emits a third pseudo-language `lang="default"`; with `default_language: ne` and `label::ne` present the bare value is **silently discarded**.
**(d) The leftover bare `label` column is harmless — this is the load-bearing fact that makes (a) safe.** pyxform resolves label columns **per LIST, not per sheet**: on the exact naive-union artifact (`[list_name, name, label, label::en, label::ne]`) it converts with **zero warnings**, the pre-existing list keeps its static `<label>`, and the new list gets proper itext in both languages. **Do not migrate the old bare cells** — that would regress them to `-` in Nepali.
**(e) Column ordering:** new `label::xx` lands at the tail. Accept it. **Do not splice `choicesHeaders.ordered`** — reordering existing on-disk columns breaks the invariant for real.
**(f) Byte-stability is provably safe:** the union is identical to today's seat whenever the sheets agree, identical on a fully-bare form, and the whole block is guarded by `commit.list && …length > 0` (`:960`).
**(g) One-line belt:** re-apply the picker's drop rule *after* seating so a draft whose only content was a dropped locale can't land as a blank `opt_N` phantom.

### Tests — the structural change matters more than the cases
**Extract the seat out of `FormEditor.tsx` into `shared/src/xlsform/choiceLabelSeat.ts`** as a pure `seatChoiceLabels(typed, choicesLocales, surveyLocales)`. **This is the single most important change:** the defect lives in client code with no unit seam, and `c.labels[loc]` typechecks fine as a `Record` index — which is exactly why 625/625 green and clean typecheck were *structurally incapable* of seeing it. Then:
1. `choiceLabelSeat.test.ts` — full matrix with exact expected `Record` per case: aligned · A · choices-superset · **B mixed** · **B mirror** · fully-bare (no-op) · reversed order.
2. `serialize.roundtrip.test.ts` — bare-label sheet is a byte no-op (header stays exactly `label`, never `label::_`); seating a real locale appends `label::xx` while pre-existing bare cells stay byte-identical; extras keep their original column positions; two successive adds produce no duplicate columns.
3. `client/tests/choice-locale-mismatch.spec.ts` + **two new non-canonical fixtures** (`mismatch-config`, `bare-label-config` with a pre-existing populated list). **Fixture workbooks must be written with a raw xlsx writer, never by our own `serializeXlsForm`** — it canonicalises `label` → `label::en`, which is why the only committed fixture (`mini-config`, aligned on both sheets) could not observe either scenario. Assert the full cell grid, not `toBeTruthy()`.
4. **`server/templates` symmetry guard** — every shipped template `.xlsx` must lose nothing through the seat. Catches cht-default's 3 forms and stops future drift.
5. **New preflight rule** `choiceLabels` — every choice row in a referenced list carries ≥1 non-empty label. Must fail on the Scenario-B artifact and the `opt_1` phantom.
6. Tighten the §F leg (`geriatric-blockers.spec.ts:284-292`) — assert the row `type` and filter choices by `list_name`; today it matches across all lists, so a wrong-list landing passes silently.

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

**8. Bilingual task title — one input per language, exactly like choice labels.** *(medium — the biggest single win; DESIGN REVISED 2026-08-08 by the PO)*
**Lead with the label inputs, not a key picker.** A task's Title field should render **one input
per project locale** (`English` / `नेपाली`), identical to the per-locale choice-label row shipped
in `8eda602`. The tool auto-derives the key (`task.<name>.title`), writes it into `tasks.js`, and
writes each string into `messages-<locale>.properties`. **The user never sees or types a key.**
Reopening resolves the key and shows the strings; a literal title shows as one value with a
"make this translatable" offer; the key stays stable on edit (renaming it would orphan the
strings). Plumbing verified to exist: `GET /api/translations` discovers locales,
`PUT /api/translations/:locale` writes and creates missing files. The key-suggestion dropdown is
still worth building — but in the **Translations editor**, for filling in keys a config already
references, not as the task author's path. Full spec:
`docs/handoff-argpreserve-and-translations-2026-08-06.md` §2 (see the REVISED box).

<details><summary>superseded framing</summary>
Task titles need a hand-typed identifier (`task.geriatric.eye_followup.title`) and the
translations screen can only edit keys that already exist on disk — so a bilingual task title
can't be made in the tool at all. **This alone blocks 17 of the 18 tasks.**
→ "+ Add translation key" as a grouped dropdown: **(a)** keys your config references but no
file defines (computable from tasks/targets/contact types), **(b)** CHT's conventions filled
in with your real task names (`task.<name>.title`), **(c)** CHT core keys, **(d)** custom,
validated. Plus: the task title becomes a **picker showing the readable string** ("ANC
follow-up") with inline Nepali + English entry. Writes into every locale file.
Full spec: `docs/handoff-argpreserve-and-translations-2026-08-06.md` §2.

</details>

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

## Filed separately from the item-F review (2026-08-08)
- **🔴 HIGH, pre-existing (originates `4583de2`, byte-identical at `c5d8508` — NOT from item F): re-typing a row to `select_one`/`select_multiple` with a new list discards the authored choices AND leaves a dangling reference.** `FormEditor.tsx:845-863` patches only `type` + `extras` and returns — `commit.list` is never read — yet `QuestionTypePicker.tsx:227-231` still routes the edit flow through the choices grid. Result: `select_one <newlist>` pointing at **zero rows**, no dangling-list validator anywhere in the tree, recovery only behind "show advanced". QA rated this P2; it's high.
- **MEDIUM: no preflight rule for empty choice labels, and `errorPatterns.ts` classifies no pyxform *warnings* at all** — which is why the Scenario-B corruption stayed silent all the way to devices.
- **MEDIUM: the `label::_` phantom header becomes an active trap after the fix** — `FormEditor.tsx:3653` renders `<th>label::{loc}</th>` literally, so bare-label forms already show a `label::_` column; once a real `label::en` sits beside it pyxform lets `label::en` win and silently discards anything typed into `_`. Render `'_'` as `label` and make it read-only when a real locale column exists.
- **LOW:** list-name collision guard is blind to survey-referenced-but-empty lists (`existingListNames` from `form.choices` only) · choice grid overflows at exactly **4** locales (measured: tracks pin at 177px min-content, ✕ 17px outside the card — fix with `minmax(0, 2fr)` + `min-width: 0`) · `opt_${i+1}` fallback isn't collision-checked against typed names · **Enter-to-add-row is a dead key for bilingual authors** (guard requires the *last* locale column and nothing focuses the new row — the commit message oversells it).

## Standing QA rule added 2026-08-08 (PO directive): **no-code by default**
**Every artifact QA produces must be authored through the UI.** Hand-editing a config file — or
running a script that edits one — is permitted **only** to get past a tool gap that is *already
filed as a finding*, and never to make a capability appear to work. When used it must be:
1. **disclosed per instance** in the report — which file, what was changed, and why;
2. **paired with the finding it works around** (a hand-fix with no finding is a reporting bug);
3. **re-tested through the UI** once that gap is fixed, and the result reported again.

The purpose of these probes is to measure what a health-post officer can actually do. A silent
hand-fix inflates that measurement, which is the one failure mode that makes the whole exercise
worthless. *(QA's 2026-08-08 workflow probe complied — the hand-fixes were disclosed and each
became finding W3/W4. This rule makes that behaviour the standard, not a courtesy.)*

## Standing process rule added 2026-08-08 (after the fourth green-tests/broken-reality case)
1. **Cross-sheet or cross-locale logic must live in `shared/` as an exported pure function**, never inline in a React handler. `8eda602` was untestable *by construction*.
2. **Stand up a hostile fixture corpus** — `shared/src/xlsform/fixtures/noncanonical/`: bare `label` on choices only, bare on both, legacy `label:ne`, survey-superset locales, extras interleaved between label columns. Workbooks written by a **raw xlsx writer**, never by our own serializer. Add `pnpm test:hostile` and name it in the Gates line of any commit touching parse/serialize/seat.
3. **The Gates line must name a spec that actually executes the changed lines.** `8eda602` credited `poc-build` and `condition-builder`, neither of which contains a single `.qtype-` selector or ever reaches the configure-list step. The no-regression claim was fine; the *attribution* is how a coverage gap reads as coverage.

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
