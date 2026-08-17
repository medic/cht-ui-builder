<!--
Built the Geriatric use case into the REAL national config (config-nssd/chis)
through the no-code UI, deployed it with the project's own cht-conf command,
and proved the whole task lifecycle on the live instance. This is the record
of what the tool did unaided and what still needed a human. 2026-08-12.
-->

# Geriatric into config-nssd — what the tool built, and what it couldn't

**Verdict: the whole use case builds, deploys and runs — but four hand-edits stand between
"authored in the tool" and "shipped", and one of them blocks the deploy outright.**

Video: `W:\medic\ui-builder-projects\anc-demos\nssd-geriatric-full-arc-2k.webm` (2K, ~15 min, one
continuous take). Spec: `client/tests/geriatric-nssd-full-arc.spec.ts` (build + deploy + runtime,
one test). Build-only and runtime-only variants: `geriatric-nssd-build.spec.ts`,
`geriatric-nssd-live-flow.spec.ts`. Shared content/drivers: `client/tests/helpers/geriatric.ts`.

## What was built, in the tool, into `W:\medic\config-nssd\chis`

| Artifact | Detail |
|---|---|
| `forms/app/integrated_health_assessment_form_for_elder_population.xlsx` | 99 rows. Eligibility `contact.contact_type === 'c82_person' && ageInYears(contact) >= 60` picked from the context builder. EN + नेपाली on every label and choice. The workbook's 10 sections. |
| …its BMI / BP / blood-sugar row (workbook R3) | Three calculates reading **this config's existing** contact-summary keys (`previous_bmi_ctx`, `sys_ctx`, `glucometer_ctx`), which `contact-summary-extras.js` already computes from `hypertension_screening` + `diabetes_screening`. **No contact-summary code was written.** |
| …the seven `refer_*` flags | Hidden calculates via the If-then table, e.g. `if(not(selected(${external_eye}, 'none_of_above')) or ${right_eye} = 'not_see_612' or …, 'true', '')`. These are the contract the workbook lacks — its referral rows are *notes*, which persist nothing. |
| `forms/app/geriatric_care_follow_up_form.xlsx` | The workbook's follow-up: the `visited_facility` gate plus eight domain questions, each gated on its `refer_*` flag. |
| `tasks.js` | One task appended: `appliesToType` the assessment, seven OR'd flag legs, window **15 / 30 / 15** as specified, `resolvedIf` on follow-up submission, `modifyContent` carrying all seven flags. |
| `translations/messages-{en,ne}.properties` | `task.geriatric_referral_follow_up.title` in both locales, written by the tool (item 8). |

**Untouched, as instructed:** the hierarchy, the 16 contact types, every contact form, and all
37 pre-existing app forms. Verified: **zero lines** of the original 1050-line `tasks.js` were
lost or rewritten (the `b0278b3` fix holding up against a real hand-written file).

## The four hand-edits — what the no-code tool could not do

### 1. 🔴 Reformat the emitted task to the config's ESLint style — *blocks the deploy*
`compile-app-settings` runs the project's own `@medic` ESLint. The serializer's output failed it
with **16 errors**, so **nothing deployed at all** until a human reformatted the file:

- `indent` ×13 — bodies emitted at 0/2/8 spaces where the config requires 4/6
- `brace-style` ×2 — `if (…) { return false; }` on one line
- `no-unused-vars` — `modifyContent: function (content, contact, report, event)`; the tool always
  emits the four-arg signature even when `event` is unused

This is the single most important finding: **the tool emits its own formatting rather than the
formatting it parsed**, and any config with lint enforcement rejects the result. Fix shape: emit
in the style of the surrounding file (or run the project's own lint --fix on the touched range),
and omit unused trailing parameters.

### 2. Relocate the follow-up's `refer_*` rows to be direct children of `inputs`
The only affordance ("+ add inside" on the `inputs` accordion) puts new rows under
`inputs/user/`, but CHT binds `modifyContent` content keys to **direct** `inputs` children — so
the flags never arrive and the follow-up cannot branch. Relocated with a serializer script.
Fix shape: a "task inputs" affordance that declares the receiving nodes in the right place.

### 3. Rewrite the `modifyContent` sources (done on camera, via Raw JS)
The mapping picker emits `content.refer_x = report.refer_x`, which is `undefined` at runtime —
report answers live under `report.fields.*`. Switching the row's source to *custom* resets it and
demotes the whole table to read-only, so the actions field's **Raw JS hatch is the only working
path**. Rewritten to this config's own house style: `Utils.getField(report, 'refer_x')`.

### 4. Type the contact-summary context keys by hand
The cross-form calculation picker lists only keys it can parse from a structured
`context: { … }` literal. This config assembles context imperatively
(`getContext()` → `context.previous_bmi_ctx = …`), so the picker showed nothing and all three
keys were typed into the raw editor. Not a blocker — but it is a hand-typed identifier, which
the no-code bar forbids. Fix shape: also detect `context.<key> = …` assignments.

## Deploy

Ran the project's documented command verbatim — **All actions completed, exit 0**:

```
cht --url=https://medic:password@127-0-0-1.local-ip.medicmobile.org:10445/ \
  compile-app-settings convert-app-forms convert-collect-forms convert-contact-forms \
  upload-app-settings upload-app-forms upload-collect-forms upload-contact-forms \
  upload-resources upload-custom-translations --force
```

`forms/collect` does not exist in this config, so those two steps no-op. Both forms uploaded,
settings updated, both translation files uploaded.

## Runtime — proven on the live instance

CHW `nssd_chw` at *FCHV Area 5A-1*, patient **Devi Kumari Thapa (67)** under *Thapa Household*:

1. The assessment is offered on her profile — the `c82_person` + age-60 gate works.
2. Page 1 renders her **BMI 27.6 / BP 138 / sugar 145**, pulled from her existing hypertension and
   diabetes screening reports through the config's own contact summary.
3. Filling it with the cognitive screen failed writes `refer_cognitive: "true"` into the report.
4. The task appears with its **translated** title.
5. Tapping it opens the follow-up **branched to the cognitive domain only** — the other six
   domains asserted absent, which is what proves `modifyContent` delivered.
6. Submitting the follow-up **resolves** the task.

**Time note:** the customer's window is start 15 / due 30, so a task correctly does *not* appear
on the day of submission. Rather than weaken the config for the demo, the run backdates the
submitted report 20 days and says so on screen.

## Data seeded for the demo (data only — no config change)

One NSSD branch: `NSSD Center → Gandaki Province → Kaski District → Pokhara Metropolitan →
Ward 5 → CHN Area 5A → FCHV Area 5A-1 → Thapa Household → Devi Kumari Thapa (1959-04-02)`,
plus hypertension + diabetes screening reports for her, and the user `nssd_chw` / `NssdCare!2026x`.

Worth stating plainly, since it caused confusion: **cht-conf deploys configuration, never
documents.** `upload-app-settings` defines contact *types*; the People tab stays empty until place
*docs* exist. That is why a freshly deployed config shows no hierarchy.

## One error of mine, for the record

Fixing the unused-`event` lint error, I used a blanket string replace and stripped the parameter
from a **pre-existing `pnc_service_form` task that legitimately uses `event`**. Caught it from the
lint line number and restored it; the file is verified byte-intact against the pre-build snapshot.
Blanket edits have no place in a real config.
