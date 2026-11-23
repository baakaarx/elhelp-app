import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
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
async function move(warehouseId: string, productId: string, qty: number, kind: 'receipt' | 'count' | 'writeoff' | 'return' = 'receipt') {
  const res = await client.post('/api/stock/movements').set(admin).send({ warehouseId, productId, qty, kind });
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
