/**
 * Demo: build the NSSD "CHO Supervisory Form" (slides 10–20 of the CHO
 * Supervisory Form deck) with NO code — every row, choice list, hint,
 * widget and show/hide rule is picked or typed as plain text in the UI.
 * No XPath is ever typed.
 *
 * Record with:
 *   DEMO_OUT=cho-supervisory-form DEMO_MS=150 npx playwright test -c playwright.demo.config.ts tests/t9-demos/cho_supervisory_form.demo.spec.ts
 *
 * The video, the built `cho_supervisory_form.xlsx` and its properties file
 * land in `client/demo/cho-supervisory-form/`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, say, beat, API, DEMO_DIR } from './demo-helpers.js';

/* ------------------------------ content ------------------------------ */

type Choice = { name: string; en: string; ne: string };
type List = { name: string; choices: Choice[] };
type Rel = { field: string; op: 'equals' | 'includes'; value: string };
type Row = {
  name: string;
  en: string;
  ne: string;
  tile: 'Select one' | 'Select many' | 'Number' | 'Text' | 'Note';
  list?: List;
  reuse?: string;
  hintNe?: string;
  multiline?: boolean;
  rel?: Rel;
};
type Section = { en: string; ne: string; slug: string; rows: Row[] };

const R = (name: string, en: string, ne: string): Choice => ({ name, en, ne });

/** Rating lists carry the slide's per-option description in Nepali. */
function rating(name: string, ne: [string, string, string, string]): List {
  return {
    name,
    choices: [
      R('unsatisfactory', 'Unsatisfactory', `असन्तोषजनक (Unsatisfactory): ${ne[0]}`),
      R('satisfactory', 'Satisfactory', `सन्तोषजनक (Satisfactory): ${ne[1]}`),
      R('good', 'Good', `राम्रो (Good): ${ne[2]}`),
      R('excellent', 'Excellent', `उत्कृष्ट (Excellent): ${ne[3]}`),
    ],
  };
}

const YES_NO: List = { name: 'yes_no', choices: [R('yes', 'Yes', 'छ'), R('no', 'No', 'छैन')] };
const YES_NO_NA: List = {
  name: 'yes_no_na',
  choices: [R('yes', 'Yes', 'छ'), R('no', 'No', 'छैन'), R('na', 'Not applicable', 'लागू हुँदैन')],
};
const DID: List = { name: 'did_not', choices: [R('yes', 'Yes', 'थिए'), R('no', 'No', 'थिएन')] };

