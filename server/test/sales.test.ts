import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Store } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

/**
 * The sales layer: catalogue, warehouses, the stock ledger and invoices.
 *
 * Two questions decide whether this is safe to run in production, and both are answered by the
 * server rather than the screen. First: can a warehouse account read the field? Second: can a client
 * talk the server into a number it did not compute — a total, a price, an invoice number, a stock
 * level? Every test below is one of those two, plus the arithmetic that follows from them.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 30, timezone: 'Africa/Cairo',
  adminEmail: 'admin@mandoub.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  // Every account in these tests is logged in for, and the login limiter counts addresses — the
  // default 15/minute is a real protection on a VPS and a false alarm inside one process.
  loginAccountLimit: 500, loginRateLimit: { windowMs: 60000, limit: 500 },
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

const DAY = 86400000;
const PASSWORD = 'Dashboard2026!';

/**
 * The client hint is part of the credential: a rep token sent with `X-Mandoub-Client: admin` is
 * refused on purpose, so the helper has to say which app it is pretending to be.
 */
async function login(email: string, password: string, clientKind: 'admin' | 'rep' = 'admin') {
  const res = await client.post('/api/auth/login').send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { Authorization: `Bearer ${res.body.token as string}`, 'X-Mandoub-Client': clientKind };
}
const admin = await login(config.adminEmail, config.adminPassword);

