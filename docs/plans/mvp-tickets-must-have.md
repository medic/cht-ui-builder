<!--
Ready-to-file tickets for every must-have feature in the tech design
("No Code CHT Configuration - Requirements & Design"). Written as a greenfield
build specification: one ticket per feature, paste-ready into an issue tracker.
-->

# MVP tickets — must-have features

**Source:** *No Code CHT Configuration — Requirements & Design*, using its **Feature Importance**
column.

| Importance | Features | Tickets |
|---|---|---|
| **Must have** | F1, F2, F3, F4, F5, F6, F9, F14, F15 | T1–T9 |
| **Must start** | F16 | T10 |
| Stretch | F7, F8, F10, F11, F12, F13, F17 | not ticketed |

Each ticket states why the feature exists, the scope as a checklist, explicit non-goals, testable
acceptance criteria, and dependencies. Sizes are S / M / L relative to each other, not calendar
estimates.

**Two conventions.**

**Acceptance criteria are assertable** — on disk, or on a live CHT instance. Not "looks correct".
The product's core promise is that a project folder edited through the UI stays deployable with
`cht-conf`, and that is only demonstrable by inspecting the emitted artifact.

**Items marked ⚠ are CHT platform constraints** confirmed during prototyping. They are not
suggestions; a design that ignores them produces output CHT rejects or silently misreads.

---

## T1 · F1 — Form editor: the restricted safe edit subset

**Importance:** Must have · **Size:** L · **Depends on:** nothing

**Why.** The core of Phase 1. A non-developer edits an existing form through a rendered view and
never encounters XLSForm rows, XPath, JSON or variable names. Everything else in the MVP assumes
this surface exists.

**Scope.**
- [ ] Edit question labels, per language.
- [ ] Edit hints and validation messages, per language.
- [ ] Add, edit, remove and reorder the options in a choice list.
- [ ] Toggle a question between mandatory and optional.
- [ ] Reorder questions. ⚠ A question cannot move ahead of a question it references — block the
      move and explain why, rather than emitting a broken form.
- [ ] Add and remove questions from a typed palette, grouped so a non-technical user can scan it:
      text & basic, choice, number, date & time, media, location.
- [ ] Add sections/groups, including nesting and the "show all on one screen" option.
      ⚠ Section open and close markers must always be emitted as a matched pair.
- [ ] A CHT-only filter that narrows the palette to types CHT supports.
- [ ] The CHT-specific date picker for the Nepali (Bikram Sambat) calendar.
- [ ] Per-question image, referencing a file the deploy carries as a form attachment.
- [ ] **Simple vs Full mode.** Simple shows label, choices and required only. Full reveals the
      advanced fields.
- [ ] Plain-language wrappers for the logic columns, so nobody edits raw syntax: *"Show this
      question when…"*, *"Compute the value as…"*, *"Accept the answer only if…"*.
- [ ] ⚠ **Refuse to edit variable names**, with an explanation. Renaming a field mid-collection
      breaks the meaning of every record already gathered under the old name.

**Not in scope.** Branching-flow authoring beyond per-question conditions (see F15). Editing a form
that cannot be represented in the editor's model — such a form opens read-mostly.

**Acceptance.**
1. A user completes a label, choice, mandatory-flag and image edit in Simple mode without
   encountering an XLSForm column name, XPath expression, JSON, or a variable name.
2. Reordering a question ahead of one it references is refused with a comprehensible message.
3. A form containing sections survives an open-and-save with no edits **byte-identically**.
4. Attempting to rename a variable is refused and the reason is stated.

---

## T2 · F2 — Edit beyond the sheet: properties, resources, translations

**Importance:** Must have · **Size:** M · **Depends on:** the resources editor precedes the icon
picker

**Why.** The design doc is explicit: icons and logos live in form properties and resources, not in
the spreadsheet. A tool that edits only the sheet cannot deliver a complete change, and the three
files must stay consistent with each other.

**Scope.**
- [ ] Edit a form's title, per language.
- [ ] Edit form eligibility — *who sees this form* — through a visual rule builder offering the
      project's real contact types, never free text.
- [ ] View and edit existing translation keys in a key × language grid, with missing translations
      visibly marked.
