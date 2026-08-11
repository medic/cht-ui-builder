<!--
The plain-language companion to nssd-initial-assessment-2026-08-11.md. Same findings, same
measurements, but each one explained with a concrete example of what a CHW would actually see.
Written for the PO / squad / MOH audience rather than the dev. 2026-08-11.
-->

# NSSD detailed assessment — what breaks, and what it looks like

**Companion to** [`nssd-initial-assessment-2026-08-11.md`](nssd-initial-assessment-2026-08-11.md),
which carries the counts, commands and file:line references. This one explains the same findings in
plain language, with a concrete example for each.

**What was tested:** the no-code editor's parsers against `W:\medic\config-nssd\chis` — Nepal's
deployed national CHT config. 36 app forms, 34 contact forms, 29 tasks, an 8-level hierarchy, 425 KB
of translations. Seven parallel lanes; the four critical ones handed to a second auditor whose only
job was to break the first one's conclusions.

> **The through-line.** Every defect below produces **valid, working-looking output.** The config
> compiles, `npm test` passes, the deploy succeeds, and the damage reaches phones. Nothing warns
> anybody. That is what makes this batch different from ordinary bugs.

> **These are not "NSSD problems."** See [`../principle-config-agnostic.md`](../principle-config-agnostic.md).
> NSSD was simply the first real config we opened, so it was the first to expose defects that were
> always there. Compared across the four real configs on disk, they disagree with each other on
> almost every convention we hardcoded — the argument style we always emit is used by **1 of 4**;
> our generated task-title key shape is used by **none**; duplicate translation keys exist in **all
> four**. Read every finding as *"we hardcoded one project's convention and called it the standard."*

---

## 1. The hidden block stops being hidden — 19 of 34 contact forms

Every "register a place or person" form opens with a group called `inputs`. It holds machine-filled
values — the logged-in user's contact id, their place id, their name. A CHW must never see it. So
the spreadsheet cell controlling visibility contains the **Excel formula `=FALSE()`**: *never show
this.*

Our parser reads that cell and gets back the **text** `FALSE()` instead of the **value** `false`.

**The analogy:** you copy a spreadsheet cell and paste it as *text*. The cell used to *compute*
FALSE; now it literally contains the six characters `F-A-L-S-E-(-)`.

```
on disk (the formula):    =FALSE()
committed .xml:           relevant="false()"     ← correct, what CHT expects
after our save:           relevant="FALSE()"     ← not a function that exists
```

XPath is case-sensitive. `false()` exists; `FALSE()` does not. When the form runs, that line errors.

**Why we never saw it:** the Excel library keeps a formula's cached result *only if it is truthy*.
`false` is falsy, so it is discarded, and our code falls back to returning the formula's **source
text**. It only bites formulas that evaluate to false, zero, or blank — a shape none of our own
scaffolds ever produced.

**Who it hits:** center, province, district, municipality, ward, CHN area, FCHV area, household
(create *and* edit each), plus person-edit. **That is every route by which NSSD registers a place or
a person.**

## 2. Dead patients keep getting tasks — 25 of 29 tasks

NSSD's actual helper:

```js
function isAlive(contact) {
  if (contact && contact.contact && contact.contact.date_of_death) return false;
  if (contact && contact.reports && contact.reports.some(r => r.form === 'death_report')) return false;
  return true;
}
```

It expects the **whole bundle** — the person *and* their reports. Our serializer always writes
`isAlive(contact.contact)`, handing it **just the person**.

So it looks for `contact.contact` — the person inside the person — and finds nothing. Then it looks
for `contact.reports` and finds nothing. No death date, no death report. **Returns "alive". Always.**
`isMuted` likewise always returns "not muted."

The change is almost invisible on the page:

```
BEFORE: if (!isAlive(contact) || isMuted(contact)) { return false; }
AFTER:  if (!isAlive(contact.contact) || isMuted(contact.contact)) { return false; }
```

**What a CHW sees:** a woman on the breast-cancer pathway dies. Her family files a death report. Her
CHW's phone keeps showing *"follow up on breast cancer diagnosis"* — indefinitely. The same for muted
households, which is how NSSD pauses families that have moved away or are in a sensitive situation.

Affected pathways: breast cancer, cervical cancer, child health, ANC home visits, PNC danger signs,
IUCD/implant, hypertension, diabetes.

**Trigger:** clicking into that task's rule builder and pressing save. **No edit required.**

## 3. A 30-year-old man gets the childbirth form — 11 of 24 forms

The `delivery` form's eligibility rule, before and after our save:

