# T9 demo recordings — what each video shows and how to replay it

<!-- Source: client/tests/t9-demos/README.md (beside the specs). The recorder
     copies it here, beside the videos, on every run; edit the source. -->

One video per sub-issue of the "complex logic" epic (#9), in this folder as
`<ticket>.mp4` (for GitHub) and `<ticket>.webm`. Each is a Playwright run with
slow-motion actions and a caption bar at the bottom. The same steps
can be done by hand in the editor; every demo runs on a throwaway copy of the
bundled sample project, so nothing you do here touches a real config.

## Set-up (once)

1. `pnpm install && pnpm build`, then `pnpm dev`. Open <http://localhost:5173>.
2. On the first screen enter the absolute path of
   `client/tests/fixtures/mini-config` (or a copy of it).
3. Go to **Forms → pregnancy.xlsx**. The rows used below: `lmp_date`
   (Last menstrual period), `lmp_note` (LMP recorded), `danger_signs`
   (Danger signs, select many), `chair_rise` (Chair rise test, select one),
   `gravidity` (Number of pregnancies).
4. On any row, **show advanced** opens the panel with the Logic section.
   "Apply" writes a picked rule; **code** shows the XPath the rule became.

Where a demo starts from a hand-written rule, type it into the row's XPath
box (click **code** first) or into the sheet with a spreadsheet editor, then
save and reload. Checking what was saved: open the sheet, or call
`GET http://127.0.0.1:5174/api/forms/app:pregnancy` and read `extras`.

To re-record all seven: from `client/`, `npx playwright test -c
playwright.demo.config.ts` (one spec: add `tests/t9-demos/t9e.demo.spec.ts`).
Videos land in this folder as `.webm` and, when ffmpeg is installed, `.mp4`.
`DEMO_MS=800` slows it down. The specs are in `client/tests/t9-demos/`.

---

## t9a — parser: `.` as the answer, `../field` as an alias (#14)

**Shows:** rules written with `.` and `../` open as structure, and an
open-and-save with zero edits leaves every one of them byte-identical.

1. Seed these cells, then reload the form:
   `gravidity` constraint `. >= 0 and . <= 20`; `chair_rise` constraint
   `.<=100` (no spaces); `lmp_date` constraint `. <= today()` and relevant
   `selected(../danger_signs, 'none')`; `lmp_note` relevant
   `../lmp_date != ''`.
2. Show advanced on each row. Gravidity's Validation reads *Between 0 and
   20*; chair rise reads *at most 100*; LMP date reads *Relative to today:
   on or before*, and its relevant is a clause, not a "hand-written" notice.
3. On `lmp_note` click **Apply** without changing anything, then **code**:
   the XPath is still `../lmp_date != ''`, not `${lmp_date}`.
4. Add any question elsewhere so Save is enabled, save, and compare the
   sheet: every seeded cell is unchanged.

## t9b — "has an answer" and "is not selected" reopen (#15)

**Shows:** the two rules the builder used to write but could not read back.

1. On `gravidity`: pick field *Last menstrual period*, condition *has an
   answer*, **Apply**. **code** shows `${lmp_date}`.
2. On `chair_rise`: pick *Danger signs*, *is not selected*, **Apply**.
   **code** shows `not(${danger_signs})`.
3. On `lmp_note` (the fixture ships `${lmp_date} != ''`): it is already a
   clause. **Apply** with no edits writes `${lmp_date} != ''` back as is.
4. Save, reload, reopen the three rows: each is still a clause with
   *undo last clause* available and no "hand-written" notice.

## t9c — the searchable field picker (#16)

**Shows:** one picker, with labels, in the strip, the modal and the value cell.

1. On `gravidity`, show advanced. Fields read *Label (name)* grouped by
   section. Type `lmp` in *search fields…*: one match by name. Type
   `menstrual`: the same match by label.
2. Tick *show technical rows* with `lmp` typed: `lmp_note` (a note) appears.
   Untick: it goes.
3. Pick *Danger signs* and *includes*; the value list shows choice labels
   (*Vaginal bleeding*). **Apply**: readback is *Danger signs includes
   Vaginal bleeding*; **code** shows
   `selected(${danger_signs}, 'vaginal_bleeding')`, the names, unchanged
   from the old builder.
4. Undo, pick *Last menstrual period* *equals*, click *another question*,
   search `patient`, pick `patient_id`, **Apply**: `${lmp_date} = ${patient_id}`.
5. With **code** open click **✎ build**, add a comparison, search
   `menstrual` in the row: the same picker.

## t9d — add a question with its details in one step (#17)

**Shows:** the configure step, insert-after-the-current-row, scroll and flash.

Needs the step on: in the picker untick *always skip this step*, or clear
the browser key `cht-ui-builder.oneClickTiles`.

1. Click into the `lmp_date` name box (you are "on" that row).
2. **+ Question**, name `age`, label *Age*, tile *Number*.
3. In the configure step: tick *Required*, hint *Years*, add the rule
   *Between two values* 0 and 20 (the message is suggested). **Add question**.
4. The new row appears directly after `lmp_date`, scrolled into view with a
   highlight.
5. Click into `age`, **+ Question** again, name `quick_note`, tile *Text*,
   **add without details**: a bare row, right after `age`.
6. Save. The sheet has `lmp_date`, `age`, `quick_note` in that order; `age`
   has `required=yes`, `hint::en=Years`, `constraint=. >= 0 and . <= 20`
   and its message.

## t9e — the Validation panel (#18)

**Shows:** presets per question type, messages beside the rule, and that a
rule shown as a preset is saved exactly as written unless you edit it.

1. Seed `gravidity` constraint `. <= 100 and . >= 70` (max first) and
   reload. Show advanced: it reads *Between 70 and 100*. Tick *Required*,
   type a required message.
2. `lmp_date` (date): add *Not in the future*; the message is suggested.
3. `danger_signs` (select many): add *A choice must be chosen alone*, pick
   *Vaginal bleeding*.
4. **+ Question** `notes`, tile *Text*; on its panel add *At most N
   characters*, 100.
5. Save. In the sheet: `lmp_date` `. <= today()`; `danger_signs`
   `not(selected(., 'vaginal_bleeding') and count-selected(.) > 1)`;
   `notes` `string-length(.) <= 100`; and `gravidity` is still
   `. <= 100 and . >= 70`, untouched.
6. Change gravidity's maximum to 99 and save: now `. >= 70 and . <= 99`.
   Editing a rule writes it canonically; displaying it never does.

## t9f — logic as sentences, XPath on request (#19)

**Shows:** the regrouped panel and the sentence editor.

1. Seed `lmp_note` relevant `../lmp_date != ''` and reload.
2. On `gravidity`, show advanced: sections *Logic*, *Display*, *Messages*,
   *Raw*. The relevant reads *Show this question when …*. Pick *Last
   menstrual period*, *has an answer*, **Apply**: readback *This row shows
   when: Last menstrual period has an answer*. No XPath on screen.
3. **code** reveals `${lmp_date}` with **✎ build** beside it; **hide code**
   puts it away. A Number row shows *+ compute this value…* rather than an
   empty calculation box.
4. **hide advanced**: the collapsed row says *shows when Last menstrual
   period has an answer*.
5. On `chair_rise` the second sentence is *Filter the choice list when …*:
   pick *Danger signs includes Vaginal bleeding*, **Apply**.
6. On `lmp_note` the seeded `../` rule reads as the same sentence; **Apply**
   with no edits and **code** still shows `../lmp_date != ''`.
7. Save and check the three cells in the sheet.

## t9g — all four builders in one journey (#20)

**Shows:** relevant, constraint, choice filter and calculation authored in
one sitting, every cell checked on disk.

1. `gravidity` relevant: *Chair rise test includes Pass*, **Apply**.
2. `gravidity` Validation: *Between two values* 0 and 20.
3. `chair_rise` choice filter: *Danger signs includes Vaginal bleeding*,
   **Apply**.
4. **+ Question** `gravidity_next`, tile *Calculate*; show advanced,
   **✎ build** on the calculation, *Raw* tab, `${gravidity} + 1`, Save.
5. Save the form. Sheet: `selected(${chair_rise}, 'pass')`;
   `. >= 0 and . <= 20` with *Must be between 0 and 20*;
   `selected(${danger_signs}, 'vaginal_bleeding')`; `${gravidity} + 1`.

The second half of #20, a picked rule matching at runtime on a live CHT, is
`tests/live-instance-check.spec.ts`. It needs Docker and the local CHT
instance; run it under the demo config to record it.