function addRep(name: string, email = `rep.${randomUUID()}@mandoub.test`) {
  const id = randomUUID();
  store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
    id, name, email, hashPassword('Rep1234!'), 'rep', Date.now());
  return { id, email };
}
async function rep(name: string) {
  const { id, email } = addRep(name);
  return { id, email, auth: await login(email, 'Rep1234!', 'rep') };
}
/** A dashboard account, created the way the manager creates one. */
async function staff(scope: 'sales' | 'stock', name = `حساب ${scope}`) {
  const email = `${scope}.${randomUUID()}@mandoub.test`;
  const created = await client.post('/api/staff').set(admin).send({ name, email, password: PASSWORD, scope });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { id: created.body.user.id as string, email, auth: await login(email, PASSWORD) };
}
async function newWarehouse(name = `مخزن ${randomUUID().slice(0, 6)}`) {
  const res = await client.post('/api/warehouses').set(admin).send({ name, governorate: 'الإسكندرية' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.warehouse as { id: string; name: string };
}
async function newProduct(name = `منتج ${randomUUID().slice(0, 6)}`, defaultPrice = 380) {
  const res = await client.post('/api/products').set(admin).send({ name, unit: 'كرتونة', defaultPrice });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.product as { id: string; name: string; defaultPrice: number };
}
async function customerOf(repId: string, name = `مزرعة ${randomUUID().slice(0, 6)}`) {
  const res = await client.post('/api/customers').set(admin).send({ name, repId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.customer.id as string;
}
/** `at` puts the movement on an earlier day — the manager's dated correction. */
async function move(warehouseId: string, productId: string, qty: number, kind: 'receipt' | 'count' | 'writeoff' | 'return' = 'receipt', at?: number) {
  const res = await client.post('/api/stock/movements').set(admin).send({ warehouseId, productId, qty, kind, ...(at ? { at } : {}) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.movement.onHand as number;
}
async function stockOf(warehouseId: string, productId: string) {
  const res = await client.get(`/api/stock?warehouseId=${warehouseId}`).set(admin);
  assert.equal(res.status, 200);
  return res.body.rows.find((row: any) => row.productId === productId);
}

test('the warehouse account sees the warehouses and nothing else', async () => {
  const warehouse = await staff('stock', 'مسؤول المخازن');
  const warehouseRow = await newWarehouse();
  const product = await newProduct();

  // What it is for.
  const list = await client.get('/api/products').set(warehouse.auth);
  assert.equal(list.status, 200);
  assert.ok(list.body.products.some((row: any) => row.id === product.id), 'the catalogue is what he is here for');
  const added = await client.post('/api/stock/movements').set(warehouse.auth).send({
    warehouseId: warehouseRow.id, productId: product.id, qty: 50, kind: 'receipt',
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const priced = await client.patch(`/api/products/${product.id}`).set(warehouse.auth).send({ defaultPrice: 410 });
  assert.equal(priced.status, 200);

  // Everything else on the dashboard is closed, whether it is a list, a write, or the live feed.
  for (const path of ['/api/overview', '/api/reps', '/api/customers', '/api/invoices', '/api/sales/summary', '/api/staff', '/api/visits']) {
    const res = await client.get(path).set(warehouse.auth);
    assert.equal(res.status, 403, `${path} must not answer for a warehouse account`);
    if (path !== '/api/visits') assert.equal(res.body.code, 'SCOPE_DENIED');
  }
  // Hoisted on purpose: building the outer request and then awaiting another one inside its body
   // overlaps two supertest calls on one server, which fails the harness, not the app.
  const customerId = await customerOf((await rep('مهندس')).id);
  const invoiceAttempt = await client.post('/api/invoices').set(warehouse.auth).send({
    customerId, warehouseId: warehouseRow.id, lines: [{ productId: product.id, qty: 1 }],
  });
  assert.equal(invoiceAttempt.status, 403, 'a warehouse cannot invent revenue');
});

test('only the manager account hands out dashboard logins', async () => {
  const office = await staff('sales', 'مدير المبيعات');
  const denied = await client.post('/api/staff').set(office.auth).send({ name: 'نسخة تانية مني', email: `x${Date.now()}@mandoub.test`, password: PASSWORD, scope: 'sales' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'MANAGER_ONLY');

  const short = await client.post('/api/staff').set(admin).send({ name: 'قصير', email: `s${Date.now()}@mandoub.test`, password: 'short1!', scope: 'stock' });
  assert.equal(short.status, 400, 'a dashboard account does not get a weak password because the client asked');

  // The scope of an account can be changed, but not in a way that leaves nobody able to fix it.
  const managerRow = store.get("SELECT id FROM users WHERE role='admin' AND scope=''")!;
  const demote = await client.patch(`/api/staff/${managerRow.id}`).set(admin).send({ scope: 'stock' });
  assert.equal(demote.status, 409);
  assert.equal(demote.body.code, 'LAST_MANAGER');

  const email = `gone.${randomUUID()}@mandoub.test`;
  const created = await client.post('/api/staff').set(admin).send({ name: 'هيتقفل', email, password: PASSWORD, scope: 'stock' });
  assert.equal(created.status, 201);
  const auth = await login(email, PASSWORD);
  assert.equal((await client.get('/api/warehouses').set(auth)).status, 200);
  const reset = await client.post(`/api/staff/${created.body.user.id}/password`).set(admin).send({ password: 'Another2026Pass!' });
  assert.equal(reset.status, 200);
  assert.equal((await client.get('/api/warehouses').set(auth)).status, 401, 'a new password must end every device signed in with the old one');
});

test('what is left is the sum of the ledger, and a count is a movement', async () => {
  const warehouse = await newWarehouse();
  const product = await newProduct('أسمنت النصر', 400);
  assert.equal(await stockOf(warehouse.id, product.id).then(row => row?.onHand ?? 0), 0, 'a new product is empty, not undefined');

  assert.equal(await move(warehouse.id, product.id, 100), 100);
  assert.equal(await move(warehouse.id, product.id, 20, 'return'), 120);
  // A count does not overwrite the number; it records the difference, so the audit trail explains it.
  assert.equal(await move(warehouse.id, product.id, 95, 'count'), 95);
  const movements = await client.get(`/api/stock/movements?warehouseId=${warehouse.id}&productId=${product.id}`).set(admin);
  assert.deepEqual(movements.body.movements.map((m: any) => [m.kind, m.qty]), [['count', -25], ['return', 20], ['receipt', 100]]);
  assert.ok(String(movements.body.movements[0].by).length > 1, 'every movement is signed with the account that wrote it');

  const same = await client.post('/api/stock/movements').set(admin).send({ warehouseId: warehouse.id, productId: product.id, qty: 95, kind: 'count' });
  assert.equal(same.status, 400);
  assert.equal(same.body.code, 'NO_CHANGE', 'a count that matches the books writes no row');

  // A writeoff is allowed to drive the shelf negative: reality wins, and the screen shows it in red.
  const deep = await client.post('/api/stock/movements').set(admin).send({ warehouseId: warehouse.id, productId: product.id, qty: 120, kind: 'writeoff' });
  assert.equal(deep.status, 201);
  assert.equal(deep.body.movement.onHand, -25);
  assert.equal((await stockOf(warehouse.id, product.id)).low, true);

  const saleByHand = await client.post('/api/stock/movements').set(admin).send({ warehouseId: warehouse.id, productId: product.id, qty: 5, kind: 'sale' });
  assert.equal(saleByHand.status, 400, 'a sale is written by an invoice, never by hand');
  const negative = await client.post('/api/stock/movements').set(admin).send({ warehouseId: warehouse.id, productId: product.id, qty: -5, kind: 'receipt' });
  assert.equal(negative.status, 400, 'the sign comes from the kind, so it cannot be argued with');
});

test('an invoice takes its numbers from the server, not from the browser', async () => {
  const engineer = await rep('أحمد شوقي');
  const warehouse = await newWarehouse();
  const product = await newProduct('جبس', 50);
  const customerId = await customerOf(engineer.id);
  await move(warehouse.id, product.id, 100);

  const body = {
    customerId, warehouseId: warehouse.id,
    lines: [{ productId: product.id, qty: 10 }, { productId: product.id, qty: 4, unitPrice: 45 }],
    discount: 20,
  };
  const created = await client.post('/api/invoices').set(admin).send(body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const invoice = created.body.invoice;
  // 10 × 50 + 4 × 45 = 680, less the discount. The line without a price took the catalogue's.
  assert.equal(invoice.subtotal, 680);
  assert.equal(invoice.total, 660);
  assert.equal(created.body.lines[0].unitPrice, 50);
  assert.equal(created.body.lines[1].lineTotal, 180);
  assert.equal(invoice.repId, engineer.id, 'the sale is credited to whoever owns the customer');
  assert.match(invoice.number, /^INV-\d{4}-0001$/);
  assert.equal(invoice.status, 'unpaid');
  assert.equal((await stockOf(warehouse.id, product.id)).onHand, 86, 'both lines left the warehouse');

  // A client that invents fields is refused rather than tolerated.
  const lying = await client.post('/api/invoices').set(admin).send({ ...body, total: 1, number: 'INV-1999-9999' });
  assert.equal(lying.status, 400, 'total and number are not inputs');

  const zero = await client.post('/api/invoices').set(admin).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 5 }], discount: 250 });
  assert.equal(zero.status, 400);
  assert.equal(zero.body.code, 'EMPTY_INVOICE', 'the discount cannot silently eat the invoice');

  const unknownProduct = await client.post('/api/invoices').set(admin).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: randomUUID(), qty: 1 }] });
  assert.equal(unknownProduct.status, 409);
  assert.equal(unknownProduct.body.code, 'PRODUCT_NOT_FOUND');
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM invoices')?.c), 1, 'and the failed attempt left no header row behind');
});

test('the number series never gets a hole, and voiding gives the goods back', async () => {
  const engineer = await rep('رضا شعبان');
  const warehouse = await newWarehouse();
  const product = await newProduct('مادة عازلة', 200);
  const customerId = await customerOf(engineer.id);
  await move(warehouse.id, product.id, 30);

  const first = await client.post('/api/invoices').set(admin).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 10 }] });
  const second = await client.post('/api/invoices').set(admin).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 3 }] });
  assert.equal(first.body.invoice.number.replace(/\d+(?=$)/, 'N'), second.body.invoice.number.replace(/\d+(?=$)/, 'N'));
  const noReason = await client.post(`/api/invoices/${first.body.invoice.id}/void`).set(admin).send({ reason: '' });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, 'REASON_REQUIRED');

  const voided = await client.post(`/api/invoices/${first.body.invoice.id}/void`).set(admin).send({ reason: 'العميل رجع البضاعة' });
  assert.equal(voided.status, 200);
  assert.equal(voided.body.restored, 1);
  assert.equal((await stockOf(warehouse.id, product.id)).onHand, 27, '30 in, 13 sold, the 10 that came back');

  const open = await client.get(`/api/invoices?customerId=${customerId}`).set(admin);
  assert.deepEqual(open.body.invoices.map((row: any) => row.number), [second.body.invoice.number], 'a voided invoice leaves the working list');
  const all = await client.get(`/api/invoices?customerId=${customerId}&includeVoided=1`).set(admin);
  assert.equal(all.body.invoices.length, 2);
  assert.equal(all.body.invoices.find((row: any) => row.id === first.body.invoice.id).voided, true);

  const third = await client.post('/api/invoices').set(admin).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 1 }] });
  // The counter moves forward even though 0001 was cancelled: the year series is compared by its
  // own tail, because other tests in this file have already drawn numbers from the same counter.
  const seq = (value: string) => Number(String(value).split('-').pop());
  assert.equal(seq(third.body.invoice.number), seq(second.body.invoice.number) + 1, 'a cancelled number is never handed out again');
  const againVoid = await client.post(`/api/invoices/${first.body.invoice.id}/void`).set(admin).send({ reason: 'تاني' });
  assert.equal(againVoid.status, 409);
});

test('selling more than the shelf holds is recorded and flagged, not refused', async () => {
  const engineer = await rep('ياسر منير');
  const warehouse = await newWarehouse();
  const product = await newProduct('بلاط', 120);
  const customerId = await customerOf(engineer.id);
  await move(warehouse.id, product.id, 8);

  const created = await client.post('/api/invoices').set(admin).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 20 }] });
  assert.equal(created.status, 201, 'the goods left, so the sale exists');
  assert.equal(created.body.invoice.stockShort, true);
  assert.equal((await stockOf(warehouse.id, product.id)).onHand, -12);

  const flagged = await client.get(`/api/invoices?stockShort=1&customerId=${customerId}`).set(admin);
  assert.equal(flagged.body.invoices.length, 1);
  const summary = await client.get('/api/sales/summary').set(admin);
  assert.equal(summary.body.totals.stockShort, 1);
});

