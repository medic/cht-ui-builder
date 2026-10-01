# Validation rules: what CHT configs need vs. what CHT UI Builder supports

**Version 2, UI/UX elements added** · 2026-10-01 · Prajwol Shrestha
v2 adds the hands-on review of condition authoring in the running app ("UI/UX: condition authoring review") and folds its fixes into the Phase 1 action items. v1.1 folded in the planner's reconciliation of its three constraint drafts (which this doc supersedes): no-normalise rule, serializer-exercising round-trip tests from non-canonical fixtures, classification wording, and QA's two-case cause for the "has an answer" defect.
Ticket: T9 (medic/cht-ui-builder#9) · Live copy: <https://claude.ai/code/artifact/729e0b55-c812-4c2d-af84-7f85c4107469>

## Summary

The visual rule builder can open **3 of the 777** validation rules (`constraint`) found in seven real CHT configs. The other 774 fall back to plain text. They are saved correctly, but can only be edited by hand.

The main reason is one missing piece. Almost every real rule is about the question's own answer, written `.` (as in `. >= 10 and . <= 90`). The builder only understands comparisons against other questions (`${field}`). A second gap is that the add-question step sets no validation at all.

Phase 1 of the plan below covers about 97% of the real rules that are not placeholders: number ranges, text length, text character rules, dates against today or another date, and "None can't be combined" for select-many. Supporting `.` plus these presets, with the existing plain-text fallback for everything else, closes most of the gap. "Support all of ODK" is a separate, realistic track: a function catalogue that gives every expression field autocomplete and checks, not more visual presets.

### Supported today at a glance

| Capability | Today |
| --- | --- |
| Set validation while adding a question | No |
| **required** checkbox | Yes |
| **required_message** | Only under "Raw column overrides", and only if the sheet already has the column |
| **constraint_message**, one box per language | Yes, once a constraint exists |
| Rule about this question's own answer (`.`), e.g. `. >= 0 and . <= 20` | No. Saved as plain text, edited by hand |
| Rule comparing other questions (`${field}`), e.g. `${role} = 'chw'` | Yes, in the inline builder and the "✎ build" modal |
| "and also" / "or instead", one level of grouping | Yes |
| Has an answer / is not selected | Can be written, but reopens as plain text |
| N days/weeks/months ago or from now; age in years; contact input; contact-summary key | Modal only |
| Text length, allowed characters, pattern, count of selected choices | No. Plain text only |
| Plain-text fallback that saves byte-identical | Yes |
| Function autocomplete, typo or unknown-field checks | No |

Details and file references are in "What is supported today" below.

## Action items

The target: add **age** as a Number question and, in the same step, set "between 0 and 20" with a message, then reopen it and see the rule as a preset.

### Phase 1: shared parser

- [ ] `relevantParser.ts`: accept `.` as a comparison subject; values may be a number, quoted string, `${field}`, `today()`, `now()`, `today() ± N`, `date('…')`
- [ ] Accept `../field` relative paths as an alias of `${field}` (subject and value); re-emit exactly as written, never rewrite to `${}`
- [ ] Recognise function forms on `.`: `string-length(.)`, `regex(., '…')`, `selected(., '…')`, `count-selected(.)`, `int(.)`, `int(format-date(., '%Y'))`, `max(coalesce(${a}, 0), …)`, `add-date(today(), …)`, `difference-in-months(., today())`, `decimal-date-time(.)`
- [ ] Keep the self-check: any rule that does not re-serialize byte-identical stays plain text; `.<=100` and `. <= 100` both round-trip unchanged
- [ ] `node --test` round-trip case per preset in `shared/src/xlsform/`
- [ ] `scripts/corpus-sweep.mjs` shows no drift on all seven configs

### Phase 1: Validation panel (client)

- [ ] New `ValidationPanel` component: preset list per question type, error message per visible language, **required** checkbox, **required_message** per language
- [ ] Mount in `QuestionTypePicker` (for every type that has presets) and in the row editor, replacing the inline strip and the "✎ build" modal for the `constraint` column
- [ ] UX: sentence-shaped inline rule editor per column ("Show this question when [field] [is] [value]"), plain-English readback, XPath behind a "code" toggle; same component for relevant, constraint and choice_filter
- [ ] UX: searchable, grouped field picker (label + name); notes, `r_*`, `__*` and plumbing hidden behind "show technical rows"
- [ ] UX: add-question configure step (required, rule presets, hint) before commit; insert after the current row; scroll to and highlight the new row
- [ ] UX: regroup the advanced panel into Logic / Display / Messages / Raw; `required_message` beside `constraint_message`; hide "Compute the value as…" for non-calculate types unless opted in
- [ ] UX: choice values show labels in pickers and readback
- [ ] UX: project picker "Forget all missing"; no toast for a stale last-opened path
- [ ] Number and Decimal: Between (both ends included by default, per-end toggle), Less than / Greater than (with "or equal"), At most / At least [another question]; integer questions accept whole numbers only
- [ ] Text: At most / At least / Exactly N characters; Allowed characters (letters with script checklist from the form's languages, digits only, no digits); Pattern box with a test field
- [ ] Text: BS year between N years ago and this year
- [ ] Date and Date-time: Not in the future / Not in the past (`today()` vs `now()` by type); On or after [question]; After all of [questions]; Within the last / next N days/weeks/months
- [ ] Select many: [choice] must be chosen alone
- [ ] Fixed value: This answer equals
- [ ] Presets combine with "and"; suggested message text per preset, editable
- [ ] Opening an existing rule: exact preset match first, then clause builder with **This answer**, then plain text; untouched rules stay byte-identical
- [ ] `true` / `true()` / `1` constraints show "This rule always passes: no validation"
- [ ] Fix (two cases, same choke point `ruleToClause` `:507`): (a) `ref` / `not` clauses are emitted as `raw` by `clauseToRule` `:489-490`, so give them real rule kinds and reopen them; (b) `answered` rules (`${f} != ''`, `${f} = ''`) parse cleanly but are dropped; map them to clauses

### Phase 1: tests

- [ ] Playwright: add **age** (integer), set Between 0 and 20 with a message, save; the sheet has `. >= 0 and . <= 20` and `constraint_message::en`; reopen shows the preset filled in
- [ ] Playwright (UX): after adding a question the new row is scrolled into view and highlighted; the field picker finds `lmp_approx` by typing "lmp"; the rule reads back in plain English
- [ ] Hostile fixtures for `../field` relevants (`selected(../lmp_approx, 'approx_weeks')`, `../lmp_date_8601 != ''`): byte-identical live, "opens as clauses" todo; QA measures the `../` vs `${}` share across the 7 configs
- [ ] Re-run the 777-rule count; target: every Phase 1 row in the gap matrix opens as a preset or clause (about 705)
- [ ] Compile one form using every preset with `cht-conf` in the Docker image, so each written rule is valid for Enketo
- [ ] Verify whether Enketo's `regex()` supports `\p{L}` before offering it

### Phase 2

- [ ] Date on or after a fixed date; "[Other] alone" for any choice; choose at least / at most N

### Parallel: level 2

- [ ] ODK + CHT function catalogue (`shared/`): names, arity, return type, CHT-only flag
- [ ] Autocomplete and checks in every expression field: unknown function, wrong argument count, unknown `${field}`, `constraint_message:en` with one colon, ODK features CHT does not run

## Sources

Every non-empty `constraint` in `forms/app/*.xlsx` and `forms/contact/*.xlsx` of the seven real deployment configs on the developer's machine, read with the project's own XLSForm parser. Test projects made with the builder (`ui-builder-projects/`) were left out.

| Config | Rules |
| --- | --- |
| config-nssd (`chis`) | 256 |
| config-lumbini | 248 |
| config-moh-nepal / master-decommissioned | 67 |
| my-cht-project | 61 |
| config-moh-nepal / province | 52 |
| config-gandaki | 50 |
| config-moh-nepal / master-direct-client-messaging | 43 |
| **Total** | **777** |

- 742 of the 777 (95%) also have a `constraint_message`.
- The three moh-nepal folders are versions of one config, so "used in N configs" counts below overlap.
- "Opens in the builder" means `parseRelevantGrouped` returns clauses with no raw parts, the test the "✎ build" modal uses. The inline builder is stricter still (comparison and includes only); both open the same 3.

## What is supported today

Validation can be set only after a question is added, in the row editor. The row editor has two visual builders for the same columns, with different rule sets, and neither can refer to the question's own answer. Verified against `client/src/ui/FormEditor.tsx`, `RelevantRuleBuilder.tsx`, `QuestionTypePicker.tsx` and `shared/src/conditionBuilder/conditionReducer.ts` on 2026-09-30.

| Where | What it does today | Limit |
| --- | --- | --- |
| Add-question picker | Sets type, name, a label per language, choices; field-list appearance for groups | No validation, required or message fields |
| Row editor: **required** | Checkbox that writes `required = yes` | `required_message` has no field of its own. It shows under "Raw column overrides" only when the sheet already has the column |
| Row editor: **inline condition builder** (strip above the raw fields) | Column picker: Show when (relevant) / Accept only if (constraint) / Filter choices (choice_filter). Operators: equals, is not, `>`, `<`, `≥`, `≤`, includes, does not include, is not selected, has an answer, today. Clauses joined with "and also" / "or instead"; one level of grouping | Subject must be an **earlier** question with a unique name; `.` is not understood. Reopens only comparison and includes / does-not-include rules. Any other rule in the saved text sends the whole expression to plain text |
| Row editor: **"✎ build" modal** on relevant / constraint / choice_filter | Rule list: comparison, includes, has an answer, "N days / weeks / months / years ago or from now", age in years, compare a contact input (`inputs/contact/…`), compare a contact-summary context key | Same `${field}`-only subject; no `.`; no text-length, pattern or count-selected rules |
| Row editor: **constraint_message** | One text box per language, shown once a constraint exists | — |
| Plain-text fallback | Banner "This rule was hand-written. Edit as text, or clear it to use the builder." Text is saved exactly as written | Editing is by hand |

In practice both builders handle validation that compares against other answers, for example `${role} = 'chw' or ${role} = 'other'`. That is the only kind among the 3 rules that opened.

### Defects found during the review

- The inline builder can **write** "has an answer" (`${field}`) and "is not selected" (`not(${field})`) but cannot **reopen** them. Cause (verified by QA against `shared/dist`): `clauseToRule` (`conditionReducer.ts:489-490`) emits both as `kind: 'raw'` from the outset; on reopen they parse back as raw, and `ruleToClause` (`:507`) returns null for raw. A separate second case: `${f} != ''` / `${f} = ''` parse **cleanly** as `kind: 'answered'` (reachable from the modal's "+ answered check", never from the inline builder) and are dropped at the same `:507`. A fixture using bare `${f}` exercises the raw path, not the answered path; pin them separately.
- Unknown `${field}` references are not flagged anywhere. `dependencies.ts` skips them silently, so a typo in a field name is caught only when `cht-conf` compiles the form.
- The two builders accept different rule sets for the same column, so whether a rule "opens" depends on which button the user pressed. The proposal below should merge them or make the modal a superset.

## UI/UX: condition authoring review

The pieces exist (two builders, dependency validator, choice-aware value picker, undo) but the authoring flow reads as a developer's debug panel. A program officer adding "show this when LMP is approximate" must pick a *column*, find one field among about 230, and read the result back as XPath. Three issues block the cold-start journey; the rest are polish.

Method (2026-10-01, `bff69cb`, desktop mode, 1440×900): opened `geriatric-workflow/forms/app/pregnancy.xlsx` (280 rows, 83 relevants, 11 constraints); opened existing rules in the inline builder and the "✎ build" modal; added a Number question **age** and gave it a relevance from scratch; discarded without saving. Screenshots: `.playwright-mcp/ux-01` to `ux-14`.

| # | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| 1 | P0 | Existing rules cannot be opened, even simple ones. Constraints use `.`; relevants in real forms use **relative paths** (`../lmp_approx`), and the parser accepts only `${}`. Inline builder shows "hand-written" with every control disabled; the modal opens in Raw with a yellow warning | ux-07, ux-08, ux-09 |
| 2 | P0 | Field picker lists about 230 fields in sheet order: every `*_note`, `r_*` summary row, `__*` hidden output and plumbing calculate. No search, no labels, no grouping. "Show all fields" is unchecked yet everything is shown | ux-13 |
| 3 | P0 | Adding a question commits on the type tile with no step for required / rule / hint. The row is appended after the hidden `__*` outputs, off-screen, with no scroll or highlight | ux-11, ux-12 |
| 4 | P1 | The result is shown as code: `${lmp_approx} = 'approx_weeks'`. No plain-English readback in one-clause mode; choice values show names, not labels | ux-14 |
| 5 | P1 | Advanced panel is one flat stack: show-when, compute, accept-only-if, appearance, image, default, hints, raw overrides; "Compute the value as…" appears on a plain Number question | ux-06 |
| 6 | P1 | Developer-facing microcopy: `build:`, `— column —`, "Which column to add the fragment to", `+ insert`, `× start over`, `value or ${other_field}`. The column should be implied by the field being edited | ux-06 |
| 7 | P1 | Messages are buried: `constraint_message` appears only once a constraint exists, inside "Hints & error messages" under seven hint boxes; `required_message` absent | ux-14 |
| 8 | P1 | Label grid density: seven locales × (box + `!` badge + "+ insert") per row; `label::hi insert` captions collide; `NO_LABEL` shown literally on calculates | ux-05 |
| 9 | P1 | Expression preview duplicated: in the "show advanced — relevant: …" toggle and again in a code bar beneath it | ux-05 |
| 10 | P1 | Project picker: 590 of 658 entries point at deleted e2e temp folders, one "Forget" each, plus an error toast on load | ux-01 |
| 11 | P2 | Modal: "Visual / Raw" plus eight "+ …" buttons (including "+ raw expression" inside Visual); and/or radios apply globally; two "cancel" buttons | ux-09 |
| 12 | P2 | `favicon.ico` 404, the only console error | console log |

**Keep:** the unsaved-changes guard on navigation (it caught the test reload); choice values become a dropdown once a select field is picked; dependency-aware ordering; "↶ undo last clause"; language chips; one-click type tiles (they need a second step, not removal).

### UX changes for the Validation panel (same ticket)

1. **One inline rule editor per column**, replacing both the strip and the modal: a sentence-shaped builder, "Show this question when [field ▾] [is ▾] [value ▾]", plain-English readback, XPath behind a "code" toggle. This is the Validation panel generalised to relevance and choice_filter, and the UI face of the shared condition module (rule model → presets → codecs).
2. **Searchable, grouped field picker** showing label + name; notes, `r_*`, `__*` and plumbing hidden by default behind "show technical rows".
3. **Parser accepts `../field`** as an alias of `${field}` for subject and value, re-emitted exactly as written (no-normalise rule). Cheap, and it unlocks most relevants in real forms. QA to measure the `../` share across the 7 configs.
4. **Add-question gets a configure step** before commit: required, rule presets, hint. Insert after the current row (or where "+ insert" was clicked); scroll to and highlight the new row.
5. **Regroup the advanced panel** into Logic / Display / Messages / Raw, with `required_message` beside `constraint_message`; hide "Compute the value as…" unless the type is calculate or the author opts in.
6. **Choice values show labels** in pickers and readback; names stay in the saved sheet.
7. **Project picker**: "Forget all missing" and no toast for a stale last-opened path.

## How other builders handle it

Every builder puts validation on the question itself, and none of the XLSForm-based ones offer it while adding the question. Most call it **validation**; XLSForm tools keep the word **constraint**. Labels are from memory of each product and may have changed.

| Builder | Name in the UI | How range rules appear |
| --- | --- | --- |
| KoboToolbox | Validation Criteria | Conditions about "This question's response" (`=`, `!=`, `>`, `<`, `>=`, `<=`, answered / not answered), met **all** or **any**; separate Error Message; a code box as fallback |
| ODK (XLSForm) | constraint / constraint_message | Hand-written `. >= 10 and . <= 90` |
| ODK Build (retired) | Constraint and Range | Range had min/max boxes for numbers |
| SurveyCTO | Constraint / Constraint message | Same as XLSForm |
| CommCare | Validation Condition / Validation Message | Written expression; closest to CHT's users |
| Google Forms | Response validation | Number: Greater than, Less than, **Between**, … with custom error text |
| Microsoft Forms | Restrictions | Number: Greater than, Less than, Between, … |
| REDCap | Validation | Type (integer / number) plus Minimum and Maximum boxes |

### What to borrow

- **Kobo:** the fixed subject "This question's response", so the user never picks the field. Our builder's missing `.` support is exactly this. Also the all / any switch, which our "and also" / "or instead" connector already covers.
- **Google Forms:** a single **Between** option with two boxes, instead of Kobo's two separate conditions. Also type-specific presets: text length and pattern, and "select at least / at most N" for checkboxes.
- **REDCap and ODK Build:** plain Minimum / Maximum boxes for numbers. Simple, but they cannot express `> 0` versus `>= 0`, which real configs mix. Our Between keeps a per-end toggle.
- **All of them:** the error message sits next to the rule, and a code box stays available for anything the presets cannot say.

For our UI: call the panel **Validation**, name the number preset **Allowed values** (Between / Less than / Greater than) and keep "constraint" as the small technical label, as the row editor's "Accept the answer only if… (constraint)" already does.

## What real configs need

Number and text rules are the bulk of real validation: 445 of the 777 rules (57%). Dates come next, then select-many.

| Rule kind | Rules | Phase |
| --- | ---: | --- |
| Number: range or limit | 153 | 1 |
| Text: maximum length | 104 | 1 |
| Text: length + allowed characters | 94 | 1 |
| Text: pattern only | 78 | 1 |
| Year typed as text, BS range | 77 | 1 |
| Date: vs another date | 59 | 1 |
| Placeholder `true` (no rule) | 51 | note only |
| Select many: None alone | 50 | 1 |
| Date: after latest of several | 28 | 1 |
| Date: within N days/months | 27 | 1 |
| Number: vs another answer | 16 | 1 |
| Date: not in the future | 16 | 1 |
| Select many: Other alone | 9 | 2 |
| Other answers only / misc | 6 | works today / not planned |
| Fixed value | 5 | 1 |
| Select many: count limit | 3 | 2 |
| Date: fixed date | 1 | 2 |

Source: `constraint` column of every form in 7 real CHT configs, grouped by pattern, counted 2026-09-30.

- **Numbers** mix inclusive and exclusive ends (`. > 0 and . <= 20`, `. >= 0 and . < 24`) and use decimal bounds such as temperature `.>= 36.5 and .<= 40`.
- **Text** rules are mostly a maximum length, often combined with "no digits" or a Nepali/English letters-only pattern.
- **Year typed as text** checks a Bikram Sambat year against today with `int(format-date(today(),'%Y')) + 57`.
- **Dates** are almost always "not in the future", often together with "after LMP / birth date / the previous visit".
- **`tel`** questions (42 rules) mostly carry the placeholder `true`. Phone checks are done with a text regex.

## Gap matrix

Only rules that compare other answers work visually today. Every rule about the question's own answer is plain text only.

| Rule | Example | Today | Proposed support | Phase |
| --- | --- | --- | --- | --- |
| Number between two values, each end ≤ or < | `. > 0 and . <= 20` | Plain text only | Preset **Between**, both ends included by default, with a per-end toggle | 1 |
| Number less than / greater than | `. <= 100` | Plain text only | Preset **Less than / Greater than**, with "or equal" | 1 |
| Number compared with another answer | `. <= ${age_in_years}` | Plain text only | Builder clause with subject **This answer** and another question as the value | 1 |
| Text maximum length | `string-length(.) <= 100` | Plain text only | Preset **At most N characters** | 1 |
| Text minimum or exact length | `string-length(.) = 10` | Plain text only | Preset **At least / Exactly N characters** | 1 |
| Text characters: no digits, digits only, letters only | `regex(.,'^([^0-9]*)$')` | Plain text only | Preset **Allowed characters**: letters (script checklist seeded from the form's languages) / digits / no digits | 1 |
| Text custom pattern | `regex(., '^9[78][0-9]{8}$')` | Plain text only | **Pattern** box (advanced), with a test field | 1 |
| Year typed as text, within a Bikram Sambat range | `int(format-date(today(),'%Y')) + 57 >= int(.)` | Plain text only | Preset **BS year between N years ago and this year** | 1 |
| Date not in the future | `. <= today()` | Plain text only | Preset **Not in the future** (and **Not in the past**); `today()` for date, `now()` for date-time | 1 |
| Date on or after another date | `. > ${lmp_date} and . <= today()` | Plain text only | Preset **On or after [question]**, combinable with not-in-future | 1 |
| Date after the latest of several dates | `. > max(coalesce(${visit_first_date}, 0), …)` | Plain text only | Preset **After all of [questions]** | 1 |
| Date within the last / next N days, weeks or months | `. <= today() - 30 and . >= today() - 294` | Plain text only | Preset **Within the last / next N days/weeks/months** | 1 |
| Date on or after a fixed date | `. >= date('2026-08-05')` | Plain text only | Builder clause with a date picker for the value | 2 |
| Select-many: "None" can't be combined | `not(selected(., 'none') and count-selected(.) > 1)` | Plain text only | Preset **[choice] must be chosen alone** | 1 |
| Select-many: "Other" must be alone | `not(selected(., 'other')) or count-selected(.) = 1` | Plain text only | Same preset as above, any choice | 2 |
| Select-many: choose at least / at most N | `count-selected(.) <= ${L2}` | Plain text only | Preset **Choose at least / at most N** (number or question) | 2 |
| Fixed value (PIN-like) | `. = 9841` | Plain text only | Builder clause **This answer equals** | 1 |
| Compare other answers only | `${role} = 'chw' or ${role} = 'other'` | Visual builder | Already works; keep | — |
| Placeholder with no effect | `true` | Leave as is | Keep as written; show "This rule always passes: no validation" | 1 |

Anything not in this table stays plain text and is saved exactly as written.

## Supporting all of ODK

Every rule above is an ODK XPath expression. CHT has no rule language of its own: forms are XLSForms and run in Enketo, which implements the ODK XForms spec. "Support all of ODK" therefore means three different things, and each needs a different answer.

| Level | What it means | Status today |
| --- | --- | --- |
| 1. Preserve | Any ODK or CHT expression opens, saves byte-identical and still deploys | Done. The round-trip rule and the plain-text fallback cover this |
| 2. Understand | Every expression field knows the ODK and CHT function catalogue: autocomplete, typo detection (`count-selcted`), argument counts, `${field}` names that do not exist, unsupported functions | Not built. This is where "all of ODK" belongs |
| 3. Edit visually | Presets and clauses for the common patterns | 3 of 777 constraints today; Phase 1 in the gap matrix above targets about 97% |

Level 3 should not aim at all of ODK. `if(…)`, `concat`, `format-date`, `indexed-repeat` and nested `coalesce(max(…))` do not map to point-and-click in any builder; Kobo, SurveyCTO and CommCare all stop at simple conditions plus a code box. Level 2 is realistic: the catalogue is finite and documented.

### What real configs actually call

Across every expression column (relevant, calculation, constraint, choice_filter, required, repeat_count, read_only, trigger) the seven configs use **44 distinct functions**, about a third of the ODK library.

| Group | Functions (count of uses) |
| --- | --- |
| Standard ODK / XPath, heavy | `selected` 1,440 · `if` 1,015 · `int` 505 · `today` 451 · `concat` 284 · `decimal-date-time` 256 · `coalesce` 246 · `not` 243 · `regex` 215 · `string-length` 199 · `format-date` 178 · `floor` 157 · `jr:choice-name` 147 · `contains` 132 |
| Standard ODK / XPath, light | `format-date-time` 83 · `translate` 48 · `max` 45 · `date-time` 38 · `now` 36 · `boolean` 36 · `count-selected` 34 · `once` 31 · `string` 25 · `round` 17 · `substr` 8 · `position` 7 · `count` 6 · `date` 4 · `sum` 4 · `join` 4 · `indexed-repeat` 2 · `selected-at` 1 |
| CHT-only extensions | `to-bikram-sambat` 84 · `difference-in-months` 84 · `add-date` 25 · `cht:extension-lib` 14 · `cht:difference-in-days` 10 · `cht:difference-in-weeks` 6 · `cht:difference-in-years` 5 · `cht:difference-in-months` 2 · `z-score` 2 |
| Data lookups | `instance(…)` 295, mostly `instance('contact-summary')` and choice-list lookups. ODK syntax, CHT data sources |

So "all of ODK" is both too much and not enough: configs use a third of ODK's functions and depend on CHT extensions ODK does not have. The catalogue for level 2 is the ODK XPath function list plus CHT's Enketo extensions.

### Other XLSForm columns in use

The same scan shows which columns carry content: `relevant` 3,048 · `calculation` 2,483 · `appearance` 2,202 · `instance::*` 1,622 · `hint` 1,034 · `default` 402 · `read_only` 134 · `choice_filter` 92 · `required_message` 52 · `repeat_count` 19 · `parameters` 4 · `trigger` 2. All are already editable or preserved.

Two things level 2 should flag: a few configs write `constraint_message:en` with one colon instead of `::`, which pyxform may not read as a translation; and ODK features CHT does not run (Entities, `background-audio`, `audit`, some Collect-only appearances).

### Recommendation

- Keep level 3 on the twenty or so patterns in the gap matrix.
- Add level 2 as its own track: a function catalogue for ODK plus CHT, driving autocomplete and checks in every expression field (relevant, calculation, constraint, choice_filter). That is how the builder supports all of ODK without drawing `if(concat(…))` as boxes.

## Proposed support

Teach the builder that `.` means **This answer**, then add a **Validation** panel with presets per question type. Each preset writes ordinary XLSForm, so the saved sheet stays deployable with `cht-conf`.

### 1. Parser: `.` as a subject (shared)

- In `relevantParser.ts`, accept `.` wherever a comparison now needs `${field}`. Values may be a number, a quoted string, another `${field}`, `today()`, `now()`, `date('…')` or `today() ± N`.
- Recognise the function forms real configs use on `.`: `string-length(.)`, `regex(., '…')`, `selected(., '…')`, `count-selected(.)`, `int(.)`, `int(format-date(., '%Y'))`, `max(coalesce(${a}, 0), …)`, `add-date(today(), …)`, `difference-in-months(., today())` and `decimal-date-time(.)`. The full list is in the action items.
- Keep the existing self-check: if re-serializing a rule doesn't give back the exact original text, it stays plain text. Spacing variants such as `.<=100` and `. <= 100` must both round-trip unchanged.

### 2. Validation panel (client)

Shown in the add-question picker and in the row editor. For the constraint column it replaces both current builders, so one rule set applies wherever the user starts. It has one preset list per question type, an error message per visible language, the **required** checkbox and a **required_message** box per language.

| Question type | Preset | Writes to `constraint` |
| --- | --- | --- |
| Number, Decimal | Between 10 and 90 (both ends included) | `. >= 10 and . <= 90` |
| Number, Decimal | Less than 50 / Greater than 70 | `. < 50` / `. > 70` |
| Number, Decimal | At most [another question] | `. <= ${age_in_years}` |
| Text | At most 100 characters | `string-length(.) <= 100` |
| Text | Digits only / No digits | `regex(., '^[0-9]*$')` / `regex(., '^([^0-9]*)$')` |
| Text | Letters only (scripts from the form's languages; here English + Nepali) | `regex(., '^[a-zA-Zऀ-ॿ\s]+$')` |
| Date | Not in the future | `. <= today()` |
| Date | On or after [another date question] | `. >= ${lmp_date}` |
| Date | Within the last 30 days | `. >= today() - 30 and . <= today()` |
| Select many | [None] must be chosen alone | `not(selected(., 'none') and count-selected(.) > 1)` |
| Select many | Choose at most 3 | `count-selected(.) <= 3` |

This table is an illustrative sample; the complete Phase 1 preset list is in the action items.

Presets combine with "and", as in "On or after LMP" plus "Not in the future". The error message box suggests text from the preset, such as "Must be between 10 and 90", which the user can change.

### 3. How an existing rule opens

1. The rule exactly matches a preset: show the preset, filled in.
2. It parses into clauses: show the clause builder, with **This answer** as a subject.
3. Otherwise: plain text, saved exactly as written.

A rule is only rewritten when the user changes it. Opening and saving a form must leave every untouched `constraint` byte-identical, per the round-trip rule in `CLAUDE.md`.

**The preset recogniser must not normalise.** The self-check already keeps *unparsed* rules byte-identical; the gap is the parsed-and-unedited case. A config holding `. <= 100 and . >= 70` may be **displayed** as "Between 70 and 100", but if the author never touches that rule it is re-emitted in its original operand order and spacing. Canonical re-emission happens only for rules the author actually edited. This is the same failure shape as the canonical-form rewrite that made `isAlive` always-true across 26 real tasks (see memory `feedback_serializer_must_not_emit_conventions`). Implementation: the preset view is a projection over the parsed rule; the stored text is kept alongside and wins on save unless the projection changed.

## Phasing, tests and decisions

Phase 1 covers every rule kind down to "Number vs another answer" in the chart, plus "Date not in the future" (it is the same expression as "on or after" rules) and fixed values (free once `.` works): about 705 of the 726 real rules that are not `true` placeholders, or 97%. Phase 2 adds the remaining presets. The 6 cross-field rules stay plain text. Shares come from a rough pattern match, so treat them as estimates. The level 2 function catalogue can run in parallel with any phase; it touches the text editor, not the presets.

| Phase | Adds | Rules covered |
| --- | --- | --- |
| 1 | `.` in the parser; Validation panel in the picker and row editor, replacing both constraint builders; required_message box; number range, limits and vs-another-answer; text max, min and exact length, allowed characters, pattern box; BS year range; date not in future, on/after [question], after all of [questions], within N days/weeks/months; "[None] alone"; fixed value; "always passes" note on `true` | about 705 of 726 |
| 2 | Date on/after a fixed date; "[Other] alone" for any choice; choose at least / at most N | about 720 of 726 |
| Parallel | Level 2: ODK + CHT function catalogue for autocomplete and checks in every expression field | — |

### Test plan

- [ ] `node --test` round-trip case per preset in `shared/src/xlsform/`: parse → serialize → parse is byte-identical, including spacing variants
- [ ] Every round-trip test **calls the serializer** and starts from a **non-canonical fixture** (`.<=100`, `. <= 100 and . >= 70`, `(.)>=1 and (.)<=7`). A parser-only test passed while the `isAlive` corruption shipped on a 603/603 green suite; a fixture that is already canonical cannot detect normalisation.
- [ ] Open-and-save with zero edits on every real config leaves every `constraint` byte-identical, including the ones the preset recogniser displays as presets
- [ ] Pin split (QA, verified): all ten `.` fixtures **already** round-trip byte-identical today, including `true`. The byte-stability half is a **live** assertion now; only the "no raw rules" half is `{ todo: true }`. A fully-todo test enforces nothing, and a parser change that breaks stability is the regression most worth catching
- [ ] `scripts/corpus-sweep.mjs` shows no drift on all seven configs
- [ ] Re-run the builder-open count on the 777 rules; target: every Phase 1 row in the gap matrix opens as a preset or clause (about 705)
- [ ] Playwright: add **age** (integer) with Between 0 and 20 and a message; save; check the sheet; reopen and see the preset filled in
- [ ] Compile one form using every preset with `cht-conf` (the Docker image has the toolchain), so each written rule is valid for Enketo

### Decisions

- **Between includes both ends by default.** In plain speech "between 0 and 20" includes 0 and 20, ODK's own docs write ranges as `>=`/`<=`, and the fully inclusive form is the most common real rule (64 rows). The mixed cases (`. > 0 and . <= 20`) mean "must be positive"; the per-end toggle covers them.
- **Letters only is not Nepali-specific.** The preset offers script checkboxes seeded from the form's languages (English: Latin; Nepali: Devanagari) and writes explicit ranges. To verify before using `\p{L}` instead: Enketo compiles `regex()` with a plain JS `RegExp`, and it is not confirmed that it sets the `u` flag `\p{L}` needs.
- **Add a `required_message` box** next to required, per language. `constraint_message` already exists (one box per language once a constraint is set); both move into the Validation panel.
- **`true` placeholders get a note**, "This rule always passes: no validation", and are never rewritten. 51 real rows carry `true`, `true()` or `1`, usually a leftover from a rule that was planned or removed.
- **`today()` for date questions, `now()` for date-time questions.** A date-time answered at 14:00 today compared with `today()` (midnight) would be wrongly rejected as in the future.
- **Displayed is not edited.** A rule the recogniser shows as a preset is re-emitted verbatim unless the author changed it (see "How an existing rule opens").
- **Wording: these are builder gaps, not CHT gaps.** `regex()`, `string-length()`, `count-selected()` and the rest are supported by pyxform, Enketo and CHT. "Plain text only" in the gap matrix means the builder cannot show the rule, never that CHT cannot run it. The MVP envelope's review rule warns about exactly this confusion.
- **Line references** are against `origin/master` at `bff69cb` (2026-10-01): `relevantParser.ts:370` (the `${}`-only comparison regex), `conditionReducer.ts:507` (`ruleToClause`), `FormEditor.tsx:1260` (`earlierFields`), `:2250` (inline builder), `:2729` (modal). A clone at `a1ac133` is 11 commits behind and has `FormEditor.tsx` before the +110/−21 hosted-authoring change; cite from `bff69cb`.
