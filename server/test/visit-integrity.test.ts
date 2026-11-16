import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { tokenHash } from '../src/auth.js';

/**
 * A visit is a claim about being somewhere.
 *
 * Nothing on the phone stops a mock-location app from making that claim from the office, and the
 * server cannot ask Android whether the fix was real. What it can do is compare the claim with
 * the engineer's own trail: a visit recorded kilometres away from the only fixes of that hour is
 * worth a manager's attention, and so is a second visit registered on the exact same coordinates.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@trail.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  staleGpsMinutes: 10, idleReasonMinutes: 60,
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const DAY = 86400000;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(Date.now());
let adminToken = '';
async function admin() {
  if (!adminToken) adminToken = String((await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword })).body.token);
  return adminToken;
}
async function makeRep(tag: string) {
  const email = `${tag}.${Date.now()}@trail.test`;
  const adminValue = await admin();
  const created = await client.post('/api/reps').set(auth(adminValue)).send({ name: `مهندس ${tag}`, email, password: 'RepPassword123!' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = String(created.body.user.id);
  const token = randomBytes(32).toString('base64url');
  store.run('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)', tokenHash(token), id, Date.now() + DAY, Date.now());
  return { id, token, device: `device-${id.slice(0, 6)}` };
}
async function openShift(rep: { token: string; device: string }) {
  const res = await client.post('/api/shifts/start').set(auth(rep.token))
    .send({ consentVersion: '1.0', deviceId: rep.device, deviceName: 'هاتف', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return String(res.body.shift.id);
}
async function pushFix(token: string, shiftId: string, lat: number, lng: number, recordedAt: number) {
  const res = await client.post('/api/locations').set(auth(token))
    .send({ points: [{ id: randomUUID(), shiftId, lat, lng, accuracy: 8, speed: 1, heading: 90, battery: 60, recordedAt }] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}
async function checkIn(token: string, name: string, lat: number, lng: number) {
  const id = randomUUID();
  const res = await client.post('/api/visits/check-in').set(auth(token)).send({ id, customerName: name, purpose: 'visit', location: { lat, lng, accuracy: 8 } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return id;
}
const alertsOf = async () => ((await client.get(`/api/alerts?date=${today()}`).set(auth(await admin()))).body.alerts || []) as Array<any>;

test('a visit near the engineer trail is not flagged', async () => {
  const rep = await makeRep('near');
  const shiftId = await openShift(rep);
  await pushFix(rep.token, shiftId, 31.2, 29.9, Date.now());
  // ~330 m away: a different side of the same village.
  await checkIn(rep.token, 'مزرعة قريبة', 31.203, 29.9);
  const alerts = await alertsOf();
  assert.ok(!alerts.some(alert => alert.code === 'visit_off_trail' && alert.repId === rep.id), JSON.stringify(alerts.filter(a => a.repId === rep.id)));
});

test('a visit kilometres away from the only fixes of that hour is flagged', async () => {
  const rep = await makeRep('far');
  const shiftId = await openShift(rep);
  await pushFix(rep.token, shiftId, 31.2, 29.9, Date.now());
  // 5 km away, at the same minute.
  await checkIn(rep.token, 'مزرعة بعيدة', 31.245, 29.9);
  const alerts = await alertsOf();
  const flagged = alerts.find(alert => alert.code === 'visit_off_trail' && alert.repId === rep.id);
  assert.ok(flagged, 'the claim contradicts the trail');
  assert.equal(flagged.level, 'warn');
  assert.match(String(flagged.detail), /مزرعة بعيدة/);
});

test('silence in the ten minutes around a visit is a gap, not a contradiction', async () => {
  const rep = await makeRep('gap');
  await openShift(rep);
  // The last fix is half an hour old: the phone was out of coverage, which is normal in a field
  // and is not evidence against the visit. Only a fix that *contradicts* the claim is alerted.
  store.run('UPDATE locations SET recorded_at=? WHERE user_id=?', Date.now() - 30 * 60000, rep.id);
  await checkIn(rep.token, 'مزرعة بين إشارتين', 31.5, 30.2);
  const alerts = await alertsOf();
  const mine = alerts.filter(alert => alert.code === 'visit_off_trail' && alert.repId === rep.id);
  assert.equal(mine.length, 0, `nothing to compare against :: ${JSON.stringify(mine)}`);
});

test('two visits on the exact same coordinates are surfaced', async () => {
  const rep = await makeRep('same');
  const shiftId = await openShift(rep);
  await pushFix(rep.token, shiftId, 31.21, 29.95, Date.now());
  const first = await checkIn(rep.token, 'مزرعة أ', 31.21, 29.95);
  await client.post(`/api/visits/${first}/check-out`).set(auth(rep.token)).send({ outcome: 'تم', notes: '', amount: null, location: null });
  await checkIn(rep.token, 'مزرعة ب', 31.21, 29.95);
  const alerts = await alertsOf();
  const flagged = alerts.find(alert => alert.code === 'same_visit_location' && alert.repId === rep.id);
  assert.ok(flagged, JSON.stringify(alerts.filter(a => a.repId === rep.id)));
  assert.match(String(flagged.detail), /مزرعة أ/);
  assert.match(String(flagged.detail), /مزرعة ب/);
});