test('the payment state comes from the amounts', async () => {
  const engineer = await rep('هاني صبري');
  const warehouse = await newWarehouse();
  const product = await newProduct('سيراميك', 100);
  const customerId = await customerOf(engineer.id);
  await move(warehouse.id, product.id, 50);
  const invoice = (await client.post('/api/invoices').set(admin).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 4 }] })).body.invoice;
  assert.equal(invoice.total, 400);

  const partial = await client.patch(`/api/invoices/${invoice.id}`).set(admin).send({ paidAmount: 150 });
  assert.equal(partial.body.invoice.status, 'partial');
  assert.equal(partial.body.invoice.paidAmount, 150);
  const paid = await client.patch(`/api/invoices/${invoice.id}`).set(admin).send({ paidAmount: 400 });
  assert.equal(paid.body.invoice.status, 'paid');

  const over = await client.patch(`/api/invoices/${invoice.id}`).set(admin).send({ paidAmount: 900 });
  assert.equal(over.status, 400);
  assert.equal(over.body.code, 'OVERPAYMENT', 'a payment bigger than the invoice means a second invoice was meant');
  const back = await client.patch(`/api/invoices/${invoice.id}`).set(admin).send({ paidAmount: 10 });
  assert.equal(back.status, 409);
  assert.equal(back.body.code, 'PAYMENT_ROLLBACK', 'money collected is not un-collected by editing a number');

  const lines = await client.patch(`/api/invoices/${invoice.id}`).set(admin).send({ lines: [] });
  assert.equal(lines.status, 400, 'an invoice line is never edited after the customer walked out with it');
});

test('the engineer reads his own invoices and the catalogue, and no more', async () => {
  const mine = await rep('مهندس ليا');
  const other = await rep('مهندس تاني');
  const warehouse = await newWarehouse();
  const product = await newProduct('شيكارة أسمنت', 60);
  await move(warehouse.id, product.id, 40);
  const mineId = await customerOf(mine.id, 'مزرعتي');
  const otherId = await customerOf(other.id, 'مزرعته');

  await client.post('/api/invoices').set(admin).send({ customerId: mineId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 5 }] });
  await client.post('/api/invoices').set(admin).send({ customerId: otherId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 7 }] });

  const list = await client.get('/api/my/invoices').set(mine.auth);
  assert.equal(list.status, 200);
  assert.equal(list.body.invoices.length, 1, 'he sees the ones that are his');
  assert.equal(list.body.invoices[0].customerName, 'مزرعتي');
  assert.equal(list.body.invoices[0].lines[0].qty, 5);
  assert.equal(list.body.outstanding, 300);

  // Prices and stock, so a promise made in a farm matches the truck; names of other engineers do not appear.
  const catalogue = await client.get('/api/my/catalogue').set(mine.auth);
  assert.equal(catalogue.status, 200);
  const mine2 = catalogue.body.products.find((row: any) => row.id === product.id);
  assert.deepEqual(mine2, {
    id: product.id, name: 'شيكارة أسمنت', unit: 'كرتونة', price: 60, onHand: 28,
    warehouses: [{ name: warehouse.name, onHand: 28 }],
  }, 'the engineer sees the price and what is left, and that is all');

  const wholeCompany = await client.get('/api/invoices').set(mine.auth);
  assert.equal(wholeCompany.status, 403);
  const numbers = await client.get('/api/sales/summary').set(mine.auth);
  assert.equal(numbers.status, 403);
  const writeAttempt = await client.post('/api/invoices').set(other.auth).send({ customerId: mineId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 1 }] });
  assert.equal(writeAttempt.status, 403, 'nobody invoices against a colleague’s customer');
});

test('the sales office sees the numbers, and a manager can point a sale at another engineer', async () => {
  const aly = await rep('علي حسن');
  const said = await rep('سعيد مبروك');
  const office = await staff('sales', 'مكتب المبيعات');
  const warehouse = await newWarehouse();
  const product = await newProduct('دهان', 30);
  const customerId = await customerOf(aly.id, 'عميل مشترك');
  await move(warehouse.id, product.id, 100);

  await client.post('/api/invoices').set(office.auth).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 10 }] });
  // A manager correcting a mis-credited sale; the office account cannot do this, because moving
  // revenue between people is not a data-entry decision.
  const moved = await client.post('/api/invoices').set(admin).send({ customerId, warehouseId: warehouse.id, repId: said.id, lines: [{ productId: product.id, qty: 6 }] });
  assert.equal(moved.body.invoice.repId, said.id);
  const forced = await client.post('/api/invoices').set(office.auth).send({ customerId, warehouseId: warehouse.id, repId: said.id, lines: [{ productId: product.id, qty: 1 }] });
  assert.equal(forced.status, 201, 'a scope that can write invoices is not refused for naming a rep…');
  assert.equal(forced.body.invoice.repId, aly.id, '…it is simply ignored, and the customer’s owner stands');

  // Scoped to this test's warehouse: the file shares one database, and a company-wide total here
  // would be a count of every other test's invoices.
  const summary = await client.get(`/api/sales/summary?warehouseId=${warehouse.id}`).set(office.auth);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.totals.count, 3);
  assert.equal(summary.body.totals.total, 510);
  assert.deepEqual(summary.body.byRep.map((row: any) => [row.repName, row.total]), [['علي حسن', 330], ['سعيد مبروك', 180]]);
  assert.deepEqual(summary.body.topProducts[0], { productId: product.id, productName: 'دهان', unit: 'كرتونة', qty: 17, revenue: 510 });
  assert.equal(summary.body.balances[0].outstanding, 510);

  const filtered = await client.get(`/api/sales/summary?repId=${said.id}&warehouseId=${warehouse.id}`).set(office.auth);
  assert.equal(filtered.body.totals.count, 1);
  const unpaid = await client.get(`/api/invoices?status=unpaid&customerId=${customerId}`).set(office.auth);
  assert.equal(unpaid.body.invoices.length, 3, 'the office sees every invoice on this customer');
});

