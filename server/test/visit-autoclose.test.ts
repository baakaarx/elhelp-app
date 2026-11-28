import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { tokenHash } from '../src/auth.js';
import { AUTO_CLOSED_OUTCOME, Store } from '../src/db.js';
import { localDate } from '../src/geo.js';
import { bookForToken } from './book.js';

/**
 * A visit left open when the shift ends used to stay open for good.
 *
 * The phone showed a stopwatch running for days, and the next check-in was refused with
 * "لديك زيارة مفتوحة" — a message the engineer only meets in another tab. The manager's board
 * showed a customer visit that never ended.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@autoclose.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  staleGpsMinutes: 10, idleReasonMinutes: 60,
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

const DAY = 86400000;

/**
 * One manager session for the whole file: the login route is rate-limited per address (15 per
 * quarter of an hour), and eight accounts created with a fresh manager login each would hit it.
 */
let adminToken = '';
async function admin() {
  if (!adminToken) {
    const res = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
    adminToken = String(res.body.token);
  }
  return adminToken;
}
async function makeRep(tag: string) {
  const email = `${tag}.${Date.now()}@autoclose.test`;
  // Resolve the token before building the request: awaiting inside supertest's chain suspends
  // after the Test object is created, and it then has no server to talk to.
  const adminTokenValue = await admin();
  const created = await client.post('/api/reps').set('Authorization', `Bearer ${adminTokenValue}`)
    .send({ region: 'منطقة اختبار', name: `مهندس ${tag}`, email, password: 'RepPassword123!' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  // A session row is what the login route writes; minting it here keeps the per-address login
  // limit (15 per quarter of an hour) out of the way of a file that needs a dozen engineers.
  const token = randomBytes(32).toString('base64url');
  store.run('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)',
    tokenHash(token), String(created.body.user.id), Date.now() + 3600000, Date.now());
  return { id: String(created.body.user.id), token, email };
}

async function openShift(token: string, deviceId: string) {
  const res = await client.post('/api/shifts/start').set('Authorization', `Bearer ${token}`)
    .send({ consentVersion: '1.0', deviceId, deviceName: 'جهاز', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return String(res.body.shift.id);
}

async function checkIn(token: string, name = 'مزرعة مفتوحة') {
  const id = randomUUID();
  const res = await client.post('/api/visits/check-in').set('Authorization', `Bearer ${token}`)
    .send({ id, customerId: bookForToken(store, token, name), customerName: name, purpose: 'visit', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return id;
}

test('ending the shift closes the visit that was still open', async () => {
  const rep = await makeRep('stop');
  const shiftId = await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token);

  const stop = await client.post('/api/shifts/stop').set('Authorization', `Bearer ${rep.token}`);
  assert.equal(stop.status, 200);

  const row = store.get('SELECT * FROM visits WHERE id=?', visitId)!;
  assert.equal(row.status, 'closed', 'the visit must not stay open after the shift');
  assert.equal(Number(row.auto_closed), 1, 'and it is marked as closed by the system');
  assert.equal(row.outcome, AUTO_CLOSED_OUTCOME);
  const shift = store.get('SELECT ended_at FROM shifts WHERE id=?', shiftId)!;
  assert.equal(Number(row.checked_out_at), Number(shift.ended_at), 'shift-stop closure uses the server-recorded shift end');
  assert.ok(Number(row.duration_seconds) >= 0);

  // The whole point: the next visit is accepted.
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const second = await checkIn(rep.token, 'مزرعة تانية');
  assert.ok(second);
});

test('a visit with a written result keeps it when the shift ends', async () => {
  const rep = await makeRep('keep');
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token);
  // A direct write, so the row looks like one that closed with a result but was left open.
  store.run("UPDATE visits SET outcome='اتفقنا على التوريد' WHERE id=?", visitId);
  await client.post('/api/shifts/stop').set('Authorization', `Bearer ${rep.token}`);
  const row = store.get('SELECT * FROM visits WHERE id=?', visitId)!;
  assert.equal(row.outcome, 'اتفقنا على التوريد', 'an existing result is never overwritten');
});

test('disabling an engineer closes their open visit too', async () => {
  const rep = await makeRep('disable');
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token);
  const token = await admin();
  const off = await client.patch(`/api/reps/${rep.id}`).set('Authorization', `Bearer ${token}`).send({ active: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  const row = store.get('SELECT * FROM visits WHERE id=?', visitId)!;
  assert.equal(row.status, 'closed');
  assert.equal(Number(row.auto_closed), 1);
});

test('the cleanup closes a visit nobody ended, and the KPI average ignores it', async () => {
  const store2 = new Store(':memory:');
  const userId = randomUUID();
  store2.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
    userId, 'مهندس قديم', `old.${Date.now()}@test`, 'x', 'rep', Date.now() - 5 * DAY);
  const now = Date.now();
  // Open for two days, and one closed visit that was actually measured.
  store2.run("INSERT INTO visits(id,user_id,customer_name,purpose,notes,outcome,status,checked_in_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    randomUUID(), userId, 'زيارة متروكة', 'visit', '', '', 'open', now - 2 * DAY, now - 2 * DAY);
  store2.run("INSERT INTO visits(id,user_id,customer_name,purpose,notes,outcome,status,checked_in_at,checked_out_at,duration_seconds,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    randomUUID(), userId, 'زيارة مقاسة', 'visit', '', 'تم', 'closed', now - DAY, now - DAY + 1800000, 1800, now - DAY);

  store2.cleanup(365);

  const abandoned = store2.get("SELECT * FROM visits WHERE customer_name='زيارة متروكة'")!;
  assert.equal(abandoned.status, 'closed');
  assert.equal(Number(abandoned.auto_closed), 1);
  assert.equal(abandoned.outcome, AUTO_CLOSED_OUTCOME);
  assert.equal(abandoned.checked_out_at, null, 'the cleanup cannot invent a checkout time');
  assert.equal(abandoned.duration_seconds, null, 'unknown duration stays unknown, not zero');

  const avg = store2.get('SELECT AVG(CASE WHEN status=\'closed\' AND auto_closed=0 THEN duration_seconds END) AS avgDuration FROM visits WHERE user_id=?', userId)!;
  assert.equal(Number(avg.avgDuration), 1800, 'only the measured visit counts');
  store2.close();
});

test('the summary keeps showing the real open visit while the shift runs', async () => {
  const rep = await makeRep('live');
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token);
  const summary = await client.get('/api/me/summary').set('Authorization', `Bearer ${rep.token}`);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.openVisit?.id, visitId, 'an open visit is still reported as open mid-shift');
  assert.ok(localDate(config.timezone));
});

test('the result of a visit the system closed can still be recorded', async () => {
  const rep = await makeRep('late');
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token, 'مزرعة النتيجة المتأخرة');
  const stop = await client.post('/api/shifts/stop').set('Authorization', `Bearer ${rep.token}`);
  assert.equal(stop.status, 200);
  const before = store.get('SELECT * FROM visits WHERE id=?', visitId)!;
  assert.equal(before.status, 'closed');

  // The next morning the engineer remembers what happened and writes it.
  const late = await client.post(`/api/visits/${visitId}/check-out`).set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'العميل طلب تأجيل التوريد لشهر قادم', notes: '', amount: null, location: null });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(late.body.recordedLate, true);
  assert.equal(late.body.visit.outcome, 'العميل طلب تأجيل التوريد لشهر قادم');

  const row = store.get('SELECT * FROM visits WHERE id=?', visitId)!;
  assert.equal(Number(row.auto_closed), 1, 'the duration is still not measured, so the average keeps ignoring it');
  assert.equal(Number(row.duration_seconds), Number(before.duration_seconds), 'no invented duration');
});

test('the engineer summary excludes automatic closures from the measured visit average', async () => {
  const rep = await makeRep('average');
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const measuredId = await checkIn(rep.token, 'زيارة مقاسة');
  const measured = await client.post(`/api/visits/${measuredId}/check-out`).set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'تمت الزيارة', notes: '', amount: null, location: null });
  assert.equal(measured.status, 200, JSON.stringify(measured.body));
  store.run('UPDATE visits SET duration_seconds=600 WHERE id=?', measuredId);

  const automaticId = await checkIn(rep.token, 'زيارة أُغلقت تلقائيًا');
  await client.post('/api/shifts/stop').set('Authorization', `Bearer ${rep.token}`);
  assert.equal(Number(store.get('SELECT auto_closed FROM visits WHERE id=?', automaticId)!.auto_closed), 1);

  const summary = await client.get('/api/me/summary').set('Authorization', `Bearer ${rep.token}`);
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.visitsCompleted, 2, 'both closed rows still count as completed');
  assert.equal(summary.body.avgVisitSeconds, 600, 'the automatic close must not dilute the measured average');
});

