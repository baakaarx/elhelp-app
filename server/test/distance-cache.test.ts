import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { tokenHash } from '../src/auth.js';
import { dayBounds, localDate } from '../src/geo.js';

const DAY = 86400000;
const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@distance-cache.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  privacyContact: 'privacy@distance-cache.test', trustProxy: false,
  staleGpsMinutes: 10, idleReasonMinutes: 60,
  loginAccountLimit: 10, loginRateLimit: { windowMs: 60000, limit: 1000 },
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  store.run('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)',
    tokenHash(token), userId, now + 3600000, now);
  return token;
}

const adminId = String(store.get('SELECT id FROM users WHERE email=?', config.adminEmail)?.id || '');
assert.ok(adminId, 'createApp initializes the configured administrator');
const adminToken = session(adminId);
const repId = randomUUID();
store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
  repId, 'مهندس المسافة', 'rep@distance-cache.test', 'unused', 'rep', Date.now());
const repToken = session(repId);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function stableCachedDate(): string {
  const now = Date.now();
  for (let daysAgo = 2; daysAgo <= 30; daysAgo++) {
    const date = localDate(config.timezone, now - daysAgo * DAY);
    const bounds = dayBounds(date, config.timezone);
    if (bounds.end - bounds.start === DAY && bounds.end < now - 6 * 60000) return date;
  }
  throw new Error('could not find a complete, cacheable 24-hour day');
}

function seedPoint(shiftId: string, lat: number, recordedAt: number) {
  const now = Date.now();
  store.run(`INSERT INTO locations(point_id,user_id,shift_id,lat,lng,accuracy,speed,heading,battery,recorded_at,received_at,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'gps')`, randomUUID(), repId, shiftId, lat, 29.9, 8, 2, 90, 80, recordedAt, now);
}

async function kpiRange(from: string, to: string) {
  const res = await client.get(`/api/kpis?from=${from}&to=${to}`).set(auth(adminToken));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = (res.body.rows as Array<{ repId: string; pointCount: number; distanceMeters: number }>)
    .find(item => item.repId === repId);
  assert.ok(row, 'the engineer appears in the KPI response');
  return row!;
}

function mostRecentLongLocalDay(): string {
  const now = Date.now();
  for (let daysAgo = 1; daysAgo <= 300; daysAgo++) {
    const date = localDate(config.timezone, now - daysAgo * DAY);
    const bounds = dayBounds(date, config.timezone);
    if (bounds.end - bounds.start === 25 * 3600000 && bounds.end < now - 60000) return date;
  }
  throw new Error('could not find a completed 25-hour local day in the retention window');
}

test('KPI distance follows Cairo calendar days through the 25-hour DST day', async () => {
  const date = mostRecentLongLocalDay();
  const bounds = dayBounds(date, config.timezone);
  const shiftId = randomUUID();
  store.run('INSERT INTO shifts(id,user_id,started_at,ended_at,consent_version,consent_at) VALUES (?,?,?,?,?,?)',
    shiftId, repId, bounds.start, bounds.end - 1000, '1.0', bounds.start);

  // Exactly across the erroneous start+24h cut: both points are still in the same 25-hour
  // Cairo date and the short, plausible leg must count once as a day, not be split in two.
  const t0 = bounds.start + 23 * 3600000 + 58 * 60000;
  seedPoint(shiftId, 31.2, t0);
  seedPoint(shiftId, 31.201, t0 + 4 * 60000);

  const row = await kpiRange(date, date);
  assert.equal(row.pointCount, 2);
  assert.ok(row.distanceMeters > 100, `the same-day leg was split at 24h: ${row.distanceMeters}m`);
});

test('late accepted GPS fixes refresh cached monthly distance and point totals', async () => {
  const date = stableCachedDate();
  const bounds = dayBounds(date, config.timezone);
  const nextDate = new Date(Date.parse(`${date}T00:00:00.000Z`) + DAY).toISOString().slice(0, 10);
  const shiftId = randomUUID();
  const shiftStart = bounds.start;
  const shiftEnd = bounds.end - 1000;
  const t0 = bounds.start + 6 * 3600000;
  store.run('INSERT INTO shifts(id,user_id,started_at,ended_at,consent_version,consent_at) VALUES (?,?,?,?,?,?)',
    shiftId, repId, shiftStart, shiftEnd, '1.0', shiftStart);
  seedPoint(shiftId, 31.2, t0);
  seedPoint(shiftId, 31.201, t0 + 60000);

  const first = await kpiRange(date, date);
  assert.equal(first.pointCount, 2);
  assert.ok(first.distanceMeters > 100, `expected measured movement, got ${first.distanceMeters}m`);

  // The outbox may deliver a valid fix after its day has already been cached. This also uses a
  // different KPI range below, so a passing result proves the day-distance cache itself changed,
  // not just the 30-second response cache.
  const pushed = await client.post('/api/locations').set(auth(repToken)).send({ points: [{
    id: randomUUID(), shiftId, lat: 31.202, lng: 29.9, accuracy: 8, speed: 2, heading: 90, battery: 80,
    recordedAt: t0 + 120000,
  }] });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
  assert.equal(pushed.body.accepted, 1);

  const expanded = await kpiRange(date, nextDate);
  assert.equal(expanded.pointCount, 3, 'the previously cached day must include the late fix');
  assert.ok(expanded.distanceMeters > first.distanceMeters, 'the extra leg must be counted');

  const sameRange = await kpiRange(date, date);
  assert.equal(sameRange.pointCount, 3, 'the response-level KPI cache must also refresh');
});
