<!--
Two PO directives (2026-08-06): (1) never rewrite a helper call's argument — preserve it
verbatim; (2) let users ADD a translation key, offering a dropdown of CHT-convention
suggestions. Supersedes P0 item ③ wording in p0-verification-30c3d92-2026-08-05.md and
promotes P2-8 out of the tail. CHT conventions grounded via the cht-specialist skill.
-->

# Handoff — argument preservation + add-a-translation (PO directives, 2026-08-06)

## 1 · Never rewrite a call's argument — preserve it verbatim  🔴 P0 (data-safety)

**PO directive:** *"I don't want to do `isAlive(contact.contact)` — wouldn't make sense."* Clarified 2026-08-06: **the objection is that it is not intuitive.** That adds a second, usability requirement on top of the data-safety one below — see §1b.

**The rule this establishes, stated generally: the tool must never substitute, normalise, or "correct" an argument the author wrote.** Whether `isAlive(contact)` or `isAlive(contact.contact)` is semantically right in a given config is the config author's call, not ours — and rewriting it violates the round-trip invariant regardless of which one we think is better. This is broader than the one function: it is the same principle as "structured where we own it, raw/verbatim where we don't."

**The defect (pre-existing; verified identical at `3fa6d39^` / `3fa6d39` / `30c3d92`):** `classifySimple` (`shared/src/tasks/appliesIfParser.ts:513-519`) matches `fn(args)` and returns `{kind:'is_alive'|'is_muted'|'has_error'|'is_task_user'}` **discarding the actual argument**; `ruleToGuardSource` then hardcodes one on emit (`:788-797` — `contact.contact`, `user`). A zero-edit open+Save therefore rewrites the author's code.

**Live damage it causes today** (both reproduced):
- `server/templates/malaria/tasks.js` — `if (!isAlive(contact) || isMuted(contact))` → `isAlive(contact.contact)`. Malaria's own helper is `isAlive(c) { return c && !c.date_of_death; }`, so **before** the rewrite the guard never fires; **after**, it fires for dead contacts. We corrupt our own shipped template.
- cht-default helper bodies — `isActivePregnancy(thisContact, …)`'s `!isAlive(thisContact)` becomes `isAlive(contact.contact)`, where `contact` is **not in scope** → `ReferenceError` on device.

**Fix:**
1. **Record the actual argument text** on each of the four well-known rule kinds at parse (e.g. `arg: string`), and emit **that** verbatim in `ruleToGuardSource` — never a hardcoded literal.
2. **If a call's arguments don't match what the kind expects, do not classify it** — keep it as a `raw` rule (which now round-trips correctly thanks to `fromGuard`). Refusing to structure is always safer than structuring lossily.
3. Do **not** attempt to "upgrade" or normalise existing configs as a side effect. No silent migrations.

**Tests (must exercise the serializer — see the memory note):** for each of the four kinds, parse→serialize a call with (a) the conventional arg, (b) a *different* arg, (c) an extra arg, (d) a member expression, (e) no args — assert **byte-stable** in every case, and assert (c)/(e) fall back to `raw` rather than being classified. Add `server/templates/malaria/tasks.js` and a cht-default helper body as **fixtures** — our own templates must be byte-stable through a no-op open+Save. That fixture alone would have caught this.

### §1b · …and never make a no-code user look at that plumbing (the intuitiveness half)

**Why `contact.contact` reads like a typo but isn't:** CHT hands `appliesIf` a **wrapper**, not the person record — `appliesIf: function(contact, report)` where the actual doc is `contact.contact` (which is why `contactLabel` defaults to `contact.contact.name`). So the expression can be *technically* right and still be unreadable to a health-program owner. The data-safety fix above stops us **changing** the author's code; this half stops us **showing** that plumbing to someone who shouldn't have to reason about it.

**Requirements:**
1. **The rule row must read as plain language.** The four well-known kinds already add via friendly buttons (`+ alive check` etc., `AppliesIfBuilder.tsx:286-289`) — the *row* must likewise render as e.g. **"Patient is alive"** / "Patient is not muted", with no argument expression visible in the default (Visual) view.
2. **The generated-JS preview is advanced-only.** `AppliesIfBuilder.tsx:299-300` renders `<pre>{serializeAppliesIf(parsed)}</pre>` unconditionally — that is where `isAlive(contact.contact)` actually reaches the user's eyes. Collapse it behind a disclosure ("Show generated code"), default closed. Note that after §1's fix the preview will show **what the author wrote** rather than our substitution, which resolves most of the surprise on its own.
3. **For a NEW rule the tool must not invent a shape.** Since correctness depends on how the project's *own* helper is defined (malaria's `isAlive(c)` expects a doc, so its own `isAlive(contact)` never fires), do **not** hardcode a favourite. Prefer, in order: (a) match the form already used elsewhere in that project's `tasks.js`; (b) failing that, emit the CHT-documented shape and say so in one line of helper text next to the row. Never silently pick and never rewrite an existing one.

