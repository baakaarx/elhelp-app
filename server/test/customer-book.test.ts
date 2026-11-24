import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';

/**
 * The customer book the way the office uses it.
 *
 * The manager and his team enter the list and decide who serves whom — one customer at a time, or a
 * whole area at once after a preview. An engineer's phone reads its own slice and books a visit on it;
 * it cannot add to it and cannot invent a name. The direction of those two rules is the whole point of
 * this file: a name typed in the office is allowed to have no owner yet, and a visit is not allowed to
 * pick its own owner.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 30, timezone: 'Africa/Cairo',
  adminEmail: 'admin@book.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  // Every account here is logged in for, and the limiter counts addresses: 15 a minute is a real
  // protection on a VPS and a false alarm inside one process.
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

/** An engineer created through the dashboard's own route, so `region` is real data and not a fixture. */
async function makeRep(name: string, region = '') {
  const email = `rep.${randomUUID().slice(0, 8)}@book.test`;
  const created = await client.post('/api/reps').set(admin).send({ name, email, password: PASSWORD, region });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { id: created.body.user.id as string, name, email, auth: await login(email, PASSWORD, 'rep') };
}
const book = (body: Record<string, unknown>) => client.post('/api/customers').set(admin).send(body);
async function openShift(rep: { id: string; auth: Record<string, string> }) {
  const res = await client.post('/api/shifts/start').set(rep.auth)
    .send({ consentVersion: '1.0', deviceId: `dev-${rep.id.slice(0, 6)}`, location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}
const checkIn = (rep: { auth: Record<string, string> }, body: Record<string, unknown> = {}) =>
  client.post('/api/visits/check-in').set(rep.auth).send({ id: randomUUID(), location: { lat: 31.2, lng: 29.9, accuracy: 8 }, ...body });

test('the office enters a customer before anybody owns him', async () => {
  const pooled = await book({ name: 'مزرعة السواحل', governorate: 'الغربية', district: 'طنطا', phone: '01000000001' });
  assert.equal(pooled.status, 201, JSON.stringify(pooled.body));
  assert.equal(pooled.body.customer.repId, null, '«من غير مهندس» is a state of the list, not a missing field');
  assert.equal(pooled.body.customer.repName, 'من غير مهندس');

  const queue = await client.get('/api/customers?unassigned=1&governorate=الغربية&district=طنطا').set(admin);
  assert.deepEqual(queue.body.customers.map((row: any) => row.id), [pooled.body.customer.id]);
  const all = await client.get('/api/customers').set(admin);
  assert.equal(all.body.customers.length, 1);

  const alone = await makeRep('مهندس لسه داخل');
  const mine = await client.get('/api/customers').set(alone.auth);
  assert.deepEqual(mine.body.customers, [], 'a customer nobody owns is not on anybody list yet');
  // The phone is not a way into the book: the office is the one that enters it.
  const fieldAdd = await client.post('/api/customers').set(alone.auth).send({ name: 'عميل من الشارع' });
  assert.equal(fieldAdd.status, 403, 'refused, not quietly filed under the manager');
  const fieldEdit = await client.patch(`/api/customers/${pooled.body.customer.id}`).set(alone.auth).send({ phone: '01099999999' });
  assert.equal(fieldEdit.status, 403);
  const fieldDelete = await client.delete(`/api/customers/${pooled.body.customer.id}`).set(alone.auth);
  assert.equal(fieldDelete.status, 403);
  // …and no anonymous request reads the company's list of who buys from it.
  assert.equal((await client.get('/api/customers')).status, 401);
});

test('one name per owner, and that owner only', async () => {
  const aly = await makeRep('علي حسن');
  const first = await book({ name: 'حاج محمد', repId: aly.id });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  // A trailing space is the same farm: the schema trims, and the unique index does the rest.
  const again = await book({ name: 'حاج محمد ', repId: aly.id });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'CUSTOMER_EXISTS');
  assert.match(again.body.error, /قائمة علي حسن/, 'the answer says which list already has him');

  const other = await makeRep('ياسر منير');
  const inAnotherList = await book({ name: 'حاج محمد', repId: other.id });
  assert.equal(inAnotherList.status, 201, 'two engineers may each sell to the same man');
  // The office list carries the same rule, checked in code rather than by an index (db.ts).
  const poolFirst = await book({ name: 'مزرعة الاتحاد' });
  assert.equal(poolFirst.status, 201);
  const poolTwice = await book({ name: 'مزرعة الاتحاد', governorate: 'البحيرة' });
  assert.equal(poolTwice.status, 409);
  assert.equal(poolTwice.body.code, 'CUSTOMER_EXISTS');
  assert.match(poolTwice.body.error, /قائمة الشركة/);
  // The same name at the office and at an engineer is not a duplicate of anything.
  assert.equal((await book({ name: 'مزرعة الاتحاد', repId: aly.id })).status, 201);
  assert.equal((await book({ name: 'مزرعة غلط', repId: 'not-a-uuid' })).status, 400);
  assert.match((await book({ name: 'مزرعة غلط', repId: 'not-a-uuid' })).body.error, /المهندس/);
  assert.equal((await book({ name: 'مزرعة غلط', repId: randomUUID() })).status, 404, 'a real uuid of nobody is refused, not read as «no owner»');
});

test('a refused customer keeps his reason, and a stopped one leaves the way', async () => {
  const aly = await makeRep('هاني صبري');
  const created = await book({ name: 'عميل رُفض', repId: aly.id });
  const id = created.body.customer.id as string;
  const noReason = await client.patch(`/api/customers/${id}`).set(admin).send({ stage: 'lost' });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, 'LOST_REASON_REQUIRED');
  const withReason = await client.patch(`/api/customers/${id}`).set(admin).send({ stage: 'lost', lostReason: 'السعر أعلى من السوق' });
  assert.equal(withReason.status, 200, JSON.stringify(withReason.body));
  assert.equal(withReason.body.customer.lostReason, 'السعر أعلى من السوق');

  const stopped = await client.patch(`/api/customers/${id}`).set(admin).send({ active: false });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.customer.active, false);
  const byOwner = (query: string) => client.get(`/api/customers?repId=${aly.id}${query}`).set(admin);
  assert.deepEqual((await byOwner('')).body.customers, [], 'the working list is the active one');
  assert.equal((await byOwner('&includeInactive=1')).body.customers.length, 1, 'and the manager can still see what is stopped');
  const own = await client.get('/api/customers').set(aly.auth);
  assert.deepEqual(own.body.customers, [], 'an engineer is not handed stopped rows to walk to');
});

