<!--
Work breakdown for the final tech design ("No Code CHT Configuration - Requirements & Design",
2026-08-13). Follows that doc's own breakdown guidance: mark what the POC already did, keep
tasks independently testable, tag dependencies. Status is measured against this repo. 2026-08-26.
-->

# MVP feature & task breakdown

**Source:** *No Code CHT Configuration — Requirements & Design* (Draft, 2026-08-13).
**Written per that doc's own guidance:** *"Make tasks for things that might be sort of completed on
POC. Even if it's just to add a checkmark that's done… try to create independently testable
tasks… tag dependencies."*

**Status legend** — measured against this repo, with evidence, not estimated.

| Column | Value | Meaning |
|---|---|---|
| **State** | ATTEMPTED | Built by the dev — **not** yet verified by anyone |
| | PART | Partially built — the gap is named |
| | TODO | Not started |
| | OUT | Explicitly out of MVP scope per the design doc |
| **Auto QA** | ☑ / ☐ | Covered by an automated spec that drives the real UI and asserts on disk |
| **UAT** | ☑ / ☐ | A person watched it work on a live CHT instance — manual acceptance |
| both | — | Not applicable (out of scope) |

**The two QA columns are different signals and neither implies the other.** An automated spec proves the artifact lands on disk correctly; UAT proves a CHW can actually use it on a device. A row needs both before it is genuinely done.

> **The headline for planning: the POC already covers most of Phase 1, and all of what the design
> doc calls Phase 2 "complex logic".** The remaining Phase 1 work concentrates in four places —
> **preview, safety tests, versioning, and governance** — plus a platform-hardening feature the
> design doc predates (F15). Read the summary table first; it changes the sequencing.

## Summary

| # | Feature | Phase | State | Auto QA | UAT |
|---|---|---|---|---|---|
| F1 | Form editor — restricted safe edit subset | 1 | ATTEMPTED ~95% | ☐ | ☐ |
| F2 | Beyond-the-sheet: properties, resources, translations | 1 | PART ~60% — resources/icons missing | ☐ | ☐ |
| F3 | New simple linear form + persona assignment | 1 | PART ~70% — persona/roles missing | ☐ | ☐ |
| F4 | Basic hierarchy | 1 | ATTEMPTED ~90% | ☐ | ☐ |
| F5 | Basic contacts | 1 | ATTEMPTED ~85% | ☐ | ☐ |
| F6 | Basic task creation | 1 | PART ~75% — hand-off seam + lint emission | ☐ | ☐ |
| F7 | Templates & reusable building blocks | 1 | PART ~55% — blocks not started | ☐ | ☐ |
| F8 | Rendered WYSIWYG preview | 1 | TODO 0% | ☐ | ☐ |
| F9 | Safety tests — synthetic patients | 1 | TODO ~10% | ☐ | ☐ |
| F10 | Versioning: attributable & reversible | 1 | TODO ~15% | ☐ | ☐ |
| F11 | Governance: sign-off + deploy gate | 1 | PART ~40% | ☐ | ☐ |
| F12 | Contact summary (basic) | 1 | ATTEMPTED ~80% | ☐ | ☐ |
| F13 | Standard codes | 1 | ATTEMPTED ~85% | ☐ | ☐ |
| F14 | Round-trip & determinism (cross-cutting) | 1 | PART ~70% | ☐ | ☐ |
| **F15** | **Platform hardening — real-config safety** | **1** | **PART ~15% — not in the design doc** | ☐ | ☐ |
| F16 | Complex logic: calculation / relevant / constraint | 2 | ATTEMPTED ~90% **(ahead of plan)** | ☐ | ☐ |
| F17 | AI-assisted authoring | 2 | TODO 0% | ☐ | ☐ |
| F18 | Constrained drag-and-drop (BPMN-lite) | 2 | TODO ~5% | ☐ | ☐ |

---

