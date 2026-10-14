/**
 * Demo for T9d (#17) — the add-question configure step: required, hint
 * and a validation rule in one go; the row lands right after the current
 * row, scrolled into view and highlighted.
 */
import {
  test,
  expect,
  say,
  beat,
  openPregnancy,
  rowByType,
  rowByName,
  saveForm,
  getForm,
  setOneClickTiles,
} from './demo-helpers.js';

test('T9d — add a question with its details in one step, right where you are', async ({
  page,
  request,
}) => {
  await setOneClickTiles(page, false);
  await openPregnancy(page);
  await say(page, 'T9d (#17) — add a question with required, hint and a rule in one step; it lands after the row you are on', 3000);

  const lmp = rowByType(page, /^date$/);
  await lmp.getByRole('textbox', { name: 'name', exact: true }).click();
  await say(page, 'The author is on the "Last menstrual period" row…');
  await beat(page, 1000);

  await page.getByRole('button', { name: '+ Question', exact: true }).click();
  const picker = page.locator('.qtype-modal');
  await picker.getByPlaceholder(/has_fever/).fill('age');
  await picker.locator('.qtype-locale-label input').first().fill('Age');
  await say(page, '…names the question, picks "Number"…');
  await picker
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Number$/ }) })
    .click();

  const configure = picker.locator('.qtype-configure');
  await expect(configure).toBeVisible();
  await say(page, '…and gets a configure step instead of an empty row');
  await beat(page, 1200);
  await configure.getByRole('checkbox', { name: /^Required/ }).check();
  await configure.getByPlaceholder(/Help text/).first().fill('Years');
  const panel = configure.getByTestId('validation-panel');
  await panel.getByRole('combobox', { name: 'Add a validation rule' }).selectOption({ label: 'Between two values' });
  await panel.getByRole('spinbutton', { name: 'Minimum' }).fill('0');
  await panel.getByRole('spinbutton', { name: 'Maximum' }).fill('20');
  await say(page, 'Required, a hint, and "Between 0 and 20" with a suggested message — all before the row exists');
  await beat(page, 1500);
  await configure.getByRole('button', { name: 'Add question', exact: true }).click();
  await expect(picker).not.toBeVisible();

  const flashed = page.locator('.survey-row.row-flash');
  await expect(flashed.getByRole('textbox', { name: 'name', exact: true })).toHaveValue('age');
  await expect(flashed).toBeInViewport();
  await say(page, 'The new row appears directly after "Last menstrual period", scrolled into view and highlighted', 2500);

  await say(page, '"add without details" keeps the old one-click behaviour for a quick question');
  await (await rowByName(page, 'age')).getByRole('textbox', { name: 'name', exact: true }).click();
  await page.getByRole('button', { name: '+ Question', exact: true }).click();
  await picker.getByPlaceholder(/has_fever/).fill('quick_note');
  await picker
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Text$/ }) })
    .click();
  await beat(page, 1000);
  await picker.getByRole('button', { name: 'add without details' }).click();
  await expect(picker).not.toBeVisible();
  await beat(page, 1200);

  await say(page, 'Save…');
  await saveForm(page);
  const after = await getForm(request);
  const names = after.form.survey.map((r) => r.name);
  const idx = names.indexOf('age');
  expect(names[idx - 1]).toBe('lmp_date');
  expect(names[idx + 1]).toBe('quick_note');
  const age = after.form.survey[idx]!;
  expect(age.required).toBe('yes');
  expect(age.extras['hint::en']).toBe('Years');
  expect(age.extras['constraint']).toBe('. >= 0 and . <= 20');
  await say(
    page,
    `…on disk: lmp_date → age → quick_note; age has required=yes, hint::en=Years, constraint "${age.extras['constraint']}", message "${age.extras['constraint_message::en']}"`,
    5000,
  );
});