**Acceptance:** a non-technical user building the geriatric tasks never sees the token `contact.contact` anywhere in the default view; an existing config's `isAlive(contact)` still reads back as "Patient is alive" **and** saves byte-identically.

> **Related, same batch, same principle (from `p0-verification-30c3d92-2026-08-05.md`): statement/declaration loss.** Change the whole-body-raw fallback gate at `:344` from `rules.length === 0` to **"any unclassified statement present"**. Both defects are the same root error — *partial recognition that discards what it didn't understand instead of declining to structure.* Fix them together.

## 2 · Add a translation key, with a dropdown of CHT-suggested keys  🟠 P1 (promoted)

**PO directive:** *"in case of translations allow users to add a new translation — for now create a dropdown of what translations CHT suggests to choose from, and allow them to add."*

This also **answers the open scope question**: we are *not* taking the literal-single-locale-title shortcut. Real translation keys stay the path, so the tool must make creating them no-code. This promotes former P2-8 above the P1 tail, and it **unblocks the durable geriatric regression spec** (17 task rows are currently FRICTION solely on the title axis).

### Current state (grounded)
- `client/src/ui/TranslationsEditor.tsx` is a key × locale grid whose rows are the **sorted union of keys already on disk** (`:88-91`) — there is **no add-key affordance at all**, so a key that exists in no file can never be created in-app.
- `client/src/ui/TasksEditor.tsx:559-580` (`TitleFieldWithI18nHint`) is a bare `<input>` that *detects* a key-shaped string and prints a hint telling the user to go edit `.properties` files by hand. Helpful, but it's an instruction to leave the tool.

### CHT conventions to seed the dropdown (from the cht-specialist reference)
| Purpose | Convention |
|---|---|
| Task title | `task.<name>.title` (e.g. `task.anc.delivery.title`, `task.family_survey.title`) |
| Task priority label | same shape, e.g. `task.<name>.priority_label` |
| Target title / subtitle | `targets.<id>.title` · `targets.<id>.subtitle` |
| Contact type | `contact.type.<type>` · `contact.type.<type>.plural` |
| SMS / message | `messages.<event>.<state>` |
| Core-defined (already exist; offer for override) | `task.overdue`, `task.due`, `task.upcoming`, `Messages`, `Tasks`, `Reports`, `People`, `Targets` |

