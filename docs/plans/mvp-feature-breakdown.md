<!--
Work breakdown for the final tech design ("No Code CHT Configuration - Requirements & Design",
2026-08-13). Follows that doc's own breakdown guidance: mark what the POC already did, keep
tasks independently testable, tag dependencies. Status is measured against this repo.

Structure notes (2026-08-27):
- F7 (user roles & attribution) added on PO direction; F8-F18 renumbered up by one.
- Platform hardening is NO LONGER a feature. It is a defect list in the "Known defects"
  appendix (D1-D10), because features are things you build and these are things you fix —
  a completion percentage on a bug list is meaningless. Dependency tags point at D-numbers.
-->

# MVP feature & task breakdown

**Source:** *No Code CHT Configuration — Requirements & Design* (Draft, 2026-08-13).
**Written per that doc's own guidance:** *"Make tasks for things that might be sort of completed on
POC. Even if it's just to add a checkmark that's done… try to create independently testable
tasks… tag dependencies."*

**Status legend** — measured against this repo, with evidence, not estimated.

| Column | Value | Meaning |
|---|---|---|
| **Dev State** | ATTEMPTED | Built by the dev — **not** verified |
| | PART | Partially built — the gap is named |
| | TODO | Not started |
| | OUT | Explicitly out of MVP scope per the design doc |
| **QA State** | Playwright attempted | An automated Playwright spec has driven this through the real UI |
| | TODO | No QA coverage yet |
| | — | Not applicable (out of scope) |

**Dev State and QA State are independent.** *Playwright attempted* means an automated spec has
driven the feature through the real UI and asserted the result on disk — it is evidence, not a
sign-off, and it says nothing about whether a CHW can use the result on a device. Everything
reading TODO in that column has no automated coverage at all.

> **The headline for planning: the POC already covers most of Phase 1, and all of what the design
> doc calls Phase 2 "complex logic".** The remaining Phase 1 work concentrates in five places —
> **roles/attribution, preview, safety tests, versioning, and governance.** Separately, the
> **Known defects** appendix lists ten real-config defects that gate two of the design doc's own
> acceptance criteria. Read the summary table first; it changes the sequencing.

## Summary

| # | Feature | Phase | Dev State | QA State |
|---|---|---|---|---|
| F1 | Form editor — restricted safe edit subset | 1 | ATTEMPTED ~95% | Playwright attempted |
| F2 | Beyond-the-sheet: properties, resources, translations | 1 | PART ~60% — resources/icons missing | Playwright attempted |
| F3 | New simple linear form + contact hydration | 1 | PART ~70% | Playwright attempted |
| F4 | Basic hierarchy | 1 | ATTEMPTED ~90% | TODO |
| F5 | Basic contacts | 1 | ATTEMPTED ~85% | TODO |
| F6 | Basic task creation | 1 | PART ~75% — hand-off seam + lint emission | TODO |
| **F7** | **User roles & attribution** | **1** | **TODO ~5% — new, prerequisite for F11 + F12** | TODO |
| F8 | Templates & reusable building blocks | 1 | PART ~55% — blocks not started | TODO |
| F9 | Rendered WYSIWYG preview | 1 | TODO 0% | TODO |
| F10 | Safety tests — synthetic patients | 1 | TODO ~10% | TODO |
| F11 | Versioning: attributable & reversible | 1 | TODO ~15% | TODO |
| F12 | Governance: sign-off + deploy gate | 1 | PART ~40% | TODO |
| F13 | Contact summary (basic) | 1 | ATTEMPTED ~80% | Playwright attempted |
| F14 | Standard codes | 1 | ATTEMPTED ~85% | TODO |
| F15 | Round-trip & determinism (cross-cutting) | 1 | PART ~70% | TODO |
| F16 | Complex logic: calculation / relevant / constraint | 2 | ATTEMPTED ~90% **(ahead of plan)** | TODO |
| F17 | AI-assisted authoring | 2 | TODO 0% | TODO |
| F18 | Constrained drag-and-drop (BPMN-lite) | 2 | TODO ~5% | TODO |

---

