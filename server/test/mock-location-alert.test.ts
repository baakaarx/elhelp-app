import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { randomUUID } from 'node:crypto';

const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@mock-location.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  trustProxy: false, loginAccountLimit: 50, loginRateLimit: { windowMs: 60000, limit: 5000 },
  apiRateLimit: { windowMs: 60000, limit: 5000 },
};
const instance = createApp(config);
const client = request(instance.app);
test.after(async () => { await instance.close(); });
const as = (token: string, clientRole: 'admin' | 'rep') => ({ 'X-Mandoub-Token': token, 'X-Mandoub-Client': clientRole });

async function login(email: string, password: string) {
  const res = await client.post('/api/auth/login').send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token as string;
}

test('native mock-provider reports are deduplicated, tied to the device, and visible to the manager', async () => {
  const adminToken = await login(config.adminEmail, config.adminPassword);
  const created = await client.post('/api/reps').set(as(adminToken, 'admin')).send({
    name: 'مهندس الموقع', email: `rep.${randomUUID()}@mock-location.test`, password: 'RepPassword123!',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const repToken = await login(created.body.user.email, 'RepPassword123!');
  const repHeaders = as(repToken, 'rep');
  const shift = await client.post('/api/shifts/start').set(repHeaders).send({
    deviceId: 'android-bound-device', consentVersion: '1.0',
    location: { lat: 31.2, lng: 29.9, accuracy: 8 },
  });
  assert.ok([200, 201].includes(shift.status), JSON.stringify(shift.body));
  const shiftId = shift.body.shift.id as string;

  const unauthenticated = await client.post('/api/security/mock-location').send({ shiftId, deviceId: 'android-bound-device' });
  assert.equal(unauthenticated.status, 401);
  const manager = await client.post('/api/security/mock-location').set(as(adminToken, 'admin'))
    .send({ shiftId, deviceId: 'android-bound-device' });
  assert.equal(manager.status, 403, 'only the representative phone can report its native OS flag');
  const wrongDevice = await client.post('/api/security/mock-location').set(repHeaders)
    .send({ shiftId, deviceId: 'another-device' });
  assert.equal(wrongDevice.status, 403);

  const first = await client.post('/api/security/mock-location').set(repHeaders)
    .send({ shiftId, deviceId: 'android-bound-device' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const repeated = await client.post('/api/security/mock-location').set(repHeaders)
    .send({ shiftId, deviceId: 'android-bound-device' });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.duplicate, true);
  assert.equal(Number(instance.store.get('SELECT COUNT(*) AS c FROM mock_location_events WHERE shift_id=?', shiftId)?.c), 1);

  const alerts = await client.get('/api/alerts').set(as(adminToken, 'admin'));
  assert.equal(alerts.status, 200);
  const alert = alerts.body.alerts.find((item: { code: string; repId: string }) => item.code === 'mock_gps_detected' && item.repId === created.body.user.id);
  assert.ok(alert, JSON.stringify(alerts.body.alerts));
  assert.equal(alert.level, 'warn');
  assert.match(alert.detail, /تم تجاهل النقطة/);
});
