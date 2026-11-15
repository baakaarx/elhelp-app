import { expect, type Page } from '@playwright/test';

/** Where global-setup stores the manager session every test starts from. */
export const MANAGER_STATE = 'e2e/.auth/manager.json';
/** The manager session token global-setup hands to the browser tests. */
export const MANAGER_COOKIE = 'mandoub_admin_session';

/**
 * Open the dashboard already signed in as the manager.
 *
 * The session token comes from global setup (one login per run, so the 15-attempts-per-15-minutes
 * limit never affects the suite) and is installed as the same HttpOnly cookie the API sets.
 */
export async function signInAsManager(page: Page) {
  const token = process.env.E2E_ADMIN_TOKEN;
  if (token) {
    await page.context().addCookies([{
      name: MANAGER_COOKIE, value: token, domain: '127.0.0.1', path: '/',
      expires: -1, httpOnly: true, secure: false, sameSite: 'Lax',
    }]);
  }
  await page.goto('/');
  // The sign-in screen carries the same page title, so only the shell proves the session.
  await expect(page.getByRole('button', { name: 'خروج' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'مركز العمليات' })).toBeVisible();
}

/** Fill the real sign-in form (used by the tests that verify the form itself). */
export async function submitLogin(page: Page, email: string, password: string) {
  await page.getByLabel('البريد الإلكتروني').fill(email);
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: /دخول/ }).click();
}