## F1 — Form editor: the restricted safe edit subset ATTEMPTED

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F1.1 | Edit question labels | ATTEMPTED | ☑ | ☑ | Per-locale inputs on the row card |
| F1.2 | Edit hints | ATTEMPTED | ☑ | ☐ | Per-locale, incl. `constraint_message` |
| F1.3 | Add / edit / reorder choices | ATTEMPTED | ☑ | ☑ | Inline editor + Choices tab; auto-derived names |
| F1.4 | Mandatory ↔ optional toggle | ATTEMPTED | ☑ | ☐ | Row-card checkbox |
| F1.5 | Reorder questions | ATTEMPTED | ☑ | ☐ | dnd-kit, **dependency-guarded** — blocks a move ahead of a referenced field |
| F1.6 | Add / remove questions | ATTEMPTED | ☑ | ☐ | Typed palette |
| F1.7 | Sections / groups | ATTEMPTED | ☑ | ☑ | Balanced insert, nested, `field-list` toggle |
| F1.8 | Typed palette, grouped | ATTEMPTED | ☑ | ☐ | 9 categories incl. a dedicated **cht** group |
| F1.9 | Bikram Sambat picker | ATTEMPTED | ☑ | ☐ | `bikram_sambat_date` tile → `appearance: bikram-sambat-datepicker` |
| F1.10 | CHT-only palette filter | PART | ☐ | ☐ | `chtOnly` flag exists per tile; **verify the filter control is exposed** |
| F1.11 | Simple vs Full mode | ATTEMPTED | ☑ | ☐ | Simple hides logic; Full reveals advanced fields |
| F1.12 | Plain-language column wrappers | ATTEMPTED | ☑ | ☐ | "Show this question when…", "Compute the value as…", "Accept only if…" |
| F1.13 | Per-question image (`media::image`) | ATTEMPTED | ☑ | ☑ | Upload to the form-media folder, **verified against vendored cht-conf** |
| F1.14 | Never expose XLSForm rows / XPath / JSON in Simple mode | PART | ☐ | ☐ | Largely true; **audit for leaks** — the generated-JS preview is always visible |
| F1.15 | Edit variable names | OUT | — | — | Breaks longitudinal data. **Add an explicit guard** — see F15.6 |

**Independently testable:** every row is a UI action with an on-disk assertion. Existing e2e
`geriatric-build.spec.ts` drives F1.1–F1.13 green.

## F2 — Beyond the sheet: properties, resources, translations PART

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F2.1 | Edit `properties.json` title, per locale | ATTEMPTED | ☑ | ☑ | "Title (per locale)" grid |
| F2.2 | Edit form eligibility (`context.expression`) | ATTEMPTED | ☑ | ☑ | Visual rule builder, real contact types |
| F2.3 | Translation files: view / edit existing keys | ATTEMPTED | ☐ | ☐ | key × locale grid, missing-cell markers |
| F2.4 | Add a language (one click) | ATTEMPTED | ☑ | ☑ | Appends to locales + survey **and** choices headers + creates the `.properties` file |
| F2.5 | **Create a new translation key** | PART | ☐ | ☐ | **In flight.** Blocks bilingual task titles |
| F2.6 | **Icons: pick from a resource list** | TODO | ☐ | ☐ | Today a typed id — and `icon` is **required** per the CHT docs |
| F2.7 | **`resources.json` editor + upload** | TODO | ☐ | ☐ | No editor at all; preflight only warns [dep: F2.6] |
| F2.8 | Keep sheet / properties / translations consistent | PART | ☐ | ☐ | Mostly; add a consistency check to preflight |
| F2.9 | Media hygiene: delete route + orphan warning | TODO | ☐ | ☐ | Replaced images ship forever as attachments |