- [ ] Add a language in one action. ⚠ This must extend the language columns on **both** the survey
      and the choices sheets, and create the corresponding translation file. Extending only one
      leaves labels that silently never render.
- [ ] **Create a new translation key.** Offer suggestions rather than requiring a hand-typed
      identifier: keys the project already references but no file defines; then CHT's naming
      conventions filled in with the project's real names; then a validated free-text option.
- [ ] A resources editor: upload an image and maintain the key → file mapping.
- [ ] An icon **picker** driven by that mapping. ⚠ CHT documents the icon as required in form
      properties, so a typed identifier is a deploy risk.
- [ ] A consistency check across sheet, properties and translation files.
- [ ] Media hygiene: remove an image, and warn when a referenced image file is missing.

**Not in scope.** Translating anything outside the project's translation files. Image editing.

**Acceptance.**
1. A user sets a form's icon by choosing it, uploads the image behind it, and both survive the
   deploy — confirmed by the icon rendering on a live instance.
2. A new translation key is created in the tool, written into **every** language file, and renders
   translated on a device.
3. Unknown keys, comments and ordering elsewhere in the translation files are preserved
   byte-for-byte. ⚠ Where a file contains duplicate keys, the value CHT actually reads must be the
   one the tool edits.

---

## T3 · F3 — Add a simple new form, and assign it to a persona

**Importance:** Must have · **Size:** M · **Depends on:** input declaration precedes the
contact-field picker

**Why.** Two stated acceptance criteria: a partner team can add a simple linear form — the
four-question rapid-response survey — and assign it to a persona, themselves, without a developer.

**Scope.**
- [ ] Create a new app form label-first: the author names it in plain language and the tool derives
      a valid identifier, showing what it derived. The author never types an identifier.
- [ ] Scaffold the standard input plumbing every CHT report carries.
- [ ] ⚠ **Declare the contact fields the form may reference.** A reference to an undeclared input
      node is an unresolvable path, and form validation fails **the entire deploy run** — every form
      and the settings — not just the offending form. At minimum declare the contact's name, which
      CHT provides by default and which nearly every real app form uses.
- [ ] Insert a contact field into a label or calculation by **picking** it. The tool creates any
      supporting rows needed, in the correct position, and inserts the reference. The author never
      types a reference expression. ⚠ Placement matters: the supporting row must sit where its
      relative path resolves.
- [ ] The four-question linear form, end to end, as the worked example.
- [ ] **Assign the form to a persona/role**, written into form properties, with the role list
      sourced from the project's own configuration.
- [ ] Whole-form visibility per role.

**Not in scope.** Per-question role visibility — the design doc places it out of MVP because it
requires contact-summary wiring. Branching or multi-page flows.

**Acceptance.**
1. A four-question linear form is created, assigned to a persona, deployed **without a developer**,
   and appears for that role and not for others on a live instance.
2. Inserting the contact's name into a label produces a form that **passes form validation and
   conversion**. This must be verified by running the real conversion, not by inspecting the sheet.
3. Validation fails, with a clear message, on any reference to an undeclared input node.

---

## T4 · F4 — Basic hierarchy

**Importance:** Must have · **Size:** M · **Depends on:** nothing

**Why.** The contact hierarchy is the foundation everything else rests on. Without contact types
there is no subject to attach a report to, no surface for a form to appear on, no way to create a
person, and no data replication to a device. It is listed modestly in the design doc but it is a
hard prerequisite.

**Scope.**
- [ ] A guided flow to define hierarchy levels and roles: choose the depth, name each level.
- [ ] Write the contact types and the place hierarchy into app settings. ⚠ Touch **only** those
      keys — every other setting in the file must be left byte-identical.
- [ ] Maintain the place-types file alongside it.
- [ ] ⚠ Person types must receive their create and edit form references. Without them CHT offers no
      way to add that person, and the omission is invisible until someone looks for the button.
- [ ] Edit leaf-level contact details — name, phone, supervisor — through the contact forms.
- [ ] ⚠ **Make no unrequested semantic changes.** Editing a display name must not re-derive the
      hierarchy ordering or backfill properties the author deliberately omitted.