const SECTIONS: Section[] = [
  {
    en: 'Physical condition', ne: 'भौतिक अवस्था', slug: 'physical_condition',
    rows: [
      {
        name: 'device_condition', tile: 'Select one',
        en: 'Physical condition of the tablet / mobile',
        ne: '१. ट्याब्लेट/मोबाइलको भौतिक अवस्था',
        list: rating('device_condition_rating', [
          'स्क्रिन फुटेको, डिस्प्ले/टच/ब्याट्रीमा समस्या भएको वा ठूलो क्षति भएको।',
          'सामान्य खरोंच वा प्रयोगका कारण देखिने सामान्य घिसावट भएको, तर प्रयोगमा असर नपर्ने।',
          'न्यूनतम घिसावट भएको र पूर्ण रूपमा काम गर्ने अवस्थामा रहेको।',
          'नयाँजस्तै अवस्थामा रहेको।',
        ]),
      },
      {
        name: 'device_charge', tile: 'Select one',
        en: 'Tablet / mobile phone charge',
        ne: '२. ट्याब्लेट/मोबाइल फोनको चार्ज',
        list: rating('device_charge_rating', [
          'चार्ज अत्यन्त कम भएको; दिनभर काम गर्न नपुग्न सक्ने।',
          'चार्ज कम भएको; दिनको बीचमा पुनः चार्ज गर्नुपर्ने हुन सक्ने।',
          'दिनभरको कामका लागि पर्याप्त चार्ज भएको।',
          'पूर्ण वा लगभग पूर्ण रूपमा चार्ज भएको।',
        ]),
      },
    ],
  },
  {
    en: 'App use', ne: 'एप प्रयोग', slug: 'app_use',
    rows: [
      {
        name: 'cht_primary_app', tile: 'Select one',
        en: 'Is the CHT App the main app used on this tablet / mobile?',
        ne: '३. के यस ट्याब्लेट/मोबाइलमा मुख्य रूपमा CHT App नै प्रयोग भइरहेको छ?',
        hintNe: '(सेटिङ्स → Digital Wellbeing/Parental Controls मा गएर CHT र अन्य एपहरूमा बिताइएको समय हेर्नुहोस्।)',
        list: rating('cht_use_rating', [
          'CHT विरलै प्रयोग हुने; अधिकांश समय कामबाहेकका अन्य एपहरू प्रयोग हुने।',
          'CHT नियमित रूपमा प्रयोग हुने, तर अन्य एपहरूको मध्यम प्रयोगले कार्यसम्पादनमा असर पार्न सक्ने।',
          'CHT मुख्य एपको रूपमा प्रयोग हुने; काम गर्ने समयमा अन्य एपहरूको प्रयोग सीमित हुने।',
          'CHT निरन्तर मुख्य एपको रूपमा प्रयोग हुने; कामबाहेकका एपहरूको प्रयोग न्यूनतम र कुनै चिन्ता नदेखिने।',
        ]),
      },
    ],
  },
  {
    en: 'Installed apps', ne: 'इन्स्टल गरिएका एप', slug: 'installed_apps',
    rows: [
      {
        name: 'unauthorized_apps', tile: 'Select one',
        en: 'Are unauthorised apps unrelated to work installed? (e.g. Game, Facebook, Instagram)',
        ne: 'के कामसँग असम्बन्धित अनधिकृत एपहरू इन्स्टल गरिएका छन्? (जस्तै: Game, Facebook, Instagram)',
        list: YES_NO,
      },
      {
        name: 'synced_before_visit', tile: 'Select one',
        en: 'Did the CHN sync data before the field visit?',
        ne: 'के CHN ले फिल्ड भ्रमणअघि डाटा सिंक गर्नुभएको छ?',
        reuse: 'yes_no',
      },
      {
        name: 'sync_counsel', tile: 'Note',
        en: 'Counsel the CHN on the importance of syncing. 1. Data loss: unsynced data is lost if the device breaks, is lost or is reset. 2. Data security: syncing backs the data up safely on the server. 3. Data inconsistency: delayed syncing leaves old or incomplete information, which affects reporting and service delivery.',
        ne: 'सिंकको महत्त्वबारे CHN लाई परामर्श दिनुहोस्। १. डाटा हराउने जोखिम (Data Loss): डिभाइसमा भएको डाटा सिंक नभएको अवस्थामा डिभाइस बिग्रिएमा, हराएमा वा रिसेट भएमा डाटा हराउन सक्छ। २. डाटा सुरक्षा (Data Security): डाटा सिंक गर्दा डाटाको सुरक्षित रूपमा सर्भरमा ब्याकअप हुन्छ। ३. डाटामा असंगति (Data Inconsistency): डाटा सिंक गर्न ढिलाइ हुँदा पुरानो वा अपूर्ण जानकारी रहन सक्छ, जसले रिपोर्टिङ र स्वास्थ्य सेवा प्रवाहमा असर पार्न सक्छ।',
        rel: { field: 'synced_before_visit', op: 'equals', value: 'no' },
      },
    ],
  },
  {
    en: 'App performance', ne: 'एपको कार्यसम्पादन', slug: 'app_performance',
    rows: [
      {
        name: 'app_performance', tile: 'Select one',
        en: 'Does the CHIS app work well? (Loading, navigation, responsiveness, sync, stability)',
        ne: 'के CHIS एपले राम्रोसँग काम गर्छ? (Loading, navigation, responsiveness, sync, stability)',
        list: rating('app_performance_rating', [
          'बारम्बार एप क्र्यास हुने वा अड्किने, ढिलो चल्ने वा डाटा सिंकमा समस्या आउने, जसले काममा असर पार्ने।',
          'कहिलेकाहीँ समस्या आउने, तर नियमित कामका लागि प्रयोग गर्न सकिने।',
          'एप सहज रूपमा चल्ने, सामान्यतया राम्रो प्रतिक्रिया दिने र कहिलेकाहीँ मात्र सामान्य ढिलाइ हुने।',
          'सधैँ छिटो, स्थिर र सहज रूपमा चल्ने; कुनै समस्या नहुने।',
        ]),
      },
      {
        name: 'has_feedback', tile: 'Select one',
        en: 'Does the CHN have any feedback, problem, challenge or suggestion about the CHIS App or the device?',
        ne: '७. के CHN सँग CHIS App वा डिभाइससम्बन्धी कुनै प्रतिक्रिया, समस्या, चुनौती वा सुझाव छ?',
        reuse: 'yes_no',
      },
      {
        name: 'feedback_details', tile: 'Text', multiline: true,
        en: 'Please describe in detail',
        ne: 'कृपया यहाँ विस्तृत रूपमा उल्लेख गर्नुहोस्:',
        rel: { field: 'has_feedback', op: 'equals', value: 'yes' },
      },
    ],
  },
  {
    en: 'Checklist', ne: 'चेकलिस्ट', slug: 'checklist',
    rows: [
      {
        name: 'checklist_note', tile: 'Note',
        en: 'Does the CHN have all the medicines and equipment needed for field work?',
        ne: 'के CHN सँग फिल्ड कामका लागि आवश्यक सबै औषधि र उपकरण छन्?',
      },
      { name: 'bp_set', tile: 'Select one', en: 'Is the BP set in working condition?', ne: '१. BP सेट काम गर्ने अवस्थामा छ?', list: YES_NO_NA },
      { name: 'glucometer', tile: 'Select one', en: 'Is the glucometer in working condition?', ne: '२. ग्लुकोमिटर काम गर्ने अवस्थामा छ?', reuse: 'yes_no_na' },
      { name: 'thermometer', tile: 'Select one', en: 'Is a thermometer available?', ne: '३. थर्मोमिटर उपलब्ध छ?', reuse: 'yes_no_na' },
      { name: 'muac_tape', tile: 'Select one', en: 'Is a MUAC tape available?', ne: '४. MUAC टेप उपलब्ध छ?', reuse: 'yes_no_na' },
      { name: 'weight_machine', tile: 'Select one', en: 'Is a weighing machine available?', ne: '५. तौल नाप्ने मेसिन (Weight Machine) उपलब्ध छ?', reuse: 'yes_no_na' },
      { name: 'height_tape', tile: 'Select one', en: 'Is a height measuring tape available?', ne: '६. उचाइ नाप्ने टेप उपलब्ध छ?', reuse: 'yes_no_na' },
      { name: 'fp_supplies', tile: 'Select one', en: 'Are family planning supplies available?', ne: '७. परिवार नियोजनका साधनहरू उपलब्ध छन्?', reuse: 'yes_no_na' },
      { name: 'ors_zinc_albendazole', tile: 'Select one', en: 'Are ORS / Zinc Tab / Albendazole available?', ne: '८. ORS / Zinc Tab / Albendazole उपलब्ध छन्?', reuse: 'yes_no_na' },
    ],
  },
  {
    en: 'Task tab review', ne: 'कार्य ट्याब समीक्षा', slug: 'task_tab_review',
    rows: [
      {
        name: 'task_review_note', tile: 'Note',
        en: "Please review the Task tab in the CHN's CHIS app and record the following.",
        ne: '१. कृपया CHN को CHIS एपमा रहेको कार्य ट्याब समीक्षा गरी निम्न जानकारी अभिलेख गर्नुहोस्।',
      },
      { name: 'tasks_due_today', tile: 'Number', en: 'Tasks due today', ne: '१) आज पूरा गर्नुपर्ने कार्यहरूको संख्या (Tasks due today)' },
      { name: 'overdue_tasks', tile: 'Number', en: 'Overdue tasks', ne: '२) म्याद नाघेका कार्यहरूको संख्या (Overdue tasks)' },
      { name: 'households_visited', tile: 'Number', en: 'Households visited by the CHN on the supervision day', ne: '३) सुपरिवेक्षणको दिन CHN ले भ्रमण गरेका घरधुरीहरूको संख्या' },
      { name: 'use_cases_completed', tile: 'Number', en: 'Use cases completed by the CHN on the supervision day', ne: '४) सुपरिवेक्षणको दिन CHN ले पूरा गरेका Use Cases को संख्या' },
      {
        name: 'followup_method', tile: 'Select one',
        en: 'How does the CHN identify clients who need follow-up?',
        ne: 'फलो-अप आवश्यक सेवाग्राहीलाई CHN ले कसरी पहिचान गर्नुहुन्छ?',
        list: {
          name: 'followup_method',
          choices: [
            R('task_tab', 'Using the Task tab in the CHIS app', 'CHIS एपको कार्य ट्याब प्रयोग गरेर'),
            R('people_tab', 'Searching the household / family member directly in the People tab', 'People ट्याबमा घरधुरी / परिवारका सदस्य सिधै खोजेर'),
            R('other', 'Using another method', 'अन्य तरिका प्रयोग गरेर'),
          ],
        },
      },
      {
        name: 'followup_method_other', tile: 'Text',
        en: 'Describe the other method',
        ne: 'अन्य तरिका खुलाउनुहोस्',
        rel: { field: 'followup_method', op: 'equals', value: 'other' },
      },
    ],
  },
  {
    en: 'Household verification', ne: 'घरधुरी प्रमाणीकरण', slug: 'household_verification',
    rows: [
      {
        name: 'verification_note', tile: 'Note',
        en: 'On every visit, check the number of household members and the demographic details against the actual household. Make sure all information in the CHIS app is correct and up to date.',
        ne: 'प्रत्येक भ्रमणमा घरधुरीका सदस्य संख्या र जनसांख्यिकीय विवरण वास्तविक घरधुरीसँग रुजु गर्नुहोस्। CHIS एपका सबै जानकारी सही र अद्यावधिक भएको सुनिश्चित गर्नुहोस्।',
      },
      {
        name: 'discrepancy_found', tile: 'Select one',
        en: 'Was any difference found between the demographic information registered in the CHIS app and the actual information?',
        ne: 'के CHIS एपमा दर्ता जनसांख्यिकीय जानकारी र वास्तविक जानकारीबीच कुनै भिन्नता भेटियो?',
        list: { name: 'found_not_found', choices: [R('found', 'Found', 'भेटियो'), R('not_found', 'Not found', 'भेटिएन')] },
      },
      {
        name: 'discrepancy_note', tile: 'Note',
        en: 'Correct the information in the CHIS app during the household visit and give the CHN constructive feedback.',
        ne: 'घरधुरी भ्रमणकै क्रममा CHIS एपमा जानकारी सच्याउनुहोस् र CHN लाई रचनात्मक पृष्ठपोषण दिनुहोस्।',
        rel: { field: 'discrepancy_found', op: 'equals', value: 'found' },
      },
    ],
  },
  {
    en: 'Rapport building', ne: 'मधुर सम्बन्ध स्थापना', slug: 'rapport_building',
    rows: [
      {
        name: 'greeted_consent', tile: 'Select one',
        en: 'Did the CHN greet the household members and take informed consent before providing the service?',
        ne: 'के CHN ले सेवा दिनुअघि घरधुरीका सदस्यहरूलाई अभिवादन गरी सूचित सहमति लिएका थिए?',
        list: DID,
      },
      { name: 'observe_note', tile: 'Note', en: 'Observe.', ne: 'अवलोकन गर्नुहोस्।' },
      {
        name: 'privacy_respect', tile: 'Select one',
        en: 'The CHN maintained privacy while providing the service, treated household members with respect and communicated professionally.',
        ne: 'CHN ले सेवा प्रदान गर्दा गोपनीयता कायम राखेको, घरधुरीका सदस्यलाई सम्मानपूर्वक व्यवहार गरेको र व्यावसायिक रूपमा संवाद गरेको।',
        list: rating('privacy_respect_rating', [
          'गोपनीयता कायम नगरिएको र/वा अनादरपूर्ण वा गैर–व्यावसायिक व्यवहार देखिएको।',
          'आधारभूत गोपनीयता र सम्मान कायम गरिएको, तर सुधारका केही पक्षहरू रहेको।',
          'गोपनीयता कायम गरिएको र सम्मानजनक तथा व्यावसायिक व्यवहार गरिएको।',
          'गोपनीयता निरन्तर रूपमा सुरक्षित राखिएको र अत्यन्त सम्मानजनक तथा व्यावसायिक व्यवहार प्रदर्शन गरिएको।',
        ]),
      },
      {
        name: 'explained_purpose', tile: 'Select one',
        en: 'Did the CHN properly explain the purpose of the visit before providing the service?',
        ne: 'के CHN ले सेवा प्रदान गर्नुअघि भ्रमणको उद्देश्य उचित रूपमा बताए?',
        hintNe: '(उदाहरणका लागि: भ्रमण किन गरिएको हो, यस सेवाले व्यक्तिको स्वास्थ्यमा कसरी फाइदा पुर्‍याउँछ, र अघिल्लो भ्रमणका चिन्ता वा सुझावहरूबारे फलो-अप गरिएको छ कि छैन भन्ने कुरा स्पष्ट गरे।)',
        reuse: 'did_not',
      },
      {
        name: 'good_rapport', tile: 'Select one',
        en: 'Observe the relationship between the CHN and the household members: does the CHN appear to have good rapport and familiarity with them?',
        ne: 'CHN र घरधुरीका सदस्यहरूबीचको सम्बन्ध अवलोकन गर्नुहोस्: के CHN को घरधुरीका सदस्यहरूसँग राम्रो सम्बन्ध र परिचय भएको देखिन्छ?',
        reuse: 'yes_no',
      },
    ],
  },
  {
    en: 'Vital signs', ne: 'भाइटल साइन', slug: 'vital_signs',
    rows: [
      {
        name: 'bp_pulse_measured', tile: 'Select one',
        en: "Did the CHN correctly measure and record the client's blood pressure (BP) and pulse?",
        ne: 'के CHN ले सेवाग्राहीको रक्तचाप (BP) र Pulse (पल्स) सही तरिकाले नापी रेकर्ड गर्नुभएको थियो?',
        reuse: 'did_not',
      },
    ],
  },
  {
    en: 'Counselling', ne: 'परामर्श', slug: 'counselling',
    rows: [
      {
        name: 'health_messages', tile: 'Select one',
        en: 'Did the CHN give the health messages correctly, completely and as per the guideline?',
        ne: 'के CHN ले स्वास्थ्यसम्बन्धी सन्देशहरू सही, पूर्ण र निर्देशिकाअनुसार दिनुभयो?',
        list: rating('health_messages_rating', [
          'महत्वपूर्ण स्वास्थ्य सन्देशहरू छुटेका वा गलत जानकारी दिइएको।',
          'आधारभूत स्वास्थ्य सन्देशहरू प्रदान गरिएको, तर पूर्णता वा स्पष्टताको कमी रहेको।',
          'अधिकांश महत्वपूर्ण स्वास्थ्य सन्देशहरू सही र स्पष्ट रूपमा प्रदान गरिएको।',
          'सिफारिस गरिएका सबै स्वास्थ्य सन्देशहरू सही, स्पष्ट र आत्मविश्वासका साथ प्रदान गरिएको।',
        ]),
      },
      {
        name: 'understandable_language', tile: 'Select one',
        en: "Did the CHN speak in a language or manner the client understands and confirm the client's understanding?",
        ne: 'के CHN ले सेवाग्राहीले बुझ्ने भाषा वा लवजमा कुरा गरी उहाँको बुझाइ सुनिश्चित गर्नुभयो?',
        list: rating('language_rating', [
          'सेवाग्राहीलाई बुझ्न कठिन हुने गरी कुराकानी गरिएको।',
          'कुराकानी बुझ्न सकिने भए पनि सधैँ स्पष्ट नभएको वा सेवाग्राहीअनुसार अनुकूल नभएको।',
          'सेवाग्राहीले बुझ्ने गरी स्पष्ट र उपयुक्त रूपमा कुराकानी गरिएको।',
          'प्रभावकारी र सांस्कृतिक रूपमा उपयुक्त तरिकाले कुराकानी गरिएको र सेवाग्राहीले बुझेको कुरा CHN ले पुष्टि गरेको।',
        ]),
      },
      {
        name: 'active_listening', tile: 'Select one',
        en: "Did the CHN listen carefully to the client's concerns and respond respectfully and appropriately?",
        ne: 'के CHN ले सेवाग्राहीका कुरा र चिन्ताहरू ध्यानपूर्वक सुनी सम्मानजनक र उचित तरिकाले प्रतिक्रिया दिनुभयो?',
        list: rating('listening_rating', [
          'बारम्बार बीचमै कुरा काट्ने वा सेवाग्राहीका चिन्ताहरूलाई उचित रूपमा सम्बोधन नगरेको।',
          'सेवाग्राहीका कुरा सुनेको, तर प्रतिक्रियामा सुधार गर्नुपर्ने देखिएको।',
          'ध्यानपूर्वक सुनेको र सम्मानजनक रूपमा प्रतिक्रिया दिएको।',
          'सहानुभूति र सक्रिय रूपमा सुन्ने व्यवहार देखाएको तथा सेवाग्राहीका चिन्ताहरूलाई प्रभावकारी रूपमा सम्बोधन गरेको।',
        ]),
      },
    ],
  },
  {
    en: 'Closing discussion', ne: 'समापन छलफल', slug: 'closing_discussion',
    rows: [
      {
        name: 'closing_note', tile: 'Note',
        en: 'After the supervision visit, hold this discussion in a private, quiet and comfortable setting.',
        ne: 'सुपरिवेक्षण भ्रमण सकिएपछि यो छलफल एकान्त, शान्त र सहज वातावरणमा गर्नुहोस्।',
      },
      {
        name: 'challenges', tile: 'Select many',
        en: 'As a supervisor, what challenges did you observe?',
        ne: 'As a Supervisor तपाईंले कस्ता चुनौतीहरू देख्नुभयो?',
        list: {
          name: 'challenges',
          choices: [
            R('geography', 'Geographical difficulty', 'भौगोलिक कठिनाइ'),
            R('client_behaviour', 'Client behaviour or lack of cooperation', 'सेवाग्राहीको व्यवहार वा सहयोगको कमी'),
            R('client_absent', 'Client not available at home', 'सेवाग्राही घरमा उपलब्ध नभएको'),
            R('no_medicine', 'Lack of required medicines', 'आवश्यक औषधिको अभाव'),
            R('equipment', 'Lack of required equipment, or equipment not working', 'आवश्यक उपकरणको अभाव वा उपकरण काम नगर्ने'),
            R('app_device_issue', 'Previously unreported CHIS app or device problems', 'CHIS एप वा डिभाइससम्बन्धी पहिले जानकारी नगराइएका समस्या'),
            R('network', 'Network problem', 'नेटवर्कको समस्या'),
            R('other', 'Other', 'अन्य'),
          ],
        },
      },
      {
        name: 'challenges_other', tile: 'Text',
        en: 'Please specify',
        ne: 'उल्लेख गर्नुहोस्',
        rel: { field: 'challenges', op: 'includes', value: 'other' },
      },
      { name: 'strengths', tile: 'Text', multiline: true, en: 'Key strengths observed in the CHN', ne: 'CHN मा देखिएका मुख्य सबल पक्षहरू' },
      { name: 'improvements', tile: 'Text', multiline: true, en: 'Areas for improvement', ne: 'सुधार गर्नुपर्ने क्षेत्रहरू' },
    ],
  },
];

