import { test, expect } from '@playwright/test';
import { E2E_REPS } from './fixtures';
import { signInAsManager } from './helpers';

test.describe('المتابعة الحية والفريق', () => {
  test('the overview lists the real team that signed up', async ({ page }) => {
    await signInAsManager(page);
    await expect(page.getByText('مهندسون في الميدان')).toBeVisible();
    await expect(page.getByText('إجمالي مسافة اليوم')).toBeVisible();
    // A production build never announces a simulation mode or sample data.
    await expect(page.locator('body')).not.toContainText('تجريبي');
    const rows = page.locator('.rep-list .rep');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(E2E_REPS.length);
  });

  test('selecting a representative shows their summary and route', async ({ page }) => {
    await signInAsManager(page);
    await page.locator('.rep-list .rep').first().click();
    await expect(page.locator('.selected-summary')).toBeVisible();
    await expect(page.locator('.selected-summary dd').first()).toBeVisible();
    await expect(page.getByText(/نقطة/).first()).toBeVisible();
  });

  test('the map renders without a JavaScript error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await signInAsManager(page);
    await expect(page.locator('.leaflet-container')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('navigation switches between team, reports, and privacy pages', async ({ page }) => {
    await signInAsManager(page);
    await page.getByRole('button', { name: /فريق الميدان/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'فريق الميدان' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'الفريق' })).toBeVisible();
    await page.getByRole('button', { name: /إنجازات وتقارير/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'إنجازات وتقارير' })).toBeVisible();
    await page.getByRole('button', { name: /هويتي/ }).click();
    await expect(page.getByRole('heading', { name: 'الخصوصية والاحتفاظ' })).toBeVisible();
    await expect(page.getByText(/لا يبدأ التتبع إلا بعد موافقة/)).toBeVisible();
  });

  test('the field alerts panel lists exceptions with a jump-to-rep action', async ({ page }) => {
    await signInAsManager(page);
    const panel = page.getByRole('region', { name: 'تنبيهات الميدان' });
    await expect(panel).toBeVisible();
    await expect(panel.locator('.alert').first()).toBeVisible();
    await expect(panel).toContainText(/زيارة مفتوحة|انقطاع/);
    await panel.getByRole('button', { name: 'فتح' }).first().click();
    await expect(page.locator('.selected-summary')).toBeVisible();
  });

  test('the route replay scrubs the day of the selected representative', async ({ page }) => {
    await signInAsManager(page);
    await page.locator('.rep-list .rep').first().click();
    await expect(page.locator('.selected-summary')).toBeVisible();
    const replay = page.locator('.replay');
    await expect(replay).toBeVisible();
    await replay.getByRole('button', { name: 'تشغيل المسار' }).click();
    await expect(replay.getByLabel('تقدم المسار')).toBeVisible();
    await replay.getByLabel('تقدم المسار').fill('500');
    await expect(replay.locator('.replay-time')).not.toHaveText('—');
  });

  test('the performance page compares the team and exports an Excel workbook', async ({ page }) => {
    await signInAsManager(page);
    await page.getByRole('button', { name: /مؤشرات التأثير/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'مؤشرات التأثير' })).toBeVisible();
    await expect(page.locator('.kpi-table')).toBeVisible();
    await expect(page.locator('.kpi-table tbody tr').first()).toBeVisible();
    // Excel only: the CSV buttons were removed from the interface on request.
    await expect(page.getByRole('button', { name: /CSV/ })).toHaveCount(0);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /تصدير Excel/ }).click();
    expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
  });
});
