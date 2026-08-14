<!--
Spec for the one thing in focus (PO directive 2026-08-12): let a no-code author PICK the
context values a config already computes. Supersedes the one-line "also detect context.<key> = …"
in handoff-nssd-safety-batch B5. Measured against W:\medic\config-nssd\chis. 2026-08-12.
-->

# Pick pre-existing context values

**PO directive (2026-08-12): this is the focus.**

## Why this exists — the corrected rationale

The geriatric build's BMI / BP / blood-sugar row worked without writing any contact-summary code.
It is tempting to read that as the config-agnostic principle paying off. **It isn't.** It worked
because a developer had **already hand-written** that contact-summary code for the hypertension and
diabetes screening workflow. The tool got lucky that the value existed.

That reframes the feature, and makes it more valuable rather than less:

> **A deployed config accumulates computed clinical values that developers wrote over time. Those
> are assets. A no-code author should be able to find and reuse them without knowing they exist,
> without knowing how they're spelled, and without writing code.**

Two distinct capabilities, and we currently have one and a half:

| | Capability | Status |
|---|---|---|
| **Reuse** an existing computed value | pick from what the config already computes | ❌ **this spec** — picker shows **zero** on NSSD |
| **Create** a new one | define "latest `<field>` from `<form>`" | ✅ shipped (Context values tab) |

The picker should offer both in one place — *"here's what your config already computes"* and
*"…or define a new one"* — because an author doesn't know which situation they're in.

## Scope decision (PO, 2026-08-12): this is ONE feature with the contact-field path included

**Workbook row R3 is the proof case, and it needs both halves at once:**

> `{Person_Name}'s Health Details` — BMI …, blood pressure …, blood sugar …

One row, two kinds of reference: the **patient's name** (a contact field) and the three **computed
context values**. In the NSSD build QA **deliberately skipped it and marked it "Not built"**, because
the contact-field half is the P1 that makes `cht convert` fail — *"a real gap, silently dropped."*

So these are not two projects. They are one seam — **"insert a reference to a value that already
exists"** — with several sources behind one picker:

| Source | State |
|---|---|
| An earlier field in this form (`${field}`) | ✅ works |
| A **contact field** (`patient_name`, `patient_id`) | ⚠️ picker works, **emits an undeployable form** — see below |
| A **context value the config already computes** | ❌ shows zero on a real config — tiers 1–2 above |
| A **new** cross-form value | ✅ shipped (Context values tab) |

### The contact-field half — fold in the P1 deploy fix
Filed as **`P1-DEPLOY`** in `NEXT.md`; do it **as part of this change**, not separately, because R3
cannot be built without it and because both halves land in the same picker.

The insert creates the harvest `calculate` referencing `../inputs/contact/<field>` but **never
declares that node inside the `inputs/contact` group**, so pyxform cannot resolve the XPath and
validation fails. Three parts:
1. **Generator** (`shared/src/xlsform/insertContactFieldRef.ts`) — also declare the node in
   `inputs/contact` when absent, in the same undoable patch.
2. **Preflight** — `danglingRefs.ts` currently treats any `../inputs/*` path as valid **by
   assumption** ("the runtime injects it"). It doesn't; the node must be declared. Validate against
   the form's real `inputs` block, so the tool catches this instead of whitelisting it.
3. **A `cht convert` (pyxform) leg in CI** for anything that generates form rows — this defect was
   invisible to every on-disk check, and the feature had shipped with nine green flow tests.

**Note the shared shape:** `insertContactFieldRef` is also the machinery to copy for the context-value
insert — one gesture producing a correctly-placed, deduped, idempotent set of rows in a single
undoable patch. Fix it once, reuse it for the other source.

## Measured reality on `config-nssd/chis`

The picker reports **0 keys**. There are **21**. Why we see nothing, and what a fix must handle:

**1. The context isn't in the file we parse.** `contact-summary.templated.js:18` is just:
```js
const context = getContext(thisContact, allReports);
```
Our detector wants `const context = {` (`contactSummaryParser.ts:46`) or a `context: {` literal
inside the last `return`. Neither matches. **The 21 keys live in `contact-summary-extras.js`,
inside `function getContext(thisContact, allReports)` (:651).** Detection must **follow the
indirection across files.**

