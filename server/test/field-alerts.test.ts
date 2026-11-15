import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { readConfig } from '../src/config.js';

/**
 * Manager-facing field alerts.
 *
 * Two blind spots motivated these tests: an engineer could leave a visit open for a whole
 * day without anyone noticing, and a stillness justification sent from the phone changed the
 * alert list but was invisible — the reason itself never reached the dashboard.
 */
const config = {
  dbPath: ':memory:', demo: false, production: false, retentionDays: 30, timezone: 'Africa/Cairo',
  adminEmail: 'admin@mandoub.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  staleGpsMinutes: 10,
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

const MINUTE = 60_000;

async function adminToken() {
  const res = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token as string;
}

function addRep(name: string, email: string) {
  const id = randomUUID();
  store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
    id, name, email, hashPassword('Rep1234!'), 'rep', Date.now());
  return id;
}
function addShift(userId: string, startedAt: number) {
  const id = randomUUID();
  store.run('INSERT INTO shifts(id,user_id,started_at,consent_version,consent_at) VALUES (?,?,?,?,?)',
    id, userId, startedAt, '1.0', startedAt);
  return id;
}
function addPoint(userId: string, shiftId: string, recordedAt: number) {
  store.run(`INSERT INTO locations(point_id,user_id,shift_id,lat,lng,accuracy,speed,recorded_at,received_at,source)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, randomUUID(), userId, shiftId, 31.24, 29.96, 12, 0, recordedAt, recordedAt, 'gps');
}
function addOpenVisit(userId: string, checkedInAt: number, customer: string) {
  const id = randomUUID();
  store.run("INSERT INTO visits(id,user_id,customer_name,purpose,status,checked_in_at,created_at) VALUES (?,?,?,'visit','open',?,?)",
    id, userId, customer, checkedInAt, checkedInAt);
  return id;
}
const alertsFor = async (token: string) => {
  const res = await client.get('/api/alerts').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.alerts as Array<{ repId?: string; code: string; detail: string; level: string }>;
};

const token = await adminToken();

test('a visit left open for hours reaches the alert list', async () => {
  const repId = addRep('سالي إبراهيم', `sally.${Date.now()}@mandoub.test`);
  const shiftId = addShift(repId, Date.now() - 6 * 60 * MINUTE);
  addPoint(repId, shiftId, Date.now() - MINUTE); // fresh signal: only the visit is wrong
  addOpenVisit(repId, Date.now() - 4 * 60 * MINUTE, 'مزرعة النور');

  const alerts = (await alertsFor(token)).filter(a => a.repId === repId);
  const openAlert = alerts.find(a => a.code === 'long_open_visit');
  assert.ok(openAlert, `expected long_open_visit, got ${alerts.map(a => a.code).join(',')}`);
  assert.equal(openAlert!.level, 'warn');
  assert.match(openAlert!.detail, /مزرعة النور/);
  assert.match(openAlert!.detail, /4 ساعات/);
});

test('an open visit with a closed shift is reported separately', async () => {
  const repId = addRep('كريم فتحي', `karim.${Date.now()}@mandoub.test`);
  addOpenVisit(repId, Date.now() - 30 * MINUTE, 'مزرعة الدلتا');

  const alerts = (await alertsFor(token)).filter(a => a.repId === repId);
  const codes = alerts.map(a => a.code);
  assert.ok(codes.includes('open_visit_without_shift'), codes.join(','));
  assert.ok(!codes.includes('long_open_visit'), 'a 30-minute visit is not "too long" yet');
});

test('the stale-signal threshold is the configured one, not a magic number', async () => {
  const freshRep = addRep('منى سعيد', `mona.${Date.now()}@mandoub.test`);
  const freshShift = addShift(freshRep, Date.now() - 2 * 60 * MINUTE);
  addPoint(freshRep, freshShift, Date.now() - 6 * MINUTE);

  const staleRep = addRep('طارق علي', `tarek.${Date.now()}@mandoub.test`);
  const staleShift = addShift(staleRep, Date.now() - 3 * 60 * MINUTE);
  addPoint(staleRep, staleShift, Date.now() - 11 * MINUTE);

  const alerts = await alertsFor(token);
  assert.ok(!alerts.some(a => a.repId === freshRep && a.code === 'stale_gps'), '6 minutes is inside the 10-minute window');
  const stale = alerts.find(a => a.repId === staleRep && a.code === 'stale_gps');
  assert.ok(stale, '11 minutes without a point must raise stale_gps');
  assert.match(stale!.detail, /حد التنبيه 10 دقيقة/);
});

test('a lower configured threshold flags the same engineer earlier', async () => {
  const strict = createApp({ ...config, dbPath: ':memory:', staleGpsMinutes: 5 });
  const strictClient = request(strict.app);
  try {
    const login = await strictClient.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
    const repId = randomUUID();
    strict.store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
      repId, 'حسناء يوسف', `hanna.${Date.now()}@mandoub.test`, hashPassword('Rep1234!'), 'rep', Date.now());
    const shiftId = randomUUID();
    strict.store.run('INSERT INTO shifts(id,user_id,started_at,consent_version,consent_at) VALUES (?,?,?,?,?)',
      shiftId, repId, Date.now() - 60 * MINUTE, '1.0', Date.now() - 60 * MINUTE);
    strict.store.run(`INSERT INTO locations(point_id,user_id,shift_id,lat,lng,accuracy,speed,recorded_at,received_at,source)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, randomUUID(), repId, shiftId, 30.1, 31.3, 9, 0, Date.now() - 6 * MINUTE, Date.now() - 6 * MINUTE, 'gps');

    const res = await strictClient.get('/api/alerts').set('Authorization', `Bearer ${login.body.token}`);
    const stale = (res.body.alerts as Array<{ repId?: string; code: string; detail: string }>)
      .find(a => a.repId === repId && a.code === 'stale_gps');
    assert.ok(stale, '6 minutes is stale when the threshold is 5');
    assert.match(stale!.detail, /حد التنبيه 5 دقيقة/);

    const overview = await strictClient.get('/api/overview').set('Authorization', `Bearer ${login.body.token}`);
    assert.equal(overview.body.staleGpsMinutes, 5, 'the dashboard must receive the same threshold');
  } finally {
    await strict.close();
  }
});

