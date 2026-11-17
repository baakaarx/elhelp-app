import { test, expect } from '@playwright/test';
import { E2E_ADMIN, E2E_REPS, E2E_REP_PASSWORD } from './fixtures';
import { signInAsManager, submitLogin } from './helpers';

// These tests exercise the sign-in form itself, so they start without a session. Every other
// spec runs with the manager session global-setup saved (see playwright.config.ts).
test.describe('تسجيل الدخول', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the login screen renders in Arabic RTL and rejects a bad password', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByLabel('البريد الإلكتروني')).toBeVisible();
    await expect(page.getByLabel('كلمة المرور')).toBeVisible();
    // No credentials are printed on the sign-in screen: the app ships without sample accounts.
    await expect(page.locator('body')).not.toContainText('Demo');
    await submitLogin(page, E2E_ADMIN.email, 'wrong-password');
    await expect(page.getByRole('alert')).toContainText('غير صحيحة');
  });

  test('a manager can sign in and reach the live map', async ({ page }) => {
    await page.goto('/');
    await submitLogin(page, E2E_ADMIN.email, E2E_ADMIN.password);
    await expect(page.getByRole('heading', { level: 1, name: 'مركز العمليات' })).toBeVisible();
    await expect(page.getByRole('application', { name: 'خريطة مواقع المهندسين' })).toBeVisible();
    await expect(page.getByText('الفريق الآن')).toBeVisible();
  });

  test('an engineer account cannot sign into the manager website', async ({ page }) => {
    await page.goto('/');
    await submitLogin(page, E2E_REPS[0].email, E2E_REP_PASSWORD);
    await expect(page.getByRole('alert')).toContainText('تطبيق الهاتف');
    await expect(page).toHaveURL('/');
    expect(await page.evaluate(() => window.localStorage.getItem('mandoub.token'))).toBeNull();
    // The manager shell must never render for a representative account.
    await expect(page.getByRole('button', { name: 'خروج' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /مركز العمليات/ })).toHaveCount(0);
  });

  test('the public privacy policy opens without a session', async ({ page }) => {
    const response = await page.goto('/privacy');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'سياسة الخصوصية' })).toBeVisible();
    // The deletion path the stores look for must be described on that same page.
    await expect(page.locator('body')).toContainText('حذف الحساب');
    await expect(page.locator('body')).toContainText('privacy@');
  });

  test('the manager login explains that engineers use the mobile app', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.login-engineer-note')).toContainText('موقع المهندس على iPhone');
    await expect(page.locator('.login-engineer-note')).toContainText('مخصصة للمديرين');
    await expect(page.locator('a[href="/app"]')).toHaveCount(0);
  });
});

test.describe('الجلسة', () => {
  test('the session survives a page reload without re-entering credentials', async ({ page }) => {
    await signInAsManager(page);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'مركز العمليات' })).toBeVisible();
    await expect(page.getByLabel('كلمة المرور')).toHaveCount(0);
  });

  test('logging out returns to the login screen and clears the session', async ({ page }) => {
    await signInAsManager(page);
    await page.getByRole('button', { name: 'خروج' }).click();
    await expect(page.getByLabel('كلمة المرور')).toBeVisible();
  });
});
