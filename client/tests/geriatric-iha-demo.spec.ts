/**
 * GERIATRIC IHA FULL-SCALE DEMO (QA / Lorena, 2026-08-06) — builds the ENTIRE
 * "Integrated Health Assessment form for elder population" sheet (52 rows)
 * through the no-code UI, and records it POC-style as one continuous video.
 *
 * This is Phase 1 of docs/qa-brief-geriatric-build.md at real scale: where
 * geriatric-build.spec.ts proves each capability once, this drives the actual
 * customer sheet — every section, every question, real EN + NE labels, real
 * choice lists, the real relevance chains (fail→notes, either-of referral
 * triggers, "any option except none" via NOT selected()), the chair-rise
 * display image, and the three cross-form pulls (BMI / BP / blood sugar)
 * from Hypertension & Diabetes screening forms built here too.
 *
 * Row-mapping notes (vs the source sheet, geri-full.txt):
 *  - R1 consent: the "Form close if disagree" behaviour has NO primitive
 *    (NEXT.md #9) — the consent question is authored; the close is a known
 *    FRICTION, not attempted.
 *  - R3 (one sheet row) expands to 3 calculates + 3 notes (one per value).
 *  - R51's 10-point advice text is entered with headline lines per point
 *    (full body text would add nothing to the buildability question).
 *  - R52 is a slide reference, not a form row — skipped.
 *  - Choice NE labels are typed INLINE in the add-picker (item F, 8eda602:
 *    one label column per active locale) — the old Translate→Choices detour
 *    is gone from this spec.
 *
 * Safety rule honoured: fresh project from fixtures/mini-config; never
 * touches Helpers → "✎ edit body"; cross-form goes through Context values.
 *
 * Iterate fast, then record slow (POC pattern):
 *   pnpm --filter @cht-ui/shared build            # stale-Vite guard
 *   pnpm --filter @cht-ui/client exec playwright test geriatric-iha-demo.spec.ts --reporter=line
 *   $env:DEMO=1 ; ...same...                      # slow-mo video (DEMO_MS to tune, default 800)
 * Video lands in client/test-results/…; copy it to a stable path afterward.
 */
import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(here, 'fixtures', 'mini-config');
const API = 'http://127.0.0.1:5174';
/** Stable path, not mkdtemp — survives Playwright's worker restart on failure. */
const PROJECT = path.join(os.tmpdir(), 'cht-ui-geri-iha-demo');

const SLOW = process.env.DEMO ? Number(process.env.DEMO_MS ?? '800') : 0;

const IHA_TITLE = 'Integrated Health Assessment';
const IHA_BASENAME = 'integrated_health_assessment';
const IHA_FORM_ID = `app:${IHA_BASENAME}`;

test.use({
  video: { mode: 'on', size: { width: 2560, height: 1440 } },
  viewport: { width: 2560, height: 1440 },
  launchOptions: { slowMo: SLOW },
});

/* ───────────────────────────── content ─────────────────────────────
 * All labels transcribed from the customer sheet (geri-full.txt). Question
 * and choice NAMES are chosen unique across the form so the Translate grid
 * rows can be matched unambiguously (NEXT.md finding D: names are still
 * typed by hand in the picker — recorded as friction, not worked around). */

type Choice = { name: string; en: string; ne: string };
type NewList = { list: string; choices: Choice[] };
type Rel =
  | { kind: 'cmp'; field: string; choice: string }
  | { kind: 'selectedNot'; field: string; choice: string };
type Row = {
  name: string;
  en: string;
  ne: string;
  tile: RegExp; // .qtype-tile-label matcher
  required?: boolean;
  list?: NewList; // author a new list in the picker
  reuse?: string; // or reuse an existing one
  rel?: { or?: boolean; rules: Rel[] };
};
type Section = { en: string; ne: string; slug: string; oneScreen?: boolean; rows: Row[] };

const T = {
  note: /^Note$/,
  s1: /^Single choice$|^Select one$/,
  sN: /^Multiple choice$|^Select many$/,
  num: /^Number$|^Integer$/,
} as const;

const PASS_FAIL: NewList = {
  list: 'pass_fail',
  choices: [
    { name: 'yes_fail', en: 'Yes (Fail)', ne: 'छ (फेल)' },
    { name: 'no_pass', en: 'No (Pass)', ne: 'छैन (पास)' },
  ],
};