## F3 — New simple linear form + persona assignment PART

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F3.1 | Create a new app form, label-first | ATTEMPTED | ☑ | ☑ | Human title → slugified id; `form_title` keeps the title |
| F3.2 | Scaffold the canonical `inputs` plumbing | ATTEMPTED | ☑ | ☑ | user + contact + linking calculates |
| F3.3 | **Declare `inputs/contact/name`** | TODO | ☐ | ☐ | **Deploy blocker.** 55 of 56 real app forms reference it; `validate-app-forms` fails the entire run without it |
| F3.4 | Insert a contact-field reference (`patient_name`) | PART | ☐ | ☐ | Picker works but emits a dangling XPath [dep: F3.3] |
| F3.5 | The four-question rapid-response case, end to end | PART | ☐ | ☐ | Buildable; blocked on F3.3 for any name reference |
| F3.6 | **Assign a form to a persona / role** | TODO | ☐ | ☐ | **Nothing edits roles.** Needs `context.permission` or a user-based rule kind, plus a permissions surface |
| F3.7 | Whole-form visibility per role | TODO | ☐ | ☐ | [dep: F3.6] |
| F3.8 | Per-question role visibility | OUT | — | — | Out of MVP |

## F4 — Basic hierarchy ATTEMPTED

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F4.1 | Guided "levels and roles" creator | ATTEMPTED | ☐ | ☑ | Quick Hierarchy Creator — pick depth, name each level |
| F4.2 | Write `contact_types` + `place_hierarchy_types` | ATTEMPTED | ☐ | ☑ | Only those keys touched; the rest of `base_settings.json` untouched |
| F4.3 | `place-types.json` maintenance | ATTEMPTED | ☐ | ☑ |  |
| F4.4 | Person types get `create_form` / `edit_form` | ATTEMPTED | ☐ | ☑ | Was a real bug; fixed |
| F4.5 | Edit leaf-level contact details | ATTEMPTED | ☐ | ☑ | Via the contact forms |
| F4.6 | Unrequested-semantic-change guard | TODO | ☐ | ☐ | Hierarchy save makes changes nobody asked for [dep: F15] |
| F4.7 | Complex restructuring (split a district, add a level) | OUT | — | — | Out of MVP |

## F5 — Basic contacts ATTEMPTED

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F5.1 | Generate create / edit forms per contact type | ATTEMPTED | ☐ | ☑ | Batch generator, minimal-valid |
| F5.2 | Regenerate / overwrite existing | ATTEMPTED | ☐ | ☑ | With a diff + confirm |
| F5.3 | Correct meta XPath hop count | ATTEMPTED | ☐ | ☑ | Was an off-by-one |
| F5.4 | Same restricted edit subset as app forms | ATTEMPTED | ☐ | ☑ | Same editor |
| F5.5 | Contact-form naming (`<type>-create.xlsx`) | ATTEMPTED | ☐ | ☑ | Hyphens preserved for the contact category |
| F5.6 | `contactFieldChoices` pollution by `PLACE_TYPE` templates | TODO | ☐ | ☐ | Parsed as real contact forms; offers values that do not exist |

## F6 — Basic task creation PART

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F6.1 | Create a single-person task | ATTEMPTED | ☐ | ☑ | Appended without disturbing a 1050-line hand-written `tasks.js` |
| F6.2 | Trigger: form + `appliesToType` | ATTEMPTED | ☐ | ☑ | Multi-select of real project forms |
| F6.3 | Condition builder (`appliesIf`) | ATTEMPTED | ☐ | ☑ | Incl. "any of" for multi-select, plus or/and connectors |
| F6.4 | Window: start / due / end in days | ATTEMPTED | ☐ | ☑ | Plus a date-anchor picker (report field, LMP) |
| F6.5 | Resolution (`resolvedIf`) | ATTEMPTED | ☐ | ☑ | "form submitted in window" picker |
| F6.6 | Action: open a form | ATTEMPTED | ☐ | ☑ | Dropdown of real forms |
| F6.7 | Computed identity so re-runs never duplicate | ATTEMPTED | ☐ | ☑ | Task id derived **from the project's own convention** |
| F6.8 | Bilingual task title | PART | ☐ | ☐ | Writes both `.properties` files; **key creation blocked** [dep: F2.5] |
| F6.9 | **Task → form data hand-off** | TODO | ☐ | ☐ | Receivers land in `inputs/user/`; `modifyContent` emits `report.<f>` not `report.fields.<f>` |
| F6.10 | **Emit in the project's lint style** | TODO | ☐ | ☐ | **Deploy blocker** — 16 ESLint errors, nothing ships [dep: F15.8] |
| F6.11 | Multi-visit temporal / group tasks | OUT | — | — | Out of MVP |