/* ------------------------------ UI driving ------------------------------ */

function picker(page: Page): Locator {
  return page.locator('.qtype-modal');
}

async function rowByName(page: Page, name: string): Promise<Locator> {
  const rows = page.locator('.survey-row').filter({ has: page.getByRole('textbox', { name: 'name', exact: true }) });
  const n = await rows.count();
  for (let i = n - 1; i >= 0; i--) {
    const row = rows.nth(i);
    if ((await row.getByRole('textbox', { name: 'name', exact: true }).inputValue()) === name) return row;
  }
  throw new Error(`no row named ${name}`);
}

function localeInput(scope: Locator, loc: string): Locator {
  return scope
    .locator('.qtype-labels-field .qtype-locale-label')
    .filter({ has: scope.page().getByText(`label::${loc}`, { exact: true }) })
    .locator('input');
}

async function addSection(page: Page, s: Section): Promise<Locator> {
  await page.getByRole('button', { name: '+ Section' }).click();
  const p = picker(page);
  await expect(p).toBeVisible();
  await p.locator('input[placeholder="e.g. Danger signs"]').fill(s.en);
  await expect(p.locator('code', { hasText: s.slug })).toBeVisible();
  await localeInput(p, 'ne').fill(s.ne);
  await p.getByRole('button', { name: 'Add section', exact: true }).click();
  await expect(p).not.toBeVisible();
  const accordion = page.locator('.survey-group-accordion').filter({
    has: page.locator('.survey-group-header code', { hasText: new RegExp(`^${s.slug}$`) }),
  });
  await expect(accordion).toHaveCount(1);
  return accordion;
}