const SECTIONS: Section[] = [
  {
    en: 'Cognitive decline', ne: 'संज्ञानात्मक ह्रास / स्मरणशक्ति र अभिमुखीकरण', slug: 'cognitive_decline',
    rows: [
      { name: 'memory_trouble', tile: T.s1, required: true, list: PASS_FAIL,
        en: 'Do you have trouble remembering things? For example, do you sometimes forget where you currently are, or what day of the week it is today?',
        ne: 'के तपाईंलाई सम्झने कुरामा समस्या छ? जस्तै: तपाईं अहिले कहाँ हुनुहुन्छ वा आज कुन बार हो भन्ने कहिलेकाहीँ बिर्सिनुहुन्छ?' },
      { name: 'memory_test_note', tile: T.note,
        en: 'Conduct a simple memory test;', ne: 'सरल स्मृति परीक्षण गर्नुहोस् ;',
        rel: { rules: [{ kind: 'cmp', field: 'memory_trouble', choice: 'yes_fail' }] } },
      { name: 'memorize_words_note', tile: T.note,
        en: 'Have them memorize 3 simple words, for example: Rice, Ranimahal, Fewa Lake.',
        ne: '३ वटा सरल शब्द याद गराउनुहोस् जस्तै: चामल, रानीमहल, फेवाताल।',
        rel: { rules: [{ kind: 'cmp', field: 'memory_trouble', choice: 'yes_fail' }] } },
      { name: 'word_recall', tile: T.s1, required: true,
        en: 'Now have them repeat these 3 words.', ne: 'अब यी ३ वटा शब्द लाई दोहोर्‍याउन लगाउनुहोस्।',
        list: { list: 'word_recall_result', choices: [
          { name: 'recall_pass', en: 'Able to repeat all three words (Pass)', ne: 'तीनै शब्द दोहोर्‍याए (पास)' },
          { name: 'recall_fail', en: 'Unable to repeat all three words (Fail)', ne: 'तीनै शब्द दोहोर्‍याउन असमर्थ (फेल)' },
        ] },
        rel: { rules: [{ kind: 'cmp', field: 'memory_trouble', choice: 'yes_fail' }] } },
      { name: 'date_place', tile: T.s1, required: true,
        en: "What is today's full date, and where are you right now?", ne: 'आजको पूरा मिति र अहिले तपाईं कहाँ हुनुहुन्छ ?',
        list: { list: 'orientation_result', choices: [
          { name: 'orient_pass', en: 'Both correct (Pass)', ne: 'दुवै सहि (पास)' },
          { name: 'orient_fail', en: 'Unable to state both correctly (Fail)', ne: 'दुवै कुरा भन्न असमर्थ (फेल)' },
        ] },
        rel: { rules: [{ kind: 'cmp', field: 'memory_trouble', choice: 'yes_fail' }] } },
      { name: 'cognitive_refer_note', tile: T.note,
        en: 'Refer them to an appropriate health facility for further examination.',
        ne: 'उहाँलाई थप जाँचको लागि उपयुक्त स्वास्थ्य संस्थामा प्रेषण गर्नुहोस्।',
        rel: { or: true, rules: [
          { kind: 'cmp', field: 'word_recall', choice: 'recall_fail' },
          { kind: 'cmp', field: 'date_place', choice: 'orient_fail' },
        ] } },
    ],
  },
  {
    en: 'Limited mobility', ne: 'सीमित गतिशीलता / चलायमान क्षमता', slug: 'limited_mobility',
    rows: [
      { name: 'chair_rise_note', tile: T.note,
        en: 'Conduct the chair-rise test;', ne: 'कुर्सीबाट उठ्ने परीक्षण गर्नुहोस् ;' }, // R11's image attaches here
      { name: 'safe_to_test', tile: T.s1, required: true,
        en: 'Without using your hands, do you feel safe standing up and sitting down quickly 5 times?',
        ne: 'हात नचलाई, छिटोछिटो ५ पटक उठेर बस्न तपाईंलाई सुरक्षित लाग्छ?',
        list: { list: 'chair_test_choice', choices: [
          { name: 'will_test', en: 'Yes (Test)', ne: 'लाग्छ (परीक्षण गर्ने)' },
          { name: 'wont_test', en: 'No (Do not test)', ne: 'लाग्दैन (परीक्षण नगर्ने)' },
        ] } },
      { name: 'timer_note', tile: T.note,
        en: 'Before starting the activity, have a watch/phone ready. You need to record how long this activity takes.',
        ne: 'क्रियाकलाप सुरु गर्नुअगाडि घडी / फोन तयार राख्नुहोस्। यो क्रियाकलाप गर्न कति समय लाग्छ रेकर्ड गर्नुपर्छ।' },
      { name: 'sit_stand_time', tile: T.s1, required: true,
        en: 'How many seconds did it take to complete standing up and sitting down quickly 5 times?',
        ne: '५ पटक छिटो-छिटो उठेर बस्न पूरा हुन कति सेकेण्ड लाग्यो?',
        list: { list: 'sit_stand_result', choices: [
          { name: 'fourteen_or_less', en: '14 seconds or less (Pass)', ne: '१४ सेकेन्ड वा सो भन्दा कम (पास)' },
          { name: 'over_fourteen', en: 'More than 14 seconds (Fail)', ne: '१४ सेकेन्ड भन्दा बढी (फेल)' },
        ] },
        rel: { rules: [{ kind: 'cmp', field: 'safe_to_test', choice: 'will_test' }] } },
      { name: 'mobility_refer_note', tile: T.note,
        en: 'Refer them to an appropriate health facility for further examination.',
        ne: 'उहाँलाई थप जाँचको लागि उपयुक्त स्वास्थ्य संस्थामा प्रेषण गर्नुहोस्।',
        rel: { rules: [{ kind: 'cmp', field: 'sit_stand_time', choice: 'over_fourteen' }] } },
    ],
  },
  {
    en: 'Nutrition check', ne: 'पोषण जाँच', slug: 'nutrition_check',
    rows: [
      { name: 'weight_loss', tile: T.s1, required: true,
        en: 'In the past 3 months, has your weight decreased by more than 3 kg unintentionally (without meaning to)?',
        ne: 'विगत ३ महिनामा तपाईंको तौल आफैँ (ननचाहँदानचाहँदै) ३ केजी भन्दा बढी घटेको छ?',
        list: { list: 'weight_loss_choice', choices: [
          { name: 'wl_yes_fail', en: 'Yes (Fail)', ne: 'छ (फेल)' },
          { name: 'wl_no_pass', en: 'No (Pass)', ne: 'छैन (पास)' },
          { name: 'wl_dont_know', en: "Don't know", ne: 'थाहा छैन' },
        ] } },
      { name: 'clothes_loose', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Have your clothes, waistband, or belt become loose?', ne: 'तपाईंको लुगा, पटुका वा बेल्ट खुकुलो भएको छ ?' },
      { name: 'appetite_loss', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Have you stopped feeling hungry?', ne: 'तपाईंलाई भोक नलाग्ने भएको छ ?',
        rel: { rules: [{ kind: 'cmp', field: 'weight_loss', choice: 'wl_dont_know' }] } },
      { name: 'weight_kg', tile: T.num,
        en: 'Measure their weight. (in kg)', ne: 'उहाँको तौल नाप्नुहोस्। (के.जी.मा)' },
      { name: 'nutrition_refer_note', tile: T.note,
        en: 'Refer them to an appropriate health facility for further examination.',
        ne: 'उहाँलाई थप जाँचको लागि उपयुक्त स्वास्थ्य संस्थामा प्रेषण गर्नुहोस्।',
        rel: { or: true, rules: [
          { kind: 'cmp', field: 'weight_loss', choice: 'wl_yes_fail' },
          { kind: 'cmp', field: 'clothes_loose', choice: 'yes_fail' },
          { kind: 'cmp', field: 'appetite_loss', choice: 'yes_fail' },
        ] } },
    ],
  },
  {
    en: 'Vision check', ne: 'दृष्टि जाँच', slug: 'vision_check',
    rows: [
      { name: 'eye_problem', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Do you have any eye-related problems? For example, difficulty seeing things far away or close up, or pain, burning, or discomfort in the eyes.',
        ne: 'के तपाईंलाई आँखासम्बन्धी कुनै समस्या छ? जस्तै: टाढाको वा नजिकको चीज देख्न गाह्रो हुनु, वा आँखामा दुखाइ, पोल्ने वा असजिलो हुनु।' },
      { name: 'diabetes_htn_meds', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Do you have diabetes or high blood pressure, or are you currently taking steroids or any medication?',
        ne: 'के तपाईंलाई मधुमेह वा उच्च रक्तचाप छ, वा हाल स्टेरोइड वा कुनै औषधि खाइरहनुभएको छ?' },
      { name: 'external_eye', tile: T.sN, required: true,
        en: 'Examine the external eye.', ne: 'बाह्य आँखाको जाँच गर्नुहोस्',
        list: { list: 'external_eye_findings', choices: [
          { name: 'pus', en: 'There is pus', ne: 'पिप छ' },
          { name: 'watery_eyes', en: 'There are tears / watery eyes', ne: 'आँसु झर्ने छ' },
          { name: 'eyelid_inward', en: 'The eyelid is turned inward', ne: 'परेला भित्रतिर मोडिएको छ' },
          { name: 'red_white_part', en: 'Abnormal redness in the white part of the eye', ne: 'आँखाको सेतो भागमा असामान्य रातो छ' },
          { name: 'cloudy_cornea', en: 'The cornea is cloudy or red', ne: 'कर्निया धमिलो वा रातोपन छ' },
          { name: 'none_of_above', en: 'None of the above', ne: 'कुनै पनि छैन' },
        ] } },
      { name: 'who_chart_note', tile: T.note,
        en: '1. Place the WHO vision chart 3 meters away from the patient. 2. Test each eye separately. 3. Right eye: cover the left. 4. Left eye: cover the right.',
        ne: '१. WHO दृष्टि चार्टलाई बिरामीबाट ३ मिटर टाढा राख्नुहोस्। २. प्रत्येक आँखा छुट्टाछुट्टै जाँच्नुहोस्। ३. दाहिने आँखा जाँच्दा देब्रे आँखा छोप्न लगाउनुहोस्। ४. देब्रे आँखा जाँच्दा दाहिने आँखा छोप्न लगाउनुहोस्।',
        rel: { rules: [{ kind: 'cmp', field: 'eye_problem', choice: 'yes_fail' }] } },
      { name: 'right_eye', tile: T.s1, required: true,
        en: 'Right eye (WHO chart, from 3 meters)', ne: 'दाहिने आँखा (WHO चार्ट, ३ मिटरबाट)',
        list: { list: 'vision_612', choices: [
          { name: 'see_612', en: 'Can see 6/12 (Pass)', ne: '६/१२ देख्यो (पास)' },
          { name: 'not_see_612', en: 'Cannot see 6/12 (Fail)', ne: '६/१२ देखेन (फेल)' },
        ] },
        rel: { rules: [{ kind: 'cmp', field: 'eye_problem', choice: 'yes_fail' }] } },
      { name: 'left_eye', tile: T.s1, required: true, reuse: 'vision_612',
        en: 'Left eye (WHO chart, from 3 meters)', ne: 'देब्रे आँखा (WHO चार्ट, ३ मिटरबाट)',
        rel: { rules: [{ kind: 'cmp', field: 'eye_problem', choice: 'yes_fail' }] } },
      { name: 'near_vision', tile: T.s1, required: true,
        en: 'Both eyes together (N6 chart, from 40 cm)', ne: 'दुवै आँखासँगै (N6 चार्ट, ४० से.मि.बाट)',
        list: { list: 'vision_n6', choices: [
          { name: 'see_n6', en: 'Can see N6 (Pass)', ne: 'N6 देख्यो (पास)' },
          { name: 'not_see_n6', en: 'Cannot see N6 (Fail)', ne: 'N6 देखेन (फेल)' },
        ] },
        rel: { rules: [{ kind: 'cmp', field: 'eye_problem', choice: 'yes_fail' }] } },
      { name: 'glasses_retest_note', tile: T.note,
        en: 'Retest with glasses', ne: 'चस्मासँगै पुनः परीक्षण गर्ने',
        rel: { rules: [{ kind: 'cmp', field: 'near_vision', choice: 'not_see_n6' }] } },
      { name: 'near_vision_glasses', tile: T.s1, required: true, reuse: 'vision_n6',
        en: 'Both eyes together, with glasses (N6 chart, from 40 cm)', ne: 'चस्मासँगै — दुवै आँखासँगै (N6 चार्ट, ४० से.मि.बाट)',
        rel: { rules: [{ kind: 'cmp', field: 'near_vision', choice: 'not_see_n6' }] } },
      // R30 — "any external-eye option EXCEPT none / or any Fail" → NOT selected(none) OR fails.
      { name: 'eye_refer_note', tile: T.note,
        en: 'Refer them to an eye hospital for further examination.',
        ne: 'उहाँलाई थप जाँचका लागि आँखाको अस्पतालमा प्रेषण गर्नुहोस्।',
        rel: { or: true, rules: [
          { kind: 'selectedNot', field: 'external_eye', choice: 'none_of_above' },
          { kind: 'cmp', field: 'right_eye', choice: 'not_see_612' },
          { kind: 'cmp', field: 'left_eye', choice: 'not_see_612' },
        ] } },
    ],
  },
  {
    en: 'Hearing check', ne: 'श्रवण क्षमता जाँच', slug: 'hearing_check',
    rows: [
      { name: 'hearing_trouble', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Do you have trouble hearing? For example, do others have to speak loudly when talking to you, or do you have to get very close to them to hear?',
        ne: 'के तपाईंलाई सुन्न समस्या छ? जस्तै; अरूले तपाईंसँग कुरा गर्दा चर्को आवाजमा बोल्नुपर्ने हुन्छ, वा तपाईं उहाँहरूको एकदमै नजिक गएर सुन्नुपर्ने हुन्छ?' },
      { name: 'whisper_method_note', tile: T.note,
        en: 'Whisper Test Method: 1. Stand behind the patient, about 60 cm away. 2. Close the ear not being tested (press the tragus). 3. In one breath whisper 4 simple, unrelated words (rice, fish, bicycle, garden). 4. Ask the patient to repeat each word. 5. Also on the other ear.',
        ne: 'कानेखुसी परीक्षण विधि: १. बिरामीको पछाडि, करिब ६० से.मि. टाढा उभिनुहोस्। २. नजाँच्ने कानको ट्रेगस थिचेर बन्द गर्न लगाउनुहोस्। ३. एउटै सासमा ४ वटा साधारण शब्द कानेखुसीमा भन्नुहोस् (चामल, माछा, साइकल, बगैंचा)। ४. प्रत्येक शब्द दोहोर्‍याउन भन्नुहोस्। ५. अर्को कानमा पनि।',
        rel: { rules: [{ kind: 'cmp', field: 'hearing_trouble', choice: 'yes_fail' }] } },
      { name: 'right_ear', tile: T.s1, required: true,
        en: 'Right ear result', ne: 'दायाँ कानको परिणाम',
        list: { list: 'whisper_result', choices: [
          { name: 'four_words_pass', en: 'Successfully repeated all four words (Pass)', ne: '४ वटै शब्द दोहोर्‍याउन सफल (पास)' },
          { name: 'four_words_fail', en: 'Unable to repeat all four words (Fail)', ne: '४ वटै शब्द दोहोर्‍याउन असफल (फेल)' },
        ] } },
      { name: 'left_ear', tile: T.s1, required: true, reuse: 'whisper_result',
        en: 'Left ear result', ne: 'बायाँ कानको परिणाम' },
      // R35 — BOTH ears failed (AND join, the builder's default).
      { name: 'ent_refer_note', tile: T.note,
        en: 'Refer them to a health facility with an ENT (ear, nose, and throat) doctor available for further examination.',
        ne: 'उहाँलाई थप जाँचका लागि नाक, कान र घाँटीको डाक्टर उपलब्ध हुने स्वास्थ्य संस्थामा प्रेषण गर्नुहोस्।',
        rel: { rules: [
          { kind: 'cmp', field: 'right_ear', choice: 'four_words_fail' },
          { kind: 'cmp', field: 'left_ear', choice: 'four_words_fail' },
        ] } },
    ],
  },
  {
    en: 'Psychological check', ne: 'मनोवैज्ञानिक जाँच', slug: 'psychological_check',
    rows: [
      { name: 'feeling_sad', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Over the past 2 weeks or more, have you been feeling persistently sad, down, or discouraged?',
        ne: 'के तपाईं पछिल्लो २ हप्ता वा त्योभन्दा बढी समयदेखि लगातार निराश, उदास, वा हतोत्साहित महसुस गरिरहनुभएको छ?' },
      { name: 'lost_interest', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Over the past 2 weeks or more, have you consistently felt little interest or pleasure in doing things?',
        ne: 'के तपाईंलाई पछिल्लो २ हप्ता वा त्योभन्दा बढी समयदेखि लगातार कुनै पनि काम वा कुरामा रुचि वा खुसी नभएको महसुस भइरहेको छ?' },
      { name: 'self_harm_thoughts', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Recently, have you had thoughts of harming yourself or not wanting to live?',
        ne: 'के पछिल्लो समयमा तपाईंलाई आफूलाई हानि गर्ने वा बाँच्न मन नलाग्ने जस्ता विचार आएको छ?' },
      { name: 'mental_refer_note', tile: T.note,
        en: 'Please provide mental health counseling to them and their family, and refer them to a health facility with a psychiatrist available.',
        ne: 'कृपया उहाँ र परिवारलाई राखी मानसिक स्वास्थ्य सम्बन्धी परामर्श दिनुहोस् र उहाँलाई मनोचिकित्सक उपलब्ध भएको स्वास्थ्य संस्थामा प्रेषण गर्नुहोस्।',
        rel: { or: true, rules: [
          { kind: 'cmp', field: 'feeling_sad', choice: 'yes_fail' },
          { kind: 'cmp', field: 'lost_interest', choice: 'yes_fail' },
          { kind: 'cmp', field: 'self_harm_thoughts', choice: 'yes_fail' },
        ] } },
    ],
  },
  {
    en: 'Social care and support', ne: 'सामाजिक हेरचाह र सहयोग', slug: 'social_care_and_support',
    rows: [
      { name: 'family_care_satisfied', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Are you satisfied with the care provided by your household/family? For example safety, cleanliness/hygiene, and adequate space',
        ne: 'के तपाईं आफ्नो घर परिवारको हेरचाह बाट सन्तुष्ट हुनुहुन्छ ? जस्तै -सुरक्षा, सरसफाइ, र पर्याप्त ठाउँ।' },
      { name: 'money_problems', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Have you experienced problems due to not having enough money for food, housing, and healthcare services?',
        ne: 'खाना, आवास र स्वास्थ्य सेवाको लागि पैसा नपुगेर तपाईंले समस्या भोग्नुभएको छ?' },
      { name: 'feel_lonely', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Do you often feel lonely, or do you have few people you can openly talk to?',
        ne: 'के तपाईंलाई प्रायः एक्लो महसुस हुन्छ, वा मन खोलेर कुरा गर्ने मान्छे कम छ ?' },
      { name: 'activity_difficulty', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Do you have difficulty participating in activities you enjoy?',
        ne: 'के तपाईंलाई आफूलाई मनपर्ने क्रियाकलापहरूमा भाग लिन कठिनाइ छ?' },
    ],
  },
  {
    en: 'Caregiver support', ne: 'हेरचाहकर्ताको सहयोग / हेरचाहकर्तालाई एकान्तमा सोध्नुहोस्', slug: 'caregiver_support',
    rows: [
      { name: 'caregiver_helped', tile: T.s1, required: true,
        en: 'When you take care of a sick or elderly person in your household, do you receive adequate support from your family or neighbors?',
        ne: 'तपाईं आफ्नो घरको बिरामी वा वृद्ध मान्छेको हेरचाह गर्दा तपाईंलाई घरपरिवार वा छिमेकीबाट पर्याप्त सहयोग मिल्छ?',
        list: { list: 'support_level', choices: [
          { name: 'enough_support', en: 'Yes, I receive sufficient support', ne: 'हो, पर्याप्त सहयोग मिल्छ' },
          { name: 'sometimes_support', en: 'I receive support only sometimes', ne: 'कहिलेकाहीँ मात्र मिल्छ' },
          { name: 'alone_mostly', en: 'No, I have to do it alone most of the time', ne: 'होइन, धेरैजसो एक्लै गर्नुपर्छ' },
        ] } },
      { name: 'caregiver_confidence', tile: T.s1, required: true,
        en: 'Do you feel confident that you can take good care of your elderly or sick family member?',
        ne: 'तपाईंलाई आफ्नो वृद्ध वा बिरामी मान्छेको राम्रोसँग हेरचाह गर्न सकिन्छ भन्ने विश्वास छ?',
        list: { list: 'confidence_level', choices: [
          { name: 'knows_what_to_do', en: 'Yes, I know what to do', ne: 'छ, मलाई थाहा छ के गर्ने' },
          { name: 'some_confusion', en: 'I am confused about some things', ne: 'केही कुरामा अलमल हुन्छ' },
          { name: 'doesnt_know', en: "No, I don't know much about it", ne: 'छैन, धेरै कुरा थाहा छैन' },
        ] } },
      { name: 'caregiver_health', tile: T.s1, required: true,
        en: 'Has caregiving affected your own health? For example: back pain, fatigue, or trouble sleeping?',
        ne: 'हेरचाह गर्दागर्दै तपाईंको आफ्नो स्वास्थ्यमा असर परेको छ? जस्तै; ढाड दुख्ने, थकान लाग्ने, निद्रा नलाग्ने?',
        list: { list: 'health_impact', choices: [
          { name: 'no_impact', en: 'No', ne: 'छैन' },
          { name: 'sometimes_impact', en: 'Sometimes', ne: 'कहिलेकाहीँ हुन्छ' },
          { name: 'mostly_impact', en: 'Most of the time', ne: 'धेरैजसो हुन्छ' },
        ] } },
      { name: 'caregiver_finance', tile: T.s1, required: true,
        en: 'Has caregiving affected your own work or income? Has it been difficult to afford the cost of medicine, treatment, or care?',
        ne: 'हेरचाहको कारणले तपाईंको आफ्नो काम वा कमाइमा असर परेको छ? औषधि, उपचार, वा हेरचाहको खर्च धान्न गाह्रो भएको छ?',
        list: { list: 'finance_impact', choices: [
          { name: 'no_difficulty', en: 'No difficulty', ne: 'छैन' },
          { name: 'some_difficulty', en: 'Some difficulty', ne: 'केही गाह्रो छ' },
          { name: 'much_difficulty', en: 'A lot of difficulty', ne: 'धेरै गाह्रो छ' },
        ] } },
      // R48 — "if selected except हो and छैन": shown when any answer is not the best case.
      { name: 'caregiver_counsel_note', tile: T.note,
        en: 'Discuss psychosocial counselling, self care, and respite care to reduce caregiver burden.',
        ne: 'हेरचाहकर्ताको बोझ कम गर्न मनोसामाजिक परामर्श, आफ्नो हेरचाह र केही समयका लागि वैकल्पिक हेरचाहको व्यवस्था गर्ने वारे छलफल गर्नुहोस्।',
        rel: { or: true, rules: [
          { kind: 'cmp', field: 'caregiver_helped', choice: 'alone_mostly' },
          { kind: 'cmp', field: 'caregiver_confidence', choice: 'doesnt_know' },
          { kind: 'cmp', field: 'caregiver_health', choice: 'mostly_impact' },
          { kind: 'cmp', field: 'caregiver_finance', choice: 'much_difficulty' },
        ] } },
    ],
  },
  {
    en: 'Urinary continence', ne: 'पिसाब नियन्त्रण / एकान्तमा, सहानुभूतिपूर्वक सोध्नुहोस्', slug: 'urinary_continence',
    rows: [
      { name: 'urine_control', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Do you have trouble holding your urine until you reach the toilet when you feel the urge to urinate?',
        ne: 'तपाईंलाई पिसाब लागेको बेलामा चर्पी पुग्नेबेलासम्म रोक्न नसक्ने समस्या भएको छ ?' },
      { name: 'urine_advice_note', tile: T.note,
        en: 'Reassure them that this is common and treatable. Reduce tea and coffee intake. If necessary, refer to a primary health center.',
        ne: 'ढाडस दिनुहोस् यो सामान्य र उपचारयोग्य छ भनी। चिया, कफी कम गर्नुहोस्। आवश्यक भएमा प्राथमिक स्वास्थ्य केन्द्रमा रेफर गर्नुहोस्।',
        rel: { rules: [{ kind: 'cmp', field: 'urine_control', choice: 'yes_fail' }] } },
    ],
  },
  {
    en: 'Health and lifestyle advice', ne: 'स्वास्थ्य र जीवनशैली सम्बन्धी सल्लाह /परामर्श', slug: 'health_and_lifestyle_advice',
    rows: [
      { name: 'lifestyle_advice_note', tile: T.note,
        en: '1. Regular physical activity — start slowly, increase gradually; every bit of movement matters. 2. Healthy diet — protein-rich food, green vegetables, fresh fruit; less salt and sugar. 3. Adequate fluid intake — 6–8 glasses of water daily. 4. Oral hygiene — brush twice a day. 5. Social contact and community participation. 6. Reduce heart-disease risk — take prescribed medications regularly. 7. Quit smoking and alcohol. 8. Pay attention to mental health. 9. Quality sleep — regular sleep and wake times. 10. Eye and ear health — regular check-ups.',
        ne: '१. नियमित शारीरिक गतिविधि — बिस्तारै सुरु गर्नुस्, बिस्तारै बढाउनुस्। २. स्वस्थ आहार — प्रोटिनयुक्त खाना, हरियो सागपात, ताजा फलफूल; नुन र चिनी कम। ३. पर्याप्त तरल पदार्थ — दैनिक ६–८ गिलास पानी। ४. मुखको सरसफाइ — दिनमा २ पटक दाँत माझ्नुहोस्। ५. सामाजिक सम्पर्क र सामुदायिक सहभागिता। ६. मुटु रोगको जोखिम घटाउने — निर्धारित औषधि नियमित सेवन। ७. धूम्रपान र मद्यपान छोड्ने। ८. मानसिक स्वास्थ्यमा ध्यान दिने। ९. गुणस्तरीय निद्रा — नियमित सुत्ने/उठ्ने समय। १०. आँखा र कानको स्वास्थ्यमा ध्यान दिने — नियमित जाँच।' },
    ],
  },
];

/* ───────────────────────────── helpers ───────────────────────────── */

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

async function ensureProject(fresh: boolean): Promise<void> {
  if (fresh) await fs.rm(PROJECT, { recursive: true, force: true });
  if (!(await exists(PROJECT))) await fs.cp(FIXTURE_DIR, PROJECT, { recursive: true });
}

async function openProject(page: Page): Promise<void> {
  await page.request.post(`${API}/api/project/open`, { data: { path: PROJECT } });
}

function rowByName(page: Page, name: string): Locator {
  return page.locator('.survey-row').filter({ has: page.locator(`input.name-input[value="${name}"]`) });
}

/** Page-header Save → SaveDiffModal Save → "Saved". */
async function saveForm(page: Page): Promise<void> {
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible({ timeout: 20_000 });
}

async function readForm(page: Page, formId: string) {
  const res = await page.request.get(`${API}/api/forms/${encodeURIComponent(formId)}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as {
    form: {
      surveyHeaders: { labelLocales: string[] };
      choicesHeaders: { labelLocales: string[] };
      survey: Array<{ type: string; name: string; labels: Record<string, string>; extras: Record<string, string> }>;
      choices: Array<{ list_name: string; name: string; labels: Record<string, string> }>;
    };
  };
}

/** Create an app form label-first and land in its editor (Full mode). */
async function createAppForm(page: Page, title: string, basename: string): Promise<void> {
  await openProject(page);
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: '+ App form' }).click();
  const card = page.locator('.create-form');
  await card.locator('#new-form-title').fill(title);
  await expect(card.locator('code', { hasText: new RegExp(`^${basename}$`) })).toBeVisible();
  await card.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(card).toBeHidden();
  await expect(page.getByRole('button', { name: /^Survey/ }).first()).toBeVisible({ timeout: 15_000 });
  // Sections are invisible in Simple mode (NEXT.md finding C) — author in Full.
  await page.getByRole('button', { name: 'Full', exact: true }).click();
}

/** Survey-editor mode resets to Simple on every tab switch (remount), and
 *  sections are invisible in Simple (NEXT.md finding C) — re-assert Full. */
async function ensureFullMode(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Full', exact: true }).click();
}

/** "+ Section" with EN title + NE heading + optional one-screen appearance. */
async function addSection(page: Page, s: Section): Promise<Locator> {
  await ensureFullMode(page);
  await page.getByRole('button', { name: '+ Section' }).click();
  const picker = page.locator('.qtype-modal');
  await expect(picker).toBeVisible();
  await picker.locator('input[placeholder="e.g. Danger signs"]').fill(s.en);
  await expect(picker.locator('code', { hasText: s.slug })).toBeVisible();
  const neHeading = picker
    .locator('.qtype-labels-field .qtype-locale-label')
    .filter({ has: page.getByText('label::ne', { exact: true }) })
    .locator('input');
  if (await neHeading.isVisible().catch(() => false)) await neHeading.fill(s.ne);
  if (s.oneScreen) await picker.getByText('Show all questions on one screen').locator('input').check();
  await picker.getByRole('button', { name: 'Add section', exact: true }).click();
  await expect(picker).not.toBeVisible();
  const accordion = page.locator('.survey-group-accordion', { hasText: s.slug });
  await expect(accordion).toBeVisible();
  return accordion;
}

/** Add one row inside a section via the picker (EN+NE labels at add time). */
async function addRow(page: Page, accordion: Locator, row: Row): Promise<void> {
  await accordion.getByRole('button', { name: /\+ add inside|\+ Add question/ }).first().click();
  const picker = page.locator('.qtype-modal');
  await expect(picker).toBeVisible();
  await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill(row.name);
  const labelFields = picker.locator('.qtype-labels-field .qtype-locale-label');
  await labelFields.filter({ has: page.getByText('label::en', { exact: true }) }).locator('input').fill(row.en);
  await labelFields.filter({ has: page.getByText('label::ne', { exact: true }) }).locator('input').fill(row.ne);
  await picker
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: row.tile }) })
    .first()
    .click();

  if (row.list || row.reuse) {
    // configure-list step
    await expect(picker.getByText(/needs a list of options/)).toBeVisible();
    if (row.reuse) {
      const reuse = picker
        .locator('.qtype-list-choice label', { hasText: 'Reuse' })
        .filter({ has: page.locator('code', { hasText: new RegExp(`^${row.reuse}$`) }) });
      await reuse.locator('input').check();
    } else if (row.list) {
      await picker.getByPlaceholder('options').fill(row.list.list);
      const choiceRows = picker.locator('.qtype-choice-row');
      // Item F (8eda602): one label column per ACTIVE locale — this form has
      // en+ne, so each row is name + label::en + label::ne, authored in ONE
      // pass with no Translate → Choices detour.
      await expect(choiceRows.first().locator('input')).toHaveCount(3);
      while ((await choiceRows.count()) < row.list.choices.length) {
        await picker.locator('.qtype-choices-edit').getByRole('button', { name: '+ Add choice' }).click();
      }
      for (let i = 0; i < row.list.choices.length; i += 1) {
        await choiceRows.nth(i).locator('input').nth(0).fill(row.list.choices[i]!.name);
        await choiceRows.nth(i).locator('input').nth(1).fill(row.list.choices[i]!.en);
        await choiceRows.nth(i).locator('input').nth(2).fill(row.list.choices[i]!.ne);
      }
    }
    await picker.getByRole('button', { name: 'Add question', exact: true }).click();
  }
  await expect(picker).not.toBeVisible();

  if (row.required) {
    await rowByName(page, row.name).locator('.required-label input').check();
  }
  if (row.rel) await setRelevance(page, row.name, row.rel);
}

/** Relevance via the visual builder — choice dropdowns only, zero typing. */
async function setRelevance(
  page: Page,
  name: string,
  rel: { or?: boolean; rules: Rel[] },
): Promise<void> {
  const row = rowByName(page, name);
  const toggle = row.getByRole('button', { name: /show advanced/ });
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await row
    .locator('.expr-field', { hasText: 'Show this question when' })
    .locator('button', { hasText: '✎ build' })
    .click();
  const modal = page.locator('.rule-builder-modal');
  await expect(modal).toBeVisible();
  if (rel.or) await modal.getByText('or instead (any rule may match)').locator('input').check();
  for (const r of rel.rules) {
    if (r.kind === 'cmp') {
      await modal.getByRole('button', { name: '+ comparison' }).click();
      const rule = modal.locator('.rule-row').last();
      await rule.locator('select').first().selectOption(r.field);
      const stringToggle = rule.locator('input[type="checkbox"]');
      if (!(await stringToggle.isChecked())) await stringToggle.check();
      const valueSelect = rule.locator('select.choice-value-select');
      await expect(valueSelect, `choice dropdown for ${r.field}`).toBeVisible();
      await valueSelect.selectOption(r.choice);
    } else {
      // NOT selected(field, choice) — the "any option except X" shape.
      await modal.getByRole('button', { name: '+ selected()' }).click();
      const rule = modal.locator('.rule-row').last();
      await rule.locator('label', { hasText: 'NOT' }).locator('input').check();
      await rule.locator('select').first().selectOption(r.field);
      const valueSelect = rule.locator('select.choice-value-select');
      await expect(valueSelect, `selected() choice dropdown for ${r.field}`).toBeVisible();
      await valueSelect.selectOption(r.choice);
    }
  }
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toBeHidden();
}

/* ═════════════════════════ the demo itself ═════════════════════════ */

test('geriatric IHA — build the full 52-row sheet through the no-code UI', async ({ page }) => {
  test.setTimeout(SLOW ? 3_600_000 : 1_200_000);
  await ensureProject(true);
  await openProject(page);

  /* ---- 0. Source forms the cross-form pulls read from (sheet: Form Overview
     constraint on R3 — "pulled from Hypertension and Diabetes screening"). ---- */
  console.log('[demo] building screening source forms');
  await createAppForm(page, 'Hypertension Screening', 'hypertension_screening');
  for (const [name, en, tile] of [
    ['bmi_recorded', 'Body Mass Index (BMI)', T.num],
    ['blood_pressure', 'Blood pressure (e.g. 120/80)', /^Text$/],
  ] as const) {
    await page.getByRole('button', { name: '+ Question' }).first().click();
    const picker = page.locator('.qtype-modal');
    await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill(name);
    await picker
      .locator('.qtype-labels-field .qtype-locale-label')
      .filter({ has: page.getByText('label::en', { exact: true }) })
      .locator('input')
      .fill(en);
    await picker.locator('.qtype-tile').filter({ has: page.locator('.qtype-tile-label', { hasText: tile }) }).first().click();
    await expect(picker).not.toBeVisible();
  }
  await saveForm(page);

  await createAppForm(page, 'Diabetes Screening', 'diabetes_screening');
  await page.getByRole('button', { name: '+ Question' }).first().click();
  {
    const picker = page.locator('.qtype-modal');
    await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill('blood_sugar');
    await picker
      .locator('.qtype-labels-field .qtype-locale-label')
      .filter({ has: page.getByText('label::en', { exact: true }) })
      .locator('input')
      .fill('Blood sugar (mg/dL)');
    await picker.locator('.qtype-tile').filter({ has: page.locator('.qtype-tile-label', { hasText: T.num }) }).first().click();
    await expect(picker).not.toBeVisible();
  }
  await saveForm(page);

  /* ---- 0b. The three cross-form bridges (Contact Summary → Context values).
     Forms page was just visited, so the source-form dropdown is populated
     (NEXT.md finding B — the known cold-nav gap). ---- */
  console.log('[demo] defining cross-form context values');
  await page.locator('.nav-item', { hasText: 'Contact summary' }).click();
  await page.getByRole('button', { name: /^Context values/ }).click();
  const values = page.locator('.cs-context-values');
  await expect(values).toBeVisible();
  const BRIDGES: Array<[string, string, string]> = [
    ['latest_bmi', 'hypertension_screening', 'bmi_recorded'],
    ['latest_bp', 'hypertension_screening', 'blood_pressure'],
    ['latest_sugar', 'diabetes_screening', 'blood_sugar'],
  ];
  for (const [key, form, field] of BRIDGES) {
    await values.getByRole('button', { name: '+ Add value' }).click();
    const card = values.locator('.task-card').last();
    const nameInput = card.locator('header input.name-input');
    await nameInput.fill(key);
    await nameInput.blur();
    const selects = card.locator('select');
    await expect(card.locator('select.form-picker')).toBeVisible();
    await selects.first().selectOption(form);
    await expect(selects.nth(1)).toBeVisible({ timeout: 15_000 });
    await selects.nth(1).selectOption(field);
  }
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  /* ---- 1. The IHA form: create, eligibility 60+, Nepali locale. ---- */
  console.log('[demo] creating the IHA form');
  await createAppForm(page, IHA_TITLE, IHA_BASENAME);

  // Properties: title + "age >= 60" eligibility (Form Overview R1 context).
  await page.getByRole('button', { name: 'Properties', exact: true }).click();
  await page.getByLabel('Available on people').check();
  const ctx = page.locator('.context-builder');
  await ctx.getByRole('button', { name: '+ age', exact: true }).click();
  const ageRow = ctx.locator('.rule-row').last();
  await ageRow.locator('select').first().selectOption('>=');
  await ageRow.locator('input[type="number"]').fill('60');
  await expect(ctx.locator('.preview code')).toContainText('ageInYears(contact) >= 60');
  await page.getByRole('button', { name: /^Survey/ }).first().click();

  // Nepali BEFORE authoring → every add-picker collects label::ne inline.
  const bar = page.locator('.language-chip-bar');
  await bar.getByRole('button', { name: '+ Add language' }).click();
  await page.locator('.language-chip-popover').locator('button', { hasText: 'नेपाली (Nepali)' }).click();
  await expect(bar.locator('.language-chip', { hasText: 'नेपाली' })).toBeVisible();
  await saveForm(page);

  /* ---- 2. Intro section (sheet R1–R3): consent, {patient_name} note,
     and the three cross-form values referenced from notes. ---- */
  console.log('[demo] intro section (consent + cross-form values)');
  const intro = await addSection(page, {
    en: 'Elderly integrated care', ne: 'वृद्ध व्यक्तिको एकीकृत हेरचाह फारम',
    slug: 'elderly_integrated_care', rows: [],
  });

  // R1 — consent. ("Form close if disagree" has no primitive: NEXT.md #9 → FRICTION, recorded.)
  await addRow(page, intro, {
    name: 'consent', tile: T.s1, required: true,
    en: "I'll do a general check-in on your health. It takes about 8 to 12 minutes. What you share stays confidential and is only used to support you. You can stop whenever you'd like.",
    ne: 'म तपाईंको स्वास्थ्यको सामान्य जाँच गर्नेछु। यसमा करिब ८ देखि १२ मिनेट लाग्छ। तपाईंले भन्नुभएका कुरा गोप्य रहन्छन्। मन नलागे जहिले पनि रोक्न सक्नुहुन्छ।',
    list: { list: 'consent_choice', choices: [
      { name: 'agree', en: 'Agree', ne: 'सहमत छु' },
      { name: 'disagree', en: 'Disagree', ne: 'सहमत छैन' },
    ] },
  });

  // R2 — "{Person_Name}'s Health Details" via insert-contact-field.
  await addRow(page, intro, {
    name: 'health_details', tile: T.note,
    en: 'Health details for ', ne: 'को स्वास्थ्य विवरण',
  });
  {
    const noteRow = rowByName(page, 'health_details');
    const enLabel = noteRow.locator('.label-row').filter({ has: page.getByText('label::en', { exact: true }) });
    await enLabel.locator('input').click();
    await enLabel.getByRole('button', { name: '+ insert' }).click();
    await page.locator('.label-insert-ref-menu').getByRole('menuitem', { name: 'patient_name' }).click();
    await expect(enLabel.locator('input')).toHaveValue(/\$\{patient_name\}/);
  }

  // R3 — three calculates (cross-form) + a note per value referencing it.
  for (const [calcName, key, noteName, noteEn, noteNe] of [
    ['bmi', 'latest_bmi', 'bmi_note', 'Body Mass Index (BMI): ', 'बडी मास इन्डेक्स (BMI): '],
    ['bp', 'latest_bp', 'bp_note', 'Your blood pressure is: ', 'तपाईंको रक्तचाप: '],
    ['sugar', 'latest_sugar', 'sugar_note', 'The amount of sugar in your blood is: ', 'तपाईंको रगतमा चिनीको मात्रा: '],
  ] as const) {
    await addRow(page, intro, { name: calcName, tile: /^Calculate$/, en: '', ne: '' });
    const calcRow = rowByName(page, calcName);
    const advToggle = calcRow.getByRole('button', { name: /show advanced/ });
    if (await advToggle.isVisible().catch(() => false)) await advToggle.click();
    const calcField = calcRow
      .locator('.expr-field')
      .filter({ has: page.locator('code.raw-col-tag', { hasText: 'calculation' }) });
    await calcField.locator('button', { hasText: 'build' }).click();
    const calcModal = page.locator('.rule-builder-modal[aria-label="Calculation builder"]');
    await expect(calcModal).toBeVisible();
    await calcModal.getByRole('tab', { name: 'Single value' }).click();
    await calcModal.getByRole('radio', { name: /From another form/ }).click();
    await calcModal.getByLabel('Cross-form context value').selectOption(key);
    await calcModal.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(calcField.locator('input').first()).toHaveValue(/contact-summary/);

    await addRow(page, intro, { name: noteName, tile: T.note, en: noteEn, ne: noteNe });
    const noteRow = rowByName(page, noteName);
    const enLabel = noteRow.locator('.label-row').filter({ has: page.getByText('label::en', { exact: true }) });
    await enLabel.locator('input').click();
    await enLabel.getByRole('button', { name: '+ insert' }).click();
    const menu = page.locator('.label-insert-ref-menu');
    const item = menu.getByRole('menuitem', { name: `\${${calcName}}` });
    if (!(await item.isVisible().catch(() => false))) {
      // NEXT.md finding E — a fresh calculate can land below the note and so
      // not be offered as an "earlier field": one manual move-up fixes it.
      await page.keyboard.press('Escape');
      await rowByName(page, calcName).getByRole('button', { name: 'move up' }).click();
      await enLabel.locator('input').click();
      await enLabel.getByRole('button', { name: '+ insert' }).click();
    }
    await menu.getByRole('menuitem', { name: `\${${calcName}}` }).click();
    await expect(enLabel.locator('input')).toHaveValue(new RegExp(`\\$\\{${calcName}\\}`));
  }
  await saveForm(page);

  /* ---- 3. The ten assessment sections, straight from the sheet. ---- */
  for (const section of SECTIONS) {
    console.log(`[demo] section: ${section.en}`);
    const accordion = await addSection(page, section);
    for (const row of section.rows) await addRow(page, accordion, row);
    await saveForm(page);
  }

  /* ---- 4. R11 — the chair-rise illustration on the mobility note. ---- */
  console.log('[demo] chair-rise display image');
  {
    await ensureFullMode(page);
    const noteRow = rowByName(page, 'chair_rise_note');
    await noteRow.scrollIntoViewIfNeeded();
    const advToggle = noteRow.getByRole('button', { name: /show advanced/ });
    if (await advToggle.isVisible().catch(() => false)) await advToggle.click();
    const mediaField = noteRow
      .locator('.expr-field')
      .filter({ has: page.locator('code.raw-col-tag', { hasText: 'media::image' }) })
      .first();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );
    const pngPath = path.join(os.tmpdir(), 'chair_rise_illustration.png');
    await fs.writeFile(pngPath, png);
    await mediaField.locator('input[type="file"]').setInputFiles(pngPath);
    await expect(mediaField.locator('input').first()).toHaveValue('chair_rise_illustration.png', { timeout: 15_000 });
    await saveForm(page);
  }

  /* ---- 5. Nepali choice labels: NOTHING TO DO. Item F (8eda602) collects
     them inline in the picker — the Translate → Choices detour this step
     used to need (finding F, ~6 interactions × 16 lists) is gone. ---- */
  const allChoices: Choice[] = [
    { name: 'agree', en: 'Agree', ne: 'सहमत छु' },
    { name: 'disagree', en: 'Disagree', ne: 'सहमत छैन' },
    ...SECTIONS.flatMap((s) => s.rows.flatMap((r) => r.list?.choices ?? [])),
  ];

  /* ---- 6. Verify from DISK (server re-parse), not UI state. ---- */
  const body = await readForm(page, IHA_FORM_ID);
  const names = new Set(body.form.survey.map((r) => r.name));
  const expected = [
    'consent', 'health_details', 'bmi', 'bp', 'sugar', 'bmi_note', 'bp_note', 'sugar_note',
    ...SECTIONS.flatMap((s) => s.rows.map((r) => r.name)),
  ];
  for (const n of expected) expect(names.has(n), `row on disk: ${n}`).toBe(true);
  for (const s of SECTIONS) {
    expect(
      body.form.survey.some((r) => r.name === s.slug && r.type.trim().toLowerCase() === 'begin group'),
      `section on disk: ${s.slug}`,
    ).toBe(true);
  }
  expect(body.form.surveyHeaders.labelLocales).toContain('ne');
  expect(body.form.choicesHeaders.labelLocales).toContain('ne');
  // Spot-check the hard shapes.
  const eyeRefer = body.form.survey.find((r) => r.name === 'eye_refer_note')!;
  expect(eyeRefer.extras['relevant']).toContain('selected(');
  expect(eyeRefer.extras['relevant']).toContain('none_of_above');
  expect(eyeRefer.extras['relevant']).toMatch(/\bor\b/);
  const entRefer = body.form.survey.find((r) => r.name === 'ent_refer_note')!;
  expect(entRefer.extras['relevant']).toContain("${right_ear} = 'four_words_fail'");
  expect(entRefer.extras['relevant']).toContain("${left_ear} = 'four_words_fail'");
  const bmiCalc = body.form.survey.find((r) => r.name === 'bmi')!;
  expect(bmiCalc.extras['calculation']).toContain("instance('contact-summary')/context/");
  const neChoices = body.form.choices.filter((c) => (c.labels['ne'] ?? '') !== '');
  expect(neChoices.length, 'NE choice labels written').toBeGreaterThanOrEqual(allChoices.length);
  console.log(
    `[demo] DONE — ${body.form.survey.length} survey rows, ${body.form.choices.length} choices, locales: en+ne`,
  );
});

/* ══════ reopen + re-save with no edits: the round-trip reality check ══════ */

test('geriatric IHA — reopen: everything survives a fresh parse from disk', async ({ page }) => {
  await openProject(page);
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: `${IHA_BASENAME}.xlsx` }).click();
  await expect(page.getByRole('button', { name: /^Survey/ }).first()).toBeVisible({ timeout: 15_000 });
  // Freshly opened → not dirty. "Saved" state = the parser accepted its own output.
  await expect(
    page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Full', exact: true }).click();
  for (const s of SECTIONS) {
    await expect(page.locator('.survey-group-accordion', { hasText: s.slug })).toBeVisible();
  }
  const body = await readForm(page, IHA_FORM_ID);
  expect(body.form.survey.length).toBeGreaterThanOrEqual(60); // 52 sheet rows → ~66 XLSForm rows incl. groups
});
