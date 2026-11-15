import { expect, type Page } from '@playwright/test';

/** Where global-setup stores the manager session every test starts from. */
export const MANAGER_STATE = 'e2e/.auth/manager.json';

/** Open the dashboard with the manager session already in place. */
export async function signInAsManager(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'مركز العمليات' })).toBeVisible();
}

/** Fill the real sign-in form (used by the tests that verify the form itself). */
export async function submitLogin(page: Page, email: string, password: string) {
  await page.getByLabel('البريد الإلكتروني').fill(email);
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: /دخول/ }).click();
}
