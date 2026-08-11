<!--
Can the no-code editor be pointed at config-nssd — a real, deployed, national CHT config — without
corrupting it? Seven measured lanes, four of them adversarially re-run by a second auditor.
Answer: not yet. Nine P0 defects, most triggered by opening a panel and saving with ZERO edits.
2026-08-11.
-->

# NSSD initial assessment — **STOP before you edit**

*The baseline reading of config-nssd. Everything measured here is the state of the config and the
editor on 2026-08-11, before any fix; re-run the lanes after batch A to measure progress against it.*

> 📖 **Plain-language version with worked examples:**
> [`nssd-detailed-assessment-2026-08-11.md`](nssd-detailed-assessment-2026-08-11.md) — same findings,
> explained through what a CHW would actually see. Use that one for the squad and MOH; this one
> carries the counts, commands and file:line references for the dev.

**Target:** `W:\medic\config-nssd\chis` (branch `954_geriatric`, real `medic/config-nssd`).
**Scale:** 36 app forms + 34 contact forms, `tasks.js` 1001 lines / 29 tasks, `contact-summary-extras.js`
825 lines / 50 callables, `base_settings.json` 27 keys, 8-level hierarchy, 425 KB of translations.

**Method:** seven parallel lanes measuring the compiled `shared/dist` parsers against the real files;
the four critical lanes were then handed to a second auditor whose only job was to **refute** them.
Three of the four refutations succeeded — every one by finding the first auditor had tested only the
**no-op** path and missed damage on the **edit** path.

> ## The verdict
> **Do not open config-nssd's existing artefacts in the editor.** Nine P0-class defects silently
> corrupt a deployed national config. Six of them fire on **open-a-panel-and-save with no user edit**.
> Every one of them produces **valid, compiling, deployable output** — `cht compile-app-settings`
> passes, `npm test` passes, the corruption reaches devices.
>
> **There is still a safe path to the geriatric build today** — see
> [`../nssd-build-protocol.md`](../nssd-build-protocol.md). It works because the geriatric artefacts
> are *new files*, and almost none of this damage applies to files the editor authored itself.

## Independently re-verified by the planner

I re-ran the three worst claims with my own scripts before writing them down. All three reproduce
exactly:

| Claim | Reported | My run |
|---|---|---|
| Contact forms parsing `relevant` as literal `"FALSE()"` | 19 / 34 | **19 / 34** ✔ |
| `appliesIf` bodies rewritten to `isAlive(contact.contact)` | 26 | **25** (of 28 that change at all) ✔ |
| `context.expression` losing parens around an `\|\|` | 11 / 24 | **11 / 24** ✔ |
| App forms whose `settings.version` becomes a JS `Date` string | 10 | **10** ✔ |

---

## The nine P0s

### 1. 🔴 Falsy Excel formulas become their own source text — 19 contact forms
Every contact form hides its `inputs`/`user` group with the Excel formula `=FALSE()`. exceljs's
`FormulaValue._copyModel` tests the cached result for truthiness — so a `false` result is **stripped
from `cell.value`** — and our `cellToString` then falls through to returning the formula *source*.
The row parses as `extras: { relevant: "FALSE()" }`.

```
c10_center-create.xlsx  r_1  begin group inputs  →  extras.relevant = "FALSE()"
committed c10_center-create.xml                  →  relevant="false()"
```

pyxform 4.5.0, run directly on probe forms, confirms the consequence:

| cell content | compiled bind |
|---|---|
| formula `=FALSE()` (what's on disk) | `relevant="false()"` ← the committed baseline |
| string `"FALSE()"` (what we'd write back) | **`relevant="FALSE()"`** ← undefined XPath function |
| string `"false"` | `relevant="false()"` |

XPath 1.0 is case-sensitive; `FALSE()` does not exist. **Affected: the entire place hierarchy plus
person editing** — `PLACE_TYPE-*`, `c10_center`, `c20_province`, `c30_district`, `c40_municipality`,
`c50_ward`, `c60_chn_area`, `c70_fchv_area`, `c80_household` (create+edit each) and `c82_person-edit`.

**Fix** (`shared/src/xlsform/parse.ts`, `readRow`): read the result off the **Cell**, not off
`cell.value` — exceljs strips falsy results from `value` but `cell.result` is correct.
```ts
const cell = excelRow.getCell(c);
cells.push(cell.type === ExcelJS.ValueType.Formula
  ? (cell.result == null ? '' : String(cell.result))
  : cellToString(cell.value));
```
Same one change also fixes P0 #2 and most of the `choices-backup` damage.

### 2. 🔴 `settings.version` becomes a machine-dependent date string — 10 app forms
`=NOW()` has a `Date` cached result, so `cellToString` returns `String(Date)`:
`"Fri Feb 13 2026 04:43:23 GMT+0545 (Nepal Time)"`. That string lands in the XForm `version`
attribute, silently version-bumping 10 forms nobody edited and **embedding the build machine's
timezone** — output is no longer reproducible across machines. (`breast_cancer`,
`breast_cancer_followup`, `death_report`, `mute`, `unmute`, `pnc_danger_sign_follow_up_baby`,
`pnc_danger_sign_follow_up_mother`, `pregnancy`, `pregnancy_danger_sign`, `pregnancy_home_visit`.)

### 3. 🔴 `isAlive`/`isMuted` get the wrong argument — 25–26 of 29 tasks
`serializeAppliesIf` **hardcodes** `contact.contact` as the argument
(`appliesIfParser.ts:839/843`); the rule model has no `args` field for the standard helpers
(`:25-26`), so the real argument is discarded at `:565-566`. NSSD's helper takes the task-engine
wrapper:

```js
function isAlive(contact) {
  if (contact && contact.contact && contact.contact.date_of_death) return false;
  if (contact && contact.reports && contact.reports.some(r => r.form === 'death_report')) return false;
  return true;
}
```

Pass `contact.contact` and it looks for `contact.contact.contact.date_of_death` (undefined) and
`contact.contact.reports` (undefined) — so **`isAlive` always returns true and `isMuted` always
returns false.** Dead patients, patients with a filed `death_report`, and muted patients all start
generating tasks: breast/cervical/child-health referral follow-ups, ANC home visits, PNC danger-sign
follow-ups, IUCD/implant, hypertension, diabetes.

**Trigger: opening the appliesIf rule builder on a task and saving. No edit required.**

### 4. 🔴 Declarations dropped, references kept — 4 tasks throw `ReferenceError` on device
`serializeAppliesIf` drops every `const`/`let` from a body while keeping the expressions that use
them. The output is valid JavaScript, so `compile-app-settings` passes and it ships; it throws
per-contact inside the rules engine. (`pnc_service_after_delivery` L513, `anxiety_session_1` L750,
`depression_session_1` L809, `motivational_interviewing` L872.)

**The parser already knows.** `parsed.hasRawFallback` is *already true* on all four — the serializer
simply never reads it. The fix is a refusal-to-emit gate, not new parsing.

### 5. 🔴 A bare function reference becomes a function that *returns* the helper — 2 tasks
Found only by the refuting auditor. Where `appliesIf` is a bare reference
(`appliesIf: someHelper`), serialization produces a function that **returns** the helper instead of
**calling** it — making `appliesIf` unconditionally truthy.
`mental_health.mental_health_referral_followup` and `cervical_cancer.referral_followup` would fire
**for every matching report on every patient.**

### 6. 🔴 `resolvedIf` bodies replaced by a template — 7 tasks
`parseResolvedIf` classifies a body as the canonical pattern on a **bare substring search** for
`isFormArraySubmittedInWindow` anywhere in the text, then `serializeResolvedIf` replaces the entire
hand-written body — discarding early-return guards, window arithmetic, extra conditions, comments.

The refuter corrected the first auditor here: the effect is worse than "resolves a day late". The
template drops the CHT-canonical `Math.max(..., report.reported_date + 1)` **start clamp**, so a
**stale prior report of the same form pre-resolves the task and the CHW never sees it at all.**
(PNC mother/baby danger-sign, IUCD/implant, pills/depo, balanced-counselling FP follow-ups.)

### 7. 🔴 Context expressions lose their parentheses — 11 of 24 app forms
`serializeContextExpression` strips the parens around any operand it lifts as `raw`. Since `&&`
binds tighter than `||`, this is a **semantic rewrite of form eligibility**:

```
IN : contact.contact_type === 'c82_person' && (!contact.date_of_birth || (ageInYears(contact) < 5)) && !contact.muted && !contact.date_of_death
OUT: contact.contact_type === 'c82_person' && !contact.date_of_birth || (ageInYears(contact) < 5) && !contact.muted && !contact.date_of_death
```

which is `(person && no-DOB) || (under-5 && !muted && !dead)` — the contact-type gate is gone.
Two auditors built independent synthetic contact spaces (448 and 672 states) and flagged the
**same 11 files**, with **every single flip in the false→true direction**: deceased and muted
contacts become eligible.

**Worst part:** `validateContextExpression` — the save-time gate `FormEditor` calls — returns `[]`
on the corrupted output (I confirmed this myself), the output compiles under `new Function`, and the
corruption is **idempotent**, so a parse→serialize→parse stability test passes on it. Every guard we
have says this is fine.

### 8. 🔴 `removeHelper` mangles a call site, not the export — 30 of 37 helpers
`removeExport()` does a single unanchored `src.replace()` over the **whole file** after deleting the
declaration, so it hits the first surviving occurrence — usually a *call*, not the export entry.
15 of 22 exported helpers additionally leave a dangling identifier in `module.exports`, which throws
at `require()` time. In CHT that means contact-summary fails to evaluate at all: **every contact
profile renders empty, all 7 `summary.*` flags become `undefined`, and the pregnancy / delivery /
cervical / breast-cancer-followup forms disappear from every CHW device.**

Latent today **only** because of #9.

### 9. 🟠 The extras file is invisible — filename mismatch
The editor hardcodes `contact-summary.extras.js` (dot). NSSD — and the cht-conf convention — uses
`contact-summary-extras.js` (hyphen); `contact-summary.templated.js:2` is
`require('./contact-summary-extras')`. So 34 KB and 50 callables are invisible: the Helpers tab is
empty, the appliesIf helper picker's optgroup is empty, and **"+ New helper" writes a phantom file
nothing ever loads.**

This is a P1 in isolation but it is load-bearing: **it is the only thing currently preventing #8
from firing.** Fixing the filename *before* fixing `removeHelper` would arm a live grenade.

### Also P0-adjacent
- **Hierarchy: no save is ever a no-op.** It injects `create_form` into the two staff person types
  that deliberately omit it (making them creatable in CHT), and *any* detail-panel edit — one
  character in "Display name" — re-derives `place_hierarchy_types` and appends `c80_household`.
- **Translations: duplicate keys written to the wrong occurrence.** `updateProperty` writes the
  **first**; cht-conf 6.0.2 reads the **last**. 113 real keys affected (7 en + 106 ne). The edit is
  invisible to CHT *and* destroys the shadowed line. The code comment asserting the opposite is wrong.
- **`renameSurveyRow` misses 37 `${}` references** in this config, all resolving to real rows — a
  rename leaves them dangling and **pyxform hard-fails the entire config conversion.**

---

## What is genuinely safe — measured, not assumed

- **Opening the project.** All 6 open-path files and all 5 `REQUIRED_FILE_PATHS` present. Nothing
  recurses into `node_modules`. Forms listing is junk-free in 8.4 ms. Cold open costs 2.75 s of CPU
  (eager-parsing all 34 contact forms); warm is 0.5 ms.
- **survey + choices sheets — the part the UI actually edits.** Header arrays **byte-identical on
  70/70 forms**, including every locale variant. Zero data rows lost anywhere. All unknown columns
  (`relevant`, `appearance`, `calculation`, `choice_filter`, `constraint`, `instance::cht:unique_tel`,
  `cht::notes`, `media::image::en/ne`, …) preserved. **This is the invariant holding.**
- **`tasks.js` structure.** 29/29 entries parsed, 29/29 pristine, no-op rebuild **byte-identical**
  (I re-ran this). Editing a task's name/icon/title, deleting, reordering, or appending all leave
  the other 28 entries **semantically bit-perfect**. The `b0278b3` per-entry splice holds at real
  scale. *The damage in #3–#6 is in the sub-parsers, not the splice layer.*
- **`base_settings.json` formatting.** Already byte-for-byte `JSON.stringify(parse(raw), null, 2)`;
  `roles`, `permissions` and 24 of 27 top-level keys provably untouched by a hierarchy write; key
  order preserved; `contact_types` model covers **100%** of the properties present (0 unmodelled).
- **Translations at scale.** Byte-identical no-op on both files; **0 failures across 4,024 per-key
  edit simulations**; escaped spaces, tabs, trailing whitespace, blank lines, the malformed
  `[Home visit]` line — all preserved. Fast (11 ms parse of the 280 KB file). The duplicate-key bug
  is the one real defect.
- **`targets.js`.** **Zero write paths anywhere in the editor** — confirmed by enumerating every
  `fs.writeFile`/`fs.rename` in `server/src`. It cannot be damaged.

## Cosmetic / low-priority, recorded and parked
`choices-backup` inflated 63 → 1000 rows on 7 forms (+20% file size); settings sheet rebuilt from a
template (2nd data row dropped on 15 forms, column order rewritten on 69); 330 interior blank rows
removed across 42 files; 459 rich-text cells flattened; one CRLF→LF non-idempotence
(`diabetes_screening`); trailing-comma churn on 6 task entries; `place-types.json` reformat;
properties.json rewritten whole on every save; `title[]` array reordered by a label rename.

## Two things that block *the tool*, not the config
- **Deploy panel "Select changed" always reports zero.** The git root is `W:/medic/config-nssd` but
  the project root is `.../chis`, so `git status --porcelain` emits `chis/forms/app/x.xlsx` while
  `parseGitPorcelain` requires `^forms/(app|contact)/`. 1 changed file on disk, 0 detected.
- **Preflight reports 20 blocking errors, all false positives** on 3 forms (`pnc_service_form` 15,
  `pregnancy_home_visit` 3, `become_sessions` 2) — pyxform already compiled all of them. The deploy
  button is gated on this count. 18 are leading/trailing whitespace in a `name` cell; **2 are literal
  dots** (`misessI_step3.1`), so a trim-only fix leaves the button blocked.

---

## Why our own guards missed all of this

Every one of these ships through the full gate: `runPreflight` passes, `validateContextExpression`
returns `[]`, `compile-app-settings` passes, `npm test` passes, and — for #7 — even a
**parse→serialize→parse byte-stability test passes, because the corruption is idempotent.**

This is the fifth instance of the pattern in
[`feedback_roundtrip_tests_must_call_serializer`](../../CLAUDE.md): *the test input was already in
the shape the code assumed*. `isAlive(contact.contact)` **is** the CHT-standard convention — the
parser's own header comment documents it — and every fixture we ever wrote used it. NSSD doesn't,
and nothing told us.

**The standing rule this adds:** a serializer that emits a *convention* rather than preserving the
*input* must capture the input as an argument. "The CHT standard shape" is a default, never a
rewrite target.