## F7 — Templates & reusable building blocks PART

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F7.1 | New-project templates | ATTEMPTED | ☐ | ☐ | empty / blank / cht-default / malaria |
| F7.2 | Templates ship every cht-conf-required file | ATTEMPTED | ☐ | ☐ | Incl. the `targets.js` stub |
| F7.3 | Per-template compile guard in CI | TODO | ☐ | ☐ | Would have caught cht-default's missing dependency |
| F7.4 | Workflow templates (pregnancy, nutrition 6–59mo) | TODO | ☐ | ☐ | Clinical content, not plumbing |
| F7.5 | **Reusable blocks** ("Age categories (select one)") | TODO | ☐ | ☐ | New concept — insertable, parameterised row groups |
| F7.6 | Lineage / ancestor block | ATTEMPTED | ☐ | ☐ | Precedent for F7.5 — one gesture, balanced insert, staleness detection |

## F8 — Rendered WYSIWYG preview TODO

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F8.1 | Spike: how much of the Project Explorer renderer is reusable | TODO | ☐ | ☐ | **A design-doc open question.** Do this first |
| F8.2 | Render the current form as the CHW sees it | TODO | ☐ | ☐ | [dep: F8.1] |
| F8.3 | On-demand xls→xml for preview | TODO | ☐ | ☐ | Or reuse the converted `.xml` |
| F8.4 | Click a question in preview → open its editor | TODO | ☐ | ☐ | The minimum that makes it an *editing* surface [dep: F8.2] |
| F8.5 | Storybook-style flow walkthrough | TODO | ☐ | ☐ | [dep: F8.2] |
| F8.6 | Full inline editing in the preview | TODO | ☐ | ☐ | Stretch [dep: F8.4] |

## F9 — Safety tests: synthetic patients TODO

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F9.1 | Define the synthetic-patient case format | TODO | ☐ | ☐ | Foundation |
| F9.2 | Run a case through old + new form, diff outcomes | TODO | ☐ | ☐ | The core acceptance criterion [dep: F9.1] |
| F9.3 | "No clinical change" gate on an edit | TODO | ☐ | ☐ | [dep: F9.2] |
| F9.4 | Accumulate cases per revision | TODO | ☐ | ☐ | Behaviour changes only when clinical rules change |
| F9.5 | Workflow simulator (contact + reports → what fires) | TODO | ☐ | ☐ | Externally requested; a leapfrog vs CommCare/Kobo |
| F9.6 | Preflight validator (deploy-blocking checks) | ATTEMPTED | ☐ | ☐ | Required files, identifiers, XPath hops, choices, dangling refs |
| F9.7 | `validate-app-forms` / pyxform leg in CI | TODO | ☐ | ☐ | The **only** check that catches a dangling XPath [dep: F15] |

## F10 — Versioning: attributable & reversible TODO

The design doc flags this as *"TBD — tall order"* and *"might be very hard, needs changes with the
CHT ecosystem itself."* Treat as a spike first.

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F10.1 | Spike: git vs hash-and-comment | TODO | ☐ | ☐ | The doc offers both; decide before building |
| F10.2 | Undo / redo within a session | ATTEMPTED | ☐ | ☐ | Single-patch undo across the editor |
| F10.3 | Record who + when per change | TODO | ☐ | ☐ | No identity concept exists yet |
| F10.4 | Roll back a change in-app | TODO | ☐ | ☐ | git substrate exists; no UI [dep: F10.1] |
| F10.5 | Diff view of pending changes | PART | ☐ | ☐ | Changed-form detection only; no content diff |
| F10.6 | Version stamp in the artifact | PART | ☐ | ☐ | `settings.version` stamped on create |

