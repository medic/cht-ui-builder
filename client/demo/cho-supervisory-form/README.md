# CHO Supervisory Form — built with no code

Source: slides 10–20 of the NSSD "CHO Supervisory Form" deck. The video in
this folder shows the whole form being built in the CHT UI Builder with no
XPath typed: every section, question, choice list, hint, widget and
show/hide rule is picked or typed as plain text. The resulting
`cho_supervisory_form.xlsx` and its `.properties.json` sit beside the video,
ready to drop into a cht-conf project's `forms/app/`.

Re-record from `client/`:

```sh
DEMO_OUT=cho-supervisory-form DEMO_MS=0 ./node_modules/.bin/playwright test -c playwright.demo.config.ts tests/t9-demos/cho_supervisory_form.demo.spec.ts
```

The recording is paced like a person: a visible cursor glides to each control
and rings on every click, text is typed one character at a time, and there is
a pause after every click, label and row. `DEMO_TYPE_MS` (ms per character,
default 18) and `DEMO_PAUSE_MS` (pause after a click, default 350) tune it;
`DEMO_MS` (slow-motion per action) stays 0 here because it would also slow every keystroke.

## What the video does, in order

1. **Forms → + App form**, title *CHO Supervisory Form*; the file name
   `cho_supervisory_form` is derived from the title. Switch to **Full** view.
2. For each of the 11 sections: **+ Section** with the English title and the
   Nepali heading, then **+ Question** for each row. A new row lands right
   after the row just added, inside the section.
3. Choice questions get their list in the picker: a list name, one row per
   choice with name, English label and Nepali label. The second question
   that needs the same list ticks **Reuse** instead.
4. Hints are typed under **Messages → Help text** (`hint::ne`).
5. Multi-line answer boxes use **✎ pick widgets → multiline**.
6. Show/hide rules use the sentence strip: *Show this question when* →
   field → *equals* / *includes* → value → **Apply**.
7. **Save**, then the sheet is read back and the five rules checked on disk.

## Sections and rows

| Section (en · ne) | Rows |
| --- | --- |
| Physical condition · भौतिक अवस्था | device_condition, device_charge (4-point ratings with the slide's descriptions) |
| App use · एप प्रयोग | cht_primary_app (rating, hint about Digital Wellbeing) |
| Installed apps · इन्स्टल गरिएका एप | unauthorized_apps, synced_before_visit (छ/छैन), sync_counsel note shown when not synced |
| App performance · एपको कार्यसम्पादन | app_performance (rating), has_feedback, feedback_details (multiline, shown when छ) |
| Checklist · चेकलिस्ट | note + 8 items on छ/छैन/लागू हुँदैन: BP set, glucometer, thermometer, MUAC tape, weight machine, height tape, FP supplies, ORS/Zinc/Albendazole |
| Task tab review · कार्य ट्याब समीक्षा | note, 4 numbers (tasks due, overdue, households visited, use cases), followup_method, followup_method_other (shown for अन्य) |
| Household verification · घरधुरी प्रमाणीकरण | note, discrepancy_found (भेटियो/भेटिएन), discrepancy_note shown when भेटियो |
| Rapport building · मधुर सम्बन्ध स्थापना | greeted_consent (थिए/थिएन), observe note, privacy_respect (rating), explained_purpose (hint with the example), good_rapport |
| Vital signs · भाइटल साइन | bp_pulse_measured |
| Counselling · परामर्श | health_messages, understandable_language, active_listening (ratings) |
| Closing discussion · समापन छलफल | note, challenges (multiple choice, 8 options), challenges_other (shown when अन्य ticked), strengths, improvements (multiline) |

## Rules written by picking

| Row | Rule on disk |
| --- | --- |
| sync_counsel | `${synced_before_visit} = 'no'` |
| feedback_details | `${has_feedback} = 'yes'` |
| followup_method_other | `${followup_method} = 'other'` |
| discrepancy_note | `${discrepancy_found} = 'found'` |
| challenges_other | `selected(${challenges}, 'other')` |

## Judgement calls against the slides

- The sync counselling note is shown only when the CHN has **not** synced; the
  slide shows it unconditionally.
- Rating options carry the slide's full Nepali description as the choice
  label, so each rating question has its own list; the English labels are
  the one-word ratings.
- "Please describe in detail", strengths and improvements are one
  multi-line box each rather than four numbered lines.
- Slide 21 (carrying agreed actions to the next visit) is not part of the
  form; it needs a task or a contact-summary card.
