/**
 * Demo for T9a (#14) — rules about the answer itself (`.`) and relative
 * paths (`../field`) open structurally, and survive open-and-save byte-
 * identical, including the tight-spaced `.<=100`.
 */
import {
  test,
  expect,
  say,
  beat,
  openPregnancy,
  rowByType,
  openStrip,
  openPanel,
  rawColumnInput,
  saveForm,
  seedCells,
  cellOnDisk,
} from './demo-helpers.js';

const SEED: Record<string, Record<string, string>> = {
  gravidity: { constraint: '. >= 0 and . <= 20', 'constraint_message::en': 'Must be 0 to 20' },
  chair_rise: { constraint: '.<=100' },
  danger_signs: { constraint: "not(selected(., 'none') and count-selected(.) > 1)" },
  lmp_note: { relevant: "../lmp_date != ''" },
  lmp_date: { constraint: '. <= today()', relevant: "selected(../danger_signs, 'none')" },
};

test('T9a — `.` and `../field` rules open structurally and save back byte-identical', async ({
  page,
  request,
}) => {
  await seedCells(request, SEED);
  await openPregnancy(page);
  await say(page, 'T9a (#14) — rules written as ". >= 0 and . <= 20", ".<=100", "../lmp_date != \'\'" were seeded into the sheet by hand', 3000);

  const gravidity = rowByType(page, /^integer$/);
  const gravPanel = await openPanel(gravidity);
  await say(page, 'Gravidity constraint ". >= 0 and . <= 20" opens as "Between 0 and 20" — not as raw text');
  await expect(gravPanel.getByRole('spinbutton', { name: 'Minimum' })).toHaveValue('0');
  await expect(gravPanel.getByRole('spinbutton', { name: 'Maximum' })).toHaveValue('20');
  await beat(page, 1500);

  const chair = rowByType(page, /^select_one pass_fail$/);
  const chairPanel = await openPanel(chair);
  await say(page, 'Chair rise constraint ".<=100" (no spaces) opens as a single bound: at most 100');
  await expect(chairPanel.getByRole('combobox', { name: 'Comparison' })).toHaveValue('<=');
  await expect(chairPanel.getByRole('textbox', { name: 'Value' })).toHaveValue('100');
  await beat(page, 1500);

  const lmpDate = rowByType(page, /^date$/);
  const lmpPanel = await openPanel(lmpDate);
  await say(page, 'LMP date: ". <= today()" opens as "Relative to today: on or before"');
  await expect(lmpPanel.getByRole('combobox', { name: 'Relative to today' })).toHaveValue('<=');
  await beat(page, 1500);
  const lmpStrip = lmpDate.locator('.cond-strip-unified[data-column="relevant"]');
  await lmpStrip.scrollIntoViewIfNeeded();
  await say(page, 'Its relevant "selected(../danger_signs, \'none\')" opens as a clause — ../ is read as an alias of ${}');
  await expect(lmpStrip.getByRole('button', { name: '↶ undo last clause' })).toBeVisible();
  await beat(page, 1500);

  const note = rowByType(page, /^note$/);
  const strip = await openStrip(note, 'relevant');
  await say(page, 'LMP note: "../lmp_date != \'\'" opens as "Last menstrual period has an answer"');
  await expect(strip.getByRole('button', { name: '↶ undo last clause' })).toBeVisible();
  await beat(page, 1200);
  await strip.getByRole('button', { name: 'Apply', exact: true }).click();
  await strip.getByRole('button', { name: 'code', exact: true }).click();
  await expect(rawColumnInput(note, 'relevant')).toHaveValue("../lmp_date != ''");
  await say(page, 'Re-applying with zero edits keeps the ../ spelling — the builder never rewrites to ${lmp_date}', 2500);

  // Dirty the form elsewhere so Save is reachable.
  await say(page, 'Add an unrelated group, then save the form…');
  await page.getByRole('button', { name: '+ Question', exact: true }).click();
  const picker = page.locator('.qtype-modal');
  await picker.getByPlaceholder(/has_fever/).fill('t9a_marker');
  await picker
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Group$/ }) })
    .click();
  await expect(picker).not.toBeVisible();
  await saveForm(page);

  const lines: string[] = [];
  for (const [name, cells] of Object.entries(SEED)) {
    for (const [col, val] of Object.entries(cells)) {
      expect(await cellOnDisk(request, name, col), `${name}.${col}`).toBe(val);
      if (col !== 'constraint_message::en') lines.push(`${name}.${col} = ${val}`);
    }
  }
  await say(page, `…every seeded cell is byte-identical on disk after the save:  ${lines.join('   ·   ')}`, 5000);
});
