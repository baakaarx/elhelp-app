import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import request from 'supertest';
import { io as connectClient, type Socket } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { dayBounds, localDate } from '../src/geo.js';
import { dailyReportPdf } from '../src/dailyPdf.js';
import { readTrustProxy } from '../src/config.js';
import { setKeySource } from '../src/oauth.js';
import { createSign, generateKeyPairSync } from 'node:crypto';

// CSV helpers: read the body as raw bytes (the BOM matters) and split it into lines.
const csvParser = (r: request.Response, done: (err: Error | null, body?: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on('data', (chunk: Buffer) => chunks.push(chunk));
  r.on('end', () => done(null, Buffer.concat(chunks)));
};
const csvLines = (body: Buffer): string[] =>
  Buffer.from(body).toString('utf8').replace('\uFEFF', '').split('\r\n').filter(line => line.length > 0);

// Read the parts of a .xlsx (a zip) without pulling in a zip library.
const xlsxEntries = (body: Buffer): Map<string, string> => {
  const files = new Map<string, string>();
  let offset = 0;
  while (offset + 30 <= body.length && body.readUInt32LE(offset) === 0x04034b50) {
    const method = body.readUInt16LE(offset + 8);
    const compressedSize = body.readUInt32LE(offset + 18);
    const nameLength = body.readUInt16LE(offset + 26);
    const extraLength = body.readUInt16LE(offset + 28);
    const name = body.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const raw = body.subarray(start, start + compressedSize);
    files.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString('utf8'));
    offset = start + compressedSize;
  }
  return files;
};

const config = {
  dbPath: ':memory:', production: false, retentionDays: 30, timezone: 'Africa/Cairo',
  adminEmail: 'admin@mandoub.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  privacyContact: 'privacy@mandoub.test', trustProxy: false,
  oauthGoogleClientIds: ['google-ios-client', 'google-android-client'],
  oauthAppleClientIds: ['com.elhelb.mandoub'],
  // The suite signs in dozens of times from one address; the shipped limits are exercised by
  // the dedicated tests that build their own instance.
  loginAccountLimit: 10, loginRateLimit: { windowMs: 60000, limit: 1000 },
};
const instance = createApp(config);
const { app, store, httpServer } = instance;
const admin = request(app);
const rep = request(app);
// Socket.IO needs a real listener; supertest's per-request servers are not reusable.
const port = await new Promise<number>(resolve => {
  httpServer.listen(0, '127.0.0.1', () => resolve((httpServer.address() as { port: number }).port));
});
test.after(async () => { await instance.close(); });

let adminToken = '';
let repToken = '';
let repId = '';
let otherRepId = '';
let shiftId = '';
let reportId = '';
let dailyId = '';
const repEmail = `rep.${Date.now()}@mandoub.test`;
const otherRepEmail = `other.${Date.now()}@mandoub.test`;
const pointId = () => crypto.randomUUID();
const now = () => Date.now();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(client: request.Agent, email: string, password: string) {
  const res = await client.post('/api/auth/login').send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res;
}

test('health endpoint reports the retention window and consent version', async () => {
  const res = await admin.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.timezone, 'Africa/Cairo');
  assert.equal(res.body.staleGpsMinutes, 10);
  assert.equal(res.body.consentVersion, '1.0');
  assert.equal(res.body.retentionDays, 30);
});

test('social login rejects an unsigned token impersonating the administrator', async () => {
  const payload = Buffer.from(JSON.stringify({ email: 'admin@mandoub.test', sub: 'forged' })).toString('base64url');
  for (const provider of ['google', 'apple']) {
    const res = await request(app).post('/api/auth/social').send({ provider, idToken: `e30.${payload}.fake` });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'SOCIAL_LOGIN_UNAVAILABLE');
    assert.equal(res.body.token, undefined);
    assert.equal(res.headers['set-cookie'], undefined);
  }
});

test('admin login returns a session and an HttpOnly cookie', async () => {
  const res = await login(admin, 'admin@mandoub.test', 'TestPassword123!');
  adminToken = res.body.token;
  assert.ok(adminToken && adminToken.length > 20);
  assert.equal(res.body.user.role, 'admin');
  assert.match(String(res.headers['set-cookie']), /mandoub_admin_session=/);
  assert.match(String(res.headers['set-cookie']), /HttpOnly/i);
});

test('login rejects a wrong password with the same generic message', async () => {
  const res = await admin.post('/api/auth/login').send({ email: 'admin@mandoub.test', password: 'wrong-password' });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /غير صحيحة/);
});

