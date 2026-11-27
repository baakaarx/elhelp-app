import { test, expect } from '@playwright/test';
import { E2E_API, E2E_REPS, E2E_REP_PASSWORD } from './fixtures';

test('عملائي يعرض قائمة المهندس فقط مع بحث وتحديث آمن عند انقطاع الشبكة', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto(`${E2E_API}/app/`);
  await page.getByPlaceholder('rep@company.com').fill(E2E_REPS[0].email);
  await page.getByPlaceholder('••••••••').fill(E2E_REP_PASSWORD);
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  await page.getByRole('tab', { name: 'عملائي' }).click();
  await expect(page.getByText('مزرعة النور', { exact: true })).toBeVisible();
  await expect(page.getByText('مزرعة الدلتا', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'اتصل بـ مزرعة النور' })).toBeVisible();
  await page.getByPlaceholder('ابحث عن عميل').fill('غير موجود');
  await expect(page.getByText('مفيش عميل مطابق للبحث')).toBeVisible();
  await page.getByPlaceholder('ابحث عن عميل').fill('النور');
  await expect(page.getByText('مزرعة النور', { exact: true })).toBeVisible();
  await page.route('**/api/customers?*', route => route.abort('failed'));
  await page.getByRole('button', { name: 'تحديث العملاء' }).click();
  await expect(page.getByText(/القائمة المعروضة من آخر اتصال/)).toBeVisible();
  await expect(page.getByText('مزرعة النور', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('قائمة المهندس تحمل أكثر من صفحة بدل إخفاء العملاء بعد أول ٥٠٠', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto(`${E2E_API}/app/`);
  await page.getByPlaceholder('rep@company.com').fill(E2E_REPS[0].email);
  await page.getByPlaceholder('••••••••').fill(E2E_REP_PASSWORD);
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  const calls: number[] = [];
  await page.route('**/api/customers?*', async route => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get('offset'));
    calls.push(offset);
    const customers = (offset === 0 ? Array.from({ length: 500 }, (_, i) => `عميل ${i}`) : ['عميل الصفحة الثانية']).map((name, i) => ({
      id: `${offset}-${i}`, name, phone: '', governorate: '', district: '', village: '', notes: '', stage: 'new', active: true,
      visitCount: 0, lastVisitAt: null, openVisits: 0, repName: '',
    }));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ customers, hasMore: offset === 0 }) });
  });
  await page.getByRole('tab', { name: 'عملائي' }).click();
  await page.getByPlaceholder('ابحث عن عميل').fill('عميل الصفحة الثانية');
  await expect(page.getByText('عميل الصفحة الثانية', { exact: true })).toBeVisible();
  expect(calls).toContain(0);
  expect(calls).toContain(500);
});
