import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';

/**
 * The order workflow, from the press in the field to the stamp at the desk.
 *
 * Two authors write one row and neither can touch the other's half: the engineer books items and
 * quantities against a customer from his own list (never a name he typed, the visit rule again), and
 * only the office can put prices on it — numbers the phone must never see. Every refusal here is
 * deliberately a sentence a field engineer can act on without a phone call to the office.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 30, timezone: 'Africa/Cairo',
  adminEmail: 'admin@orders.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  loginAccountLimit: 500, loginRateLimit: { windowMs: 60000, limit: 5000 },
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

async function login(email: string, password: string, kind: 'admin' | 'rep' = 'admin') {
  const res = await client.post('/api/auth/login').send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { Authorization: `Bearer ${res.body.token as string}`, 'X-Mandoub-Client': kind };
}
const admin = await login(config.adminEmail, config.adminPassword);
const PASSWORD = 'Rep1234!Rep';

async function makeRep(name: string) {
  const email = `rep.${randomUUID().slice(0, 8)}@orders.test`;
  const created = await client.post('/api/reps').set(admin).send({ name, email, password: PASSWORD });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { id: created.body.user.id as string, name, email, auth: await login(email, PASSWORD, 'rep') };
}
const repA = await makeRep('مصطفى كامل');
const repB = await makeRep('سعيد البحر');

async function bookCustomer(repId: string | null, name: string, priceTierId?: string | null) {
  const res = await client.post('/api/customers').set(admin).send({ name, repId, phone: '01000000000', governorate: 'الغربية', district: 'طنطا', ...(priceTierId !== undefined ? { priceTierId } : {}) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.customer.id as string;
}
const tiers = (await client.get('/api/price-tiers').set(admin)).body.tiers as Array<{ id: string; name: string }>;
const wholesale = tiers[0];
async function makeProduct(name: string, unit: string, price: number | null) {
  const res = await client.post('/api/products').set(admin).send({
    name, unit, category: 'fertilizer', unitSize: '٥٠ كجم',
    ...(price === null ? {} : { prices: [{ tierId: wholesale.id, price }] }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.product.id as string;
}
const urea = await makeProduct('يوريا', 'شيكارة', 120);
const dap = await makeProduct('داب', 'شيكارة', 150);

const customerA = await bookCustomer(repA.id, 'مزرعة التل', wholesale.id);
const customerB = await bookCustomer(repB.id, 'مزرعة السهل');
const customerPool = await bookCustomer(null, 'عميل الشركة');
const customerStopped = await bookCustomer(repA.id, 'عميل موقوف');
await client.patch(`/api/customers/${customerStopped}`).set(admin).send({ active: false });

const createOrder = (rep: { auth: Record<string, string> }, body: Record<string, unknown> = {}) =>
  client.post('/api/orders').set(rep.auth).send({ id: randomUUID(), customerId: customerA, lines: [{ productId: urea, qty: 3 }], ...body });

test('the engineer writes the order against his own customer and the office queue lights up', async () => {
  const res = await createOrder(repA, { notes: 'التسليم السبت' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.order.status, 'sent', 'a press in the field means «send this»');
  assert.equal(res.body.order.customerName, 'مزرعة التل', 'the name comes from the book, not from the request');
  assert.equal(res.body.order.lines[0].productName, 'يوريا');
  assert.equal(res.body.order.lines[0].unit, 'شيكارة');
  assert.equal(res.body.order.lines[0].unitSize, '٥٠ كجم', 'the pack is frozen with the line');
  assert.equal('price' in res.body.order.lines[0], false, 'the phone does not even receive the key');
  assert.equal('total' in res.body.order, false, 'same for the total');

  const queue = await client.get('/api/orders?status=sent').set(admin);
  assert.equal(queue.body.orders.length, 1);
  assert.equal(queue.body.orders[0].repName, repA.name);
  assert.equal(queue.body.orders[0].lines[0].suggestedPrice, 120, 'the queue prefills the customer\'s list price');
  assert.equal(queue.body.orders[0].customerTierName, wholesale.name);
  const overview = await client.get('/api/overview').set(admin);
  assert.equal(overview.body.sentOrders, 1, 'the badge counts what waits');
  const alerts = await client.get('/api/alerts').set(admin);
  assert.ok(alerts.body.alerts.some((a: any) => a.code === 'orders_awaiting_pricing'), 'the alert feed says so too');
});

test('an order is booked on the book, never on a name typed in the street', async () => {
  const ghost = await createOrder(repA, { customerId: randomUUID() });
  assert.equal(ghost.status, 400);
  assert.equal(ghost.body.code, 'CUSTOMER_NOT_FOUND');
  const other = await createOrder(repA, { customerId: customerB });
  assert.equal(other.status, 403, 'the office decides who serves whom, and the route enforces it');
  const pooled = await createOrder(repA, { customerId: customerPool });
  assert.equal(pooled.status, 403, 'a company-list customer is not his until the office hands him over');
  const stopped = await createOrder(repA, { customerId: customerStopped });
  assert.equal(stopped.status, 409);
  assert.equal(stopped.body.code, 'CUSTOMER_INACTIVE');
  // A field order is not a visit: no shift, no GPS, no open-visit lock — a phone call from the road is paperwork enough.
  const noShift = await createOrder(repA);
  assert.equal(noShift.status, 201, 'no shift is open for repA yet and the order still lands');
  const typed = await createOrder(repA, { customerName: 'محمود' } as Record<string, unknown>);
  assert.equal(typed.status, 400, 'the old payload with a hand-typed name is refused, not ignored silently');
});

test('lines are one per item, counted in whole units, and real', async () => {
  const twice = await createOrder(repA, { lines: [{ productId: urea, qty: 1 }, { productId: urea, qty: 2 }] });
  assert.equal(twice.status, 400);
  assert.match(twice.body.error, /متكرر/);
  const zero = await createOrder(repA, { lines: [{ productId: urea, qty: 0 }] });
  assert.equal(zero.status, 400);
  const negative = await createOrder(repA, { lines: [{ productId: urea, qty: -5 }] });
  assert.equal(negative.status, 400);
  const huge = await createOrder(repA, { lines: [{ productId: urea, qty: 100001 }] });
  assert.equal(huge.status, 400, 'the fat finger is stopped by the schema, not by the warehouse');
  const empty = await createOrder(repA, { lines: [] });
  assert.equal(empty.status, 400);
  const phantom = await createOrder(repA, { lines: [{ productId: randomUUID(), qty: 1 }] });
  assert.equal(phantom.status, 400);
  assert.match(phantom.body.error, /مش موجود/);
  const stopped = await makeProduct('نترات', 'شيكارة', 100);
  await client.patch(`/api/products/${stopped}`).set(admin).send({ active: false });
  const shelved = await createOrder(repA, { lines: [{ productId: stopped, qty: 1 }] });
  assert.equal(shelved.status, 400, 'a stopped item cannot enter a new order');
  assert.match(shelved.body.error, /موقوف/);
});

test('a replayed send is the same order, not a second agreement', async () => {
  const id = randomUUID();
  const first = await createOrder(repA, { id, lines: [{ productId: urea, qty: 2 }, { productId: dap, qty: 1 }] });
  assert.equal(first.status, 201);
  const again = await createOrder(repA, { id, lines: [{ productId: urea, qty: 2 }, { productId: dap, qty: 1 }] });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  const lines = store.all('SELECT id FROM order_lines WHERE order_id=?', id);
  assert.equal(lines.length, 2, 'the office prices two lines, not four');
  const thief = await createOrder(repB, { id });
  assert.equal(thief.status, 409, 'another owner cannot replay his way into somebody else\'s order');
});

test('a draft waits on the phone; a sent order belongs to the office', async () => {
  const draft = await createOrder(repA, { send: false });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.order.status, 'draft');
  const patched = await client.patch(`/api/orders/${draft.body.order.id}`).set(repA.auth)
    .send({ notes: 'اتصل تاني الصبح', lines: [{ productId: dap, qty: 4 }] });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.order.lines.length, 1);
  assert.equal(patched.body.order.lines[0].productName, 'داب', 'the whole list is replaced, so a stale line cannot survive an edit');
  const bad = await client.patch(`/api/orders/${draft.body.order.id}`).set(repA.auth).send({});
  assert.equal(bad.status, 400, 'an edit with nothing to edit says so');
  const sent = await client.post(`/api/orders/${draft.body.order.id}/send`).set(repA.auth).send({});
  assert.equal(sent.status, 200);
  assert.equal(sent.body.order.status, 'sent');
  const resend = await client.post(`/api/orders/${draft.body.order.id}/send`).set(repA.auth).send({});
  assert.equal(resend.body.duplicate, true, 'a queue that replays the send is told the truth, twice');
  const lateEdit = await client.patch(`/api/orders/${draft.body.order.id}`).set(repA.auth).send({ notes: 'غيّرت رأيي' });
  assert.equal(lateEdit.status, 409, 'what the office may already be pricing cannot move under them');
  const otherPhone = await client.patch(`/api/orders/${draft.body.order.id}`).set(repB.auth).send({ notes: 'أنا' });
  assert.equal(otherPhone.status, 404, 'not his order, not even found');
});

test('an order held through the night arrives marked, an older one does not arrive at all', async () => {
  const fresh = await createOrder(repA, { recordedAt: Date.now() - 3 * 3600000 });
  assert.equal(fresh.status, 201);
  assert.equal(fresh.body.recordedOffline, true);
  const stale = await createOrder(repA, { recordedAt: Date.now() - 26 * 3600000 });
  assert.equal(stale.status, 422);
  assert.equal(stale.body.code, 'OFFLINE_ORDER_REJECTED');
  const future = await createOrder(repA, { recordedAt: Date.now() + 10 * 60000 });
  assert.equal(future.status, 422, 'the phone clock may be wrong but it may not lead');
});

test('pricing is the office\'s half, and one press closes the order', async () => {
  const order = await createOrder(repA, { lines: [{ productId: urea, qty: 2 }, { productId: dap, qty: 1 }] });
  const orderId = order.body.order.id as string;
  const before = (await client.get('/api/overview').set(admin)).body.sentOrders as number;
  const byPhone = await client.post(`/api/orders/${orderId}/price`).set(repA.auth).send({ lines: [{ productId: urea, price: 1 }, { productId: dap, price: 1 }] });
  assert.equal(byPhone.status, 403, 'the engineer has no door to a price');
  const half = await client.post(`/api/orders/${orderId}/price`).set(admin).send({ lines: [{ productId: urea, price: 120 }] });
  assert.equal(half.status, 400);
  assert.equal(half.body.code, 'PRICE_REQUIRED');
  assert.match(half.body.error, /داب/, 'the message names the line that has no number');
  const liar = await client.post(`/api/orders/${orderId}/price`).set(admin).send({ lines: [{ productId: urea, price: 90, tierId: wholesale.id }, { productId: dap, price: 150 }] });
  assert.equal(liar.status, 400);
  assert.equal(liar.body.code, 'TIER_PRICE_MISMATCH', 'a number wearing a list type it disagrees with is refused, not guessed at');
  const ok = await client.post(`/api/orders/${orderId}/price`).set(admin).send({
    lines: [{ productId: urea, price: 120, tierId: wholesale.id }, { productId: dap, price: 140 }],
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.order.status, 'priced');
  assert.equal(ok.body.order.total, 380, '2×120 from the list, 1×140 by hand');
  assert.ok(!('code' in ok.body) || ok.body.code === undefined);
  const lines = store.all('SELECT product_id AS productId, price, tier_id AS tierId FROM order_lines WHERE order_id=? ORDER BY product_id', orderId) as Array<Record<string, any>>;
  const ureaLine = lines.find(l => l.productId === urea)!;
  assert.equal(ureaLine.price, 120, 'the column it was taken from is on the line');
  assert.equal(ureaLine.tierId, wholesale.id);
  assert.equal(lines.find(l => l.productId === dap).tierId, null, 'a hand-typed price leaves no tier behind');
  const again = await client.post(`/api/orders/${orderId}/price`).set(admin).send({ lines: [{ productId: urea, price: 1 }, { productId: dap, price: 1 }] });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'ORDER_PRICED', 'the book was written once');
  const phoneView = await client.get('/api/orders?limit=300').set(repA.auth);
  const seen = phoneView.body.orders.find((o: any) => o.id === orderId);
  assert.equal(seen.status, 'priced', 'the engineer may know the office closed it');
  assert.equal('total' in seen, false, 'the closing itself carries no number back to his pocket');
  assert.equal('price' in seen.lines[0], false);
  const overview = await client.get('/api/overview').set(admin);
  assert.equal(overview.body.sentOrders, before - 1, 'the closed order left the queue; the others still wait');
});

test('a customer with no price type is priced by hand and says so', async () => {
  const noTier = await bookCustomer(repA.id, 'عميل باليد', null);
  const order = await createOrder(repA, { customerId: noTier });
  const queue = await client.get(`/api/orders?repId=${repA.id}&limit=300`).set(admin);
  const mine = queue.body.orders.find((o: any) => o.id === order.body.order.id);
  assert.equal(mine.customerTierName, '', 'the office reads «من غير تحديد» as «باليد», and the row confirms it');
  assert.equal(mine.lines[0].suggestedPrice, null);
  const priced = await client.post(`/api/orders/${order.body.order.id}/price`).set(admin).send({ lines: [{ productId: urea, price: 135 }] });
  assert.equal(priced.status, 200);
  assert.equal(priced.body.order.total, 405);
});

test('the visit is a link, not a parent', async () => {
  const wrong = await createOrder(repA, { visitId: randomUUID() });
  assert.equal(wrong.status, 400, 'a visit id that is nobody\'s is refused, not stored dangling');
  assert.equal(wrong.body.code, 'VISIT_NOT_YOURS');
});

test('an order outlives the GPS trail it was written in', async () => {
  const shift = await client.post('/api/shifts/start').set(repA.auth)
    .send({ consentVersion: '1.0', deviceId: 'dev-orders', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(shift.status, 200, JSON.stringify(shift.body));
  const visit = await client.post('/api/visits/check-in').set(repA.auth)
    .send({ id: randomUUID(), customerId: customerA, purpose: 'order', notes: '', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(visit.status, 201, JSON.stringify(visit.body));
  const visitId = visit.body.visit.id as string;
  const anotherCustomer = await bookCustomer(repA.id, 'عميل تاني');
  const mismatched = await createOrder(repA, { visitId, customerId: anotherCustomer });
  assert.equal(mismatched.status, 400, 'زيارة عميل آخر لا تُربط بالطلبية');
  const order = await createOrder(repA, { visitId });
  assert.equal(order.status, 201);
  const blockedDelete = await client.delete(`/api/customers/${anotherCustomer}`).set(admin);
  assert.equal(blockedDelete.status, 200);
  const orderId = order.body.order.id as string;
  const old = Date.now() - 400 * 86400000;
  store.run('UPDATE visits SET created_at=?, checked_in_at=? WHERE id=?', old, old, visitId);
  store.run('UPDATE orders SET created_at=?, sent_at=? WHERE id=?', old, old, orderId);
  store.run('UPDATE order_lines SET created_at=? WHERE order_id=?', old, orderId);
  store.run(`UPDATE shifts SET ended_at=?, started_at=? WHERE user_id=? AND ended_at IS NULL`, old, old, repA.id);
  store.cleanup(30);
  assert.ok(!store.get('SELECT id FROM visits WHERE id=?', visitId), 'retention swept the visit, as it promises');
  const survivor = store.get('SELECT visit_id AS visitId, status FROM orders WHERE id=?', orderId) as { visitId: string | null; status: string } | undefined;
  assert.ok(survivor, 'the promise made inside it is not swept with the trail');
  assert.equal(survivor.visitId, null, 'it only stops pointing at a row that is gone');
  assert.equal(survivor.status, 'sent', 'and the office still has to price it');
});

test('drafts are private and cannot be sent after the customer is moved or an item is stopped', async () => {
  const customer = await bookCustomer(repA.id, `عميل مسودة ${randomUUID().slice(0, 8)}`);
  const product = await makeProduct(`صنف مسودة ${randomUUID().slice(0, 8)}`, 'عبوة', null);
  const draft = await createOrder(repA, { customerId: customer, send: false, lines: [{ productId: product, qty: 1 }] });
  assert.equal(draft.status, 201);
  const id = draft.body.order.id as string;
  const office = await client.get('/api/orders?status=draft').set(admin);
  assert.equal(office.status, 200);
  assert.ok(!office.body.orders.some((row: any) => row.id === id));
  assert.ok((await client.get('/api/orders?status=draft').set(repA.auth)).body.orders.some((row: any) => row.id === id));
  assert.equal((await client.patch(`/api/products/${product}`).set(admin).send({ active: false })).status, 200);
  const stopped = await client.post(`/api/orders/${id}/send`).set(repA.auth).send({});
  assert.equal(stopped.status, 400);
  assert.equal(stopped.body.code, 'ORDER_LINES');
  assert.equal((await client.patch(`/api/products/${product}`).set(admin).send({ active: true })).status, 200);
  assert.equal((await client.post(`/api/customers/${customer}/assign`).set(admin).send({ repId: repB.id })).status, 200);
  const moved = await client.post(`/api/orders/${id}/send`).set(repA.auth).send({});
  assert.equal(moved.status, 403);
  assert.equal(moved.body.code, 'CUSTOMER_NOT_YOURS');
  assert.equal(store.get('SELECT status FROM orders WHERE id=?', id)?.status, 'draft');
});

test('orders reject malformed pagination and the office can page through its queue', async () => {
  for (const query of ['limit=1.5', 'limit=0', 'limit=Infinity', 'offset=-1', 'status=nope']) {
    const result = await client.get(`/api/orders?${query}`).set(admin);
    assert.equal(result.status, 400, `${query}: ${JSON.stringify(result.body)}`);
  }
  const one = await client.get('/api/orders?status=sent&limit=1&offset=0').set(admin);
  const two = await client.get('/api/orders?status=sent&limit=1&offset=1').set(admin);
  assert.equal(one.status, 200);
  assert.equal(one.body.hasMore, true);
  assert.equal(two.status, 200);
  assert.notEqual(one.body.orders[0].id, two.body.orders[0].id);
  assert.ok(one.body.orders[0].sentAt <= two.body.orders[0].sentAt);
});

test('the deletion impact names orders before removing an engineer', async () => {
  const rep = await makeRep(`مهندس حذف ${randomUUID().slice(0, 8)}`);
  const customer = await bookCustomer(rep.id, `عميل حذف ${randomUUID().slice(0, 8)}`);
  const order = await createOrder(rep, { customerId: customer });
  assert.equal(order.status, 201);
  const impact = await client.get(`/api/reps/${rep.id}/impact`).set(admin);
  assert.equal(impact.body.orders, 1);
  const deleted = await client.delete(`/api/reps/${rep.id}`).set(admin).send({ confirm: true });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.removed.orders, 1);
  assert.equal(store.get('SELECT id FROM orders WHERE id=?', order.body.order.id), undefined);
});
