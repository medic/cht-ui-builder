<!--
Dev handoff. Pointing the editor at config-nssd — a real deployed national config — surfaced nine
P0s that our entire gate (preflight, validators, compile, npm test, even round-trip stability)
passes clean. This replaces the previous product-fix order. 2026-08-11.
-->

# Handoff — the config-nssd safety batch

**Why this jumped the queue.** We pointed the editor at `medic/config-nssd` (36 app forms, 34 contact
forms, 29 tasks, 8-level hierarchy, 425 KB of translations, deployed nationally) and measured. Nine
P0-class defects **silently corrupt it**. Six fire on **open-a-panel-and-save with zero edits**.
Every one produces valid, compiling, deployable output.

Full evidence, per-file counts and reproduction commands:
[`reviews/nssd-initial-assessment-2026-08-11.md`](reviews/nssd-initial-assessment-2026-08-11.md).
Three of the worst were independently re-verified by the planner and reproduce exactly.

**This replaces the previous order.** The old #1 (`cht-default` won't compile) drops out — it's a
scaffold problem, and we are no longer scaffolding. The old #5 (`P1-LOCALE-SEAT`) rises, because
"imported config" stopped being hypothetical.

> ## ⚠️ Read [`principle-config-agnostic.md`](principle-config-agnostic.md) before starting
> **These are not "NSSD fixes."** NSSD was just the first real config we opened; every finding is a
> place where **we hardcoded one project's convention and called it the standard.** Measured across
> the four real configs on disk, they disagree with each other on almost everything we hardcoded:
>
> - `isAlive(contact.contact)` — the shape we always emit — is used by **1 of 4** configs. Two use
>   `isAlive(contact)`. Both are correct CHT.
> - The extras filename is `contact-summary.extras.js` in gandaki and lumbini, `contact-summary-extras.js`
>   in nssd. **Both must work.**
> - Our generated task-title key is hyphenated; **0 of 42 real title keys across three configs
>   contain a hyphen.** It matches only our own scaffold.
> - Duplicate translation keys exist in **all four**. The project root sits below the git root in
>   **3 of 4**. moh-nepal runs **seven locales**.
>
> **So the acceptance test for every fix below is: "is this also correct in the other three configs?"**
> Emitting `isAlive(contact)` instead would fix nssd and lumbini and **break gandaki** — that's not a
> fix, it's a different hardcode. Preserve what you read; derive what you write; refuse what you
> can't model.

---

## Batch A — corruption on read/no-op-save. Nothing else ships first.

Ordered by **damage ÷ effort**. A1 is one expression and kills three findings.

### A1 — Read formula results off the Cell, not off `cell.value`
`shared/src/xlsform/parse.ts`, `readRow()`.

exceljs's `FormulaValue._copyModel` tests the cached result for truthiness
(`const cp = name => { const value = model[name]; if (value) copy[name] = value }`), so a `false`
result is **stripped from `cell.value`**. `cellToString` then falls through to
`if ('formula' in v) return f.formula` and returns the **source text**.

```ts
const cell = excelRow.getCell(c);
cells.push(cell.type === ExcelJS.ValueType.Formula
  ? (cell.result == null ? '' : String(cell.result))
  : cellToString(cell.value));
```

Kills three findings at once:
- **19 of 34 contact forms**: `relevant` `=FALSE()` → `"FALSE()"` → pyxform emits
  `relevant="FALSE()"`, an undefined XPath function. Verified against pyxform 4.5.0 and against the
  committed `.xml` (`relevant="false()"`).
- **10 app forms**: `settings.version` `=NOW()` → `"Fri Feb 13 2026 04:43:23 GMT+0545 (Nepal Time)"`.
  Needs a `Date` branch too — emit the Excel-serial-preserving form, not `String(Date)`.
- **7 forms**: 14 `choices-backup` cells getting raw formula source in the `name` column.

Also in `readRawSheet`: iterate `includeEmpty: false` (or stop at `ws.actualRowCount`) — it currently
inflates `choices-backup` from 63 to 1000 rows.

**Test:** a fixture with a formula cell whose cached result is `false`, one whose result is a `Date`,
and one truthy. Assert on the *emitted cell*, not just idempotence — idempotence passes today.

### A2 — `serializeAppliesIf` must not invent the helper argument
`shared/src/tasks/appliesIfParser.ts:25-26`, `:565-566`, `:839`, `:843`.

The rule model has no `args` for `is_alive`/`is_muted`; the parser discards the real argument and the
serializer hardcodes `contact.contact`. NSSD's helper takes the task-engine wrapper, so
`isAlive(contact.contact)` looks for `contact.contact.contact.date_of_death` and
`contact.contact.reports` — both `undefined`. **`isAlive` always true, `isMuted` always false: 25–26
of 29 tasks start firing for dead and muted patients.**

