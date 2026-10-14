/**
 * Demo for T9b (#15) — "has an answer" / "is not selected" rules written by
 * the inline builder reopen in the inline builder; `${f} != ''` opens as a
 * clause and is saved back exactly as spelled.
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
  saveForm,
  cellOnDisk,
} from './demo-helpers.js';

test('T9b — rules the builder writes reopen in the builder', async ({ page, request }) => {
  await openPregnancy(page);
  await say(page, 'T9b (#15) — rules the builder writes must reopen in the builder, not as hand-written text', 2500);

  // gravidity: "Last menstrual period has an answer".
  const gravidity = rowByType(page, /^integer$/);
  let strip = await openStrip(gravidity, 'relevant');
  await say(page, 'Gravidity: show it when "Last menstrual period" has an answer — picked, not typed');
  await strip.locator('.ref-chip-select').nth(0).selectOption('lmp_date');
  await strip.locator('.ref-chip-select').nth(1).selectOption('ref');
  await beat(page);
  await strip.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(strip.getByRole('button', { name: '↶ undo last clause' })).toBeVisible();
  await say(page, 'The rule reads back as a sentence; the XPath it wrote is ${lmp_date}');
  await strip.getByRole('button', { name: 'code', exact: true }).click();
  await expect(rawColumnInput(gravidity, 'relevant')).toHaveValue('${lmp_date}');
  await beat(page, 1500);

  // chair_rise: "Danger signs is not selected".
  const chair = rowByType(page, /^select_one pass_fail$/);
  strip = await openStrip(chair, 'relevant');
  await say(page, 'Chair rise: show it when "Danger signs" is not selected → not(${danger_signs})');
  await strip.locator('.ref-chip-select').nth(0).selectOption('danger_signs');
  await strip.locator('.ref-chip-select').nth(1).selectOption('not');
  await beat(page);
  await strip.getByRole('button', { name: 'Apply', exact: true }).click();
  await strip.getByRole('button', { name: 'code', exact: true }).click();
  await expect(rawColumnInput(chair, 'relevant')).toHaveValue('not(${danger_signs})');
  await beat(page, 1500);

  // lmp_note: the fixture's `${lmp_date} != ''` opens as a clause.
  const note = rowByType(page, /^note$/);
  strip = await openStrip(note, 'relevant');
  await say(page, "The fixture's hand-typed ${lmp_date} != '' also opens as a clause…");
  await expect(strip.getByRole('button', { name: '↶ undo last clause' })).toBeVisible();
  await beat(page);
  await strip.getByRole('button', { name: 'Apply', exact: true }).click();
  await strip.getByRole('button', { name: 'code', exact: true }).click();
  await expect(rawColumnInput(note, 'relevant')).toHaveValue("${lmp_date} != ''");
  await say(page, "…and re-applying with zero edits writes it back as spelled: ${lmp_date} != '' (never normalised)", 2500);

  await say(page, 'Save, reload, and reopen each row');
  await saveForm(page);
  expect(await cellOnDisk(request, 'gravidity', 'relevant')).toBe('${lmp_date}');
  expect(await cellOnDisk(request, 'chair_rise', 'relevant')).toBe('not(${danger_signs})');
  expect(await cellOnDisk(request, 'lmp_note', 'relevant')).toBe("${lmp_date} != ''");

  await openPregnancy(page);
  for (const [type, label] of [
    [/^integer$/, 'Gravidity'],
    [/^select_one pass_fail$/, 'Chair rise'],
    [/^note$/, 'LMP note'],
  ] as const) {
    const s = await openStrip(rowByType(page, type), 'relevant');
    await expect(s.getByText(/This rule was hand-written/)).toHaveCount(0);
    await expect(s.getByRole('button', { name: '↶ undo last clause' })).toBeVisible();
    await say(page, `${label}: reopened after reload as a clause — controls enabled, no "hand-written" notice`, 1800);
  }
  await say(page, 'On disk: ${lmp_date} · not(${danger_signs}) · ${lmp_date} != \'\' — exactly what the builder has always written', 3000);
});
