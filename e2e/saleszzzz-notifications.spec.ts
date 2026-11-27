import { test, expect, type Browser, type Page } from '@playwright/test';
import { signInAsManager } from './helpers';

async function fixture(manager: Page, browser: Browser) {
  const token = await manager.evaluate(() => localStorage.getItem('mandoub.token'));
  const headers = { 'X-Mandoub-Token': token!, 'X-Mandoub-Client': 'admin' };
  const post = async (path: string, data: object) => {
    const response = await manager.request.post(path, { headers, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const email = `order-sound-${suffix}@example.test`, password = 'RepPassword123!';
  const rep = (await post('/api/reps', { name: `مهندس تنبيه ${suffix}`, email, password, region: 'الإسكندرية' })).user;
  const customer = (await post('/api/customers', { name: `عميل تنبيه ${suffix}`, repId: rep.id })).customer;
  const product = (await post('/api/warehouse/products', { name: `صنف تنبيه ${suffix}`, category: 'other', unit: 'عبوة', unitSize: '٥ لتر' })).product;
  const phoneContext = await browser.newContext({ viewport: { width: 420, height: 850 } });
  const phone = await phoneContext.newPage();
  await phone.goto('http://127.0.0.1:3100/app/');
  await phone.getByPlaceholder('rep@company.com').fill(email);
  await phone.getByPlaceholder('••••••••').fill(password);
  await phone.getByRole('button', { name: 'دخول', exact: true }).click();
  await expect(phone.getByRole('button', { name: 'تسجيل طلبية' })).toBeVisible();
  await phone.getByRole('button', { name: 'تسجيل طلبية' }).click();
  await phone.getByText(customer.name, { exact: true }).last().click();
  await phone.getByPlaceholder('مثال: ٢٠ مبيد حشري فرتاك').fill(`٣ ${product.name} عبوة ٥ لتر`);
  return { phone, phoneContext, customer, product, rep, headers };
}

async function instrumentAudio(page: Page) {
  await page.addInitScript(() => {
    const original = OscillatorNode.prototype.start;
    (window as any).__orderChimes = 0;
    OscillatorNode.prototype.start = function (...args: Parameters<OscillatorNode['start']>) {
      (window as any).__orderChimes++;
      return original.apply(this, args);
    };
  });
}
const chimes = (page: Page) => page.evaluate(() => (window as any).__orderChimes as number);

test('طلبية المهندس تصل للوحة وتُسمع بعد تفعيل الصوت وتفتح القائمة', async ({ page, browser }) => {
  await instrumentAudio(page); await signInAsManager(page);
  await expect(page.getByText('متصل بالبث الحي').first()).toBeVisible();
  await page.getByRole('button', { name: 'تفعيل صوت الطلبيات' }).click();
  await expect(page.getByRole('button', { name: 'إيقاف صوت الطلبيات' })).toBeVisible();
  expect(await chimes(page)).toBe(1); // The enable button plays a test chime.
  const { phone, phoneContext, customer, product, rep } = await fixture(page, browser);
  try {
    const response = phone.waitForResponse(r => r.url().endsWith('/api/orders') && r.request().method() === 'POST');
    await phone.getByRole('button', { name: /ابعت الطلبية للمكتب/ }).click();
    const saved = await response; expect(saved.status()).toBe(201);
    await expect(phone.getByText('الطلبية وصلت للمكتب وبقت مستنية المراجعة.')).toBeVisible();
    await expect(page.locator('.order-notice')).toContainText(customer.name);
    await expect(page.locator('.order-notice')).toContainText(rep.name);
    await expect.poll(() => chimes(page)).toBe(2);
    await page.getByRole('button', { name: 'عرض الطلبيات' }).click();
    const card = page.locator('.order-card').filter({ hasText: customer.name });
    await expect(card).toContainText(product.name); await expect(card).toContainText('٥ لتر');
    await expect(card).toContainText('٣'); await expect(card).toContainText(rep.name);
  } finally { await phoneContext.close(); }
});

test('طلبية بعد انقطاع الهاتف تصل مع صوت حتى لو البث الحي للوحة متوقف', async ({ page, browser }) => {
  await instrumentAudio(page);
  await page.routeWebSocket('**/socket.io/**', ws => ws.close());
  await page.route('**/socket.io/**', route => route.abort());
  await signInAsManager(page); await expect(page.getByText('وضع التحديث الدوري').first()).toBeVisible();
  // Ensure the fallback's baseline has loaded before the order is sent.
  await expect(page.getByText('طلبيات مستنية', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'تفعيل صوت الطلبيات' }).click();
  const { phone, phoneContext, customer, product } = await fixture(page, browser);
  try {
    await phone.route('**/api/orders', route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
    await phone.getByRole('button', { name: /ابعت الطلبية للمكتب/ }).click();
    await expect(phone.getByText(/الطلبية محفوظة على الهاتف، ولم نتأكد من وصولها للمكتب بعد/).first()).toBeVisible();
    expect(await chimes(page)).toBe(1);
    await phone.unroute('**/api/orders');
    await phone.getByRole('tab', { name: 'حسابي' }).click();
    const response = phone.waitForResponse(r => r.url().endsWith('/api/orders') && r.request().method() === 'POST');
    await phone.getByRole('button', { name: 'مزامنة الآن' }).click();
    expect((await response).status()).toBe(201);
    await expect(page.locator('.order-notice')).toContainText('وصلت طلبية جديدة');
    await expect.poll(() => chimes(page), { timeout: 10000 }).toBe(2);
    await page.getByRole('button', { name: 'عرض الطلبيات' }).click();
    const card = page.locator('.order-card').filter({ hasText: customer.name });
    await expect(card).toContainText(product.name); await expect(card).toContainText('٣');
    await expect(card).toContainText('اتبعتت بعد رجوع الشبكة');
  } finally { await phoneContext.close(); }
});

test('فشل تفعيل الصوت لا يخفي الطلبية أو يمنع وصول التنبيه المرئي', async ({ page, browser }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'AudioContext', { value: class { constructor() { throw new Error('audio blocked'); } } }); });
  await signInAsManager(page); await expect(page.getByText('متصل بالبث الحي').first()).toBeVisible();
  await page.getByRole('button', { name: 'تفعيل صوت الطلبيات' }).click();
  await expect(page.getByRole('alert')).toContainText('تعذر تشغيل الصوت');
  const { phone, phoneContext, customer } = await fixture(page, browser);
  try {
    const response = phone.waitForResponse(r => r.url().endsWith('/api/orders') && r.request().method() === 'POST');
    await phone.getByRole('button', { name: /ابعت الطلبية للمكتب/ }).click(); expect((await response).status()).toBe(201);
    await expect(page.locator('.order-notice')).toContainText(customer.name);
    await expect(page.getByRole('button', { name: 'تفعيل صوت الطلبيات' })).toBeVisible();
  } finally { await phoneContext.close(); }
});
