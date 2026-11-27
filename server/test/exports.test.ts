import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { tokenHash } from '../src/auth.js';
import { localDate } from '../src/geo.js';
import { bookCustomer } from './book.js';

/** The two registers the board shows and the owner asks for on paper. */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@export.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  staleGpsMinutes: 10, idleReasonMinutes: 60,
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const today = localDate(config.timezone);
let adminToken = '';
async function admin() {
  if (!adminToken) adminToken = String((await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword })).body.token);
  return adminToken;
}
async function makeRep(tag: string) {
  const email = `${tag}.${Date.now()}@export.test`;
  const adminValue = await admin();
  const created = await client.post('/api/reps').set(auth(adminValue)).send({ region: 'منطقة اختبار', name: `مهندس ${tag}`, email, password: 'RepPassword123!' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = String(created.body.user.id);
  const token = randomBytes(32).toString('base64url');
  store.run('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)', tokenHash(token), id, Date.now() + 3600000, Date.now());
  return { id, token, device: `device-${id.slice(0, 6)}` };
}

test('the visits register exports what the board shows', async () => {
  const rep = await makeRep('register');
  await client.post('/api/shifts/start').set(auth(rep.token)).send({ consentVersion: '1.0', deviceId: rep.device, location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  const id = randomUUID();
  await client.post('/api/visits/check-in').set(auth(rep.token))
    .send({ id, customerId: bookCustomer(store, rep.id, 'مزرعة التصدير'), customerName: 'مزرعة التصدير', purpose: 'visit', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  await client.post(`/api/visits/${id}/check-out`).set(auth(rep.token)).send({ outcome: '=cmd|calc', notes: 'ملاحظة', amount: null, location: null });

  const csv = await client.get(`/api/visits.csv?from=${today}&to=${today}`).set(auth(await admin()));
  assert.equal(csv.status, 200, csv.text.slice(0, 120));
  assert.match(csv.text, /مزرعة التصدير/);
  assert.match(csv.text, /'=cmd/, 'a result typed by hand cannot become a formula');
  const lines = csv.text.trim().split('\r\n');
  assert.equal(lines.length, 2, 'one header and one visit');

  const xlsx = await client.get(`/api/visits.xlsx?from=${today}&to=${today}`).set(auth(await admin()));
  assert.equal(xlsx.status, 200);
  assert.ok(xlsx.text.startsWith('PK'), 'a real workbook');
});

test('the justifications register exports too', async () => {
  const rep = await makeRep('idle');
  await client.post('/api/shifts/start').set(auth(rep.token)).send({ consentVersion: '1.0', deviceId: rep.device, location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  const idle = await client.post('/api/shifts/idle').set(auth(rep.token)).send({ reason: 'مستني رد العميل', location: { lat: 31.2, lng: 29.9, accuracy: 8 }, deviceId: rep.device });
  assert.equal(idle.status, 201, JSON.stringify(idle.body));
  const csv = await client.get('/api/idle-reports.csv').set(auth(await admin()));
  assert.equal(csv.status, 200);
  assert.match(csv.text, /مستني رد العميل/);
});

test('a bad range is refused, not silently exported as today', async () => {
  const token = await admin();
  assert.equal((await client.get('/api/visits.csv?from=2026-01-02&to=2026-01-01').set(auth(token))).status, 400);
  assert.equal((await client.get('/api/visits.csv?from=2020-01-01&to=2026-01-01').set(auth(token))).status, 400);
  assert.equal((await client.get('/api/idle-reports.csv?from=nonsense').set(auth(token))).status, 400);
  assert.equal((await client.get('/api/visits.csv').set(auth(token))).status, 200, 'and no range means today');
});

test('an engineer cannot export the team registers', async () => {
  const rep = await makeRep('nope');
  assert.equal((await client.get('/api/visits.csv').set(auth(rep.token))).status, 403);
  assert.equal((await client.get('/api/idle-reports.csv').set(auth(rep.token))).status, 403);
});

test('the reports feed can be narrowed by date instead of being cut at 300', async () => {
  const rep = await makeRep('feed');
  await client.post('/api/shifts/start').set(auth(rep.token)).send({ consentVersion: '1.0', deviceId: rep.device, location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  const token = await admin();
  const created = await client.post('/api/reports').set(auth(rep.token)).send({ id: randomUUID(), type: 'note', title: 'تقرير اليوم', body: '', customer: '', amount: null, location: null });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const mine = await client.get(`/api/reports?from=${today}&to=${today}`).set(auth(token));
  assert.equal(mine.status, 200);
  assert.ok((mine.body.reports as Array<any>).some(report => report.id === created.body.report.id));

  const future = await client.get('/api/reports?from=2030-01-01&to=2030-01-02').set(auth(token));
  assert.equal(future.status, 200);
  assert.equal((future.body.reports as Array<any>).length, 0, 'a range with nothing in it is empty, not everything');
  assert.equal((await client.get('/api/reports?from=2026-02-01&to=2026-01-01').set(auth(token))).status, 400);
});