test('an auto-closed offline result rejects stale, future, and pre-check-in timestamps', async () => {
  const rep = await makeRep('late-time');
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token, 'مزرعة وقت النتيجة');
  assert.equal((await client.post('/api/shifts/stop').set('Authorization', `Bearer ${rep.token}`)).status, 200);
  const before = store.get('SELECT checked_in_at AS checkedInAt, checked_out_at AS checkedOutAt, outcome FROM visits WHERE id=?', visitId)!;
  assert.equal(before.outcome, AUTO_CLOSED_OUTCOME);

  const sendLateResult = (recordedAt: number) => client.post(`/api/visits/${visitId}/check-out`)
    .set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'نتيجة وقت الزيارة', notes: '', amount: null, location: null, recordedAt });
  for (const recordedAt of [
    Date.now() + 5 * 60000,
    Date.now() - 25 * 3600000,
    Number(before.checkedInAt) - 2 * 60000,
  ]) {
    const rejected = await sendLateResult(recordedAt);
    assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
    assert.equal(rejected.body.code, 'OFFLINE_VISIT_REJECTED');
    const unchanged = store.get('SELECT checked_out_at AS checkedOutAt, outcome FROM visits WHERE id=?', visitId)!;
    assert.equal(unchanged.checkedOutAt, before.checkedOutAt);
    assert.equal(unchanged.outcome, AUTO_CLOSED_OUTCOME);
  }

  const recordedAt = Date.now();
  const accepted = await sendLateResult(recordedAt);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.visit.checkedOutAt, recordedAt);
  assert.equal(accepted.body.visit.outcome, 'نتيجة وقت الزيارة');
});