## F1 — Form editor: the restricted safe edit subset ATTEMPTED

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F1.1 | Edit question labels | ATTEMPTED | Playwright attempted | Per-locale inputs on the row card |
| F1.2 | Edit hints | ATTEMPTED | Playwright attempted | Per-locale, incl. `constraint_message` |
| F1.3 | Add / edit / reorder choices | ATTEMPTED | Playwright attempted | Inline editor + Choices tab; auto-derived names |
| F1.4 | Mandatory ↔ optional toggle | ATTEMPTED | Playwright attempted | Row-card checkbox |
| F1.5 | Reorder questions | ATTEMPTED | Playwright attempted | dnd-kit, **dependency-guarded** — blocks a move ahead of a referenced field |
| F1.6 | Add / remove questions | ATTEMPTED | Playwright attempted | Typed palette |
| F1.7 | Sections / groups | ATTEMPTED | Playwright attempted | Balanced insert, nested, `field-list` toggle |
| F1.8 | Typed palette, grouped | ATTEMPTED | Playwright attempted | 9 categories incl. a dedicated **cht** group |
| F1.9 | Bikram Sambat picker | ATTEMPTED | Playwright attempted | `bikram_sambat_date` tile → `appearance: bikram-sambat-datepicker` |
| F1.10 | CHT-only palette filter | PART | TODO | `chtOnly` flag exists per tile; **verify the filter control is exposed** |
| F1.11 | Simple vs Full mode | ATTEMPTED | Playwright attempted | Simple hides logic; Full reveals advanced fields |
| F1.12 | Plain-language column wrappers | ATTEMPTED | Playwright attempted | "Show this question when…", "Compute the value as…", "Accept only if…" |
| F1.13 | Per-question image (`media::image`) | ATTEMPTED | Playwright attempted | Upload to the form-media folder, **verified against vendored cht-conf** |
| F1.14 | Never expose XLSForm rows / XPath / JSON in Simple mode | PART | TODO | Largely true; **audit for leaks** — the generated-JS preview is always visible |
| F1.15 | Edit variable names | OUT | — | Breaks longitudinal data. **Add an explicit guard** [see D6] |

**Independently testable:** every row is a UI action with an on-disk assertion. Existing e2e
`geriatric-build.spec.ts` drives F1.1–F1.13 green.

## F2 — Beyond the sheet: properties, resources, translations PART

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F2.1 | Edit `properties.json` title, per locale | ATTEMPTED | Playwright attempted | "Title (per locale)" grid |
| F2.2 | Edit form eligibility (`context.expression`) | ATTEMPTED | Playwright attempted | Visual rule builder, real contact types |
| F2.3 | Translation files: view / edit existing keys | ATTEMPTED | TODO | key × locale grid, missing-cell markers |
| F2.4 | Add a language (one click) | ATTEMPTED | Playwright attempted | Appends to locales + survey **and** choices headers + creates the `.properties` file |
| F2.5 | **Create a new translation key** | PART | TODO | **In flight.** Blocks bilingual task titles |
| F2.6 | **Icons: pick from a resource list** | TODO | TODO | Today a typed id — and `icon` is **required** per the CHT docs |
| F2.7 | **`resources.json` editor + upload** | TODO | TODO | No editor at all; preflight only warns [dep: F2.6] |
| F2.8 | Keep sheet / properties / translations consistent | PART | TODO | Mostly; add a consistency check to preflight |
| F2.9 | Media hygiene: delete route + orphan warning | TODO | TODO | Replaced images ship forever as attachments |

## F3 — New simple linear form + contact hydration PART

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F3.1 | Create a new app form, label-first | ATTEMPTED | Playwright attempted | Human title → slugified id; `form_title` keeps the title |
| F3.2 | Scaffold the canonical `inputs` plumbing | ATTEMPTED | Playwright attempted | user + contact + linking calculates |
| F3.3 | Declare `inputs/contact/name` | TODO | TODO | 55 of 56 real app forms use it, and CHT provides it by default, so we should declare it. `validate-app-forms` fails the **entire run** without it |
| F3.4 | Insert a contact-field reference (`patient_name`) | PART | TODO | Picker works but emits a dangling XPath [dep: F3.3] |

## F4 — Basic hierarchy ATTEMPTED

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F4.1 | Guided "levels and roles" creator | ATTEMPTED | TODO | Quick Hierarchy Creator — pick depth, name each level |
| F4.2 | Write `contact_types` + `place_hierarchy_types` | ATTEMPTED | TODO | Only those keys touched; the rest of `base_settings.json` untouched |
| F4.3 | `place-types.json` maintenance | ATTEMPTED | TODO | |
| F4.4 | Person types get `create_form` / `edit_form` | ATTEMPTED | TODO | Was a real bug; fixed |
| F4.5 | Edit leaf-level contact details | ATTEMPTED | TODO | Via the contact forms |
| F4.6 | Unrequested-semantic-change guard | TODO | TODO | Hierarchy save makes changes nobody asked for [see D9] |
| F4.7 | Complex restructuring (split a district, add a level) | OUT | — | Out of MVP |

