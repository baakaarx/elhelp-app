import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { sendLocationChunks } from '../../mobile/src/locationQueue.js';
import type { GeoPoint } from '../../mobile/src/types.js';

/**
 * A phone whose clock runs more than ten minutes fast is refused by every endpoint that
 * carries a timestamp. The server says exactly that with `code: 'CLOCK_SKEW'`, but the app
 * treated the rejection like a corrupt fix: it split the batch in half until each single point
 * failed on its own, then deleted it. The engineer's whole track disappeared and the only
 * message that could have fixed it never reached the screen.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@mandoub.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  staleGpsMinutes: 10,
};
const instance = createApp(config);
const { app } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

test('a fast-clock rejection keeps every fix instead of deleting them', async () => {
  const points = ['a', 'b', 'c', 'd'].map(id => ({ id } as GeoPoint));
  const removed: string[] = [];
  const send = async () => { throw Object.assign(new Error('ساعة الهاتف متقدمة'), { status: 422, code: 'CLOCK_SKEW' }); };
  await assert.rejects(
    () => sendLocationChunks(points, send, async id => { removed.push(id); }),
    (error: { code?: string }) => error.code === 'CLOCK_SKEW',
    'the clock message must reach the caller',
  );
  assert.deepEqual(removed, [], 'nothing may be deleted while the clock is wrong');
});

test('a corrupt fix is still isolated and removed', async () => {
  const points = ['good-1', 'bad', 'good-2'].map(id => ({ id } as GeoPoint));
  const sent: string[] = [], removed: string[] = [];
  const count = await sendLocationChunks(points, async chunk => {
    // No `code`: this is a genuinely invalid point, not a clock problem.
    if (chunk.some(point => point.id === 'bad')) throw { status: 422 };
    sent.push(...chunk.map(point => point.id));
  }, async id => { removed.push(id); });
  assert.deepEqual(sent, ['good-1', 'good-2']);
  assert.deepEqual(removed, ['good-1', 'bad', 'good-2']);
  assert.equal(count, 2);
});

test('the server answers a fast clock with a code the app can read', async () => {
  const admin = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
  assert.equal(admin.status, 200);
  await client.post('/api/reps').set('Authorization', `Bearer ${admin.body.token}`)
    .send({ name: 'مهندس ساعة', email: 'clock@mandoub.test', password: 'RepPassword123!' });
  const login = await client.post('/api/auth/login').send({ email: 'clock@mandoub.test', password: 'RepPassword123!' });
  const token = login.body.token as string;
  const started = await client.post('/api/shifts/start').set('Authorization', `Bearer ${token}`)
    .send({ consentVersion: '1.0', deviceId: 'clock-device', deviceName: 'تحقق', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const shiftId = started.body.shift.id as string;
  const point = (recordedAt: number) => ({
    id: randomUUID(), shiftId, lat: 31.2, lng: 29.9, accuracy: 8, speed: 0, heading: null, battery: null, recordedAt,
  });

  const future = await client.post('/api/locations').set('Authorization', `Bearer ${token}`)
    .send({ points: [point(Date.now() + 45 * 60000)] });
  assert.equal(future.status, 422);
  assert.equal(future.body.code, 'CLOCK_SKEW');
  assert.match(future.body.error, /الوقت التلقائي/);
  assert.equal(future.body.skewMinutes, 45, 'the app tells the engineer how far off the clock is');

  // Recorded "now", not before the shift started: a fix older than the shift is dropped for a
  // different (and correct) reason, which would hide what this test is checking.
  const honest = await client.post('/api/locations').set('Authorization', `Bearer ${token}`)
    .send({ points: [point(Date.now())] });
  assert.equal(honest.status, 200, JSON.stringify(honest.body));
  assert.equal(honest.body.accepted, 1, 'an honest timestamp is stored');
});