test('a visit that was closed normally rejects a different result rather than claiming it was saved', async () => {
  const rep = await makeRep('normal');
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token, 'مزرعة عادية');
  const closed = await client.post(`/api/visits/${visitId}/check-out`).set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'تمت المتابعة', notes: '', amount: null, location: null });
  assert.equal(closed.status, 200);
  const again = await client.post(`/api/visits/${visitId}/check-out`).set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'نتيجة تانية', notes: '', amount: null, location: null });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'VISIT_RESULT_CONFLICT');
  const row = store.get('SELECT outcome FROM visits WHERE id=?', visitId)!;
  assert.equal(row.outcome, 'تمت المتابعة', 'a real result is never overwritten by a retry');
});

test('an old automatically closed visit can be finished without recording a field payment', async () => {
  const rep = await makeRep('money'); await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const id = randomUUID();
  const opened = await client.post('/api/visits/check-in').set('Authorization', `Bearer ${rep.token}`)
    .send({ id, customerId: bookForToken(store, rep.token, 'مزرعة قديمة'), purpose: 'visit', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(opened.status, 201);
  store.run("UPDATE visits SET purpose='collection' WHERE id=?", id); // existing legacy visit
  await client.post('/api/shifts/stop').set('Authorization', `Bearer ${rep.token}`);
  const late = await client.post(`/api/visits/${id}/check-out`).set('Authorization', `Bearer ${rep.token}`).send({ outcome: 'متابعة', amount: 750 });
  assert.equal(late.status, 403); assert.equal(late.body.code, 'FIELD_COLLECTION_DISABLED');
  const accepted = await client.post(`/api/visits/${id}/check-out`).set('Authorization', `Bearer ${rep.token}`).send({ outcome: 'متابعة', amount: null });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.recordedLate, true);
  assert.equal(store.get('SELECT id FROM reports WHERE id=?', `visit:${id}`), undefined);
});

test('a visit from yesterday still missing a result stays visible to its engineer', async () => {
  const rep = await makeRep('yesterday');
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token, 'مزرعة امبارح');
  await client.post('/api/shifts/stop').set('Authorization', `Bearer ${rep.token}`);

  // The app was killed before the result was written, so the visit is yesterday's by the time
  // the engineer opens the app again: the "today" list must still carry it.
  const yesterday = Date.now() - 26 * 3600000;
  store.run('UPDATE visits SET checked_in_at=?, checked_out_at=? WHERE id=?', yesterday, yesterday, visitId);

  const listed = await client.get('/api/visits').set('Authorization', `Bearer ${rep.token}`);
  assert.equal(listed.status, 200);
  const row = (listed.body.visits as Array<any>).find(visit => visit.id === visitId);
  assert.ok(row, 'the visit must be in the list the app reads');
  assert.ok(row.pendingResult, 'flagged as still missing a result');
  assert.equal(row.status, 'closed');

  const late = await client.post(`/api/visits/${visitId}/check-out`).set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'العميل رفض الكمية', notes: '', amount: null, location: null });
  assert.equal(late.status, 200);

  const after = await client.get('/api/visits').set('Authorization', `Bearer ${rep.token}`);
  const stillThere = (after.body.visits as Array<any>).find(visit => visit.id === visitId);
  if (stillThere) assert.ok(!stillThere.pendingResult, 'once answered it is no longer pending');
});