```
BEFORE: person AND female AND show_delivery_form AND (no-DOB OR aged 15–49) AND not-muted AND not-deceased
AFTER:  (person AND female AND show_delivery_form AND no-DOB) OR (aged 15–49 AND not-muted AND not-deceased)
```

We drop the brackets. AND binds tighter than OR — the same precedence rule as × before + in
arithmetic, where `2 + 3 × 4` is not `(2 + 3) × 4`.

The second half now **stands on its own**: anyone aged 15–49 who isn't muted or deceased gets the
delivery form. No gender check. No person-type check. `show_delivery_form` gone entirely.

Same shape on `child_health_screening`, `pregnancy`, `pregnancy_home_visit`, `married_woman_
reproductive`, `edu_status_5_18_yrs`, `mental_health_screening`, `under_5_child`, `mute`, `unmute`,
`pregnancy_surveillance_form`.

Two auditors built **independent** synthetic contact populations (448 and 672 states) and flagged the
**same 11 files**, with **every flip in the "more people see it" direction**.

**And every guard we own says it's fine:** our validator returns zero warnings, it's valid
JavaScript, and saving twice produces identical text — so even the round-trip stability test passes.

## 4. A task that crashes on every patient — 4 tasks

Some task rules do work before they decide. Roughly:

```
let motherDied = <look up the death report>
...
if (motherDied) return false
```

We delete the line that **defines** `motherDied` and keep the line that **uses** it. JavaScript then
has no idea what that name refers to and throws.

**The analogy:** deleting the cell a spreadsheet formula points at, but keeping the formula. You get
`#NAME?`.

It's still valid JavaScript, so it compiles, deploys, and ships — then throws once per contact
inside the rules engine on the phone. `pnc_service_after_delivery`, `anxiety_session_1`,
`depression_session_1`, `motivational_interviewing`.

**We already detect this.** The parser sets a "couldn't fully understand this" flag on all four. The
serializer just never reads it.

## 5. Two tasks that fire for everybody

Where a rule is written as a plain reference to a checker function — *"use this checker"* — we turn
it into a function that **hands back the checker itself** instead of running it.

**The analogy:** asked *"is the door locked?"*, you hand over the key. Any answer that isn't
"nothing" counts as yes.

So the condition is always true. `mental_health.mental_health_referral_followup` and
`cervical_cancer.referral_followup` would raise a task for **every matching report on every
patient.**

## 6. A task that is already finished the moment it appears — 7 tasks

"This task is done when the follow-up form is submitted during the task's window."

The hand-written versions clamp the window's **start** so it begins *after* the report that triggered
the task. NSSD comments the reason in its own code:

```js
const startTime = Math.max(addDays(dueDate, -event.start).getTime(), report.reported_date + 1);
//+1 so that source ds_follow_up does not resolve itself
```

We recognise these rules by searching for one function name **anywhere in the text**, then replace
the **entire** hand-written body with a generic template — dropping the clamp, the early exits, the
extra conditions and the comments.

Without the clamp, the window opens *before* the triggering report, so an older submission of the
same form counts as the answer. **The task is born already resolved and the CHW never sees it.**
PNC mother and baby danger signs, IUCD/implant complications, pills/depo referral,
balanced-counselling family planning.

## 7. Every patient profile goes blank

`contact-summary-extras.js` is a library of ~37 small functions that compute what shows on a
patient's profile. Deleting one should remove its definition **and** its entry in the file's export
list.

Instead we delete the definition, then run a find-and-replace for the name across the **whole file**
— and the first surviving match is usually a **place where the function is used**, not the export
list. So we damage a working line somewhere else entirely. For 15 of 22 exported helpers we also
leave a broken name in the export list, and then **the whole file fails to load.**

**What that means on a phone:** contact summary produces nothing. Every patient profile renders
empty, and the 7 `summary.*` flags all become undefined — so the pregnancy, delivery, cervical-cancer
and breast-cancer-follow-up forms **disappear from every CHW's device.**

**This cannot happen today** — only because of finding 9. That is a coincidence, not a safeguard.

## 8. Saving the hierarchy screen changes the app

Open the Hierarchy editor, change **nothing**, press save: the two staff types (CHN staff, FCHV
staff) gain a `create_form` they deliberately don't have. CHT then renders a *"+ New CHN staff"*
button that was never supposed to exist.

Type **one character** in a display name and `c80_household` gets appended to the hierarchy list,
which deliberately excludes it.

## 9. Nepali edits that silently don't apply — 113 keys

