import { test, expect, type Page } from '@playwright/test';
import { signInAsManager } from './helpers';

async function openCustomers(page: Page) {
  await signInAsManager(page);
  await page.locator('button.nav-item').filter({ hasText: 'العملاء' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'قائمة العملاء' })).toBeVisible();
}
const rows = (page: Page) => page.locator('.customers-table tbody tr');

test('قائمة العملاء بسيطة، والبيانات القديمة باقية', async ({ page }) => {
  await openCustomers(page);
  const row = rows(page).filter({ hasText: 'مزرعة النور' });
  await expect(row).toContainText('أحمد حسن');
  await expect(row).toContainText('01000000000');
  await expect(row.getByRole('button', { name: 'تغيير المهندس' })).toBeVisible();
  await expect(page.getByText('توزيع العملاء على المناطق')).toHaveCount(0);
  await expect(page.getByText('مناطق المهندسين')).toHaveCount(0);
});

test('إضافة عميل واختيار مهندس وتغييره أو إزالته', async ({ page }) => {
  await openCustomers(page);
  const name = `عميل ربط ${Date.now()}`;
  await page.getByRole('button', { name: 'عميل جديد' }).click();
  const form = page.locator('form.panel');
  await form.getByLabel('اسم العميل / المزرعة').fill(name);
  await form.getByLabel('المحافظة').fill('الغربية');
  await form.getByLabel('المركز').fill('طنطا');
  await form.getByLabel('التليفون').fill('01099998888');
  await form.getByRole('button', { name: 'حفظ' }).click();
  const row = rows(page).filter({ hasText: name });
  await expect(row).toContainText('من غير مهندس');
  await row.getByRole('button', { name: 'إضافة مهندس' }).click();
  await row.getByLabel(`اختار مهندس ${name}`).selectOption({ label: 'مصطفى كامل — الدقهلية' });
  await expect(row).toContainText('مصطفى كامل');
  await page.reload();
  await page.locator('button.nav-item').filter({ hasText: 'العملاء' }).click();
  await expect(row).toContainText('مصطفى كامل');
  await row.getByRole('button', { name: 'تغيير المهندس' }).click();
  await row.getByLabel(`اختار مهندس ${name}`).selectOption({ label: 'أحمد حسن — الإسكندرية' });
  await expect(row).toContainText('أحمد حسن');
  await row.getByRole('button', { name: 'تغيير المهندس' }).click();
  await row.getByLabel(`اختار مهندس ${name}`).selectOption({ label: 'من غير مهندس' });
  await expect(row.getByRole('button', { name: 'إضافة مهندس' })).toBeVisible();
  await row.getByRole('button', { name: 'حذف', exact: true }).click();
  await expect(row.getByText(/لو عليه طلبيات، الحذف هيترفض/)).toBeVisible();
  await row.getByRole('button', { name: 'إلغاء' }).click();
  await page.getByRole('button', { name: 'عميل جديد' }).click();
  await page.locator('form.panel').getByLabel('اسم العميل / المزرعة').fill(name);
  await page.locator('form.panel').getByRole('button', { name: 'حفظ' }).click();
  await expect(page.locator('form.panel').getByRole('alert')).toContainText('قائمة الشركة');
  await expect(rows(page).filter({ hasText: name })).toHaveCount(1);
});
