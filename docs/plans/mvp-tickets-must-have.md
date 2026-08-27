<!--
Ready-to-file tickets for every MUST-HAVE feature in the final tech design
("No Code CHT Configuration - Requirements & Design", rev 2, Feature Importance column).
One ticket per feature; paste-ready into GitHub Issues or Jira. 2026-08-27.
-->

# MVP tickets — must-have features

**Source:** *No Code CHT Configuration — Requirements & Design* (rev 2), using its own
**Feature Importance** column.

| Importance | Features | Tickets here |
|---|---|---|
| **Must have** | F1, F2, F3, F4, F5, F6, F9, F14, F15 | 9 |
| **Must start** | F16 | 1 |
| Stretch | F7, F8, F10, F11, F12, F13, F17 | — not ticketed |

**Ten tickets.** Each carries what a developer needs to start without re-reading the design doc:
why it exists, what is already built, the remaining work as a checklist, explicit non-goals,
testable acceptance criteria, and dependencies.

**Two conventions used throughout:**
- Every ticket states **what is already done**, because most of these features are partly built and
  the risk is rebuilding working code.
- Acceptance criteria are **assertable on disk or on a live instance**, not "looks right" — this
  project has repeatedly had green tests over broken output.

---

## T1 · F1 — Form editor: complete the restricted safe edit subset

**Importance:** Must have · **Size:** S · **Depends on:** nothing

**Why.** The design doc's Phase-1 core: a non-developer edits labels, hints, choices, required
flags, images and question order through a rendered view, and never sees XLSForm rows or JSON.

**Already built (do not rebuild).** Labels, hints, choices (add/edit/reorder with auto-derived
names), required toggle, dependency-guarded reordering, add/remove questions, sections and groups,
the 9-category typed palette including the Bikram Sambat picker, Simple vs Full mode, plain-language
column wrappers, and per-question `media::image`. An existing Playwright spec drives all of this
green.

**Remaining work.**
- [ ] **F1.10** — expose the CHT-only palette filter. The `chtOnly` flag already exists per tile;
      confirm the control is reachable in the UI, and add it if not.
- [ ] **F1.14** — audit Simple mode for leaks of internal concepts. Known: the generated-JS preview
      is always visible. Sweep for others (raw column names, XPath, JSON) and gate them behind Full.
- [ ] **F1.15** — add an explicit guard preventing variable-name edits, with a message explaining
      why (renaming mid-collection breaks the meaning of longitudinal data).

**Not in scope.** Anything that changes what the editor can express — this ticket only closes the
three gaps above.

**Acceptance.**
1. A user completes a label, choice, required-flag and image edit in Simple mode and **never sees**
   an XLSForm column name, XPath expression, JSON, or a variable name. Verified by walking the
   Simple-mode surface, not by inspection of intent.
2. The palette can be narrowed to CHT-supported types from the UI.
3. Attempting to edit a variable name is refused with an explanatory message.

---

## T2 · F2 — Edit beyond the sheet: properties, resources, translations

**Importance:** Must have · **Size:** M · **Depends on:** nothing (F2.7 depends on F2.6)

**Why.** The design doc is explicit: *"icons and logos live in form properties and resources, not
the XLS, so the tool edits `properties.json`, `resources.json`, and translation files, and keeps
them consistent with the sheet."* Icons are the single largest untouched surface in Phase 1 — and
CHT's own docs list `icon` as **required** in `properties.json`.

**Already built.** Per-locale form title, form eligibility via a visual rule builder, the
translations key × locale grid with missing-cell markers, and one-click add-a-language (which
correctly extends the survey **and** choices headers and creates the `.properties` file).

**Remaining work.**
- [ ] **F2.5** — create a *new* translation key. Today the screen only edits keys already on disk,
      which blocks bilingual task titles. Offer a grouped suggestion list: keys the config
      references but no file defines; then CHT naming conventions filled in with real project names
      (`task.<name>.title`, `targets.<id>.title`, `contact.type.<id>`); then CHT core keys; then
      validated free text. *(In flight — check current state before starting.)*
- [ ] **F2.6** — pick an icon from a list instead of typing an id.
- [ ] **F2.7** — a `resources.json` editor with image upload, maintaining the key → file map.
      [needs F2.6]
- [ ] **F2.8** — a preflight check that sheet, properties and translations stay consistent.
- [ ] **F2.9** — media hygiene: a delete path, and a warning for an orphaned or missing image file.

**Not in scope.** Per-question media beyond `media::image`; translating anything outside
`.properties` files.

**Acceptance.**
1. A user sets a form's icon by **choosing** it, uploads the image behind it, and the deploy carries
   both — confirmed by the icon rendering on a live instance.
