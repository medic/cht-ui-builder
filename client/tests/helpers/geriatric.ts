/**
 * Shared elder-care demo content + builder-driver helpers.
 *
 * ⚠️  SYNTHETIC DEMO CONTENT — NOT CLINICAL GUIDANCE.
 * The questions, thresholds and advice below are invented for the purpose of
 * exercising the builder. They are deliberately shaped like a real community
 * health assessment (sections, pass/fail screens, referral flags, a follow-up
 * form) because that is what makes them a useful test of the tool — but they
 * are not a validated instrument and must never be deployed to real users or
 * treated as medical advice. The Nepali strings are illustrative, chosen to
 * exercise a second locale and a non-Latin script; they have not been reviewed
 * by a translator.
 *
 * This is the single source of truth for the demo assessment content and the
 * Playwright drivers for the no-code builder. Identifiers (field names, list
 * names, choice values, refer_* flags) are stable — specs assert on them.
 *
 * Everything here observes the QA safety rule: pure UI driving, no production
 * code, no Contact Summary → Helpers → "edit body".
 */
import { expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';

export const API = 'http://127.0.0.1:5174';

/* ───────────────────────────── content ───────────────────────────── */

export type Choice = { name: string; en: string; ne: string };
export type NewList = { list: string; choices: Choice[] };
export type Rel =
  | { kind: 'cmp'; field: string; choice: string }
  | { kind: 'selectedNot'; field: string; choice: string };
export type Row = {
  name: string;
  en: string;
  ne: string;
  tile: RegExp;
  required?: boolean;
  list?: NewList;
  reuse?: string;
  rel?: { or?: boolean; rules: Rel[] };
};
export type Section = { en: string; ne: string; slug: string; oneScreen?: boolean; rows: Row[] };

export const T = {
  note: /^Note$/,
  s1: /^Single choice$|^Select one$/,
  sN: /^Multiple choice$|^Select many$/,
  num: /^Number$|^Integer$/,
  calc: /^Calculate$/,
  text: /^Text$/,
} as const;

export const PASS_FAIL: NewList = {
  list: 'pass_fail',
  choices: [
    { name: 'yes_fail', en: 'Yes (Fail)', ne: 'छ (फेल)' },
    { name: 'no_pass', en: 'No (Pass)', ne: 'छैन (पास)' },
  ],
};

/** The 10 demo assessment sections. `oneScreen` may be forced by callers that
 *  need compact Enketo pagination for runtime driving. */
export function ihaSections(oneScreen: boolean): Section[] {
  return SECTIONS_BASE.map((s) => ({ ...s, oneScreen }));
}

const SECTIONS_BASE: Section[] = [
  {
    en: 'Memory and orientation', ne: 'सम्झना र अभिमुखीकरण', slug: 'cognitive_decline',
    rows: [
      { name: 'memory_trouble', tile: T.s1, required: true, list: PASS_FAIL,
        en: 'Do they find it harder than before to remember recent events?',
        ne: 'के उहाँलाई पहिलेभन्दा हालका कुरा सम्झन गाह्रो हुन्छ?' },
      { name: 'memory_test_note', tile: T.note,
        en: 'Do a short memory check.', ne: 'छोटो सम्झना जाँच गर्नुहोस्।',
        rel: { rules: [{ kind: 'cmp', field: 'memory_trouble', choice: 'yes_fail' }] } },
      { name: 'memorize_words_note', tile: T.note,
        en: 'Say three simple words and ask them to remember: lamp, river, basket.',
        ne: 'तीन सजिला शब्द भन्नुहोस् र सम्झन लगाउनुहोस्: बत्ती, खोला, टोकरी।',
        rel: { rules: [{ kind: 'cmp', field: 'memory_trouble', choice: 'yes_fail' }] } },
      { name: 'word_recall', tile: T.s1, required: true,
        en: 'Ask them to repeat the three words.', ne: 'ती तीन शब्द दोहोर्‍याउन लगाउनुहोस्।',
        list: { list: 'word_recall_result', choices: [
          { name: 'recall_pass', en: 'Repeated all three (Pass)', ne: 'तीनै दोहोर्‍याए (पास)' },
          { name: 'recall_fail', en: 'Could not repeat all three (Fail)', ne: 'तीनै दोहोर्‍याउन सकेनन् (फेल)' },
        ] },
        rel: { rules: [{ kind: 'cmp', field: 'memory_trouble', choice: 'yes_fail' }] } },
      { name: 'date_place', tile: T.s1, required: true,
        en: 'Ask what day it is and where they are right now.', ne: 'आज कुन बार हो र अहिले कहाँ हुनुहुन्छ सोध्नुहोस्।',
        list: { list: 'orientation_result', choices: [
          { name: 'orient_pass', en: 'Both answers correct (Pass)', ne: 'दुवै उत्तर सही (पास)' },
          { name: 'orient_fail', en: 'One or both incorrect (Fail)', ne: 'एक वा दुवै गलत (फेल)' },
        ] },
        rel: { rules: [{ kind: 'cmp', field: 'memory_trouble', choice: 'yes_fail' }] } },
      { name: 'cognitive_refer_note', tile: T.note,
        en: 'Suggest a check-up at the nearest health post.',
        ne: 'नजिकको स्वास्थ्य चौकीमा जाँच गराउन सुझाव दिनुहोस्।',
        rel: { or: true, rules: [
          { kind: 'cmp', field: 'word_recall', choice: 'recall_fail' },
          { kind: 'cmp', field: 'date_place', choice: 'orient_fail' },
        ] } },
    ],
  },
  {
    en: 'Moving around', ne: 'हिँडडुल र चलायमान', slug: 'limited_mobility',
    rows: [
      { name: 'chair_rise_note', tile: T.note,
        en: 'Do the sit-to-stand check.', ne: 'उठ्ने-बस्ने जाँच गर्नुहोस्।' },
      { name: 'safe_to_test', tile: T.s1, required: true,
        en: 'Do they feel steady enough to stand up and sit down five times without using their hands?',
        ne: 'हात नटेकी पाँच पटक उठ्न-बस्न सकिन्छ जस्तो लाग्छ?',
        list: { list: 'chair_test_choice', choices: [
          { name: 'will_test', en: 'Yes (Do the check)', ne: 'लाग्छ (जाँच गर्ने)' },
          { name: 'wont_test', en: 'No (Skip the check)', ne: 'लाग्दैन (जाँच नगर्ने)' },
        ] } },
      { name: 'timer_note', tile: T.note,
        en: 'Have a watch or phone ready to time the activity.',
        ne: 'समय नाप्न घडी वा फोन तयार राख्नुहोस्।' },
      { name: 'sit_stand_time', tile: T.s1, required: true,
        en: 'How long did the five repetitions take?', ne: 'पाँच पटक पूरा गर्न कति समय लाग्यो?',
        list: { list: 'sit_stand_result', choices: [
          { name: 'fourteen_or_less', en: '14 seconds or less (Pass)', ne: '१४ सेकेन्ड वा कम (पास)' },
          { name: 'over_fourteen', en: 'More than 14 seconds (Fail)', ne: '१४ सेकेन्डभन्दा बढी (फेल)' },
        ] },
        rel: { rules: [{ kind: 'cmp', field: 'safe_to_test', choice: 'will_test' }] } },
      { name: 'mobility_refer_note', tile: T.note,
        en: 'Suggest a check-up at the nearest health post.',
        ne: 'नजिकको स्वास्थ्य चौकीमा जाँच गराउन सुझाव दिनुहोस्।',
        rel: { rules: [{ kind: 'cmp', field: 'sit_stand_time', choice: 'over_fourteen' }] } },
    ],
  },
  {
    en: 'Eating and weight', ne: 'खानपान र तौल', slug: 'nutrition_check',
    rows: [
      { name: 'weight_loss', tile: T.s1, required: true,
        en: 'Has their weight dropped noticeably in the last three months without trying?',
        ne: 'पछिल्लो तीन महिनामा आफैँ तौल उल्लेख्य घटेको छ?',
        list: { list: 'weight_loss_choice', choices: [
          { name: 'wl_yes_fail', en: 'Yes (Fail)', ne: 'छ (फेल)' },
          { name: 'wl_no_pass', en: 'No (Pass)', ne: 'छैन (पास)' },
          { name: 'wl_dont_know', en: 'Not sure', ne: 'थाहा छैन' },
        ] } },
      { name: 'clothes_loose', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Have their clothes or belt become looser?', ne: 'लुगा वा बेल्ट खुकुलो भएको छ?' },
      { name: 'appetite_loss', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Has their appetite dropped?', ne: 'खाना खाने रुचि घटेको छ?',
        rel: { rules: [{ kind: 'cmp', field: 'weight_loss', choice: 'wl_dont_know' }] } },
      { name: 'weight_kg', tile: T.num,
        en: 'Record their weight (kg).', ne: 'तौल लेख्नुहोस् (के.जी.)।' },
      { name: 'nutrition_refer_note', tile: T.note,
        en: 'Suggest a check-up at the nearest health post.',
        ne: 'नजिकको स्वास्थ्य चौकीमा जाँच गराउन सुझाव दिनुहोस्।',
        rel: { or: true, rules: [
          { kind: 'cmp', field: 'weight_loss', choice: 'wl_yes_fail' },
          { kind: 'cmp', field: 'clothes_loose', choice: 'yes_fail' },
          { kind: 'cmp', field: 'appetite_loss', choice: 'yes_fail' },
        ] } },
    ],
  },
  {
    en: 'Eyesight', ne: 'आँखा जाँच', slug: 'vision_check',
    rows: [
      { name: 'eye_problem', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Do they have any trouble with their eyes?', ne: 'आँखा सम्बन्धी कुनै समस्या छ?' },
      { name: 'diabetes_htn_meds', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Do they have a long-term condition or take regular medicine?',
        ne: 'दीर्घ रोग छ वा नियमित औषधि खानुहुन्छ?' },
      { name: 'external_eye', tile: T.sN, required: true,
        en: 'Look at the outside of both eyes and record what you see.',
        ne: 'दुवै आँखाको बाहिरी भाग हेरेर लेख्नुहोस्।',
        list: { list: 'external_eye_findings', choices: [
          { name: 'pus', en: 'Discharge', ne: 'पिप' },
          { name: 'watery_eyes', en: 'Watering', ne: 'आँसु' },
          { name: 'eyelid_inward', en: 'Eyelid turned inward', ne: 'परेला भित्र मोडिएको' },
          { name: 'red_white_part', en: 'Redness in the white of the eye', ne: 'सेतो भागमा रातोपन' },
          { name: 'cloudy_cornea', en: 'Cloudy front of the eye', ne: 'आँखाको अगाडि धमिलो' },
          { name: 'none_of_above', en: 'Nothing unusual', ne: 'केही असामान्य छैन' },
        ] } },
      { name: 'who_chart_note', tile: T.note,
        en: 'Set the distance chart three metres away and test one eye at a time, covering the other.',
        ne: 'दूरी चार्ट तीन मिटर टाढा राखी अर्को आँखा छोपेर एक-एक गरी जाँच्नुहोस्।',
        rel: { rules: [{ kind: 'cmp', field: 'eye_problem', choice: 'yes_fail' }] } },
      { name: 'right_eye', tile: T.s1, required: true,
        en: 'Right eye (distance chart)', ne: 'दाहिने आँखा (दूरी चार्ट)',
        list: { list: 'vision_612', choices: [
          { name: 'see_612', en: 'Reads the target line (Pass)', ne: 'तोकिएको लाइन पढ्यो (पास)' },
          { name: 'not_see_612', en: 'Cannot read the target line (Fail)', ne: 'तोकिएको लाइन पढ्न सकेन (फेल)' },
        ] },
        rel: { rules: [{ kind: 'cmp', field: 'eye_problem', choice: 'yes_fail' }] } },
      { name: 'left_eye', tile: T.s1, required: true, reuse: 'vision_612',
        en: 'Left eye (distance chart)', ne: 'देब्रे आँखा (दूरी चार्ट)',
        rel: { rules: [{ kind: 'cmp', field: 'eye_problem', choice: 'yes_fail' }] } },
      { name: 'near_vision', tile: T.s1, required: true,
        en: 'Both eyes together, near card at 40 cm', ne: 'दुवै आँखा सँगै, नजिकको कार्ड ४० से.मि.',
        list: { list: 'vision_n6', choices: [
          { name: 'see_n6', en: 'Reads the near card (Pass)', ne: 'नजिकको कार्ड पढ्यो (पास)' },
          { name: 'not_see_n6', en: 'Cannot read the near card (Fail)', ne: 'नजिकको कार्ड पढ्न सकेन (फेल)' },
        ] },
        rel: { rules: [{ kind: 'cmp', field: 'eye_problem', choice: 'yes_fail' }] } },
      { name: 'glasses_retest_note', tile: T.note,
        en: 'Try again with their glasses on.', ne: 'चस्मा लगाएर फेरि जाँच्नुहोस्।',
        rel: { rules: [{ kind: 'cmp', field: 'near_vision', choice: 'not_see_n6' }] } },
      { name: 'near_vision_glasses', tile: T.s1, required: true, reuse: 'vision_n6',
        en: 'Both eyes with glasses, near card at 40 cm', ne: 'चस्मासहित दुवै आँखा, नजिकको कार्ड ४० से.मि.',
        rel: { rules: [{ kind: 'cmp', field: 'near_vision', choice: 'not_see_n6' }] } },
      { name: 'eye_refer_note', tile: T.note,
        en: 'Suggest an eye check-up at the nearest eye clinic.',
        ne: 'नजिकको आँखा क्लिनिकमा जाँच गराउन सुझाव दिनुहोस्।',
        rel: { or: true, rules: [
          { kind: 'selectedNot', field: 'external_eye', choice: 'none_of_above' },
          { kind: 'cmp', field: 'right_eye', choice: 'not_see_612' },
          { kind: 'cmp', field: 'left_eye', choice: 'not_see_612' },
        ] } },
    ],
  },
  {
    en: 'Hearing', ne: 'कान जाँच', slug: 'hearing_check',
    rows: [
      { name: 'hearing_trouble', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Do they have trouble hearing everyday conversation?',
        ne: 'दैनिक कुराकानी सुन्न गाह्रो हुन्छ?' },
      { name: 'whisper_method_note', tile: T.note,
        en: 'Stand behind them, cover the ear not being tested, and whisper four simple words: rice, fish, cycle, garden. Ask them to repeat each one, then test the other ear.',
        ne: 'पछाडि उभिएर नजाँच्ने कान छोपी चार सजिला शब्द कानेखुसीमा भन्नुहोस्: चामल, माछा, साइकल, बगैँचा। प्रत्येक दोहोर्‍याउन लगाउनुहोस्, त्यसपछि अर्को कान जाँच्नुहोस्।',
        rel: { rules: [{ kind: 'cmp', field: 'hearing_trouble', choice: 'yes_fail' }] } },
      { name: 'right_ear', tile: T.s1, required: true,
        en: 'Right ear result', ne: 'दाहिने कानको नतिजा',
        list: { list: 'whisper_result', choices: [
          { name: 'four_words_pass', en: 'Repeated all four (Pass)', ne: 'चारै दोहोर्‍याए (पास)' },
          { name: 'four_words_fail', en: 'Could not repeat all four (Fail)', ne: 'चारै दोहोर्‍याउन सकेनन् (फेल)' },
        ] } },
      { name: 'left_ear', tile: T.s1, required: true, reuse: 'whisper_result',
        en: 'Left ear result', ne: 'देब्रे कानको नतिजा' },
      { name: 'ent_refer_note', tile: T.note,
        en: 'Suggest a hearing check-up at the nearest health post.',
        ne: 'नजिकको स्वास्थ्य चौकीमा कान जाँच गराउन सुझाव दिनुहोस्।',
        rel: { or: true, rules: [
          { kind: 'cmp', field: 'right_ear', choice: 'four_words_fail' },
          { kind: 'cmp', field: 'left_ear', choice: 'four_words_fail' },
        ] } },
    ],
  },
  {
    en: 'Mood and wellbeing', ne: 'मन र भावना', slug: 'psychological_check',
    rows: [
      { name: 'feeling_sad', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Have they felt low or down most days over the past two weeks?',
        ne: 'पछिल्लो दुई हप्ता धेरैजसो दिन उदास महसुस गर्नुभएको छ?' },
      { name: 'lost_interest', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Have they lost interest in things they usually enjoy?',
        ne: 'मनपर्ने कुरामा रुचि घटेको छ?' },
      { name: 'self_harm_thoughts', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Have they had thoughts of harming themselves?',
        ne: 'आफूलाई हानि गर्ने विचार आएको छ?' },
      { name: 'mental_refer_note', tile: T.note,
        en: 'Talk with them and their family, and suggest support at the nearest health post.',
        ne: 'उहाँ र परिवारसँग कुरा गरी नजिकको स्वास्थ्य चौकीमा सहयोग लिन सुझाव दिनुहोस्।',
        rel: { or: true, rules: [
          { kind: 'cmp', field: 'feeling_sad', choice: 'yes_fail' },
          { kind: 'cmp', field: 'lost_interest', choice: 'yes_fail' },
          { kind: 'cmp', field: 'self_harm_thoughts', choice: 'yes_fail' },
        ] } },
    ],
  },
  {
    en: 'Home and support', ne: 'घर र सहयोग', slug: 'social_care_and_support',
    rows: [
      { name: 'family_care_satisfied', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Are they happy with the care and space they have at home?',
        ne: 'घरमा पाएको हेरचाह र ठाउँबाट सन्तुष्ट हुनुहुन्छ?' },
      { name: 'money_problems', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Have costs made food, housing, or care hard to manage?',
        ne: 'खर्चका कारण खाना, बसोबास वा उपचार धान्न गाह्रो भएको छ?' },
      { name: 'feel_lonely', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Do they often feel alone, or have few people to talk to?',
        ne: 'प्रायः एक्लो महसुस हुन्छ, वा कुरा गर्ने मान्छे कम छन्?' },
      { name: 'activity_difficulty', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Is it hard for them to join activities they enjoy?',
        ne: 'मनपर्ने काममा सहभागी हुन गाह्रो छ?' },
    ],
  },
  {
    en: 'Carer wellbeing', ne: 'हेरचाहकर्ताको अवस्था', slug: 'caregiver_support',
    rows: [
      { name: 'caregiver_helped', tile: T.s1, required: true,
        en: 'As a carer, do you get enough help from family or neighbours?',
        ne: 'हेरचाह गर्दा परिवार वा छिमेकीबाट पर्याप्त सहयोग मिल्छ?',
        list: { list: 'support_level', choices: [
          { name: 'enough_support', en: 'Yes, enough help', ne: 'पर्याप्त सहयोग मिल्छ' },
          { name: 'sometimes_support', en: 'Only sometimes', ne: 'कहिलेकाहीँ मात्र' },
          { name: 'alone_mostly', en: 'Mostly on my own', ne: 'धेरैजसो एक्लै' },
        ] } },
      { name: 'caregiver_confidence', tile: T.s1, required: true,
        en: 'Do you feel you know what to do day to day?',
        ne: 'दैनिक के गर्ने भन्ने थाहा छ भन्ने लाग्छ?',
        list: { list: 'confidence_level', choices: [
          { name: 'knows_what_to_do', en: 'Yes, I know what to do', ne: 'थाहा छ' },
          { name: 'some_confusion', en: 'Unsure about some things', ne: 'केही कुरामा अलमल' },
          { name: 'doesnt_know', en: 'Often unsure', ne: 'प्रायः थाहा हुँदैन' },
        ] } },
      { name: 'caregiver_health', tile: T.s1, required: true,
        en: 'Has caring affected your own health?', ne: 'हेरचाहले आफ्नो स्वास्थ्यमा असर परेको छ?',
        list: { list: 'health_impact', choices: [
          { name: 'no_impact', en: 'No', ne: 'छैन' },
          { name: 'sometimes_impact', en: 'Sometimes', ne: 'कहिलेकाहीँ' },
          { name: 'mostly_impact', en: 'Most of the time', ne: 'धेरैजसो' },
        ] } },
      { name: 'caregiver_finance', tile: T.s1, required: true,
        en: 'Has caring affected your work or income?', ne: 'हेरचाहले काम वा आम्दानीमा असर परेको छ?',
        list: { list: 'finance_impact', choices: [
          { name: 'no_difficulty', en: 'No difficulty', ne: 'छैन' },
          { name: 'some_difficulty', en: 'Some difficulty', ne: 'केही गाह्रो' },
          { name: 'much_difficulty', en: 'A lot of difficulty', ne: 'धेरै गाह्रो' },
        ] } },
      { name: 'caregiver_counsel_note', tile: T.note,
        en: 'Talk through practical support and arranging a short break from caring.',
        ne: 'व्यावहारिक सहयोग र केही समय विश्रामको व्यवस्थाबारे कुरा गर्नुहोस्।',
        rel: { or: true, rules: [
          { kind: 'cmp', field: 'caregiver_helped', choice: 'alone_mostly' },
          { kind: 'cmp', field: 'caregiver_confidence', choice: 'doesnt_know' },
          { kind: 'cmp', field: 'caregiver_health', choice: 'mostly_impact' },
          { kind: 'cmp', field: 'caregiver_finance', choice: 'much_difficulty' },
        ] } },
    ],
  },
  {
    en: 'Bladder comfort', ne: 'पिसाब सम्बन्धी', slug: 'urinary_continence',
    rows: [
      { name: 'urine_control', tile: T.s1, required: true, reuse: 'pass_fail',
        en: 'Do they have trouble reaching the toilet in time?',
        ne: 'समयमा शौचालय पुग्न गाह्रो हुन्छ?' },
      { name: 'urine_advice_note', tile: T.note,
        en: 'Reassure them this is common and can be helped. Suggest a check-up if it continues.',
        ne: 'यो सामान्य हो र सुधार्न सकिन्छ भनी ढाडस दिनुहोस्। जारी रहे जाँच गराउन सुझाव दिनुहोस्।',
        rel: { rules: [{ kind: 'cmp', field: 'urine_control', choice: 'yes_fail' }] } },
    ],
  },
  {
    en: 'Wellness advice', ne: 'स्वस्थ जीवनशैली सल्लाह', slug: 'health_and_lifestyle_advice',
    rows: [
      { name: 'lifestyle_advice_note', tile: T.note,
        en: 'Talk through: daily movement, balanced meals, drinking enough water, dental care, staying social, good sleep, and regular eye and ear checks.',
        ne: 'छलफल गर्नुहोस्: दैनिक हिँडडुल, सन्तुलित खाना, पर्याप्त पानी, दाँतको सरसफाइ, सामाजिक सम्पर्क, राम्रो निद्रा, र नियमित आँखा-कान जाँच।' },
    ],
  },
];

/** The 7 referral-flag domain conditions. These are the contract the follow-up
 *  form and the task both read, so the names are stable. */
export const REFER_FLAGS: Array<{ name: string; rel: { or?: boolean; rules: Rel[] } }> = [
  { name: 'refer_cognitive', rel: { or: true, rules: [
    { kind: 'cmp', field: 'word_recall', choice: 'recall_fail' },
    { kind: 'cmp', field: 'date_place', choice: 'orient_fail' },
  ] } },
  { name: 'refer_mobility', rel: { rules: [
    { kind: 'cmp', field: 'sit_stand_time', choice: 'over_fourteen' },
  ] } },
  { name: 'refer_nutrition', rel: { or: true, rules: [
    { kind: 'cmp', field: 'weight_loss', choice: 'wl_yes_fail' },
    { kind: 'cmp', field: 'clothes_loose', choice: 'yes_fail' },
    { kind: 'cmp', field: 'appetite_loss', choice: 'yes_fail' },
  ] } },
  { name: 'refer_vision', rel: { or: true, rules: [
    { kind: 'selectedNot', field: 'external_eye', choice: 'none_of_above' },
    { kind: 'cmp', field: 'right_eye', choice: 'not_see_612' },
    { kind: 'cmp', field: 'left_eye', choice: 'not_see_612' },
    { kind: 'cmp', field: 'near_vision', choice: 'not_see_n6' },
    { kind: 'cmp', field: 'near_vision_glasses', choice: 'not_see_n6' },
  ] } },
  { name: 'refer_hearing', rel: { or: true, rules: [
    { kind: 'cmp', field: 'right_ear', choice: 'four_words_fail' },
    { kind: 'cmp', field: 'left_ear', choice: 'four_words_fail' },
  ] } },
  { name: 'refer_psych', rel: { or: true, rules: [
    { kind: 'cmp', field: 'feeling_sad', choice: 'yes_fail' },
    { kind: 'cmp', field: 'lost_interest', choice: 'yes_fail' },
    { kind: 'cmp', field: 'self_harm_thoughts', choice: 'yes_fail' },
  ] } },
  { name: 'refer_continence', rel: { rules: [
    { kind: 'cmp', field: 'urine_control', choice: 'yes_fail' },
  ] } },
];

const YES_NO: NewList = { list: 'yes_no', choices: [
  { name: 'yes', en: 'Yes', ne: 'हो' },
  { name: 'no', en: 'No', ne: 'होइन' },
] };
const STATUS = (list: string): NewList => ({ list, choices: [
  { name: `${list}_improving`, en: 'Better', ne: 'सुधार' },
  { name: `${list}_same`, en: 'About the same', ne: 'उस्तै' },
  { name: `${list}_worse`, en: 'Worse', ne: 'बिग्रँदै' },
] });
const visitedYes: Rel = { kind: 'cmp', field: 'visited_facility', choice: 'yes' };
const flagTrue = (f: string): Rel => ({ kind: 'cmp', field: f, choice: 'true' });

/** The follow-up form's rows, each gated on the matching refer_* flag that the
 *  task delivers through modifyContent. Single source of truth, reused by every
 *  demo build spec. */
export const FOLLOWUP_ROWS: Row[] = [
  { name: 'visited_facility', tile: T.s1, required: true, list: YES_NO,
    en: 'Did they go for the check-up that was suggested?',
    ne: 'सुझाव गरिएको जाँचका लागि जानुभयो?' },
  { name: 'formal_exam', tile: T.s1, required: true, reuse: 'yes_no',
    en: 'Were they examined at the facility?',
    ne: 'संस्थामा जाँच भयो?', rel: { rules: [visitedYes] } },
  { name: 'diagnosis_result', tile: T.text,
    en: 'What was found?', ne: 'के भेटियो?', rel: { rules: [visitedYes] } },
  { name: 'meds_started', tile: T.s1, required: true, reuse: 'yes_no',
    en: 'Was any treatment started?', ne: 'कुनै उपचार सुरु भयो?', rel: { rules: [visitedYes] } },
  { name: 'memory_improvement', tile: T.s1, required: true, list: STATUS('mem'),
    en: 'Memory since the last visit', ne: 'गत भेटपछि सम्झना',
    rel: { rules: [visitedYes, flagTrue('refer_cognitive')] } },
  { name: 'sit_stand_followup', tile: T.s1, required: true, list: STATUS('mob'),
    en: 'Sit-to-stand since the last visit', ne: 'गत भेटपछि उठ्ने-बस्ने',
    rel: { rules: [visitedYes, flagTrue('refer_mobility')] } },
  { name: 'weight_increased', tile: T.s1, required: true, list: STATUS('nut'),
    en: 'Weight since the last visit', ne: 'गत भेटपछि तौल',
    rel: { rules: [visitedYes, flagTrue('refer_nutrition')] } },
  { name: 'external_eye_now', tile: T.s1, required: true, list: STATUS('eye'),
    en: 'Eye condition since the last visit', ne: 'गत भेटपछि आँखाको अवस्था',
    rel: { rules: [visitedYes, flagTrue('refer_vision')] } },
  { name: 'hearing_status', tile: T.s1, required: true, list: STATUS('ear'),
    en: 'Hearing since the last visit', ne: 'गत भेटपछि सुन्ने क्षमता',
    rel: { rules: [visitedYes, flagTrue('refer_hearing')] } },
  { name: 'psych_status', tile: T.s1, required: true, list: STATUS('psy'),
    en: 'Mood since the last visit', ne: 'गत भेटपछि मनको अवस्था',
    rel: { rules: [visitedYes, flagTrue('refer_psych')] } },
  { name: 'continence_status', tile: T.s1, required: true, list: STATUS('con'),
    en: 'Bladder comfort since the last visit', ne: 'गत भेटपछि पिसाब नियन्त्रण',
    rel: { rules: [visitedYes, flagTrue('refer_continence')] } },
  { name: 'not_visited_note', tile: T.note,
    en: 'Encourage the family to arrange the visit soon.',
    ne: 'चाँडै जाँचको व्यवस्था गर्न परिवारलाई प्रोत्साहन दिनुहोस्।',
    rel: { rules: [{ kind: 'cmp', field: 'visited_facility', choice: 'no' }] } },
];


/* ─────────────────────────── builder drivers ─────────────────────────── */

export async function openProjectAt(page: Page, projectPath: string): Promise<void> {
  await page.request.post(`${API}/api/project/open`, { data: { path: projectPath } });
}

/** Survey-editor mode resets to Simple on every tab switch (remount);
 *  sections are invisible in Simple (NEXT.md finding C) — re-assert Full. */
export async function ensureFullMode(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Full', exact: true }).click();
}

export function rowByName(page: Page, name: string): Locator {
  return page.locator('.survey-row').filter({ has: page.locator(`input.name-input[value="${name}"]`) });
}

/** Page-header Save → SaveDiffModal Save → "Saved". */
export async function saveForm(page: Page): Promise<void> {
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible({ timeout: 20_000 });
}

export async function readForm(page: Page, formId: string) {
  const res = await page.request.get(`${API}/api/forms/${encodeURIComponent(formId)}`);
  expect(res.ok(), `GET form ${formId}`).toBeTruthy();
  return (await res.json()).form as {
    surveyHeaders: { labelLocales: string[] };
    choicesHeaders: { labelLocales: string[] };
    survey: Array<{ type: string; name: string; labels: Record<string, string>; extras: Record<string, string> }>;
    choices: Array<{ list_name: string; name: string; labels: Record<string, string> }>;
  };
}

/** Create an app form label-first and land in its editor (Full mode). */
export async function createAppForm(page: Page, title: string, basename: string): Promise<void> {
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: '+ App form' }).click();
  const card = page.locator('.create-form');
  await card.locator('#new-form-title').fill(title);
  await expect(card.locator('code', { hasText: new RegExp(`^${basename}$`) })).toBeVisible();
  await card.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(card).toBeHidden();
  await expect(page.getByRole('button', { name: /^Survey/ }).first()).toBeVisible({ timeout: 15_000 });
  await ensureFullMode(page);
}

/** "+ Section" with EN title + NE heading + optional one-screen appearance. */
export async function addSection(page: Page, s: Section): Promise<Locator> {
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

/** Add one row (question/note/calc) — inside a section accordion when given,
 *  else top-level. EN+NE labels at add time; choices per-locale (item F). */
export async function addRow(page: Page, accordion: Locator | null, row: Row): Promise<void> {
  const page_ = accordion ? accordion.page() : page;
  if (accordion) {
    await accordion.getByRole('button', { name: /\+ add inside|\+ Add question/ }).first().click();
  } else {
    await page.getByRole('button', { name: '+ Question' }).first().click();
  }
  const picker = page_.locator('.qtype-modal');
  await expect(picker).toBeVisible();
  await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill(row.name);
  const labelFields = picker.locator('.qtype-labels-field .qtype-locale-label');
  if (row.en) {
    await labelFields.filter({ has: page_.getByText('label::en', { exact: true }) }).locator('input').fill(row.en);
  }
  if (row.ne) {
    const neInput = labelFields.filter({ has: page_.getByText('label::ne', { exact: true }) }).locator('input');
    if (await neInput.isVisible().catch(() => false)) await neInput.fill(row.ne);
  }
  await picker
    .locator('.qtype-tile')
    .filter({ has: page_.locator('.qtype-tile-label', { hasText: row.tile }) })
    .first()
    .click();

  if (row.list || row.reuse) {
    await expect(picker.getByText(/needs a list of options/)).toBeVisible();
    if (row.reuse) {
      const reuse = picker
        .locator('.qtype-list-choice label', { hasText: 'Reuse' })
        .filter({ has: page_.locator('code', { hasText: new RegExp(`^${row.reuse}$`) }) });
      await reuse.locator('input').check();
    } else if (row.list) {
      await picker.getByPlaceholder('options').fill(row.list.list);
      const choiceRows = picker.locator('.qtype-choice-row');
      await expect(choiceRows.first().locator('input')).toHaveCount(3); // name + en + ne (item F)
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
    await rowByName(page_, row.name).locator('.required-label input').check();
  }
  if (row.rel) await setRelevance(page_, row.name, row.rel);
}

/** Relevance via the visual builder — choice dropdowns only, zero typing. */
export async function setRelevance(
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
  await fillRuleList(page, modal, rel);
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toBeHidden();
}

/** Shared rule-list driver for any mount of the visual rule builder. */
export async function fillRuleList(
  page: Page,
  scope: Locator,
  rel: { or?: boolean; rules: Rel[] },
): Promise<void> {
  if (rel.or) {
    const orToggle = scope.getByText('or instead (any rule may match)').locator('input');
    if (await orToggle.isVisible().catch(() => false)) await orToggle.check();
  }
  for (const r of rel.rules) {
    if (r.kind === 'cmp') {
      await scope.getByRole('button', { name: '+ comparison' }).click();
      const rule = scope.locator('.rule-row').last();
      await rule.locator('select').first().selectOption(r.field);
      const stringToggle = rule.locator('input[type="checkbox"]');
      if (!(await stringToggle.isChecked())) await stringToggle.check();
      const valueSelect = rule.locator('select.choice-value-select');
      if (await valueSelect.isVisible().catch(() => false)) {
        await valueSelect.selectOption(r.choice);
      } else {
        // Fields without form-local choices (calculates, inputs rows) get a
        // free-text value cell — type the literal (recorded as friction).
        await rule.getByPlaceholder('text value').fill(r.choice);
      }
    } else {
      await scope.getByRole('button', { name: '+ selected()' }).click();
      const rule = scope.locator('.rule-row').last();
      await rule.locator('label', { hasText: 'NOT' }).locator('input').check();
      await rule.locator('select').first().selectOption(r.field);
      const valueSelect = rule.locator('select.choice-value-select');
      await expect(valueSelect, `selected() choice dropdown for ${r.field}`).toBeVisible();
      await valueSelect.selectOption(r.choice);
    }
  }
}
