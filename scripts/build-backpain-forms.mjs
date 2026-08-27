/**
 * Build the chronic-back-pain surveillance + follow-up XLSForms for the
 * gandaki demo. Runs the tool's own serializer to produce the .xlsx files,
 * proving the editor's outputs are CHT-compatible.
 *
 * Usage: node scripts/build-backpain-forms.mjs
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serializeXlsForm } from '@cht-ui/shared';

const today = new Date().toISOString().slice(0, 10);

/** Build a SurveyRow with extras helper. */
function r(rowId, type, name, labelEn, labelNe, extras = {}) {
  return {
    rowId,
    type,
    name,
    labels: { en: labelEn ?? '', ne: labelNe ?? 'NO_LABEL' },
    required: '',
    extras,
  };
}

/** Build a ChoiceRow. */
function c(rowId, list_name, name, labelEn, labelNe) {
  return {
    rowId,
    list_name,
    name,
    labels: { en: labelEn, ne: labelNe ?? labelEn },
    extras: {},
  };
}

const surveyHeadersOrdered = [
  'type',
  'name',
  'label::en',
  'label::ne',
  'required',
  'relevant',
  'appearance',
  'constraint',
  'constraint_message::en',
  'calculation',
  'choice_filter',
  'hint::en',
  'default',
  'instance::tag',
];

const choicesHeadersOrdered = ['list_name', 'name', 'label::en', 'label::ne'];

/* ----------------------------------------------------------------------
 * SURVEILLANCE FORM
 * --------------------------------------------------------------------*/
const surveillanceSurvey = [
  // Standard inputs block (CHT convention).
  r('s1', 'begin group', 'inputs', 'Patient', 'NO_LABEL', {
    relevant: "./source = 'user'",
    appearance: 'field-list',
  }),
  r('s2', 'hidden', 'source', 'Source', 'NO_LABEL', { default: 'user' }),
  r('s3', 'hidden', 'source_id', 'Source ID', 'NO_LABEL'),
  r('s4', 'begin group', 'contact', 'Contact', 'NO_LABEL'),
  r('s5', 'db:person', '_id', "What is the patient's name?", 'सेवा लिनेको नाम के हो?', {
    appearance: 'db-object',
  }),
  r('s6', 'hidden', 'patient_id', 'Patient ID', 'NO_LABEL'),
  r('s7', 'hidden', 'name', 'Name', 'NO_LABEL'),
  r('s8', 'hidden', 'date_of_birth', 'DOB', 'NO_LABEL'),
  r('s9', 'hidden', 'sex', 'Sex', 'NO_LABEL'),
  r('s10', 'end group', '', '', 'NO_LABEL'),
  r('s11', 'end group', '', '', 'NO_LABEL'),

  // Main surveillance questions.
  r('s12', 'begin group', 'surveillance', 'Chronic Back Pain Surveillance', 'पुरानो ढाड दुखाइको निगरानी'),

  r('s13', 'note', 'intro', 'We are screening adult males aged 18–65 for chronic back pain. This information helps the health facility plan follow-up care.', ''),

  r('s14', 'select_one yes_no', 'has_back_pain', 'Do you currently have back pain?', 'के तपाईंलाई अहिले ढाड दुखेको छ?', {
    required: 'yes',
  }),

  r('s15', 'select_one duration_options', 'pain_duration', 'How long has the pain been present?', 'कति समयदेखि दुखेको छ?', {
    relevant: "${has_back_pain} = 'yes'",
    required: 'yes',
  }),

  r('s16', 'integer', 'pain_severity', 'On a 1–10 scale, how severe is the pain on most days?', '१-१० मा कति तीव्र छ?', {
    relevant: "${has_back_pain} = 'yes'",
    constraint: '. >= 1 and . <= 10',
    'constraint_message::en': 'Enter a number between 1 and 10',
    required: 'yes',
  }),

  r('s17', 'select_multiple body_location', 'pain_location', 'Where is the pain located?', 'दुखाइ कहाँ छ?', {
    relevant: "${has_back_pain} = 'yes'",
  }),

  r('s18', 'select_one yes_no', 'radiates_to_leg', 'Does the pain travel down to your leg(s)?', 'दुखाइ खुट्टातिर जान्छ?', {
    relevant: "${has_back_pain} = 'yes'",
  }),

  r('s19', 'select_one yes_no', 'numbness_weakness', 'Any numbness or weakness in your legs?', 'खुट्टामा झमझम वा कमजोरी छ?', {
    relevant: "${has_back_pain} = 'yes'",
  }),

  // Red flag questions (potentially urgent).
  r('s20', 'begin group', 'red_flags', 'Warning signs', 'चेतावनी संकेत', {
    relevant: "${has_back_pain} = 'yes'",
  }),
  r('s21', 'select_one yes_no', 'red_flag_bowel_bladder', 'Any loss of bowel or bladder control?', ''),
  r('s22', 'select_one yes_no', 'red_flag_fever', 'Any fever along with the back pain?', ''),
  r('s23', 'select_one yes_no', 'red_flag_weight_loss', 'Unexplained weight loss in the past month?', ''),
  r('s24', 'end group', '', '', 'NO_LABEL'),

  r('s25', 'select_one yes_no', 'prior_treatment', 'Have you tried any treatment for this pain?', ''),

  r('s26', 'text', 'notes', 'Other notes', 'अन्य टिप्पणी', {
    appearance: 'multiline',
  }),

  // Calculated: chronic & symptomatic indicator that drives the follow-up task.
  r('s27', 'calculate', 'has_chronic_symptoms', 'Has chronic symptoms (calc)', 'NO_LABEL', {
    calculation:
      "if(${has_back_pain} = 'yes' and (${pain_duration} = 'more_6_weeks' or ${pain_duration} = 'more_3_months') and ${pain_severity} >= 4, 'yes', 'no')",
  }),
  r('s28', 'calculate', 'has_red_flags', 'Has red flags (calc)', 'NO_LABEL', {
    calculation:
      "if(${red_flag_bowel_bladder} = 'yes' or ${red_flag_fever} = 'yes' or ${red_flag_weight_loss} = 'yes', 'yes', 'no')",
  }),

  r('s29', 'note', 'urgent_note',
    'This patient has warning signs and should be referred for urgent care.',
    'यो बिरामीलाई तुरुन्त रेफर गर्नुहोस्।', {
      relevant: "${has_red_flags} = 'yes'",
      appearance: 'warn',
    }),

  r('s30', 'end group', '', '', 'NO_LABEL'),
];