test('a rep never sees another rep\'s visits', async () => {
  const first = await makeRep('own1');
  const second = await makeRep('own2');
  await openShift(first.token, `device-${first.id.slice(0, 6)}`);
  const visitId = await checkIn(first.token, 'زيارة خاصة');
  const listed = await client.get('/api/visits').set('Authorization', `Bearer ${second.token}`);
  assert.equal(listed.status, 200);
  assert.ok(!(listed.body.visits as Array<any>).some(visit => visit.id === visitId));
});

test('a recorded late result is not rewritten by a retried request', async () => {
  const rep = await makeRep('retry');
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token, 'مزرعة التكرار');
  await client.post('/api/shifts/stop').set('Authorization', `Bearer ${rep.token}`);
  const first = await client.post(`/api/visits/${visitId}/check-out`).set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'الطلب اتأجل لأسبوع', notes: '', amount: null, location: null });
  assert.equal(first.status, 200);
  // The offline queue can send the same request twice.
  const second = await client.post(`/api/visits/${visitId}/check-out`).set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'الطلب اتأجل لأسبوع', notes: '', amount: null, location: null });
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  const row = store.get('SELECT outcome FROM visits WHERE id=?', visitId)!;
  assert.equal(row.outcome, 'الطلب اتأجل لأسبوع');
});

test('the two flags travel as booleans, not as SQLite 0/1', async () => {
  const rep = await makeRep('flags');
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token, 'مزرعة الأعلام');
  await client.post('/api/shifts/stop').set('Authorization', `Bearer ${rep.token}`);
  const listed = await client.get('/api/visits').set('Authorization', `Bearer ${rep.token}`);
  const row = (listed.body.visits as Array<any>).find(visit => visit.id === visitId)!;
  assert.equal(row.autoClosed, true, 'a boolean, so the app can compare with === true');
  assert.equal(row.pendingResult, true);
  const closed = await client.get(`/api/visits?date=${localDate(config.timezone)}`).set('Authorization', `Bearer ${rep.token}`);
  const same = (closed.body.visits as Array<any>).find(visit => visit.id === visitId);
  assert.equal(same?.autoClosed, true);
});

/**
 * The same dead end from the other side: a visit left open by a shift that was closed somewhere
 * else. It is not on the "today" screen, so nothing could close it, while every new check-in was
 * refused with a message about a visit the engineer could not see.
 */
test('a shift closed elsewhere does not strand an open visit', async () => {
  const rep = await makeRep('orphan');
  const shiftId = await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token, 'مزرعة الوردية الضائعة');

  // The shift ends without the stop request ever arriving (the phone died): the cleanup rule
  // closes a shift that has been silent, and the visit that belonged to it must not survive it.
  store.run('UPDATE shifts SET ended_at=? WHERE id=?', Date.now(), shiftId);
  store.cleanup(config.retentionDays);

  const row = store.get('SELECT * FROM visits WHERE id=?', visitId)!;
  assert.equal(row.status, 'closed', 'an open visit cannot outlive its shift');
  assert.equal(Number(row.auto_closed), 1);
  assert.equal(row.outcome, AUTO_CLOSED_OUTCOME);

  const listed = await client.get('/api/visits').set('Authorization', `Bearer ${rep.token}`);
  const visit = (listed.body.visits as Array<any>).find(item => item.id === visitId)!;
  assert.ok(visit.pendingResult, 'and it stays on the engineer screen so the result can be typed');

  // A visit opened while a shift is running is untouched by the same cleanup.
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const live = await checkIn(rep.token, 'مزرعة شغالة');
  store.cleanup(config.retentionDays);
  assert.equal(store.get('SELECT status FROM visits WHERE id=?', live)!.status, 'open');
});