test('the sales office reads the shelves but does not price them', async () => {
  const office = await staff('sales', 'مكتب المبيعات');
  const warehouse = await newWarehouse();
  const product = await newProduct('بودرة معدنية', 90);
  await move(warehouse.id, product.id, 40);

  // Reading is the whole job here: a quotation cannot be written without the price and the level.
  const stock = await client.get(`/api/stock?warehouseId=${warehouse.id}`).set(office.auth);
  assert.equal(stock.status, 200);
  const row = stock.body.rows.find((item: any) => item.productId === product.id);
  assert.equal(row.onHand, 40);
  const catalogue = await client.get('/api/products').set(office.auth);
  assert.equal(catalogue.status, 200);

  // One at a time, and awaited on its own line: building several supertest requests inside one
  // expression is what makes supertest reach for a server address it has already torn down.
  const addProduct = await client.post('/api/products').set(office.auth).send({ name: 'صنف من المكتب', defaultPrice: 10 });
  assert.equal(addProduct.status, 403, 'the catalogue belongs to the warehouse account');
  assert.equal(addProduct.body.code, 'STOCK_WRITE_ONLY');
  const reprice = await client.patch(`/api/products/${product.id}`).set(office.auth).send({ defaultPrice: 100 });
  assert.equal(reprice.status, 403);
  assert.equal(reprice.body.code, 'STOCK_WRITE_ONLY');
  const handMove = await client.post('/api/stock/movements').set(office.auth).send({ warehouseId: warehouse.id, productId: product.id, qty: 5, kind: 'receipt' });
  assert.equal(handMove.status, 403);
  assert.equal(handMove.body.code, 'STOCK_WRITE_ONLY');
  const addWarehouse = await client.post('/api/warehouses').set(office.auth).send({ name: 'مخزن المكتب' });
  assert.equal(addWarehouse.status, 403);
  assert.equal(addWarehouse.body.code, 'STOCK_WRITE_ONLY');

  // The manager keeps the override — a typo found at 11 p.m. still gets fixed.
  const override = await client.patch(`/api/products/${product.id}`).set(admin).send({ defaultPrice: 95 });
  assert.equal(override.status, 200);

  // The office can still sell, and selling is what moves the shelf: the invoice route writes the
  // movement itself, so the rule above must not stand in its way.
  const repId = (await rep('مهندس المكتب')).id;
  const customerId = await customerOf(repId, 'عميل المكتب');
  const invoice = await client.post('/api/invoices').set(office.auth).send({
    customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 6 }],
  });
  assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
  assert.equal(invoice.body.lines.length, 1);
  assert.equal(invoice.body.invoice.lines, undefined, 'the header is returned on its own; lines come from their route');
  const after = await client.get(`/api/stock?warehouseId=${warehouse.id}`).set(office.auth);
  assert.equal(after.body.rows.find((item: any) => item.productId === product.id).onHand, 34);
});

test('an engineer can ask what one customer owes, and nothing more', async () => {
  const me = await rep('مهندس التحصيل');
  const auth = await login(me.email, 'Rep1234!', 'rep');
  const mine = await customerOf(me.id, 'مزرعة ليها فاتورة');
  const other = await customerOf(me.id, 'مزرعة تانية');
  const warehouse = await newWarehouse();
  const product = await newProduct('أسمنت أبيض', 250);
  await move(warehouse.id, product.id, 20);
  const billed = await client.post('/api/invoices').set(admin).send({
    customerId: mine, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 4 }], paidAmount: 300,
  });
  assert.equal(billed.status, 201, JSON.stringify(billed.body));

  const all = await client.get('/api/my/invoices').set(auth).send();
  assert.equal(all.status, 200);
  assert.equal(all.body.outstanding, 700, 'the 1000-pound invoice, less the 300 collected');

  const one = await client.get(`/api/my/invoices?customerId=${mine}`).set(auth).send();
  assert.equal(one.status, 200);
  assert.equal(one.body.invoices.length, 1);
  assert.equal(one.body.outstanding, 700);

  // A different customer of the same engineer answers with nothing, not with the other balance.
  const empty = await client.get(`/api/my/invoices?customerId=${other}`).set(auth).send();
  assert.equal(empty.body.invoices.length, 0);
  assert.equal(empty.body.outstanding, 0);

  // A farm that belongs to somebody else is not a window into that account either.
  const stranger = await rep('مهندس تاني');
  const strangerId = stranger.id;
  const peek = await client.get(`/api/my/invoices?customerId=${strangerId}`).set(auth).send();
  assert.equal(peek.status, 200);
  assert.equal(peek.body.invoices.length, 0, 'the filter narrows his own rows; it never widens them');
});

test('the engineer books his own invoice and it lands on his customer in the dashboard', async () => {
  const repRow = await rep('مهندس الكارنية');
  const auth = repRow.auth;
  const warehouse = await newWarehouse();
  const product = await newProduct('لابداه ٢٥ كيلو', 400);
  await move(warehouse.id, product.id, 30);
  const customerId = await customerOf(repRow.id, 'عمارة الكارنية');

  // He tried to invent a price and a discount. Neither is his to decide: the catalogue prices and
  // the office discounts. He may name himself, and only himself, on the sale.
  const written = await client.post('/api/my/invoices').set(auth).send({
    customerId, warehouseId: warehouse.id,
    lines: [{ productId: product.id, qty: 4, unitPrice: 1 }],
    discount: 500, repId: repRow.id,
  });
  assert.equal(written.status, 201, JSON.stringify(written.body));
  const invoice = written.body.invoice;
  assert.equal(invoice.total, 1600, 'four at the catalogue price — the invented unitPrice and discount were ignored');
  assert.equal(invoice.discount, 0);
  assert.equal(invoice.paidAmount, 0, 'nothing was collected, so nothing is claimed');
  assert.equal(invoice.status, 'unpaid');
  assert.equal(invoice.source, 'field', 'the dashboard can see who typed it');
  assert.equal(invoice.customerName, 'عمارة الكارنية', 'and on whose name it landed');

  assert.equal((await stockOf(warehouse.id, product.id)).onHand, 26, 'the shelf moved on his sale, no separate trip to the office');

  const list = await client.get(`/api/invoices?customerId=${customerId}`).set(admin);
  assert.equal(list.body.invoices.length, 1);
  assert.equal(list.body.invoices[0].number, invoice.number, 'the office reads the same row he wrote');

  const counted = await client.get(`/api/sales/summary?warehouseId=${warehouse.id}`).set(admin);
  assert.equal(counted.body.bySource.field.invoices, 1);
  assert.equal(counted.body.bySource.field.total, 1600);

  // He cannot sell for a farmer who is not his, and he cannot re-point his own sale at a colleague.
  const other = await rep('مهندس تاني');
  const foreignCustomer = await customerOf(other.id, 'مزرعة مش بتاعته');
  const stolen = await client.post('/api/my/invoices').set(auth).send({ customerId: foreignCustomer, lines: [{ productId: product.id, qty: 1 }] });
  assert.equal(stolen.status, 403);
  assert.equal(stolen.code ?? stolen.body.code, 'CUSTOMER_NOT_OWNED');

  // An invoice he typed is his to cancel while it is only his — and not one coin recorded against it.
  const voided = await client.post(`/api/my/invoices/${invoice.id}/void`).set(auth).send({ reason: 'كمية غلط' });
  assert.equal(voided.status, 200, JSON.stringify(voided.body));
  assert.equal((await stockOf(warehouse.id, product.id)).onHand, 30, 'and the bags go back on the shelf');

  const billed = await client.post('/api/my/invoices').set(auth).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 2 }], paidAmount: 100 });
  assert.equal(billed.body.invoice.paidAmount, 100, 'the cash he took is on the row the office then reads');
  assert.equal(billed.body.invoice.status, 'partial');
  const paid = await client.post(`/api/my/invoices/${billed.body.invoice.id}/void`).set(auth).send({ reason: 'هشيل الفاتورة' });
  assert.equal(paid.status, 409, 'a sale with money collected on it is the office’s to undo');
  assert.equal(paid.body.code, 'HAS_PAYMENT');
});