async function addRow(page: Page, row: Row): Promise<Locator> {
  await page.getByRole('button', { name: '+ Question', exact: true }).click();
  const p = picker(page);
  await expect(p).toBeVisible();
  await p.getByPlaceholder(/has_fever/).fill(row.name);
  await localeInput(p, 'en').fill(row.en);
  await localeInput(p, 'ne').fill(row.ne);
  await p
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: new RegExp(`^${row.tile}$`) }) })
    .first()
    .click();
  if (row.list || row.reuse) {
    await expect(p.getByText(/needs a list of options/)).toBeVisible();
    if (row.reuse) {
      await p
        .locator('.qtype-list-choice label', { hasText: 'Reuse' })
        .filter({ has: page.locator('code', { hasText: new RegExp(`^${row.reuse}$`) }) })
        .locator('input')
        .check();
    } else if (row.list) {
      await p.getByPlaceholder('options').fill(row.list.name);
      const choiceRows = p.locator('.qtype-choice-row');
      while ((await choiceRows.count()) < row.list.choices.length) {
        await p.locator('.qtype-choices-edit').getByRole('button', { name: '+ Add choice' }).click();
      }
      for (let i = 0; i < row.list.choices.length; i++) {
        const c = row.list.choices[i]!;
        const inputs = choiceRows.nth(i).locator('input');
        await inputs.nth(0).fill(c.name);
        await inputs.nth(1).fill(c.en);
        await inputs.nth(2).fill(c.ne);
      }
    }
    await p.getByRole('button', { name: 'Add question', exact: true }).click();
  }
  await expect(p).not.toBeVisible();
  const r = await rowByName(page, row.name);
  await r.scrollIntoViewIfNeeded();
  return r;
}

