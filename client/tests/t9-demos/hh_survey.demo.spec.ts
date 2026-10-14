/**
 * Demo for a PM/PO audience: build the PIH Malawi "HH Survey" (annual
 * household survey, from the Integrated Workflow design workbook) in the
 * CHT UI Builder with no code, inside a copy of the CHT baseline project,
 * then set its properties (title, icon, where it appears) and save.
 *
 * Human-paced: visible pointer, per-character typing, one fixed gap
 * between inputs. Captions are plain language, no XLSForm vocabulary.
 *
 *   DEMO_OUT=pih-hh-survey DEMO_MS=0 ./node_modules/.bin/playwright test -c playwright.demo.config.ts tests/t9-demos/hh_survey.demo.spec.ts
 *
 * The project it builds in is kept at client/demo/pih-hh-survey/project so
 * the deploy video can start from exactly this state.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { test, expect, say, API, DEMO_DIR, hclick, htype, hselect } from './demo-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(here, '..', '..', '..', 'server', 'templates', 'cht-default');
const PROJECT = path.join(DEMO_DIR, 'project');
const FORM = 'hh_survey';
const CAPTION_MS = 2000;

/* ------------------------------ content ------------------------------ */

type Choice = { name: string; label: string };
type List = { name: string; choices: Choice[] };
type Rel =
  | { field: string; op: 'equals'; value: string }
  | { field: string; op: 'is not'; values: string[] }
  | { field: string; op: 'at least'; value: string };
type Row = {
  name: string;
  label: string;
  tile: 'Select one' | 'Select many' | 'Number' | 'Text' | 'Note';
  list?: List;
  reuse?: string;
  required?: boolean;
  multiline?: boolean;
  rel?: Rel;
  /** "A choice must be chosen alone" on a select-many. */
  alone?: string;
};
type Section = { title: string; slug: string; rows: Row[] };

const C = (name: string, label: string): Choice => ({ name, label });
const YES_NO: List = { name: 'yes_no', choices: [C('yes', 'Yes'), C('no', 'No')] };
const AGREEMENT: List = {
  name: 'agreement',
  choices: [
    C('strongly_agree', 'Strongly agree'), C('agree', 'Agree'), C('neutral', 'Neutral'),
    C('disagree', 'Disagree'), C('strongly_disagree', 'Strongly disagree'), C('dont_know', "Don't know"),
  ],
};

