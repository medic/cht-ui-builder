<!--
Definitive reading of the customer's Geriatric Task sheet: what fires, when, and how many
tasks it actually specifies. Verified against the RAW sheet XML (xl/worksheets/sheet2-4.xml)
and <mergeCells> geometry, not the text dump — see the methodology warning. 2026-08-08.
-->

# Geriatric Task sheet — definitive analysis

**Source:** `C:\Users\ADMIN\Downloads\Geriatric care use case XLS.xlsx` — `Task` = sheet2,
`Integrated Health Assess form f` = sheet3, `Refrral Follow up Form` = sheet4 (name truncated
at Excel's 31 chars; "Refrral" is the customer's typo). `T#` = Task row, `A#` = IHA row
(XLSX row = #+1).

## ⚠️ Methodology warning — and a trap in our own tooling
The scratchpad text dump was produced with **our own `parseXlsForm`, which expands merged
cells** (forward-fills the anchor value into every covered row). So the dump showed
Start/Due/End/resolved and the Nutrition/Psychological conditions populated on *every* row
when the source leaves them **blank**. The dump had already silently applied the very
inheritance we set out to test. Everything below is verified against raw cell XML +
`<mergeCells>` geometry instead.

**Take-away for us:** forward-filling is defensible for real XLSForms (which don't use merges),
but it is a **meaning-changing transform when reading a human-authored design sheet**. Any
future "import a customer spec" feature must read merges explicitly, not flatten them.

---

## 1. The window is ONE global setting, not a per-row value
`<mergeCells>` on the Task sheet:
```
A2:A3  A4  A5:A8  A9:A13  A14:A15  A16:A18  A19     <- column A = 7 blocks
D5:D8  D16:D18                                       <- shared conditions
E2:E19  F2:F19  G2:G19  H2:H19                       <- window + resolution, ALL 18 rows
```
`E2="15 days"`, `F2="30 days"`, `G2="15 days"`, `H2="Once, Referral Follow Up form is
submitted"` — four single merged cells spanning every data row. **One window for the whole
sheet: start +15 d, due +30 d, end +15 d** (CHT reading: due day 30, visible from day 15,
expires day 45). **The anchor date is never stated** — presumably IHA submission. Must ask.

## 2. It specifies ONE task, not 18
**18 rows → 17 trigger legs → 7 domain conditions → 1 CHT task.**

- **T7** (`Measure their weight (in kg)`, integer, no threshold) is **not a trigger** — data
  capture swept in by the `D5:D8` merge. → 17 legs.
- **No true duplicates.** T11/T12 are different questions (bare-eye A27 vs with-glasses A29).
- **7 domain conditions**, corroborated three ways: the 7 column-A merge blocks, the 7 referral
  notes in the IHA, and the 7 domain-gated rows in the Referral Follow-up form.

| # | Domain | Legs | Condition | IHA referral note |
|---|---|---|---|---|
| 1 | संज्ञानात्मक ह्रास · Cognitive | 2 (A7, A8) | **OR** of 2 select_one fails | A9 — *"either of the two options"* |
| 2 | सीमित गतिशीलता · Mobility | 1 (A14) | equality `१४ सेकेन्ड भन्दा बढी (फेल)` | A15 |
| 3 | पोषण जाँच · Nutrition | 3 (A16–A18) | **OR** of 3 fails on `छ (फेल)` | A20 — *"either of the above options"* |
| 4 | दृष्टि जाँच · Vision | 5 (A23, A25, A26, A27, A29) | **OR** of [multi-select any-except-`कुनै पनि छैन`] with 4 select_one fails | A30 |
| 5 | श्रवण क्षमता जाँच · Hearing | 2 (A33, A34) | **OR *or* AND** — sheet says `and`; **unresolved** | A35 |
| 6 | मनोवैज्ञानिक जाँच · Psychological | 3 (A36–A38) | **OR** — *"of any response"* | A39 |
| 7 | पिसाब नियन्त्रण · Continence | 1 (A49) | equality `छ (फेल)` | A50 |

**Why one task, not seven cards:**
1. **Form Overview declares exactly one task-driven form** — `Geriatric care follow up form`,
   `Access: Task`, for *"all those people who were referred for further assessment/treatment."*
2. **`H2:H19` is a single merged resolution** — seven tasks would all resolve on one submission,
   i.e. up to 7 identical cards on one contact, all opening the same form, all vanishing at once.
3. **The follow-up form self-branches per domain** (its R8–R15, each gated *"if a referral note
   is triggered for `<section>`"*, under one merged relevance). **Domain routing lives inside
   the form, not across tasks.**

**Recommended build:** ONE task, `appliesIf` = OR of the 7 domain conditions, with the 7 domain
booleans carried into the follow-up form to drive its per-domain relevance. Window: start 15,
due 30, end 45 from IHA submission.

## 3. Three things that will bite at build time

**(a) 🔴 The referral flags are never persisted — the two forms cannot talk.** Follow-up rows
R8–R15 each read *"if a referral note is triggered for `<section>`"*, but in the IHA those
triggers are **notes** (A9/A20 have no `Type` at all; A30/A35 are `note`) — **notes persist no
value.** Nothing in the submitted report says "cognitive referral fired." The IHA needs hidden
`calculate` fields (`refer_cognitive`, `refer_mobility`, …) as the contract between the forms
*and* as the task condition. **This is a spec addition, not a build detail.**

**(b) There are no choice values anywhere in the workbook.** Headers are
`Section Header | Question (Ne) | Question (Eg) | Type | Required | Choose (Ne) | Choose (Eg) |
Condition | Constraints | Hint | Hidden` — **no `name`, no `list_name`, no value column.** All
18 conditions reference **label strings**, and choice lists are newline blobs of `○ `-prefixed
labels. Every value must be derived. `छ (फेल)` is the fail label on **15 different questions** —
resolvable only because the Task sheet names the question in column B/C.
Label hazards found: `"○  छ (फेल)"` (double space), `" N6 देखेन (फेल) "` (leading space, no
`If selected` prefix), `"○  Yes  (Fail )"`, and a **spelling mismatch inside the sheet's own
logic** — A35's condition writes `दाँया` where the question label is `दायाँ` (ा ँ transposed).
Any label-matching import breaks on that one. Good news: **18/18 Task labels are verbatim
copies of IHA labels**, so the row→question mapping is unambiguous by string match.

**(c) Section names don't join across the three sheets.** Task says `दृष्टि जाँच`; the IHA has
`टाढाको दृष्टि जाँच` *and* `नजिकको दृष्टि जाँच`; the follow-up keys off a third set. Ask for one
canonical section list with stable IDs.

## 4. Must-ask before building (cannot be derived)
1. **Hearing: `and` or `either`?** (A35) — one ear or both?
2. **Vision N6:** should the referral fire on the bare-eye test (A27), the with-glasses retest
   (A29), or both? As written, both.
3. **Nutrition branch:** are A17/A18 always asked, or only when A16 = `थाहा छैन`? (The sheet says
   the latter but parks the rule on the wrong row.)
4. **Weight threshold:** A19 captures kg with no cutoff and no BMI rule — trigger or not?
5. **Window anchor:** 15/30/15 relative to what?
6. **Silent no-task paths:** A4/A21/A31 `छैन (पास)` and A12 `लाग्दैन (परीक्षण नगर्ने)` produce no
   task at all. Note the **whole cognitive branch is gated on A4 self-report** — say "no memory
   problem" and the tests never run. Intended?
7. **🔴 A38 self-harm on the same 30-day clock.** *"Recently, have you had thoughts of harming
   yourself or not wanting to live?"* currently surfaces as a task **first visible at day 15,
   due day 30**. Needs a deliberate decision: same-day escalation, priority, and who owns it.
   Same concern for sight-threatening eye findings (`पिप छ`, `कर्निया धमिलो`) on a 30-day clock.
8. **Continence contradiction:** IHA A50 says refer *`आवश्यक भएमा`* (if necessary) but the task
   fires unconditionally — so a CHW who correctly judged referral unnecessary still gets a task.
9. **Resolution scope:** any submission of the follow-up, or one linked to *this* IHA report? As
   written, a submission answering only `छैन` resolves everything.
10. **Task title:** the labels are **instrument prompts** (`Right ear result`, `Measure their
    weight (in kg)`), not task titles — they read as "re-do this test" when the action is "check
    the referral happened." Ask for a short action-shaped title plus a detail line. The sheet has
    only one label-column pair, so no title/description distinction exists in it at all.
11. **Assignee, priority, escalation, recurrence, death/muting suppression** — none specified.
12. **The HTN/DM screening form is not in this spec** (A3 pulls BMI/BP/blood-sugar from it).
    Need its field names, plus what shows when no record exists and how stale is too stale.

## 5. Data-quality defects to fix in the workbook before import
- **Polarity bug, A40:** *"Are you satisfied with the care provided by your family?"* with options
  `छ (फेल)` / `छैन (पास)` — **"yes, I am satisfied" is tagged FAIL.** The fail/pass pair was
  copy-pasted onto a positively-worded question. Same risk across A44–A47.
- **Sections producing `(फेल)` answers with NO task and NO referral note:**
  `सामाजिक हेरचाह र सहयोग` (A40–A43) and `हेरचाहकर्ताको सहयोग` (A44–A48). A48's condition
  *"if selected except हो and छैन"* is under-specified — A45's pass option is
  `छ, मलाई थाहा छ के गर्ने`, which the exclusion list misses.
- **Missing English choice label:** A16's `थाहा छैन` has no `Choose (Eg)` entry (3 Ne options, 2
  Eg) — a direct hit on the per-locale-choice-label path.
- `Type` empty on three referral notes (raw `D10`, `D21`, `D49`); A50 has `note` in the
  **Required** column, not Type; A19 is `integer` yet carries a choice list; A28 is a `note`
  marked required.
- **`select_multiple` with a none-option and no exclusivity constraint** (A23) — nothing stops
  `कुनै पनि छैन` being ticked alongside an abnormality.
- **A22** (diabetes/HTN/steroids) is tagged `(फेल)` but consumed by nothing.
- **A11 is `Type: Image` with no filename** — the chair-rise illustration was never supplied.
- **Consent:** A1's `Form close if selected सहमत छैन` — "form close" isn't an XLSForm concept;
  needs a relevance/skip design, and it's undefined whether a declined report submits at all.

## 6. What our tool can and can't do for this task, today
| Need | Status |
|---|---|
| One task, trigger form + window (15/30/45) + resolution + action | ✅ all picker-driven |
| OR across several questions within a domain | ✅ connector pill (one level — enough here) |
| Multi-select "any of" for the external-eye finding | ✅ shipped (item 4) |
| "Any except `कुनै पनि छैन`" | ✅ expressible |
| Hidden `calculate` referral flags (3a) | ✅ but needs the Calculate tile — now visible in Simple mode |
| Bilingual task title | ❌ **blocked** — translation keys can't be created (queue item 8) |
| Priority / same-day escalation for self-harm | ⚠️ `priority` field exists in the tasks editor; no separate urgent-window concept |
