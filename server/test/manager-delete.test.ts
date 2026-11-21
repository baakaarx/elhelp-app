import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';

/**
 * The manager's delete buttons: one engineer account, one visit, one report, one signed day.
 *
 * These are the only destructive actions the dashboard offers, so the tests hold the three things
 * that matter about them: nothing happens without an explicit confirmation, the cascade really
 * removes the field data (and only that account's), and an engineer can never delete his own
 * record — the register is evidence, and the author is not the one who retires it.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 30, timezone: 'Africa/Cairo',
  adminEmail: 'admin@mandoub.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

async function adminToken() {
  const res = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token as string;
}
const admin = { Authorization: `Bearer ${await adminToken()}` };

function addRep(email: string) {
  const id = randomUUID();
  store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
    id, 'مهندس تجربة', email, hashPassword('Rep1234!'), 'rep', Date.now());
  return id;
}
const repTokenFor = async (email: string) => {
  const res = await client.post('/api/auth/login').send({ email, password: 'Rep1234!' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token as string;
};

/** One engineer with a shift, fixes, a visit and a report — a whole day of field data. */
function seedDay(userId: string) {
  const shiftId = randomUUID();
  const now = Date.now();
  store.run('INSERT INTO shifts(id,user_id,started_at,ended_at,consent_version,consent_at) VALUES (?,?,?,NULL,?,?)',
    shiftId, userId, now - 30 * 60000, '1.0', now - 30 * 60000);
  store.run(`INSERT INTO locations(point_id,user_id,shift_id,lat,lng,accuracy,speed,heading,battery,recorded_at,received_at,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'gps')`, randomUUID(), userId, shiftId, 31.2, 29.9, 8, 0, null, 60, now, now);
  const visitId = randomUUID();
  store.run("INSERT INTO visits(id,user_id,customer_name,purpose,status,checked_in_at,created_at) VALUES (?,?,'مزرعة التجربة','visit','open',?,?)",
    visitId, userId, now - 20 * 60000, now - 20 * 60000);
  const reportId = randomUUID();
  store.run(`INSERT INTO reports(id,user_id,shift_id,type,title,body,status,created_at)
    VALUES (?,?,?,'issue','مشكلة في الشبكة','—','new',?)`, reportId, userId, shiftId, now - 5 * 60000);
  const dailyId = randomUUID();
  store.run(`INSERT INTO daily_reports(id,user_id,shift_id,engineer_name,report_date,day_name,status,created_at,signed_name,signed_at)
    VALUES (?,?,?,'مهندس تجربة','2026-11-02','الاثنين','new',?,'مهندس تجربة',?)`,
    dailyId, userId, shiftId, now - 60000, now - 60000);
  store.run(`INSERT INTO daily_report_visits(id,report_id,position,customer_name) VALUES (?,?,?,'عميل اليوم')`,
    randomUUID(), dailyId, 1);
  return { shiftId, visitId, reportId, dailyId };
}

test('the impact count tells the manager what a delete would take', async () => {
  const repId = addRep(`impact.${Date.now()}@mandoub.test`);
  seedDay(repId);
  const res = await client.get(`/api/reps/${repId}/impact`).set(admin);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.shifts, 1);
  assert.equal(res.body.locations, 1);
  assert.equal(res.body.visits, 1);
  assert.equal(res.body.openVisits, 1);
  assert.equal(res.body.reports, 1);
  assert.equal(res.body.dailyReports, 1);
  assert.equal(res.body.trackingNow, true, 'an open shift has to be visible before it is closed by the delete');
  const missing = await client.get(`/api/reps/${randomUUID()}/impact`).set(admin);
  assert.equal(missing.status, 404);
});

test('a delete without the confirmation is refused, and nothing is lost', async () => {
  const repId = addRep(`unconfirmed.${Date.now()}@mandoub.test`);
  seedDay(repId);
  const res = await client.delete(`/api/reps/${repId}`).set(admin).send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CONFIRM_REQUIRED');
  assert.ok(store.get('SELECT id FROM users WHERE id=?', repId), 'the account is untouched');
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM visits WHERE user_id=?', repId)?.c), 1);
});

