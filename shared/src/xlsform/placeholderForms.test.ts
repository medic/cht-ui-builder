/**
 * Pins `isPlaceholderFormFile` against every real form basename shape we
 * have, because a false positive here would silently hide a customer's own
 * contact fields from the pickers — a worse failure than the pollution it
 * exists to stop.
 *
 * The negative list below is taken from the actual basenames across the four
 * real configs and the templates we ship.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isPlaceholderFormFile } from './placeholderForms.js';

test('the cht-conf place-type templates are recognised, in every spelling', () => {
  for (const f of [
    'PLACE_TYPE-create.xlsx',
    'PLACE_TYPE-edit.xlsx',
    'PLACE_TYPE-create',
    'forms/contact/PLACE_TYPE-create.xlsx',
    'W:\\medic\\config-gandaki\\cht-config\\forms\\contact\\PLACE_TYPE-edit.xlsx',
    'PLACE_TYPE-create.properties.json',
    'PLACE_TYPE-create.xml',
  ]) {
    assert.equal(isPlaceholderFormFile(f), true, f);
  }
});

test('a hypothetical future CONTACT_TYPE template is handled without a new case', () => {
  // The point of matching the SHAPE rather than the one literal.
  assert.equal(isPlaceholderFormFile('CONTACT_TYPE-create.xlsx'), true);
  assert.equal(isPlaceholderFormFile('PERSON_TYPE-edit.xlsx'), true);
});

test('every real form basename we have is NOT a placeholder', () => {
  // Verbatim from the four real configs plus our templates. Measured: these
  // are all lowercase snake_case, and the only uppercase basenames anywhere
  // across seven project roots are the two PLACE_TYPE ones above.
  const real = [
    // contact forms
    'person-create',
    'person-edit',
    'clinic-create',
    'clinic-edit',
    'district_hospital-create',
    'district_hospital-edit',
    'health_center-create',
    'health_center-edit',
    'c10_center-create',
    'c20_province-create',
    'c30_district-create',
    'c40_municipality-create',
    'c82_person-create',
    'c82_person-edit',
    'p10_district-create',
    'p20_municipality-edit',
    // app forms
    'pregnancy',
    'pregnancy_home_visit',
    'pregnancy_danger_sign_follow_up',
    'delivery',
    'pnc_danger_sign_follow_up_baby',
    'undo_death_report',
    'replace_user',
    'diabetes_referral',
    'hypertension_screening',
    'become_closure_form',
    'breast_cancer_followup',
    'cervical_cancer_referral_follow_up_visit',
    'integrated_health_assessment_form_for_elder_population',
  ];
  for (const b of real) {
    assert.equal(isPlaceholderFormFile(`${b}.xlsx`), false, b);
    assert.equal(isPlaceholderFormFile(b), false, b);
  }
});

test('a short uppercase run does not make a form a template', () => {
  // Four characters is the floor precisely so these stay real forms.
  assert.equal(isPlaceholderFormFile('anc-A1.xlsx'), false);
  assert.equal(isPlaceholderFormFile('form-ANC.xlsx'), false);
  assert.equal(isPlaceholderFormFile('TB-screening.xlsx'), false);
});

test('an all-caps token embedded mid-name still counts', () => {
  assert.equal(isPlaceholderFormFile('prefix-PLACE_TYPE-create.xlsx'), true);
});

test('empty and odd input does not throw', () => {
  assert.equal(isPlaceholderFormFile(''), false);
  assert.equal(isPlaceholderFormFile('.xlsx'), false);
  assert.equal(isPlaceholderFormFile('forms/contact/'), false);
});
