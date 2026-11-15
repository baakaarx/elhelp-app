import { expect, type Page } from '@playwright/test';
import { E2E_ADMIN } from './fixtures';

/** Sign in through the real form, then wait for the manager shell to render. */
export async function signInAsManager(page: Page) {
  await page.goto('/');
  await page.getByLabel('البريد الإلكتروني').fill(E2E_ADMIN.email);
  await page.getByLabel('كلمة المرور').fill(E2E_ADMIN.password);
  await page.getByRole('button', { name: /دخول/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'مركز العمليات' })).toBeVisible();
}
