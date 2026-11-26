import { test, expect } from '@playwright/test';
import { E2E_ADMIN, E2E_API, E2E_REPS, E2E_REP_PASSWORD } from './fixtures';
import { submitLogin } from './helpers';

test('المندوب يسجل طلبية من التطبيق من غير تقارير أو أسعار', async ({ page }) => {
  const manager = await page.context().newPage();
  await manager.goto('/');
  await submitLogin(manager, E2E_ADMIN.email, E2E_ADMIN.password);
  await expect(manager.getByRole('button', { name: 'خروج' })).toBeVisible();
  const managerTab = manager.locator('button.nav-item').filter({ hasText: 'الزيارات والطلبيات' });
  await managerTab.click();
  await manager.getByRole('tab', { name: /الطلبيات/ }).click();
  await expect(manager.locator('.order-card').filter({hasText:'عميل اختبار الطلبية'})).toBeVisible();
  const initialBadge = Number((await managerTab.locator('em.badge').innerText()).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))));
  await page.setViewportSize({ width: 420, height: 850 });
  await page.goto(`${E2E_API}/app/`);
  await page.getByPlaceholder('rep@company.com').fill(E2E_REPS[0].email);
  await page.getByPlaceholder('••••••••').fill(E2E_REP_PASSWORD);
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  await expect(page.getByRole('button', { name: 'تسجيل طلبية' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'التقارير' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'اليومي' })).toHaveCount(0);
  await expect(page.getByText('التقرير اليومي')).toHaveCount(0);
  await page.getByRole('button', { name: 'تسجيل طلبية' }).click();
  // Wait for the order picker, rather than clicking an identically named customer on the home screen.
  await expect(page.getByPlaceholder('مثال: محمود أو 010')).toBeVisible();
  await page.getByRole('button', { name: /مزرعة النور/ }).click();
  await expect(page.getByRole('button', { name: 'اختار واحد تاني' })).toBeVisible();
  // The phone only shows the first few catalogue entries until the engineer searches.
  await page.getByPlaceholder('مثال: يوريا أو شيكارة').fill('يوريا');
  await page.getByRole('button', { name: 'ضيف يوريا ٤٦٪' }).click();
  await page.getByLabel('كمية يوريا ٤٦٪').fill('3');
  await expect(page.getByLabel('كمية يوريا ٤٦٪')).toHaveValue('3');
  const response = page.waitForResponse(res => res.url().endsWith('/api/orders') && res.request().method() === 'POST', { timeout: 12000 })
    .catch(async () => { throw new Error(`لم يُرسل طلب الطلبية. حالة الشاشة: ${(await page.locator('body').innerText()).slice(-2500)}`); });
  await page.getByRole('button', { name: /ابعت الطلبية للمكتب/ }).click();
  const result = await response;
  expect(result.status()).toBe(201);
  const body = await result.json();
  expect(body.order.status).toBe('sent');
  await expect(page.getByText('الطلبية وصلت للمكتب وبقت مستنية المراجعة.')).toBeVisible();
  expect(body.order.lines[0].qty).toBe(3);
  expect(body.order.lines[0]).not.toHaveProperty('price');
  expect(body.order).not.toHaveProperty('total');
  await expect(managerTab.locator('em.badge')).toHaveText(new Intl.NumberFormat('ar-EG').format(initialBadge + 1));
  await expect(manager.locator('.order-card').filter({ hasText: 'مزرعة النور' })).toBeVisible();
  await page.getByRole('tab', { name: 'حسابي' }).click();
  await expect(page.getByText(/الطلبيات تفضل محفوظة لحد حذف الحساب/)).toBeVisible();
  await manager.close();
});
