# Household Survey (PIH Malawi) — built with no code, deployed, and filled

Two videos for a PM/PO audience, from the "HH Survey" sheet of the PIH Malawi
Integrated Workflow design workbook. Both are human-paced: a visible pointer,
text typed character by character, one fixed gap between inputs, plain-language
captions. Nothing in either video needs a developer.

| File | What it shows | Length |
| --- | --- | --- |
| `hh_survey.mp4` (`.small.mp4` for sharing) | Build the survey from the design sheet in the CHT UI Builder, then set its properties: name, icon, where it appears. Save, with the review step on screen. | about 19 min |
| `hh_survey_deploy.mp4` (`.small.mp4`) | Deploy from the builder's Deploy tab to a fresh local CHT (checks first, then upload), create a health-facility user in the CHT admin, sign in as that user, fill the survey on a household, see the report saved. | about 4 min |
| `project/` | The cht-conf project the videos use: the CHT baseline plus `forms/app/hh_survey.xlsx` and its properties. Deployable as-is. | |

Re-record from `client/` (the second needs the `pih_demo` CHT running on port 10446):

```sh
DEMO_OUT=pih-hh-survey DEMO_MS=0 ./node_modules/.bin/playwright test -c playwright.demo.config.ts tests/t9-demos/hh_survey.demo.spec.ts
DEMO_OUT=pih-hh-survey DEMO_MS=0 ./node_modules/.bin/playwright test -c playwright.demo.config.ts tests/t9-demos/hh_survey_deploy.demo.spec.ts
```

## Video 1, in order

1. **Forms → + App form**, title *HH Survey*. The file name `hh_survey` is derived.
2. For each of the 11 sections: **+ Section**, then **+ Question** per row with the English label and a type tile. Answer lists are typed once in the picker and reused where the sheet reuses them (yes/no, the agreement scale).
3. **Required** ticked on every question the sheet marks required.
4. Show-only-when rules picked in the sentence strip: six "specify other" boxes, the shared-toilet question, hand-washing soap, cervical screening when women aged 30-49 ≥ 1, the epilepsy message, the phone-charging chain, the comments box.
5. "None cannot be ticked with other items" from the Validation menu on the assets question.
6. **Properties**: title *Household Survey*, icon `icon-household`, *Available on places*, and *+ contact type → clinic* (the household type).
7. **Save**, with the review of what changes, then **Show preview**.

## Video 2, in order

1. **Deploy** tab: target `--url` with the CHT address and admin login, **Test connection**.
2. **Validate everything (no upload)**: cht-conf validates and compiles the whole project; the log is the real output.
3. **Deploy everything** (confirmation accepted): settings, forms and contact forms go up.
4. The administrator's one-time setup on the CHT happens off camera through the API: a district, a health centre, a household with one person, and the facility nurse's contact.
5. In the CHT admin, **Add User**: user name, full name, role *CHW Supervisor*, place *Dambe Health Centre*, contact *Grace Phiri*, password.
6. Sign in as that user. The CHT asks a new user to choose their own password on first sign-in.
7. Open the household, open the survey, answer it one screen at a time. Conditional questions appear as the rules fire. **Submit**. The report is read back from the CHT database.

## Rules on disk, as written by picking

| Row | Rule |
| --- | --- |
| floor_material_other and the other five "specify" boxes | `${field} = 'other'` |
| toilet_shared | `${toilet} != 'bucket' and ${toilet} != 'none' and ${toilet} != 'other'` |
| handwashing_soap | `${handwashing} = 'yes'` |
| women_screened_cervical | `${women_30_49} >= 1` |
| epilepsy_note | `${fits} = 'yes'` |
| phone_charge_where / phone_charge_outside / phone_charge_other | `= 'yes'` / `= 'outside'` / `= 'other'` |
| comments | `${satisfied} = 'no'` |
| assets (constraint) | `not(selected(., 'none') and count-selected(.) > 1)` |
| properties context | `contact.type === 'clinic'` |

## Judgement calls against the design sheet

- English only. The sheet mixes English and Chichewa in some cells; the Chichewa was left out rather than added as a half-filled second language.
- The shared-toilet rule is written as "not bucket, not none, not other" instead of "flush or pit or composting". Same logic; the sentence strip cannot start a brand-new rule with "or" (see below).
- The survey's one-screen-per-question layout comes from the project's `pages` style; the sections are groups without the one-screen appearance.

## Builder gaps and bugs found while making these

1. **Classic contact types were written with the wrong field.** The context builder emitted `contact.contact_type === 'clinic'`, but the CHT stores its four classic types (district, health centre, household, person) under `type`, so the running app refused the form with "not authorized". Fixed: the builder now emits `contact.type` for those four ids and `contact.contact_type` for custom ids.
2. **`true && …`.** Adding the first rule appended to the "always show" placeholder instead of replacing it. Fixed.
3. **No way to start an "or" rule in the sentence strip.** The "and also / or instead" chooser only appears once a clause is staged, and staging locks the chain to "and also". The grouped builder behind `code` can do it; the strip cannot. Open.
4. **The one-click deploy opens a browser confirm**; fine for people, but worth knowing for automation.
5. **The project needs its one declared dependency installed** (`npm install` in the project folder, for `moment`) before settings compile outside the hosted image, which bundles it.