const surveillanceChoices = [
  c('cs1', 'yes_no', 'yes', 'Yes', 'हो'),
  c('cs2', 'yes_no', 'no', 'No', 'होईन'),
  c('cs3', 'duration_options', 'less_2_weeks', 'Less than 2 weeks', '२ हप्ता भन्दा कम'),
  c('cs4', 'duration_options', '2_to_6_weeks', '2 to 6 weeks', '२ देखि ६ हप्ता'),
  c('cs5', 'duration_options', 'more_6_weeks', 'More than 6 weeks', '६ हप्ता भन्दा बढी'),
  c('cs6', 'duration_options', 'more_3_months', 'More than 3 months', '३ महिना भन्दा बढी'),
  c('cs7', 'body_location', 'lower_back', 'Lower back', 'तल्लो ढाड'),
  c('cs8', 'body_location', 'upper_back', 'Upper back', 'माथिल्लो ढाड'),
  c('cs9', 'body_location', 'neck', 'Neck', 'घाँटी'),
  c('cs10', 'body_location', 'hips', 'Hips / buttocks', 'कम्मर'),
];

const surveillanceForm = {
  locales: ['en', 'ne'],
  surveyHeaders: { ordered: surveyHeadersOrdered, labelLocales: ['en', 'ne'] },
  choicesHeaders: { ordered: choicesHeadersOrdered, labelLocales: ['en', 'ne'] },
  survey: surveillanceSurvey,
  choices: surveillanceChoices,
  settings: {
    form_title: 'Chronic Back Pain Surveillance',
    form_id: 'back_pain_surveillance',
    version: today,
    default_language: 'en',
    extras: { style: 'pages' },
  },
  extraSheets: [],
};

/* ----------------------------------------------------------------------
 * FOLLOW-UP FORM
 * --------------------------------------------------------------------*/
