import { test, expect } from '@playwright/test';

test.describe('تسجيل الدخول والجلسة', () => {
  test('the login screen renders in Arabic RTL and rejects a bad password', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'لوحة متابعة الميدان' })).toBeVisible();
    await expect(page.getByText('مبيدات وأسمدة زراعية')).toBeVisible();
    await page.getByLabel('البريد الإلكتروني').fill('admin@mandoub.test');
    await page.getByLabel('كلمة المرور').fill('wrong-password');
    await page.getByRole('button', { name: 'دخول لوحة المتابعة' }).click();
    await expect(page.getByRole('alert')).toContainText('غير صحيحة');
  });

  test('a manager can sign in and reach the live map', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('البريد الإلكتروني').fill('admin@mandoub.test');
    await page.getByLabel('كلمة المرور').fill('Demo1234!');
    await page.getByRole('button', { name: 'دخول لوحة المتابعة' }).click();
    await expect(page.getByRole('heading', { name: 'المتابعة الحية' })).toBeVisible();
    await expect(page.getByRole('application', { name: 'خريطة مواقع المهندسين' })).toBeVisible();
    await expect(page.getByText('الفريق الآن')).toBeVisible();
  });

  test('a representative is redirected from the dashboard to the engineer app', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('البريد الإلكتروني').fill('rep@mandoub.test');
    await page.getByLabel('كلمة المرور').fill('Demo1234!');
    await page.getByRole('button', { name: 'دخول لوحة المتابعة' }).click();
    await expect(page).toHaveURL(/\/app/);
    // The manager shell must never render for a representative account.
    await expect(page.getByRole('button', { name: 'خروج' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /المتابعة الحية/ })).toHaveCount(0);
  });

  test('the login screen links to the engineer app', async ({ page }) => {
    await page.goto('/');
    const link = page.getByRole('link', { name: /تطبيق المهندس/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/app');
  });

  test('the session survives a page reload without re-entering credentials', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('البريد الإلكتروني').fill('admin@mandoub.test');
    await page.getByLabel('كلمة المرور').fill('Demo1234!');
    await page.getByRole('button', { name: 'دخول لوحة المتابعة' }).click();
    await expect(page.getByRole('heading', { name: 'المتابعة الحية' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'المتابعة الحية' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'دخول لوحة المتابعة' })).toHaveCount(0);
  });

  test('logging out returns to the login screen and clears the session', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('البريد الإلكتروني').fill('admin@mandoub.test');
    await page.getByLabel('كلمة المرور').fill('Demo1234!');
    await page.getByRole('button', { name: 'دخول لوحة المتابعة' }).click();
    await page.getByRole('button', { name: 'خروج' }).click();
    await expect(page.getByRole('button', { name: 'دخول لوحة المتابعة' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'دخول لوحة المتابعة' })).toBeVisible();
  });
});