`messages-ne.properties` lists **127 keys twice** (106 of them with different text). CHT uses the
**last** copy. Our editor writes the **first**.

So: you fix a Nepali string, the grid shows your new text, you deploy — and the phone still shows the
old text, because CHT read the second copy. Meanwhile your edit overwrote the first copy. The change
is invisible *and* destructive.

Related, and the reason 7 is currently harmless: the editor looks for `contact-summary.extras.js`
(dot); NSSD and the cht-conf convention use `contact-summary-extras.js` (hyphen). 34 KB and 50
functions are invisible to the editor, and "+ New helper" writes a file nothing ever loads.

## 10. Renaming a question can stop the whole config compiling

Rename a question and **37 references** elsewhere in this config are left pointing at a name that no
longer exists. pyxform then refuses to convert — **not just that form, the entire config.**

---

## What this means for the geriatric task

Roughly **7 of 10 parts are buildable today**, 2 more with a hand-edit, 1 genuinely blocked.

| Part | Status |
|---|---|
| Create the task entry | ✅ Safe — 29/29 existing tasks stay pristine, no-op save byte-identical, single-edit drift zero |
| Trigger form (`appliesTo` / `appliesToType`) | ✅ picker-driven |
| Window — due +30, visible from +15, expires +45 | ✅ picker-driven |
| Name, title, icon, priority | ✅ (title key needs a hand-fix to match NSSD's convention) |
| Action — opens the Referral Follow-up form | ✅ picker-driven |
| Condition — OR of the 7 `refer_*` flags | ✅ connector pill handles it |
| **"Patient is alive / not muted" guard** | ❌ **breaks on a new task too** — the argument is hardcoded regardless of what you pick, so the guard silently does nothing. *Hand-edit around it* |
| **Resolution rule** | ❌ template drops the start clamp (finding 6). *Hand-write it* |
| **Carrying the flags into the follow-up form** | ❌ we emit a form-answer access that appears **0 times** in 4,000+ lines of NSSD rules code. **No workaround** |
| **The receiving fields in the follow-up form** | ❌ can't be authored (the W3/W4 seam) |

The last two are the real block, and they are the same seam we've been tracking since 2026-08-08.

**Standing risk while building:** you'd be working beside 29 tasks that corrupt on a stray click into
their rule builder. `git diff --stat` after every save.

---

## What genuinely works — measured, not assumed

- **Opening the project.** Everything the editor needs is present; nothing recurses into
  `node_modules`; forms list cleanly in 8 ms.
- **Editing questions and answer options.** Column headers **byte-identical across all 70 forms**,
  including every bilingual variant. **Zero data rows lost anywhere.** Every column we don't model
  (`relevant`, `appearance`, `calculation`, `constraint`, media, custom namespaces) preserved. *This
  is the core invariant holding under real load.*
- **`tasks.js` structure.** 29/29 tasks parsed and recognised; a save that changes nothing is
  **byte-identical**; editing, deleting, reordering or appending a task leaves the other 28
  **bit-perfect**. The per-entry splice fix holds at real scale — the damage above is in the rule
  *interpreters*, not the file writer.
- **`base_settings.json`.** Formatting untouched, key order preserved, `roles`/`permissions` and 24
  of 27 keys provably unchanged, and our contact-type model covers **100%** of what NSSD actually
  uses — nothing dropped.
- **Translations at scale.** Byte-identical no-op on both files and **zero failures across 4,024
  per-key edit simulations**; every awkward shape in there (escaped spaces, tabs, trailing
  whitespace, a malformed line) survives. The duplicate-key bug is the single real defect.
- **`targets.js`.** **No write path exists anywhere in the editor.** It cannot be damaged.

## Why our own testing missed all of this

Every defect here passes the full gate: preflight passes, the validators return no warnings,
`compile-app-settings` passes, `npm test` passes — and finding 3 even survives a
parse→serialize→parse byte-stability test, because the corruption is *idempotent*.

This is the fifth instance of one pattern: **the test input was already in the shape the code
assumed.** `isAlive(contact.contact)` genuinely **is** the documented CHT-standard shape — our
parser's own header comment says so, and every fixture we ever wrote used it. NSSD doesn't, and
nothing told us.

**The rule this adds:** a serializer must **re-emit what the input actually said**, never substitute
the convention it expects. If the model can't hold a value — an argument, a bracket, a variable
declaration — that's a gap to fix, not a licence to write the canonical form. And regression tests
for this class must assert **semantic equivalence over a range of inputs**, not string stability.
