import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { bookCustomer } from './book.js';

/**
 * One table saying who may call what, checked for every route at once.
 *
 * These routes were each reviewed by hand when they were written, but nothing stopped a later
 * change from dropping an `adminOnly` from one of them — and the failure is silent: the app keeps
 * working, and every engineer can read the whole team's trails. The list below is the contract.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@authz.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  trustProxy: false, loginAccountLimit: 50, loginRateLimit: { windowMs: 60000, limit: 5000 },
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });
const as = (token: string) => ({ 'X-Mandoub-Token': token, 'X-Mandoub-Client': 'rep' });

let adminToken = '';
let repToken = '';
let repId = '';
let otherRepToken = '';
let otherRepId = '';
let otherReportId = '';
let otherDailyId = '';
let otherVisitId = '';

const login = async (email: string, password: string) => {
  const res = await client.post('/api/auth/login').send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token as string;
};

test('set the installation up: one manager and two engineers', async () => {
  adminToken = await login(config.adminEmail, config.adminPassword);
  const admin = { 'X-Mandoub-Token': adminToken, 'X-Mandoub-Client': 'admin' };
  const rep = await client.post('/api/reps').set(admin)
    .send({ name: 'مهندس أ', email: 'rep.a@authz.test', password: 'RepPassword123!', region: 'الإسكندرية' });
  assert.equal(rep.status, 201, JSON.stringify(rep.body));
  repId = rep.body.user.id;
  const other = await client.post('/api/reps').set(admin)
    .send({ name: 'مهندس ب', email: 'rep.b@authz.test', password: 'RepPassword123!', region: 'الإسكندرية' });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  otherRepId = other.body.user.id;
  repToken = await login('rep.a@authz.test', 'RepPassword123!');
  otherRepToken = await login('rep.b@authz.test', 'RepPassword123!');

  // Something that belongs to the second engineer, for the cross-account checks below.
  const start = await client.post('/api/shifts/start').set(as(otherRepToken))
    .send({ deviceId: 'authz-device-b', consentVersion: '1.0', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.ok([200, 201].includes(start.status), JSON.stringify(start.body));
  const visit = await client.post('/api/visits/check-in').set(as(otherRepToken)).send({
    id: crypto.randomUUID(), customerId: bookCustomer(store, otherRepId, 'عميل ب'), customerName: 'عميل ب', governorate: 'الإسكندرية', district: 'سموحة',
    village: '', phone: '01000000001', purpose: 'visit', notes: '', location: { lat: 31.2, lng: 29.9, accuracy: 8 },
    deviceId: 'authz-device-b',
  });
  assert.equal(visit.status, 201, JSON.stringify(visit.body));
  otherVisitId = visit.body.visit.id;

  const report = await client.post('/api/reports').set(as(otherRepToken))
    .send({ id: crypto.randomUUID(), type: 'note', title: 'ملاحظة', customer: 'عميل', amount: null, location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  otherReportId = report.body.report.id;

  const daily = await client.post('/api/daily-reports').set(as(otherRepToken)).send({
    version: 1, id: crypto.randomUUID(), reportDate: '2026-10-30', engineerName: 'مهندس ب',
    signedName: 'مهندس ب', confirmed: true, visits: [{ customerName: 'عميل', outcome: 'تم' }],
  });
  assert.equal(daily.status, 201, JSON.stringify(daily.body));
  otherDailyId = daily.body.report.id;
});

/** Every route that changes the installation or reads the whole team. */
function adminOnlyRoutes(): Array<[string, string, object?]> {
  const id = repId;
  return [
    ['GET', '/api/overview'], ['GET', '/api/reps'],
    ['POST', '/api/reps', { name: 'x', email: 'x@authz.test', password: 'Whatever1234!' }],
    ['PATCH', `/api/reps/${id}`, { region: 'القاهرة' }],
    ['PATCH', `/api/reps/${id}/approval`, { status: 'approved' }],
    ['POST', `/api/reps/${id}/reset-device`],
    ['POST', `/api/reps/${otherRepId}/reset-device`],
    ['POST', `/api/reps/${id}/password`, { password: 'Another12345!' }],
    ['GET', '/api/alerts'], ['GET', '/api/kpis'],
    ['GET', '/api/kpis.csv'], ['GET', '/api/kpis.xlsx'],
    ['GET', '/api/visits.csv'], ['GET', '/api/visits.xlsx'], ['GET', '/api/idle-reports.csv'],
    ['GET', '/api/monthly'], ['GET', '/api/monthly.csv'], ['GET', '/api/monthly.xlsx'],
    ['GET', '/api/agent/status'], ['GET', '/api/agent/skills'], ['POST', '/api/agent/refresh'],
    ['PATCH', `/api/reports/${otherReportId}`, { status: 'reviewed' }],
    ['PATCH', `/api/daily-reports/${otherDailyId}`, { status: 'reviewed' }],
  ];
}