test('deleting an engineer takes his day with it, and leaves the rest of the team alone', async () => {
  const doomed = addRep(`doomed.${Date.now()}@mandoub.test`);
  const keeper = addRep(`keeper.${Date.now()}@mandoub.test`);
  seedDay(doomed);
  seedDay(keeper);
  // A session for the doomed engineer must not outlive him.
  const doomedEmail = String(store.get('SELECT email FROM users WHERE id=?', doomed)!.email);
  const login = await client.post('/api/auth/login').send({ email: doomedEmail, password: 'Rep1234!' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const doomedToken = login.body.token as string;

  const res = await client.delete(`/api/reps/${doomed}`).set(admin).send({ confirm: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(Number(res.body.removed.visits), 1);
  assert.equal(store.get('SELECT id FROM users WHERE id=?', doomed), undefined, 'the account is gone');
  for (const table of ['shifts', 'locations', 'visits', 'reports', 'daily_reports', 'daily_report_visits', 'sessions']) {
    const join = table === 'daily_report_visits'
      ? `SELECT COUNT(*) AS c FROM ${table} v JOIN daily_reports r ON r.id=v.report_id WHERE r.user_id=?`
      : table === 'sessions' ? `SELECT COUNT(*) AS c FROM ${table} WHERE user_id=?`
        : `SELECT COUNT(*) AS c FROM ${table} WHERE user_id=?`;
    assert.equal(Number(store.get(join, doomed)?.c), 0, `${table} must not outlive the account`);
  }
  const after = await client.get('/api/auth/me').set('Authorization', `Bearer ${doomedToken}`);
  assert.equal(after.status, 401, 'a stolen session stops working with the account');

  assert.ok(store.get('SELECT id FROM users WHERE id=?', keeper), 'the colleague is untouched');
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM visits WHERE user_id=?', keeper)?.c), 1);
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM locations WHERE user_id=?', keeper)?.c), 1);

  // The deletion itself stays auditable, without keeping his identity in the trail.
  const audit = store.get("SELECT metadata FROM audit_log WHERE action='rep.delete' ORDER BY id DESC LIMIT 1");
  assert.ok(audit, 'the audit row survives the cascade');
  assert.match(String(audit!.metadata), new RegExp(doomed.slice(0, 8)));
  const overview = await client.get('/api/overview').set(admin);
  assert.ok(!overview.body.reps.some((row: any) => row.id === doomed));
});

test('a manager account is not on the team page delete list', async () => {
  const adminId = String(store.get("SELECT id FROM users WHERE role='admin' LIMIT 1")!.id);
  const res = await client.delete(`/api/reps/${adminId}`).set(admin).send({ confirm: true });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NOT_A_REP');
  assert.ok(store.get('SELECT id FROM users WHERE id=?', adminId), 'the manager stays');
});

test('an engineer cannot delete his own visit, report or day', async () => {
  const email = `own.${Date.now()}@mandoub.test`;
  const repId = addRep(email);
  const { visitId, reportId, dailyId } = seedDay(repId);
  const token = await repTokenFor(email);

  const rows = [['/api/visits', 'visits', visitId], ['/api/reports', 'reports', reportId], ['/api/daily-reports', 'daily_reports', dailyId]] as const;
  for (const [path, table, id] of rows) {
    const res = await client.delete(`${path}/${id}`).set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 403, `${path}: the author is not the one who retires a record`);
    assert.ok(store.get(`SELECT id FROM ${table} WHERE id=?`, id), `${path}: the row is kept`);
  }
});

test('the manager can remove one visit, and the register stops counting it', async () => {
  const repId = addRep(`visit.${Date.now()}@mandoub.test`);
  const { visitId } = seedDay(repId);
  const res = await client.delete(`/api/visits/${visitId}`).set(admin);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.visit.customerName, 'مزرعة التجربة');
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM visits WHERE user_id=?', repId)?.c), 0);
  const list = await client.get('/api/visits').set(admin);
  assert.ok(!list.body.visits.some((row: any) => row.id === visitId));
  const gone = await client.delete(`/api/visits/${randomUUID()}`).set(admin);
  assert.equal(gone.status, 404);
});

test('deleting the day removes its visit rows and its signature', async () => {
  const repId = addRep(`daily.${Date.now()}@mandoub.test`);
  const { dailyId } = seedDay(repId);
  const res = await client.delete(`/api/daily-reports/${dailyId}`).set(admin);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM daily_report_visits WHERE report_id=?', dailyId)?.c), 0,
    'the paper rows go with the report they belong to');
  assert.equal(store.get('SELECT id FROM daily_reports WHERE id=?', dailyId), undefined);
});

test('deleting a report leaves the visit and the shift untouched', async () => {
  const repId = addRep(`report.${Date.now()}@mandoub.test`);
  const { reportId, visitId } = seedDay(repId);
  const res = await client.delete(`/api/reports/${reportId}`).set(admin);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(store.get('SELECT id FROM visits WHERE id=?', visitId), 'a report is not the visit');
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM shifts WHERE user_id=?', repId)?.c), 1);
});
