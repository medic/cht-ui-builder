<!--
Standing principle, set by the PO 2026-08-11 after the NSSD assessment: the no-code editor is a
product, not an NSSD tool. Findings from one config are defects in the product. Measured across the
four real configs on disk — gandaki, lumbini, moh-nepal, nssd — which disagree with each other on
almost every convention we hardcoded.
-->

# The editor is config-agnostic — it adapts to the project, the project doesn't adapt to it

**PO directive, 2026-08-11.** The no-code editor is **its own product**, not a tool for
config-nssd. There are many CHT configs and there will be many more. **The editor must tailor itself
to whatever it opens** — never the other way round.

This reframes the whole NSSD assessment. Those findings are **not "things to fix for NSSD."** NSSD
was simply the first real config we pointed the tool at, so it was the first to expose defects that
were always there. Read every finding as: *"we hardcoded one project's convention and called it the
standard."*

---

## The evidence: four real configs, four different answers

Measured on the four configs sitting in `W:\medic\` — all real Nepali deployments, all valid CHT.

| What we hardcoded | gandaki | lumbini | moh-nepal | nssd |
|---|---|---|---|---|
| **`isAlive`/`isMuted` argument** — we always emit `contact.contact` | `contact.contact` ×4 ✅ | **`contact` ×9** ❌ | — | **`contact` ×31** ❌ |
| **Contact-summary extras filename** — we hardcode `contact-summary.extras.js` | `.extras.js` ✅ | `.extras.js` ✅ | *(none)* | **`-extras.js`** ❌ |
| **Task title keys** — we emit hyphenated kebab + `.title` | 4/4 `.title`, **0 hyphens** | 3/3 `.title`, **0 hyphens** | — | 6/29 `.title`, **0 hyphens** |
| **Duplicate translation keys** — we write the first, CHT reads the last | 11 en / 25 ne | 11 en / 27 ne | 1 en / 1 ne | 10 en / **127 ne** |
| **Project root = git root** — assumed by "Select changed" | `cht-config/` ❌ | root ✅ | `master-decommissioned/` ❌ | `chis/` ❌ |
| **Locales** — the UI grid assumes a handful | en, ne | en, ne | **en, hi, id, sw, ne, es, fr** | en, ne, es, fr |
| **Excel formula cells in forms** | 0 | 0 | 0 | present |
| Scale (app forms / tasks) | 7 / 4 | 13 / 9 | 1 / 0 | 36 / 29 |

**Read the top row again.** `isAlive(contact.contact)` — the shape we hardcoded, the shape the CHT
docs use, the shape our parser's own header comment cites — is used by **one of four** configs.
Two use the opposite. Both are correct CHT.

**And the row below it:** our generated task-title key is **hyphenated**, and **zero of the 42 real
task title keys across three configs contain a hyphen.** Our default doesn't match NSSD, doesn't
match gandaki, doesn't match lumbini. It matches only our own `cht-default` scaffold.

**Three rows are universal, not NSSD-specific:** duplicate translation keys exist in **all four**;
the project root sits below the git root in **three of four**; and moh-nepal alone runs **seven
locales**.

### The strongest evidence is our own code, not a customer's

The four templates **we ship** disagree with each other about what `isAlive` wants — same helper
name, same parameter name, opposite meaning:

| Template | Definition | Therefore wants |
|---|---|---|
| `cht-default/tasks-extras.js:11` | `contact && contact.contact && !contact.contact.date_of_death` | the **wrapper** — call it `isAlive(contact)` |
| `blank/tasks-extras.js:4` | `!contact.date_of_death` | the **raw doc** — call it `isAlive(contact.contact)` |
| `malaria/contact-summary-extras.js:4` | `function isAlive(c)` — re-exported into `tasks.js` via an explicit `require` | its own third spelling |
| `empty` | *(no helpers at all)* | no evidence to derive from |

There is no argument the tool could have hardcoded that is correct even across **our own
templates**. That settles it more cleanly than any customer config can: the argument is not a
convention to be known, it is a fact to be **read**.

> **Open defect this exposes — `blank`'s helper is always-true under the standard call.**
> `blank/tasks-extras.js` reads `contact.date_of_death`, but the task engine's `appliesIf` receives
> the wrapper, so the standard `isAlive(contact)` call reads `undefined` and the guard never fires.
> It is latent only because `blank/tasks.js` ships no tasks — it bites the moment a user creates
> their first one, which is precisely the cold-start path. Fix the **helper body** to match
> `cht-default`; do not "fix" it by making the tool emit a different argument.

---

## The three postures

Every generated or rewritten token has to fall into one of these.

### 1. Preserve — never emit a token you didn't read
If a value came from the file, it goes back exactly as it came, whether or not we understand it.
This is the existing round-trip invariant; the new part is that it applies to **arguments, brackets,
declarations and comments inside expressions**, not just unknown columns and unknown sheets.

> ✗ read `isAlive(contact)` → write `isAlive(contact.contact)`
> ✓ read `isAlive(contact)` → write `isAlive(contact)`

### 2. Derive — when you must write something new, take the shape from the project
A default belongs in the code only when the project offers no evidence. If the project already has
29 tasks, their naming, key scheme, argument style and file layout are **the specification**.

> ✗ generate `task.geriatric-referral-followup.title` because that's our house style
> ✓ look at the project's existing task titles, see 0 hyphens and a dominant `'task.' + name`, and
>   match it

Same for: contact-summary extras filename (read the `require()` and use whatever's there), the
`inputs` group skeleton, the locale list, form-id casing, `form-constants.js` entry shape,
receiver-node placement.

### 3. Refuse — when you can't model it, emit the original bytes
Partial understanding must be **all-or-nothing per body**. A rule set that doesn't account for every
statement in a function emits the function unchanged and offers the raw editor. Guessing is worse
than declining, because a guess ships silently.

> ✗ recognise one function name in a body, then replace the whole body with a template
> ✓ require an exact structural match; anything else stays raw and round-trips byte-for-byte

### 4. And the working rule: a finding in one config is a defect in the product
Never fix it by special-casing the config that found it. **The test for any fix is: "is this also
correct in the other three?"** Emitting `isAlive(contact)` instead of `isAlive(contact.contact)`
would fix NSSD and lumbini and **break gandaki** — it isn't a fix, it's a different hardcode.

---

## What this changes in practice

**For the dev.** Most of the safety batch stays as written, but the *reason* changes and so does the
acceptance test. Every fix must be justified as "the editor now adapts" rather than "NSSD now
works":

| Fix | Wrong framing | Right framing |
|---|---|---|
| A2 `isAlive` argument | "NSSD passes `contact`" | **Capture and re-emit whatever argument was there.** For a brand-new rule, copy the shape the project already uses; fall back to the CHT default only if the project has no tasks yet |
| A7 extras filename | "NSSD uses a hyphen" | **Discover the filename** from the `require()` in `contact-summary.templated.js`. Two of four configs use the dot form — both must work |
| A9 duplicate keys | "NSSD has 127 duplicates" | **All four configs have duplicates.** Match `properties`/Java semantics: last wins |
| B4 title keys | "match NSSD's convention" | **Derive from the project's own dominant shape.** Our current default matches no real config |
| C1 git prefix | "NSSD nests under `chis/`" | **The project root is below the git root in 3 of 4 configs.** Resolve the prefix; don't assume |
| A1 formula cells | "NSSD uses `=FALSE()`" | Formula cells come from **how a human authored a spreadsheet**, not from a convention. Any config can have them |

**For QA.** One config is no longer a passing grade. A change to `shared/` must be exercised against
**several real configs of different shapes** before it's called done — the four on disk differ by
9× in form count and 7× in task count, and disagree on nearly every convention.

Do **not** commit customer configs as fixtures. Instead:
1. keep a local corpus sweep that runs against whatever real configs a machine has, and
2. distil each divergent shape into a **small synthetic fixture** in `shared/src/**` so CI pins it —
   e.g. one fixture with `isAlive(contact)` and one with `isAlive(contact.contact)`, one config with
   the dotted extras filename and one with the hyphenated, one `.properties` with duplicate keys,
   one form with a falsy formula cell, one project nested under a subdirectory.

The fixture corpus must be **hostile and non-canonical by construction**. Every one of these defects
survived because the fixture was already in the shape the code assumed.

---

## The one-paragraph version

> The no-code editor is a product, not a config. It has to open **any** cht-conf project and leave
> everything it doesn't explicitly edit exactly as it found it — including conventions we disagree
> with. When it writes something new, it copies the shape the project already uses; when it can't
> model something, it leaves the original bytes alone. A defect found in one customer's config is a
> **product defect**, and the fix is only a fix if it's also right in every other config we have.
