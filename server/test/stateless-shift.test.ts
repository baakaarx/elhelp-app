import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

/**
 * The hosted demo runs on serverless functions with one SQLite file per instance, so a
 * request that lands on a fresh instance used to answer "no open shift" and the engineer was
 * dropped out of the shift every few seconds. Signed sessions and a signed shift token fix
 * that; these tests simulate two instances sitting behind the same hostname.
 */
process.env.SESSION_SECRET = 'test-hosted-demo-secret-value-1234';

const config = {
  dbPath: ':memory:', demo: false, production: false, retentionDays: 30, timezone: 'Africa/Cairo',
  adminEmail: 'admin@mandoub.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
};

const instanceA = createApp(config);
const instanceB = createApp(config);
test.after(async () => { await instanceA.close(); await instanceB.close(); });

const email = `field.${Date.now()}@mandoub.test`;
let repToken = '';
let shiftId = '';
let shiftStartedAt = 0;
let shiftToken = '';

const authHeaders = (token: string, shift?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(shift ? { 'X-Mandoub-Shift': shift } : {}),
});

test('a representative created on one instance can still sign in on another', async () => {
  const adminLogin = await request(instanceA.app).post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
  const created = await request(instanceA.app)
    .post('/api/reps')
    .set(authHeaders(adminLogin.body.token))
    .send({ name: 'مهندس الميدان', email, password: 'FieldPassword123!', phone: '01000000000', region: 'الإسكندرية' });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const login = await request(instanceA.app).post('/api/auth/login').send({ email, password: 'FieldPassword123!' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  repToken = login.body.token;

  // The same token must resolve on the second instance, which never stored this account.
  const me = await request(instanceB.app).get('/api/auth/me').set(authHeaders(repToken));
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.user.email, email);
  assert.equal(me.body.user.role, 'rep');
  assert.equal(me.body.user.approvalStatus, 'approved');
});

test('starting a shift returns a signed shift token', async () => {
  const res = await request(instanceA.app)
    .post('/api/shifts/start')
    .set(authHeaders(repToken))
    .send({ consentVersion: '1.0', location: { lat: 31.2001, lng: 29.9187, accuracy: 12 }, deviceId: 'test-device-abc', deviceName: 'Test Phone' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.shift?.id);
  assert.equal(typeof res.body.shiftToken, 'string');
  shiftId = res.body.shift.id;
  shiftStartedAt = Number(res.body.shift.started_at);
  shiftToken = res.body.shiftToken;
});

test('the shift survives the request landing on a different instance', async () => {
  const res = await request(instanceB.app).get('/api/me/shift').set(authHeaders(repToken, shiftToken));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.shift?.id, shiftId);
  assert.equal(Number(res.body.shift?.started_at), shiftStartedAt);
});

test('without the signed shift the other instance reports no open shift', async () => {
  const res = await request(instanceB.app).get('/api/me/shift').set(authHeaders(repToken));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.shift, null);
});

test('a forged shift token is ignored', async () => {
  const [version, body] = shiftToken.split('.');
  const forged = `${version}.${body}.${'A'.repeat(43)}`;
  const res = await request(instanceB.app).get('/api/me/shift').set(authHeaders(repToken, forged));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.shift, null);
});

test('GPS points are accepted on the other instance for the same shift', async () => {
  const res = await request(instanceB.app)
    .post('/api/locations')
    .set(authHeaders(repToken, shiftToken))
    .send({
      points: [{
        id: crypto.randomUUID(), shiftId, lat: 31.2002, lng: 29.9188, accuracy: 10, speed: 3, heading: 45, battery: 80,
        recordedAt: Date.now(),
      }],
    });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.accepted, 1);
});

test('stopping the shift closes it on the instance that served the stop', async () => {
  const stop = await request(instanceA.app).post('/api/shifts/stop').set(authHeaders(repToken, shiftToken));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const res = await request(instanceA.app).get('/api/me/shift').set(authHeaders(repToken, shiftToken));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.shift, null);
});
