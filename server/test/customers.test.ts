import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { customerWatch, CUSTOMER_OVERDUE_DAYS, daysSince } from '../../dashboard/src/Customers.js';

/**
 * Customers as master data — the layer every visit (and later every invoice) points at.
 *
 * The three things these tests hold: an engineer sees and touches only his own list, a duplicated
 * customer is impossible (a duplicate name is a duplicated sales figure), and a customer with
 * history cannot be deleted, only stopped.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 30, timezone: 'Africa/Cairo',
  adminEmail: 'admin@mandoub.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

const DAY = 86400000;

async function login(email: string, password: string) {
  const res = await client.post('/api/auth/login').send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { Authorization: `Bearer ${res.body.token as string}` };
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
  return { id, email, auth: await login(email, 'Rep1234!') };
}
const create = (body: Record<string, unknown>) => client.post('/api/customers').send(body);
/** The visit goes in the way the phone writes it: a row plus the shift that produced it. */
function addVisit(userId: string, at: number, customerId: string | null, name = 'مزرعة قديمة') {
  store.run('INSERT INTO shifts(id,user_id,started_at,ended_at,consent_version,consent_at) VALUES (?,?,?,?,?,?)',
    randomUUID(), userId, at - 60000, at, '1.0', at - 60000);
  store.run(`INSERT INTO visits(id,user_id,customer_name,customer_id,checked_in_at,created_at,status)
    VALUES (?,?,?,?,?,?, 'closed')`, randomUUID(), userId, name, customerId, at, at);
}

test('an engineer sees his own list only, and cannot read a colleague by id', async () => {
  const aly = await rep('علي حسن');
  const said = await rep('سعيد مبروك');
  const created = await create({ name: 'مزرعة النور', repId: aly.id }).set(aly.auth);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const customerId = created.body.customer.id as string;

  const own = await client.get('/api/customers').set(aly.auth);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.customers.map((row: any) => row.id), [customerId]);
  assert.equal(own.body.customers[0].repName, 'علي حسن');

  // Asking for another engineer's view is ignored, not refused with a helpful 403: the answer is
  // the same list either way, so there is nothing to confirm about the other man.
  const peek = await client.get(`/api/customers?repId=${said.id}`).set(aly.auth);
  assert.equal(peek.status, 200);
  assert.deepEqual(peek.body.customers.map((row: any) => row.id), [customerId], 'he sees his own list, never سعيد مبروك');

  const edit = await client.patch(`/api/customers/${customerId}`).set(said.auth).send({ name: 'سرقة' });
  assert.equal(edit.status, 403);
  assert.match(edit.body.error, /عملاءك إنت بس/);
});

test('the same name twice in one list is refused, and allowed in two different lists', async () => {
  const aly = await rep('مراد فؤاد');
  const first = await create({ name: 'حاج محمد', repId: aly.id }).set(admin);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  // Trailing space and a different case are the same customer, and the index proves it.
  const again = await create({ name: 'حاج محمد ', repId: aly.id }).set(admin);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'CUSTOMER_EXISTS');
  assert.match(again.body.error, /قايمتة بالفعل/);

  const other = await rep('ياسر منير');
  const inAnotherList = await create({ name: 'حاج محمد', repId: other.id }).set(admin);
  assert.equal(inAnotherList.status, 201, 'two engineers may both sell to the same man');
});

test('a manager creating a customer has to name the owner', async () => {
  const res = await create({ name: 'مزرعة بدون صاحب' }).set(admin);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'REP_REQUIRED');
  const ghost = await create({ name: 'عميل لحساب متوقف' }).set({ Authorization: 'Bearer nope' });
  assert.equal(ghost.status, 401, 'and nobody anonymous gets in at all');
});

test('a refused customer keeps its reason, and a half address is refused', async () => {
  const aly = await rep('هاني صبري');
  const noReason = await create({ name: 'عميل رُفض', repId: aly.id, stage: 'lost' }).set(aly.auth);
  assert.equal(noReason.status, 201, 'creating him as lost with no reason is allowed — the update is where it matters');
  const refuse = await client.patch(`/api/customers/${noReason.body.customer.id}`).set(aly.auth).send({ stage: 'lost', lostReason: '' });
  assert.equal(refuse.status, 400);
  assert.equal(refuse.body.code, 'LOST_REASON_REQUIRED');
  const withReason = await client.patch(`/api/customers/${noReason.body.customer.id}`).set(aly.auth).send({ stage: 'lost', lostReason: 'السعر أعلى من السوق' });
  assert.equal(withReason.status, 200);
  assert.equal(withReason.body.customer.lostReason, 'السعر أعلى من السوق');

  const halfAddress = await create({ name: 'عنوان ناقص', repId: aly.id, lat: 31.2 }).set(aly.auth);
  assert.equal(halfAddress.status, 400);
  assert.equal(halfAddress.body.code, 'ADDRESS_INCOMPLETE');
});

