import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { signInAsManager } from './helpers';

test('رسم العملاء يتحدث مع البيع ويفتح كل فواتير العميل ومديونيته', async ({ page }) => {
  await signInAsManager(page);
  const token = await page.evaluate(() => localStorage.getItem('mandoub.token'));
  const headers = { 'X-Mandoub-Token': token!, 'X-Mandoub-Client': 'admin' };
  const send = async (path: string, data: object) => {
    const response = await page.request.post(path, { headers, data });
    expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const name = `عميل تحليل ${Date.now()}`;
  const customer = (await send('/api/customers', { name, phone: '01076543210' })).customer;
  const warehouse = (await send('/api/warehouse/warehouses', { name: `مخزن تحليل ${Date.now()}` })).warehouse;
  const product = (await send('/api/warehouse/products', { name: `صنف تحليل ${Date.now()}`, category: 'other', unit: 'عبوة' })).product;
  await send('/api/warehouse/movements', { id: randomUUID(), kind: 'opening', productId: product.id, toWarehouseId: warehouse.id, qty: 10 });
  await send('/api/sales', { id: randomUUID(), customerId: customer.id, warehouseId: warehouse.id, paid: 20, lines: [{ productId: product.id, qty: 1, price: 100 }] });
  await send('/api/sales/opening', { id: randomUUID(), customerId: customer.id, amount: 50 });
  await send('/api/sales/receipts', { id: randomUUID(), customerId: customer.id, amount: 10 });

  await page.getByRole('button', { name: 'العملاء', exact: true }).click();
  const chart = page.getByRole('region', { name: 'تحليل مشتريات العملاء' });
  await chart.getByLabel('بحث في الرسم').fill(name);
  const bar = chart.getByRole('button', { name: new RegExp(`عرض حساب ${name}`) });
  await expect(bar).toBeVisible(); await expect(bar).toContainText('١٠٠');
  await bar.click();
  const detail = page.getByRole('region', { name: 'تفاصيل العميل' });
  await expect(detail.getByRole('heading', { name })).toBeVisible();
  await expect(detail.locator('.customer-detail-stats > div').filter({ hasText: 'صافي المشتريات' })).toContainText('١٠٠');
  await expect(detail.locator('.customer-detail-stats > div').filter({ hasText: 'المديونية' })).toContainText('١٢٠');
  await expect(detail.locator('tbody tr')).toHaveCount(1);
  await detail.getByRole('button', { name: 'عرض الفاتورة' }).click();
  await expect(detail.locator('.invoice-print')).toContainText(name);
  await expect(detail.locator('.invoice-print')).toContainText(product.name);
  await detail.getByRole('button', { name: 'رجوع للحساب' }).click();

  // A confirmed invoice from another tab updates this open chart and its selected account.
  await send('/api/sales', { id: randomUUID(), customerId: customer.id, warehouseId: warehouse.id, paid: 0, lines: [{ productId: product.id, qty: 1, price: 40 }] });
  await expect(bar).toContainText('١٤٠', { timeout: 22000 });
  await expect(detail.locator('.customer-detail-stats > div').filter({ hasText: 'المديونية' })).toContainText('١٦٠', { timeout: 22000 });
  await expect(detail.locator('tbody tr')).toHaveCount(2);
  const row = page.locator('.customers-table tbody tr').filter({ hasText: name });
  // The regular customer list may be on another page; searching it is independent of the chart.
  await page.getByPlaceholder('اسم أو تليفون أو قرية').fill(name);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'المشتريات والفواتير' }).click();
  await expect(detail.getByRole('heading', { name })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
});

test('اختيار عميل آخر لا يعرض حساب العميل السابق لو الرد اتأخر', async ({ page }) => {
  await signInAsManager(page);
  const token = await page.evaluate(() => localStorage.getItem('mandoub.token'));
  const headers = { 'X-Mandoub-Token': token!, 'X-Mandoub-Client': 'admin' };
  const suffix = String(Date.now());
  const add = async (name: string) => {
    const r = await page.request.post('/api/customers', { headers, data: { name } });
    expect(r.ok(), await r.text()).toBeTruthy(); return (await r.json()).customer;
  };
  const a = await add(`سباق تحليل ألف ${suffix}`), b = await add(`سباق تحليل باء ${suffix}`);
  await page.getByRole('button', { name: 'العملاء', exact: true }).click();
  const chart = page.getByRole('region', { name: 'تحليل مشتريات العملاء' });
  await chart.getByLabel('بحث في الرسم').fill(`سباق تحليل`);
  const first = chart.getByRole('button', { name: new RegExp(`عرض حساب ${a.name}`) });
  const second = chart.getByRole('button', { name: new RegExp(`عرض حساب ${b.name}`) });
  await expect(first).toBeVisible(); await expect(second).toBeVisible();
  await page.route(`**/api/sales/customer-ranking/${a.id}?*`, async route => { await new Promise(resolve => setTimeout(resolve, 1200)); await route.continue(); });
  await first.click(); await second.click();
  const detail = page.getByRole('region', { name: 'تفاصيل العميل' });
  await expect(detail.getByRole('heading', { name: b.name })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(detail.getByRole('heading', { name: b.name })).toBeVisible();
  await expect(detail.getByRole('heading', { name: a.name })).toHaveCount(0);
});
