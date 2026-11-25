import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { setPushTransport } from '../src/push.js';
import { localDate } from '../src/geo.js';

const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@push.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  trustProxy: false, loginAccountLimit: 50, loginRateLimit: { windowMs: 60000, limit: 5000 },
  apiRateLimit: { windowMs: 60000, limit: 5000 },
};
const instance = createApp(config);
const client = request(instance.app);
test.after(async () => { setPushTransport(null); await instance.close(); });
const headers = (token: string, role: 'admin' | 'rep') => ({ 'X-Mandoub-Token': token, 'X-Mandoub-Client': role });
const expoToken = `ExpoPushToken[${'1'.repeat(32)}]`;

async function login(email: string, password: string) {
  const result = await client.post('/api/auth/login').send({ email, password });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.token as string;
}

async function addRep(adminToken: string, name: string, email: string) {
  const result = await client.post('/api/reps').set(headers(adminToken, 'admin'))
    .send({ region: 'منطقة اختبار', name, email, password: 'RepPassword123!' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.user.id as string;
}

test('push token endpoints are authenticated, account-scoped, and review events reach the rep', async () => {
  assert.equal((await client.get('/api/push/status')).status, 401);
  assert.equal((await client.post('/api/push/token').send({})).status, 401);

  const adminToken = await login(config.adminEmail, config.adminPassword);
  const repId = await addRep(adminToken, 'مهندس أ', 'rep.a@push.test');
  const otherId = await addRep(adminToken, 'مهندس ب', 'rep.b@push.test');
  const repToken = await login('rep.a@push.test', 'RepPassword123!');
  const otherToken = await login('rep.b@push.test', 'RepPassword123!');
  const repHeaders = headers(repToken, 'rep');
  const otherHeaders = headers(otherToken, 'rep');
  const adminHeaders = headers(adminToken, 'admin');
  const deviceId = 'android-push-device-001';
  const otherDevice = 'android-push-device-002';
  const unbound = await client.post('/api/push/token').set(repHeaders)
    .send({ token: expoToken, platform: 'android', deviceId });
  assert.equal(unbound.status, 409);
  assert.equal(unbound.body.code, 'DEVICE_NOT_BOUND');
  for (const [token, id] of [[repToken, deviceId], [otherToken, otherDevice]] as const) {
    const shift = await client.post('/api/shifts/start').set(headers(token, 'rep')).send({
      deviceId: id, consentVersion: '1.0', location: { lat: 31.2, lng: 29.9, accuracy: 8 },
    });
    assert.ok([200, 201].includes(shift.status), JSON.stringify(shift.body));
  }

  const invalid = await client.post('/api/push/token').set(repHeaders)
    .send({ token: 'not-an-expo-token', platform: 'android', deviceId });
  assert.equal(invalid.status, 400);

  const registered = await client.post('/api/push/token').set(repHeaders)
    .send({ token: expoToken, platform: 'android', deviceId });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  assert.deepEqual((await client.get('/api/push/status').set(repHeaders)).body, { enabled: true });

  // A token already owned by one account cannot be reassigned just by presenting it elsewhere.
  const collision = await client.post('/api/push/token').set(otherHeaders)
    .send({ token: expoToken, platform: 'android', deviceId: otherDevice });
  assert.equal(collision.status, 409);
  await client.delete('/api/push/token').set(otherHeaders).send({ deviceId });
  assert.deepEqual((await client.get('/api/push/status').set(repHeaders)).body, { enabled: true }, 'one account cannot unregister another account\'s token');

  const disabled = await client.delete('/api/push/token').set(repHeaders).send({ deviceId });
  assert.equal(disabled.status, 200);
  assert.deepEqual((await client.get('/api/push/status').set(repHeaders)).body, { enabled: false });
  assert.equal((await client.post('/api/push/token').set(repHeaders)
    .send({ token: expoToken, platform: 'android', deviceId })).status, 200);

  const reportId = randomUUID();
  const report = await client.post('/api/reports').set(repHeaders).send({
    id: reportId, type: 'note', title: 'متابعة العميل', body: 'ملاحظة',
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));

  const sent: Array<Record<string, unknown>> = [];
  let nextStatus: 'ok' | 'invalid' = 'ok';
  setPushTransport(async body => {
    const messages = JSON.parse(body) as Array<Record<string, unknown>>;
    sent.push(...messages);
    return {
      status: 200,
      json: { data: messages.map(() => nextStatus === 'ok'
        ? { status: 'ok' }
        : { status: 'error', details: { error: 'DeviceNotRegistered' } }) },
    };
  });

  const reviewed = await client.patch(`/api/reports/${reportId}`).set(adminHeaders).send({ status: 'reviewed' });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, expoToken);
  assert.equal(sent[0].title, 'تمت مراجعة تقريرك');
  assert.deepEqual(sent[0].data, { type: 'report_reviewed', reportId });

  const dailyId = randomUUID();
  const daily = await client.post('/api/daily-reports').set(repHeaders).send({
    version: 1, id: dailyId, reportDate: localDate(config.timezone), engineerName: 'مهندس أ',
    signedName: 'مهندس أ', confirmed: true, visits: [{ customerName: 'مزرعة النور' }],
  });
  assert.equal(daily.status, 201, JSON.stringify(daily.body));
  const dailyReview = await client.patch(`/api/daily-reports/${dailyId}`).set(adminHeaders).send({ status: 'reviewed' });
  assert.equal(dailyReview.status, 200);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent[1].title, 'تمت مراجعة تقريرك اليومي');
  assert.deepEqual(sent[1].data, { type: 'daily_report_reviewed', reportId: dailyId });

  const approval = await client.patch(`/api/reps/${repId}/approval`).set(adminHeaders).send({ status: 'pending' });
  assert.equal(approval.status, 200);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent[2].title, 'تحديث حالة الحساب');
  assert.deepEqual(sent[2].data, { type: 'account_status', status: 'pending' });

  // Expo's DeviceNotRegistered receipt removes only the dead token; it does not fail the review.
  const secondId = randomUUID();
  instance.store.run(`INSERT INTO reports(id,user_id,type,title,body,customer,status,created_at)
    VALUES (?,?,?,'تقرير آخر','','','new',?)`, secondId, repId, 'note', Date.now());
  nextStatus = 'invalid';
  const second = await client.patch(`/api/reports/${secondId}`).set(adminHeaders).send({ status: 'reviewed' });
  assert.equal(second.status, 200);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(Number(instance.store.get('SELECT COUNT(*) AS c FROM push_tokens WHERE user_id=?', repId)?.c), 0);

  const otherExpoToken = `ExponentPushToken[${'2'.repeat(32)}]`;
  const otherRegistered = await client.post('/api/push/token').set(otherHeaders)
    .send({ token: otherExpoToken, platform: 'android', deviceId: otherDevice });
  assert.equal(otherRegistered.status, 200);
  const logout = await client.post('/api/auth/logout').set(otherHeaders).send({});
  assert.equal(logout.status, 200);
  assert.equal(Number(instance.store.get('SELECT COUNT(*) AS c FROM push_tokens WHERE user_id=?', otherId)?.c), 0, 'logout purges the account\'s registered tokens');
});