async function showAdvanced(row: Locator): Promise<void> {
  const btn = row.getByRole('button', { name: /show advanced/ });
  if (await btn.isVisible().catch(() => false)) await btn.click();
}

/** "Show this question when <field> <equals|includes> <value>" — all picked. */
async function setRelevance(page: Page, row: Locator, rel: Rel): Promise<void> {
  await showAdvanced(row);
  const strip = row.locator('.cond-strip-unified[data-column="relevant"]');
  await strip.scrollIntoViewIfNeeded();
  await strip.locator('.ref-chip-select').nth(0).selectOption(rel.field);
  const op = strip.locator('.ref-chip-select').nth(1);
  const wanted = rel.op === 'includes' ? 'selected' : '=';
  const ops = await op.locator('option').evaluateAll((els) => els.map((o) => (o as { value: string }).value));
  await op.selectOption(ops.includes(wanted) ? wanted : 'selected');
  await strip.locator('select[title="Pick a value from this field\'s choices"]').selectOption(rel.value);
  await strip.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(strip.locator('.cond-preview').first()).toBeVisible();
  void page;
}

async function setHintNe(row: Locator, text: string): Promise<void> {
  await showAdvanced(row);
  const details = row.locator('details.raw-extras').filter({ hasText: 'Help text' });
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
  const field = row
    .locator('label.expr-field')
    .filter({ has: row.page().locator('code.raw-col-tag', { hasText: /^hint::ne$/ }) })
    .locator('input')
    .first();
  await field.scrollIntoViewIfNeeded();
  await field.fill(text);
}