test('an open visit from an earlier day is listed so it can be closed', async () => {
  const rep = await makeRep('listed');
  const shiftId = await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token, 'مزرعة امبارح');

  // Yesterday's visit, still open: the screen only asks for today's, so it used to be invisible
  // while the engineer kept his shift and kept being refused the next check-in.
  const yesterday = Date.now() - DAY;
  store.run('UPDATE visits SET checked_in_at=? WHERE id=?', yesterday, visitId);
  store.run('UPDATE shifts SET started_at=? WHERE id=?', yesterday - 60000, shiftId);

  const listed = await client.get('/api/visits').set('Authorization', `Bearer ${rep.token}`);
  const visit = (listed.body.visits as Array<any>).find(item => item.id === visitId);
  assert.ok(visit, 'the open visit from yesterday is on the list');
  assert.equal(visit.status, 'open');

  // And it can be closed from there, which is the whole point of showing it.
  const closed = await client.post(`/api/visits/${visitId}/check-out`).set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'اتقفلت من الشاشة', notes: '', amount: null, location: null });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.visit.status, 'closed');
  assert.equal(closed.body.visit.outcome, 'اتقفلت من الشاشة');
  assert.equal(closed.body.visit.autoClosed, false);

  // The next check-in is accepted again instead of answering 409 with a visit nobody could see.
  const next = await client.post('/api/shifts/check-in-placeholder', {}).set('Authorization', `Bearer ${rep.token}`);
  assert.equal(next.status, 404);
  const fresh = await checkIn(rep.token, 'مزرعة جديدة');
  assert.ok(fresh);
});

test('the filters only add the extra rows they are about', async () => {
  const rep = await makeRep('filters');
  const device = `device-${rep.id.slice(0, 6)}`;
  await openShift(rep.token, device);
  const openId = await checkIn(rep.token, 'مزرعة مفتوحة من امبارح');
  const yesterday = Date.now() - DAY;
  store.run('UPDATE visits SET checked_in_at=? WHERE id=?', yesterday, openId);

  const all = async () => (await client.get('/api/visits').set('Authorization', `Bearer ${rep.token}`)).body.visits as Array<any>;
  const closedOnly = async () => (await client.get('/api/visits?status=closed').set('Authorization', `Bearer ${rep.token}`)).body.visits as Array<any>;
  const openOnly = async () => (await client.get('/api/visits?status=open').set('Authorization', `Bearer ${rep.token}`)).body.visits as Array<any>;

  // Still open, and not from today: the open filter is exactly about it, the closed one is not.
  assert.ok((await openOnly()).some(visit => visit.id === openId), 'the open filter carries it');
  assert.ok(!(await closedOnly()).some(visit => visit.id === openId), 'the closed filter does not');
  assert.ok((await closedOnly()).every(visit => visit.status === 'closed'));
  assert.ok((await openOnly()).every(visit => visit.status === 'open'));

  // Finished now, with a result: a plain visit of yesterday, which belongs to `?date=`.
  const done = await client.post(`/api/visits/${openId}/check-out`).set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'اتقفلت عادي', notes: '', amount: null, location: null });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(!(await all()).some(visit => visit.id === openId), 'a finished visit of yesterday is not today');

  // A second one, auto-closed by the end of the shift and missing its result, from yesterday.
  const autoId = await checkIn(rep.token, 'مزرعة بدون نتيجة');
  assert.equal((await client.post('/api/shifts/stop').set('Authorization', `Bearer ${rep.token}`)).status, 200);
  store.run('UPDATE visits SET checked_in_at=? WHERE id=?', yesterday, autoId);
  const listed = await all();
  assert.ok(listed.some(visit => visit.id === autoId), 'the missing result is on the default list');
  assert.ok((await closedOnly()).some(visit => visit.id === autoId), 'and on the closed filter');
  assert.ok(!(await openOnly()).some(visit => visit.id === autoId), 'but not on the open one');
  assert.equal(listed.length, new Set(listed.map(visit => visit.id)).size, 'no visit is listed twice');
});
