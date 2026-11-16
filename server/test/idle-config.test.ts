import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { readConfig, DEFAULT_IDLE_REASON_MINUTES } from '../src/config.js';

/**
 * The stillness threshold was a literal 60 minutes in two places: the phone's banner and the
 * server's alert. Changing it (the field asked for 30) meant shipping a new APK and hoping the
 * two numbers stayed in step. It is one setting now, and the app reads it from the summary.
 */
const previous = {
  email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD,
  idle: process.env.IDLE_REASON_MINUTES, env: process.env.NODE_ENV,
};
test.after(() => {
  process.env.NODE_ENV = previous.env;
  if (previous.email === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = previous.email;
  if (previous.password === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = previous.password;
  if (previous.idle === undefined) delete process.env.IDLE_REASON_MINUTES; else process.env.IDLE_REASON_MINUTES = previous.idle;
});

const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@idle.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  staleGpsMinutes: 10, idleReasonMinutes: 45,
};

test('the threshold defaults to an hour and rejects nonsense', () => {
  delete process.env.IDLE_REASON_MINUTES;
  const base = { ADMIN_EMAIL: 'a@idle.test', ADMIN_PASSWORD: 'TestPassword123!' };
  Object.assign(process.env, base);
  assert.equal(readConfig().idleReasonMinutes, DEFAULT_IDLE_REASON_MINUTES);
  assert.equal(DEFAULT_IDLE_REASON_MINUTES, 60);
  for (const bad of ['5', '600', 'abc', '30.5', '']) {
    process.env.IDLE_REASON_MINUTES = bad;
    if (bad === '') {
      // An empty value means "not set", so it falls back to the default rather than failing.
      assert.equal(readConfig().idleReasonMinutes, 60);
      continue;
    }
    assert.throws(() => readConfig(), /IDLE_REASON_MINUTES/, `"${bad}" must be refused`);
  }
  process.env.IDLE_REASON_MINUTES = '30';
  assert.equal(readConfig().idleReasonMinutes, 30);
  delete process.env.IDLE_REASON_MINUTES;
});

test('the engineer app is told the threshold the server will alert on', async () => {
  const instance = createApp(config);
  const client = request(instance.app);
  try {
    const admin = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
    const email = `idle.${Date.now()}@idle.test`;
    await client.post('/api/reps').set('Authorization', `Bearer ${admin.body.token}`)
      .send({ name: 'مهندس سكون', email, password: 'RepPassword123!' });
    const login = await client.post('/api/auth/login').send({ email, password: 'RepPassword123!' });
    const summary = await client.get('/api/me/summary').set('Authorization', `Bearer ${login.body.token}`);
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    assert.equal(summary.body.idleReasonMinutes, 45);
    const health = await client.get('/api/health');
    assert.equal(health.body.idleReasonMinutes, 45, 'ops can read the live value');
  } finally {
    await instance.close();
  }
});
