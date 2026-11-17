import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

const instance = createApp({
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@csrf.test', adminPassword: 'AdminPassword123!', allowedOrigins: [], port: 0,
  trustProxy: false, loginAccountLimit: 50, loginRateLimit: { windowMs: 60000, limit: 500 },
});
const client = request(instance.app);
test.after(async () => { await instance.close(); });

test('a same-site sibling cannot use a cookie to stop an engineer shift', async () => {
  const managerLogin = await client.post('/api/auth/login').send({
    email: 'admin@csrf.test', password: 'AdminPassword123!',
  });
  assert.equal(managerLogin.status, 200);
  const manager = { 'X-Mandoub-Token': managerLogin.body.token, 'X-Mandoub-Client': 'admin' };
  const created = await client.post('/api/reps').set(manager).send({
    name: 'مهندس أ', email: 'engineer@csrf.test', password: 'RepPassword123!',
  });
  assert.equal(created.status, 201);

  const repLogin = await client.post('/api/auth/login').send({
    email: 'engineer@csrf.test', password: 'RepPassword123!',
  });
  assert.equal(repLogin.status, 200);
  const rep = { 'X-Mandoub-Token': repLogin.body.token, 'X-Mandoub-Client': 'rep' };
  const cookie = (repLogin.headers['set-cookie'] as string[])
    .find(value => value.startsWith('mandoub_rep_session='));
  assert.ok(cookie);

  const started = await client.post('/api/shifts/start').set(rep).send({
    consentVersion: '1.0', deviceId: 'csrf-device-123',
    location: { lat: 31.2, lng: 29.9, accuracy: 8 },
  });
  assert.equal(started.status, 200);

  const crossOriginStop = await client.post('/api/shifts/stop')
    .set('Cookie', cookie.split(';')[0])
    .set('X-Mandoub-Client', 'rep')
    .set('Sec-Fetch-Site', 'same-site')
    .set('Origin', 'http://attacker.test');
  assert.equal(crossOriginStop.status, 401, 'a sibling-origin cookie request must not authenticate');
  const stillOpen = await client.get('/api/me/shift?snapshot=0').set(rep);
  assert.ok(stillOpen.body.shift, 'the rejected cross-origin request must not stop the shift');

  const sameOriginStop = await client.post('/api/shifts/stop')
    .set('Cookie', cookie.split(';')[0])
    .set('X-Mandoub-Client', 'rep')
    .set('Sec-Fetch-Site', 'same-origin');
  assert.equal(sameOriginStop.status, 200, 'same-origin cookie authentication still works');
});
