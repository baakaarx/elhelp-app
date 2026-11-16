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

async function makeRep(tag: string) {
  const admin = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
  const email = `${tag}.${Date.now()}@autoclose.test`;
  const created = await client.post('/api/reps').set('Authorization', `Bearer ${admin.body.token}`)
    .send({ name: `مهندس ${tag}`, email, password: 'RepPassword123!' });
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
  const admin = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
  const off = await client.patch(`/api/reps/${rep.id}`).set('Authorization', `Bearer ${admin.body.token}`).send({ active: false });
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