test('the monthly statement closes on the shelf, and the clerk sees counts not prices', async () => {
  const warehouse = await newWarehouse();
  const product = await newProduct('سيراميك ٦٠', 120);
  const since = Date.now() - 3 * 86400000;
  await move(warehouse.id, product.id, 100);            // the receipt
  await move(warehouse.id, product.id, 7, 'writeoff');  // seven bags broke on the floor: −7
  await move(warehouse.id, product.id, 140, 'count');   // a count states the level it found, so +47
  const repRow = await rep('مهندس الجرد');
  const customerId = await customerOf(repRow.id, 'عميل الجرد');
  await client.post('/api/my/invoices').set(repRow.auth).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 13 }] });

  const report = await client.get(`/api/stock/report?warehouseId=${warehouse.id}&from=${since}&to=${Date.now() + 86400000}`).set(admin);
  assert.equal(report.status, 200);
  const row = report.body.rows.find((item: any) => item.productId === product.id);
  assert.ok(row, 'the product is in the statement');
  assert.equal(row.inQty, 100, 'the receipt is what came in');
  assert.equal(row.outQty, 13, 'the sale is what went out');
  assert.equal(row.adjustments, 40, 'a 47-bag count correction and seven broken bags');
  assert.equal(row.closing, 100 + 40 - 13, 'opening + in + adjustments − out = what is on the shelf');
  assert.equal(row.closing, (await stockOf(warehouse.id, product.id)).onHand, 'and it equals the live figure, not somebody’s memory');
  assert.equal(row.closingValue, row.closing * 120, 'the manager sees the value');
  assert.equal(report.body.totals.closingValue, row.closingValue);

  const clerk = await staff('stock', 'بتاع الجرد');
  const theirs = await client.get(`/api/stock/report?warehouseId=${warehouse.id}&from=${since}&to=${Date.now() + 86400000}`).set(clerk.auth);
  assert.equal(theirs.status, 200, 'the statement is his own paperwork');
  assert.equal(theirs.body.valuesVisible, false);
  const clerkRow = theirs.body.rows.find((item: any) => item.productId === product.id);
  assert.equal(clerkRow.closing, row.closing, 'he reads the same quantities');
  assert.equal(clerkRow.closingValue, undefined, 'and none of the money');
  assert.equal(clerkRow.price, undefined, 'not even the price he is not allowed to change');
  assert.equal(theirs.body.ledger[0].value, undefined, 'the ledger rows carry no value either');
  assert.ok(theirs.body.ledger.some((item: any) => item.kind === 'sale' && item.invoiceNumber), 'the movement says which invoice took the goods');

  const bogus = await client.get(`/api/stock/report?from=${Date.now()}&to=${since}`).set(admin);
  assert.equal(bogus.status, 400);
});

test('the engineer sees his own draws from the shelf, without the money', async () => {
  const warehouse = await newWarehouse();
  const otherStore = await newWarehouse('مخزن تاني للجرد');
  const product = await newProduct('بوصية ٢ بوصة', 60);
  // The receipt is dated before the window on purpose: that is what a monthly statement is for — the
  // opening figure is the shelf as it stood when the month started, not the movements inside it.
  await move(warehouse.id, product.id, 50, 'receipt', Date.now() - 5 * 86400000);
  const mine = await rep('مهندس البوص');
  const theirs = await rep('مهندس تاني على نفس الصنف');
  const myCustomer = await customerOf(mine.id, 'عميل البوص');
  const theirCustomer = await customerOf(theirs.id, 'عميل البوص التاني');
  await client.post('/api/my/invoices').set(mine.auth).send({ customerId: myCustomer, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 8 }] });
  await client.post('/api/invoices').set(admin).send({ customerId: theirCustomer, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 5 }] });
  await move(otherStore.id, product.id, 200);

  const since = Date.now() - 3 * 86400000;
  const report = await client.get(`/api/my/stock/report?from=${since}&to=${Date.now() + 86400000}`).set(mine.auth);
  assert.equal(report.status, 200);
  assert.equal(report.body.valuesVisible, false, 'no price column on a phone');
  const row = report.body.rows.find((item: any) => item.productName === 'بوصية ٢ بوصة');
  assert.ok(row, 'his own draw is on the sheet');
  assert.equal(row.outQty, 8, 'eight pieces, which is what he handed over');
  assert.equal(row.closing, 37, 'and the shelf level he has to quote from — the office took five of them too');

  const list = await client.get(`/api/my/stock/report?from=${since}&to=${Date.now() + 86400000}`).set(theirs.auth);
  const theirRow = list.body.rows.find((item: any) => item.productName === 'بوصية ٢ بوصة');
  assert.ok(!theirRow || theirRow.outQty !== 8, 'and he cannot read another engineer\'s sales out of it');
  assert.ok(report.body.ledger.every((item: any) => item.invoiceNumber), 'every line names the invoice that moved it');
  assert.equal(report.body.ledger[0].price, undefined);
  assert.equal(report.body.ledger[0].value, undefined);
});

test('a dated correction is the manager’s, and a dated lie is not anybody’s', async () => {
  const warehouse = await newWarehouse();
  const product = await newProduct('اسمنت dated', 320);
  const past = Date.now() - 12 * 86400000;
  const clerk = await staff('stock', 'بتاع حركة قديمة');
  const office = await staff('sales', 'مكتب حركة قديمة');

  // The clerk is the one standing at the shelf, and his entry is the level today — never last week.
  const denied = await client.post('/api/stock/movements').set(clerk.auth).send({ warehouseId: warehouse.id, productId: product.id, qty: 10, kind: 'receipt', at: past });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'BACKDATE_MANAGER_ONLY');
  const officeDenied = await client.post('/api/stock/movements').set(office.auth).send({ warehouseId: warehouse.id, productId: product.id, qty: 10, kind: 'receipt', at: past });
  assert.equal(officeDenied.status, 403, 'a count of the shelf is not the office’s to backdate either');

  const fixed = await client.post('/api/stock/movements').set(admin).send({ warehouseId: warehouse.id, productId: product.id, qty: 10, kind: 'receipt', at: past });
  assert.equal(fixed.status, 201, JSON.stringify(fixed.body));
  assert.equal(fixed.body.movement.backdated, true);
  assert.equal(fixed.body.movement.createdAt, past, 'the row is filed on the day it happened');
  assert.equal(fixed.body.movement.onHand, 10, 'and the level shown is today’s');

  // «the level on that day was X» cannot be honoured with a delta against today.
  const badCount = await client.post('/api/stock/movements').set(admin).send({ warehouseId: warehouse.id, productId: product.id, qty: 40, kind: 'count', at: past });
  assert.equal(badCount.status, 400);
  assert.equal(badCount.body.code, 'BACKDATE_KIND');

  // The same truck typed twice, once on the day and once as a correction, is refused rather than
  // doubling the shelf.
  const twin = await client.post('/api/stock/movements').set(admin).send({ warehouseId: warehouse.id, productId: product.id, qty: 10, kind: 'receipt', at: past + 2 * 86400000 });
  assert.equal(twin.status, 409);
  assert.equal(twin.body.code, 'BACKDATE_CONFLICT');
  assert.equal((await stockOf(warehouse.id, product.id)).onHand, 10, 'and the shelf never moved twice');

  // A month statement reads the dated row where it belongs, not where it was typed.
  const monthAgo = Date.now() - 30 * 86400000;
  const statement = await client.get(`/api/stock/report?warehouseId=${warehouse.id}&from=${monthAgo}&to=${Date.now() + 86400000}`).set(admin);
  const row = statement.body.rows.find((item: any) => item.productId === product.id);
  assert.ok(row.inQty > 0, 'the receipt lands inside the window it is dated in');
  assert.equal(row.opening, 0, 'nothing was on the shelf before it');
});