test('an engineer is refused by every manager route', async () => {
  const refused: string[] = [];
  for (const [method, path, body] of adminOnlyRoutes()) {
    const call = method === 'GET' ? client.get(path) : method === 'POST' ? client.post(path) : client.patch(path);
    const res = await call.set(as(repToken)).send(body ?? {});
    if (res.status !== 403 && res.status !== 401) refused.push(`${method} ${path} → ${res.status}`);
  }
  assert.deepEqual(refused, [], `one of these is no longer manager-only:\n${refused.join('\n')}`);
});

test('an engineer cannot read the other engineer\'s work', async () => {
  const route = await client.get(`/api/reps/${otherRepId}/route`).set(as(repToken));
  assert.equal(route.status, 403);

  const report = await client.get(`/api/reports/${otherReportId}`).set(as(repToken));
  assert.equal(report.status, 403);
  const replay = await client.post('/api/reports').set(as(repToken)).send({
    id: otherReportId, type: 'note', title: 'محاولة إعادة إرسال بمعرّف زميل', body: '', customer: '', amount: null, location: null,
  });
  assert.equal(replay.status, 409, 'a report id owned by another engineer is not an idempotent replay');
  assert.equal(replay.body.code, 'REPORT_ID_IN_USE');
  assert.equal(replay.body.report, undefined, 'the conflicting report payload is never returned');
  const daily = await client.get(`/api/daily-reports/${otherDailyId}`).set(as(repToken));
  assert.equal(daily.status, 403);
  const pdf = await client.get(`/api/daily-reports/${otherDailyId}/pdf`).set(as(repToken));
  assert.equal(pdf.status, 403);

  // The list endpoints ignore a `repId` a representative is not allowed to name.
  const visits = await client.get(`/api/visits?repId=${otherRepId}`).set(as(repToken));
  assert.equal(visits.status, 200);
  assert.ok(!visits.body.visits.some((visit: { id: string }) => visit.id === otherVisitId), 'another engineer\'s visit leaked');
  const reports = await client.get(`/api/reports?repId=${otherRepId}`).set(as(repToken));
  assert.ok(!reports.body.reports.some((report: { id: string }) => report.id === otherReportId), 'another engineer\'s report leaked');
  const idle = await client.get(`/api/idle-reports?repId=${otherRepId}`).set(as(repToken));
  assert.equal(idle.status, 200);
  assert.ok(!idle.body.reports.some((one: { userId: string }) => one.userId === otherRepId), 'another engineer\'s idle report leaked');
});

test('the agent answers about the caller, not about whoever they name', async () => {
  const named = await client.post('/api/agent/run').set(as(repToken))
    .send({ task: 'summarize-day', repId: otherRepId, date: '2026-10-30' });
  assert.equal(named.status, 403);
  const teamWide = await client.post('/api/agent/run').set(as(repToken))
    .send({ task: 'field-alerts', date: '2026-10-30' });
  assert.equal(teamWide.status, 403);
  const own = await client.post('/api/agent/run').set(as(repToken)).send({ task: 'summarize-day', date: '2026-10-30' });
  assert.equal(own.status, 200, JSON.stringify(own.body));
});

test('no token means no data, on every kind of route', async () => {
  for (const path of ['/api/overview', '/api/visits', '/api/reports', '/api/daily-reports', '/api/me/shift', '/api/alerts']) {
    const res = await client.get(path);
    assert.equal(res.status, 401, path);
  }
});

test('a representative cookie cannot be borrowed to act as the manager', async () => {
  const repCookie = (await client.post('/api/auth/login').send({ email: 'rep.a@authz.test', password: 'RepPassword123!' }))
    .headers['set-cookie'] as unknown as string[];
  assert.ok(repCookie.some(cookie => cookie.startsWith('mandoub_rep_session=')));
  // Claiming to be the dashboard borrows the manager cookie slot, which this session never filled.
  const res = await client.get('/api/overview')
    .set('Cookie', repCookie.join('; '))
    .set('X-Mandoub-Client', 'admin');
  assert.equal(res.status, 401);
});