## F5 — Basic contacts ATTEMPTED

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F5.1 | Generate create / edit forms per contact type | ATTEMPTED | TODO | Batch generator, minimal-valid |
| F5.2 | Regenerate / overwrite existing | ATTEMPTED | TODO | With a diff + confirm |
| F5.3 | Correct meta XPath hop count | ATTEMPTED | TODO | Was an off-by-one |
| F5.4 | Same restricted edit subset as app forms | ATTEMPTED | TODO | Same editor |
| F5.5 | Contact-form naming (`<type>-create.xlsx`) | ATTEMPTED | TODO | Hyphens preserved for the contact category |
| F5.6 | `contactFieldChoices` pollution by `PLACE_TYPE` templates | TODO | TODO | Parsed as real contact forms; offers values that do not exist |

## F6 — Basic task creation PART

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F6.1 | Create a single-person task | ATTEMPTED | TODO | Appended without disturbing a 1050-line hand-written `tasks.js` |
| F6.2 | Trigger: form + `appliesToType` | ATTEMPTED | TODO | Multi-select of real project forms |
| F6.3 | Condition builder (`appliesIf`) | ATTEMPTED | TODO | Incl. "any of" for multi-select, plus or/and connectors |
| F6.4 | Window: start / due / end in days | ATTEMPTED | TODO | Plus a date-anchor picker (report field, LMP) |
| F6.5 | Resolution (`resolvedIf`) | ATTEMPTED | TODO | "form submitted in window" picker |
| F6.6 | Action: open a form | ATTEMPTED | TODO | Dropdown of real forms |
| F6.7 | Computed identity so re-runs never duplicate | ATTEMPTED | TODO | Task id derived from the project's own convention |
| F6.8 | Bilingual task title | PART | TODO | Writes both `.properties` files; key creation blocked [dep: F2.5] |
| F6.9 | Task → form data hand-off | TODO | TODO | Receivers land in `inputs/user/`; `modifyContent` emits `report.<f>` not `report.fields.<f>` |
| F6.10 | Emit in the project's lint style | TODO | TODO | **Deploy blocker** — 16 ESLint errors, nothing ships [see D8] |
| F6.11 | Multi-visit temporal / group tasks | OUT | — | Out of MVP |

## F7 — User roles & attribution TODO ← NEW

**Not named as a feature in the design doc, but required by it three times:** *"every change is
versioned, **attributable to a person/role**, and reversible"*; *"program staff self-serve to
dev/training instances; **production passes a PR-style review gate**"*; and the open question
*"**Which roles** should be allowed to add a new rapid-response form?"*

**F11 (versioning) and F12 (governance) both depend on this.** You cannot attribute a change to a
person if the tool has no concept of a person, and you cannot gate a panel by role if no roles
exist. Both of those features are currently specced on top of nothing.

> **Scope honestly: guardrails, not security.** The tool is local and single-user, and the config is
> just files on the user's own disk — so this prevents *accidents* and produces an *audit trail*. It
> does not stop anyone determined, and it should not claim to. Accidents are the real risk.

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F7.1 | Identity on first run — name + role | TODO | TODO | Foundation for everything below; stored per project |
| F7.2 | Stamp who + when into every change record | TODO | TODO | **This is what unblocks F11.3** [dep: F7.1] |
| F7.3 | Role-gated panel visibility | TODO | TODO | Hide, or warn before opening — not a hard block [dep: F7.1] |
| F7.4 | Deploy panel: dev/training self-serve vs production gated | TODO | TODO | The split the design doc states [dep: F7.1] |
| F7.5 | Decide the role set | TODO | TODO | **Design-doc open question.** Program officer / designer / app developer / approver? |
| F7.6 | Credentials already gate production *de facto* | ATTEMPTED | TODO | You can only deploy where you hold instance credentials — worth stating, since it may already cover most of the need |
| F7.7 | Real multi-user authorization | OUT | — | Needs a hosted mode; out of MVP per the design doc |

**Note:** this is **builder-tool** roles — who may use which part of the editor. It is unrelated to
assigning a *CHT form* to a persona (which is `permissions` in `app_settings` plus
`context.permission`). That CHT-side work was removed from this breakdown; if the acceptance
criterion *"an MOH team can add a rapid-response form and assign it to a persona"* is still wanted,
it needs its own feature.