const followupSurvey = [
  // Inputs block.
  r('f1', 'begin group', 'inputs', 'Patient', 'NO_LABEL', {
    relevant: "./source = 'user'",
    appearance: 'field-list',
  }),
  r('f2', 'hidden', 'source', 'Source', 'NO_LABEL', { default: 'user' }),
  r('f3', 'hidden', 'source_id', 'Source ID', 'NO_LABEL'),
  r('f4', 'begin group', 'contact', 'Contact', 'NO_LABEL'),
  r('f5', 'db:person', '_id', "What is the patient's name?", '', { appearance: 'db-object' }),
  r('f6', 'hidden', 'patient_id', 'Patient ID', 'NO_LABEL'),
  r('f7', 'hidden', 'name', 'Name', 'NO_LABEL'),
  r('f8', 'end group', '', '', 'NO_LABEL'),
  r('f9', 'end group', '', '', 'NO_LABEL'),

  // Visit-period context passed in by the task action (CHT convention).
  r('f10', 'hidden', 'visit', 'Visit ID', 'NO_LABEL'),
  r('f11', 'hidden', 'current_period_start', 'Window start', 'NO_LABEL'),
  r('f12', 'hidden', 'current_period_end', 'Window end', 'NO_LABEL'),

  r('f13', 'begin group', 'followup', 'Back Pain Follow-up', 'ढाड दुखाइ पछिल्लो जाँच'),

  r('f14', 'note', 'recap',
    'You reported chronic back pain at your last visit. This follow-up checks whether you sought care and what was found.',
    ''),

  r('f15', 'select_one yes_no', 'visited_hf', 'Did the patient visit a health facility?', 'के बिरामीले स्वास्थ्य संस्था गएको थियो?', {
    required: 'yes',
  }),

  r('f16', 'text', 'reason_no', 'Why did the patient not visit a health facility?', 'किन गएको थिएन?', {
    relevant: "${visited_hf} = 'no'",
    appearance: 'multiline',
  }),

  r('f17', 'begin group', 'hf_visit', 'Health facility visit', '', {
    relevant: "${visited_hf} = 'yes'",
  }),

  r('f18', 'text', 'hf_name', 'Which health facility?', 'कुन स्वास्थ्य संस्था?'),

  r('f19', 'text', 'diagnosis', 'What was the diagnosis or impression?', 'के निदान भयो?', {
    appearance: 'multiline',
    required: 'yes',
  }),

  r('f20', 'select_multiple diagnostic_methods', 'diagnostic_methods',
    'Which diagnostic methods were used?',
    'कुन-कुन निदान विधि प्रयोग गरियो?', {
      hint: 'Select all that apply',
    }),

  r('f21', 'text', 'other_method', 'Specify the other method', 'अन्य विधि उल्लेख गर्नुहोस्', {
    relevant: "selected(${diagnostic_methods}, 'other')",
  }),

  r('f22', 'integer', 'current_pain_level', 'On a 1–10 scale, how is the pain today?', '१-१० मा अहिले कति?', {
    constraint: '. >= 0 and . <= 10',
  }),

  r('f23', 'select_one yes_no', 'treatment_started', 'Was any treatment started or prescribed?', 'कुनै उपचार सुरु गरियो?'),

  r('f24', 'text', 'treatment_details', 'Briefly describe the treatment', 'उपचारको विवरण', {
    relevant: "${treatment_started} = 'yes'",
    appearance: 'multiline',
  }),

  r('f25', 'select_one referral_outcome', 'referral_outcome', 'Outcome of the visit', 'भ्रमणको परिणाम'),

  r('f26', 'end group', '', '', 'NO_LABEL'),

  r('f27', 'text', 'notes', 'Other notes', 'अन्य टिप्पणी', { appearance: 'multiline' }),

  // Calculated field useful for targets/reporting later.
  r('f28', 'calculate', 'hf_visited_calc', 'HF visited (calc)', 'NO_LABEL', {
    calculation: '${visited_hf}',
  }),

  r('f29', 'end group', '', '', 'NO_LABEL'),
];

