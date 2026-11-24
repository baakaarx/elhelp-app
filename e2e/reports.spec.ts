import { test, expect } from '@playwright/test';
import { signInAsManager } from './helpers';

test('سجل الزيارات والطلبيات من غير التقارير القديمة', async ({ page }) => {
  await signInAsManager(page);
  await page.getByRole('button', { name: /إنجازات وتقارير/ }).click();
  await expect(page.getByRole('heading', { name: 'الزيارات والطلبيات' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /الزيارات/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.report').filter({ hasText: 'مزرعة النور' })).toContainText('البحيرة');
  await expect(page.getByRole('tab', { name: /التقارير اليومية|تقارير الميدان/ })).toHaveCount(0);
  await page.getByLabel('الحالة').selectOption('closed');
  await expect(page.locator('.report .pill.warn')).toHaveCount(0);
  await page.getByRole('tab', { name: /الطلبيات/ }).click();
  await expect(page.getByRole('heading', { name: 'الطلبيات', exact: true })).toBeVisible();
});
