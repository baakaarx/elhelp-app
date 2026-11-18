import { test, expect, type Page } from '@playwright/test';
import { signInAsManager } from './helpers';

async function openReports(page: Page) {
  await signInAsManager(page);
  await page.getByRole('button', { name: /إنجازات وتقارير/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'إنجازات وتقارير' })).toBeVisible();
}

test.describe('التقارير اليومية والميدانية', () => {
  test('the daily reports tab lists the signed reports', async ({ page }) => {
    await openReports(page);
    await expect(page.getByRole('tab', { name: /التقارير اليومية/ })).toHaveAttribute('aria-selected', 'true');
    const reports = page.locator('.report');
    await expect(reports.first()).toBeVisible();
    await expect(reports.first().locator('.visits table')).toBeVisible();
  });

  test('a daily report shows the visit table and electronic signature', async ({ page }) => {
    await openReports(page);
    await expect(page.locator('.visits table')).toBeVisible();
    await expect(page.getByText(/توقيع إلكتروني:/)).toBeVisible();
  });

  test('the field reports tab shows report types', async ({ page }) => {
    await openReports(page);
    await page.getByRole('tab', { name: /تقارير الميدان/ }).click();
    await expect(page.locator('.report').first()).toBeVisible();
    await expect(page.locator('.report').first()).toContainText(/زيارة|طلبية|تحصيل|ملاحظة|مشكلة/);
  });

  test('reviewing a report turns its status pill into the reviewed state', async ({ page }) => {
    await openReports(page);
    const reviewed = page.locator('.report .pill.ok');
    const before = await reviewed.count();
    await page.locator('.report').first().getByRole('button', { name: 'تمت المراجعة' }).click();
    await expect(reviewed).toHaveCount(before + 1);
  });

  test('reviewing a field report refreshes every open manager dashboard', async ({ page }) => {
    await openReports(page);
    const observer = await page.context().newPage();
    await openReports(observer);
    await page.getByRole('tab', { name: /تقارير الميدان/ }).click();
    await observer.getByRole('tab', { name: /تقارير الميدان/ }).click();

    const title = 'طلبية سماد';
    const reviewedBy = page.locator('.report').filter({ hasText: title });
    const observed = observer.locator('.report').filter({ hasText: title });
    await expect(reviewedBy).toContainText('جديد');
    await expect(observed).toContainText('جديد');
    await reviewedBy.getByRole('button', { name: 'تمت المراجعة' }).click();
    await expect(reviewedBy).toContainText('تمت المراجعة');
    await expect(observed).toContainText('تمت المراجعة');
    await observer.close();
  });

  test('the visits tab lists the recorded visits with their details', async ({ page }) => {
    await openReports(page);
    await page.getByRole('tab', { name: /الزيارات/ }).click();
    const cards = page.locator('.report');
    await expect(cards.first()).toBeVisible();
    await expect(page.locator('.report').filter({ hasText: 'مزرعة النور' })).toHaveCount(1);
    await expect(page.locator('.report').filter({ hasText: 'مزرعة النور' })).toContainText('البحيرة');
  });

  test('the status filter only keeps the requested state', async ({ page }) => {
    await openReports(page);
    await page.getByLabel('الحالة').selectOption('new');
    await expect(page.locator('.report .pill.ok')).toHaveCount(0);
    await page.getByLabel('الحالة').selectOption('reviewed');
    await expect(page.locator('.report .pill.warn')).toHaveCount(0);
  });

  test('the daily report PDF downloads', async ({ page }) => {
    await openReports(page);
    const download = page.waitForEvent('download');
    await page.locator('.report').first().getByRole('button', { name: 'تنزيل PDF' }).click();
    expect((await download).suggestedFilename()).toContain('.pdf');
  });
});
