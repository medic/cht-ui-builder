<!--
The operational answer to "let's build the geriatric use case in config-nssd": what you can safely
touch today, what you must not, the git safety net, and the build order with NSSD's own conventions
baked in. Evidence: reviews/nssd-readiness-audit-2026-08-11.md. 2026-08-11.
-->

# Building geriatric in config-nssd — the safe protocol

**Project path to open:** `W:\medic\config-nssd\chis` (**not** the repo root).
**Branch:** `954_geriatric`. **Repo:** real `medic/config-nssd`, so this is a PR, not a sandbox.

> ## The one-line answer
> **Yes, you can start — but only on the two new geriatric forms.** Build them in the tool, in
> config-nssd, today. **Hold the task** until the safety batch lands. Rationale below; the evidence
> is in [`reviews/nssd-readiness-audit-2026-08-11.md`](reviews/nssd-readiness-audit-2026-08-11.md).
>
> This works because the corruption lives in **reading files somebody else wrote**. The geriatric
> forms are files *we* write — no Excel formulas, no `choices-backup`, no hand-written JS. Almost
> none of the damage applies to them.

---

## 🟢 Green — safe, measured

| Action | Evidence |
|---|---|
| **Open the project** | All open-path + required files present; nothing recurses `node_modules`; 2.75 s cold, 0.5 s warm |
| **Create a new app form** | New file, no legacy formulas. *One caveat:* it appends to `form-constants.js` in the wrong shape — see the checklist |
| **Edit survey / choices on a form the tool created** | Headers byte-identical 70/70, zero rows lost, all unknown columns preserved |
| **Edit its `.properties.json` title / context** | Fine on a *new* form. **Not** on an existing one — see red list |
| **Translations grid, for keys that appear once** | Byte-identical no-op, 0 failures in 4,024 edit simulations |
| **Read anything** | Browsing, viewing, the Decisions view — all read-only |

## 🔴 Red — do not touch until fixed

| Do not | What happens |
|---|---|
| **Open any of the 19 contact forms** (`c10_center` … `c82_person-edit`, `PLACE_TYPE-*`) | Saving rewrites `relevant` `false()` → `FALSE()`; the whole place hierarchy stops compiling correctly |
| **Click into the appliesIf builder or resolvedIf picker on any of the 29 existing tasks** | 25–26 tasks start firing for **dead and muted patients**; 4 throw `ReferenceError`; 7 lose their resolution guards; 2 fire for **everyone** |
| **Save the Hierarchy editor at all** | Injects `create_form` into 2 staff types; any detail edit appends `c80_household` to `place_hierarchy_types` |
| **Contact Summary → Helpers tab** | Standing rule already. Here it's worse: `removeHelper` can blank every contact profile on every device |
| **Contact Summary → Cards tab** | De-indents the cards array and breaks NSSD's own eslint gate |
| **Edit `context.expression` on any of the 24 existing app forms** | Parens dropped → eligibility flips **false→true** on 11 forms; deceased/muted contacts become eligible; **every validator says it's fine** |
| **Rename a survey row on an existing form** | 37 `${}` refs left dangling → pyxform **hard-fails the whole config** |
| **Edit any of these 10 forms at all** | `settings.version` becomes a timezone-stamped date string: `breast_cancer`, `breast_cancer_followup`, `death_report`, `mute`, `unmute`, `pnc_danger_sign_follow_up_baby`/`_mother`, `pregnancy`, `pregnancy_danger_sign`, `pregnancy_home_visit` |
| **Edit these 7 forms** (overlaps above) | `choices-backup` sheet trashed, 63 → 1000 rows: `mute`, `unmute`, `pregnancy`, `pregnancy_danger_sign`, `pregnancy_home_visit`, `pnc_danger_sign_follow_up_baby`/`_mother` |

## 🛡 The safety net — use it after every single save

config-nssd is under git. That makes damage **measurable and reversible**:

```sh
git -C W:/medic/config-nssd diff --stat
```

**Rule: if a file you did not intend to edit appears in that list, revert it immediately.**

```sh
git -C W:/medic/config-nssd checkout -- <the file you didn't mean to touch>
```

Commit after each good step so `diff` always compares against a known-good point. Do this even when
you're sure — six of the nine defects fire on a save with **zero** user edits.

---

## The build order

### Phase 1 — the two forms (today)

**The IHA form already in the tree needs rework before it's shippable.** It was built on a scratch
project and copied in; measured against NSSD's 70 forms it deviates on six counts:

