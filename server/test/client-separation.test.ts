import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'manager@client-split.test', adminPassword: 'ManagerPassword123!',
  allowedOrigins: [], port: 0, trustProxy: false, loginAccountLimit: 50,
  loginRateLimit: { windowMs: 60000, limit: 5000 },
  apiRateLimit: { windowMs: 60000, limit: 5000 },
};
const instance = createApp(config);
const client = request(instance.app);
test.after(async () => { await instance.close(); });

const clientHeaders = (token: string, surface: 'admin' | 'rep') => ({
  'X-Mandoub-Token': token,
  'X-Mandoub-Client': surface,
});

let adminToken = '';
let repToken = '';
const repEmail = 'engineer@client-split.test';
const repPassword = 'EngineerPassword123!';

test('the website and mobile client can only issue sessions for their own role', async () => {
  const managerLogin = await client.post('/api/auth/login')
    .set('X-Mandoub-Client', 'admin')
    .send({ email: config.adminEmail, password: config.adminPassword });
  assert.equal(managerLogin.status, 200, JSON.stringify(managerLogin.body));
  adminToken = managerLogin.body.token;
  assert.equal(managerLogin.body.user.role, 'admin');

  const created = await client.post('/api/reps').set(clientHeaders(adminToken, 'admin'))
    .send({ region: 'منطقة اختبار', name: 'مهندس الميدان', email: repEmail, password: repPassword });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const engineerOnWebsite = await client.post('/api/auth/login')
    .set('X-Mandoub-Client', 'admin')
    .send({ email: repEmail, password: repPassword });
  assert.equal(engineerOnWebsite.status, 403);
  assert.equal(engineerOnWebsite.body.code, 'CLIENT_ROLE_MISMATCH');
  assert.match(engineerOnWebsite.body.error, /موقع المهندس على iPhone/);
  assert.equal(engineerOnWebsite.body.token, undefined);
  assert.equal(engineerOnWebsite.headers['set-cookie'], undefined);

  const managerOnMobile = await client.post('/api/auth/login')
    .set('X-Mandoub-Client', 'rep')
    .send({ email: config.adminEmail, password: config.adminPassword });
  assert.equal(managerOnMobile.status, 403);
  assert.equal(managerOnMobile.body.code, 'CLIENT_ROLE_MISMATCH');
  assert.match(managerOnMobile.body.error, /لوحة المتابعة على الويب/);
  assert.equal(managerOnMobile.body.token, undefined);
  assert.equal(managerOnMobile.headers['set-cookie'], undefined);

  const wrongPassword = await client.post('/api/auth/login')
    .set('X-Mandoub-Client', 'admin')
    .send({ email: repEmail, password: 'not-the-password' });
  assert.equal(wrongPassword.status, 401, 'the role mismatch must not reveal a valid account password');
});

test('a valid session cannot cross into the other client surface', async () => {
  const engineerLogin = await client.post('/api/auth/login')
    .set('X-Mandoub-Client', 'rep')
    .send({ email: repEmail, password: repPassword });
  assert.equal(engineerLogin.status, 200, JSON.stringify(engineerLogin.body));
  repToken = engineerLogin.body.token;

  assert.equal((await client.get('/api/auth/me').set(clientHeaders(adminToken, 'admin'))).status, 200);
  assert.equal((await client.get('/api/auth/me').set(clientHeaders(repToken, 'rep'))).status, 200);

  const engineerAtManagerWebsite = await client.get('/api/auth/me').set(clientHeaders(repToken, 'admin'));
  assert.equal(engineerAtManagerWebsite.status, 403);
  assert.equal(engineerAtManagerWebsite.body.code, 'CLIENT_ROLE_MISMATCH');

  const managerAtEngineerApp = await client.get('/api/auth/me').set(clientHeaders(adminToken, 'rep'));
  assert.equal(managerAtEngineerApp.status, 403);
  assert.equal(managerAtEngineerApp.body.code, 'CLIENT_ROLE_MISMATCH');
});