Add `args` to `{kind:'is_alive'|'is_muted'; negated}` exactly as the generic `helper` rule already
has it; capture `fn[2]` at `:565-567`; emit `isAlive(${rule.args})`.

> **The rule this establishes:** a serializer that emits a *convention* rather than preserving the
> *input* must capture the input as an argument. `isAlive(contact.contact)` **is** the CHT-standard
> shape — the parser's own header comment says so, and every fixture we wrote used it. That is
> exactly why we never caught it.

### A3 — `serializeAppliesIf` must refuse to emit what it can't represent
Same file. Two shapes:

- **Dropped declarations (4 tasks).** Every `const`/`let` is discarded while the expressions
  referencing them are kept → valid JS that throws `ReferenceError` in the rules engine, per contact.
  `pnc_service_after_delivery` L513, `anxiety_session_1` L750, `depression_session_1` L809,
  `motivational_interviewing` L872.
  **`parsed.hasRawFallback` is already `true` on all four.** The parser detects this correctly; the
  serializer never reads the flag. This is a gate, not new parsing.
- **Bare function reference (2 tasks).** `appliesIf: someHelper` serializes to a function that
  **returns** the helper instead of calling it → unconditionally truthy →
  `mental_health.mental_health_referral_followup` and `cervical_cancer.referral_followup` fire for
  **every matching report on every patient.**

Per the all-or-nothing rule in `ir-serializer-contract.md` §4: **partial recognition of a JS body
must be all-or-nothing per body.** If the rule set doesn't account for every statement, emit the
original bytes.

### A4 — `parseResolvedIf` must match exactly, not by substring
`shared/src/tasks/` (resolvedIf parser). It classifies a body as the canonical pattern on
`indexOf('isFormArraySubmittedInWindow')` over the whole text, then replaces the **entire**
hand-written body with a template — 7 tasks.

The template drops the CHT-canonical `Math.max(..., report.reported_date + 1)` **start clamp**, so a
**stale prior report pre-resolves the task and the CHW never sees it.**

Require a single return statement whose callee is that identifier. Anything else → `{kind:'raw'}`,
which already round-trips.

### A5 — `serializeContextExpression` must preserve parentheses
`shared/src/tasks/contextExpressionParser.ts` — `classify()` strips outer parens with
`e.trim().replace(/^\((.*)\)$/, '$1')` and `ruleToSource()` case `'raw'` returns `rule.text` bare.

`A && (B || C) && D` → `A && B || C && D`. **11 of 24 app forms flip eligibility**, every flip
false→true: deceased and muted contacts become eligible for pregnancy, delivery, child-health,
mute/unmute and 7 more.

Keep the operand's original text verbatim in the raw rule, or re-wrap when it contains `||`.

> **`validateContextExpression` returns `[]` on the corrupted output** (planner-verified), it
> compiles under `new Function`, and the corruption is **idempotent** — so a parse→serialize→parse
> stability test passes on it. Every guard we own says this is fine. The regression test must assert
> **semantic equivalence over a contact space**, not string stability.

### A6 — `removeHelper` / `renameExport`: scope the replace to `exportsBounds`
`shared/src/tasks/helpersParser.ts`, `removeExport()`. A single unanchored `src.replace()` over the
whole file lands on the first surviving occurrence — usually a **call site**. 30 of 37 helpers get a
call corrupted; 15 of 22 exported ones leave a dangling identifier in `module.exports` → **throws at
`require()`** → contact-summary fails entirely → every profile blank, all 7 `summary.*` flags
`undefined`, and pregnancy/delivery/cervical/breast-cancer forms **vanish from every device.**

`renameExport()` has the identical bug.

### A7 — 🔒 Do **not** fix the extras filename until A6 lands
The editor hardcodes `contact-summary.extras.js`; NSSD (and cht-conf) uses
`contact-summary-extras.js`. That mismatch is the **only** reason A6 is latent today. Fixing the
filename first arms it.

Once A6 is in: discover the name — read the `require('./X')` specifier out of
`contact-summary.templated.js`, or probe both spellings in `server/src/routes/contactSummary.ts`.
Also fix `patchHelper` while you're there (fails identity round-trip on **37/37**; `declStart` is
`m.index + m[1].length` after `\s*` already ate the separating newline, and the rebuilt decl adds
newlines the body already carries) — and drop the branch that **appends 15 internal helpers to
`module.exports`** on a no-op body edit.

