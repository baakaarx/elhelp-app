import { test, expect, type Page, type Locator } from '@playwright/test';
import { signInAsManager } from './helpers';

/**
 * The customer book, driven the way the office uses it.
 *
 * Three things are checked here and nowhere else: that a customer can be entered with no engineer
 * attached (the state that has to be possible), that the area workbench answers with a preview before
 * it moves anybody, and that a repeated name is refused in words instead of creating a second row for
 * the same farm. The seed in `global-setup.ts` already holds «مزرعة النور» for أحمد حسن and
 * «مزرعة الدلتا» for سارة منصور, so every count below is relative to that.
 */
const unique = `عميل اختبار ${Date.now().toString().slice(-6)}`;
const area = { governorate: 'الغربية', district: `مركز ${unique}` };

async function openCustomers(page: Page) {
  await signInAsManager(page);
  await page.locator('button.nav-item').filter({ hasText: 'العملاء' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'العملاء' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'قايمعة العملاء' })).toBeVisible();
}
/** The two tables on the screen carry their own class, so a locator cannot land on the wrong one. */
const rows = (page: Page): Locator => page.locator('.customers-table tbody tr');
const areaRow = (page: Page, district: string): Locator =>
  page.locator('.area-table tbody tr').filter({ hasText: district });

test.describe('قايمعة عملاء الشركة', () => {
  test('the book shows the customers the office entered, with the visits the field recorded', async ({ page }) => {
    await openCustomers(page);
    await expect(rows(page).filter({ hasText: 'مزرعة النور' })).toContainText('أحمد حسن');
    await expect(rows(page).filter({ hasText: 'مزرعة النور' })).toContainText('جديد');
    await expect(rows(page).filter({ hasText: 'مزرعة النور' })).toContainText('01000000000');
    await expect(page.getByText('توزيع العملاء على المناطق')).toBeVisible();
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
    await expect(rows(page).filter({ hasText: unique })).toContainText('من غير مهندس');

    await page.getByRole('button', { name: 'عميل جديد' }).click();
    await page.locator('form.panel').getByLabel('اسم العميل / المزرعة').fill(unique);
    await page.locator('form.panel').getByRole('button', { name: 'حفظ' }).click();
    await expect(page.locator('form.panel').getByRole('alert')).toContainText('قايمعة الشركة');
    await expect(rows(page).filter({ hasText: unique })).toHaveCount(1);
  });

  test('the area workbench previews the move, then hands the area to the engineer', async ({ page }) => {
    await openCustomers(page);
    await page.getByRole('button', { name: 'عميل جديد' }).click();
    const form = page.locator('form.panel');
    await form.getByLabel('اسم العميل / المزرعة').fill(unique);
    await form.getByLabel('المحافظة').fill(area.governorate);
    await form.getByLabel('المركز').fill(area.district);
    await form.getByRole('button', { name: 'حفظ' }).click();

    const row = areaRow(page, area.district);
    await expect(row).toBeVisible();
    // Nobody typed this مركز under any engineer's name, so there is no suggestion to lean on: the
    // manager picks the man himself, and only then asks what would move.
    await row.getByLabel('المهندس').selectOption({ label: 'مصطفى كامل' });
    await row.getByRole('button', { name: 'معاينة الأول' }).click();
    // The press that could move a whole area answers with words first, and nothing has been written yet.
    await expect(row.getByText('هينقل')).toBeVisible();
    await row.getByRole('button', { name: /تأكيد النقل/ }).click();
    await expect(row.getByText('اتنقلوا')).toBeVisible();

    await expect(rows(page).filter({ hasText: unique })).toContainText('مصطفى كامل');
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
    await expect(page.locator('.empty', { hasText: 'مفيش مهندس مسجّل عنده المنطقة دي' })).toHaveCount(0);
  });
});