2. A brand-new translation key is created in-app, written into **every** locale file, and used as a
   task title that renders translated on a device.
3. Unknown keys and comments elsewhere in the `.properties` files are preserved byte-for-byte.

---

## T3 · F3 — New simple linear form + persona assignment

**Importance:** Must have · **Size:** M · **Depends on:** F3.3 before F3.4

**Why.** Two stated acceptance criteria live here: *"an MOH/partner team can add a simple linear
rapid-response form (e.g. the four-question flood survey) and assign it to a persona, themselves"*.
Form creation works; **persona assignment does not exist at all.**

**Already built.** Label-first form creation (human title → slugified id, with `form_title` keeping
the readable title) and the canonical `inputs` plumbing scaffold.

**Remaining work.**
- [ ] **F3.3** — declare `inputs/contact/name` in the scaffold. **Deploy blocker:** 55 of 56 real
      app forms across three configs reference it, CHT provides it by default, and
      `validate-app-forms` fails the **entire run** — every form and the settings — when a
      reference dangles. One `hidden name` row under `inputs/contact`.
- [ ] **F3.4** — make the contact-field reference picker emit a resolvable path. It currently writes
      the reference half without declaring the node. Declare on demand for config-specific fields.
      [needs F3.3]
- [ ] **F3.5** — walk the four-question rapid-response case end to end and fix what it hits.
- [ ] **F3.6** — **assign a form to a persona/role.** Nothing edits roles today. Needs either
      `context.permission` in `properties.json` or a user-based rule kind in the eligibility
      builder, **plus** a surface for the `permissions` map in `app_settings`.
- [ ] **F3.7** — whole-form visibility per role, driven by F3.6.

**Not in scope.** Per-question role visibility (the design doc puts it out of MVP). Branching forms.

**Acceptance.**
1. A four-question linear form is created, assigned to a persona, and deployed **without a
   developer** — and appears for that role and not others on a live instance.
2. Inserting the patient's name into a label produces a form that **passes**
   `cht convert` / `validate-app-forms`.
3. Preflight fails, with a clear message, on any `../inputs/*` reference whose node is not declared.

---

## T4 · F4 — Basic hierarchy

**Importance:** Must have · **Size:** S · **Depends on:** D9 for F4.6

**Why.** The design doc calls hierarchy *"good to have"*, but it is a hard prerequisite: without
contact types there is no subject to attach a report to, no surface for a form to appear on, no
"+ New person" button, and no replication to the device.

**Already built.** The guided levels-and-roles creator, writing `contact_types` and
`place_hierarchy_types` without disturbing the rest of `base_settings.json`, `place-types.json`
maintenance, `create_form`/`edit_form` on person types, and leaf-detail editing via contact forms.

**Remaining work.**
- [ ] **F4.6** — stop making unrequested semantic changes on save. Two known: `create_form` is
      injected into staff person types that deliberately omit it, and `place_hierarchy_types` is
      re-derived on **any** keystroke in the detail panel. Gate the backfill to types created in
      this session. [see D9]

**Not in scope.** Complex restructuring — splitting a district, adding a level or region — is
explicitly out of MVP.

**Acceptance.**
1. Editing one character of a hierarchy display name produces a diff containing **only** that
   change. Asserted with `git diff` against a real config.
2. A three-level hierarchy plus one person type is created through the guided flow, deploys, and the
   "+ New \<person type\>" button appears in CHT.

---

## T5 · F5 — Basic contacts

**Importance:** Must have · **Size:** S · **Depends on:** nothing

**Why.** Contact create/edit forms per type are what make people addable at all — the design doc
lists household, household member and CHW as the baseline.

**Already built.** The batch generator producing minimal-valid create/edit forms per type,
regenerate-with-diff-and-confirm, the corrected meta XPath hop count, the same restricted edit
subset as app forms, and correct `<type>-create.xlsx` naming with hyphens preserved.

**Remaining work.**
- [ ] **F5.6** — stop `PLACE_TYPE-*.xlsx` cht-conf templates being parsed as real contact forms.
      They currently win a last-write-wins merge into the contact-field choice map, so the condition
      builder offers values that do not exist at runtime — a rule authored from the picker then
      never matches.

