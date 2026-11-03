import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { io as connectClient, type Socket } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { dayBounds } from '../src/geo.js';
import { dailyReportPdf } from '../src/dailyPdf.js';

const config = {
  dbPath: ':memory:', demo: true, production: false, retentionDays: 30, timezone: 'Africa/Cairo',
  adminEmail: 'admin@mandoub.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
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
let shiftId = '';
let reportId = '';
let dailyId = '';
const repEmail = `rep.${Date.now()}@mandoub.test`;
const pointId = () => crypto.randomUUID();
const now = () => Date.now();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(client: request.Agent, email: string, password: string) {
  const res = await client.post('/api/auth/login').send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res;
}

test('health endpoint reports demo mode and consent version', async () => {
  const res = await admin.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.demo, true);
  assert.equal(res.body.timezone, 'Africa/Cairo');
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
  assert.equal(res.body.demo, true);
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

test('a simulated demo account cannot start real GPS tracking', async () => {
  const demoUser = store.get("SELECT * FROM users WHERE is_demo=1 ORDER BY email LIMIT 1")!;
  const demoRep = request(app);
  const res = await demoRep.post('/api/auth/login').send({ email: demoUser.email, password: 'Demo1234!' });
  assert.equal(res.status, 200);
  const start = await request(app).post('/api/shifts/start').set(auth(res.body.token)).send({ consentVersion: '1.0', location: { lat: 31.2, lng: 29.9, accuracy: 10 }, deviceId: 'demo-device-001' });
  assert.equal(start.status, 403);
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

test('the representative cannot read another representative\'s route', async () => {
  const other = store.get("SELECT id FROM users WHERE is_demo=1 ORDER BY email LIMIT 1")!.id;
  const res = await rep.get(`/api/reps/${other}/route`).set(auth(repToken));
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
  assert.ok(list.body.reports.length > 1);
  assert.ok(list.body.reports.some((r: any) => r.repIsDemo === 1));
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
  const demoUser = store.get("SELECT * FROM users WHERE is_demo=1 ORDER BY email LIMIT 1")!;
  const loginRes = await request(app).post('/api/auth/login').send({ email: demoUser.email, password: 'Demo1234!' });
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
  const text = Buffer.from(res.body).toString('utf8').replace('\uFEFF', '');
  assert.match(text.split('\r\n')[0], /المهندس/);
  assert.ok(text.split('\r\n').length >= 2);
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