**2. The 21 are plain assignments** — `context.alive`, `context.previous_bmi_ctx`, `context.sys_ctx`,
`context.dia_ctx`, `context.glucometer_ctx`, `context.dt_fbs_ctx`, `context.dt_pps_rbs_ctx`,
`context.show_pregnancy_form`, `context.delivery_date_ctx`, `context.motherstatus_ctx`,
`context.total_visit`, … — **many inside `if` blocks**, so a key may or may not exist at runtime.

**3. Static detection is provably incomplete. Three sources it cannot enumerate:**
- **Dynamic keys** — `context[key] = value` (`:376`) inside a generic loop.
- **Template-literal keys** — `context[\`baby_name_${i}_ctx\`]`, `context[\`baby_status_${i}_ctx\`]`
  (`:721-722`) → a *family* of keys (`baby_name_1_ctx`, `baby_name_2_ctx`, …) whose count depends on
  the data.
- **Spread sources** — `const context = Object.assign({}, getAge(…) <= 5 ? getChildVaccinations(…) : {})`
  (`:652-653`): keys come from another function's return value, conditionally.

**So tier 1 gets 21 of 25-plus, and cannot know it's missing any.** That is the argument for tier 2,
below — not as polish, but as **the only complete and trustworthy answer.**

**4. ⚠️ A false-positive trap for a naive fix.** `contact-summary.templated.js:112` contains
`context: { count: …, total: … }` — that is a **translation-interpolation context on a card field**,
nothing to do with the summary context. A fix that simply scans the file for `context\s*:\s*\{`
would offer `count` and `total` as pickable context keys. (Today's fallback happens to miss it
because it only scans inside the last `return`, where the real export is `context: context,` at
`:333`.) **Any widened detection must be scoped, not a file-wide grep.**

---

## Tier 1 — see what's statically there *(do first; small, read-only)*

Extend `shared/src/tasks/contactSummaryParser.ts` to collect context keys from all of:
1. `const|let|var context = { … }` — **already works**, keep.
2. `context: { … }` in the exported object — **already works**, keep, and keep it scoped to the
   export so `:112` can't leak in.
3. **NEW — assignment form:** `context.<key> = …` and `context['<key>'] = …` (literal string only).
4. **NEW — follow the indirection:** when `context` is assigned from a **call** rather than a
   literal (`const context = getContext(a, b)`), resolve that function — **including in
   `contact-summary-extras.js`** — and collect assignments within its body. One hop is enough for
   NSSD; do not build a general call-graph resolver.