test('stillness justifications are readable by the manager, with the reason and the name', async () => {
  const repId = addRep('وليد شعبان', `walid.${Date.now()}@mandoub.test`);
  const shiftId = addShift(repId, Date.now() - 3 * 60 * MINUTE);
  store.run(`INSERT INTO idle_reports(id,user_id,shift_id,lat,lng,accuracy,reason,duration_minutes,device_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, randomUUID(), repId, shiftId, 31.2, 29.9, 15, 'انتظار مدير المزرعة', 75, 'device-abc', Date.now() - 10 * MINUTE);

  const res = await client.get('/api/idle-reports').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const mine = (res.body.reports as Array<{ userId: string; repName: string; reason: string; durationMinutes: number }>)
    .find(r => r.userId === repId);
  assert.ok(mine, 'the manager must see the justification, not just a vanished alert');
  assert.equal(mine!.reason, 'انتظار مدير المزرعة');
  assert.equal(mine!.durationMinutes, 75);
  assert.equal(mine!.repName, 'وليد شعبان');
});

test('a representative only sees his own justifications', async () => {
  const repId = addRep('إيمان مصطفى', `eman.${Date.now()}@mandoub.test`);
  const otherId = addRep('عادل حسن', `adel.${Date.now()}@mandoub.test`);
  const email = `eman.login.${Date.now()}@mandoub.test`;
  store.run('UPDATE users SET email=? WHERE id=?', email, repId);
  for (const id of [repId, otherId]) {
    store.run(`INSERT INTO idle_reports(id,user_id,lat,lng,accuracy,reason,duration_minutes,device_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, randomUUID(), id, 31.2, 29.9, 20, `سبب ${id.slice(0, 4)}`, 61, 'dev', Date.now());
  }
  const login = await client.post('/api/auth/login').send({ email, password: 'Rep1234!' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const res = await client.get('/api/idle-reports').set('Authorization', `Bearer ${login.body.token}`);
  assert.equal(res.status, 200);
  assert.deepEqual((res.body.reports as Array<{ userId: string }>).map(r => r.userId), [repId]);
});

test('the configuration rejects a nonsense staleness window', () => {
  const previous = process.env.STALE_GPS_MINUTES;
  try {
    process.env.STALE_GPS_MINUTES = '1';
    assert.throws(() => readConfig(), /STALE_GPS_MINUTES/);
  } finally {
    if (previous === undefined) delete process.env.STALE_GPS_MINUTES;
    else process.env.STALE_GPS_MINUTES = previous;
  }
});
