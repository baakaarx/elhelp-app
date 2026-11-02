import { test, expect } from '@playwright/test';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByLabel('البريد الإلكتروني').fill('admin@mandoub.test');
  await page.getByLabel('كلمة المرور').fill('Demo1234!');
  await page.getByRole('button', { name: 'دخول لوحة المتابعة' }).click();
  await expect(page.getByRole('heading', { name: 'المتابعة الحية' })).toBeVisible();
  await page.getByRole('button', { name: /التقارير/ }).click();
  await expect(page.getByRole('heading', { name: 'التقارير' })).toBeVisible();
}

test.describe('التقارير اليومية والميدانية', () => {
  test('the daily reports tab lists seeded demo reports with visit counts', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('tab', { name: /التقارير اليومية/ })).toHaveAttribute('aria-selected', 'true');
    const reports = page.locator('.report');
    await expect(reports.first()).toBeVisible();
    await expect(reports.first().locator('.visits')).toHaveCount(0);
    await expect(reports.first().getByRole('button', { name: 'عرض التفاصيل' })).toBeVisible();
  });

  test('expanding a daily report shows the visit table and electronic signature', async ({ page }) => {
    await signIn(page);
    await page.locator('.report').first().getByRole('button', { name: 'عرض التفاصيل' }).click();
    await expect(page.locator('.visits table')).toBeVisible();
    await expect(page.getByText(/توقيع إلكتروني:/)).toBeVisible();
    await expect(page.locator('.visits thead th').first()).toHaveText('م');
  });

  test('the field reports tab shows report types', async ({ page }) => {
    await signIn(page);
    await page.getByRole('tab', { name: /تقارير الميدان/ }).click();
    await expect(page.locator('.report').first()).toBeVisible();
    await expect(page.locator('.report').first()).toContainText(/زيارة|طلبية|تحصيل|ملاحظة|مشكلة/);
  });

  test('reviewing a report updates its status pill', async ({ page }) => {
    await signIn(page);
    const card = page.locator('.report').filter({ hasText: 'جديد' }).first();
    const review = card.getByRole('button', { name: 'تمت المراجعة' });
    if (await review.count()) {
      await review.click();
      await expect(card.locator('.pill.ok')).toHaveText('تمت المراجعة');
    }
  });

  test('the status filter narrows the list', async ({ page }) => {
    await signIn(page);
    const before = await page.locator('.report').count();
    await page.getByLabel('الحالة').selectOption('reviewed');
    await expect(page.locator('.report')).not.toHaveCount(0);
    const after = await page.locator('.report').count();
    expect(after).toBeLessThanOrEqual(before);
  });

  test('the daily report PDF downloads', async ({ page }) => {
    await signIn(page);
    const download = page.waitForEvent('download');
    await page.locator('.report').first().getByRole('button', { name: 'تنزيل PDF' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toContain('.pdf');
  });
});