5. **NEW — report what it can't see.** Emit an explicit `indeterminate` signal when the body
   contains dynamic-key assignment (`context[expr]` where `expr` isn't a string literal) or a
   spread/`Object.assign` from a call. **The UI must say so** (below) — silence would imply the
   list is complete when it provably isn't.

Return shape — extend, don't replace (`contextFlags`/`contextOrder` stay for the editor):
```ts
interface ContextKeyInfo {
  key: string;
  origin: 'literal' | 'assignment' | 'indirect';  // where we found it
  conditional: boolean;      // inside an if/ternary — may not exist at runtime
  expression: string | null; // RHS source text, for a "computed from…" hint
  file: string;              // templated vs extras — the author may want to look
}
interface ContextScan {
  keys: ContextKeyInfo[];
  indeterminate: { reason: 'dynamic-key' | 'spread-from-call'; evidence: string }[];
}
```

**Read-only. No new emission path, so no round-trip risk** — this is the cheapest safe win we have.

## Tier 2 — show the real value *(the only complete answer)*

**Why it's not optional:** tier 1 is measurably blind to at least three key families, and it cannot
tell a *conditional* key that will exist for this patient from one that won't. Running the deployed
contact-summary against a **real contact** answers both.

Design: when connected to an instance, execute the compiled contact-summary for a chosen contact
and show the **actual value** beside each key —

```
Values your config already computes for  Devi Kumari Thapa (67)

  previous_bmi_ctx      27.6          ← computed from hypertension_screening
  sys_ctx               138
  glucometer_ctx        145
  alive                 true
  show_pregnancy_form   false
  baby_name_1_ctx       —  (no value for this contact)
  …
  ＋ Define a new value from another form
```

The author picks **"BMI → 27.6"**, not an identifier they hope is spelled right. It also surfaces
the dynamic families tier 1 can't name, and it validates the key end-to-end before they build on it.

**Implementation notes:**
- QA's note, worth heeding: the compiled contact-summary is a **UMD bundle** and needs
  **global-scope sandboxing** to execute.
- Run it **server-side** (never in the client) against the instance's real contact + reports.
- This must be **read-only and side-effect-free** — it evaluates config against live data. Treat any
  write as a bug.
- Degrade honestly: no instance → tier-1 list with *"connect to an instance to see real values."*
- Pick-a-contact needs a chooser; reuse whatever the deploy panel already uses to reach the instance.

## Tier 3 — emit in the project's house style

Same principle as the lint-emission fix (safety batch **A′**): when the tool *does* write a context
value, match the file's own conventions rather than ours. **Do not build this before A′** — it's the
same underlying capability (infer style from what we parsed) and should be solved once, in one place.

---

## The picker UI

One surface, grouped, best-source first — mirroring the pattern already shipped for choice values
and translation keys:

1. **"Values your config already computes"** — the scan, with the real value when tier 2 is live.
   Mark **conditional** keys (*"only set for some contacts"*) and show the `expression` as a
   *"computed from…"* hint so the author can tell `previous_bmi_ctx` from `sys_ctx`.
2. **"Not fully detectable"** — when `indeterminate` is non-empty, say it plainly: *"This config
   also builds some values dynamically that we can't list. Connect to an instance to see all of
   them,"* plus a free-text escape. **Never present a partial list as complete.**
3. **"Contact fields"** — `patient_name`, `patient_id`, … (the fixed contact-field path). Same
   picker, same one-gesture behaviour, so R3's name and its three values are authored side by side.
4. **"＋ Define a new value from another form"** — the existing Context values flow, so an author who
   finds nothing suitable isn't stranded.

## Acceptance — R3 is the exit criterion
Build workbook row **R3** end to end in the UI, with **zero hand-edits**, and ship it:
1. the patient's name inserted from the picker (no typed `${…}`, no manual `inputs` surgery);
2. the three values picked from what NSSD already computes (no typed identifiers);
3. `cht compile-app-settings convert-app-forms` **passes** — the current blocker;
4. on the instance, the note renders the real name **and** BMI 27.6 / BP 138 / sugar 145 for
   Devi Kumari Thapa, matching what QA already proved for the values alone.

Until R3 builds and deploys untouched, this feature isn't done — that row is the one QA had to mark
"Not built."

## Tests
- **Contact-field half:** the harvest calc **and** the declared `inputs/contact` node in one patch;
  idempotent re-insert; a **pyxform conversion test** on the produced form (the check that would have
  caught the P1); `danglingRefs` now **fails** on an undeclared `../inputs/contact/x` instead of
  passing it.
- **Unit** (`contactSummaryParser`): NSSD's real `getContext` shape → **exactly the 21 keys**, with
  `conditional` correct for the `if`-nested ones; the assignment form; bracket-with-string-literal;
  the **cross-file indirection**; `indeterminate` populated for `context[key]` and for the
  `Object.assign(getChildVaccinations())` spread. **A negative test that `:112`'s card-field
  `context: {count,total}` is NOT offered** — that's the trap.
- **Fixtures:** copy the real shapes (templated-delegates-to-extras, assignments in conditionals,
  template-literal keys) into the non-canonical corpus. Do **not** hand-write a tidy fixture — a
  tidy fixture is why we see zero keys today.
- **Round-trip:** parsing more shapes must not change what we *write*. A no-op open+save of NSSD's
  contact-summary must stay byte-identical — pin it.
- **Tier 2:** the sandbox executes the UMD bundle, returns values, and **writes nothing**; a
  throwing contact-summary degrades to the tier-1 list rather than blanking the picker.

## Explicitly not in scope
A general JS call-graph resolver (one hop covers NSSD); evaluating context in the client; editing
`getContext` (this is read-and-reuse, and the extras-editing path has known corruption bugs — see
the parked safety batch); inventing values a config doesn't compute — that's the existing Context
values tab, and it stays a separate, clearly-labelled action.