const SECTIONS: Section[] = [
  {
    title: 'Introduction', slug: 'introduction',
    rows: [
      {
        name: 'intro_note', tile: 'Note',
        label: 'This is a household survey that will be happening once or twice a year and the target is to reach all households in your catchment area. It is important that you collect all information correctly. You are expected to reach ALL your assigned households. Please interview the household head (father or mother). If not available, interview a household member who is 18 years and above who can provide the required information. If there is no one, make plans to revisit the house. Please ensure that GPS is enabled on your phone when you are starting the interview.',
      },
    ],
  },
  {
    title: 'Introduction to interviewee', slug: 'introduction_to_interviewee',
    rows: [
      {
        name: 'interviewee', tile: 'Select one', required: true, label: 'Who are you interviewing?',
        list: { name: 'interviewee', choices: [C('household_head', 'Household head'), C('household_member', 'Household member'), C('own_household', 'A member of my own household')] },
      },
      {
        name: 'consent_note', tile: 'Note',
        label: 'Explain to the person you are interviewing that for the next 10 minutes you will ask them a few questions about their household. The data is important because it helps the CHWs and leadership to improve the design and review of our programmes, so that we are able to improve care to all people in the district. When you finish the interview, please remember to thank the interviewee.',
      },
      {
        name: 'location', tile: 'Select one', required: true, label: 'Where are you currently?',
        list: { name: 'location', choices: [C('clients_household', "Client's household"), C('my_home', 'At my home'), C('elsewhere', 'Elsewhere')] },
      },
    ],
  },
  {
    title: 'Housing material', slug: 'housing_material',
    rows: [
      {
        name: 'floor_material', tile: 'Select one', required: true, label: 'What is the main material of the floor of your dwelling?',
        list: { name: 'floor_material', choices: [C('earth', 'Earth / sand'), C('cement', 'Cement'), C('dung', 'Dung'), C('other', 'Other floor material')] },
      },
      { name: 'floor_material_other', tile: 'Text', required: true, label: 'Specify other floor material', rel: { field: 'floor_material', op: 'equals', value: 'other' } },
      {
        name: 'roof_material', tile: 'Select one', label: 'What is the main material of the roof of your dwelling?',
        list: { name: 'roof_material', choices: [C('thatch', 'Thatch / palm leaf'), C('metal', 'Metal'), C('other', 'Other')] },
      },
      { name: 'roof_material_other', tile: 'Text', required: true, label: 'Specify other roof material', rel: { field: 'roof_material', op: 'equals', value: 'other' } },
    ],
  },
  {
    title: 'Household asset ownership', slug: 'household_asset_ownership',
    rows: [
      {
        name: 'assets', tile: 'Select many', required: true, alone: 'none',
        label: 'Does this household have any of the following items that are functioning? Tick every option that applies.',
        list: {
          name: 'assets',
          choices: [
            C('bicycle', 'Bicycle'), C('electricity', 'Electricity'), C('television', 'Television'), C('radio', 'Radio'),
            C('bed_mattress', 'Bed with mattress'), C('sofa', 'Sofa set'), C('refrigerator', 'Refrigerator'),
            C('mobile_phone', 'Mobile phone'), C('motorbike', 'Motorbike'), C('car', 'Car or truck'), C('none', 'None'),
          ],
        },
      },
    ],
  },
  {
    title: 'Bank account', slug: 'bank_account',
    rows: [{ name: 'bank_account', tile: 'Select one', required: true, label: 'Does any member of this household have a bank account?', list: YES_NO }],
  },
  {
    title: 'Fuel', slug: 'fuel',
    rows: [
      {
        name: 'cooking_fuel', tile: 'Select one', required: true, label: 'What type of fuel does your household mainly use for cooking?',
        list: { name: 'cooking_fuel', choices: [C('wood', 'Wood'), C('charcoal', 'Charcoal'), C('dung', 'Dung'), C('kerosene', 'Kerosene'), C('gas', 'Cooking gas'), C('other', 'Other')] },
      },
      { name: 'cooking_fuel_other', tile: 'Text', required: true, label: 'Specify other cooking fuel', rel: { field: 'cooking_fuel', op: 'equals', value: 'other' } },
    ],
  },
  {
    title: 'Water, sanitation and hygiene', slug: 'water_sanitation_and_hygiene',
    rows: [
      {
        name: 'water_source', tile: 'Select one', required: true, label: 'What is your main source of drinking water?',
        list: { name: 'water_source', choices: [C('piped', 'Piped water'), C('borehole', 'Tubewell or borehole'), C('dug_well', 'Dug well'), C('spring', 'Water from spring'), C('rainwater', 'Rainwater'), C('surface', 'Surface water'), C('bottled', 'Bottled'), C('other', 'Other')] },
      },
      { name: 'water_source_other', tile: 'Text', required: true, label: 'Specify other water source', rel: { field: 'water_source', op: 'equals', value: 'other' } },
      {
        name: 'water_walk_time', tile: 'Select one', required: true, label: 'How long does it take to walk to the drinking water source?',
        list: { name: 'walk_time', choices: [C('under_30', 'Less than 30 minutes'), C('between_30_60', 'Between 30 and 60 minutes'), C('over_60', 'More than 60 minutes')] },
      },
      {
        name: 'water_treatment', tile: 'Select one', required: true, label: "What is the primary method used to treat your household's drinking water?",
        list: { name: 'water_treatment', choices: [C('filtration', 'Filtration'), C('chemical', 'Chemical treatment'), C('boiling', 'Boiling'), C('sun', 'Heated in the sun'), C('none', 'Not treated'), C('other', 'Other (specify)')] },
      },
      { name: 'water_treatment_other', tile: 'Text', required: true, label: 'Specify other drinking water treatment', rel: { field: 'water_treatment', op: 'equals', value: 'other' } },
      {
        name: 'toilet', tile: 'Select one', required: true, label: 'What type of toilet facility is mainly used by the household members?',
        list: { name: 'toilet', choices: [C('flush', 'Flush toilet'), C('pit', 'Pit latrine'), C('composting', 'Composting toilet'), C('bucket', 'Bucket'), C('none', 'No facilities / bush / field'), C('other', 'Other')] },
      },
      { name: 'toilet_other', tile: 'Text', required: true, label: 'Specify other toilet facility', rel: { field: 'toilet', op: 'equals', value: 'other' } },
      { name: 'toilet_shared', tile: 'Select one', required: true, label: 'Is the toilet facility shared with other households?', reuse: 'yes_no', rel: { field: 'toilet', op: 'is not', values: ['bucket', 'none', 'other'] } },
      { name: 'handwashing', tile: 'Select one', required: true, label: 'Does this household have a hand washing facility?', reuse: 'yes_no' },
      { name: 'handwashing_soap', tile: 'Select one', required: true, label: 'Does the facility have soap?', reuse: 'yes_no', rel: { field: 'handwashing', op: 'equals', value: 'yes' } },
    ],
  },
  {
    title: 'Education level', slug: 'education_level',
    rows: [
      { name: 'schooling_5yrs', tile: 'Select one', required: true, label: 'Has anyone in this household completed five or more years of schooling?', reuse: 'yes_no' },
      { name: 'children_class8', tile: 'Select one', required: true, label: 'Have any children in this household attended school up to class 8?', reuse: 'yes_no' },
    ],
  },
  {
    title: 'General household health', slug: 'general_household_health',
    rows: [
      { name: 'covid_reported', tile: 'Select one', required: true, label: 'Have you ever reported any COVID related symptoms to the CHWs during the year?', reuse: 'yes_no' },
      {
        name: 'covid_comfort', tile: 'Select one', required: true, label: 'How comfortable would you be discussing your own COVID experience with your health care provider?',
        list: { name: 'comfort', choices: [C('very', 'Very comfortable'), C('somewhat', 'Somewhat comfortable'), C('not_very', 'Not very comfortable'), C('not_at_all', 'Not at all comfortable')] },
      },
      { name: 'malnourished', tile: 'Select one', required: true, label: 'Is anyone in the household malnourished?', reuse: 'yes_no' },
      { name: 'borrowed_for_medical', tile: 'Select one', required: true, label: 'During the last 12 months, did you or other members of your household have to borrow money or sell assets in order to pay for medical costs?', reuse: 'yes_no' },
      {
        name: 'clinic_transport', tile: 'Select one', required: true, label: 'The last time you went to the clinic, how did you travel?',
        list: { name: 'transport', choices: [C('foot', 'On foot'), C('bicycle', 'Bicycle'), C('motorbike', 'Motorbike'), C('vehicle', 'Vehicle'), C('public', 'Public transport'), C('other', 'Other')] },
      },
      { name: 'clinic_transport_other', tile: 'Text', required: true, label: 'Specify other means of transport to the health facility', rel: { field: 'clinic_transport', op: 'equals', value: 'other' } },
      {
        name: 'clinic_travel_time', tile: 'Select one', required: true, label: 'How long did it take you to reach the health facility?',
        list: { name: 'travel_time', choices: [C('under_30', 'Less than 30 minutes'), C('between_30_60', 'Between 30 minutes and 1 hour'), C('over_60', 'More than 1 hour')] },
      },
      { name: 'women_30_49', tile: 'Number', required: true, label: 'How many women in the household are aged 30-49 years?' },
      { name: 'women_screened_cervical', tile: 'Number', required: true, label: 'How many women (30-49 years) in this household have been screened for cervical cancer?', rel: { field: 'women_30_49', op: 'at least', value: '1' } },
      { name: 'hpv_vaccine', tile: 'Select one', required: true, label: 'Did any girl(s) in the household receive the HPV vaccine this year?', reuse: 'yes_no' },
      { name: 'fits', tile: 'Select one', required: true, label: 'Does anyone in the household sometimes have fits, become rigid, or lose consciousness?', reuse: 'yes_no' },
      { name: 'epilepsy_note', tile: 'Note', label: 'Message to CHW: refer to the facility for evaluation for epilepsy.', rel: { field: 'fits', op: 'equals', value: 'yes' } },
      {
        name: 'itn', tile: 'Select one', required: true, label: 'Do all the sleeping points in the household have an insecticide-treated net (ITN)?',
        list: { name: 'itn', choices: [C('all', 'All the sleeping points'), C('some', 'Some sleeping points'), C('none', 'None')] },
      },
      { name: 'sprayed', tile: 'Select one', required: true, label: 'Have you sprayed your household with insecticides within the last 12 months?', reuse: 'yes_no' },
      { name: 'agree_services', tile: 'Select one', required: true, label: 'I can get all the health services I need in Neno.', list: AGREEMENT },
      { name: 'agree_recommend', tile: 'Select one', required: true, label: 'Regarding the nearest health facility to me, I would recommend a friend attend this clinic if they are sick.', reuse: 'agreement' },
      { name: 'agree_confidence', tile: 'Select one', required: true, label: 'Over the past year, my confidence in my health provider has improved.', reuse: 'agreement' },
      { name: 'agree_services_improved', tile: 'Select one', required: true, label: 'Over the past year, the services such as tests and medications at my nearest health facility have improved.', reuse: 'agreement' },
    ],
  },
  {
    title: 'Economic survey', slug: 'economic_survey',
    rows: [
      { name: 'phone_access', tile: 'Select one', required: true, label: 'Does anyone in the household have a functioning mobile phone that is accessible for use by household members?', reuse: 'yes_no' },
      {
        name: 'phone_charge_where', tile: 'Select one', required: true, label: 'Where do you usually charge the phone?', rel: { field: 'phone_access', op: 'equals', value: 'yes' },
        list: { name: 'charge_where', choices: [C('home', 'Within the home'), C('outside', 'Outside the home')] },
      },
      {
        name: 'phone_charge_outside', tile: 'Select one', required: true, label: 'Specify where outside the home', rel: { field: 'phone_charge_where', op: 'equals', value: 'outside' },
        list: { name: 'charge_outside', choices: [C('solar', 'Paid for solar charging'), C('electricity', 'Paid for electricity charging'), C('vehicle_battery', 'Vehicle battery'), C('other', 'Other')] },
      },
      { name: 'phone_charge_other', tile: 'Text', required: true, label: 'Specify the other place', rel: { field: 'phone_charge_outside', op: 'equals', value: 'other' } },
      {
        name: 'wealth_rank', tile: 'Select one', required: true,
        label: 'Considering your household wealth, education, community influence and other aspects considered important in your community, what position would you rank your household relative to the community you live in?',
        list: { name: 'rank', choices: [C('higher', 'Higher'), C('same', 'Same'), C('lower', 'Lower')] },
      },
    ],
  },
  {
    title: 'Validation of responses', slug: 'validation_of_responses',
    rows: [
      { name: 'satisfied', tile: 'Select one', required: true, label: 'Are you satisfied with the responses given?', reuse: 'yes_no' },
      { name: 'comments', tile: 'Text', required: true, multiline: true, label: 'Comments', rel: { field: 'satisfied', op: 'equals', value: 'no' } },
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

function labelInput(scope: Locator, loc: string): Locator {
  return scope
    .locator('.qtype-labels-field .qtype-locale-label')
    .filter({ has: scope.page().getByText(`label::${loc}`, { exact: true }) })
    .locator('input');
}

/** The caption bar: plain words, same hold every time. */
async function tell(page: Page, text: string): Promise<void> {
  await say(page, text, CAPTION_MS);
}

async function addSection(page: Page, s: Section): Promise<Locator> {
  await hclick(page.getByRole('button', { name: '+ Section' }));
  const p = picker(page);
  await expect(p).toBeVisible();
  await htype(p.locator('input[placeholder="e.g. Danger signs"]'), s.title);
  await expect(p.locator('code', { hasText: s.slug })).toBeVisible();
  await hclick(p.getByRole('button', { name: 'Add section', exact: true }));
  await expect(p).not.toBeVisible();
  const accordion = page.locator('.survey-group-accordion').filter({
    has: page.locator('.survey-group-header code', { hasText: new RegExp(`^${s.slug}$`) }),
  });
  await expect(accordion).toHaveCount(1);
  return accordion;
}

async function addRow(page: Page, row: Row): Promise<Locator> {
  await hclick(page.getByRole('button', { name: '+ Question', exact: true }));
  const p = picker(page);
  await expect(p).toBeVisible();
  await htype(p.getByPlaceholder(/has_fever/), row.name);
  await htype(labelInput(p, 'en'), row.label);
  await hclick(
    p.locator('.qtype-tile').filter({ has: page.locator('.qtype-tile-label', { hasText: new RegExp(`^${row.tile}$`) }) }).first(),
  );
  if (row.list || row.reuse) {
    await expect(p.getByText(/needs a list of options/)).toBeVisible();
    if (row.reuse) {
      await hclick(
        p.locator('.qtype-list-choice label', { hasText: 'Reuse' })
          .filter({ has: page.locator('code', { hasText: new RegExp(`^${row.reuse}$`) }) })
          .locator('input'),
      );
    } else if (row.list) {
      await htype(p.getByPlaceholder('options'), row.list.name);
      const choiceRows = p.locator('.qtype-choice-row');
      while ((await choiceRows.count()) < row.list.choices.length) {
        await hclick(p.locator('.qtype-choices-edit').getByRole('button', { name: '+ Add choice' }));
      }
      for (let i = 0; i < row.list.choices.length; i++) {
        const c = row.list.choices[i]!;
        const inputs = choiceRows.nth(i).locator('input');
        await htype(inputs.nth(0), c.name);
        await htype(inputs.nth(1), c.label);
      }
    }
    await hclick(p.getByRole('button', { name: 'Add question', exact: true }));
  }
  await expect(p).not.toBeVisible();
  const r = await rowByName(page, row.name);
  await r.scrollIntoViewIfNeeded();
  return r;
}

async function showAdvanced(row: Locator): Promise<void> {
  const btn = row.getByRole('button', { name: /show advanced/ });
  if (await btn.isVisible().catch(() => false)) await hclick(btn);
}

/** "Show this question when <field> <condition> <value>", all picked; "is not" chains with "and also". */
async function setRelevance(row: Locator, rel: Rel): Promise<void> {
  await showAdvanced(row);
  const strip = row.locator('.cond-strip-unified[data-column="relevant"]');
  await strip.scrollIntoViewIfNeeded();
  const field = () => strip.locator('.ref-chip-select').nth(0);
  const op = () => strip.locator('.ref-chip-select').nth(1);
  const value = strip.locator(`select[title="Pick a value from this field's choices"]`);

  const pickOne = async (opValue: string, v: string) => {
    await hselect(field(), rel.field);
    await hselect(op(), opValue);
    if (opValue === '>=') await htype(strip.locator('input.cond-value-input'), v);
    else await hselect(value, v);
  };
  if (rel.op === 'at least') {
    await pickOne('>=', rel.value);
  } else if (rel.op === 'equals') {
    await pickOne('=', rel.value);
  } else {
    // Each "is not" is staged with "+ add another rule" (joined by "and also"); the last one is applied.
    for (const [i, v] of rel.values.entries()) {
      if (i > 0) await hclick(strip.getByRole('button', { name: '+ add another rule' }));
      await pickOne('!=', v);
    }
  }
  await hclick(strip.getByRole('button', { name: 'Apply', exact: true }));
  await expect(strip.locator('.cond-preview').first()).toBeVisible();
}

async function setRequired(row: Locator): Promise<void> {
  await hclick(row.locator('.required-label input'));
}

async function setMultiline(row: Locator): Promise<void> {
  await showAdvanced(row);
  await hclick(row.locator('button', { hasText: 'pick widgets' }).first());
  const modal = row.page().locator('.modal').filter({ hasText: /multiline/ }).last();
  await hclick(modal.getByRole('checkbox', { name: /^multiline/ }));
  await hclick(modal.getByRole('button', { name: 'Done' }));
}

async function setChoiceAlone(row: Locator, choice: string): Promise<void> {
  await showAdvanced(row);
  const panel = row.getByTestId('validation-panel');
  await panel.scrollIntoViewIfNeeded();
  await hselect(panel.getByRole('combobox', { name: 'Add a validation rule' }), { label: 'A choice must be chosen alone' });
  await hselect(panel.getByRole('combobox', { name: 'Choice' }), choice);
}

/* ------------------------------ the take ------------------------------ */

test('HH Survey — built with no code, with its properties', async ({ page, request }) => {
  test.setTimeout(3_600_000);

  // A fresh copy of the baseline project, kept for the deploy video.
  await fs.rm(PROJECT, { recursive: true, force: true });
  await fs.mkdir(DEMO_DIR, { recursive: true });
  await fs.cp(TEMPLATE, PROJECT, { recursive: true });
  expect((await request.post(`${API}/api/project/open`, { data: { path: PROJECT } })).ok()).toBeTruthy();

  await page.goto('/');
  await say(page, 'What you are watching: a programme officer builds the Household Survey from the PIH Malawi design workbook, in the browser, without writing any code. Every rule is chosen from menus.', 6000);
  await hclick(page.locator('.nav-item', { hasText: 'Forms' }));
  await tell(page, 'This project is the standard CHT starting kit: a district, health centres, households and people, with the usual forms already in place.');

  // Create the form.
  await hclick(page.getByRole('button', { name: '+ App form' }));
  const card = page.locator('.create-form');
  await tell(page, 'A new form. Type its name once; the file name is made for you.');
  await htype(card.locator('#new-form-title'), 'HH Survey');
  await expect(card.locator('code', { hasText: new RegExp(`^${FORM}$`) })).toBeVisible();
  await hclick(card.getByRole('button', { name: 'Create', exact: true }));
  await expect(card).toBeHidden();
  await expect(page.getByRole('button', { name: /^Survey/ }).first()).toBeVisible({ timeout: 15_000 });
  await hclick(page.getByRole('button', { name: 'Full', exact: true }));

  const total = SECTIONS.reduce((n, s) => n + s.rows.length, 0);
  let built = 0;
  for (const [si, section] of SECTIONS.entries()) {
    await tell(page, `Section ${si + 1} of ${SECTIONS.length}: ${section.title}. A section groups related questions on one screen.`);
    const accordion = await addSection(page, section);
    for (const [ri, row] of section.rows.entries()) {
      built++;
      const kind =
        row.tile === 'Note' ? 'an instruction the CHW reads'
        : row.tile === 'Select one' ? 'a single-choice question'
        : row.tile === 'Select many' ? 'a tick-all-that-apply question'
        : row.tile === 'Number' ? 'a number'
        : 'a free-text answer';
      await tell(page, `Question ${built} of ${total}: ${kind}.${row.reuse ? ' Its answer list already exists, so it is reused.' : row.list ? ' Its answer options are typed once.' : ''}`);
      const r = await addRow(page, row);
      if (ri === 0) {
        const header = accordion.locator('button.survey-group-header').first();
        if ((await header.getAttribute('aria-expanded')) === 'false') await hclick(header);
      }
      if (row.required) {
        await tell(page, 'Required: the CHW cannot submit without answering it.');
        await setRequired(r);
      }
      if (row.multiline) {
        await tell(page, 'A bigger answer box, chosen from the list of widgets.');
        await setMultiline(r);
      }
      if (row.alone) {
        await tell(page, '"None" cannot be ticked together with other items. That rule comes from a menu, with the error message suggested.');
        await setChoiceAlone(r, row.alone);
      }
      if (row.rel) {
        const why =
          row.rel.op === 'at least'
            ? `only when the number of women aged 30-49 is at least ${row.rel.value}`
            : row.rel.op === 'is not'
              ? `unless the toilet is a bucket, none, or other: three "is not" rules joined by "and also"`
              : `only when the previous answer is "${row.rel.value}"`;
        await tell(page, `This question appears ${why}. Picked from three menus; the builder writes the logic.`);
        await setRelevance(r, row.rel);
      }
      await hclick(r.getByRole('textbox', { name: 'name', exact: true }));
    }
  }

  /* Properties: what the CHW sees in the app, and where. */
  await tell(page, `All ${total} questions are in. Now the form's properties: its name in the app, its icon, and where it can be opened from.`);
  await hclick(page.getByRole('button', { name: 'Properties', exact: true }));
  const props = page.locator('.properties-editor');
  await expect(props).toBeVisible();
  await tell(page, 'Title: the name the CHW sees in the list of forms.');
  await htype(
    props.locator('label.row').filter({ has: page.locator('code.locale-tag', { hasText: /^en$/ }) }).locator('input'),
    'Household Survey',
  );
  await tell(page, 'Icon: the picture shown beside that name. The project already ships a household icon.');
  await htype(props.getByPlaceholder('icon-pregnancy'), 'icon-household');
  await tell(page, '"Available on people" and "Available on places" decide where the form can be opened from. This survey is about a household, so places only.');
  await hclick(page.getByLabel('Available on places'));
  await tell(page, 'And more precisely: only on a household, not on a health centre or a district. "+ contact type" picks the household type from the project.');
  const ctx = page.locator('.context-builder');
  await hclick(ctx.getByRole('button', { name: '+ contact type', exact: true }));
  await hselect(ctx.locator('.rule-row').last().locator('select').first(), 'clinic');
  await tell(page, 'The "task-only" box stays unticked: that is for forms that should open only from a reminder, never from the menu.');

  /* Save with the review step on screen. */
  await tell(page, 'Save. Before anything is written, the builder lists exactly what will change: this is the review step.');
  await hclick(page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }));
  await say(page, 'The review: one new form file, its properties, and nothing else in the project touched.', 4000);
  await hclick(page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }));
  await expect(page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true })).toBeVisible({ timeout: 20_000 });

  /* Preview. */
  await hclick(page.getByRole('button', { name: /^Survey/ }).first());
  await hclick(page.getByRole('button', { name: 'Show preview', exact: true }));
  await say(page, 'A rough preview of the shape of the form. The exact phone rendering is checked after deploying, in the next video.', 4000);

  /* Check what landed on disk. */
  const body = (await (await request.get(`${API}/api/forms/app:${FORM}`)).json()) as {
    form: { survey: Array<{ type: string; name?: string; required?: string; extras: Record<string, string> }>; choices: Array<{ list_name: string }> };
    properties?: { title?: Array<{ locale: string; content: string }>; icon?: string; context?: { place?: boolean; person?: boolean; expression?: string } };
  };
  const cell = (name: string, col: string) => body.form.survey.find((r) => r.name === name)?.extras[col];
  expect(cell('floor_material_other', 'relevant')).toBe("${floor_material} = 'other'");
  expect(cell('toilet_shared', 'relevant')).toBe("${toilet} != 'bucket' and ${toilet} != 'none' and ${toilet} != 'other'");
  expect(cell('women_screened_cervical', 'relevant')).toBe('${women_30_49} >= 1');
  expect(cell('epilepsy_note', 'relevant')).toBe("${fits} = 'yes'");
  expect(cell('assets', 'constraint')).toBe("not(selected(., 'none') and count-selected(.) > 1)");
  expect(cell('comments', 'appearance')).toBe('multiline');
  expect(body.form.survey.find((r) => r.name === 'interviewee')?.required).toBe('yes');
  expect(body.properties?.context?.place).toBe(true);
  expect(body.properties?.context?.expression ?? '').toContain('clinic');
  expect(body.properties?.icon).toBe('icon-household');
  const groups = body.form.survey.filter((r) => r.type.trim().toLowerCase() === 'begin group').length - 1; // minus the inputs group
  const lists = new Set(body.form.choices.map((c) => c.list_name)).size;
  const rules = body.form.survey.filter((r) => r.extras['relevant'] && r.name !== 'inputs').length;
  await say(page, `Done: ${groups} sections, ${total} questions, ${lists} answer lists, ${rules} show-only-when rules, 1 "none alone" rule, no code typed. The file is standard and deploys with the usual CHT tooling.`, 7000);
});
