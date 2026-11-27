import assert from 'node:assert/strict';
import test from 'node:test';
import { movementStatus, STALE_FIX_MS } from '../../dashboard/src/locationStatus.js';
import type { Rep } from '../../dashboard/src/types.js';
import { sendLocationChunks } from '../../mobile/src/locationQueue.js';
import type { GeoPoint } from '../../mobile/src/types.js';

test('movement does not report a stale, weak or unavailable fix as moving or stopped', () => {
  const now = Date.now();
  const rep = { tracking: true, location: { recordedAt: now, accuracy: 10, speed: 0 } } as Rep;
  assert.match(movementStatus(rep, now), /واقف تقريبًا/);
  assert.match(movementStatus({ ...rep, location: { ...rep.location!, speed: 2 } }, now), /يتحرك تقريبًا/);
  assert.match(movementStatus({ ...rep, location: { ...rep.location!, accuracy: 212 } }, now), /ضعيفة/);
  assert.match(movementStatus({ ...rep, location: { ...rep.location!, speed: null } }, now), /غير متاحة/);
  // 91 seconds used to count as stale while the app only heartbeats once a minute.
  assert.match(movementStatus(rep, now + 91_000), /واقف تقريبًا/);
  assert.match(movementStatus(rep, now + STALE_FIX_MS + 1000), /لا إشارة/);
});

test('a bad GPS fix does not discard valid neighbours in the same batch', async () => {
  const points = ['good-1', 'bad', 'good-2'].map(id => ({ id } as GeoPoint));
  const sent: string[] = [], removed: string[] = [], rejected: string[] = [];
  const count = await sendLocationChunks(points, async chunk => {
    if (chunk.some(point => point.id === 'bad')) throw { status: 422 };
    sent.push(...chunk.map(point => point.id));
  }, async id => { removed.push(id); }, async id => { rejected.push(id); });
  assert.deepEqual(sent, ['good-1', 'good-2']);
  assert.deepEqual(removed, ['good-1', 'good-2']);
  assert.deepEqual(rejected, ['bad']);
  assert.equal(count, 2);
});

test('GPS queue retains points for authentication, rate-limit and server errors', async () => {
  for (const status of [0, 401, 429, 500]) {
    const removed: string[] = [];
    const count = await sendLocationChunks([{ id: 'point' } as GeoPoint], async () => { throw { status }; }, async id => { removed.push(id); }, async () => { throw Error('transient error must not reject'); });
    assert.equal(count, 0);
    assert.deepEqual(removed, []);
  }
});

test('a local deletion failure is not mistaken for a server rejection',async()=>{
 const removed:string[]=[],rejected:string[]=[];
 await assert.rejects(sendLocationChunks([{id:'one'} as GeoPoint,{id:'two'} as GeoPoint],async()=>{},async id=>{removed.push(id);throw {status:422};},async id=>{rejected.push(id); }));
 assert.deepEqual(removed,['one']);assert.deepEqual(rejected,[]);
});