## F11 — Governance: sign-off + deploy gate PART

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F11.1 | Decisions / sign-off view | PART | ☐ | ☐ | Exists but FHIR-oriented; needs to cover form + task changes |
| F11.2 | Self-serve deploy to dev / training | ATTEMPTED | ☐ | ☐ | One-click, targeted, friendly error translator |
| F11.3 | Production review gate | TODO | ☐ | ☐ | **Open question in the doc:** who reviews, what is the minimum gate |
| F11.4 | Governance tiering by change type | TODO | ☐ | ☐ | Label edit vs mandatory toggle vs new form |
| F11.5 | Gate the mandatory↔optional toggle specifically | TODO | ☐ | ☐ | The doc calls this out by name [dep: F9.3] |
| F11.6 | Fix the sign-off view rendering conditions inverted | TODO | ☐ | ☐ | Currently shows the **opposite** of the config's meaning [dep: F15] |

## F12 — Contact summary (basic) ATTEMPTED

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F12.1 | Context flags: add / rename / remove | ATTEMPTED | ☐ | ☐ | Only the context object rewritten; fields/cards verbatim |
| F12.2 | Condition-card fields editor | ATTEMPTED | ☐ | ☐ | Cards + fields, raw fallback for imperative cards |
| F12.3 | Cross-form values ("latest X from form Y") | ATTEMPTED | ☑ | ☑ | Self-contained reports scan |
| F12.4 | **Pick values the config already computes** | PART | ☐ | ☐ | **In flight.** Shows 0 of ~70 on a real config |
| F12.5 | Helper-body editing | TODO | ☐ | ☐ | **Do not use today** — 31 of 31 real helpers fail to survive it [dep: F15] |

## F13 — Standard codes ATTEMPTED

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F13.1 | Assign codes to questions and choices | ATTEMPTED | ☐ | ☐ | Sidecar `fhir-mapping.json` |
| F13.2 | LOINC / ICD / CIEL dictionaries | ATTEMPTED | ☐ | ☐ | Vendored, free-licence only |
| F13.3 | Coverage + orphan reporting | ATTEMPTED | ☐ | ☐ |  |
| F13.4 | SNOMED | OUT | — | — | Deliberate — licensing |
| F13.5 | WHO CCC | TODO | ☐ | ☐ | Named in the design doc, not built |

## F14 — Round-trip & determinism (cross-cutting) PART

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F14.1 | Preserve unknown columns and sheets verbatim | ATTEMPTED | ☐ | ☐ | The core invariant; extras rewritten in their original position |
| F14.2 | Hand-authored form round-trips losslessly | PART | ☐ | ☐ | True for the sheet; **the JS surfaces are where it breaks** [dep: F15] |
| F14.3 | Deterministic output: same edit, same bytes | PART | ☐ | ☐ | Holds for forms; formatting drift on JS |
| F14.4 | Reuse pyxform + cht-conf, no parallel compiler | ATTEMPTED | ☐ | ☐ | Explicit non-goal honoured |
| F14.5 | Hostile / non-canonical fixture corpus | PART | ☐ | ☐ | 8 hostile test files + a corpus sweep exist — **still uncommitted** |
| F14.6 | Cross-sheet logic must live in `shared/` as pure functions | TODO | ☐ | ☐ | Standing rule after four green-tests / broken-reality cases |

## F15 — Platform hardening: real-config safety PART — NOT IN THE DESIGN DOC

The design doc predates pointing the editor at a **deployed national config**. Nine defects
silently corrupt it; six fire on **open-a-panel-and-save with zero edits**, and every one produces
valid, compiling, deployable output. **This gates the doc's own "round-trips without losing them"
and "deterministic output" acceptance criteria**, so it belongs in Phase 1.

