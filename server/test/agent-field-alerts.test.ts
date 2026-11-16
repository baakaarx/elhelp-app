import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { fieldAlerts } from '../src/agent/tasks/fieldAlerts.js';

/**
 * The "no visits" field alert used to count check-ins over a rolling 24 hours. A visit
 * recorded yesterday evening therefore silenced the alert for a shift that opened this
 * morning and had not produced a single visit yet. The window is now the current shift.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 30, timezone: 'Africa/Cairo',
  adminEmail: 'admin@mandoub.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  staleGpsMinutes: 10,
};
const instance = createApp(config);
const { store } = instance;
test.after(async () => { await instance.close(); });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function addRep(name: string) {
  const id = randomUUID();
  store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
    id, name, `${id.slice(0, 8)}@mandoub.test`, hashPassword('Rep1234!'), 'rep', Date.now() - 30 * 24 * HOUR);
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
function addVisit(userId: string, checkedInAt: number, customer: string) {
  store.run("INSERT INTO visits(id,user_id,customer_name,purpose,status,checked_in_at,created_at) VALUES (?,?,?,'visit','open',?,?)",
    randomUUID(), userId, customer, checkedInAt, checkedInAt);
}

function codesFor(repId: string) {
  const result = fieldAlerts(store, { timezone: config.timezone });
  return (result.details.alerts as Array<{ repId: string; code: string }>)
    .filter(a => a.repId === repId)
    .map(a => a.code);
}

test("yesterday's visit does not excuse a shift with no visits", () => {
  const repId = addRep('سالي إبراهيم');
  const shiftId = addShift(repId, Date.now() - 3 * HOUR);
  addPoint(repId, shiftId, Date.now() - MINUTE); // fresh signal: only the missing visit is wrong
  addVisit(repId, Date.now() - 20 * HOUR, 'مزرعة النور'); // inside the old 24h window, before this shift

  const codes = codesFor(repId);
  assert.ok(codes.includes('no_visits'), `expected no_visits, got ${codes.join(',') || 'nothing'}`);
});

test('a visit during the current shift keeps the alert quiet', () => {
  const repId = addRep('منى سعيد');
  const shiftId = addShift(repId, Date.now() - 3 * HOUR);
  addPoint(repId, shiftId, Date.now() - MINUTE);
  addVisit(repId, Date.now() - 2 * HOUR, 'مزرعة الدلتا'); // after the shift started

  const codes = codesFor(repId);
  assert.ok(!codes.includes('no_visits'), `no_visits must not fire, got ${codes.join(',') || 'nothing'}`);
});

test('a shift younger than an hour is not reported yet', () => {
  const repId = addRep('كريم فتحي');
  const shiftId = addShift(repId, Date.now() - 10 * MINUTE);
  addPoint(repId, shiftId, Date.now() - MINUTE);

  const codes = codesFor(repId);
  assert.ok(!codes.includes('no_visits'), 'ten minutes into a shift is too early to complain');
});
