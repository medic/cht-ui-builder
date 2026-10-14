/**
 * Demo for T9f (#19) — the sentence-shaped logic editor: one lead-in per
 * column, plain-English readback, the XPath only behind "code", the
 * advanced panel in Logic / Display / Messages / Raw.
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
  seedCells,
  cellOnDisk,
} from './demo-helpers.js';

test('T9f — logic as sentences; XPath on request', async ({ page, request }) => {
  await seedCells(request, { lmp_note: { relevant: "../lmp_date != ''" } });
  await openPregnancy(page);
  await say(page, 'T9f (#19) — logic reads as sentences; the XPath is there when you ask for it', 2500);

  const gravidity = rowByType(page, /^integer$/);
  await gravidity.getByRole('button', { name: /show advanced/ }).click();
  await say(page, 'The advanced panel is grouped: Logic, Display, Messages, Raw');
  await expect(gravidity.locator('h4.advanced-section', { hasText: 'Logic' })).toBeVisible();
  await beat(page, 1800);

  const strip = gravidity.locator('.cond-strip-unified[data-column="relevant"]');
  await strip.scrollIntoViewIfNeeded();
  await say(page, 'Each logic column is one sentence: "Show this question when …" — pick a field and a condition');
  await expect(strip.locator('.cond-lead')).toContainText('Show this question when');
  await beat(page, 1200);
  await strip.locator('.ref-chip-select').nth(0).selectOption('lmp_date');
  await strip.locator('.ref-chip-select').nth(1).selectOption('ref');
  await beat(page, 800);
  await strip.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(strip.locator('.cond-preview').first()).toHaveText('Last menstrual period has an answer');
  await say(page, 'Readback: "This row shows when: Last menstrual period has an answer" — no XPath on screen');
  await expect(rawColumnInput(gravidity, 'relevant')).toBeHidden();
  await beat(page, 1800);

  await strip.getByRole('button', { name: 'code', exact: true }).click();
  await expect(rawColumnInput(gravidity, 'relevant')).toBeVisible();
  await expect(rawColumnInput(gravidity, 'relevant')).toHaveValue('${lmp_date}');
  await say(page, '"code" reveals the XPath — ${lmp_date} — editable, with the advanced "✎ build" beside it');
  await beat(page, 1800);
  await strip.getByRole('button', { name: 'hide code', exact: true }).click();
  await beat(page, 600);

  await say(page, 'A plain Number question does not show "Compute the value as…" — it is one click away if wanted');
  await expect(gravidity.getByRole('button', { name: '+ compute this value…' })).toBeVisible();
  await beat(page, 1500);

  await gravidity.getByRole('button', { name: /hide advanced/ }).click();
  await say(page, 'Collapsed, the row summarises its logic in words: "shows when Last menstrual period has an answer"');
  await expect(gravidity).toContainText('shows when Last menstrual period has an answer');
  await beat(page, 2200);

  const chair = rowByType(page, /^select_one pass_fail$/);
  const cStrip = await openStrip(chair, 'choice_filter');
  await say(page, 'A select question also gets "Filter the choice list when …"');
  await expect(cStrip.locator('.cond-lead')).toContainText('Filter the choice list when');
  await cStrip.locator('.ref-chip-select').nth(0).selectOption('danger_signs');
  await cStrip.locator('.ref-chip-select').nth(1).selectOption('selected');
  await cStrip.locator('select[title="Pick a value from this field\'s choices"]').selectOption('vaginal_bleeding');
  await cStrip.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(cStrip.locator('.cond-preview').first()).toHaveText('Danger signs includes Vaginal bleeding');
  await beat(page, 1800);

  const note = rowByType(page, /^note$/);
  const nStrip = await openStrip(note, 'relevant');
  await say(page, 'A relevant written by hand as "../lmp_date != \'\'" reads as the same sentence…');
  await expect(nStrip.locator('.cond-preview').first()).toHaveText('Last menstrual period has an answer');
  await beat(page, 1500);
  await nStrip.getByRole('button', { name: 'Apply', exact: true }).click();
  await nStrip.getByRole('button', { name: 'code', exact: true }).click();
  await expect(rawColumnInput(note, 'relevant')).toHaveValue("../lmp_date != ''");
  await say(page, '…and re-applying keeps its spelling: ../lmp_date != \'\' — the bytes are the author\'s', 2500);

  await saveForm(page);
  expect(await cellOnDisk(request, 'gravidity', 'relevant')).toBe('${lmp_date}');
  expect(await cellOnDisk(request, 'chair_rise', 'choice_filter')).toBe("selected(${danger_signs}, 'vaginal_bleeding')");
  expect(await cellOnDisk(request, 'lmp_note', 'relevant')).toBe("../lmp_date != ''");
  await say(page, "On disk: gravidity ${lmp_date} · chair_rise selected(${danger_signs}, 'vaginal_bleeding') · lmp_note ../lmp_date != ''", 4000);
});