| # | Problem | NSSD convention |
|---|---|---|
| 1 | **Monolingual English** — the only survey sheet of 70 with no `label::ne`, the only properties.json of 36 with an en-only title. **The instance locale is `ne`.** | Header spelling is exactly `label::en` / `label::ne` — bare ISO codes, never `label::नेपाली (ne)`. Add `hint::ne`, `constraint_message::ne` too |
| 2 | **Name is 54 chars, mixed case** (`Integrated_Health_Assessment_form_for_elder_population`) | 35 of 36 app forms are strict `lower_snake_case`; longest native id is 40. Use **`geriatric_health_assessment`** and **`geriatric_referral_followup`** — mirroring `child_referral_followup`, `pnc_referral_followup_form` |
| 3 | **`inputs` group deviates on 4 of 6 elements** | The skeleton is **100% uniform across all 36 app forms**: `db:person \| _id` with `db-object` appearance, `hidden \| source_id`, `calculate \| patient_uuid`, `calculate \| patient_name = ../inputs/contact/name`. Drop the `inputs/user` group unless you need `created_by` (only `delivery` has it) |
| 4 | **Context expression has none of the standard gates** — currently just `ageInYears(contact) >= 60`. Without the person gate it is offered on the **6 staff person types** and on muted/deceased contacts | `contact.contact_type === 'c82_person' && ageInYears(contact) >= 60 && !contact.muted && !contact.date_of_death` — 19/21 person forms start with the type gate, 17/21 carry `!muted`, 18/21 carry `!date_of_death` |
| 5 | **`icon: ""`** | Register a real key in `resources.json` and drop the SVG in `chis/resources/` |
| 6 | **Zero `report.*` translation keys** | NSSD ships 834 en + 1337 ne `report.<form_id>.<group>.<field>` keys across 34 of 36 forms. Without them, submitted reports show raw XForm node paths instead of question text |

✅ **Good news:** `ageInYears(contact) >= 60` **will work** — `date_of_birth` is a required field on
`c82_person-create` and lands on the contact doc, and the 6 staff person types don't capture it so
they can't satisfy the predicate anyway.

**Steps**

1. Commit the current clean state so `git diff` has a baseline.
2. Rename → `geriatric_health_assessment` (xlsx + `.properties.json` + delete the stale `.xml`).
3. Open it in the tool, add the `ne` locale, fill the Nepali labels, fix the `inputs` block and the
   context expression. **`git diff --stat` after each save** — only that form's three files may move.
4. Build `geriatric_referral_followup` the same way, 16 rows, each domain gated on its flag.
5. Add the 7 hidden `refer_*` calculates to the assessment (Calculate tile + if-then condition
   builder) — the contract between the two forms and the task.
6. `cd chis && npm run compile-forms` — this must pass before anything else.
7. Hand-add both form ids to `form-constants.js` in **NSSD's shape** (`geriatric_health_assessment:
   'geriatric_health_assessment'`) — the tool writes `NAME: ['name']`, which is wrong for this config.
8. Commit.

### Phase 2 — the task (blocked, and for good reasons)

Three independent blockers, all in the safety batch:

- **`modifyContent` emits `report.<field>`** — a form-answer access that appears **0 times** in
  4,000+ lines of NSSD rules code. NSSD reads answers with `Utils.getField(report, 'dotted.path')`
  (29 uses) or `report.fields.X` (10 uses). What we emit reads `undefined` at runtime and silently
  delivers an empty node. *8 keys in NSSD's own `tasks.js` already fail this way.*
- **No receiver-node authoring** (W3/W4). NSSD has two valid placements; the newest convention —
  used by hypertension, diabetes, become, pnc_referral — is a **top-level `hidden` row carrying
  `instance::tag = hidden`**, named `<source_field>_ctx`. The tool can't author either.
- **The rule-builder P0s.** Building the task means being in the Tasks editor next to 29 tasks that
  corrupt on a stray click.

**When it unblocks, the shape is known** (model on `tasks.js:340`, `referral_followup_pills_depo`):

```js
{
  name: 'geriatric.referral_followup',          // dotted snake — 0 of 29 NSSD task names use hyphens
  title: 'task.geriatric.referral_followup',    // 13/29 use exactly 'task.' + name
  appliesTo: 'reports',                         // 28 of 29 tasks
  appliesToType: ['geriatric_health_assessment'],
  events: [{ id: 'geriatric-referral-followup-visit', days: 30, start: 15, end: 15 }],
}
```
Add `task.geriatric.referral_followup` to **both** `messages-en.properties` and
`messages-ne.properties` — cht-core has **no default-language fallback**, so a title in only one
locale renders as the raw key on the other locale's handsets.

---

## Two tool quirks to expect

- **Deploy → "Select changed" will always show zero forms.** The git root sits one level above the
  project root, so the porcelain paths never match. Select forms manually.
- **Preflight will report 20 blocking errors** on `pnc_service_form`, `pregnancy_home_visit` and
  `become_sessions`. All false positives — pyxform already compiled every one. The deploy button is
  gated on that count.

## Definition of done for the PR

`.xlsx` + compiled `.xml` + `.properties.json` for both forms; `npm run compile-forms` then
`npm run compile-app-settings` green (**don't commit `app_settings.json`** — it's generated and
gitignored); both form ids in `form-constants.js`; the task-title key and the `report.*` key blocks
in **both** `.properties` files; and a `chis/test/tasks/geriatric.spec.js` following
`hypertension_screening_and_referral.spec.js` — NSSD has 14 harness specs covering tasks and a PR
without one will stand out.
