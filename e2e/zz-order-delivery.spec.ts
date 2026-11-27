import { test, expect } from '@playwright/test';
import { E2E_ADMIN, E2E_API, E2E_REPS, E2E_REP_PASSWORD } from './fixtures';
import { submitLogin } from './helpers';

test('حفظ الطلب قبل الإرسال واستعادة تأكيد مفقود بدون طلبية أو تنبيه مكرر', async ({ page }) => {
  const manager = await page.context().newPage();
  await manager.goto('/');
  await submitLogin(manager, E2E_ADMIN.email, E2E_ADMIN.password);
  const managerTab = manager.locator('button.nav-item').filter({ hasText: 'الزيارات والطلبيات' });
  await managerTab.click();
  await manager.getByRole('tab', { name: /الطلبيات/ }).click();
  await expect(manager.locator('.order-card').first()).toBeVisible();
  const initialBadge = Number((await managerTab.locator('em.badge').innerText()).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))));
  await page.setViewportSize({ width: 420, height: 850 });
  await page.goto(`${E2E_API}/app/`);
  await page.getByPlaceholder('rep@company.com').fill(E2E_REPS[0].email);
  await page.getByPlaceholder('••••••••').fill(E2E_REP_PASSWORD);
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  await page.getByRole('button', { name: 'تسجيل طلبية' }).click();
  await expect(page.getByPlaceholder('مثال: محمود أو 010')).toBeVisible();
  await page.getByRole('button', { name: /مزرعة النور/ }).click();
  await expect(page.getByRole('button', { name: 'اختار واحد تاني' })).toBeVisible();
  await page.getByPlaceholder('مثال: ٢٠ مبيد حشري فرتاك').fill('٧ يوريا ٤٦٪');
  const note = `تأكيد مفقود ${Date.now()}`;
  await page.getByPlaceholder('مثال: التسليم السبت الصبح').fill(note);

  let allowReplay = false;
  let firstId = '';
  let observedSavedBeforeSend = false;
  const ids: string[] = [];
  await page.route('**/api/orders', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    ids.push(body.id);
    if (!firstId) {
      firstId = body.id;
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mandoub.outbox') || '[]'));
      observedSavedBeforeSend = saved.some((item: { key: string }) => item.key === firstId);
      const upstream = await route.fetch();
      expect(upstream.status()).toBe(201);
      // The server committed, but a gateway replaced the confirmation with an error.
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'gateway failure' }) });
    }
    if (!allowReplay) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    return route.continue();
  });
  await page.getByRole('button', { name: /ابعت الطلبية للمكتب/ }).click();
  await expect(page.getByText(/الطلبية محفوظة على الهاتف، ولم نتأكد من وصولها للمكتب بعد/)).toBeVisible();
  expect(observedSavedBeforeSend).toBe(true);
  await expect(managerTab.locator('em.badge')).toHaveText(new Intl.NumberFormat('ar-EG').format(initialBadge + 1));
  allowReplay = true;
  await page.getByRole('tab', { name: 'حسابي' }).click();
  await page.getByRole('button', { name: /مزامنة الآن/ }).click();
  await expect.poll(async () => page.evaluate((id) => JSON.parse(localStorage.getItem('mandoub.outbox') || '[]').some((item: { key: string }) => item.key === id), firstId)).toBe(false);
  expect(ids.length).toBeGreaterThanOrEqual(2);
  expect(ids.every(id => id === firstId)).toBe(true);
  await expect(managerTab.locator('em.badge')).toHaveText(new Intl.NumberFormat('ar-EG').format(initialBadge + 1));
  const cards = manager.locator('.order-card').filter({ hasText: note });
  await expect(cards).toHaveCount(1);
  await manager.close();
});