const followupChoices = [
  c('cf1', 'yes_no', 'yes', 'Yes', 'हो'),
  c('cf2', 'yes_no', 'no', 'No', 'होईन'),
  c('cf3', 'diagnostic_methods', 'physical_exam', 'Physical examination only', 'शारीरिक जाँच मात्र'),
  c('cf4', 'diagnostic_methods', 'x_ray', 'X-ray', 'एक्स-रे'),
  c('cf5', 'diagnostic_methods', 'usg', 'Ultrasound (USG)', 'अल्ट्रासाउन्ड'),
  c('cf6', 'diagnostic_methods', 'mri', 'MRI', 'एम.आर.आई'),
  c('cf7', 'diagnostic_methods', 'ct_scan', 'CT scan', 'सी.टी. स्क्यान'),
  c('cf8', 'diagnostic_methods', 'blood_test', 'Blood test', 'रगत जाँच'),
  c('cf9', 'diagnostic_methods', 'urine_test', 'Urine test', 'पिसाब जाँच'),
  c('cf10', 'diagnostic_methods', 'nerve_study', 'Nerve conduction study (EMG/NCS)', 'नर्भ कन्डक्सन'),
  c('cf11', 'diagnostic_methods', 'other', 'Other', 'अन्य'),
  c('cf12', 'referral_outcome', 'resolved', 'Resolved', 'समाधान भयो'),
  c('cf13', 'referral_outcome', 'improving', 'Improving', 'सुधार हुँदै'),
  c('cf14', 'referral_outcome', 'no_change', 'No change', 'परिवर्तन छैन'),
  c('cf15', 'referral_outcome', 'worsening', 'Worsening', 'बिग्रिँदै'),
  c('cf16', 'referral_outcome', 'referred_higher', 'Referred to higher centre', 'माथिल्लो केन्द्रमा रेफर'),
];

const followupForm = {
  locales: ['en', 'ne'],
  surveyHeaders: { ordered: surveyHeadersOrdered, labelLocales: ['en', 'ne'] },
  choicesHeaders: { ordered: choicesHeadersOrdered, labelLocales: ['en', 'ne'] },
  survey: followupSurvey,
  choices: followupChoices,
  settings: {
    form_title: 'Back Pain Follow-up',
    form_id: 'back_pain_followup',
    version: today,
    default_language: 'en',
    extras: { style: 'pages' },
  },
  extraSheets: [],
};

/* ----------------------------------------------------------------------
 * Write files.
 * --------------------------------------------------------------------*/
// This repo ships no CHT config; pass the target forms/app directory explicitly.
const outDir = process.argv[2] ?? process.env.CHT_FORMS_DIR;
if (!outDir) {
  console.error(
    'Usage: node scripts/build-backpain-forms.mjs <path-to/forms/app>\n' +
      '   or: CHT_FORMS_DIR=<path-to/forms/app> node scripts/build-backpain-forms.mjs',
  );
  process.exit(2);
}

const sBuf = await serializeXlsForm(surveillanceForm);
const fBuf = await serializeXlsForm(followupForm);

const sXlsx = path.join(outDir, 'back_pain_surveillance.xlsx');
const fXlsx = path.join(outDir, 'back_pain_followup.xlsx');

await writeFile(sXlsx, sBuf);
await writeFile(fXlsx, fBuf);

const surveillanceProps = {
  title: [
    { locale: 'en', content: 'Chronic Back Pain Surveillance' },
    { locale: 'ne', content: 'पुरानो ढाड दुखाइको निगरानी' },
  ],
  context: {
    place: false,
    person: true,
    expression:
      "contact.type === 'person' && contact.sex === 'male' && ageInYears(contact) >= 18 && ageInYears(contact) <= 65 && summary.show_back_pain_surveillance_form && !contact.muted && !contact.date_of_death",
  },
  icon: 'icon-healthcare',
};

const followupProps = {
  title: [
    { locale: 'en', content: 'Back Pain Follow-up' },
    { locale: 'ne', content: 'ढाड दुखाइ पछिल्लो जाँच' },
  ],
  context: {
    // The follow-up form is only opened via a scheduled task, so the
    // person-context expression always returns false. The task action
    // (in tasks.js) still opens it.
    place: false,
    person: true,
    expression: 'false',
  },
  icon: 'icon-healthcare',
};

await writeFile(
  path.join(outDir, 'back_pain_surveillance.properties.json'),
  JSON.stringify(surveillanceProps, null, 2),
);
await writeFile(
  path.join(outDir, 'back_pain_followup.properties.json'),
  JSON.stringify(followupProps, null, 2),
);

console.log(`Wrote ${sXlsx} (${sBuf.length} bytes)`);
console.log(`Wrote ${fXlsx} (${fBuf.length} bytes)`);
console.log('Wrote both .properties.json files.');