test('the money record outlives retention and the people in it', async () => {
  const doomed = addRep('حسام إبراهيم');
  const warehouse = await newWarehouse();
  const product = await newProduct('طوب', 2);
  const customerId = await customerOf(doomed.id, 'عميل هيمشي');
  await move(warehouse.id, product.id, 1000);
  const invoice = (await client.post('/api/invoices').set(admin).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 100 }], paidAmount: 50 })).body.invoice;
  assert.equal(invoice.status, 'partial');

  store.run('UPDATE users SET created_at=?, last_seen=? WHERE id=?', Date.now() - 400 * DAY, Date.now() - 400 * DAY, doomed.id);
  store.run("UPDATE customers SET created_at=?, updated_at=? WHERE id=?", Date.now() - 400 * DAY, Date.now() - 400 * DAY, customerId);
  store.cleanup(30);
  assert.ok(store.get('SELECT id FROM invoices WHERE id=?', invoice.id), 'an invoice never ages out of the register');
  assert.ok(store.get('SELECT id FROM customers WHERE id=?', customerId));
  assert.ok(Number(store.get('SELECT COUNT(*) AS c FROM stock_movements')?.c) >= 2);

  // The man leaves; the sale stays, and is still attributable to the customer row.
  store.run('DELETE FROM users WHERE id=?', doomed.id);
  const row = store.get('SELECT rep_id, customer_name, total FROM invoices WHERE id=?', invoice.id)!;
  assert.equal(row.rep_id, null, 'a deleted engineer nulls the credit, it does not delete the sale');
  assert.equal(row.customer_name, 'عميل هيمشي', 'and the name on the invoice is the one from the day it was written');
  const after = await client.get('/api/sales/summary').set(admin);
  assert.ok(after.body.byRep.some((entry: any) => entry.repName === 'بدون مهندس'), 'the orphaned sale is shown, not hidden');
});

/* ------------------------------------------------------------------ التحصيل والأهداف */

/** The day the server will read, in its own timezone — no SQLite clock tricks. */
const CAIRO_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
const serverDay = () => CAIRO_DAY.format(new Date());
/** A window that surely contains the row that was just written. */
const windowQuery = (extra = '') => `from=${Date.now() - 3 * DAY}&to=${Date.now() + DAY}${extra}`;
const collectionRows = async (auth: Record<string, string>, extra = '') =>
  (await client.get(`/api/collections?${windowQuery(extra)}`).set(auth)).body;

test('a collection is an event: an edit writes the difference, not the new total', async () => {
  const engineer = await rep('ياسر تحصيل');
  const warehouse = await newWarehouse();
  const product = await newProduct(`أسمنت مقاوم ${randomUUID().slice(0, 6)}`, 400);
  const customerId = await customerOf(engineer.id);
  await move(warehouse.id, product.id, 50);

  const invoice = (await client.post('/api/invoices').set(admin).send({
    customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 10 }], paidAmount: 500,
  })).body.invoice;
  assert.equal(invoice.total, 4000);

  // Typing 1500 into a box that means «total paid» must not book 1500 of cash on top of the 500.
  const patched = await client.patch(`/api/invoices/${invoice.id}`).set(admin).send({ paidAmount: 1500 });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.invoice.paidAmount, 1500);

  const report = await collectionRows(admin, `&repId=${engineer.id}`);
  assert.equal(report.totals.collected, 1500, 'the register sums the events, and the events are the deltas');
  assert.equal(report.totals.entries, 2);
  assert.deepEqual(report.entries.map((row: any) => row.amount).sort((a: number, b: number) => a - b), [500, 1000]);
  const row = report.byRep.find((entry: any) => entry.repId === engineer.id);
  assert.equal(row.collected, 1500);
  assert.equal(row.fromOffice, 1500, 'the office typed both, so none of it is the engineer’s cash');
  assert.equal(row.fromField, 0);
  assert.equal(row.outstanding, 2500, 'what was paid is shown next to what is still owed');
  assert.equal(row.openInvoices, 1);
  assert.equal(report.byCustomer[0].collected, 1500);
  const adminName = String(store.get("SELECT name FROM users WHERE role='admin' LIMIT 1")!.name);
  assert.equal(report.entries[0].recordedBy, adminName, 'and every entry says who typed it, not only whose money it is');

  // Money does not walk backwards through the invoice editor: voiding is the correction path.
  const rollback = await client.patch(`/api/invoices/${invoice.id}`).set(admin).send({ paidAmount: 200 });
  assert.equal(rollback.status, 409);
  assert.equal(rollback.body.code, 'PAYMENT_ROLLBACK');

  // The register and the invoice books are written together, so they agree: that is the one check on
  // this screen that tells an office whether it is looking at money or at a half-migrated database.
  assert.equal(Math.abs(report.lifetime.difference) < 0.01, true, 'no drift between what was banked and what was registered');

  // A bill with no cash on it is not a collection, so the register stays a record of money.
  await client.post('/api/invoices').set(admin).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 1 }] });
  assert.equal((await collectionRows(admin, `&repId=${engineer.id}`)).totals.entries, 2, 'no entry for a zero payment');

  // An engineer may not read the company's cash register — only his own month.
  assert.equal((await client.get('/api/collections').set(engineer.auth)).status, 403);

  // And the warehouse account, whose dashboard is shelves and nothing else, is refused by the same
  // allowlist that guards every other money route — the register is not its to read.
  const clerk = await staff('stock');
  assert.equal((await client.get(`/api/collections?${windowQuery()}`).set(clerk.auth)).status, 403);
  assert.equal((await client.put('/api/targets').set(clerk.auth).send({ month: serverDay().slice(0, 7), revenue: 1 })).status, 403);
});

test('voiding a paid invoice moves the cash back out of the register', async () => {
  const engineer = await rep('رضا رجيع');
  const warehouse = await newWarehouse();
  const product = await newProduct(`بوية ${randomUUID().slice(0, 6)}`, 250);
  const customerId = await customerOf(engineer.id);
  await move(warehouse.id, product.id, 20);
  const invoice = (await client.post('/api/invoices').set(admin).send({
    customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 8 }], paidAmount: 2000,
  })).body.invoice;

  assert.equal((await collectionRows(admin, `&repId=${engineer.id}`)).byRep[0].collected, 2000);

  const voided = await client.post(`/api/invoices/${invoice.id}/void`).set(admin).send({ reason: 'العميل رجع البضاعة' });
  assert.equal(voided.status, 200, JSON.stringify(voided.body));

  const after = await collectionRows(admin, `&repId=${engineer.id}`);
  assert.equal(after.totals.collected, 0, 'the money that went back out is an entry, not a vanished row');
  assert.equal(after.totals.entries, 2, 'the trail keeps both: 2000 in, 2000 out');
  const reversal = after.entries.find((entry: any) => entry.amount < 0);
  assert.ok(reversal, 'a negative entry exists');
  assert.match(reversal.note, /إلغاء الفاتورة/);
  assert.equal(after.byRep[0].outstanding, 0, 'a voided bill stops being somebody’s outstanding balance');
});

