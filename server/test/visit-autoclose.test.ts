import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { AUTO_CLOSED_OUTCOME, Store } from '../src/db.js';
import { localDate } from '../src/geo.js';

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
  const token = await admin();
  const created = await client.post('/api/reps').set('Authorization', `Bearer ${token}`)
    .send({ name: `مهندس ${tag}`, email, password: 'RepPassword123!' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const login = await client.post('/api/auth/login').send({ email, password: 'RepPassword123!' });
  return { id: String(created.body.user.id), token: String(login.body.token), email };
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
    .send({ id, customerName: name, purpose: 'visit', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return id;
}

test('ending the shift closes the visit that was still open', async () => {
  const rep = await makeRep('stop');
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token);

  const stop = await client.post('/api/shifts/stop').set('Authorization', `Bearer ${rep.token}`);
  assert.equal(stop.status, 200);

  const row = store.get('SELECT * FROM visits WHERE id=?', visitId)!;
  assert.equal(row.status, 'closed', 'the visit must not stay open after the shift');
  assert.equal(Number(row.auto_closed), 1, 'and it is marked as closed by the system');
  assert.equal(row.outcome, AUTO_CLOSED_OUTCOME);
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
  assert.equal(Number(abandoned.duration_seconds), 0, 'no invented duration');

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

test('a visit that was closed normally still answers duplicate', async () => {
  const rep = await makeRep('normal');
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const visitId = await checkIn(rep.token, 'مزرعة عادية');
  const closed = await client.post(`/api/visits/${visitId}/check-out`).set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'تمت المتابعة', notes: '', amount: null, location: null });
  assert.equal(closed.status, 200);
  const again = await client.post(`/api/visits/${visitId}/check-out`).set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'نتيجة تانية', notes: '', amount: null, location: null });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  const row = store.get('SELECT outcome FROM visits WHERE id=?', visitId)!;
  assert.equal(row.outcome, 'تمت المتابعة', 'a real result is never overwritten by a retry');
});

test('a late collection amount still reaches the manager as a collection', async () => {
  const rep = await makeRep('money');
  await openShift(rep.token, `device-${rep.id.slice(0, 6)}`);
  const id = randomUUID();
  await client.post('/api/visits/check-in').set('Authorization', `Bearer ${rep.token}`)
    .send({ id, customerName: 'مزرعة تحصيل', purpose: 'collection', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  await client.post('/api/shifts/stop').set('Authorization', `Bearer ${rep.token}`);
  const late = await client.post(`/api/visits/${id}/check-out`).set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'تم التحصيل نقدًا', notes: '', amount: 750, location: null });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  const report = store.get("SELECT * FROM reports WHERE id=?", `visit:${id}`)!;
  assert.ok(report, 'the collection must appear in the reports feed');
  assert.equal(Number(report.amount), 750);
  // Repeating the request must not duplicate the financial row.
  await client.post(`/api/visits/${id}/check-out`).set('Authorization', `Bearer ${rep.token}`)
    .send({ outcome: 'تم التحصيل نقدًا', notes: '', amount: 750, location: null });
  const count = store.get("SELECT COUNT(*) AS c FROM reports WHERE id=?", `visit:${id}`)!;
  assert.equal(Number(count.c), 1);
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
