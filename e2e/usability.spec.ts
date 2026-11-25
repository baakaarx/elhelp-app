import { test, expect, request, type Page } from '@playwright/test';
import { E2E_ADMIN, E2E_API } from './fixtures';

// Session tests sign out the global setup token. One fresh session is shared by this file to
// avoid exhausting the real login rate limit with one login per test.
let token: string;
test.beforeAll(async () => {
  const client = await request.newContext({ baseURL: E2E_API });
  const response = await client.post('/api/auth/login', { data: E2E_ADMIN });
  expect(response.ok()).toBeTruthy();
  token = (await response.json()).token;
  await client.dispose();
});
async function signIn(page: Page) {
  await page.addInitScript(value => window.localStorage.setItem('mandoub.token', value), token);
  await page.context().addCookies([{ name: 'mandoub_admin_session', value: token, url: 'http://127.0.0.1:5174' }]);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'خروج' })).toBeVisible();
}

test('رسالة الحقول المطلوبة والبريد غير الصحيح بالعربي', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: /فريق الميدان/ }).click();
  await page.getByRole('button', { name: 'إنشاء حساب المهندس' }).click();
  const name = page.getByLabel('اسم المهندس');
  await expect.poll(() => name.evaluate((input: HTMLInputElement) => input.validationMessage)).toContain('البيانات المطلوبة');
  await name.fill('مهندس تجربة');
  const email = page.getByLabel('البريد الإلكتروني');
  await email.fill('bad-email');
  await page.getByRole('button', { name: 'إنشاء حساب المهندس' }).click();
  await expect.poll(() => email.evaluate((input: HTMLInputElement) => input.validationMessage)).toContain('بريدًا إلكترونيًا صحيحًا');
  await email.fill('good@example.test');
  await expect.poll(() => email.evaluate((input: HTMLInputElement) => input.validationMessage)).toBe('');
});

test('الأزرار والنماذج مناسبة للشاشات الصغيرة والجداول تتحرك داخلها', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  for (const tab of ['العملاء', 'المبيعات', 'المخازن', 'حسابات المكتب', 'فريق الميدان', 'الزيارات والطلبيات']) {
    await page.getByRole('button', { name: tab, exact: tab !== 'الزيارات والطلبيات' }).first().click();
    await expect(page.locator('main')).toBeVisible();
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(dimensions.scroll, `عرض الشاشة في ${tab}`).toBeLessThanOrEqual(dimensions.width + 1);
  }
});

test('تعذر الاتصال ما يكررش حركة مخزون اتحفظت قبل انقطاع الرد', async ({ page }) => {
  await signIn(page);
  const token = await page.evaluate(() => localStorage.getItem('mandoub.token'));
  const headers = { 'X-Mandoub-Token': token!, 'X-Mandoub-Client': 'admin' };
  const wh = await (await page.request.post('/api/warehouse/warehouses', { headers, data: { name: `مخزن شبكة ${Date.now()}` } })).json();
  const product = await (await page.request.post('/api/warehouse/products', { headers, data: { name: `صنف شبكة ${Date.now()}`, category: 'other', unit: 'عبوة' } })).json();
  await page.getByRole('button', {name:'المخازن',exact:true}).click();
  await page.getByRole('combobox', {name:'المخزن',exact:true}).selectOption(wh.warehouse.id);
  await page.getByRole('combobox', {name:'الصنف',exact:true}).selectOption(product.product.id);
  await page.getByLabel('الكمية').fill('5');
  let dropped = false;
  const ids: string[] = [];
  await page.route('**/api/warehouse/movements', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    ids.push(route.request().postDataJSON().id);
    if (!dropped) { dropped = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByRole('button', {name:'حفظ الحركة'}).click();
  await expect(page.getByRole('alert')).toContainText('تعذر الاتصال بالسيرفر');
  await page.getByRole('button', {name:'حفظ الحركة'}).click();
  await expect(page.getByRole('status')).toContainText('الحركة اتحفظت');
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  const stock = await (await page.request.get(`/api/warehouse/stock?warehouseId=${wh.warehouse.id}`, {headers})).json();
  expect(stock.stock.find((row: {id: string}) => row.id === product.product.id).qty).toBe(5);
});

test('حفظ حركة نجح لكن تحديث الرصيد فشل يوضح النتيجة الحقيقية', async ({ page }) => {
  await signIn(page);
  const token = await page.evaluate(() => localStorage.getItem('mandoub.token'));
  const headers = { 'X-Mandoub-Token': token!, 'X-Mandoub-Client': 'admin' };
  const wh = await (await page.request.post('/api/warehouse/warehouses', { headers, data: { name: `مخزن تحديث ${Date.now()}` } })).json();
  const product = await (await page.request.post('/api/warehouse/products', { headers, data: { name: `صنف تحديث ${Date.now()}`, category: 'other', unit: 'عبوة' } })).json();
  await page.getByRole('button', {name:'المخازن',exact:true}).click();
  await page.getByRole('combobox', {name:'المخزن',exact:true}).selectOption(wh.warehouse.id);
  await page.getByRole('combobox', {name:'الصنف',exact:true}).selectOption(product.product.id);
  await page.getByLabel('الكمية').fill('7');
  await page.route('**/api/warehouse/stock?*', route => route.abort('failed'));
  await page.getByRole('button', {name:'حفظ الحركة'}).click();
  await expect(page.getByRole('status')).toContainText('الحركة اتحفظت');
  await expect(page.getByRole('alert')).toContainText('الحركة اتحفظت، لكن الأرصدة ما اتحدّثتش');
  await expect(page.getByLabel('الكمية')).toHaveValue('');
  await page.unroute('**/api/warehouse/stock?*');
  const stock = await (await page.request.get(`/api/warehouse/stock?warehouseId=${wh.warehouse.id}`, {headers})).json();
  expect(stock.stock.find((row: {id: string}) => row.id === product.product.id).qty).toBe(7);
});