test('the engineer books the cash he took, on his own bill, and never more than it owes', async () => {
  const mine = await rep('مهندس الكاش');
  const colleague = await rep('مهندس جنبه');
  const warehouse = await newWarehouse();
  const product = await newProduct(`سيراميك 60 ${randomUUID().slice(0, 6)}`, 300);
  await move(warehouse.id, product.id, 20);
  const customerId = await customerOf(mine.id);

  const created = await client.post('/api/my/invoices').set(mine.auth).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 4 }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.invoice.id as string;
  assert.equal(created.body.invoice.total, 1200);

  const paid = await client.post(`/api/my/invoices/${id}/pay`).set(mine.auth).send({ amount: 700, note: 'كاش من صاحب المزرعة' });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.collected, 700);
  assert.equal(paid.body.invoice.paidAmount, 700);
  assert.equal(paid.body.invoice.status, 'partial');

  const over = await client.post(`/api/my/invoices/${id}/pay`).set(mine.auth).send({ amount: 600 });
  assert.equal(over.status, 400);
  assert.equal(over.body.code, 'OVERPAYMENT', 'the rest belongs on a second bill, not on this one');
  assert.equal((await client.post(`/api/my/invoices/${id}/pay`).set(mine.auth).send({ amount: -700 })).status, 400, 'no undo from the field');
  assert.equal((await client.post(`/api/my/invoices/${id}/pay`).set(mine.auth).send({ amount: 500 })).status, 200, 'and the exact remainder closes it');

  const stolen = await client.post(`/api/my/invoices/${id}/pay`).set(colleague.auth).send({ amount: 100 });
  assert.equal(stolen.status, 403, 'a bill is only paid by the engineer it belongs to');
  const byOffice = await client.post(`/api/my/invoices/${id}/pay`).set(admin).send({ amount: 100 });
  assert.equal(byOffice.status, 403, 'the office uses its own endpoint, so the source stays honest');

  const report = await collectionRows(admin, `&repId=${mine.id}`);
  assert.equal(report.totals.collected, 1200);
  assert.equal(report.byRep[0].fromField, 1200, 'his cash is credited as his, typed by him');
  assert.equal(report.byRep[0].fromOffice, 0);
  assert.ok(report.entries.every((entry: any) => entry.source === 'field'));
  assert.equal(report.byRep[0].openInvoices, 0, 'paid in full, so it is off the follow-up list');
});

test('the office and the field are two hands on the same invoice', async () => {
  const engineer = await rep('مهندس تقسيم');
  const warehouse = await newWarehouse();
  const product = await newProduct(`جبس ${randomUUID().slice(0, 6)}`, 100);
  await move(warehouse.id, product.id, 40);
  const customerId = await customerOf(engineer.id);

  const his = (await client.post('/api/my/invoices').set(engineer.auth).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 10 }] })).body.invoice;
  const ours = (await client.post('/api/invoices').set(admin).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 10 }], paidAmount: 400 })).body.invoice;
  assert.equal(his.total, 1000);
  assert.equal(ours.total, 1000);

  const report = await collectionRows(admin, `&repId=${engineer.id}`);
  assert.equal(report.totals.collected, 400);
  assert.equal(report.byRep[0].fromField, 0);
  assert.equal(report.byRep[0].fromOffice, 400);

  const open = await client.get(`/api/invoices?open=1&repId=${engineer.id}`).set(admin);
  assert.equal(open.status, 200);
  assert.equal(open.body.invoices.length, 2, 'open=1 keeps a half-paid bill in the follow-up list, not only an untouched one');
  assert.deepEqual([...new Set(open.body.invoices.map((bill: any) => bill.status))].sort(), ['partial', 'unpaid']);

  const rest = await client.patch(`/api/invoices/${ours.id}`).set(admin).send({ paidAmount: 1000 });
  assert.equal(rest.body.invoice.status, 'paid');
  const settled = await collectionRows(admin, `&repId=${engineer.id}`);
  assert.equal(settled.totals.collected, 1000, '400 banked at the desk, 600 banked after it');
  assert.equal(settled.entries.length, 2, 'two entries, and the second one is 600 not 1000');
  assert.equal((await client.get(`/api/invoices?open=1&repId=${engineer.id}`).set(admin)).body.invoices.length, 1, 'that bill leaves the list, the other stays');
});

test('a target is a plan: the manager writes it, the invoices measure it', async () => {
  const engineer = await rep('مهندس هدف');
  const warehouse = await newWarehouse();
  const product = await newProduct(`أسمنت ${randomUUID().slice(0, 6)}`, 500);
  const customerId = await customerOf(engineer.id);
  await move(warehouse.id, product.id, 20);
  const month = (await client.get('/api/targets').set(admin)).body.month as string;

  const set = await client.put('/api/targets').set(admin).send({ month, repId: engineer.id, revenue: 5000, invoices: 2, note: 'نص الشهر للمقاولات' });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  // Writing the same plan twice updates it instead of appending a history nobody asked for.
  await client.put('/api/targets').set(admin).send({ month, repId: engineer.id, revenue: 5000, invoices: 2, note: 'اتعدل' });
  await client.put('/api/targets').set(admin).send({ month, repId: null, revenue: 10, invoices: 0 });
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM sales_targets WHERE month=?', month)!.c), 2, 'one row for the engineer, one for the company');
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM sales_targets WHERE month=? AND rep_id IS NULL', month)!.c), 1, 'the company plan is the NULL row, not a fake engineer');

  const before = await client.get(`/api/targets?month=${month}`).set(admin);
  const planned = before.body.reps.find((entry: any) => entry.repId === engineer.id);
  assert.equal(planned.target, 5000);
  assert.equal(planned.invoiceTarget, 2);
  assert.equal(planned.note, 'اتعدل', 'and the last write is the plan, not the first one');
  assert.equal(planned.revenue, 0, 'nothing sold yet — the percentage is computed from the register, never stored next to the target');
  assert.equal(planned.progress, 0);
  assert.ok(before.body.reps.some((entry: any) => entry.repId !== engineer.id && entry.target === 0), 'an engineer with no plan is listed anyway, at zero');

  await client.post('/api/invoices').set(admin).send({ customerId, warehouseId: warehouse.id, lines: [{ productId: product.id, qty: 8 }], paidAmount: 1000 });
  const measured = (await client.get(`/api/targets?month=${month}`).set(admin)).body.reps.find((entry: any) => entry.repId === engineer.id);
  assert.equal(measured.revenue, 4000, 'eight at 500: the invoices are the measurement');
  assert.equal(measured.invoices, 1);
  assert.equal(measured.collected, 1000);
  assert.equal(measured.progress, 80);
  assert.equal(measured.remaining, 1000);

  const mine = await client.get('/api/my/targets').set(engineer.auth);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.target.revenue, 5000, 'he sees his own plan');
  assert.equal(mine.body.target.revenueProgress, 80);
  assert.equal(mine.body.sold.revenue, 4000);
  assert.ok(mine.body.daysLeft >= 0);
  const unplanned = await rep('زميل من غير هدف');
  const colleague = await client.get('/api/my/targets').set(unplanned.auth);
  assert.equal(colleague.body.target, null, 'and nobody else’s — including the company number');

  // Who may write a plan.
  const office = await staff('sales');
  assert.equal((await client.put('/api/targets').set(office.auth).send({ month, repId: engineer.id, revenue: 1 })).status, 403, 'the sales office cannot set a target');
  assert.equal((await client.put('/api/targets').set(engineer.auth).send({ month, repId: engineer.id, revenue: 1 })).status, 403, 'and neither can the engineer it is for');
  assert.equal((await client.get(`/api/targets?month=${month}`).set(office.auth)).status, 200, 'but the office reads the same board');
  assert.equal((await client.put('/api/targets').set(admin).send({ month, repId: randomUUID(), revenue: 1 })).status, 409, 'a plan for a man who does not exist is refused');
  assert.equal((await client.put('/api/targets').set(admin).send({ month: '2026-13', revenue: 1 })).status, 400, 'a month that does not exist is refused, not clipped');
  assert.equal((await client.get('/api/targets?month=2026-13').set(admin)).status, 400);
});