### A8 — Hierarchy: stop making unrequested semantic changes
`server/src/routes/hierarchy.ts:103-108` unconditionally injects `create_form` into the two staff
person types that deliberately omit it. And `HierarchyEditor.tsx:289/361` re-derives
`place_hierarchy_types` on **every** detail-panel control — one character in "Display name" appends
`c80_household`.

Gate the backfill to types the session actually created; restrict `deriveHierarchyOrder` to the
`parents`/`person` mutations and seed it so ids absent from the on-disk array are never added
silently.

### A9 — Translations: write the **last** duplicate, not the first
`updateProperty` targets the first occurrence; cht-conf 6.0.2 (npm `properties`) reads the **last**.
113 real keys (7 en + 106 ne). The edit is invisible to CHT *and* destroys the shadowed line. The
code comment asserting the opposite is factually wrong — fix it too. Make
`TranslationsEditor.valuesByKey` last-wins and surface duplicates as an explicit warning.

### A10 — `renameSurveyRow` misses 37 `${}` references
All 37 resolve to real survey rows in this config, so a rename leaves them dangling and pyxform
**hard-fails the entire config conversion**. The rename macro is the one place we promised
rewrite-all-refs (`decision_nocode_names_autoderived`) — it needs the same reference extractor the
dependency map uses.

---

## Batch A′ — 🔴 emission must survive the project's own lint (added 2026-08-12, from the geriatric-into-NSSD build)

**Nothing the tool authors can ship to a lint-enforcing config today.** `compile-app-settings` runs
the project's own `@medic` ESLint, and the serializer's `tasks.js` output failed it with **16
errors** — the deploy did not run at all until a human reformatted the file. Evidence:
[`reviews/nssd-geriatric-build-2026-08-12.md`](reviews/nssd-geriatric-build-2026-08-12.md) §1.

- `indent` ×13 — bodies emitted at 0/2/8 spaces where this config requires 4/6
- `brace-style` ×2 — `if (…) { return false; }` collapsed onto one line
- `no-unused-vars` ×1 — `modifyContent: function (content, contact, report, event)`; we always emit
  the four-arg signature even when `event` is unused

**Fix shape:** emit in the style of the file we parsed — infer indent width/unit from the existing
entries and match brace style — or run the project's own `eslint --fix` over the touched byte range
after splicing. And **omit unused trailing parameters** (emit the shortest signature the body
actually uses). Prefer inference over a hard-coded 4/6: the point is *the project's* style, not a
new default of ours. Round-trip test must pin the emitted indentation against a 4-space fixture.

> **⚠️ This reclassifies the "Parked, cosmetic" list below.** We parked *"trailing-comma churn on 6
> task entries"* and the other formatting churn as **"confirmed harmless at NSSD scale."** That
> judgement was wrong in one specific way: **formatting is not cosmetic on a config with a lint
> gate — it is deploy-blocking.** Re-read every parked formatting item through that lens. The
> corruption items in Batch A are worse because they are *silent*; this one is merely *loud* — but
> loud-and-blocking still means nothing ships.

**Ordering note.** QA's suggested order puts this first; this doc puts Batch A first. Both are
right from their own lens and they don't actually conflict: **Batch A stops silent damage to a
deployed national config, which outranks a loud, obvious failure.** But A′ is small, fully
independent of A, and without it *nothing authored in the tool reaches NSSD at all* — so it should
ride along with A rather than queue behind it.

## Batch B — unblocks the geriatric task (start after A2–A4)

### B1 — `modifyContent` must emit an access that exists
`report.<field>` appears **0 times** in 4,000+ lines of NSSD rules code. Emit
`Utils.getField(report, '<full.group.path>')` (29 uses in `tasks.js`, the dominant form) or
`report.fields.<name>` (10 uses in `nools-extras.js`). `Utils` is a **global** in `tasks.js` — no
import. Pin the emitted string in a round-trip test; this class has bitten us before.

### B2 — The receiver-node affordance (W3/W4)
Unchanged from [`handoff-task-to-form-handoff-2026-08-08.md`](handoff-task-to-form-handoff-2026-08-08.md),
now with NSSD's real target shape: the newest convention (hypertension, diabetes, become,
pnc_referral — 12 of 20 working keys) is a **top-level `hidden` row carrying `instance::tag = hidden`**,
named `<source_field>_ctx`, placed after the `patient_uuid`/`patient_id`/`patient_name` calculates.
The older shape (8 keys) is a `hidden` row *inside* the `inputs` group. Support the top-level one.

