import { test, expect, type Page, type Locator } from '@playwright/test';
import { signInAsManager } from './helpers';

/**
 * The customer book, driven the way the office uses it.
 *
 * Three things are checked here and nowhere else: that a customer can be entered with no engineer
 * attached (the state that has to be possible), that the area workbench states the move on the button
 * itself before anything is pressed, and that a repeated name is refused in words instead of creating
 * a second row for the same farm. The seed in `global-setup.ts` already holds «مزرعة النور» for أحمد
 * حسن and «مزرعة الدلتا» for سارة منصور, so every count below is relative to that.
 */
const unique = `عميل اختبار ${Date.now().toString().slice(-6)}`;
const area = { governorate: 'الغربية', district: `مركز ${unique}` };

async function openCustomers(page: Page) {
  await signInAsManager(page);
  await page.locator('button.nav-item').filter({ hasText: 'العملاء' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'العملاء' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'قائمة العملاء' })).toBeVisible();
}
/** The two tables on the screen carry their own class, so a locator cannot land on the wrong one. */
const rows = (page: Page): Locator => page.locator('.customers-table tbody tr');
/**
 * The engineer cell is the picker itself, so the row's text now contains every engineer's name as a choice.
 * Reading «who owns this customer» off the row would pass for any answer; it is read off the selected
 * option instead, which is the one thing the screen is actually claiming.
 */
const ownerOf = (row: Locator): Locator => row.locator('select.rowpick option:checked');
const ownerPicker = (row: Locator): Locator => row.locator('select.rowpick');
const areaRow = (page: Page, district: string): Locator =>
  page.locator('.area-table tbody tr').filter({ hasText: district });

test.describe('قائمة عملاء الشركة', () => {
  test('the book shows the customers the office entered, with the visits the field recorded', async ({ page }) => {
    await openCustomers(page);
    await expect(ownerOf(rows(page).filter({ hasText: 'مزرعة النور' }))).toHaveText('أحمد حسن');
    await expect(rows(page).filter({ hasText: 'مزرعة النور' })).toContainText('جديد');
    await expect(rows(page).filter({ hasText: 'مزرعة النور' })).toContainText('01000000000');
    await expect(page.getByText('توزيع العملاء على المناطق')).toBeVisible();
    await expect(page.getByText(/عملاء الشركة كلهم هنا/)).toBeVisible();
  });

  test('a customer is entered with no engineer, and the duplicate is refused', async ({ page }) => {
    await openCustomers(page);
    await page.getByRole('button', { name: 'عميل جديد' }).click();
    const form = page.locator('form.panel');
    await form.getByLabel('اسم العميل / المزرعة').fill(unique);
    await form.getByLabel('المحافظة').fill(area.governorate);
    await form.getByLabel('المركز').fill(area.district);
    await form.getByLabel('التليفون').fill('01099998888');
    await form.getByRole('button', { name: 'حفظ' }).click();

    await expect(rows(page).filter({ hasText: unique })).toBeVisible();
    // Not attached to anybody: a real state of the list, so it must be readable and not hidden.
    await expect(ownerOf(rows(page).filter({ hasText: unique }))).toHaveText(/من غير مهندس/);
    const createdRow = rows(page).filter({ hasText: unique });
    await createdRow.getByRole('button', { name: 'حذف', exact: true }).click();
    await expect(createdRow.getByText(/لو عليه طلبيات، الحذف هيترفض/)).toBeVisible();
    await createdRow.getByRole('button', { name: 'إلغاء' }).click();

    await page.getByRole('button', { name: 'عميل جديد' }).click();
    await page.locator('form.panel').getByLabel('اسم العميل / المزرعة').fill(unique);
    await page.locator('form.panel').getByRole('button', { name: 'حفظ' }).click();
    await expect(page.locator('form.panel').getByRole('alert')).toContainText('قائمة الشركة');
    await expect(rows(page).filter({ hasText: unique })).toHaveCount(1);
  });

  test('the row hands a customer to an engineer by itself — no window, no save button', async ({ page }) => {
    await openCustomers(page);
    const name = `عميل ربط ${Date.now().toString().slice(-6)}`;
    await page.getByRole('button', { name: 'عميل جديد' }).click();
    const form = page.locator('form.panel');
    await form.getByLabel('اسم العميل / المزرعة').fill(name);
    await form.getByRole('button', { name: 'حفظ' }).click();

    const row = rows(page).filter({ hasText: name });
    // Entered a second ago and owned by nobody: the picker's value is the empty one, not a string that
    // happens to read as «unassigned».
    await expect(ownerPicker(row)).toHaveValue('');
    await ownerPicker(row).selectOption({ label: 'مصطفى كامل' });
    // Nothing was clicked after that. The list reloads from the server, so what reads back is the answer
    // the POST produced — the same read-back the manager sees, not a widget left showing a choice.
    await expect(ownerOf(row)).toHaveText('مصطفى كامل');
    await ownerPicker(row).selectOption({ label: 'من غير مهندس (قائمة الشركة)' });
    await expect(ownerPicker(row)).toHaveValue('');
  });

  test('the area row calculates the move automatically and transfers in one press', async ({ page }) => {
    await openCustomers(page);
    await page.getByRole('button', { name: 'عميل جديد' }).click();
    const form = page.locator('form.panel');
    await form.getByLabel('اسم العميل / المزرعة').fill(unique);
    await form.getByLabel('المحافظة').fill(area.governorate);
    await form.getByLabel('المركز').fill(area.district);
    await form.getByRole('button', { name: 'حفظ' }).click();

    const row = areaRow(page, area.district);
    await expect(row).toBeVisible();
    // Nobody typed this مركز under any engineer's name: the picker starts on the company's list, and
    // choosing the man turns the button itself into the preview — «how many» is on it before it moves.
    await expect(row.locator('select.rowpick option:checked')).toContainText('قائمة الشركة');
    await row.getByLabel('المهندس').selectOption({ label: 'مصطفى كامل' });
    await expect(row.getByText(/هينقل/)).toBeVisible();
    await row.getByRole('button', { name: /تأكيد النقل لـ مصطفى كامل/ }).click();
    await expect(row.getByText('اتنقلوا')).toBeVisible();

    await expect(ownerOf(rows(page).filter({ hasText: unique }))).toHaveText('مصطفى كامل');
  });

  test('an engineer without a region gets one, and the area starts proposing him', async ({ page }) => {
    await openCustomers(page);
    // Seeded with الدقهلية; the point is that the office can correct it without recreating the account.
    const engineer = page.locator('.rep-list li').filter({ hasText: 'مصطفى كامل' });
    await expect(engineer.getByText('منطقته: الدقهلية')).toBeVisible();
    await engineer.getByRole('button', { name: 'اربط المنطقة' }).click();
    await engineer.locator('input').fill(area.governorate);
    await engineer.getByRole('button', { name: 'احفظ' }).click();
    await expect(engineer.getByText(`منطقته: ${area.governorate}`)).toBeVisible();
    // The suggestion is no longer a column to read before acting — it is the picker's own starting
    // value. Writing the region is the only thing that ever produces it.
    await expect(areaRow(page, area.district).locator('select.rowpick option:checked')).toHaveText('مصطفى كامل');
  });
});
