import { expect, type Page } from '@playwright/test';

/**
 * Install the manager session global setup obtained, then open the dashboard.
 *
 * The dashboard keeps its session token in `localStorage` (sent as `X-Mandoub-Token`) on top of
 * the HttpOnly cookie, so both have to be in place before the first render. Reusing one token
 * keeps the suite at a single login per run, well under the 15-attempts-per-15-minutes limit.
 */
export async function signInAsManager(page: Page) {
  const token = process.env.E2E_ADMIN_TOKEN;
  if (token) {
    await page.addInitScript(value => window.localStorage.setItem('mandoub.token', value), token);
    await page.context().addCookies([{ name: 'mandoub_admin_session', value: token, url: 'http://127.0.0.1:5174' }]);
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