**Not in scope.** Complex restructuring — splitting a district, adding a level or a region — is
explicitly out of MVP.

**Acceptance.**
1. Editing one character of a display name produces a diff containing **only** that change,
   asserted against a real project folder.
2. A three-level hierarchy plus one person type is created through the guided flow, deploys, and the
   "add person" affordance appears in CHT.

---

## T5 · F5 — Basic contacts

**Importance:** Must have · **Size:** M · **Depends on:** T4

**Why.** Contact create and edit forms per type are what make people addable and updatable at all.
The design doc names household, household member and CHW as the baseline.

**Scope.**
- [ ] Generate a minimal-valid create form and edit form for each contact type.
- [ ] Regenerate over existing forms, behind a clear diff and confirmation, since these are files
      the author may have edited.
- [ ] ⚠ Emit the correct relative paths for the audit metadata fields. The hop count depends on how
      deeply the field is nested; getting it wrong yields empty audit fields with no error.
- [ ] ⚠ Follow CHT's on-disk naming convention for contact forms, from which CHT derives the form
      identifier. A form named otherwise is not recognised as a contact form.
- [ ] Apply the same restricted edit subset as app forms (T1).
- [ ] ⚠ When offering contact fields elsewhere in the tool, read them only from real contact forms.
      Template and scaffold files that resemble contact forms must not contribute field values, or
      the tool will offer values that do not exist at runtime and rules authored from the picker
      will never match.

**Not in scope.** Bulk contact import, which the CLI already provides.

**Acceptance.**
1. A generated contact form deploys, and a contact of that type can be created and edited on a live
   instance with the audit fields populated.
2. The contact-field picker offers only values that exist in the project's real contact forms.

---

## T6 · F6 — Basic task creation

**Importance:** Must have · **Size:** L · **Depends on:** T2 for the title; T8 for safe emission

**Why.** From the design doc: create simple single-person tasks — for example a follow-up in N days
— composed safely alongside existing task rules, with a computed identity so re-running the rules
never duplicates a task.

**Scope.**
- [ ] Create a task, appended to the project's existing task rules. ⚠ The existing rules are
      hand-written code. Adding a task must leave every other task **byte-identical**, including
      comments and computed expressions.
- [ ] Choose the trigger: which form submission, selected from the project's real forms.
- [ ] A condition builder for when the task applies: pick a field, an operator, and a value from
      that field's real options. ⚠ For a multiple-choice field the operator must express
      *"any of these"* — an equality test against a multi-select is silently wrong.
- [ ] Support combining conditions with *and* / *or*.
- [ ] The schedule: start, due and end offsets in days, anchored either to the submission date or to
      a date field within the report.
- [ ] Resolution: when the task is considered done — typically the submission of a specific form
      within the window.
- [ ] The action: which form the task opens.
- [ ] ⚠ A computed task identity, derived from the project's own convention, so re-running the rules
      never produces a duplicate.
- [ ] A task title in every project language.
- [ ] **The task → form hand-off**: carry values from the triggering report into the form the task
      opens. ⚠ Two platform constraints: CHT binds delivered content only to nodes that are
      **direct children** of the form's input group, and the report's answers are addressed through
      the report's fields — not the report object itself. A receiving node placed anywhere else
      silently receives nothing.
- [ ] ⚠ **Emit code in the project's own style.** Deploy runs the project's own linter, so
      generated code that does not match the surrounding file's conventions fails the build and
      nothing deploys. Infer style from the file being edited rather than imposing a default, and
      omit unused parameters.

**Not in scope.** Multi-visit temporal tasks and group or household tasks — both explicitly out of
MVP.

**Acceptance.**
1. A single-person follow-up task is authored with a title in each language, deploys at **exit zero
   with no hand-editing**, and appears on a device with the title translated.
2. Opening the task launches the target form **carrying the delivered values**, and those values are
   present in the **submitted report** on the instance — not merely visible on screen.
3. Adding the task leaves every pre-existing task byte-identical.
4. Re-running the rules does not duplicate the task.

---

## T7 · F9 — Safety tests: synthetic patients

**Importance:** Must have · **Size:** L · **Depends on:** nothing