**Not in scope.** Bulk contact import (that is cht-conf's `csv-to-docs`).

**Acceptance.**
1. The contact-field picker offers **only** values that exist in the real contact forms, verified
   against a config containing `PLACE_TYPE` templates.
2. A generated contact form deploys and a contact can be created and edited on a live instance.

---

## T6 · F6 — Basic task creation

**Importance:** Must have · **Size:** M · **Depends on:** F2.5 for F6.8; D8 for F6.10

**Why.** *"Basic task creation: create simple single-person tasks, for example a follow-up in N
days, composed safely with existing task rules and with a computed identity so re-running the rules
never duplicates a task."* The whole loop has been proven live; two seams still need a human.

**Already built and proven on a real config.** Creating a task appended to a 1050-line hand-written
`tasks.js` without disturbing it, the trigger form and `appliesToType`, the condition builder
(including "any of" for multi-selects and or/and connectors), the start/due/end window with a
date-anchor picker, the resolution picker, the open-a-form action, and a computed task identity
derived from the project's own convention.

**Remaining work.**
- [ ] **F6.8** — bilingual task titles. Both `.properties` files are written already; blocked only
      on key creation. [needs F2.5]
- [ ] **F6.9** — the task → form hand-off. Receiving nodes land in `inputs/user/` where CHT cannot
      bind content, and the mapping picker emits `report.<field>` where the runtime needs
      `report.fields.<field>`. Also: switching one mapping row to custom currently resets it and
      makes the whole table read-only, so the raw escape is the only working path.
- [ ] **F6.10** — emit in the project's own lint style. **Deploy blocker:** the project's ESLint
      rejected our `tasks.js` with 16 errors and nothing deployed until a human reformatted.
      Infer indent width and brace style from the file we parsed — do not hard-code ours — and omit
      unused trailing parameters. [see D8]

**Not in scope.** Multi-visit temporal tasks and group/household tasks are out of MVP.

**Acceptance.**
1. A single-person follow-up task is authored, given a bilingual title, deployed with the project's
   own cht-conf command at **exit 0 with no hand-editing**, and appears on a device with the
   translated title.
2. Tapping it opens the target form **carrying the delivered values**, and those values are present
   in the submitted report on the instance — not merely visible in the UI.
3. Re-running the rules does not duplicate the task.

---

## T7 · F9 — Safety tests: synthetic patients

**Importance:** Must have · **Size:** L · **Depends on:** nothing; F9.5 pairs with the F8 preview

**Why.** A stated acceptance criterion, and the design doc's main safety promise: *"run synthetic
cases through the old and new form so an edit that should not change clinical logic produces
identical outcomes."* This is the mechanism that makes non-developer editing defensible clinically.

**Already built.** The preflight validator (required files, identifier validity, XPath hop counts,
empty choice lists, dangling references).

**Remaining work.**
- [ ] **F9.1** — define the synthetic-patient case format. Foundation for everything below.
- [ ] **F9.2** — run one case through the old and new form and diff the outcomes. [needs F9.1]
- [ ] **F9.3** — a "no clinical change" gate on an edit, wired into save or deploy. [needs F9.2]
- [ ] **F9.4** — accumulate cases per revision, so behaviour changes only when clinical rules do.
- [ ] **F9.5** — the workflow simulator: a sample contact plus reports in, and out comes which
      forms become available, which tasks fire, and what the contact summary computes.
- [ ] **F9.7** — a `validate-app-forms` / pyxform leg in CI. **This is the only check that catches
      a dangling XPath**, and its absence is why an undeployable form shipped past nine green tests.

**Not in scope.** A full clinical test-authoring UI. Cases can start as files.

**Acceptance.**
1. Editing a label produces **identical** synthetic-patient outcomes; editing a `relevant`
   expression produces a **reported difference**.
2. CI fails on a form with a dangling XPath reference.
3. The case corpus grows with each revision and old cases keep passing unless a clinical rule
   changed.

---

## T8 · F14 — Round-trip & determinism

**Importance:** Must have · **Size:** M · **Depends on:** the D-list defects

**Why.** Two acceptance criteria: *"a form with hand-authored columns round-trips through the
builder without losing them"* and *"regenerated artifacts must be deterministic: the same edit
produces the same XLSForm/XForm."* **Both are currently false for the JavaScript surfaces** — which
is what makes this a must-have rather than hygiene.

**Already built.** Unknown columns and sheets preserved verbatim with extras rewritten in their
original positions; pyxform and cht-conf reused with no parallel compiler.

**Remaining work.**
- [ ] **F14.2 / F14.3** — close the defects that break losslessness and determinism on the JS
      surfaces. See the D-list in the breakdown; the load-bearing ones are **D1** (reads a formula's
      source instead of its result — 19 of 34 contact forms), **D3** (emits a body it only partly
      parsed), **D5** (drops parentheses, flipping eligibility on 11 of 24 forms, every flip
      false→true), **D6** (unscoped find-and-replace), **D7** (writes the first duplicate
      translation key where CHT reads the last), **D8** (own formatting, not the project's).
- [ ] **F14.5** — commit the hostile / non-canonical fixture corpus. It exists but is untracked.
- [ ] **F14.6** — move cross-sheet and cross-locale logic into `shared/` as pure functions. Standing
      rule: logic buried in a React handler is untestable by construction, which is how one
      corruption bug reached production with a fully green suite.

**Not in scope.** Decompiling arbitrary hand-written forms into the builder's own grammar — the
design doc rules that out.

**Acceptance.**
1. Open-a-panel-and-save with **zero edits** on each of the four real configs produces an **empty
   `git diff`**.
2. The same edit applied twice produces byte-identical output.
3. Round-trip tests exercise the **serializer** over **non-canonical** fixtures — fixtures written
   by a raw xlsx writer, never by our own serializer, which canonicalises and hides the bug.

---

## T9 · F15 — Complex logic: calculation / relevant / constraint

**Importance:** Must have (Phase 2, **already ~90%**) · **Size:** S · **Depends on:** nothing

**Why.** The design doc places this in Phase 2, but the POC shipped it. This ticket is the small
remainder plus a verification pass — **not a build.**

**Already built.** Visual builders for `relevant`, `constraint`, `choice_filter` and `calculation`,
with plain-language wrappers, if-then decision tables, cross-form references, and a raw escape that
preserves unparsed text verbatim.

**Remaining work.**
- [ ] Wire the choice-value dropdown into the last un-wired builder mount (the calculation builder's
      if-then condition editor), so values are never hand-typed there.
- [ ] Verify the raw-escape contract holds: an expression the builder cannot represent must survive
      a no-op open and save **byte-identically**.
- [ ] Add QA coverage. This is the largest feature in the MVP with **no automated coverage at all**.

**Not in scope.** Nested condition grouping beyond one level — **decided: keep as is.** One level
(`A and (B or C)`) covers every case in the real specs, and deepening it multiplies the
polarity/precedence surface in the module that has produced the most corruption bugs.

**Acceptance.**
1. Every value in every condition builder can be **picked**, never typed.
2. An unrepresentable expression round-trips byte-identically.
3. A Playwright spec drives all four builders and asserts the emitted cells on disk.

---

## T10 · F16 — AI-assisted authoring (must **start**)

**Importance:** Must start · **Size:** L (spike first) · **Depends on:** nothing

**Why.** The design doc allocates ~20% of the MVP to *starting* this: *"an optional step that drafts
a form or a clinical pathway from written guidelines and flags gaps, always producing an ordinary
editable form for human review. AI runs at build time only; runtime stays deterministic, and the
core builder works with no AI at all."*

**Remaining work.**
- [ ] **F16.1** — evaluate `cht-ai-tools` for overlap. Do this before building anything.
- [ ] **F16.2** — get familiar with Berkeley's tool; identify the seam.
- [ ] **F16.3** — draft-from-guidelines producing an **ordinary editable form** in the builder.
- [ ] **F16.4** — gap and consistency flagging, surfaced for human review and never resolved
      silently.
- [ ] **F16.5** — the IR crosswalk: a clinical-logic IR layered **above** our XLSForm IR and
      compiling down to it. Groundwork exists in `ir-crosswalk-levine.md`.
- [ ] **F16.6** — a free / open-model path. The design doc names this as necessary for real
      adoption, not a nice-to-have.

**Not in scope, emphatically.** Any AI at the point of care. Runtime stays deterministic; everything
AI produces is a suggestion a person approves in the builder.

**Acceptance (for the MVP's "started" bar).**
1. A written guideline produces a draft form that opens in the builder and is **fully editable**
   with no AI-specific artifacts left in it.
2. The builder works identically with AI unavailable.
3. A documented decision on the open question: **which Phase-2 track — AI pipeline or
   drag-and-drop — the squad invests in first.**

---

## Cross-ticket notes

**Sequencing.** T3's `inputs/contact/name` fix (F3.3) and T6's lint emission (F6.10) are both
**deploy blockers** — nothing the tool authors reaches an instance until they land, so they outrank
everything else in this set regardless of ticket order. T8's defect work then unblocks the two
acceptance criteria it owns.

**The QA column is the honest gap.** Nine of these ten features read **TODO** for QA State. F15 in
particular is ~90% built with zero automated coverage. Given this project's history of green suites
over broken output, treat "QA State: TODO" as a real risk marker, not a formality.

**Stretch features are not ticketed here** — F7 templates, F8 preview, F10 versioning,
F11 governance, F12 contact summary, F13 standard codes, F17 drag-and-drop. Note that F10 and F11
would additionally need an identity/roles layer that does not exist, so they are larger than their
"stretch" label suggests.
