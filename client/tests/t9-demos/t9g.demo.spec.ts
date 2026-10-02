/**
 * Demo for T9g (#20) — one journey drives all four builders (relevant,
 * constraint, choice_filter, calculation) and every emitted cell is read
 * back from disk. The live-instance half of #20 is
 * `tests/live-instance-check.spec.ts`; run it under this demo config when
 * the local CHT instance is up to record it too.
 */
import {
  test,
  expect,
  say,
  beat,
  openPregnancy,
  rowByType,
  rowByName,
  openStrip,
  openPanel,
  showAdvanced,
  rawColumnInput,
  saveForm,
  getForm,
} from './demo-helpers.js';

test('T9g — all four builders in one journey', async ({ page, request }) => {
  await openPregnancy(page);
  await say(page, 'T9g (#20) — one journey through all four builders: relevant, constraint, choice filter, calculation', 3000);

  // 1. relevant
  const gravidity = rowByType(page, /^integer$/);
  const strip = await openStrip(gravidity, 'relevant');
  await say(page, '1/4 relevant — gravidity shows when Chair rise includes "Pass"');
  await strip.locator('.ref-chip-select').nth(0).selectOption('chair_rise');
  await strip.locator('.ref-chip-select').nth(1).selectOption('selected');
  await strip.locator('select[title="Pick a value from this field\'s choices"]').selectOption('pass');
  await beat(page, 800);
  await strip.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(strip.locator('.cond-preview').first()).toHaveText('Chair rise test includes Pass');
  await beat(page, 1500);

  // 2. constraint
  const panel = await openPanel(gravidity);
  await say(page, '2/4 constraint — the Validation panel: Between 0 and 20, message suggested');
  await panel.getByRole('combobox', { name: 'Add a validation rule' }).selectOption({ label: 'Between two values' });
  await panel.getByRole('spinbutton', { name: 'Minimum' }).fill('0');
  await panel.getByRole('spinbutton', { name: 'Maximum' }).fill('20');
  await expect(panel.getByPlaceholder('Message shown when the answer is rejected')).toHaveValue('Must be between 0 and 20');
  await beat(page, 1800);

  // 3. choice_filter
  const chair = rowByType(page, /^select_one pass_fail$/);
  const cStrip = await openStrip(chair, 'choice_filter');
  await say(page, '3/4 choice filter — on Chair rise: filter its choices when Danger signs includes "Vaginal bleeding"');
  await cStrip.locator('.ref-chip-select').nth(0).selectOption('danger_signs');
  await cStrip.locator('.ref-chip-select').nth(1).selectOption('selected');
  await cStrip.locator('select[title="Pick a value from this field\'s choices"]').selectOption('vaginal_bleeding');
  await beat(page, 800);
  await cStrip.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(cStrip.locator('.cond-preview').first()).toHaveText('Danger signs includes Vaginal bleeding');
  await beat(page, 1500);

  // 4. calculation
  await say(page, '4/4 calculation — a new calculate row, gravidity_next = ${gravidity} + 1');
  await page.getByRole('button', { name: '+ Question', exact: true }).click();
  const picker = page.locator('.qtype-modal');
  await picker.getByPlaceholder(/has_fever/).fill('gravidity_next');
  await picker
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Calculate$/ }) })
    .click();
  await expect(picker).not.toBeVisible();
  const calcRow = await rowByName(page, 'gravidity_next');
  await showAdvanced(calcRow);
  const calcField = calcRow
    .locator('label.expr-field')
    .filter({ has: page.locator('code.raw-col-tag', { hasText: /^calculation$/ }) });
  await calcField.scrollIntoViewIfNeeded();
  await calcField.locator('button', { hasText: '✎ build' }).click();
  const calcModal = page.getByRole('dialog', { name: 'Calculation builder' });
  await expect(calcModal).toBeVisible();
  await beat(page, 1200);
  await calcModal.getByRole('tab', { name: 'Raw', exact: true }).click();
  await calcModal.locator('textarea').fill('${gravidity} + 1');
  await beat(page, 800);
  await calcModal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rawColumnInput(calcRow, 'calculation')).toHaveValue('${gravidity} + 1');
  await beat(page, 1200);

  await say(page, 'Save and read every cell back from the sheet on disk…');
  await saveForm(page);
  const after = await getForm(request);
  const row = (name: string) => after.form.survey.find((r) => r.name === name)!;
  expect(row('gravidity').extras['relevant']).toBe("selected(${chair_rise}, 'pass')");
  expect(row('gravidity').extras['constraint']).toBe('. >= 0 and . <= 20');
  expect(row('gravidity').extras['constraint_message::en']).toBe('Must be between 0 and 20');
  expect(row('chair_rise').extras['choice_filter']).toBe("selected(${danger_signs}, 'vaginal_bleeding')");
  expect(row('gravidity_next').extras['calculation']).toBe('${gravidity} + 1');
  await say(
    page,
    "On disk — relevant: selected(${chair_rise}, 'pass')  ·  constraint: . >= 0 and . <= 20 (+ message)  ·  choice_filter: selected(${danger_signs}, 'vaginal_bleeding')  ·  calculation: ${gravidity} + 1",
    6000,
  );
});
