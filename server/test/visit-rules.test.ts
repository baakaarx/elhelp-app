import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { localDate } from '../src/geo.js';
import { bookCustomer } from './book.js';

/**
 * Two rules that lived only in the client, checked against the server itself:
 *   - the check-out sheet marks the outcome required; the API accepted an empty one;
 *   - an average visit duration of `0` was tested for truthiness, so an instant visit became
 *     `null` and the table printed "—" instead of "أقل من دقيقة".
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@mandoub.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  staleGpsMinutes: 10,
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

const DAY = 86400000;

test('closing a visit without a result is refused by the server', async () => {
  const admin = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
  const adminToken = admin.body.token as string;
  const repId = randomUUID();
  const email = `visit.rule.${Date.now()}@mandoub.test`;
  store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
    repId, 'مهندس القاعدة', email, hashPassword('RepPassword123!'), 'rep', Date.now() - 30 * DAY);
  const login = await client.post('/api/auth/login').send({ email, password: 'RepPassword123!' });
  const token = login.body.token as string;
  const device = `rule-${repId.slice(0, 6)}`;
  const started = await client.post('/api/shifts/start').set('Authorization', `Bearer ${token}`)
    .send({ consentVersion: '1.0', deviceId: device, deviceName: 'جهاز', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(started.status, 200, JSON.stringify(started.body));

  const visitId = randomUUID();
  const checkIn = await client.post('/api/visits/check-in').set('Authorization', `Bearer ${token}`)
    .send({ id: visitId, customerId: bookCustomer(store, repId, 'مزرعة القاعدة'), customerName: 'مزرعة القاعدة', purpose: 'visit', notes: '', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(checkIn.status, 201, JSON.stringify(checkIn.body));

  const empty = await client.post(`/api/visits/${visitId}/check-out`).set('Authorization', `Bearer ${token}`)
    .send({ outcome: '', notes: '', amount: null, location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(empty.status, 400, JSON.stringify(empty.body));
  assert.match(String(empty.body.error), /نتيجة/);
  assert.equal(store.get('SELECT status FROM visits WHERE id=?', visitId)!.status, 'open', 'the visit must stay open');

  const proper = await client.post(`/api/visits/${visitId}/check-out`).set('Authorization', `Bearer ${token}`)
    .send({ outcome: 'تمت المتابعة', notes: '', amount: null, location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(proper.status, 200, JSON.stringify(proper.body));
  assert.equal(proper.body.visit.status, 'closed');

  const overview = await client.get('/api/kpis?from=' + localDate(config.timezone) + '&to=' + localDate(config.timezone))
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
});

test('a zero-second average visit is reported as zero, not as no data', async () => {
  const admin = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
  const adminToken = admin.body.token as string;
  const repId = randomUUID();
  store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
    repId, 'مهندس لحظي', `instant.${Date.now()}@mandoub.test`, hashPassword('RepPassword123!'), 'rep', Date.now() - 20 * DAY);
  // Yesterday, and queried for yesterday: the KPI table is cached per date range for 30 seconds,
  // and the previous test already filled the "today" entry.
  const now = Date.now();
  const shifted = now - DAY;
  store.run(`INSERT INTO visits(id,user_id,customer_name,governorate,district,village,phone,purpose,notes,outcome,status,
      checked_in_at,checked_out_at,duration_seconds,in_lat,in_lng,in_accuracy,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(), repId, 'زيارة لحظية', '', '', '', '', 'visit', '', 'تم', 'closed', shifted, shifted, 0, 31.2, 29.9, 8, shifted);

  const day = localDate(config.timezone, shifted);
  const res = await client.get(`/api/kpis?from=${day}&to=${day}`).set('Authorization', `Bearer ${adminToken}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = (res.body.rows as Array<{ repId: string; visitsCompleted: number; avgVisitSeconds: number | null }>)
    .find(item => item.repId === repId);
  assert.ok(row, 'the engineer must be in the table');
  assert.equal(row!.visitsCompleted, 1);
  assert.equal(row!.avgVisitSeconds, 0, 'zero is a real average, not missing data');
});
