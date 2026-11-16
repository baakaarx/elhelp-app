import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

/**
 * The policy used to be attached in index.ts, *after* `createApp()` had already registered its
 * routes. `/privacy` and `/delete-account` end the response inside their own handler, so the
 * middleware never ran for them: the two public pages both stores link to were the only HTML the
 * server sent with no content-security-policy at all.
 */
const previous = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, env: process.env.NODE_ENV };
process.env.NODE_ENV = 'production';
process.env.ADMIN_EMAIL = 'admin@mandoub.test';
process.env.ADMIN_PASSWORD = 'TestPassword123!';
const instance = createApp({ dbPath: ':memory:', production: true, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@mandoub.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0, staleGpsMinutes: 10 });
const client = request(instance.app);

test.after(async () => {
  await instance.close();
  process.env.NODE_ENV = previous.env;
  if (previous.email === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = previous.email;
  if (previous.password === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = previous.password;
});

const policyOf = (res: request.Response) => String(res.headers['content-security-policy'] ?? '');
const directiveConnect = (policy: string) => policy.split('; ').find(part => part.startsWith('connect-src ')) ?? '';

test('the public privacy and deletion pages carry the policy', async () => {
  for (const path of ['/privacy', '/delete-account']) {
    const res = await client.get(path);
    assert.equal(res.status, 200, `${path} must be served`);
    const policy = policyOf(res);
    assert.ok(policy, `${path} has no content-security-policy`);
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /frame-ancestors 'self'/);
    assert.ok(!policy.includes('unsafe-eval'), 'a static page needs no eval');
  }
});

test('the policy names the host the browser actually opened', async () => {
  // `/` is mounted by index.ts; `/privacy` is a page createApp itself serves.
  const res = await client.get('/privacy');
  const policy = policyOf(res);
  assert.match(policy, /wss:\/\/127\.0\.0\.1(:\d+)?/, `Socket.IO must reach its own host: ${policy}`);
  assert.ok(!/wss:( |$)/.test(directiveConnect(policy)), 'no scheme-wide websocket allowance on a named host');
});

test('API responses do not carry a page policy', async () => {
  const res = await client.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(policyOf(res), '');
});

test('the login and the dashboard shell still answer', async () => {
  const login = await client.post('/api/auth/login').send({ email: 'admin@mandoub.test', password: 'TestPassword123!' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  // The dashboard files may not be built in a test checkout; what matters is that the fallback
  // route answers instead of throwing when the policy middleware is in front of it.
  const shell = await client.get('/');
  assert.ok([200, 404].includes(shell.status), `unexpected status ${shell.status}`);
});