## F8 — Templates & reusable building blocks PART

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F8.1 | New-project templates | ATTEMPTED | TODO | empty / blank / cht-default / malaria |
| F8.2 | Templates ship every cht-conf-required file | ATTEMPTED | TODO | Incl. the `targets.js` stub |
| F8.3 | Per-template compile guard in CI | TODO | TODO | Would have caught cht-default's missing dependency |
| F8.4 | Workflow templates (pregnancy, nutrition 6–59mo) | TODO | TODO | Clinical content, not plumbing |
| F8.5 | Reusable blocks ("Age categories (select one)") | TODO | TODO | New concept — insertable, parameterised row groups |
| F8.6 | Lineage / ancestor block | ATTEMPTED | TODO | Precedent for F8.5 — one gesture, balanced insert, staleness detection |

## F9 — Rendered WYSIWYG preview TODO

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F9.1 | Spike: how much of the Project Explorer renderer is reusable | TODO | TODO | **A design-doc open question.** Do this first |
| F9.2 | Render the current form as the CHW sees it | TODO | TODO | [dep: F9.1] |
| F9.3 | On-demand xls→xml for preview | TODO | TODO | Or reuse the converted `.xml` |
| F9.4 | Click a question in preview → open its editor | TODO | TODO | The minimum that makes it an *editing* surface [dep: F9.2] |
| F9.5 | Storybook-style flow walkthrough | TODO | TODO | [dep: F9.2] |
| F9.6 | Full inline editing in the preview | TODO | TODO | Stretch [dep: F9.4] |

## F10 — Safety tests: synthetic patients TODO

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F10.1 | Define the synthetic-patient case format | TODO | TODO | Foundation |
| F10.2 | Run a case through old + new form, diff outcomes | TODO | TODO | The core acceptance criterion [dep: F10.1] |
| F10.3 | "No clinical change" gate on an edit | TODO | TODO | [dep: F10.2] |
| F10.4 | Accumulate cases per revision | TODO | TODO | Behaviour changes only when clinical rules change |
| F10.5 | Workflow simulator (contact + reports → what fires) | TODO | TODO | Externally requested; a leapfrog vs CommCare/Kobo |
| F10.6 | Preflight validator (deploy-blocking checks) | ATTEMPTED | TODO | Required files, identifiers, XPath hops, choices, dangling refs |
| F10.7 | `validate-app-forms` / pyxform leg in CI | TODO | TODO | The **only** check that catches a dangling XPath [see D-list] |

## F11 — Versioning: attributable & reversible TODO

The design doc flags this as *"TBD — tall order"* and *"might be very hard, needs changes with the
CHT ecosystem itself."* Treat as a spike first. **Depends on F7.**

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F11.1 | Spike: git vs hash-and-comment | TODO | TODO | The doc offers both; decide before building |
| F11.2 | Undo / redo within a session | ATTEMPTED | TODO | Single-patch undo across the editor |
| F11.3 | Record who + when per change | TODO | TODO | Blocked until identity exists [dep: F7.2] |
| F11.4 | Roll back a change in-app | TODO | TODO | git substrate exists; no UI [dep: F11.1] |
| F11.5 | Diff view of pending changes | PART | TODO | Changed-form detection only; no content diff |
| F11.6 | Version stamp in the artifact | PART | TODO | `settings.version` stamped on create |

## F12 — Governance: sign-off + deploy gate PART

**Depends on F7** for anything role-based.

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F12.1 | Decisions / sign-off view | PART | TODO | Exists but FHIR-oriented; needs to cover form + task changes |
| F12.2 | Self-serve deploy to dev / training | ATTEMPTED | TODO | One-click, targeted, friendly error translator |
| F12.3 | Production review gate | TODO | TODO | **Open question in the doc:** who reviews, what is the minimum gate [dep: F7.4] |
| F12.4 | Governance tiering by change type | TODO | TODO | Label edit vs mandatory toggle vs new form |
| F12.5 | Gate the mandatory↔optional toggle specifically | TODO | TODO | The doc calls this out by name [dep: F10.3] |
| F12.6 | Fix the sign-off view rendering conditions inverted | TODO | TODO | Currently shows the opposite of the config's meaning [see D10] |

