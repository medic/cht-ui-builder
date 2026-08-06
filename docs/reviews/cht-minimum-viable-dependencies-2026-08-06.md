<!--
What a CHT app MINIMALLY needs in order to run, mapped against the squad's Phase 1 (MVP)
scope. Grounded in the cht-specialist reference docs (app-settings, forms, translations,
cht-conf) plus what we learned empirically shipping the deploy pipeline (our own
shared/src/preflight/rules/requiredFiles.ts encodes the hard-required set). 2026-08-06.
-->

# What CHT minimally needs to run — vs. the Phase 1 scope

**Purpose:** the Phase 1 scope lists what a non-technical user should be able to *edit*. This
maps that against what CHT actually *requires in order to function*, so we don't ship an MVP
that edits beautifully and produces an app that won't start.

**Headline finding: Hierarchy is listed as "good to have (might move below)" — it is actually a
hard prerequisite that sits BELOW forms.** Without contact types there is nobody to attach a
form to, no place for the form to appear, and no data replication to the device. It cannot move
below; if anything it moves up.

---

## The dependency chain (each layer needs the one above it)

### Layer 0 — the config won't compile or upload at all
Empirically established while building our deploy pipeline; encoded in
`shared/src/preflight/rules/requiredFiles.ts`.

| File | Severity | Note |
|---|---|---|
| `app_settings/base_settings.json` | **hard fail** | the app's core settings |
| `tasks.js` | **hard fail** | must EXIST even if it's `module.exports = [];` |
| `targets.js` | **hard fail** | same — **this bit us**: `cht compile-app-settings` refuses to run without it, even though targets are out of scope to edit |
| `.eslintrc` | warn | linter fails, compile still succeeds |
| `resources.json` | warn | `upload-resources` warns and skips |

**⚠️ Consequence for the scope: "tasks can be secondary" is true of CONTENT, false of
EXISTENCE.** Tasks and targets are mandatory *files*. Every template and every new project must
ship minimal-valid versions of both or the app never compiles. (Already a standing rule for us:
templates ship minimal-valid versions of everything cht-conf requires.)

### Layer 1 — the contact hierarchy (the real foundation)
`contact_types[]` in `base_settings.json`. Nothing above works without it:

- **A form has nowhere to appear.** Visibility is `context.person` / `context.place` /
  `context.expression`, all of which resolve against contact types. No types → no surface.
- **Nobody can be created.** A contact type is only creatable if it declares
  `create_form` / `edit_form` (`form:contact:<id>:create|edit`). **We hit this**: `patient` had
  no `create_form`, so CHT showed no "+ New patient" button even though the form files existed.
- **No data reaches the device.** Replication is driven by the user's assigned place. A user
  with no place in the hierarchy syncs nothing.
- **A report needs a subject.** App forms attach to a contact; the `inputs/contact` block that
  every form scaffold carries is reading from the hierarchy.
- `place_hierarchy_types` additionally drives the Place Filter.

**So the real order is: hierarchy → contact forms → app forms → tasks.** The scope has forms
first and hierarchy as optional, which inverts it.

### Layer 2 — the form itself
- The `.xlsx` → `convert-app-forms` → `.xml` → `upload-app-forms`.
- `<form>.properties.json`. Per the CHT forms reference, **`icon` is listed as REQUIRED** —
  which independently validates the scope note that icons/resources must be editable, not just
  the sheet.
- `context.person` / `context.place` / `context.expression` decide where it shows.
- `context.permission` is the documented hook for role-gating a form.

### Layer 3 — translations (not cosmetic; structural)
Contact types are displayed via translation **keys**, not literals: `name_key`
(`contact.type.<id>`), `group_key` (`.plural`), `create_key`, `edit_key`. **If those keys don't
exist in `messages-<locale>.properties`, the UI shows the raw key string to the health worker.**
Same for any task title or target title. Also `languages: [{locale, enabled}]` in app_settings
controls which locales the app offers at all.

**Consequence: a hierarchy is not "done" when the types exist — it's done when their translation
keys exist too.** This makes translations a Layer-3 dependency of Layer 1, not a Phase-2 nicety.

### Layer 4 — resources / icons
`resources.json` maps icon keys → files in `resources/`. Both `contact_types[].icon` and each
form's `properties.json` `icon` reference those keys. Missing key → missing icon.

### Genuinely secondary (content-wise)
- **`tasks.js` content** — the file is mandatory, the tasks inside are not.
- **`targets.js` content** — same.
- **`contact-summary`** fields/cards — without it a contact profile is sparse but the app runs.
- SMS / `registrations`, `schedules.json`, `purge.js`.

---

## Three things the Phase 1 scope needs to change

**1. Move hierarchy UP, not down.** It's Layer 1. "Forms won't run without it" is exactly right —
and the sharper version is: without contact types there is no *person*, no *place*, no
*replication*, and no "+ New …" button. Suggested reframing: **Phase 1 = hierarchy + contact
forms + app forms.** We already ship a Quick Hierarchy Creator precisely because a blank
hierarchy is the cold-start wall.

**2. "Assign a form to a persona" pulls in role configuration, which nothing edits today.**
The scope says whole-form visibility per role "is easy". Mechanically it needs either
`context.permission` in properties.json **or** a `user`-based `context.expression`, and then that
permission mapped to roles under `permissions` in `app_settings.json`. Verified in our codebase:
there is **no roles/permissions editor at all**, and the form-visibility builder has **no
user-role rule kind** (it gates by contact type, age, and summary flags only). So this scope item
is currently unbuildable end-to-end — it needs a small roles surface, or it should be explicitly
deferred rather than assumed easy.

**3. Translations are a prerequisite of hierarchy, not a Phase-2 extra.** Declaring contact types
without their `contact.type.*` keys ships an app that shows raw identifiers to health workers.
The scope already lists "translation fixes" as editable — the gap is *creating* keys, which is
exactly the queue item now in flight.

---

## Where we already stand against this list

| Layer | Requirement | Our status |
|---|---|---|
| 0 | All hard-required files present in every template | ✅ shipped (incl. the `targets.js` stub) + a preflight check |
| 1 | contact_types, parents, person/place, create/edit forms | ✅ hierarchy editor + Quick Hierarchy Creator + contact-form generator |
| 1 | `place_hierarchy_types` | ✅ maintained by the hierarchy editor |
| 2 | Form authoring, properties, `context.*` | ✅ shipped, incl. real contact types in the visibility builder |
| 2 | `icon` in properties (**required** per the docs) | ⚠️ a typed id — no picker, and **no `resources.json` editor** |
| 3 | Translations for referenced keys | ⚠️ can edit existing keys; **creating keys is in flight** |
| 3 | `languages` enablement | ⚠️ per-form locales work; app-level `languages` not edited |
| 4 | `resources.json` + `resources/` | ❌ no editor (preflight warns only) |
| — | Roles / `permissions` | ❌ nothing edits it; no user-role rule kind |
| — | tasks/targets content | ✅ tasks editor · targets deliberately out of scope (stub only) |

**Net:** Layers 0–2 are essentially covered; the honest gaps are **icons/resources**,
**creating translation keys** (in flight), and **roles** — and all three are things the Phase 1
scope either names or implies. That's a short, concrete list to take back to the squad.