test('the area table groups the list by place and names the engineer who drives it', async () => {
  const zaftawy = await makeRep('مهندس زفتى');
  for (const name of ['مزرعة القنال', 'مزرعة بقرش', 'مزرعة السبطخانة']) {
    assert.equal((await book({ name, governorate: 'الغربية', district: 'زفتى' })).status, 201);
  }
  const held = await makeRep('مهندس المحلة');
  assert.equal((await book({ name: 'مزرعة المحلة القديمة', governorate: 'الغربية', district: 'المحلة', repId: held.id })).status, 201);

  const res = await client.get('/api/customers/areas').set(admin);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = res.body.areas.find((area: any) => area.bareDistrict === 'زفتى');
  assert.equal(row.total, 3);
  assert.equal(row.unassigned, 3);
  assert.equal(row.settled, false, 'three customers with no owner is exactly the row to act on');
  assert.equal(row.suggestedRepId, null, 'nobody in the team has a region yet, so nothing is proposed');
  const heldRow = res.body.areas.find((area: any) => area.bareDistrict === 'المحلة');
  assert.equal(heldRow.settled, true, 'an area one engineer already holds is finished with');
  assert.deepEqual(heldRow.owners.map((owner: any) => [owner.repName, owner.customers]), [['مهندس المحلة', 1]]);
  assert.equal(res.body.totals.areas, res.body.areas.length);
  assert.ok(res.body.totals.unassigned >= 3, 'the queue the header counts is the same pool these rows add up to');
  assert.equal((await client.get('/api/customers/areas').set(zaftawy.auth)).status, 403, 'the workbench is the office’s, not the team’s');
});