`nools-extras.js:394-403` builds the names mechanically —
`store[\`${key.slice(key.lastIndexOf('.') + 1)}_ctx\`] = Utils.getField(report, key)` — so
`deriveHarvestName` should match that.

### B3 — `parseActions` can't read a non-string `form`
It blanks the value in the model and shadows it in extras; `serializeActions` then emits **both**,
producing a duplicate object key. The picker shows empty, a user's form change is silently discarded,
and the output fails NSSD's own lint gate.

### B4 — `deriveTaskTitleKey` should follow the project, not cht-default
It emits hyphenated kebab + `.title`. **0 of 29** NSSD task names and **0 of 29** title keys contain
a hyphen; 13/29 are exactly `'task.' + name`. Seed the derivation from the project's dominant shape.

---

### B5 — Detect imperatively-built contact-summary context (added 2026-08-12)
The cross-form calculation picker lists only keys it can parse from a structured
`context: { … }` literal. **NSSD assembles context imperatively** (`getContext()` →
`context.previous_bmi_ctx = …`), so the picker showed **zero** keys and all three had to be typed
into the raw editor — a hand-typed identifier, which the no-code bar forbids. A scan found **21
usable context keys in NSSD that the tool currently reports as none.**

**Tier 1 (do this one — cheap, catches all 21):** also detect `context.<key> = …` assignments in
`contactSummaryParser`, not just the object literal. Read-only detection; no new emission path, so
no round-trip risk.

**Tiers 2–3 are a feature idea worth its own decision, not part of this batch:** (2) when connected
to an instance, execute the deployed contact-summary against a real contact and show the **actual
value** beside each key, so the author picks *"BMI → 27.6"* rather than guessing an identifier;
(3) emit into the project's house style rather than ours (same principle as **A′**). Implementation
note from QA for whoever builds tier 2: the compiled contact-summary is a **UMD bundle** and needs
global-scope sandboxing to execute.

## Batch C — tool usability on this config (small, independent)

- **`detectChangedForms` ignores the git prefix.** Repo root is `config-nssd`, project root is
  `config-nssd/chis`, so porcelain emits `chis/forms/app/x.xlsx` and the `^forms/(app|contact)/`
  regex never matches. "Select changed" reports **zero, always**. Fix: strip
  `git -C <projectPath> rev-parse --show-prefix`, or use `status --porcelain --relative`.
  (`server/src/routes/forms.ts:321-365`)
- **Preflight: 20 false-positive blocking errors** gate the deploy button. 18 are leading/trailing
  whitespace in a `name` cell (trim before the identifier regex, as pyxform does); **2 are literal
  dots** (`misessI_step3.1`) — a trim-only fix leaves the button blocked.
- **`maintainFormConstants` writes the wrong shape**, non-atomically. It emits
  `MY_NEW_FORM: ['my_new_form']` into a map whose 32 entries are `lowercase: 'string'`. Detect the
  existing shape; route through the tmp+rename helper the other writers use.
  (`server/src/routes/forms.ts:217-267`)
- **`PLACE_TYPE-*.xlsx` are cht-conf templates, not contact types.** They're parsed as real forms and
  **win the last-write-wins merge** in `contactFieldChoices`, so the condition builder offers
  `caste_code` values that don't exist (`brahmin_chhetri`/`unknown` offered, `brahmin`/`chhettri`
  hidden) — a rule authored from the picker never matches at runtime.
  (`server/src/routes/project.ts:82-133`)
- **14 of 34 contact forms are gitignored build output** the editor lists as first-class editable.
  Badge them from `git check-ignore`.
- **Cold open costs 2.75 s** eagerly full-parsing all 34 contact forms in `describeProject`. Make
  `scanContactFieldChoices` lazy.

---

## Parked, still (cosmetic — confirmed harmless at NSSD scale)
Settings-sheet column reorder and dropped 2nd data row; 330 interior blank rows removed; 459
rich-text cells flattened; one CRLF→LF non-idempotence (`diabetes_screening`); trailing-comma churn
on 6 task entries; `place-types.json` reformat; whole-file `properties.json` rewrite on save;
`title[]` reorder on a label rename; `.properties` EOF newline; `choices-backup` row inflation once
A1 lands.

## What still holds — don't regress it
survey/choices headers byte-identical **70/70**; zero data rows lost anywhere; `tasks.js` no-op
rebuild **byte-identical** with 29/29 entries pristine and single-edit drift **zero** (the `b0278b3`
splice holds at real scale); `base_settings.json` formatting and 24 of 27 keys untouched;
`contact_types` model covers **100%** of NSSD's properties; translations **0 failures in 4,024**
per-key edit simulations; `targets.js` has **zero write paths**.