## F13 — Contact summary (basic) ATTEMPTED

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F13.1 | Context flags: add / rename / remove | ATTEMPTED | TODO | Only the context object rewritten; fields/cards verbatim |
| F13.2 | Condition-card fields editor | ATTEMPTED | TODO | Cards + fields, raw fallback for imperative cards |
| F13.3 | Cross-form values ("latest X from form Y") | ATTEMPTED | Playwright attempted | Self-contained reports scan |
| F13.4 | Pick values the config already computes | PART | TODO | **In flight.** Shows 0 of ~70 on a real config |
| F13.5 | Helper-body editing | TODO | TODO | **Do not use today** — 31 of 31 real helpers fail to survive it [see D3] |

## F14 — Standard codes ATTEMPTED

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F14.1 | Assign codes to questions and choices | ATTEMPTED | TODO | Sidecar `fhir-mapping.json` |
| F14.2 | LOINC / ICD / CIEL dictionaries | ATTEMPTED | TODO | Vendored, free-licence only |
| F14.3 | Coverage + orphan reporting | ATTEMPTED | TODO | |
| F14.4 | SNOMED | OUT | — | Deliberate — licensing |
| F14.5 | WHO CCC | TODO | TODO | Named in the design doc, not built |

## F15 — Round-trip & determinism (cross-cutting) PART

| ID | Task | Dev State | QA State | Notes |
|---|---|---|---|---|
| F15.1 | Preserve unknown columns and sheets verbatim | ATTEMPTED | TODO | The core invariant; extras rewritten in their original position |
| F15.2 | Hand-authored form round-trips losslessly | PART | TODO | True for the sheet; the JS surfaces are where it breaks [see D-list] |
| F15.3 | Deterministic output: same edit, same bytes | PART | TODO | Holds for forms; formatting drift on JS [see D8] |
| F15.4 | Reuse pyxform + cht-conf, no parallel compiler | ATTEMPTED | TODO | Explicit non-goal honoured |
| F15.5 | Hostile / non-canonical fixture corpus | PART | TODO | 8 hostile test files + a corpus sweep exist — still uncommitted |
| F15.6 | Cross-sheet logic must live in `shared/` as pure functions | TODO | TODO | Standing rule after four green-tests / broken-reality cases |

---

## Phase 2

**F16 — Complex logic (calculation / relevant / constraint) ATTEMPTED ~90%, ahead of the plan.**
The design doc places this in Phase 2; the POC shipped it. Visual builders for relevant, constraint,
choice_filter and calculation, with plain-language wrappers, if-then decision tables, cross-form
references, and a raw escape that preserves unparsed text. Remaining: nested grouping beyond one
level (**decided: keep as is**) and wiring choice dropdowns into the last un-wired builder mount.

**F17 — AI-assisted authoring TODO.** F17.1 evaluate `cht-ai-tools` for overlap · F17.2 get familiar
with Berkeley's tool · F17.3 draft-from-guidelines producing an ordinary editable form · F17.4 gap
and consistency flagging · F17.5 the IR crosswalk (a layered clinical IR compiling down to our
XLSForm IR — groundwork exists in `ir-crosswalk-levine.md`) · F17.6 a free / open-model path, which
the doc names as necessary for real adoption.

**F18 — Constrained drag-and-drop (BPMN-lite) TODO ~5%.** React Flow already renders a form
flowchart view, which is the seed. Structured data stays the source of truth, never the diagram.
**Open question in the doc: which Phase-2 track goes first.**

---

## Acceptance-criteria traceability

| Design-doc criterion | Features | Can we claim it today? |
|---|---|---|
| Change a label / choice / image / mandatory flag and deploy without a developer | F1, F2, F12.2 | **Nearly** — blocked by F6.10 lint emission on any task edit |
| Small change: full dev cycle → days | F1, F12.2 | Plausible; unmeasured |
| Basic hierarchy, contacts and a single-person task via the builder | F4, F5, F6 | **Yes**, proven on a real config |
| Every change versioned, attributable, reversible | F7, F11 | **No** — and F11 cannot start until F7 exists |
| Edits that should not change logic give identical synthetic outcomes | F10 | **No** |
| Icons / logos + translations edited outside the XLS, kept consistent | F2 | **Partly** — icons missing |
| Hand-authored columns round-trip without loss | F15, D-list | **Sheet yes, JS no** |
| Production passes a review gate; dev / training self-serve | F7, F12 | **Half** — the credential split works, the role gate does not exist |
| Complete an edit in Simple mode without seeing XLSForm, JSON or variable names | F1.14 | **Nearly** — audit for leaks |