| ID | Task | State | Auto QA | UAT | Notes |
|---|---|---|---|---|---|
| F15.1 | Read formula results, not formula source | TODO | ☐ | ☐ | One expression; kills three findings (19 of 34 contact forms) |
| F15.2 | Do not invent the helper argument | ATTEMPTED | ☐ | ☐ | Shipped |
| F15.3 | Refuse to emit what cannot be represented | TODO | ☐ | ☐ | Dropped declarations cause a ReferenceError per contact |
| F15.4 | `resolvedIf`: exact match, not substring | TODO | ☐ | ☐ | Replaces hand-written bodies; drops the start clamp |
| F15.5 | Preserve parentheses in eligibility | TODO | ☐ | ☐ | 11 of 24 forms flip eligibility, every flip false→true |
| F15.6 | Scope helper / export replaces; rename covers all refs | TODO | ☐ | ☐ | 37 missed references |
| F15.7 | Translations: write the last duplicate, not the first | TODO | ☐ | ☐ | Duplicate keys exist in all four real configs |
| F15.8 | Emit in the project's lint style | TODO | ☐ | ☐ | **Deploy blocker** — same as F6.10 |
| F15.9 | Config-agnostic acceptance rule | ATTEMPTED | ☐ | ☐ | A fix must be right in all four real configs |

---

## Phase 2

**F16 — Complex logic (calculation / relevant / constraint) ATTEMPTED ~90%, ahead of the plan.**
The design doc places this in Phase 2; the POC shipped it. Visual builders for relevant,
constraint, choice_filter and calculation, with plain-language wrappers, if-then decision tables,
cross-form references, and a raw escape that preserves unparsed text. Remaining: nested grouping
beyond one level (**decided: keep as is**) and wiring choice dropdowns into the last un-wired
builder mount.

**F17 — AI-assisted authoring TODO.** F17.1 evaluate `cht-ai-tools` for overlap · F17.2 get familiar
with Berkeley's tool · F17.3 draft-from-guidelines producing an ordinary editable form · F17.4 gap
and consistency flagging · F17.5 the IR crosswalk (a layered clinical IR compiling down to our
XLSForm IR — groundwork exists in `ir-crosswalk-levine.md`) · F17.6 a free / open-model path, which
the doc names as necessary for real adoption.

**F18 — Constrained drag-and-drop (BPMN-lite) TODO ~5%.** React Flow already renders a form flowchart
view, which is the seed. Structured data stays the source of truth, never the diagram.
**Open question in the doc: which Phase-2 track goes first.**

---

## Acceptance-criteria traceability

| Design-doc criterion | Features | Can we claim it today? |
|---|---|---|
| Change a label / choice / image / mandatory flag and deploy without a developer | F1, F2, F11.2 | **Nearly** — blocked by F6.10 lint emission on any task edit |
| Small change: full dev cycle → days | F1, F11.2 | Plausible; unmeasured |
| MOH team adds a rapid-response form and assigns a persona | F3 | **No** — F3.6 roles missing |
| Basic hierarchy, contacts and a single-person task via the builder | F4, F5, F6 | **Yes**, proven on a real config |
| Every change versioned, attributable, reversible | F10 | **No** |
| Edits that should not change logic give identical synthetic outcomes | F9 | **No** |
| Icons / logos + translations edited outside the XLS, kept consistent | F2 | **Partly** — icons missing |
| Hand-authored columns round-trip without loss | F14, F15 | **Sheet yes, JS no** |
| Production passes a review gate; dev / training self-serve | F11 | **Half** |
| Complete an edit in Simple mode without seeing XLSForm, JSON or variable names | F1.14 | **Nearly** — audit for leaks |

## Suggested sequencing

1. **F15 + F3.3 + F6.10** — stop corrupting real configs and unblock deploy. Everything else is
   worth less until the output can actually ship.
2. **F2.5 + F12.4 + F3.4** — finish the in-flight authoring work (the current focus).
3. **F3.6** — roles / persona. The smallest remaining item that unblocks a stated acceptance criterion.
4. **F2.6 / F2.7** — icons + resources. Named in scope, currently zero coverage.
5. **F8 spike, then F9** — preview first (F8.1 answers a design-doc open question), because the
   synthetic-patient harness reuses the same rendering and evaluation work.
6. **F10 + F11** — versioning and governance. Both carry open questions the doc flags; spike first.
7. **F7.4 / F7.5**, then Phase 2 once the squad picks a track.