**Why.** The design doc's central safety promise, and a stated acceptance criterion: run synthetic
cases through the old and the new form so that an edit which *should not* change clinical logic
produces identical outcomes. This is the mechanism that makes non-developer editing clinically
defensible.

**Scope.**
- [ ] Define the synthetic-patient case format: inputs, and the expected outcomes.
- [ ] Run a case through the previous and the edited form and diff the outcomes.
- [ ] A *"no clinical change"* gate on an edit, surfaced before deploy.
- [ ] Accumulate cases across revisions, so a behavioural change is only accepted when a clinical
      rule genuinely changed.
- [ ] A workflow simulator: given a sample contact and sample reports, show which forms become
      available, which tasks fire, and what the contact summary computes.
- [ ] An authoring-time validator that runs the deploy pipeline's hard gates before the author ever
      deploys: required files present, identifiers valid, references resolvable, every choice list
      non-empty.
- [ ] ⚠ **Run the real form conversion in continuous integration.** Some classes of broken
      reference are invisible to every on-disk check and surface only at conversion, where they
      block the entire deploy.

**Not in scope.** A full clinical test-authoring interface. Cases may begin as files.

**Acceptance.**
1. Editing a label produces identical synthetic outcomes; editing a condition produces a reported
   difference.
2. Continuous integration fails on a form containing an unresolvable reference.
3. The case corpus grows with each revision, and existing cases keep passing unless a clinical rule
   changed.

---

## T8 · F14 — Round-trip safety and determinism

**Importance:** Must have · **Size:** L · **Depends on:** nothing — but everything depends on it

**Why.** Two acceptance criteria, and the product's central promise: a form with hand-authored
columns round-trips through the builder without losing them, and the same edit always produces the
same output. This is what makes it safe to point the tool at a config someone else wrote.

**Scope.**
- [ ] Preserve columns and sheets the tool does not understand, verbatim and in their original
      positions.
- [ ] Deterministic output: the same edit produces byte-identical results every time.
- [ ] ⚠ **Read a spreadsheet cell's computed result, not its formula text.** A cell containing a
      formula has both; writing the formula text back produces expressions the runtime cannot
      evaluate.
- [ ] ⚠ **Preserve grouping in logical expressions.** Dropping parentheses changes the meaning,
      because *and* binds more tightly than *or*, and the failure direction tends to be permissive.
- [ ] ⚠ **All-or-nothing parsing of code bodies.** Where the tool models only some shapes of a code
      block, it must either represent the whole block or keep the original bytes. Emitting the parts
      it recognised and discarding the rest yields code that compiles and then fails at runtime.
- [ ] ⚠ **Never substitute a convention for the author's input.** Where a value is read and written
      back, write back what was read. Emitting the "standard" form of an expression changes
      behaviour on any project that spells it differently.
- [ ] ⚠ **Scope every find-and-replace.** Renaming or removing a definition must target the
      definition, not the first textual match, which is usually a usage.
- [ ] ⚠ **A rename must rewrite every reference** to the renamed item, across all columns that can
      contain one. A dangling reference blocks the whole deploy.
- [ ] Reuse the platform's own compiler and deploy tooling. Building a parallel implementation is an
      explicit non-goal.
- [ ] Build a **non-canonical fixture corpus**: files in the shapes real projects actually use, not
      in the shape the code expects.
- [ ] Cross-file and cross-language logic lives in the shared parser package as pure functions, not
      inside UI event handlers, so it can be unit-tested at all.

**Not in scope.** Reconstructing an arbitrary hand-written form in the builder's own grammar — the
design doc rules this out; such forms open read-mostly.

**Acceptance.**
1. Opening any panel and saving with **zero edits**, on several real projects of differing
   conventions, produces an **empty diff**.
2. The same edit applied twice produces byte-identical output.
3. Round-trip tests exercise the **writer**, over **non-canonical** fixtures. ⚠ A fixture produced
   by the tool's own writer is already in the shape the code expects and will pass while real input
   corrupts.

---

## T9 · F15 — Complex logic: calculation, relevance, constraint

**Importance:** Must have · **Size:** L · **Depends on:** T1, T8

**Why.** The logic columns are where clinical intent actually lives. The design doc places them in
Phase 2, but they are marked must-have: without them the tool can only edit wording, and a
program cannot own its own decision support.