test('a visit booked from the list carries the master name and counts on the customer', async () => {
  const aly = await rep('أحمد شوقي');
  const other = await rep('كريم فتحي');
  const customer = await create({ name: 'مزرعة الدلتا', repId: aly.id }).set(aly.auth);
  const customerId = customer.body.customer.id as string;

  const now = Date.now();
  addVisit(aly.id, now - DAY, customerId, 'مزرعة الدلتا');
  // A live check-in only works inside an open shift, so open one for him.
  store.run('INSERT INTO shifts(id,user_id,started_at,consent_version,consent_at) VALUES (?,?,?,?,?)',
    randomUUID(), aly.id, now - 60000, '1.0', now - 60000);

  const list = await client.get('/api/customers').set(aly.auth);
  assert.equal(list.body.customers[0].visitCount, 1);
  assert.equal(list.body.customers[0].lastVisitAt, now - DAY);
  assert.equal(daysSince(now, now + 3 * DAY), 3);
  assert.equal(list.body.customers[0].stage, 'new', 'a visit does not promote a customer by itself');

  const foreign = await create({ name: 'مش بتاعك', repId: other.id }).set(other.auth);
  const stolen = await client.post('/api/visits/check-in').set(aly.auth).send({
    id: randomUUID(), customerName: 'اي اسم', customerId: foreign.body.customer.id,
    location: { lat: 31.2, lng: 29.9, accuracy: 8 },
  });
  assert.equal(stolen.status, 409, 'a visit cannot be booked against a customer the engineer does not own');
  assert.equal(stolen.body.code, 'CUSTOMER_NOT_OWNED');

  // The same visit, replayed from the outbox after the shift ended, must not be thrown away: the
  // link is dropped, the visit stands with the name the engineer typed.
  const linked = await create({ name: 'مزرعة الوادي', repId: aly.id }).set(aly.auth);
  const replay = await client.post('/api/visits/check-in').set(aly.auth).send({
    id: randomUUID(), customerName: 'الوادي', customerId: linked.body.customer.id, recordedAt: now - 300000,
    location: { lat: 31.2, lng: 29.9, accuracy: 8 },
  });
  assert.equal(replay.status, 422, 'a replayed visit still has to fall inside a shift of his own');
  assert.equal(replay.body.code, 'OFFLINE_VISIT_REJECTED');

  store.run('UPDATE shifts SET started_at=? WHERE user_id=? AND ended_at IS NULL', Date.now() - 3600000, aly.id);
  const movedAway = await create({ name: 'عميل اتنقل لغيرك', repId: other.id }).set(other.auth);
  const replayed = await client.post('/api/visits/check-in').set(aly.auth).send({
    id: randomUUID(), customerName: 'مزرعة التمساح', customerId: movedAway.body.customer.id,
    recordedAt: Date.now() - 120000, location: { lat: 31.2, lng: 29.9, accuracy: 8 },
  });
  assert.equal(replayed.status, 201, JSON.stringify(replayed.body));
  assert.equal(replayed.body.visit.customerId, null, 'the link is dropped, not the visit');
  assert.equal(replayed.body.visit.customerName, 'مزرعة التمساح');
});

test('a customer with history cannot be deleted, only stopped', async () => {
  const aly = await rep('سمر علي');
  const customer = await create({ name: 'عميل عنده تاريخ', repId: aly.id }).set(aly.auth);
  addVisit(aly.id, Date.now(), customer.body.customer.id);

  const blocked = await client.delete(`/api/customers/${customer.body.customer.id}`).set(admin);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'CUSTOMER_HAS_VISITS');
  assert.match(blocked.body.error, /وقّفه بدل الحذف/);

  const stopped = await client.patch(`/api/customers/${customer.body.customer.id}`).set(admin).send({ active: false });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.customer.active, false);
  const activeOnly = await client.get('/api/customers?includeInactive=0').set(admin);
  assert.ok(!activeOnly.body.customers.some((row: any) => row.id === customer.body.customer.id), 'he leaves the working list');
  const everything = await client.get('/api/customers?includeInactive=1').set(admin);
  assert.ok(everything.body.customers.some((row: any) => row.id === customer.body.customer.id), 'and stays in the register');

  const empty = await create({ name: 'عميل غلط اتكتب', repId: aly.id }).set(aly.auth);
  const removed = await client.delete(`/api/customers/${empty.body.customer.id}`).set(admin);
  assert.equal(removed.status, 200);
  assert.equal(store.get('SELECT id FROM customers WHERE id=?', empty.body.customer.id), undefined);
});