async function setMultiline(row: Locator): Promise<void> {
  await showAdvanced(row);
  // The button sits inside a <label>, so its accessible name is the label's text.
  const btn = row.locator('button', { hasText: 'pick widgets' }).first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const modal = row.page().locator('.modal').filter({ hasText: /multiline/ }).last();
  await modal.getByRole('checkbox', { name: /^multiline/ }).check();
  await modal.getByRole('button', { name: 'Done' }).click();
}

/* ------------------------------ the take ------------------------------ */

test('CHO Supervisory Form — built with no code', async ({ page, request, scratch }) => {
  test.setTimeout(1_800_000);
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await say(page, 'CHO Supervisory Form (NSSD) — slides 10 to 20, built with no code: every rule is picked, no XPath typed', 3500);

  // Create the form, label first.
  await page.getByRole('button', { name: '+ App form' }).click();
  const card = page.locator('.create-form');
  await card.locator('#new-form-title').fill('CHO Supervisory Form');
  await expect(card.locator('code', { hasText: /^cho_supervisory_form$/ })).toBeVisible();
  await say(page, 'New app form "CHO Supervisory Form" — the file name cho_supervisory_form is derived from the title', 2000);
  await card.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(card).toBeHidden();
  await expect(page.getByRole('button', { name: /^Survey/ }).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Full', exact: true }).click();

  // The form starts English-only: add Nepali from the language chip bar.
  await say(page, 'Add Nepali as a second language: "+ Add language" → नेपाली', 1500);
  const bar = page.locator('.language-chip-bar');
  await bar.getByRole('button', { name: '+ Add language' }).click();
  const pop = page.locator('.language-chip-popover');
  await pop.locator('button', { hasText: 'नेपाली (Nepali)' }).click();
  await expect(bar.locator('.language-chip', { hasText: 'नेपाली' })).toBeVisible();

  let built = 0;
  for (const [si, section] of SECTIONS.entries()) {
    await say(page, `Section ${si + 1} of ${SECTIONS.length}: ${section.en} · ${section.ne}`, 1200);
    const accordion = await addSection(page, section);
    for (const [ri, row] of section.rows.entries()) {
      const r = await addRow(page, row);
      built++;
      if (ri === 0) {
        const header = accordion.locator('button.survey-group-header').first();
        if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
      }
      if (row.hintNe) {
        await say(page, 'A hint is plain text under the question: Messages → Help text', 900);
        await setHintNe(r, row.hintNe);
      }
      if (row.multiline) {
        await say(page, 'A multi-line answer box is a widget picked from the list, not a typed appearance', 900);
        await setMultiline(r);
      }
      if (row.rel) {
        await say(page, `Show "${row.en}" only when ${row.rel.field} ${row.rel.op} ${row.rel.value} — picked in the sentence strip`, 1500);
        await setRelevance(page, r, row.rel);
        await beat(page, 800);
      }
      // Keep the new row the "current" row so the next one lands after it.
      await r.getByRole('textbox', { name: 'name', exact: true }).click();
    }
  }

  await say(page, `${SECTIONS.length} sections, ${built} rows. Saving…`, 1500);
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true })).toBeVisible({ timeout: 20_000 });

  // Read the sheet back through the API and check the picked rules.
  const body = (await (await request.get(`${API}/api/forms/app:cho_supervisory_form`)).json()) as {
    form: { survey: Array<{ type: string; name?: string; extras: Record<string, string> }>; choices: Array<{ list_name: string; name: string }> };
  };
  const cell = (name: string, col: string) => body.form.survey.find((r) => r.name === name)?.extras[col];
  expect(cell('sync_counsel', 'relevant')).toBe("${synced_before_visit} = 'no'");
  expect(cell('feedback_details', 'relevant')).toBe("${has_feedback} = 'yes'");
  expect(cell('followup_method_other', 'relevant')).toBe("${followup_method} = 'other'");
  expect(cell('discrepancy_note', 'relevant')).toBe("${discrepancy_found} = 'found'");
  expect(cell('challenges_other', 'relevant')).toBe("selected(${challenges}, 'other')");
  expect(cell('feedback_details', 'appearance')).toBe('multiline');
  expect(cell('cht_primary_app', 'hint::ne')).toContain('Digital Wellbeing');
  const groups = body.form.survey.filter((r) => r.type.trim().toLowerCase() === 'begin group').length;
  const lists = new Set(body.form.choices.map((c) => c.list_name)).size;

  await page.getByRole('button', { name: 'Simple', exact: true }).click();
  // eslint-disable-next-line no-undef
  await page.evaluate(() => window.scrollTo(0, 0));
  await say(page, `Saved: ${groups} sections, ${built} rows, ${lists} choice lists. Show/hide rules on disk: ${"${synced_before_visit} = 'no'"} · ${"${has_feedback} = 'yes'"} · ${"${followup_method} = 'other'"} · ${"${discrepancy_found} = 'found'"} · ${"selected(${challenges}, 'other')"}`, 6000);

  // Keep the built form next to the video.
  await fs.mkdir(DEMO_DIR, { recursive: true });
  for (const f of ['cho_supervisory_form.xlsx', 'cho_supervisory_form.properties.json']) {
    await fs.copyFile(path.join(scratch, 'forms', 'app', f), path.join(DEMO_DIR, f));
  }
});
