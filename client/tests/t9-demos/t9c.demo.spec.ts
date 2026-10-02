/**
 * Demo for T9c (#16) — the shared searchable field picker: labels and
 * names, grouped by section, technical rows behind a toggle, choice
 * labels in the value picker; the written cell keeps the names.
 */
import {
  test,
  expect,
  say,
  beat,
  openPregnancy,
  rowByType,
  openStrip,
  rawColumnInput,
} from './demo-helpers.js';

test('T9c — one searchable field picker everywhere', async ({ page }) => {
  await openPregnancy(page);
  await say(page, 'T9c (#16) — a searchable field picker with labels, shared by every builder', 2500);

  const gravidity = rowByType(page, /^integer$/);
  const strip = await openStrip(gravidity, 'relevant');
  const search = strip.getByLabel('Search fields');
  const fieldSelect = strip.locator('.ref-chip-select').nth(0);

  await say(page, 'Fields read "Label (name)" and are grouped by section; type to narrow');
  await fieldSelect.focus();
  await beat(page, 1500);
  await search.fill('lmp');
  await say(page, 'Typing "lmp" matches by name…');
  await expect(fieldSelect).toHaveAttribute('size', /\d+/);
  await beat(page, 1200);
  await search.fill('menstrual');
  await say(page, '…and "menstrual" matches by label — the same field either way');
  await beat(page, 1500);

  await strip.getByRole('checkbox', { name: 'show technical rows' }).check();
  await search.fill('lmp');
  await say(page, 'Notes, hidden rows and r_*/__* helpers stay out of the way until "show technical rows" is on');
  await beat(page, 1800);
  await strip.getByRole('checkbox', { name: 'show technical rows' }).uncheck();
  await beat(page, 800);
  await fieldSelect.selectOption('lmp_date');
  await expect(fieldSelect).toHaveValue('lmp_date');

  await say(page, 'A select question: the value picker shows the choice LABELS');
  await fieldSelect.selectOption('danger_signs');
  await strip.locator('.ref-chip-select').nth(1).selectOption('selected');
  const valueSelect = strip.locator('select[title="Pick a value from this field\'s choices"]');
  await valueSelect.focus();
  await beat(page, 1500);
  await valueSelect.selectOption('vaginal_bleeding');
  await beat(page, 800);
  await strip.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(strip.locator('.cond-preview').first()).toHaveText('Danger signs includes Vaginal bleeding');
  await say(page, 'Readback uses the labels: "Danger signs includes Vaginal bleeding"');
  await beat(page, 1200);
  await strip.getByRole('button', { name: 'code', exact: true }).click();
  await expect(rawColumnInput(gravidity, 'relevant')).toHaveValue("selected(${danger_signs}, 'vaginal_bleeding')");
  await say(page, "The cell keeps the NAMES: selected(${danger_signs}, 'vaginal_bleeding') — unchanged from the previous builder", 2500);

  await say(page, 'Comparing against another question: the value side offers the same picker');
  await strip.getByRole('button', { name: '↶ undo last clause' }).click();
  await fieldSelect.selectOption('lmp_date');
  await strip.locator('.ref-chip-select').nth(1).selectOption('=');
  await strip.getByRole('button', { name: 'another question' }).click();
  const valuePicker = strip.locator('select[title="Compare against another question\'s answer"]');
  await strip.getByLabel('Search fields').nth(1).fill('patient');
  await beat(page, 1200);
  await valuePicker.selectOption('patient_id');
  await expect(valuePicker).not.toHaveAttribute('size', /\d+/);
  await strip.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(rawColumnInput(gravidity, 'relevant')).toHaveValue('${lmp_date} = ${patient_id}');
  await say(page, 'Written as ${lmp_date} = ${patient_id} — no `${…}` typed by hand', 2500);

  await say(page, 'The advanced "✎ build" modal uses the same picker');
  const relevantField = gravidity
    .locator('label.expr-field')
    .filter({ has: page.locator('code.raw-col-tag', { hasText: /^relevant$/ }) });
  await relevantField.locator('button', { hasText: '✎ build' }).click();
  const modal = page.locator('.rule-builder-modal');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: '+ comparison' }).click();
  const ruleRow = modal.locator('.rule-row').last();
  await ruleRow.getByLabel('Search fields').fill('menstrual');
  await beat(page, 1200);
  await ruleRow.locator('select.field-picker-select').selectOption('lmp_date');
  await beat(page, 1500);
  await modal.getByRole('button', { name: 'cancel' }).last().click();
  await say(page, 'Same search, same labels, same grouping — in the strip, the modal and the value cell', 3000);
});
