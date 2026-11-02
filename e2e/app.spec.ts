import { test, expect } from '@playwright/test';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByLabel('البريد الإلكتروني').fill('admin@mandoub.test');
  await page.getByLabel('كلمة المرور').fill('Demo1234!');
  await page.getByRole('button', { name: 'دخول لوحة المتابعة' }).click();
  await expect(page.getByRole('heading', { name: 'المتابعة الحية' })).toBeVisible();
}

test.describe('المتابعة الحية والفريق', () => {
  test('the overview shows live counters and the demo team', async ({ page }) => {
    await signIn(page);
    await expect(page.getByText('مهندسون في الميدان')).toBeVisible();
    await expect(page.getByText('إجمالي مسافة اليوم')).toBeVisible();
    const rows = page.locator('.rep-list .rep');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(3);
  });

  test('selecting a representative shows their summary and route', async ({ page }) => {
    await signIn(page);
    await page.locator('.rep-list .rep').first().click();
    await expect(page.locator('.selected-summary')).toBeVisible();
    await expect(page.locator('.selected-summary dd').first()).toBeVisible();
    await expect(page.getByText(/نقطة/).first()).toBeVisible();
  });

  test('the map renders without a JavaScript error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await signIn(page);
    await expect(page.locator('.leaflet-container')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('navigation switches between team, reports, and privacy pages', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: /الفريق/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'الفريق' })).toBeVisible();
    await page.getByRole('button', { name: /التقارير/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'التقارير' })).toBeVisible();
    await page.getByRole('button', { name: /الحساب والخصوصية/ }).click();
    await expect(page.getByRole('heading', { name: 'الخصوصية والاحتفاظ' })).toBeVisible();
    await expect(page.getByText(/لا يبدأ التتبع إلا بعد موافقة/)).toBeVisible();
  });

  test('a disabled representative cannot be created twice with the same email', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: /الفريق/ }).click();
    const form = page.locator('form.stack');
    await form.getByLabel('الاسم').fill('مهندس مكرر');
    await form.getByLabel('البريد الإلكتروني').fill('ahmed@mandoub.test');
    await form.getByLabel(/كلمة مرور مؤقتة/).fill('RepPassword123!');
    await form.getByRole('button', { name: 'إنشاء الحساب' }).click();
    await expect(page.getByRole('alert')).toContainText('مستخدم بالفعل');
  });
});