> ### ⭐ REVISED 2026-08-08 (PO) — lead with the label inputs, not the key picker
> **PO question: "why can't this just work like adding choices — the same UI when adding a
> tile?" Answer: it can, and it should. This supersedes the ordering below.**
>
> **Why it *looked* different (and why that doesn't matter):** a question or choice label lives
> **inside the form file** as a `label::<locale>` column — the tool owns one file. A task title
> lives in `tasks.js` as a **translation key**, with the strings in **separate**
> `messages-<locale>.properties` files. That's *indirection*, not a barrier: it means the tool
> writes to three files instead of one. It does not change what the user should see.
>
> **The design, therefore, is exactly the choices design:** the task's Title field renders
> **one input per project locale** — `English` / `नेपाली` — stacked, identical to the per-locale
> choice-label row shipped in `8eda602`. Behind it the tool:
> 1. **auto-derives the key** from the task name using the CHT convention `task.<name>.title`
>    (label-first slugify, numeric suffix on collision — same helper as everywhere else);
> 2. writes that key into `tasks.js`;
> 3. writes each typed string into its `messages-<locale>.properties`.
>
> **The user never sees or types a key** — which is the standing "identifiers are auto-derived,
> never typed" principle, applied to the one surface that still violated it.
>
> **Reopening an existing task:** resolve the key against the `.properties` files and show the
> **resolved strings** in the same inputs; edits write back to the `.properties`, and the key
> itself stays stable (never rename on a title edit — that would orphan the strings, the same
> trap as renaming a field mid-collection). A **literal** (non-key) title — which real configs do
> use — displays as a single value with an offer to *"make this translatable"*. The raw key
> stays visible as an advanced/read-only detail so a power user can still see what shipped.
>
> **All the plumbing exists** — verified: `GET /api/translations` already discovers the project's
> locale files, `PUT /api/translations/:locale` writes them and **creates a missing file**
> (added during the add-language work). This is wiring, not new infrastructure.
>
> **The key-suggestion dropdown below is still worth building — but as the `TranslationsEditor`
> surface, not the task author's path.** It serves the different job of filling in keys that
> already exist in a config (and the "referenced but missing" group is genuinely useful there).
> The task author should never reach it.

### Design
**A · "+ Add translation key" in `TranslationsEditor`.** A dropdown (a `<select>` with an "Other / custom…" escape, matching the `ChoiceValueInput` pattern already shipped) whose options are grouped, **best source first**:

1. **"Referenced in your config but missing"** — the highest-value group and the reason to build this. The tool already knows every `title`/`priorityLabel` in `tasks.js`, every target id, and every contact type, so it can compute *keys the config references that no `.properties` file defines* — i.e. **dangling translation refs**. Offer those directly; each is a key the user demonstrably needs.
2. **"Suggested for this project"** — convention templates instantiated with the project's real names: for each task, `task.<its name>.title`; for each contact type, `contact.type.<id>` + `.plural`; etc.
3. **"CHT standard keys"** — the core-defined list above (labelled as overrides of built-in strings).
4. **"Other / custom…"** — free text, validated against the key shape (`^[A-Za-z][\w.]*$`) with an inline explanation, not a silent reject.

On confirm, the key is added as a **new row with an empty cell per locale**, focus lands in the first cell, and it flows through the existing batched-edit/Save path (`:113-128`) — **no new write plumbing**. An added-but-still-empty key must be visibly "missing" in every locale (reuse the existing missing-cell treatment at `:254-262`), and Save must not write empty values as if they were translations.

**B · Close the loop in `TasksEditor`.** Replace the bare title `<input>` with **key picker + create**: a dropdown of existing keys (showing the resolved string for the default locale, so the user picks by *meaning* — "ANC follow-up" — not by identifier), plus **"＋ New translation key…"** which pre-fills the convention `task.<task name>.title`, lets the user type the EN/NE strings **inline**, and creates the key. The literal-string path stays available as advanced (existing configs use it). Net effect: **a non-technical user never types a translation identifier** — which is the standing no-code principle.

**C · Locale coverage.** Adding a key must add it to **every** locale file the project has (empty where untranslated), not just the default — consistent with how add-language already appends across `form.locales` / `surveyHeaders.labelLocales` / `choicesHeaders.labelLocales`.

### Acceptance
- Building the geriatric task set end-to-end requires **zero hand-typed identifiers**: pick or create the title key from the dropdown, type the Nepali + English strings inline, done.
- A key referenced by `tasks.js` but absent from every `.properties` file appears in the "missing" group and can be created in one gesture.
- Round-trip: unknown/unrelated keys in every `.properties` file are preserved verbatim (existing `propertiesParser` guarantee — pin it with a test that adds one key to a file containing comments, blank lines, and duplicate keys, and asserts **only** the new line is added).

### Tests
- Unit (`shared/src/translations/propertiesParser`): add-key preserves comments/ordering/unknown keys byte-for-byte; empty value is not emitted as `key =` unless the user actually entered an empty string.
- Unit: the dangling-key computation (config-referenced minus on-disk) over a fixture with a task title, a target id, and a contact type.
- E2E: create a task → pick "＋ New translation key" → type EN + NE → Save → both `.properties` files contain the key with the right values and `tasks.js` references it.

### Small related fix
`TasksEditor.tsx:576-578`'s hint points at `app_settings/forms/translations/messages-en.properties`. The CHT convention (and the cht-specialist reference) is **`translations/messages-<locale>.properties` at project root**; the server's translations route carries a `DIRS` candidate list, so **verify which path this project layout actually uses and make the hint match** — a wrong path in the guidance is worse than no hint. Once **B** ships, the hint becomes redundant anyway.

## Gates
```
pnpm --filter @cht-ui/shared build && pnpm --filter @cht-ui/shared test
pnpm --filter @cht-ui/client build && pnpm typecheck
```
Item 1 is data-safety and ships with the other P0s from `docs/reviews/p0-verification-30c3d92-2026-08-05.md` (parenthesize `:777`, statement-loss gate, HelpersTab gating + delete the false "nothing is dropped" copy, grouped-raw pins, Decisions/MOH polarity). Item 2 leads the P1 batch.