---

## Appendix — Known defects (from real-config testing)

**Why these are here and not a feature.** Features are things you build; these are things you fix,
and a completion percentage on a bug list means nothing. They are listed because **they gate two of
the design doc's own acceptance criteria** — *"a form with hand-authored columns round-trips through
the builder without losing them"* and *"regenerated artifacts must be deterministic"* — both of
which are false today for the JavaScript surfaces.

**Where they came from.** Every earlier probe ran against configs we scaffolded ourselves. Pointing
the editor at a **deployed national config** surfaced shapes we had never fixtured. Nine of these
fire on **open-a-panel-and-save with zero user edits**, and every one produces valid, compiling,
deployable output — which is why preflight, the validators, `compile-app-settings` and the test
suite all pass on the corrupted result.

Full evidence and reproduction steps: `docs/handoff-nssd-safety-batch-2026-08-11.md` (canonical
A-numbering), `docs/reviews/nssd-initial-assessment-2026-08-11.md` (technical),
`docs/reviews/nssd-detailed-assessment-2026-08-11.md` (plain language).

| ID | Defect | State | What breaks |
|---|---|---|---|
| D1 | Reads a formula's **source** instead of its **result** | TODO | `=FALSE()` becomes the text `"FALSE()"`, an undefined XPath function — 19 of 34 contact forms. Same bug turns `=NOW()` into a JS date string in 10 app forms |
| D2 | Invents the helper argument | ATTEMPTED | Rewrote `isAlive(contact)` to `isAlive(contact.contact)`, making the check always-true — 25 of 29 tasks would fire for dead and muted patients. **Fixed** |
| D3 | Emits a body it only partly parsed | TODO | Keeps logic, drops the `const` declarations it references → `ReferenceError` per contact. Also the reason helper-body editing is unusable (F13.5) |
| D4 | `resolvedIf` matched by substring, not exactly | TODO | Overwrites hand-written code with a template that omits a clamp, so a stale older report marks the task done and **the CHW never sees it** — 7 tasks |
| D5 | Drops parentheses in eligibility | TODO | `A && (B \|\| C)` becomes `A && B \|\| C`. **11 of 24 forms flip, every flip false→true** — deceased and muted contacts become eligible |
| D6 | Unscoped find-and-replace; rename misses references | TODO | Corrupts a call site instead of the definition (30 of 37 helpers); a dangling `module.exports` name throws at load → **every profile blank, forms vanish from devices**. Rename leaves 37 `${}` refs dangling → pyxform hard-fails the whole config |
| D7 | Writes the **first** duplicate translation key | TODO | CHT reads the **last**. 113 real duplicates: the edit is invisible in the app *and* destroys the line actually in use |
| D8 | Emits its own formatting, not the project's | TODO | The project's own ESLint rejected `tasks.js` with 16 errors — **nothing deploys at all** until a human reformats [blocks F6.10] |
| D9 | Hierarchy save makes unrequested semantic changes | TODO | Injects `create_form` into staff types that deliberately omit it; re-derives `place_hierarchy_types` on any keystroke [blocks F4.6] |
| D10 | Sign-off view renders conditions inverted | TODO | The Decisions screen shows the **opposite** of the config's meaning — on the surface meant for approval [blocks F12.6] |

**The acceptance test for every fix: is this also correct in the other three real configs?** They
disagree with each other on nearly every convention — `isAlive(contact.contact)` is used by 1 of 4;
two use `isAlive(contact)`; both are valid CHT. So "emit the other one" is not a fix, it is a
different hardcode. Principle: **preserve what you read, derive what you write, refuse what you
cannot model.**

---

## Suggested sequencing

1. **F2.5 + F13.4** — finish the in-flight authoring work (the current focus).
2. **D8 + D1** — the two cheapest defects with the widest blast radius. D8 unblocks deploying
   anything the tool writes; D1 is one expression and fixes three findings.
3. **F2.6 / F2.7** — icons + resources. Named in scope, currently zero coverage.
4. **F7** — roles and attribution. Small, and **F11 and F12 cannot start without it.**
5. **F9 spike, then F10** — preview first (F9.1 answers a design-doc open question), because the
   synthetic-patient harness reuses the same rendering and evaluation work.
6. **F11 + F12** — versioning and governance. Both carry open questions the doc flags; spike first.
7. **F8.4 / F8.5**, then Phase 2 once the squad picks a track.