test('moving a customer to another engineer keeps his history attached', async () => {
  const from = await rep('رضا شعبان');
  const to = await rep('مصطفى كامل');
  const customer = await create({ name: 'مزرعة النخيل', repId: from.id }).set(from.auth);
  addVisit(from.id, Date.now() - DAY, customer.body.customer.id);

  const denied = await client.post(`/api/customers/${customer.body.customer.id}/assign`).set(from.auth).send({ repId: to.id });
  assert.equal(denied.status, 403, 'an engineer cannot hand his list to whoever he likes');

  const moved = await client.post(`/api/customers/${customer.body.customer.id}/assign`).set(admin).send({ repId: to.id });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.customer.repId, to.id);
  assert.equal(moved.body.customer.visitCount, 1, 'the visit follows the customer, not the man');
  const oldOwner = await client.get('/api/customers').set(from.auth);
  assert.deepEqual(oldOwner.body.customers, []);

  store.run('UPDATE users SET active=0 WHERE id=?', to.id);
  const other = await create({ name: 'عميل للتوزيع', repId: from.id }).set(from.auth);
  const refused = await client.post(`/api/customers/${other.body.customer.id}/assign`).set(admin).send({ repId: to.id });
  assert.equal(refused.status, 409, 'a stopped account is not a destination for a customer list');
});

test('a name collision blocks a move, and says to merge first', async () => {
  const from = await rep('عمرو سيد');
  const to = await rep('تامر جمعة');
  await create({ name: 'الحاج سعيد', repId: to.id }).set(to.auth);
  const mine = await create({ name: 'الحاج سعيد', repId: from.id }).set(from.auth);
  const res = await client.post(`/api/customers/${mine.body.customer.id}/assign`).set(admin).send({ repId: to.id });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CUSTOMER_EXISTS');
  assert.match(res.body.error, /ادمج العميلين/);
});

test('retention sweeps the visits but never the customer list', () => {
  const aly = addRep('زينب عادل');
  const customerId = randomUUID();
  store.run('INSERT INTO customers(id,rep_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', customerId, aly.id, 'عميل قديم', Date.now() - 400 * DAY, Date.now() - 400 * DAY);
  addVisit(aly.id, Date.now() - 400 * DAY, customerId);
  store.cleanup(30);
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM visits WHERE user_id=?', aly.id)?.c), 0, 'the old visit goes with the retention window');
  assert.ok(store.get('SELECT id FROM customers WHERE id=?', customerId), 'the customer stays: master data is not an activity log');
});

test('deleting an engineer takes his customer list with him', () => {
  const doomed = addRep('حسام إبراهيم', `hoss.${Date.now()}@mandoub.test`);
  const keeper = addRep('فادي نبيل', `fady.${Date.now()}@mandoub.test);`.replace(');', '') + '@mandoub.test');
  store.run('INSERT INTO customers(id,rep_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', randomUUID(), doomed.id, 'عميل لحد', Date.now(), Date.now());
  const kept = randomUUID();
  store.run('INSERT INTO customers(id,rep_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', kept, keeper.id, 'عميل تاني', Date.now(), Date.now());
  store.run('DELETE FROM users WHERE id=?', doomed.id);
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM customers WHERE rep_id=?', doomed.id)?.c), 0);
  assert.ok(store.get('SELECT id FROM customers WHERE id=?', kept), 'the colleague list is untouched');
});

test('the cooling rule names a cold relationship and never a refused one', () => {
  const now = Date.now();
  const base = { active: true, lostReason: '', openVisits: 0, visitCount: 3, repId: 'r', id: 'c', name: 'n', phone: '', governorate: '', district: '', village: '', notes: '', lat: null, lng: null, updatedAt: now, repName: 'مهندس', repColor: '' } as const;
  const oldVisit = { ...base, stage: 'active' as const, createdAt: now - 200 * DAY, lastVisitAt: now - (CUSTOMER_OVERDUE_DAYS + 4) * DAY };
  assert.equal(customerWatch(oldVisit, now).level, 'warn');
  assert.match(customerWatch(oldVisit, now).text, /برّد/);
  const fresh = { ...base, stage: 'following' as const, createdAt: now - 5 * DAY, lastVisitAt: now - 2 * DAY };
  assert.equal(customerWatch(fresh, now).level, 'ok');
  const neverVisited = { ...base, stage: 'new' as const, createdAt: now - 30 * DAY, lastVisitAt: null };
  assert.match(customerWatch(neverVisited, now).text, /مفيش زيارة/);
  const justAdded = { ...base, stage: 'new' as const, createdAt: now - 2 * DAY, lastVisitAt: null };
  assert.equal(customerWatch(justAdded, now).text, 'لسه من غير زيارة');
  const refused = { ...base, stage: 'lost' as const, lostReason: 'السعر', createdAt: now - 90 * DAY, lastVisitAt: now - 90 * DAY };
  assert.equal(customerWatch(refused, now).level, 'ok', 'a closed customer is not a warning');
  assert.match(customerWatch(refused, now).text, /السعر/);
});