test('the money columns ride along with the KPI table, and so with the export', async () => {
  const engineer = await rep('مهندس مؤشرات');
  const warehouse = await newWarehouse();
  const paint = await newProduct(`بوية بلاستيك ${randomUUID().slice(0, 6)}`, 240);
  const tiles = await newProduct(`سيراميك ${randomUUID().slice(0, 6)}`, 190);
  const customerId = await customerOf(engineer.id);
  await move(warehouse.id, paint.id, 30);
  await move(warehouse.id, tiles.id, 10);
  const today = serverDay();
  await client.put('/api/targets').set(admin).send({ month: today.slice(0, 7), repId: engineer.id, revenue: 1000 });
  // Set the company plan here rather than reading whatever an earlier test left: the number on the
  // company row is the company's, and it has to be the one this screen is showing.
  await client.put('/api/targets').set(admin).send({ month: today.slice(0, 7), repId: null, revenue: 777000 });
  await client.post('/api/invoices').set(admin).send({
    customerId, warehouseId: warehouse.id,
    lines: [{ productId: paint.id, qty: 10 }, { productId: tiles.id, qty: 1 }], paidAmount: 600,
  });

  const res = await client.get(`/api/kpis?from=${today}&to=${today}`).set(admin);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = res.body.rows.find((entry: any) => entry.repId === engineer.id);
  assert.equal(row.revenue, 2590);
  assert.equal(row.invoices, 1);
  assert.equal(row.collected2, 600);
  assert.equal(row.outstanding, 1990);
  assert.equal(row.topProduct, paint.name, 'the best seller by money, not by count');
  assert.equal(row.topProductRevenue, 2400);
  assert.equal(row.target, 1000);
  assert.equal(row.targetProgress, 259);
  // The company aggregate is the whole day, not this engineer's invoice, so it is checked as a
  // superset: the window that contains his 2590 must report at least his money and a best seller.
  assert.ok(res.body.company.sales.revenue >= 2590, 'the company row sums every engineer in the window');
  assert.ok(res.body.company.sales.topProduct.revenue >= 2400, 'and its best seller is at least as big as his');
  assert.equal(res.body.company.target, 777000, 'the company row carries the company plan of the window’s month');

  const csv = await client.get(`/api/kpis.csv?from=${today}&to=${today}`).set(admin);
  assert.equal(csv.status, 200);
  const header = csv.text.split('\n')[0];
  assert.ok(header.includes('المبيعات') && header.includes('المسدد على الفواتير') && header.includes('نسبة الهدف'), 'the export gained the money columns instead of becoming a different report');
  assert.ok(csv.text.includes('2590'), 'and the numbers in the file are the numbers on the screen');
  assert.ok(csv.text.includes(paint.name), 'the best-seller column carries the name, not an id');
});

test('the company row is the month, not the invoices nobody claimed', async () => {
  const month = (await client.get('/api/targets').set(admin)).body.month as string;
  const board = await client.get(`/api/targets?month=${month}`).set(admin);
  assert.equal(board.status, 200);
  const sums = store.get('SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS invoices FROM invoices WHERE voided=0')!;
  assert.equal(Math.round(Number(board.body.company.revenue) * 100), Math.round(Number(sums.revenue) * 100),
    'the company number is every engineer’s sale added up — not only the bills with no engineer on them');
  assert.equal(Number(board.body.company.invoices), Number(sums.invoices));
  assert.equal(board.body.company.repActive, true, 'and the company row is never the dimmed one');
  const perRep = board.body.reps.reduce((acc: number, row: any) => acc + row.revenue, 0)
    + board.body.retired.reduce((acc: number, row: any) => acc + row.revenue, 0);
  // A sale whose engineer was deleted keeps its money and loses its credit, so the rows do not add up
  // to the company total by themselves — the unclaimed remainder is the difference, and it is shown.
  const unclaimed = Number(store.get('SELECT COALESCE(SUM(total),0) AS revenue FROM invoices WHERE voided=0 AND rep_id IS NULL')!.revenue);
  assert.equal(Math.round((perRep + unclaimed) * 100), Math.round(Number(sums.revenue) * 100), 'every EGP is either under an engineer or under «بدون مهندس»');
});

test('an old database carries its cash into the register when it opens, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elhelp-upgrade-'));
  const file = join(dir, 'mandoub.db');
  try {
    const now = Date.now();
    const opened = new Store(file);
    opened.run('INSERT INTO warehouses(id,name,created_at,updated_at) VALUES (?,?,?,?)', 'w-old', `مخزن ${randomUUID().slice(0, 6)}`, now, now);
    opened.run(`INSERT INTO invoices(id,number,customer_name,warehouse_id,invoice_date,subtotal,discount,total,paid_amount,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, 'i-old', 'INV-2020-0001', 'مزرعة من الزمن ده', 'w-old', now - 400 * DAY, 3000, 0, 3000, 3000, 'paid', now, now);
    assert.equal(Number(opened.get('SELECT COUNT(*) AS c FROM collection_events')!.c), 0, 'the write happened while there was no register to write to');
    opened.close();

    const upgraded = new Store(file);
    const rows = upgraded.all('SELECT amount, source, note, created_at AS createdAt, invoice_id AS invoiceId FROM collection_events') as Array<Record<string, any>>;
    assert.equal(rows.length, 1, 'the cash already on the books becomes one entry');
    assert.equal(Number(rows[0].amount), 3000);
    assert.equal(rows[0].invoiceId, 'i-old');
    assert.equal(rows[0].source, 'office');
    assert.match(String(rows[0].note), /قبل ما سجل التحصيل/, 'and the row says where it came from');
    assert.equal(Number(rows[0].createdAt), now - 400 * DAY, 'dated on the invoice’s own day, so a month report reads the month the money moved');
    upgraded.close();

    const again = new Store(file);
    assert.equal(Number(again.get("SELECT COUNT(*) AS c FROM collection_events WHERE invoice_id='i-old'")!.c), 1,
      'reopening a database whose register is already written never duplicates the old cash');
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
