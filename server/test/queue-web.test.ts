import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutboxItem } from '../../mobile/src/types.js';

/**
 * The web outbox keeps a single localStorage array. Two things used to go wrong once it filled:
 * reports and fixes were silently evicted, and a long stretch of fixes starved a queued report.
 * All pending work must survive, with actions replayed before fixes.
 */
const store = new Map<string, string>();
let rejectWrites = false;
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (rejectWrites) throw new Error('quota exceeded');
    store.set(key, value);
  },
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

test('a long GPS backlog preserves all fixes and reports', async () => {
  store.clear();
  const queue = await createQueue();
  await queue.add('report', { id: 'rep-2' });
  for (let i = 0; i < 600; i++) await queue.add('location', { id: `fix-${i}` });

  const keys = readRaw().map(item => item.key);
  assert.equal(keys.length, 601);
  assert.ok(keys.includes('rep-2'), 'the queued report was evicted by the fix backlog');
  assert.ok(keys.includes('fix-0'), 'the oldest fix must stay until confirmed by the server');
});

test('the soft cap never evicts offline visits when no GPS fixes can be dropped', async () => {
  store.clear();
  const queue = await createQueue();
  for (let i = 0; i < 501; i++) {
    await queue.add('visit-checkout', { id: `checkout:visit-${i}`, visitId: `visit-${i}`, body: { outcome: 'تم' } });
  }
  const keys = readRaw().map(item => item.key);
  assert.equal(keys.length, 501, 'important work may exceed the soft item cap');
  assert.ok(keys.includes('checkout:visit-0'), 'the oldest unsent visit is still present');
});

test('a full browser store reports that an offline visit was not saved', async () => {
  store.clear();
  const queue = await createQueue();
  rejectWrites = true;
  try {
    await assert.rejects(
      queue.add('visit-checkin', { id: 'visit-no-space', customerName: 'عميل' }),
      /مساحة حفظ البيانات/,
    );
  } finally { rejectWrites = false; }
  assert.equal(readRaw().length, 0, 'nothing was claimed as saved when the write failed');
});

test('corrupt local outbox content is preserved instead of treated as an empty queue', async () => {
  store.clear();
  const queue = await createQueue();
  for (const raw of ['{broken', JSON.stringify([{}]), JSON.stringify({ items: [] })]) {
    store.set(KEY, raw);
    await assert.rejects(queue.count(), /تعذّر قراءة البيانات المعلّقة/);
    await assert.rejects(queue.add('report', { id: 'must-not-overwrite' }), /تعذّر قراءة البيانات المعلّقة/);
    assert.equal(store.get(KEY), raw, 'a failed read must not destroy the stored bytes');
  }
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

test('a check-in sent in the same millisecond is ordered before its check-out', async () => {
  store.clear();
  const queue = await createQueue();
  const originalNow = Date.now;
  Date.now = () => 12345;
  try {
    await queue.add('visit-checkin', { id: 'visit-same-ms', customerName: 'عميل', recordedAt: 12345 });
    await queue.add('visit-checkout', { id: 'checkout:visit-same-ms', visitId: 'visit-same-ms', body: { outcome: 'تم', recordedAt: 12345 } });
    assert.deepEqual((await queue.list()).map(item => item.kind), ['visit-checkin', 'visit-checkout']);
    assert.equal(await queue.count('visit-checkin'), 1);
    assert.equal(await queue.count('visit-checkout'), 1);
    assert.equal(await queue.count(), 2);
  } finally { Date.now = originalNow; }
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

test('offline orders survive reading and reloading the web queue', async () => {
  store.clear();
  const queue = await createQueue();
  const order = { id: 'order-offline', customerId: 'customer', notes: '', lines: [{ productId: 'item', qty: 4 }], recordedAt: 123 };
  await queue.add('order', order);
  assert.equal(await queue.count('order'), 1);
  const reopened = await createQueue();
  const items = await reopened.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'order');
  assert.deepEqual(JSON.parse(items[0].payload), order);
});


test('rejected actions cannot starve later work while visit dependencies stay in order', async () => {
  store.clear();
  const queue = await createQueue();
  for (let i = 0; i < 205; i++) {
    await queue.add('visit-checkin', { id: `rejected-${i}` });
    await queue.reject(`rejected-${i}`);
  }
  await queue.add('visit-checkout', { id: 'checkout:rejected-0', visitId: 'rejected-0', body: {} });
  await queue.add('order', { id: 'independent-order' });
  await queue.add('location', { id: 'gps' });
  const items = await queue.listForReplay(1);
  assert.equal(items.length, 208);
  assert.equal(items[0].key, 'rejected-0');
  assert.ok(items.findIndex(item => item.key === 'checkout:rejected-0') > 0);
  assert.ok(items.some(item => item.key === 'independent-order'));
  assert.equal(items.at(-1)?.key, 'gps');
});

test('a reused key never silently discards different offline work', async () => {
  store.clear();
  const queue = await createQueue();
  const original = { id: 'same-key', customerId: 'a', lines: [{ qty: 1 }] };
  await queue.add('order', original);
  await queue.add('order', original); // A genuine retry stays idempotent.
  await assert.rejects(queue.add('order', { ...original, lines: [{ qty: 2 }] }), /الطلب الجديد لم يُحفظ/);
  await assert.rejects(queue.add('report', original), /الطلب الجديد لم يُحفظ/);
  const items = await queue.list();
  assert.equal(items.length, 1);
  assert.deepEqual(JSON.parse(items[0].payload), original);
});

test('quota failure never evicts existing locations to save a new action', async () => {
  store.clear(); const queue=await createQueue();
  await queue.add('location',{id:'keep-gps',recordedAt:1});
  const before=store.get(KEY);rejectWrites=true;
  try { await assert.rejects(queue.add('report',{id:'report-cannot-fit'}),/لم يتم حفظ البيانات الجديدة/); }
  finally { rejectWrites=false; }
  assert.equal(store.get(KEY),before);assert.equal((await queue.list())[0].key,'keep-gps');
});

test('rejected locations remain on the device but cannot starve fresh fixes',async()=>{
  store.clear();const queue=await createQueue();
  for(let i=0;i<205;i++){await queue.add('location',{id:`old-${i}`});await queue.reject(`old-${i}`);}
  await queue.add('location',{id:'new-gps'});
  assert.equal(await queue.countRejectedLocations(),205);
  assert.deepEqual((await queue.listForReplay(2)).map(x=>x.key),['new-gps']);
  assert.deepEqual((await queue.listForReplay(2,true)).map(x=>x.key),['old-0','old-1']);
  await queue.bump('old-0');await queue.bump('old-1');
  assert.deepEqual((await queue.listForReplay(2,true)).map(x=>x.key),['old-2','old-3'], 'repeated manual retries eventually reach the rest');
  assert.equal(await queue.count(),206);
});