test('an engineer region is correctable, and that is what makes a proposal', async () => {
  // Its own district: this file shares one store between its tests, and طنطا already holds a row from
  // the first test. A count is only worth asserting inside an area nobody else typed.
  const aly = await makeRep('مهندس قطور');
  assert.equal((await book({ name: 'مزرعة الدلتا', governorate: 'الغربية', district: 'قطور' })).status, 201);
  const empty = await client.patch(`/api/reps/${aly.id}`).set(admin).send({});
  assert.equal(empty.status, 400, 'a patch that changes nothing is a bug elsewhere, not a success');
  const set = await client.patch(`/api/reps/${aly.id}`).set(admin).send({ region: 'قطور' });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.user.region, 'قطور');
  const row = (await client.get('/api/customers/areas').set(admin)).body.areas.find((area: any) => area.bareDistrict === 'قطور');
  assert.equal(row.suggestedRepId, aly.id, 'the area now knows who drives it');
  assert.equal(row.suggestedRepName, 'مهندس قطور');
  // A proposal is not a move: writing the region changed nothing about who owns the customer.
  assert.equal(row.unassigned, 1);
  assert.equal((await client.patch(`/api/reps/${aly.id}`).set(aly.auth).send({ region: 'المنوفية' })).status, 403);
});

test('handing a whole area to an engineer is previewed before it is done', async () => {
  const aly = await makeRep('مهندس المنوفية');
  assert.equal((await client.patch(`/api/reps/${aly.id}`).set(admin).send({ region: 'شبين الكوم' })).status, 200);
  const mine = await book({ name: 'مزرعة شبين', governorate: 'المنوفية', district: 'شبين الكوم' });
  const alsoMine = await book({ name: 'مزرعة سرس الليان', governorate: 'المنوفية', district: 'شبين الكوم' });
  // He already has this one by another name of the same shop, so the office copy cannot land on him.
  const clash = await book({ name: 'مزرعة اللبدي', governorate: 'المنوفية', district: 'شبين الكوم' });
  assert.equal((await book({ name: 'مزرعة اللبدي', repId: aly.id })).status, 201);

  const noArea = await client.post('/api/customers/assign-area').set(admin).send({ repId: aly.id });
  assert.equal(noArea.status, 400);
  assert.equal(noArea.body.code, 'AREA_REQUIRED', 'one press never moves the whole company list');

  const preview = await client.post('/api/customers/assign-area').set(admin)
    .send({ governorate: 'المنوفية', district: 'شبين الكوم', repId: aly.id, dryRun: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual([preview.body.matched, preview.body.wouldMove], [3, 2]);
  assert.deepEqual(preview.body.conflicts.map((row: any) => row.id), [clash.body.customer.id]);
  assert.equal(store.get('SELECT rep_id AS v FROM customers WHERE id=?', mine.body.customer.id)?.v, null, 'a preview writes nothing');
  assert.equal(store.get('SELECT rep_id AS v FROM customers WHERE id=?', alsoMine.body.customer.id)?.v, null);

  const moved = await client.post('/api/customers/assign-area').set(admin)
    .send({ governorate: 'المنوفية', district: 'شبين الكوم', repId: aly.id });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.moved, moved.body.skipped], [2, 1]);
  assert.equal(store.get('SELECT rep_id AS v FROM customers WHERE id=?', clash.body.customer.id)?.v, null, 'the clash stays where it is');
  const hisList = await client.get('/api/customers').set(aly.auth);
  assert.equal(hisList.body.customers.length, 3, 'the engineer is handed exactly what the preview said');
  const logged = store.get("SELECT metadata FROM audit_log WHERE action='customer.assignArea' ORDER BY created_at DESC, rowid LIMIT 1");
  assert.ok(logged, 'the move is in the audit trail');
  assert.equal(JSON.parse(String(logged.metadata)).moved, 2);

  // A second press: the area still holds three rows, and none of them can move.
  const again = await client.post('/api/customers/assign-area').set(admin)
    .send({ governorate: 'المنوفية', district: 'شبين الكوم', repId: aly.id });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, 'CUSTOMER_EXISTS');
  assert.match(again.body.error, /تعارض اسم/);
  assert.equal((await client.post('/api/customers/assign-area').set(aly.auth).send({ district: 'طنطا', repId: aly.id })).status, 403);
});