test('login rejects an unknown account without leaking existence', async () => {
  const res = await admin.post('/api/auth/login').send({ email: 'nobody@mandoub.test', password: 'TestPassword123!' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'البريد الإلكتروني أو كلمة المرور غير صحيحة.');
});

test('admin creates a representative account', async () => {
  const res = await admin.post('/api/reps').set(auth(adminToken)).send({ name: 'مهندس اختبار', email: repEmail, password: 'RepPassword123!', phone: '01000000000', region: 'الإسكندرية' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  repId = res.body.user.id;
  assert.equal(res.body.user.role, 'rep');
  assert.equal(res.body.user.active, true);
  assert.ok(!('password_hash' in res.body.user));
});

test('representative login works and /auth/me accepts the bearer token', async () => {
  const res = await login(rep, repEmail, 'RepPassword123!');
  repToken = res.body.token;
  assert.equal(res.body.user.id, repId);
  const me = await rep.get('/api/auth/me').set(auth(repToken));
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, repEmail);
});

test('/auth/me also accepts the scoped session cookie alone', async () => {
  const agent = request.agent(app);
  await login(agent, repEmail, 'RepPassword123!');
  const me = await agent.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'rep');
});

test('a custom X-Mandoub-Token takes precedence over a stale cookie', async () => {
  const agent = request.agent(app);
  await login(agent, repEmail, 'RepPassword123!');
  const res = await agent.get('/api/auth/me').set('X-Mandoub-Token', 'not-a-real-token-value-1234');
  assert.equal(res.status, 401);
});

test('a representative cannot read the admin overview', async () => {
  const res = await rep.get('/api/overview').set(auth(repToken));
  assert.equal(res.status, 403);
});

test('admin overview lists the live representative and pending report counters', async () => {
  const res = await admin.get('/api/overview').set(auth(adminToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.staleGpsMinutes, 10);
  assert.ok(Array.isArray(res.body.reps));
  assert.ok(res.body.reps.some((r: any) => r.id === repId));
  assert.equal(typeof res.body.newReports, 'number');
  const mine = res.body.reps.find((r: any) => r.id === repId);
  assert.equal(mine.tracking, false);
  assert.equal(mine.location, null);
});

test('starting a shift without GPS is rejected', async () => {
  const res = await rep.post('/api/shifts/start').set(auth(repToken)).send({ consentVersion: '1.0' as const });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /GPS/);
});
test('starting a shift without explicit consent is rejected', async () => {
  const res = await rep.post('/api/shifts/start').set(auth(repToken)).send({ location: { lat: 31.2, lng: 29.9, accuracy: 10 }, deviceId: 'test-device-001' });
  assert.equal(res.status, 400);
});
test('starting a shift records the consent version and time', async () => {
  const res = await rep.post('/api/shifts/start').set(auth(repToken)).send({ consentVersion: '1.0', location: { lat: 31.2, lng: 29.9, accuracy: 10 }, deviceId: 'test-device-001', deviceName: 'Test Phone' });
  assert.equal(res.status, 200);
  shiftId = res.body.shift.id;
  assert.equal(res.body.shift.consent_version, '1.0');
  assert.ok(res.body.shift.started_at > 0);
  assert.equal(res.body.shift.ended_at, null);
});

test('the GPS fix at shift start is visible immediately without a second update', async () => {
  const res = await rep.get('/api/me/shift').set(auth(repToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.snapshot.location.lat, 31.2);
  assert.equal(res.body.snapshot.location.lng, 29.9);
  assert.equal(res.body.snapshot.location.speed, null);
});

test('resuming tracking reuses the open shift and still requires GPS', async () => {
  const noFix = await rep.post('/api/shifts/start').set(auth(repToken)).send({ consentVersion: '1.0', deviceId: 'test-device-001' });
  assert.equal(noFix.status, 422);
  const resumed = await rep.post('/api/shifts/start').set(auth(repToken)).send({ consentVersion: '1.0', location: { lat: 31.2, lng: 29.9, accuracy: 10 }, deviceId: 'test-device-001' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.shift.id, shiftId);
});

test('/me/shift exposes the open shift and snapshot', async () => {
  const res = await rep.get('/api/me/shift').set(auth(repToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.shift.id, shiftId);
  assert.equal(res.body.consentVersion, '1.0');
  assert.equal(res.body.snapshot.tracking, true);
});

test('a second representative is a real account, not a simulation', async () => {
  const other = await admin.post('/api/reps').set(auth(adminToken)).send({
    name: 'مهندس ثانٍ', email: otherRepEmail, password: 'RepPassword123!', region: 'البحيرة',
  });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  otherRepId = other.body.user.id;
  const otherRep = request(app);
  const loginRes = await otherRep.post('/api/auth/login').send({ email: otherRepEmail, password: 'RepPassword123!' });
  assert.equal(loginRes.status, 200);
  const start = await otherRep.post('/api/shifts/start').set(auth(loginRes.body.token)).send({
    consentVersion: '1.0', location: { lat: 31.2, lng: 29.9, accuracy: 10 }, deviceId: 'other-device-001',
  });
  assert.equal(start.status, 200, 'every representative can start a real shift');
});

test('a location batch is accepted for the open shift', async () => {
  const res = await rep.post('/api/locations').set(auth(repToken)).send({ points: [{ id: pointId(), shiftId, lat: 31.2001, lng: 29.9187, accuracy: 12, speed: 3.5, heading: 90, battery: 80, recordedAt: now() }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, 1);
  assert.equal(res.body.duplicates, 0);
});

test('replaying the same point is idempotent, not duplicated', async () => {
  const id = pointId();
  const body = { points: [{ id, shiftId, lat: 31.2002, lng: 29.9188, accuracy: 10, speed: null, heading: null, battery: 79, recordedAt: now() }] };
  const first = await rep.post('/api/locations').set(auth(repToken)).send(body);
  assert.equal(first.body.accepted, 1);
  const second = await rep.post('/api/locations').set(auth(repToken)).send(body);
  assert.equal(second.status, 200);
  assert.equal(second.body.accepted, 0);
  assert.equal(second.body.duplicates, 1);
});

test('a point for a shift that is not the caller\'s is rejected atomically', async () => {
  const res = await rep.post('/api/locations').set(auth(repToken)).send({
    points: [
      { id: pointId(), shiftId, lat: 31.2, lng: 29.9, accuracy: 5, speed: null, heading: null, battery: 50, recordedAt: now() },
      { id: pointId(), shiftId: crypto.randomUUID(), lat: 31.3, lng: 29.8, accuracy: 5, speed: null, heading: null, battery: 50, recordedAt: now() },
    ],
  });
  assert.equal(res.status, 422);
});

test('a point older than the retention window is rejected', async () => {
  const res = await rep.post('/api/locations').set(auth(repToken)).send({
    points: [{ id: pointId(), shiftId, lat: 31.2, lng: 29.9, accuracy: 5, speed: null, heading: null, battery: 50, recordedAt: now() - 40 * 86400000 }],
  });
  assert.equal(res.status, 422);
});

test('invalid coordinates are rejected with an Arabic validation error', async () => {
  const res = await rep.post('/api/locations').set(auth(repToken)).send({
    points: [{ id: pointId(), shiftId, lat: 200, lng: 29.9, accuracy: 5, speed: null, heading: null, battery: 50, recordedAt: now() }],
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /غير صالحة/);
});

test('the representative can read today\'s own route', async () => {
  const res = await rep.get(`/api/reps/${repId}/route`).set(auth(repToken));
  assert.equal(res.status, 200);
  assert.ok(res.body.points.length >= 2);
  assert.equal(res.body.truncated, false);
  assert.ok(res.body.distanceMeters >= 0);
  assert.equal(res.body.points[0].source, 'gps');
});

test('the assistant can summarise a real representative', async () => {
  const res = await admin.post('/api/agent/run').set(auth(adminToken)).send({
    task: 'summarize-day', repId, date: localDate('Africa/Cairo'),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.result.task, 'summarize-day');
  assert.match(res.body.result.summary, /مهندس اختبار/);
});

test('an unknown engineer id gives a clear message, not a schema error', async () => {
  const res = await admin.post('/api/agent/run').set(auth(adminToken)).send({
    task: 'summarize-day', repId: 'legacy-id-without-uuid-shape', date: localDate('Africa/Cairo'),
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /المهندس غير موجود/);
});

test('every assistant task runs against the real schema', async () => {
  const today = localDate('Africa/Cairo');
  const bodies: Array<Record<string, unknown>> = [
    { task: 'field-alerts' },
    { task: 'review-daily-reports' },
    { task: 'summarize-day', date: today },
    { task: 'analyze-route', repId, date: today },
  ];
  for (const body of bodies) {
    const res = await admin.post('/api/agent/run').set(auth(adminToken)).send(body);
    assert.equal(res.status, 200, `${body.task}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.result.task, body.task);
    assert.equal(typeof res.body.result.summary, 'string');
  }
});

test('the KPI analysis task is gone from the assistant', async () => {
  const today = localDate('Africa/Cairo');
  const res = await admin.post('/api/agent/run').set(auth(adminToken)).send({ task: 'kpi-insights', from: today, to: today });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /بيانات المهمة غير صحيحة/);
});

test('collections made while checking out are counted in the KPI report', async () => {
  const open = await rep.post('/api/visits/check-in').set(auth(repToken)).send({
    id: crypto.randomUUID(), customerName: 'مزرعة التحصيل', purpose: 'collection',
    location: { lat: 31.2, lng: 29.9, accuracy: 8 }, deviceId: 'test-device-001',
  });
  assert.equal(open.status, 201, JSON.stringify(open.body));
  const closed = await rep.post(`/api/visits/${open.body.visit.id}/check-out`).set(auth(repToken)).send({
    outcome: 'تم التحصيل', notes: '', amount: 2500, location: { lat: 31.2, lng: 29.9, accuracy: 8 },
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const today = localDate('Africa/Cairo');
  const res = await admin.get(`/api/kpis?from=${today}&to=${today}`).set(auth(adminToken));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body.rows as Array<{ repId: string; collected: number }>;
  const mine = rows.find(row => row.repId === repId);
  assert.ok(mine, 'the representative must appear in the KPI rows');
  assert.ok(mine!.collected >= 2500, `expected the collection to be counted, got ${mine!.collected}`);
});

test('the representative cannot read another representative\'s route', async () => {
  const res = await rep.get(`/api/reps/${otherRepId}/route`).set(auth(repToken));
  assert.equal(res.status, 403);
});

test('admin can read any representative route for a specific day', async () => {
  const res = await admin.get(`/api/reps/${repId}/route?date=2024-02-29`).set(auth(adminToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.date, '2024-02-29');
  assert.equal(res.body.points.length, 0);
});

test('a representative submits a report with location', async () => {
  reportId = crypto.randomUUID();
  const res = await rep.post('/api/reports').set(auth(repToken)).send({
    id: reportId, type: 'visit', title: 'زيارة مزرعة اختبار', body: 'تفاصيل', customer: 'مزرعة الاختبار', amount: null,
    location: { lat: 31.2, lng: 29.9, accuracy: 8 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.report.id, reportId);
  assert.equal(res.body.report.status, 'new');
  assert.equal(res.body.report.lat, 31.2);
  assert.equal(res.body.duplicate, false);
});

test('replaying the same report id does not create a second row', async () => {
  const res = await rep.post('/api/reports').set(auth(repToken)).send({
    id: reportId, type: 'visit', title: 'زيارة مزرعة اختبار', body: 'تفاصيل', customer: 'مزرعة الاختبار', amount: null, location: null,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM reports WHERE id=?', reportId)!.c, 1);
});

test('a representative only sees their own reports', async () => {
  const res = await rep.get('/api/reports').set(auth(repToken));
  assert.equal(res.status, 200);
  assert.ok(res.body.reports.length >= 1);
  assert.ok(res.body.reports.every((r: any) => r.userId === repId));
});

test('admin sees all reports and can mark one reviewed', async () => {
  const list = await admin.get('/api/reports').set(auth(adminToken));
  assert.equal(list.status, 200);
  assert.ok(list.body.reports.length >= 1);
  assert.ok(list.body.reports.every((r: any) => !('repIsDemo' in r)));
  const res = await admin.patch(`/api/reports/${reportId}`).set(auth(adminToken)).send({ status: 'reviewed' });
  assert.equal(res.status, 200);
  assert.equal(res.body.report.status, 'reviewed');
  assert.ok(res.body.report.reviewedAt > 0);
});

test('daily report validation requires at least one visit', async () => {
  const res = await rep.post('/api/daily-reports').set(auth(repToken)).send({
    version: 1, id: crypto.randomUUID(), engineerName: 'مهندس اختبار', reportDate: new Date().toISOString().slice(0, 10),
    leftAt: '08:00', returnedAt: '17:00', circumstances: '', visits: [], signedName: 'مهندس اختبار', confirmed: true, location: null,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /زيارة/);
});

test('a daily report with three visits is stored with an Arabic weekday name', async () => {
  dailyId = crypto.randomUUID();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(Date.now());
  const res = await rep.post('/api/daily-reports').set(auth(repToken)).send({
    version: 1, id: dailyId, engineerName: 'مهندس اختبار', reportDate: today, leftAt: '08:30', returnedAt: '17:15', circumstances: '',
    signedName: 'مهندس اختبار', confirmed: true, location: { lat: 31.2, lng: 29.9, accuracy: 9 },
    visits: [
      { customerName: 'مزرعة النور', governorate: 'القاهرة', district: 'مدينة نصر', village: 'القرية', phone: '01000000001', areaFeddan: 12, crops: 'قمح', recommendations: 'ري', outcome: 'متابعة' },
      { customerName: 'عميل الاختبار', governorate: 'الجيزة', district: 'الدقي', village: '', phone: '', areaFeddan: null, crops: '', recommendations: '', outcome: 'عينة' },
      { customerName: 'مزرعة السلام', governorate: 'الشرقية', district: 'بلبيس', village: 'قرية', phone: '01000000003', areaFeddan: 25, crops: 'ذرة', recommendations: 'فحص', outcome: 'موعد' },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.report.id, dailyId);
  assert.equal(res.body.report.visits.length, 3);
  assert.equal(res.body.report.visits[1].position, 2);
  assert.equal(res.body.report.signedName, 'مهندس اختبار');
  assert.ok(res.body.report.dayName.length > 2);
  assert.equal(res.body.duplicate, false);
});

test('replaying a daily report id is idempotent', async () => {
  const report = store.get('SELECT * FROM daily_reports WHERE id=?', dailyId)!;
  const res = await rep.post('/api/daily-reports').set(auth(repToken)).send({
    version: 1, id: dailyId, engineerName: report.engineer_name, reportDate: report.report_date, leftAt: report.left_at,
    returnedAt: report.returned_at, circumstances: report.circumstances, signedName: report.signed_name, confirmed: true, location: null,
    visits: [{ customerName: 'مزرعة النور', governorate: 'القاهرة', district: 'مدينة نصر', village: 'القرية', phone: '', areaFeddan: 12, crops: 'قمح', recommendations: '', outcome: '' }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM daily_report_visits WHERE report_id=?', dailyId)!.c, 3);
});

test('a future daily report date is rejected', async () => {
  const future = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(Date.now() + 3 * 86400000);
  const res = await rep.post('/api/daily-reports').set(auth(repToken)).send({
    version: 1, id: crypto.randomUUID(), engineerName: 'مهندس اختبار', reportDate: future, leftAt: '', returnedAt: '', circumstances: '',
    signedName: 'مهندس اختبار', confirmed: true, location: null,
    visits: [{ customerName: 'عميل', governorate: '', district: '', village: '', phone: '', areaFeddan: null, crops: '', recommendations: '', outcome: '' }],
  });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /مستقبلي/);
});

test('admin lists daily reports and marks one reviewed', async () => {
  const list = await admin.get('/api/daily-reports').set(auth(adminToken));
  assert.equal(list.status, 200);
  assert.ok(list.body.reports.length >= 1);
  const res = await admin.patch(`/api/daily-reports/${dailyId}`).set(auth(adminToken)).send({ status: 'reviewed' });
  assert.equal(res.status, 200);
  assert.equal(res.body.report.status, 'reviewed');
  assert.ok(res.body.report.reviewedAt > 0);
});

test('another representative cannot read someone else\'s daily report', async () => {
  const loginRes = await request(app).post('/api/auth/login').send({ email: otherRepEmail, password: 'RepPassword123!' });
  const res = await request(app).get(`/api/daily-reports/${dailyId}`).set(auth(loginRes.body.token));
  assert.equal(res.status, 403);
});

test('the daily report PDF is generated as a valid UTF-8 PDF', async () => {
  const res = await admin.get(`/api/daily-reports/${dailyId}/pdf`).set(auth(adminToken)).buffer(true).parse((r, done) => {
    const chunks: Buffer[] = []; r.on('data', c => chunks.push(c)); r.on('end', () => done(null, Buffer.concat(chunks)));
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.body.subarray(0, 5).toString(), '%PDF-');
  assert.ok(res.body.length > 3000);
});

test('socket.io rejects an unauthenticated connection', async () => {
  const socket: Socket = connectClient(`http://127.0.0.1:${port}`, { auth: {}, reconnection: false, transports: ['websocket'] });
  const error = await new Promise<Error>(resolve => { socket.on('connect_error', resolve); socket.on('connect', () => resolve(new Error('connected'))); });
  socket.close();
  assert.match(error.message, /Unauthorized/);
});

test('an admin socket receives the live overview after login', async () => {
  const socket: Socket = connectClient(`http://127.0.0.1:${port}`, { auth: { token: adminToken }, reconnection: false, transports: ['websocket'] });
  const overview = await new Promise<any>((resolve, reject) => {
    socket.on('overview', resolve);
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('timeout')), 4000);
  });
  socket.close();
  assert.ok(overview.reps.some((r: any) => r.id === repId));
});

test('the day bounds follow DST transitions in the configured timezone', () => {
  const spring = dayBounds('2026-04-24', 'Africa/Cairo');
  const autumn = dayBounds('2026-10-29', 'Africa/Cairo');
  assert.equal(spring.end - spring.start, 23 * 3600000);
  assert.equal(autumn.end - autumn.start, 25 * 3600000);
});


let visitId = '';
test('a visit check-in stores the customer and opens the visit', async () => {
  visitId = crypto.randomUUID();
  const res = await rep.post('/api/visits/check-in').set(auth(repToken)).send({
    id: visitId, customerName: 'مزرعة الزيارة', governorate: 'القاهرة', district: 'مدينة نصر', village: 'القرية',
    phone: '01000000009', purpose: 'visit', notes: 'اختبار', location: { lat: 31.21, lng: 29.92, accuracy: 7 },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.visit.status, 'open');
  assert.equal(res.body.visit.customerName, 'مزرعة الزيارة');
  assert.equal(res.body.visit.inLat, 31.21);
  assert.equal(res.body.duplicate, false);
});

test('a second check-in is rejected while a visit is still open', async () => {
  const res = await rep.post('/api/visits/check-in').set(auth(repToken)).send({ id: crypto.randomUUID(), customerName: 'عميل تاني', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(res.status, 409);
  assert.equal(res.body.openVisitId, visitId);
});

test('the day summary shows the open visit and the collected totals', async () => {
  const res = await rep.get('/api/me/summary').set(auth(repToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.openVisit.id, visitId);
  assert.ok(res.body.visitsTotal >= 1);
  assert.equal(typeof res.body.distanceMeters, 'number');
  assert.equal(res.body.timezone, 'Africa/Cairo');
});

test('checking out closes the visit with a measured duration', async () => {
  const res = await rep.post(`/api/visits/${visitId}/check-out`).set(auth(repToken)).send({
    outcome: 'تمت المتابعة وطلب عينة', notes: 'زيارة ناجحة', amount: null, location: { lat: 31.22, lng: 29.93, accuracy: 6 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.visit.status, 'closed');
  assert.ok(res.body.visit.checkedOutAt >= res.body.visit.checkedInAt);
  assert.ok(res.body.visit.durationSeconds >= 0);
  assert.equal(res.body.visit.outLat, 31.22);
});

test('a collection checkout is mirrored into the manager reports feed', async () => {
  const id = crypto.randomUUID();
  await rep.post('/api/visits/check-in').set(auth(repToken)).send({ id, customerName: 'مؤسسة التحصيل', purpose: 'collection', location: { lat: 31.21, lng: 29.92, accuracy: 7 } });
  const out = await rep.post(`/api/visits/${id}/check-out`).set(auth(repToken)).send({ outcome: 'تحصيل نقدي', amount: 1250 });
  assert.equal(out.status, 200);
  const mirrored = store.get('SELECT * FROM reports WHERE id=?', `visit:${id}`);
  assert.ok(mirrored, 'collection should appear in reports');
  assert.equal(mirrored!.type, 'collection');
  assert.equal(mirrored!.amount, 1250);
  assert.equal(mirrored!.customer, 'مؤسسة التحصيل');
});

test('the manager visit feed is scoped by date and representative', async () => {
  const mine = await rep.get('/api/visits').set(auth(repToken));
  assert.equal(mine.status, 200);
  assert.ok(mine.body.visits.every((v: any) => v.userId === repId));
  const managerFeed = await admin.get(`/api/visits?repId=${repId}`).set(auth(adminToken));
  assert.equal(managerFeed.status, 200);
  assert.ok(managerFeed.body.visits.length >= 2);
  assert.equal(typeof managerFeed.body.visits[0].repName, 'string');
});

test('manager alerts expose coded exceptions', async () => {
  const res = await admin.get('/api/alerts').set(auth(adminToken));
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.alerts));
  assert.ok(res.body.alerts.length > 0);
  for (const alert of res.body.alerts) {
    assert.ok(['warn', 'info'].includes(alert.level));
    assert.equal(typeof alert.code, 'string');
    assert.equal(typeof alert.title, 'string');
  }
});

test('KPIs aggregate visits, distance and collections per representative', async () => {
  const res = await admin.get('/api/kpis').set(auth(adminToken));
  assert.equal(res.status, 200);
  const mine = res.body.rows.find((row: any) => row.repId === repId);
  assert.ok(mine);
  assert.ok(mine.visits >= 2);
  assert.ok(mine.visitsCompleted >= 2);
  assert.ok(mine.collected >= 1250);
  assert.ok(mine.distanceMeters >= 0);
  assert.equal(typeof mine.daysWithData, 'number');
});

test('the KPI export is a UTF-8 CSV with Arabic headers and a BOM', async () => {
  const res = await admin.get('/api/kpis.csv').set(auth(adminToken)).buffer(true).parse((r, done) => {
    const chunks: Buffer[] = []; r.on('data', c => chunks.push(c)); r.on('end', () => done(null, Buffer.concat(chunks)));
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /text\/csv/);
  assert.deepEqual(res.body.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  const lines = csvLines(res.body);
  assert.match(lines[0], /^"المهندس"/, 'a plain RFC-4180 header, no delimiter hint line');
  assert.ok(lines.length >= 2);
});

test('the monthly export opens in Excel as real columns, in the same order as the dashboard', async () => {
  const res = await admin.get('/api/monthly.csv').set(auth(adminToken)).buffer(true).parse(csvParser);
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-disposition']), /elhelb-monthly-\d{4}-\d{2}\.csv/);
  const lines = csvLines(res.body);
  assert.match(lines[0], /^"المهندس","المنطقة","الشهر","عدد الزيارات"/);
  const rows = lines.slice(1).map(line => line.split('","'));
  for (const row of rows) {
    assert.equal(row.length, 10, `every exported row must have 10 columns: ${row.join('|')}`);
    assert.match(row[2].replace(/"/g, ''), /^\d{4}-\d{2}$/, 'the month column must hold the month');
  }
  const visits = rows.map(row => Number(row[3]));
  assert.deepEqual(visits, [...visits].sort((a, b) => b - a), 'busiest engineer first, like the dashboard');
});

test('the monthly Excel export is a real workbook with readable Arabic', async () => {
  const res = await admin.get('/api/monthly.xlsx').set(auth(adminToken)).buffer(true).parse(csvParser);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(String(res.headers['content-type']), /spreadsheetml\.sheet/);
  assert.match(String(res.headers['content-disposition']), /elhelb-monthly-\d{4}-\d{2}\.xlsx/);
  const body = res.body as Buffer;
  assert.deepEqual(body.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'an xlsx must be a zip');
  const files = xlsxEntries(body);
  for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(files.has(part), `missing workbook part ${part}`);
  }
  const sheet = files.get('xl/worksheets/sheet1.xml')!;
  assert.match(sheet, /المهندس/, 'the header must be stored as real UTF-8 text, not mojibake');
  assert.match(sheet, /rightToLeft="1"/, 'the sheet opens right-to-left for Arabic');
  assert.match(sheet, /<v>\d+<\/v>/, 'numbers are written as numbers so Excel can sum them');
  assert.match(files.get('xl/workbook.xml')!, /سجل \d{4}-\d{2}/);
});

test('the KPI Excel export is a real workbook too', async () => {
  const res = await admin.get('/api/kpis.xlsx').set(auth(adminToken)).buffer(true).parse(csvParser);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(String(res.headers['content-type']), /spreadsheetml\.sheet/);
  const sheet = xlsxEntries(res.body as Buffer).get('xl/worksheets/sheet1.xml')!;
  assert.match(sheet, /التحصيل/);
});

test('the representative stops tracking and their open shift is closed', async () => {
  const stop = await rep.post('/api/shifts/stop').set(auth(repToken));
  assert.equal(stop.status, 200);
  const shift = store.get('SELECT ended_at FROM shifts WHERE id=?', shiftId)!;
  assert.ok(shift.ended_at > 0);
});

test('disabling a representative blocks login and kills existing sessions', async () => {
  const res = await admin.patch(`/api/reps/${repId}`).set(auth(adminToken)).send({ active: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.active, false);
  const disabledAt = store.get('SELECT ended_at FROM shifts WHERE user_id=?', repId);
  assert.ok(disabledAt === undefined || disabledAt.ended_at === null || disabledAt.ended_at > 0);
  const me = await rep.get('/api/auth/me').set(auth(repToken));
  assert.equal(me.status, 401);
  const relogin = await request(app).post('/api/auth/login').send({ email: repEmail, password: 'RepPassword123!' });
  assert.equal(relogin.status, 401);
});

test('logout invalidates the session token', async () => {
  const fresh = await request(app).post('/api/auth/login').send({ email: 'admin@mandoub.test', password: 'TestPassword123!' });
  const token = fresh.body.token;
  const out = await request(app).post('/api/auth/logout').set(auth(token));
  assert.equal(out.status, 200);
  const me = await request(app).get('/api/auth/me').set(auth(token));
  assert.equal(me.status, 401);
});

// Kept for parity with the production database guard: a session must never outlive an active flag flip.
test('the privacy policy is public and states the live retention window', async () => {
  const res = await request(app).get('/privacy');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /text\/html/);
  assert.match(res.text, /سياسة الخصوصية/);
  // The page is generated from the running configuration, so the numbers cannot drift.
  assert.match(res.text, /30<\/b> يومًا/);
  assert.match(res.text, /privacy@mandoub\.test/);
  assert.match(res.text, /حذف الحساب/);
});

test('a representative can erase their own account and everything it produced', async () => {
  const email = `erase.${Date.now()}@mandoub.test`;
  const password = 'ErasePassword123!';
  const created = await admin.post('/api/reps').set(auth(adminToken)).send({ name: 'مهندس حذف', email, password });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.user.id;

  const signedIn = await request(app).post('/api/auth/login').send({ email, password });
  const token = signedIn.body.token;
  const started = await request(app).post('/api/shifts/start').set(auth(token)).send({
    consentVersion: '1.0', deviceId: 'erase-device-1', location: { lat: 31.2, lng: 29.9, accuracy: 5 },
  });
  assert.equal(started.status, 200);
  assert.ok(Number(store.get('SELECT COUNT(*) AS c FROM locations WHERE user_id=?', id)?.c) > 0);

  // Two deliberate guards: a mistyped address and a missing confirmation both change nothing.
  const wrongEmail = await request(app).delete('/api/me').set(auth(token)).send({ confirm: true, email: 'someone@else.test' });
  assert.equal(wrongEmail.status, 422);
  assert.equal(wrongEmail.body.code, 'EMAIL_MISMATCH');
  const noConfirm = await request(app).delete('/api/me').set(auth(token)).send({ email });
  assert.equal(noConfirm.status, 400);
  assert.ok(store.get('SELECT id FROM users WHERE id=?', id));

  const erased = await request(app).delete('/api/me').set(auth(token)).send({ confirm: true, email: email.toUpperCase() });
  assert.equal(erased.status, 200, JSON.stringify(erased.body));
  assert.equal(store.get('SELECT id FROM users WHERE id=?', id), undefined);
  for (const table of ['shifts', 'locations', 'sessions']) {
    assert.equal(Number(store.get(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id=?`, id)?.c), 0, table);
  }
  // The audit trail keeps the fact, not the person.
  assert.ok(store.get("SELECT id FROM audit_log WHERE action='account.delete'"));
  assert.equal((await request(app).get('/api/auth/me').set(auth(token))).status, 401);
  assert.equal((await request(app).post('/api/auth/login').send({ email, password })).status, 401);
});

test('the only administrator cannot delete the last manager account', async () => {
  const signedIn = await request(app).post('/api/auth/login').send({ email: 'admin@mandoub.test', password: 'TestPassword123!' });
  const res = await request(app).delete('/api/me').set(auth(signedIn.body.token)).send({ confirm: true, email: 'admin@mandoub.test' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'LAST_ADMIN');
  assert.ok(store.get('SELECT id FROM users WHERE email=?', 'admin@mandoub.test'));
});

// ---- Hardening regressions -------------------------------------------------------------
// Earlier tests deliberately disable and erase the original representative, so these build
// their own account instead of depending on the shared session.
let freshSeq = 0;
async function freshRep(label: string) {
  freshSeq += 1;
  const email = `${label}.${freshSeq}.${Date.now()}@mandoub.test`;
  const password = 'FreshPassword123!';
  const created = await admin.post('/api/reps').set(auth(adminToken)).send({ name: `مهندس ${label}`, email, password });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const session = await login(request(app), email, password);
  return { email, token: session.body.token as string, id: created.body.user.id as string };
}

test('TRUST_PROXY trusts only a local proxy unless configured otherwise', () => {
  assert.equal(readTrustProxy(undefined, true), 'loopback');
  assert.equal(readTrustProxy(undefined, false), false);
  assert.equal(readTrustProxy('1', true), 1);
  assert.equal(readTrustProxy('false', true), false);
  assert.equal(readTrustProxy('10.0.0.0/8', true), '10.0.0.0/8');
});

test('the session cookie is HttpOnly, Lax and never cross-site', async () => {
  const created = await admin.post('/api/reps').set(auth(adminToken))
    .send({ name: 'مهندس الكوكيز', email: `cookie.${Date.now()}@mandoub.test`, password: 'CookiePassword123!' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const res = await request(app).post('/api/auth/login').send({ email: created.body.user.email, password: 'CookiePassword123!' });
  assert.equal(res.status, 200);
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] || []);
  const session = cookies.find(cookie => cookie.startsWith('mandoub_rep_session='));
  assert.ok(session, 'the representative cookie must be set');
  assert.match(String(session), /HttpOnly/i);
  assert.match(String(session), /SameSite=Lax/i);
  assert.ok(!/SameSite=None/i.test(String(session)));
});

test('a representative changes their password and the other devices are signed out', async () => {
  const email = `pw.${Date.now()}@mandoub.test`;
  const created = await admin.post('/api/reps').set(auth(adminToken))
    .send({ name: 'مهندس كلمة المرور', email, password: 'StartPassword1!' });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const first = await login(request(app), email, 'StartPassword1!');
  const second = await login(request(app), email, 'StartPassword1!');
  const current = first.body.token as string;
  const other = second.body.token as string;

  const wrong = await request(app).post('/api/me/password').set(auth(current)).send({ currentPassword: 'not-it', newPassword: 'BrandNewPassword1!' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, 'WRONG_PASSWORD');

  assert.equal((await request(app).post('/api/me/password').set(auth(current)).send({ currentPassword: 'StartPassword1!', newPassword: 'short' })).status, 400);
  assert.equal((await request(app).post('/api/me/password').set(auth(current)).send({ currentPassword: 'StartPassword1!', newPassword: 'StartPassword1!' })).status, 400);

  const changed = await request(app).post('/api/me/password').set(auth(current)).send({ currentPassword: 'StartPassword1!', newPassword: 'BrandNewPassword1!' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  // The device that changed it keeps working; the other session is gone.
  assert.equal((await request(app).get('/api/auth/me').set(auth(current))).status, 200);
  assert.equal((await request(app).get('/api/auth/me').set(auth(other))).status, 401);
  // The old password is dead, the new one signs in.
  assert.equal((await request(app).post('/api/auth/login').send({ email, password: 'StartPassword1!' })).status, 401);
  assert.equal((await request(app).post('/api/auth/login').send({ email, password: 'BrandNewPassword1!' })).status, 200);
  assert.ok(store.get("SELECT id FROM audit_log WHERE action='auth.password_change' ORDER BY id DESC LIMIT 1"));
});

test('repeated wrong passwords freeze the account, and a success clears the misses', async () => {
  const isolated = createApp({ ...config, dbPath: ':memory:', loginAccountLimit: 3 });
  try {
    const client = request(isolated.app);
    const email = config.adminEmail;
    for (let i = 0; i < 2; i++) {
      assert.equal((await client.post('/api/auth/login').send({ email, password: 'wrong' })).status, 401);
    }
    // A correct sign-in wipes the two misses: mistyping twice is not an attack.
    assert.equal((await client.post('/api/auth/login').send({ email, password: config.adminPassword })).status, 200);
    for (let i = 0; i < 3; i++) {
      assert.equal((await client.post('/api/auth/login').send({ email, password: 'wrong' })).status, 401);
    }
    const frozen = await client.post('/api/auth/login').send({ email, password: config.adminPassword });
    assert.equal(frozen.status, 429);
    assert.equal(frozen.body.code, 'ACCOUNT_THROTTLED');
    // The freeze is per account: an unrelated address still gets a normal answer.
    assert.equal((await client.post('/api/auth/login').send({ email: 'nobody@mandoub.test', password: 'anything' })).status, 401);
  } finally { await isolated.close(); }
});

test('the assistant scopes a representative to their own day', async () => {
  const engineer = await freshRep('agent-scope');
  const own = await request(app).post('/api/agent/run').set(auth(engineer.token)).send({ task: 'summarize-day' });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  const reps = own.body.result.details.reps as Array<{ repId: string }>;
  assert.equal(reps.length, 1, 'a missing repId must not aggregate the whole team');
  assert.equal(reps[0].repId, engineer.id);

  const second = await freshRep('agent-scope-other');
  const other = await request(app).post('/api/agent/run').set(auth(engineer.token)).send({ task: 'summarize-day', repId: second.id });
  assert.equal(other.status, 403);
});

test('the assistant internals are for the manager only', async () => {
  const engineer = await freshRep('agent-internals');
  assert.equal((await request(app).get('/api/agent/status').set(auth(engineer.token))).status, 403);
  assert.equal((await request(app).get('/api/agent/skills').set(auth(engineer.token))).status, 403);

  const manager = await request(app).get('/api/agent/status').set(auth(adminToken));
  assert.equal(manager.status, 200);
  for (const skill of manager.body.skills as Array<Record<string, unknown>>) {
    assert.equal(skill.filePath, undefined, 'the filesystem path must not leave the server');
    assert.equal(skill.content, undefined, 'the skill body must not leave the server');
    assert.ok(typeof skill.name === 'string');
  }
});

test('an exported CSV never runs a name as a spreadsheet formula', async () => {
  const email = `formula.${Date.now()}@mandoub.test`;
  const name = '=HYPERLINK("http://attacker.test","x")';
  assert.equal((await admin.post('/api/reps').set(auth(adminToken)).send({ name, email, password: 'FormulaPassword1!' })).status, 201);

  const today = localDate(config.timezone);
  const res = await request(app).get(`/api/kpis.csv?from=${today}&to=${today}`).set(auth(adminToken)).buffer(true).parse(csvParser).expect(200);
  const rows = csvLines(res.body as unknown as Buffer).filter(line => line.includes('HYPERLINK'));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].startsWith('"\'=HYPERLINK'), rows[0]);
});

test('the retention sweep also deletes stillness justifications', async () => {
  const insert = (id: string, createdAt: number) => store.run(
    `INSERT INTO idle_reports(id,user_id,shift_id,lat,lng,accuracy,reason,duration_minutes,device_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`, id, repId, null, 31.2, 29.9, 8, 'وقوف قديم', 15, 'retention-probe', createdAt,
  );
  insert('idle-old-probe', Date.now() - 40 * 86400000);
  insert('idle-new-probe', Date.now());
  store.cleanup(config.retentionDays);
  assert.equal(store.get("SELECT id FROM idle_reports WHERE id='idle-old-probe'"), undefined, 'expired rows must be swept');
  assert.ok(store.get("SELECT id FROM idle_reports WHERE id='idle-new-probe'"), 'recent rows stay');
  store.run("DELETE FROM idle_reports WHERE id='idle-new-probe'");
});

test('the privacy page escapes the operator supplied contact address', async () => {
  const isolated = createApp({ ...config, dbPath: ':memory:', privacyContact: 'x"><script>alert(1)</script>' });
  try {
    const res = await request(isolated.app).get('/privacy').expect(200);
    const html = String(res.text);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  } finally { await isolated.close(); }
});

// ---- Payload and accounting fixes ---------------------------------------------------------

test('a route response is thinned for drawing while the distance uses every fix', async () => {
  const engineer = await freshRep('route-thinning');
  const shift = await request(app).post('/api/shifts/start').set(auth(engineer.token))
    .send({ consentVersion: '1.0', deviceId: 'thin-device', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(shift.status, 200, JSON.stringify(shift.body));
  const shiftId = shift.body.shift.id as string;
  // Backdate the shift so the ten minutes of fixes below are in the past: the endpoint rejects
  // fixes stamped in the future, which is the point of the timestamp checks.
  store.run('UPDATE shifts SET started_at=? WHERE id=?', Date.now() - 3600000, shiftId);
  const base = Date.now() - 660000;
  const points = Array.from({ length: 600 }, (_, index) => ({
    id: crypto.randomUUID(), shiftId,
    lat: 31.2 + index * 0.0001, lng: 29.9 + index * 0.0001,
    accuracy: 6, speed: 3, heading: 100, battery: 80, recordedAt: base + index * 1000,
  }));
  // The endpoint takes at most 100 fixes per batch, exactly like the device's outbox.
  for (let start = 0; start < points.length; start += 100) {
    const batch = points.slice(start, start + 100);
    const pushed = await request(app).post('/api/locations').set(auth(engineer.token)).send({ points: batch });
    assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
  }

  const full = await request(app).get(`/api/reps/${engineer.id}/route?maxPoints=5000`).set(auth(engineer.token));
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.equal(full.body.pointCount, 601, 'the check-in point plus the batch');
  assert.equal(full.body.sampled, false);

  const thinned = await request(app).get(`/api/reps/${engineer.id}/route?maxPoints=200`).set(auth(engineer.token));
  assert.equal(thinned.status, 200);
  assert.equal(thinned.body.points.length, 200);
  assert.equal(thinned.body.sampled, true);
  assert.equal(thinned.body.pointCount, 601);
  // The shape still starts and ends where the engineer did.
  assert.equal(thinned.body.points[0].lat, full.body.points[0].lat);
  assert.equal(thinned.body.points[199].lat, full.body.points[600].lat);
  // Distance is computed before thinning, so it must not shrink with the payload.
  assert.equal(thinned.body.distanceMeters, full.body.distanceMeters);
});

test('one busy office address does not spend another engineer\'s budget', async () => {
  const isolated = createApp({ ...config, dbPath: ':memory:', apiRateLimit: { windowMs: 60000, limit: 10 } });
  try {
    const client = request(isolated.app);
    const adminSession = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
    const adminToken = adminSession.body.token as string;
    const created = await client.post('/api/reps').set(auth(adminToken))
      .send({ name: 'مهندس الشبكة', email: 'nat@mandoub.test', password: 'NatPassword1234!' });
    assert.equal(created.status, 201);
    const repSession = await client.post('/api/auth/login').send({ email: 'nat@mandoub.test', password: 'NatPassword1234!' });
    const repToken = repSession.body.token as string;

    // The manager's own bucket is separate, so it can be exhausted without touching the rep.
    // Creating the rep above already spent one of the ten calls.
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await client.get('/api/auth/me').set(auth(adminToken))).status);
    assert.deepEqual(statuses.slice(0, 9), Array(9).fill(200));
    assert.equal(statuses[9], 429, 'the eleventh call exceeds the manager budget');

    // Same public IP, different session: still served.
    assert.equal((await client.get('/api/auth/me').set(auth(repToken))).status, 200);
  } finally { await isolated.close(); }
});

test('activity days are counted on the company calendar, not on UTC', async () => {
  const isolated = createApp({ ...config, dbPath: ':memory:' });
  try {
    const client = request(isolated.app);
    const adminSession = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
    const adminToken = adminSession.body.token as string;
    const created = await client.post('/api/reps').set(auth(adminToken))
      .send({ name: 'مهندس الأيام', email: 'days@mandoub.test', password: 'DaysPassword1234!' });
    const engineer = created.body.user as { id: string };
    const repSession = await client.post('/api/auth/login').send({ email: 'days@mandoub.test', password: 'DaysPassword1234!' });
    const repToken = repSession.body.token as string;

    // Yesterday, so both fixes are safely in the past.
    const today = localDate(config.timezone);
    const yesterday = localDate(config.timezone, Date.now() - 86400000);
    const bounds = dayBounds(yesterday, config.timezone);
    const started = await client.post('/api/shifts/start').set(auth(repToken))
      .send({ consentVersion: '1.0', deviceId: 'days-device', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
    const shiftId = started.body.shift.id as string;
    isolated.store.run('UPDATE shifts SET started_at=? WHERE id=?', bounds.start - 3600000, shiftId);
    // Early morning and late evening of the same local day: in Cairo these two fall on different
    // UTC dates, which is exactly what used to inflate "أيام النشاط" in the monthly register.
    const at = [bounds.start + 3600000, bounds.end - 3600000];
    const points = at.map((recordedAt, index) => ({
      id: crypto.randomUUID(), shiftId, lat: 31.2 + index * 0.001, lng: 29.9, accuracy: 6,
      speed: 2, heading: 90, battery: 70, recordedAt,
    }));
    assert.equal((await client.post('/api/locations').set(auth(repToken)).send({ points })).status, 200);

    const kpis = await client.get(`/api/kpis?from=${yesterday}&to=${yesterday}`).set(auth(adminToken));
    assert.equal(kpis.status, 200, JSON.stringify(kpis.body));
    const row = (kpis.body.rows as Array<{ repId: string; daysWithData: number; pointCount: number }>)
      .find(entry => entry.repId === engineer.id);
    assert.ok(row, 'the engineer must appear in the KPI rows');
    assert.equal(row!.daysWithData, 1, 'one local day, not two UTC dates');
  } finally { await isolated.close(); }
});

test('a forged token does not buy a fresh rate-limit bucket', async () => {
  const isolated = createApp({ ...config, dbPath: ':memory:', apiRateLimit: { windowMs: 60000, limit: 4 } });
  try {
    const client = request(isolated.app);
    const statuses: number[] = [];
    // A random token each time must not create a new identity: only live sessions are keyed.
    for (let i = 0; i < 6; i++) {
      statuses.push((await client.get('/api/auth/me').set({ 'X-Mandoub-Token': crypto.randomUUID() })).status);
    }
    assert.deepEqual(statuses.slice(0, 4), Array(4).fill(401));
    assert.equal(statuses[4], 429);
    assert.equal(statuses[5], 429);
  } finally { await isolated.close(); }
});

// ---- Distance filter: the rewrite must be bit-for-bit the same numbers ---------------------

import { distanceMeters, haversine, type GeoPoint } from '../src/geo.js';

/** The original implementation, kept here as the reference the optimised one is checked against. */
function referenceDistance(points: GeoPoint[]): number {
  const usable = points.filter(p => p.accuracy === null || (p.accuracy > 0 && p.accuracy <= 100));
  if (usable.length < 2) return 0;
  const steps: Array<{ dLat: number; dLng: number; seconds: number }> = [];
  let total = 0;
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  for (let index = 1; index < usable.length; index++) {
    const previous = usable[index - 1];
    const current = usable[index];
    const seconds = (current.recordedAt - previous.recordedAt) / 1000;
    if (seconds <= 0 || seconds > 600) { steps.length = 0; continue; }
    steps.push({ dLat: current.lat - previous.lat, dLng: current.lng - previous.lng, seconds });
    if (steps.length > 5) steps.shift();
    const dLat = median(steps.map(step => step.dLat));
    const dLng = median(steps.map(step => step.dLng));
    const stepSeconds = median(steps.map(step => step.seconds));
    if (stepSeconds <= 0) continue;
    const meters = haversine(current, { lat: current.lat + dLat, lng: current.lng + dLng });
    if (meters / stepSeconds > 55) continue;
    const accuracy = ((previous.accuracy ?? 0) + (current.accuracy ?? 0)) / 2;
    if (meters < Math.max(10, accuracy)) continue;
    total += meters;
  }
  return total;
}

test('the optimised distance filter returns exactly the old numbers', () => {
  // A deterministic pseudo-random track: driving, GPS jitter, a long gap, a teleport, a
  // low-accuracy stretch and repeated timestamps.
  let seed = 42;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const tracks: GeoPoint[][] = [];
  for (const day of [0, 1, 2]) {
    const points: GeoPoint[] = [];
    let lat = 31.2, lng = 29.9;
    let at = 1_700_000_000_000 + day * 86_400_000;
    for (let index = 0; index < 400; index++) {
      lat += (random() - 0.45) * 0.0004;
      lng += (random() - 0.45) * 0.0004;
      at += index === 120 ? 900_000 : 1000 + Math.round(random() * 900);
      if (index === 200) { lat += 0.5; lng += 0.5; }              // teleport
      const accuracy = index > 300 ? 150 : 5 + Math.round(random() * 20); // last stretch unusable
      points.push({ lat, lng, accuracy, speed: null, recordedAt: at });
    }
    points.push({ ...points[points.length - 1] });                 // duplicate timestamp
    tracks.push(points);
  }
  for (const track of tracks) {
    assert.equal(distanceMeters(track), referenceDistance(track));
    assert.equal(distanceMeters(track.slice(0, 1)), 0);
    assert.equal(distanceMeters([]), 0);
  }
});

test('the day summary reports the requested day, not today', async () => {
  const engineer = await freshRep('summary-day');
  const started = await request(app).post('/api/shifts/start').set(auth(engineer.token))
    .send({ consentVersion: '1.0', deviceId: 'summary-device', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const shiftId = started.body.shift.id as string;
  assert.equal((await request(app).get('/api/me/shift?snapshot=0').set(auth(engineer.token))).body.snapshot, undefined);

  const yesterday = localDate(config.timezone, Date.now() - 86400000);
  const bounds = dayBounds(yesterday, config.timezone);
  store.run('UPDATE shifts SET started_at=? WHERE id=?', bounds.start - 3600000, shiftId);
  // Twenty fixes 22 m apart, so the distance filter has real movement to count.
  const points = Array.from({ length: 20 }, (_, index) => ({
    id: crypto.randomUUID(), shiftId, lat: 31.2 + index * 0.0002, lng: 29.9, accuracy: 6,
    speed: 3, heading: 90, battery: 80, recordedAt: bounds.start + 7200000 + index * 10000,
  }));
  assert.equal((await request(app).post('/api/locations').set(auth(engineer.token)).send({ points })).status, 200);

  const past = await request(app).get(`/api/me/summary?date=${yesterday}`).set(auth(engineer.token));
  assert.equal(past.status, 200, JSON.stringify(past.body));
  assert.ok(past.body.distanceMeters > 300, `yesterday must carry its own distance, got ${past.body.distanceMeters}`);

  const today = await request(app).get('/api/me/summary').set(auth(engineer.token));
  assert.equal(today.status, 200);
  assert.equal(today.body.distanceMeters, 0, 'today has no fixes of its own');
});

test('the manager can replace a forgotten password, and every old session dies with it', async () => {
  const engineer = await freshRep('forgot');
  // A second device, so "all sessions" is a real claim and not just the token we hold.
  const secondDevice = await login(request(app), engineer.email, 'FreshPassword123!');

  // A representative must not be able to do this to anybody, including themselves.
  const forbidden = await rep.post(`/api/reps/${engineer.id}/password`).set(auth(engineer.token)).send({ password: 'AnotherPassword123!' });
  assert.equal(forbidden.status, 403);
  const tooShort = await admin.post(`/api/reps/${engineer.id}/password`).set(auth(adminToken)).send({ password: 'short' });
  assert.equal(tooShort.status, 400);

  const changed = await admin.post(`/api/reps/${engineer.id}/password`).set(auth(adminToken)).send({ password: 'BrandNewPassword123!' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  assert.equal((await request(app).get('/api/auth/me').set(auth(engineer.token))).status, 401);
  assert.equal((await request(app).get('/api/auth/me').set(auth(secondDevice.body.token))).status, 401);
  const withOldPassword = await request(app).post('/api/auth/login').send({ email: engineer.email, password: 'FreshPassword123!' });
  assert.equal(withOldPassword.status, 401);
  const fresh = await login(request(app), engineer.email, 'BrandNewPassword123!');
  assert.equal(fresh.body.user.id, engineer.id);
});

test('a second daily report for the same day is refused instead of counted twice', async () => {
  const engineer = await freshRep('onereport');
  const today = localDate(config.timezone);
  const payload = (id: string) => ({
    version: 1, id, engineerName: 'مهندس اختبار', reportDate: today, leftAt: '08:00', returnedAt: '16:00',
    circumstances: '', signedName: 'مهندس اختبار', confirmed: true, location: null,
    visits: [{ customerName: 'مزرعة النور', governorate: '', district: '', village: '', phone: '', areaFeddan: null, crops: '', recommendations: '', outcome: '' }],
  });
  const first = await request(app).post('/api/daily-reports').set(auth(engineer.token)).send(payload(crypto.randomUUID()));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await request(app).post('/api/daily-reports').set(auth(engineer.token)).send(payload(crypto.randomUUID()));
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.code, 'DAILY_REPORT_EXISTS');
  assert.equal(second.body.reportId, first.body.report.id);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM daily_reports WHERE user_id=?', engineer.id)!.c, 1);
});

test('a phone whose clock runs fast keeps its fixes instead of losing the day', async () => {
  const engineer = await freshRep('skew');
  const started = await request(app).post('/api/shifts/start').set(auth(engineer.token))
    .send({ consentVersion: '1.0', deviceId: 'skew-device', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const shiftId = started.body.shift.id as string;
  // An hour into the shift, as in the field, so the corrected fixes land inside it.
  store.run('UPDATE shifts SET started_at=? WHERE id=?', Date.now() - 3600000, shiftId);

  // Five minutes ahead: the old check refused the whole batch, so the trail vanished.
  const ahead = Date.now() + 5 * 60000;
  const points = [0, 1, 2].map(index => ({
    id: crypto.randomUUID(), shiftId, lat: 31.2 + index * 0.0002, lng: 29.9, accuracy: 6,
    speed: 3, heading: 90, battery: 70, recordedAt: ahead + index * 10000,
  }));
  const accepted = await request(app).post('/api/locations').set(auth(engineer.token)).send({ points });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.accepted, 3);
  const stored = store.get('SELECT MAX(recorded_at) AS at FROM locations WHERE user_id=?', engineer.id)!;
  assert.ok(Number(stored.at) <= Date.now(), 'a fix from the future must be stored in the past');
  // The spacing between the three fixes survives the correction, so distance still works.
  const ids = points.map(point => point.id);
  const spans = store.all('SELECT recorded_at AS at FROM locations WHERE point_id IN (?,?,?) ORDER BY recorded_at', ...ids)
    .map((row: any) => Number(row.at));
  assert.equal(spans.length, 3);
  assert.deepEqual([spans[1] - spans[0], spans[2] - spans[1]], [10000, 10000]);

  // A clock that is hours off is still refused, with an explanation instead of silence.
  const absurd = await request(app).post('/api/locations').set(auth(engineer.token)).send({
    points: [{ ...points[0], id: crypto.randomUUID(), recordedAt: Date.now() + 6 * 3600000 }],
  });
  assert.equal(absurd.status, 422);
  assert.equal(absurd.body.code, 'CLOCK_SKEW');
});

test('each new engineer gets a distinct colour so the live map stays readable', async () => {
  const first = await freshRep('colour-one');
  const second = await freshRep('colour-two');
  const colors = store.all("SELECT color FROM users WHERE id IN (?,?)", first.id, second.id).map((row: any) => String(row.color));
  assert.equal(colors.length, 2);
  assert.notEqual(colors[0], colors[1]);
});

test('engineers who shared the old default colour get their own on the next start', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../src/db.js');
  const dir = mkdtempSync(join(tmpdir(), 'elhelp-colour-'));
  const file = join(dir, 'legacy.db');
  const legacy = new Store(file);
  for (const [index, id] of ['r1', 'r2', 'r3'].entries()) {
    legacy.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
      id, `مهندس ${index + 1}`, `${id}@mandoub.test`, 'salt:hash', 'rep', index + 1);
  }
  legacy.close();
  const upgraded = new Store(file);
  const colors = upgraded.all("SELECT color FROM users WHERE role='rep' ORDER BY created_at").map(row => String(row.color));
  assert.equal(colors.length, 3);
  assert.equal(new Set(colors).size, 3, `colours must be distinct, got ${colors.join(',')}`);
  // Running again must not shuffle them a second time.
  upgraded.close();
  const again = new Store(file);
  const after = again.all("SELECT color FROM users WHERE role='rep' ORDER BY created_at").map(row => String(row.color));
  assert.deepEqual(after, colors);
  again.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a report range longer than a year is refused instead of stalling the server', async () => {
  const tooWide = await admin.get('/api/kpis?from=2020-01-01&to=2026-01-01').set(auth(adminToken));
  assert.equal(tooWide.status, 400);
  assert.equal(tooWide.body.code, 'RANGE_TOO_LARGE');
  assert.equal((await admin.get('/api/kpis.csv?from=2020-01-01&to=2026-01-01').set(auth(adminToken))).status, 400);
  assert.equal((await admin.get('/api/kpis.xlsx?from=2020-01-01&to=2026-01-01').set(auth(adminToken))).status, 400);
  // A full year is still allowed: that is exactly what the register may ask for.
  const oneYear = await admin.get('/api/kpis?from=2025-01-01&to=2025-12-31').set(auth(adminToken));
  assert.equal(oneYear.status, 200, JSON.stringify(oneYear.body));
});

test('a fix taken right at the shift start is still accepted', async () => {
  // The app stamps the first fix at the shift start itself; correcting clock drift must never
  // push that fix before the shift and drop the batch (this is how the browser suite seeds).
  const engineer = await freshRep('boundary');
  const started = await request(app).post('/api/shifts/start').set(auth(engineer.token))
    .send({ consentVersion: '1.0', deviceId: 'boundary-device', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const shift = started.body.shift;
  const points = [0, 1, 2, 3].map(step => ({
    id: crypto.randomUUID(), shiftId: shift.id, lat: 31.2001 + step * 0.0008, lng: 29.9187 + step * 0.0011,
    accuracy: 10 + step, speed: 3.4, heading: 90, battery: 80, recordedAt: Number(shift.started_at) + step * 1000,
  }));
  const res = await request(app).post('/api/locations').set(auth(engineer.token)).send({ points });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.accepted, 4);
});

test("a representative's visit list is today's field log, not every visit ever", async () => {
  const engineer = await freshRep('visitlog');
  const started = await request(app).post('/api/shifts/start').set(auth(engineer.token))
    .send({ consentVersion: '1.0', deviceId: 'visitlog-device', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const older = crypto.randomUUID();
  const visit = await request(app).post('/api/visits/check-in').set(auth(engineer.token))
    .send({ id: older, customerName: 'مزرعة الأمس', purpose: 'visit', location: { lat: 31.2, lng: 29.9, accuracy: 9 } });
  assert.equal(visit.status, 201, JSON.stringify(visit.body));
  // Closed with a real result, so it is a finished visit of yesterday and not one of the two
  // exceptions the engineer's list legitimately carries (still open, or missing its result).
  const closed = await request(app).post(`/api/visits/${older}/check-out`).set(auth(engineer.token))
    .send({ outcome: 'اتقفلت امبارح', notes: '', amount: null, location: null });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const yesterday = localDate(config.timezone, Date.now() - 86400000);
  const bounds = dayBounds(yesterday, config.timezone);
  store.run('UPDATE visits SET checked_in_at=?, checked_out_at=?, created_at=? WHERE id=?',
    bounds.start + 3600000, bounds.start + 7200000, bounds.start + 3600000, older);

  const today = await request(app).get('/api/visits').set(auth(engineer.token));
  assert.equal(today.status, 200);
  assert.equal(today.body.visits.length, 0, 'yesterday\'s finished visit must not count as today\'s');
  const past = await request(app).get(`/api/visits?date=${yesterday}`).set(auth(engineer.token));
  assert.equal(past.status, 200);
  assert.equal(past.body.visits.length, 1);
  assert.equal(past.body.visits[0].id, older);
});

test('a shift left open by a killed app is closed instead of showing the engineer at work for days', async () => {
  const engineer = await freshRep('stale');
  const started = await request(app).post('/api/shifts/start').set(auth(engineer.token))
    .send({ consentVersion: '1.0', deviceId: 'stale-device', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const shiftId = started.body.shift.id as string;
  // Two days old, last fix two days ago: the app was killed, nothing ever ended the shift.
  const old = Date.now() - 2 * 86400000;
  store.run('UPDATE shifts SET started_at=? WHERE id=?', old, shiftId);
  store.run('UPDATE locations SET recorded_at=? WHERE shift_id=?', old + 3600000, shiftId);
  store.cleanup(config.retentionDays);
  const closed = store.get('SELECT ended_at FROM shifts WHERE id=?', shiftId)!;
  assert.ok(Number(closed.ended_at) > 0, 'the stale shift must be closed');
  assert.ok(Number(closed.ended_at) <= old + 3600001);

  // A shift that is genuinely running right now must be left alone.
  const running = await request(app).post('/api/shifts/start').set(auth(engineer.token))
    .send({ consentVersion: '1.0', deviceId: 'stale-device', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(running.status, 200);
  store.cleanup(config.retentionDays);
  assert.equal(store.get('SELECT ended_at FROM shifts WHERE id=?', running.body.shift.id)!.ended_at, null);
});

test('old unreviewed reports stay reachable beyond the feed limit', async () => {
  const engineer = await freshRep('backlog');
  const base = Date.now() - 400 * 3600000;
  store.transaction(() => {
    for (let index = 0; index < 305; index += 1) {
      store.run('INSERT INTO reports(id,user_id,type,title,status,created_at) VALUES (?,?,?,?,?,?)',
        `backlog-${index}`, engineer.id, 'note', `تقرير ${index}`, index < 5 ? 'new' : 'reviewed', base + index * 60000);
    }
  });
  const list = await request(app).get('/api/reports').set(auth(adminToken));
  assert.equal(list.status, 200);
  assert.equal(list.body.reports.length, 300);
  const ids = list.body.reports.map((report: any) => report.id);
  assert.ok(ids.includes('backlog-0'), 'the oldest unreviewed report must still be listed');
  assert.equal(list.body.reports[0].status, 'new');
});

test('the account-deletion page is public, Arabic and says what gets erased', async () => {
  const res = await request(app).get('/delete-account');
  assert.equal(res.status, 200, String(res.text).slice(0, 120));
  assert.match(String(res.headers['content-type']), /text\/html/);
  assert.match(res.text, /dir="rtl"/);
  assert.match(res.text, /com\.elhelb\.mandoub/);
  assert.match(res.text, /mailto:/, 'there must be a way to start the request without the app');
  assert.match(res.text, /إيه اللي بيتمسح/);
  assert.ok(res.text.includes(`${config.retentionDays} يومًا`), 'the page must quote the real retention period');

  const privacy = await request(app).get('/privacy');
  assert.match(privacy.text, /href="\/delete-account"/, 'the policy links to the deletion page');
});

test("a representative's day summary carries the retention period the UI prints", async () => {
  const engineer = await freshRep('retention');
  const res = await request(app).get('/api/me/summary').set(auth(engineer.token));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.retentionDays, config.retentionDays);
});

/* ── Sign in with Google / Apple ────────────────────────────────────────────────
   The key source is replaced with a keypair generated here, so verification runs for real
   (signature, issuer, audience, expiry) without a network call to Google. */
const providerKeys = (() => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const kid = 'test-key';
  const sign = (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signer = createSign('RSA-SHA256');
    signer.update(`${head}.${body}`);
    return `${head}.${body}.${signer.sign(privateKey).toString('base64url')}`;
  };
  return { jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }, sign };
})();

const googleClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: 'google-ios-client',
  sub: 'google-sub-1',
  email: 'rep@mandoub.test',
  email_verified: true,
  exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000) - 10,
  ...overrides,
});

test('Google sign-in only works for an account the manager already created', async () => {
  setKeySource(async () => [providerKeys.jwk as never]);
  try {
    const created = await admin.post('/api/reps').set(auth(adminToken))
      .send({ name: 'مهندس جوجل', email: 'gmail.signer@mandoub.test', password: 'FreshPassword123!' });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const ok = await request(app).post('/api/auth/oauth')
      .send({ provider: 'google', idToken: providerKeys.sign(googleClaims({ email: 'gmail.signer@mandoub.test' })) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.user.email, 'gmail.signer@mandoub.test');
    assert.ok(String(ok.body.token).length > 20);
    const me = await request(app).get('/api/auth/me').set({ 'x-mandoub-token': ok.body.token });
    assert.equal(me.status, 200);
    // The link is stored, so the next sign-in matches on `sub` even without an email.
    const row = store.get('SELECT oauth_provider, oauth_subject FROM users WHERE email=?', 'gmail.signer@mandoub.test')!;
    assert.equal(row.oauth_provider, 'google');
    assert.equal(row.oauth_subject, 'google-sub-1');

    const stranger = await request(app).post('/api/auth/oauth')
      .send({ provider: 'google', idToken: providerKeys.sign(googleClaims({ email: 'stranger@gmail.com', sub: 'google-sub-9' })) });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.code, 'ACCOUNT_NOT_FOUND');
  } finally {
    setKeySource(null);
  }
});

test('a Google/Apple token is refused when it is expired, replayed for another app or unsigned', async () => {
  setKeySource(async () => [providerKeys.jwk as never]);
  try {
    const post = (idToken: string, provider: 'google' | 'apple' = 'google') =>
      request(app).post('/api/auth/oauth').send({ provider, idToken });

    const expired = await post(providerKeys.sign(googleClaims({ exp: Math.floor(Date.now() / 1000) - 3600 })));
    assert.equal(expired.status, 401, JSON.stringify(expired.body));

    const otherApp = await post(providerKeys.sign(googleClaims({ aud: 'some-other-client' })));
    assert.equal(otherApp.status, 401, JSON.stringify(otherApp.body));

    const wrongIssuer = await post(providerKeys.sign(googleClaims({ iss: 'https://evil.example' })));
    assert.equal(wrongIssuer.status, 401);

    const unsigned = await post(providerKeys.sign(googleClaims(), { alg: 'none' }).replace(/[^.]*$/, ''));
    assert.equal(unsigned.status, 401, 'alg=none must never be accepted');

    const tampered = await post(providerKeys.sign(googleClaims({ email: 'x@y.z' })).replace(/\.[^.]+$/, '.AAAA'));
    assert.equal(tampered.status, 401);

    const notOurs = await post('a'.repeat(60));
    assert.equal(notOurs.status, 401);
  } finally {
    setKeySource(null);
  }
});

test('Apple signs in on the stored link even when it stops sending the email', async () => {
  setKeySource(async () => [providerKeys.jwk as never]);
  try {
    const created = await admin.post('/api/reps').set(auth(adminToken))
      .send({ name: 'مهندس أبل', email: 'apple.signer@mandoub.test', password: 'FreshPassword123!' });
    assert.equal(created.status, 201);

    const appleClaims = (overrides: Record<string, unknown> = {}) => ({
      iss: 'https://appleid.apple.com',
      aud: 'com.elhelb.mandoub',
      sub: 'apple-sub-1',
      email: 'apple.signer@mandoub.test',
      email_verified: 'true',
      exp: Math.floor(Date.now() / 1000) + 600,
      iat: Math.floor(Date.now() / 1000) - 5,
      ...overrides,
    });

    const first = await request(app).post('/api/auth/oauth')
      .send({ provider: 'apple', idToken: providerKeys.sign(appleClaims()), name: 'مهندس أبل' });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    // Apple only sends the address on the first authorization; later tokens carry just `sub`.
    const second = await request(app).post('/api/auth/oauth')
      .send({ provider: 'apple', idToken: providerKeys.sign(appleClaims({ email: undefined })) });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.user.email, 'apple.signer@mandoub.test');

    // A Google token presented as an Apple one must not slip through.
    const crossed = await request(app).post('/api/auth/oauth')
      .send({ provider: 'apple', idToken: providerKeys.sign(googleClaims({ aud: 'com.elhelb.mandoub' })) });
    assert.equal(crossed.status, 401);
  } finally {
    setKeySource(null);
  }
});

test('the app is told which social sign-ins the server can verify', async () => {
  const res = await request(app).get('/api/auth/providers');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { google: true, apple: true });
});

test('the first phone to start a shift owns the account, and the agent refresh exposes no paths', async () => {
  const engineer = await freshRep('device');
  const start = (deviceId: string) => request(app).post('/api/shifts/start').set(auth(engineer.token))
    .send({ consentVersion: '1.0', deviceId, location: { lat: 31.2, lng: 29.9, accuracy: 8 } });

  const first = await start('phone-one');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(store.get('SELECT device_id FROM users WHERE id=?', engineer.id)!.device_id, 'phone-one');

  const second = await start('phone-two');
  assert.equal(second.status, 403);
  assert.equal(second.body.code, 'DEVICE_MISMATCH');
  assert.equal(store.get('SELECT device_id FROM users WHERE id=?', engineer.id)!.device_id, 'phone-one',
    'a second phone must never take the binding over');

  const refresh = await request(app).post('/api/agent/refresh').set(auth(adminToken));
  assert.equal(refresh.status, 200, JSON.stringify(refresh.body));
  for (const skill of refresh.body.skills as Array<Record<string, unknown>>) {
    assert.deepEqual(Object.keys(skill).sort(), ['description', 'id', 'name'],
      'skill files carry a body and an absolute path; neither belongs in an API response');
  }
});

test('the overview carries the join date the team page prints', async () => {
  const engineer = await freshRep('joindate');
  const res = await request(app).get('/api/overview').set(auth(adminToken));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = (res.body.reps as Array<Record<string, unknown>>).find(rep => rep.id === engineer.id);
  assert.ok(row, 'the new engineer must be in the overview');
  assert.equal(typeof row.createdAt, 'number');
  assert.ok(Number(row.createdAt) > Date.now() - 600000, 'the join date is the creation time, not null');
});