**Scope.**
- [ ] A visual builder for *show this question when…* — pick a field, an operator, and a value from
      that field's real options.
- [ ] The same for *accept the answer only if…* and for filtering one choice list by another answer.
- [ ] A builder for *compute the value as…*, including a decision-table form for
      if-this-then-that rules.
- [ ] Combining conditions with *and* / *or*, and one level of grouping — enough to express
      *A and (B or C)*.
- [ ] Reference values from elsewhere: an earlier answer in the same form, a field on the contact,
      or a value the project's contact summary already computes. ⚠ All by picking, never by typing
      a reference expression.
- [ ] ⚠ **A raw escape that preserves what it cannot model.** An expression outside the builder's
      grammar must be editable as text and must survive an open-and-save byte-identically.

**Not in scope.** Grouping beyond one level. Deeper nesting multiplies the precedence and polarity
surface for very little expressive gain, and an expression that complex belongs in a computed field
instead.

**Acceptance.**
1. Every value in every builder can be **picked**; no path requires typing an identifier or a
   reference expression.
2. An expression the builder cannot represent round-trips byte-identically.
3. An automated test drives all four builders and asserts the emitted cells on disk.
4. A condition authored through the picker **matches at runtime** on a live instance — verified with
   real data, not by reading the generated expression.

---

## T10 · F16 — AI-assisted authoring (must **start**)

**Importance:** Must start · **Size:** L — spike first · **Depends on:** T1 for the target format

**Why.** The design doc allocates roughly a fifth of the MVP to *starting* this: an optional step
that drafts a form or a clinical pathway from written guidelines and flags gaps, always producing an
ordinary editable form for human review. It runs at build time only.

**Scope.**
- [ ] Evaluate the existing AI tooling in this ecosystem for overlap, before building anything.
- [ ] Assess the collaborating team's clinical-pathway tooling and identify the integration seam.
- [ ] Draft-from-guidelines: a written guideline in, an **ordinary editable form** out, with no
      AI-specific artifacts left in it.
- [ ] Gap and consistency flagging, surfaced for a human to resolve. ⚠ Ambiguity is never resolved
      silently.
- [ ] A layered representation: a clinical-logic model above the form model, compiling down to it,
      so the two teams' tools meet at a defined boundary.
- [ ] A path that works with freely available models. The design doc names this as necessary for
      real adoption rather than a refinement.

**Not in scope, emphatically.** Any AI at the point of care. Runtime stays deterministic. Everything
the AI produces is a suggestion a person approves in the builder, and the builder must work with no
AI available at all.

**Acceptance.**
1. A written guideline produces a draft form that opens in the builder and is fully editable.
2. The builder behaves identically when AI is unavailable.
3. A documented decision on the design doc's open question: which second-phase track — the AI
   pipeline or the constrained visual editor — is invested in first.

---

## Cross-ticket notes

**T8 is load-bearing.** Round-trip safety is not a quality initiative running alongside the feature
work; it is the constraint every other ticket writes against. A feature that emits correct-looking
output while quietly reformatting the rest of the file has not shipped. It is worth building the
non-canonical fixture corpus early, because it is what makes the other nine tickets verifiable.

**Deploy-blocking items outrank ticket order.** Two constraints stop *anything* the tool produces
from reaching an instance: an undeclared input reference fails validation for the entire project
(T3), and generated code that does not match the project's own lint configuration fails the build
(T6). Both are small, and until they hold, the rest of the work cannot be demonstrated end to end.

**Every ticket's acceptance criteria should be exercised against more than one real project.**
Projects differ on nearly every convention available to differ on — how expressions are spelled,
how files are named, how many languages are configured. A behaviour correct on one project and
wrong on another is a defect, not a configuration difference. The rule throughout: **preserve what
you read, derive what you write, refuse what you cannot model.**

**Stretch features are not ticketed here** — templates and reusable blocks, the rendered WYSIWYG
preview, versioning, the governance and sign-off gate, contact summary, standard codes, and the
constrained visual editor. Two of them, versioning and governance, additionally require a user
identity and role concept that no other ticket delivers, so they are larger than their placement
suggests.