test('an area goes back to the office only when he is told so', async () => {
  const aly = await makeRep('مهندس الشرقية');
  const said = await makeRep('مهندس الشرقية التاني');
  const handed = await book({ name: 'مزرعة العاشر', governorate: 'الشرقية', district: 'العاشر من رمضان', repId: aly.id });
  const kept = await book({ name: 'مزرعة فاقوس', governorate: 'الشرقية', district: 'العاشر من رمضان', repId: said.id });

  // With the safe switch on, there is nothing in that area that belongs to nobody — so this press is
  // refused rather than reported as a success that changed nothing.
  const refused = await client.post('/api/customers/assign-area').set(admin)
    .send({ governorate: 'الشرقية', district: 'العاشر من رمضان', repId: null });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'NO_CHANGE');
  assert.match(refused.body.error, /اقفل/);

  const back = await client.post('/api/customers/assign-area').set(admin)
    .send({ governorate: 'الشرقية', district: 'العاشر من رمضان', repId: null, onlyUnassigned: false });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.moved, 2, 'both rows return to the company list when the switch is off');
  assert.equal(store.get('SELECT rep_id AS v FROM customers WHERE id=?', handed.body.customer.id)?.v, null);
  assert.equal(store.get('SELECT rep_id AS v FROM customers WHERE id=?', kept.body.customer.id)?.v, null);
});

test('one customer at a time: to an engineer, unchanged, or back to the office', async () => {
  const aly = await makeRep('مهندس محله');
  const said = await makeRep('مهندس منوف');
  const created = await book({ name: 'مزرعة الكيلو ١٢', governorate: 'المنوفية', district: 'شبين الكوم' });
  const id = created.body.customer.id as string;

  const toAly = await client.post(`/api/customers/${id}/assign`).set(admin).send({ repId: aly.id });
  assert.equal(toAly.status, 200, JSON.stringify(toAly.body));
  assert.equal(toAly.body.customer.repId, aly.id);
  const sameAgain = await client.post(`/api/customers/${id}/assign`).set(admin).send({ repId: aly.id });
  assert.equal(sameAgain.body.unchanged, true, 'pressing the same thing twice is not two moves');

  // The receiver already has that farm: the move is refused and the two rows are left for a human.
  assert.equal((await book({ name: 'مزرعة الكيلو ١٢', repId: said.id })).status, 201);
  const collide = await client.post(`/api/customers/${id}/assign`).set(admin).send({ repId: said.id });
  assert.equal(collide.status, 409);
  assert.equal(collide.body.code, 'CUSTOMER_EXISTS');
  assert.match(collide.body.error, /ادمج العميلين/);
  assert.equal(store.get('SELECT rep_id AS v FROM customers WHERE id=?', id)?.v, aly.id, 'the refused move left him where he was');

  const off = await client.post(`/api/customers/${id}/assign`).set(admin).send({ repId: null });
  assert.equal(off.status, 200);
  assert.equal(off.body.customer.repId, null);
  assert.equal(off.body.customer.repName, 'من غير مهندس');
  assert.equal((await client.post(`/api/customers/${id}/assign`).set(admin).send({ repId: randomUUID() })).status, 404);
  assert.equal((await client.post(`/api/customers/${id}/assign`).set(aly.auth).send({ repId: said.id })).status, 403);
});

