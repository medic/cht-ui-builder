/**
 * Demo for T9e (#18) — the Validation panel: presets per question type,
 * messages beside the rule, required beside it too; rules shown as presets
 * are saved exactly as written unless edited.
 */
import {
  test,
  expect,
  say,
  beat,
  openPregnancy,
  rowByType,
  rowByName,
  openPanel,
  saveForm,
  seedCells,
  cellOnDisk,
} from './demo-helpers.js';

test('T9e — validation presets per question type, messages beside the rule', async ({
  page,
  request,
}) => {
  await seedCells(request, {
    gravidity: { constraint: '. <= 100 and . >= 70', 'constraint_message::en': 'Between 70 and 100' },
  });
  await openPregnancy(page);
  await say(page, 'T9e (#18) — a Validation panel: presets per question type, with the message right beside the rule', 3000);

  const gravPanel = await openPanel(rowByType(page, /^integer$/));
  await say(page, 'Gravidity was seeded with ". <= 100 and . >= 70" (max first) — shown as Between 70 and 100');
  await expect(gravPanel.getByRole('spinbutton', { name: 'Minimum' })).toHaveValue('70');
  await expect(gravPanel.getByRole('spinbutton', { name: 'Maximum' })).toHaveValue('100');
  await beat(page, 1500);
  await gravPanel.getByRole('checkbox', { name: /^Required/ }).check();
  await gravPanel.getByPlaceholder('Message shown when the answer is missing (optional)').fill('Please enter a number');
  await say(page, 'Required and its message live here too, beside the rule');
  await beat(page, 1500);

  const lmpPanel = await openPanel(rowByType(page, /^date$/));
  await say(page, 'A date question offers date presets: "Not in the future"');
  await lmpPanel.getByRole('combobox', { name: 'Add a validation rule' }).focus();
  await beat(page, 1200);
  await lmpPanel.getByRole('combobox', { name: 'Add a validation rule' }).selectOption({ label: 'Not in the future' });
  await expect(lmpPanel.getByPlaceholder('Message shown when the answer is rejected')).toHaveValue('Cannot be in the future');
  await say(page, 'The message is suggested from the preset; the author can edit it');
  await beat(page, 1500);

  const dsPanel = await openPanel(rowByType(page, /^select_multiple danger_signs$/));
  await say(page, 'A select-many question: "A choice must be chosen alone", with the choice picked by label');
  await dsPanel.getByRole('combobox', { name: 'Add a validation rule' }).selectOption({ label: 'A choice must be chosen alone' });
  await dsPanel.getByRole('combobox', { name: 'Choice' }).selectOption('vaginal_bleeding');
  await beat(page, 1800);

  await say(page, 'A text question: "At most N characters"');
  await page.getByRole('button', { name: '+ Question', exact: true }).click();
  const picker = page.locator('.qtype-modal');
  await picker.getByPlaceholder(/has_fever/).fill('notes');
  await picker
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Text$/ }) })
    .click();
  await expect(picker).not.toBeVisible();
  const notesPanel = await openPanel(await rowByName(page, 'notes'));
  await notesPanel.getByRole('combobox', { name: 'Add a validation rule' }).selectOption({ label: 'At most N characters' });
  await notesPanel.getByRole('spinbutton', { name: 'Characters' }).fill('100');
  await beat(page, 1500);

  await say(page, 'Save…');
  await saveForm(page);
  const grav = await cellOnDisk(request, 'gravidity', 'constraint');
  const lmp = await cellOnDisk(request, 'lmp_date', 'constraint');
  const ds = await cellOnDisk(request, 'danger_signs', 'constraint');
  const notes = await cellOnDisk(request, 'notes', 'constraint');
  expect(grav).toBe('. <= 100 and . >= 70');
  expect(lmp).toBe('. <= today()');
  expect(ds).toBe("not(selected(., 'vaginal_bleeding') and count-selected(.) > 1)");
  expect(notes).toBe('string-length(.) <= 100');
  await say(page, `…on disk:  lmp_date: ${lmp}   ·   danger_signs: ${ds}   ·   notes: ${notes}`, 4000);
  await say(page, `…and gravidity, displayed as a preset but never edited, is still exactly "${grav}" — never normalised`, 3500);

  await say(page, 'Editing the maximum rewrites that one rule canonically (min first)');
  const gravPanel2 = await openPanel(rowByType(page, /^integer$/));
  await gravPanel2.getByRole('spinbutton', { name: 'Maximum' }).fill('99');
  await beat(page, 1000);
  await saveForm(page);
  const grav2 = await cellOnDisk(request, 'gravidity', 'constraint');
  expect(grav2).toBe('. >= 70 and . <= 99');
  await say(page, `On disk now: gravidity constraint = "${grav2}"`, 3000);
});
