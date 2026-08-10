<!--
QA brief: prove the COMPLETE geriatric workflow — assessment → task → referral follow-up →
resolution — built in the tool and exercised at RUNTIME on a live CHT instance. This is the
first probe of the task lifecycle; every prior probe stopped at "the files are correct on
disk". 2026-08-08.
-->

# QA brief — the full geriatric workflow, end to end

**What we're proving is no longer "can the tool author these files."** That's done: the forms
build 10/10 through the UI and deploy. **The open question is whether the whole loop actually
works on a device** — a screening failure raising a task, that task opening the right
follow-up form with the right data, and submitting it closing the task.

## The workflow

```
CHW opens a patient aged 60+
   ↓  (form visible via context: age >= 60)
① Integrated Health Assessment  ── fills it, a screen FAILS ──▶ submit
   ↓  (hidden calculate flags record WHICH domains failed)
② Task fires   appliesTo: reports · appliesToType: [IHA] · appliesIf: any refer_* flag true
   ↓  window: due +30d, visible from +15d, expires +45d
③ CHW taps the task ──▶ it OPENS the Referral Follow-up form
   ↓  (task action + modifyContent carry the refer_* flags into the new form)
④ Follow-up form self-branches — only the failed domains' questions show
   ↓  submit
⑤ Task RESOLVES  (resolvedIf: follow-up form submitted in the window)
```

**One task, not seven.** The sheet's 7 domains are 7 OR-legs of a single task's condition; the
per-domain routing happens *inside* the follow-up form. Reasoning and evidence:
`docs/reviews/geriatric-task-sheet-analysis-2026-08-08.md`.

---

## ⚠️ Read this before you build, or you will lose a day

**The task will NOT appear when you submit the assessment.** CHT event semantics (verified
against the CHT reference): `days` = days after `reported_date` the task is **due**; `start` =
days **before** due to start showing it; `end` = days **after** due to keep showing it. The
spec's 15/30/15 therefore means **due day 30, first visible day 15, gone day 45.**

Submit an assessment today and the Tasks tab is legitimately **empty**. Do not report that as a
bug. To test the lifecycle, either:
- **temporarily set `start` = 30** so the task is visible from day 0 (test this variant first,
  then restore 15 and note the difference), or
- **backdate the report's `reported_date`** on the instance.

State which method you used in every runtime result.

---

## Phase 1 — build it in the tool (no hand-editing)

**1a. The assessment form** — already proven; reuse `geriatric-build.spec.ts` / your at-scale
spec rather than rebuilding.

**1b. Add the referral flags — this is a SPEC GAP we must close, not a build detail.** The
customer's follow-up form says *"if a referral note is triggered for `<section>`"*, but in the
assessment those triggers are **notes**, and notes persist no value — so nothing in the
submitted report records which domain failed. Add **hidden `calculate` rows** to the assessment,
one per domain, as the contract between the two forms and the task:

| flag | true when |
|---|---|
| `refer_cognitive` | either cognitive question failed |
| `refer_mobility` | sit-to-stand > 14 seconds |
| `refer_nutrition` | any of the 3 nutrition questions failed |
| `refer_vision` | any external-eye finding **except** `कुनै पनि छैन`, **or** any acuity fail |
| `refer_hearing` | ear result(s) failed *(the sheet says "and" — assume OR, flag it)* |
| `refer_psych` | any of the 3 psychological questions failed |
| `refer_continence` | continence question failed |

Build these with the **Calculate tile** (now visible in Simple mode) and the condition builder's
if-then mode. **Report the interaction cost** — this is the first real test of authoring seven
multi-condition flags through the UI.

**1c. The Referral Follow-up form** — 16 rows, with each domain's question gated on the matching
flag. This is the form the task opens.

**1d. The task** — in the Tasks editor:
- trigger: `appliesTo: reports`, `appliesToType`: the assessment form (picker)
- condition: **OR of the 7 flags** (connector pill — one level of grouping is enough)
- window: `days` 30, `start` 15, `end` 15 (and the day-0 variant above for testing)
- resolution: "Referral Follow-up form submitted" (ResolvedWhenPicker)
- action: opens the Referral Follow-up form (ActionsEditor)
- **`modifyContent` mappings**: carry the 7 `refer_*` flags from the report into the follow-up
  form so step ④ can branch. **This is the capability under test** — structured mapping pickers
  shipped in Phase 2a; nobody has driven them against a real workflow.

**Expected blocker — record and continue:** the task **title** needs a translation key, which
cannot be created in the tool yet (queue item 8). Use a literal title to get past it and note it.

## Phase 2 — deploy from inside the tool
Use the **one-click deploy** (compile → convert → upload), **not** the CLI. If it fails, that's a
finding — the deploy pipeline is part of the definition of "works" now. Expect the
insert-contact-field bug (`P1-DEPLOY`) if you use patient-name inserts; skip them until fixed.

## Phase 3 — the runtime proof (the actually-new part)
On the live instance, with a CHW user:
1. Create a contact **aged 60+** under the CHW's place. Confirm the assessment form **appears**
   on their profile (proves the `age >= 60` eligibility) — and confirm it does **not** appear on
   an under-60 contact.
2. Fill the assessment, **failing exactly one domain** (start with cognitive). Submit.
3. **Assert the task appears** (with the day-0 window variant), and capture its title, due date
   and contact line as the CHW sees them.
4. **Tap the task** → assert it opens the **Referral Follow-up** form.
5. **Assert the form branched correctly** — only the cognitive question shows; the other six
   domains are hidden. This proves the `modifyContent` hand-off end to end.
6. Submit the follow-up → **assert the task disappears** from the Tasks tab.
7. **Repeat failing three domains at once** — assert **one** task (not three) and that the
   follow-up shows exactly those three sections.
8. **Negative case:** an assessment where everything passes → **no task**.

## Deliverables
1. **A pass/fail table for Phase 3 steps 1–8** — this is the headline. Screenshots of the task
   card and the branched follow-up form are worth more than prose here.
2. **Every failure classified**: *(A)* my test/build error, *(B)* real tool limitation, *(C)*
   spec ambiguity. The third category is new and important — several conditions genuinely can't
   be derived from the sheet (list in the analysis doc §4).
3. **Interaction cost** for the seven `refer_*` flags and the task build — "possible but takes 40
   actions" is a finding.
4. **Whether `modifyContent` actually delivered the flags** — inspect the follow-up form's
   submitted report on the instance, not just the UI behaviour.
5. **The spec questions your build forced you to answer** (hearing and/or, which N6 test, the
   nutrition branch) — real answers needed from the customer.
6. Spec path(s) + exact run command.
7. **Verdict:** does the complete workflow work today? If not, precisely what stops it.

## Scope
`client/tests/**` and scratch only. Production code belongs to the dev session — a needed fix is
a finding, not a task. Safety rule still stands: **never** Contact Summary → Helpers → "edit
body", and don't open a pre-existing hand-written task condition and save it.