test('a visit is booked on a row of the book, and only on the office’s copy of the name', async () => {
  const aly = await makeRep('مهندس زيارة');
  const other = await makeRep('مهندس تاني');
  const customer = await book({ name: 'مزرعة النخيل', governorate: 'الغربية', district: 'طنطا', phone: '01100000002', repId: aly.id });
  const customerId = customer.body.customer.id as string;
  await openShift(aly);

  const visit = await checkIn(aly, { customerId, customerName: 'اسم كتبه المهندس' });
  assert.equal(visit.status, 201, JSON.stringify(visit.body));
  assert.equal(visit.body.visit.customerId, customerId);
  assert.equal(visit.body.visit.customerName, 'مزرعة النخيل', 'the phone does not name a customer, the book does');
  assert.equal(visit.body.visit.district, 'طنطا', 'and what the phone did not send falls back to the row');
  const listed = await client.get('/api/customers').set(aly.auth);
  const row = listed.body.customers.find((item: any) => item.id === customerId);
  assert.equal(row.visitCount, 1);
  assert.ok(row.lastVisitAt, 'the cooling clock starts from the visit itself');
  assert.equal(row.openVisits, 1);
  const audit = store.get("SELECT metadata FROM audit_log WHERE action LIKE 'visit.check_in%' ORDER BY created_at DESC, rowid LIMIT 1");
  assert.equal(JSON.parse(String(audit.metadata)).customerId, customerId, 'the trail ties the visit to the row');

  const closedVisit = await client.post(`/api/visits/${visit.body.visit.id}/check-out`).set(aly.auth)
    .send({ outcome: 'تم', notes: '', amount: null, location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(closedVisit.status, 200, JSON.stringify(closedVisit.body));
  // The visit that was stored is not rewritten by what happens to the customer after it: the row is
  // history, and it reads with the name the office had on the day.
  assert.equal(store.get('SELECT customer_name AS name FROM visits WHERE id=?', visit.body.visit.id)?.name, 'مزرعة النخيل');
  // A phone still running a build from before the book sends a typed name and no id. This is also
  // exactly what a queued offline visit looks like when it is replayed after an upgrade: it is refused
  // with a code the outbox can show, rather than being filed under a customer nobody picked.
  const legacy = await checkIn(aly, { customerName: 'اسم من بيلد قديم' });
  assert.equal(legacy.status, 400);
  assert.equal(legacy.body.code, 'CUSTOMER_REQUIRED');
  assert.match(legacy.body.error, /قائمتك/);
  const ghost = await checkIn(aly, { customerId: randomUUID() });
  assert.equal(ghost.status, 400);
  assert.equal(ghost.body.code, 'CUSTOMER_NOT_FOUND');
  assert.match(ghost.body.error, /قائمة الشركة/);
  const theirs = await book({ name: 'مزرعة الزميل', repId: other.id });
  const poached = await checkIn(aly, { customerId: theirs.body.customer.id });
  assert.equal(poached.status, 403);
  assert.equal(poached.body.code, 'CUSTOMER_NOT_YOURS');
  const unowned = await book({ name: 'مزرعة لسه موزعتش' });
  assert.equal((await checkIn(aly, { customerId: unowned.body.customer.id })).body.code, 'CUSTOMER_NOT_YOURS');
  const stopped = await client.patch(`/api/customers/${customerId}`).set(admin).send({ active: false });
  assert.equal(stopped.status, 200);
  const onStopped = await checkIn(aly, { customerId });
  assert.equal(onStopped.status, 409, 'a stopped customer is not somebody to walk to');
  assert.equal(onStopped.body.code, 'CUSTOMER_INACTIVE');
});

test('a customer with history is stopped, not deleted', async () => {
  const aly = await makeRep('مهندس حذف');
  const visited = await book({ name: 'عميل عليه تاريخ', repId: aly.id });
  await openShift(aly);
  const checkin = await checkIn(aly, { customerId: visited.body.customer.id });
  assert.equal(checkin.status, 201, JSON.stringify(checkin.body));
  const blocked = await client.delete(`/api/customers/${visited.body.customer.id}`).set(admin);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'CUSTOMER_HAS_VISITS');
  assert.match(blocked.body.error, /وقّفه/);
  const clean = await book({ name: 'عميل نضيف' });
  assert.equal((await client.delete(`/api/customers/${clean.body.customer.id}`).set(admin)).status, 200);
  assert.equal(store.get('SELECT id FROM customers WHERE id=?', clean.body.customer.id), undefined);
  assert.equal((await client.delete('/api/customers/does-not-exist').set(admin)).status, 404);
});

test('an edit that touches one field leaves the fields that were not sent alone', async () => {
  // The shape a partial patch used to destroy: `.partial()` keeps create-time defaults, so `{ active }`
  // arrived as `phone: ''`, `governorate: ''`, `stage: 'new'` and the route wrote all of it over the row.
  // Pressing «وقف» on a customer in the dashboard erased his number and his area, and nothing on screen
  // said so. A key the caller did not send must stay absent, not become a default.
  const created = await book({
    name: 'مزرعة الروّاد', phone: '01000000055', governorate: 'الغربية', district: 'طنطا', village: 'ميت حابس',
    notes: 'بيشتري يوريا كل شهر', stage: 'following',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.customer.id as string;
  const before = created.body.customer;

  const stopped = await client.patch(`/api/customers/${id}`).set(admin).send({ active: false });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.customer.active, false, 'the one thing that was asked for happened');
  for (const field of ['phone', 'governorate', 'district', 'village', 'notes', 'stage'] as const) {
    assert.equal(stopped.body.customer[field], before[field], `${field} was not in the body and must be untouched`);
  }

  // And a patch that does send a field still writes it, blank included: «sent empty» and «not sent» are
  // different requests, and only the second one means «keep».
  const cleared = await client.patch(`/api/customers/${id}`).set(admin).send({ phone: '', notes: 'ملاحظة جديدة' });
  assert.equal(cleared.body.customer.phone, '');
  assert.equal(cleared.body.customer.notes, 'ملاحظة جديدة');
  assert.equal(cleared.body.customer.governorate, before.governorate, 'the area survived the phone being cleared');
  assert.equal(cleared.body.customer.stage, before.stage, 'and the stage survived it too');
  // Stopping a customer takes him out of the default list, so the row is read with the stopped ones in.
  const listed = await client.get('/api/customers?q=مزرعة الروّاد&includeInactive=1').set(admin);
  assert.equal(listed.body.customers[0].governorate, before.governorate, 'the list reads the row, not the last patch');
  assert.equal(listed.body.customers[0].active, false);

  // The field that actually broke is the one spelled differently in the row and in the body: lost_reason
  // versus lostReason. Moving a refused customer back to «بيتابع» must not delete why he said no, and an
  // edit of his phone number must not either.
  const refused = await book({ name: 'مزرعة الرفض', governorate: 'الغربية', district: 'طنطا', stage: 'lost', lostReason: 'السعر أعلى من السوق' });
  assert.equal(refused.status, 201, JSON.stringify(refused.body));
  const touched = await client.patch(`/api/customers/${refused.body.customer.id}`).set(admin).send({ phone: '01000000077' });
  assert.equal(touched.status, 200, JSON.stringify(touched.body));
  assert.equal(touched.body.customer.lostReason, 'السعر أعلى من السوق', 'the reason survived an unrelated edit');
  assert.equal(touched.body.customer.stage, 'lost');
});

test('an exact unnamed district never moves customers from other districts', async () => {
  const rep = await makeRep('مهندس الاختبار');
  const a = await book({ name: 'من غير مركز', governorate: 'اختبار الحدود', district: '' });
  const b = await book({ name: 'مركز تاني', governorate: 'اختبار الحدود', district: 'مدينة' });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const body = { governorate: 'اختبار الحدود', district: '', repId: rep.id, onlyUnassigned: true, exactArea: true };
  const preview = await client.post('/api/customers/assign-area').set(admin).send({ ...body, dryRun: true });
  assert.equal(preview.body.wouldMove, 1);
  const moved = await client.post('/api/customers/assign-area').set(admin).send(body);
  assert.equal(moved.body.moved, 1);
  assert.equal((await client.get('/api/customers').set(admin)).body.customers.find((row: any) => row.id === b.body.customer.id).repId, null);
});
