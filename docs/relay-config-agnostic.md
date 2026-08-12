<!--
Paste-able relay text for the dev and QA sessions, so the config-agnostic principle survives a
/clear of the planner tab. Substance and evidence: docs/principle-config-agnostic.md.
Written 2026-08-11, after the NSSD assessment.
-->

# Relay: the config-agnostic principle, in paste-able form

The full argument and the measurements live in
[`docs/principle-config-agnostic.md`](./principle-config-agnostic.md). This file is just the text to
send, so nothing depends on a chat window staying open.

---

## 1. The shared message — send to both sessions

> **The editor is a product, not a config.**
>
> It has to open **any** cht-conf project and leave everything it doesn't explicitly edit exactly as
> it found it — including conventions we'd have written differently. When it writes something new,
> it copies the shape the project already uses. When it can't model something, it leaves the
> original bytes alone.
>
> Three postures for every token we write:
>
> 1. **Preserve** — never emit a token you didn't read. This now covers arguments, brackets, and
>    variable declarations *inside* expressions, not just unknown columns and sheets.
> 2. **Derive** — when generating something new, take the shape from the project you're in. A
>    hardcoded default is only for a project with no evidence yet.
> 3. **Refuse** — if you can't model a body, emit it unchanged and offer the raw editor.
>    All-or-nothing per body. A guess ships silently; a refusal doesn't.
>
> **And the working rule: a finding in one customer's config is a *product* defect.** Never fix it
> by special-casing that config. **The acceptance test for any fix is "is this also correct in the
> other configs?"**
>
> Evidence: we hardcoded `isAlive(contact.contact)` — used by 1 of our 4 real configs. Two use
> `isAlive(contact)`. Both valid. Stronger still, **the four templates we ship disagree with each
> other**: `cht-default`'s `isAlive` wants the wrapper, `blank`'s wants the raw doc, same parameter
> name. No hardcoded argument is correct even across our own code. We also generate hyphenated
> task-title keys — 0 of 42 real keys use a hyphen. We hardcode one extras filename — two spellings
> exist in the wild. Duplicate translation keys exist in all four configs. The project root sits
> below the git root in 3 of 4. One config runs seven locales.

---

## 2. Rider for the dev

> The safety batch stays, but every fix needs re-justifying as **"the editor now adapts"** rather
> than **"NSSD now works."** Capture the argument rather than swapping the constant; discover the
> filename rather than changing it; derive the key convention rather than hardcoding a second one.
>
> Concretely: emitting `isAlive(contact)` instead of `isAlive(contact.contact)` would fix nssd and
> lumbini and **break gandaki**. That isn't a fix, it's a different hardcode.

**Status — the dev has already done this correctly on the first two items:**

| Commit | Item | Posture | Verdict |
|---|---|---|---|
| `c1a9710` | helper arguments | Preserve, with signature-derived fallback for UI-built rules | ✅ conformant |
| `dd66cef` | task-id separator | Derive from the project's own task names | ✅ conformant |

Both were fixed by **removing** a hardcode, not by replacing it with a better one. That is the
pattern to keep.

**Two corrections to carry forward:**

1. **`c1a9710`'s rationale slightly overstates the gandaki case.** The commit says our one-argument
   re-emit dropped gandaki's second argument. Gandaki's two-argument calls
   (`isAlive(contact.contact, contact.reports)`) are real, but they live in **`targets.js`** —
   which is out of scope for this editor and which our `appliesIf` parser never reads. All four
   calls in gandaki's **`tasks.js`** are single-argument. The fix is right and the Preserve posture
   is right regardless; only the "lossy for the fifth" line needs qualifying, so nobody goes hunting
   for a two-arg fixture in a file we don't parse.
2. **`blank/tasks-extras.js` has an always-true `isAlive`** under the standard call — see the open
   defect box in `principle-config-agnostic.md`. Fix the **helper body**, not the emitted argument.

---

## 3. Rider for QA

> **One config is no longer a passing grade.** A `shared/` change gets exercised against several
> real configs before it's done — the four on disk differ by 9× in form count and 7× in task count.
>
> Don't commit customer configs as fixtures. Distil each divergent shape into a small **synthetic**
> fixture in `shared/src/**` so CI pins it:
>
> - one config with `isAlive(contact)` and one with `isAlive(contact.contact)`
> - both extras filename spellings (`.extras.js` and `-extras.js`)
> - a `.properties` with duplicate keys
> - a form with a falsy formula cell
> - a project nested under a subdirectory
>
> **Hostile and non-canonical by construction** — every one of these defects survived because the
> fixture was already in the shape the code assumed.

---

## Provenance

Everything above is measured, not asserted. Sources:

- Four real configs in `W:\medic\`: `config-gandaki/cht-config`, `config-lumbini`,
  `config-moh-nepal/master-decommissioned`, `config-nssd/chis`.
- Our own four templates in `server/templates/`.
- Comparison table and per-fix reframing: `docs/principle-config-agnostic.md`.
- The findings these came from: `docs/reviews/nssd-initial-assessment-2026-08-11.md` (technical) and
  `docs/reviews/nssd-detailed-assessment-2026-08-11.md` (plain language).
- Queued work: `docs/handoff-nssd-safety-batch-2026-08-11.md`.
