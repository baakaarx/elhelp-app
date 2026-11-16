import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutboxItem } from '../../mobile/src/types.js';

/**
 * The web outbox keeps a single localStorage array. Two things used to go wrong once it filled:
 * reports were evicted by a plain `slice(-500)` (silently losing the engineer's work), and the
 * flush read strictly by age, so a long stretch of fixes starved a queued report.
 */
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

const { createQueue } = await import('../../mobile/src/queue.web.js');
const KEY = 'mandoub.outbox';
const readRaw = () => JSON.parse(store.get(KEY) ?? '[]') as OutboxItem[];

test('reports are flushed before an older backlog of fixes', async () => {
  store.clear();
  const queue = await createQueue();
  const now = Date.now();
  for (let i = 0; i < 5; i++) await queue.add('location', { id: `fix-${i}`, lat: 31.2, lng: 29.9, recordedAt: now - 10_000 + i });
  await queue.add('report', { id: 'rep-1', note: 'تحصيل ٥٠٠' });

  const order = (await queue.list(3)).map(item => item.key);
  assert.deepEqual(order, ['rep-1', 'fix-0', 'fix-1'], `got ${order.join(',')}`);
});

test('the cap evicts old fixes, never a queued report', async () => {
  store.clear();
  const queue = await createQueue();
  await queue.add('report', { id: 'rep-2' });
  for (let i = 0; i < 600; i++) await queue.add('location', { id: `fix-${i}` });

  const keys = readRaw().map(item => item.key);
  assert.ok(keys.length <= 500, `cap not applied: ${keys.length}`);
  assert.ok(keys.includes('rep-2'), 'the queued report was evicted by the fix backlog');
  assert.ok(!keys.includes('fix-0'), 'the oldest fixes should be the ones dropped');
});

test('a visit typed with no signal is never evicted by fixes, and is retried before them', async () => {
  store.clear();
  const queue = await createQueue();
  // The queued payload is the check-in body itself: its `id` is the queue key.
  await queue.add('visit-checkin', { id: 'v-1', customerName: 'عميل', recordedAt: Date.now() });
  for (let i = 0; i < 600; i++) await queue.add('location', { id: `fix-${i}`, lat: 31.2, lng: 29.9, recordedAt: Date.now() });

  const keys = readRaw().map(item => item.key);
  assert.ok(keys.includes('v-1'), 'the visit was evicted');
  assert.equal((await queue.list(1))[0].key, 'v-1', 'a visit goes out before the fix backlog');
});

test('two visits closed with no signal both survive the queue', async () => {
  store.clear();
  const queue = await createQueue();
  // The payload carries its queue key as `id`; the body itself never does.
  await queue.add('visit-checkout', { id: 'checkout:v-1', visitId: 'v-1', body: { outcome: 'مكتملة', recordedAt: Date.now() } });
  await queue.add('visit-checkout', { id: 'checkout:v-2', visitId: 'v-2', body: { outcome: 'مكتملة', recordedAt: Date.now() } });
  const keys = readRaw().map(item => item.key).sort();
  assert.deepEqual(keys, ['checkout:v-1', 'checkout:v-2']);

  // And a payload that names no key at all no longer collides with the previous one.
  await queue.add('report', { note: 'بدون id' });
  await queue.add('report', { note: 'بدون id كذلك' });
  assert.equal(readRaw().length, 4, 'an id-less payload must not be de-duplicated away');
});
