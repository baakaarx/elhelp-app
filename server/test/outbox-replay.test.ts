import assert from 'node:assert/strict';
import test from 'node:test';
import { replayOutboxActions } from '../../mobile/src/outboxReplay.js';
import type { Outbox } from '../../mobile/src/queue.js';
import type { OutboxItem, VisitInput } from '../../mobile/src/types.js';

const visit: VisitInput & { recordedAt: number } = {
  id: 'visit-offline-1', customerName: 'مزرعة', governorate: '', district: '', village: '', phone: '',
  purpose: 'visit', notes: '', location: { lat: 31.2, lng: 29.9, accuracy: 8 }, recordedAt: 12345,
};
const checkout = {
  id: `checkout:${visit.id}`, visitId: visit.id,
  body: { outcome: 'تمت الزيارة', notes: '', amount: null, location: null, recordedAt: 12346 },
};
const report = { id: 'report-1', type: 'note' as const, title: 'ملاحظة', body: '', customer: '', amount: null, location: null };
const item = (key: string, kind: OutboxItem['kind'], payload: unknown): OutboxItem => ({
  key, kind, payload: JSON.stringify(payload), createdAt: 12345, attempts: 0, rejected: false,
});

test('a transient check-in failure keeps its check-out pending but does not block unrelated reports', async () => {
  const initial = [
    item('checkin', 'visit-checkin', visit),
    item('report', 'report', report),
    item('checkout', 'visit-checkout', checkout),
  ];
  const pending = new Map(initial.map(entry => [entry.key, entry]));
  const queue: Pick<Outbox, 'remove' | 'bump' | 'reject' | 'unreject'> = {
    async remove(key) { pending.delete(key); },
    async bump(key) {
      const entry = pending.get(key);
      if (entry) pending.set(key, { ...entry, attempts: entry.attempts + 1 });
    },
    async reject(key) {
      const entry = pending.get(key);
      if (entry) pending.set(key, { ...entry, rejected: true });
    },
    async unreject(key) {
      const entry = pending.get(key);
      if (entry) pending.set(key, { ...entry, rejected: false });
    },
  };
  const calls: string[] = [];
  const result = await replayOutboxActions(initial, queue, {
    async checkIn() { calls.push('check-in'); throw Object.assign(new Error('temporary server error'), { status: 503 }); },
    async checkOut() { calls.push('check-out'); },
    async report() { calls.push('report'); },
    async dailyReport() { calls.push('daily-report'); },
  });

  assert.equal(result.sent, 1);
  assert.deepEqual(calls, ['check-in', 'report'], 'the dependent check-out is not attempted');
  assert.deepEqual([...pending.keys()], ['checkin', 'checkout'], 'both halves remain queued for a retry');
  assert.equal(pending.get('checkin')?.attempts, 1);
  assert.equal(pending.get('checkout')?.attempts, 0, 'the dependent item is neither failed nor discarded');

  calls.length = 0;
  const retried = await replayOutboxActions([...pending.values()], queue, {
    async checkIn() { calls.push('check-in'); },
    async checkOut() { calls.push('check-out'); },
    async report() { calls.push('report'); },
    async dailyReport() { calls.push('daily-report'); },
  });
  assert.equal(retried.sent, 2);
  assert.deepEqual(calls, ['check-in', 'check-out']);
  assert.equal(pending.size, 0);
});

test('a failed offline check-in blocks its dependent result until a manual retry succeeds', async () => {
  const initial = [item('checkin', 'visit-checkin', visit), item('checkout', 'visit-checkout', checkout)];
  const pending = new Map(initial.map(entry => [entry.key, entry]));
  const queue: Pick<Outbox, 'remove' | 'bump' | 'reject' | 'unreject'> = {
    async remove(key) { pending.delete(key); },
    async bump(key) {
      const entry = pending.get(key);
      if (entry) pending.set(key, { ...entry, attempts: entry.attempts + 1 });
    },
    async reject(key) {
      const entry = pending.get(key);
      if (entry) pending.set(key, { ...entry, rejected: true });
    },
    async unreject(key) {
      const entry = pending.get(key);
      if (entry) pending.set(key, { ...entry, rejected: false });
    },
  };
  const calls: string[] = [];
  await replayOutboxActions(initial, queue, {
    async checkIn() { calls.push('check-in'); throw Object.assign(new Error('visit is not valid'), { status: 422 }); },
    async checkOut() { calls.push('check-out'); },
    async report() {},
    async dailyReport() {},
  });
  assert.deepEqual(calls, ['check-in'], 'the result is not sent after its check-in fails');
  assert.equal(pending.get('checkin')?.rejected, true);
  assert.equal(pending.get('checkout')?.rejected, false, 'the dependent result is left untouched, not falsely rejected');
  assert.equal(pending.get('checkout')?.attempts, 0);

  calls.length = 0;
  const paused = await replayOutboxActions([...pending.values()], queue, {
    async checkIn() { calls.push('check-in'); },
    async checkOut() { calls.push('check-out'); },
    async report() {},
    async dailyReport() {},
  });
  assert.deepEqual(calls, [], 'automatic retry pauses both halves behind the rejected check-in');
  assert.equal(pending.size, 2);

  calls.length = 0;
  const manual = await replayOutboxActions([...pending.values()], queue, {
    async checkIn() { calls.push('check-in'); },
    async checkOut() { calls.push('check-out'); },
    async report() {},
    async dailyReport() {},
  }, { retryRejected: true });
  assert.deepEqual(calls, ['check-in', 'check-out']);
  assert.equal(manual.sent, 2);
  assert.equal(pending.size, 0);
});

test('a permanent server rejection keeps the saved report and explains why it did not sync', async () => {
  const initial = [
    item('report', 'report', report),
    item('daily', 'daily-report', { id: 'daily-1' }),
  ];
  const pending = new Map(initial.map(entry => [entry.key, entry]));
  const queue: Pick<Outbox, 'remove' | 'bump' | 'reject' | 'unreject'> = {
    async remove(key) { pending.delete(key); },
    async bump(key) {
      const entry = pending.get(key);
      if (entry) pending.set(key, { ...entry, attempts: entry.attempts + 1 });
    },
    async reject(key) {
      const entry = pending.get(key);
      if (entry) pending.set(key, { ...entry, rejected: true });
    },
    async unreject(key) {
      const entry = pending.get(key);
      if (entry) pending.set(key, { ...entry, rejected: false });
    },
  };
  const calls: string[] = [];
  const result = await replayOutboxActions(initial, queue, {
    async checkIn() {},
    async checkOut() {},
    async report() { calls.push('report'); throw Object.assign(new Error('التاريخ مرفوض'), { status: 422 }); },
    async dailyReport() { calls.push('daily-report'); },
  });

  assert.equal(result.sent, 1, 'the rejected report does not block unrelated saved work');
  assert.deepEqual(calls, ['report', 'daily-report']);
  assert.deepEqual([...pending.keys()], ['report'], 'the rejected payload remains on the phone');
  assert.equal(pending.get('report')?.attempts, 1);
  assert.equal(pending.get('report')?.rejected, true);
  assert.match(result.notice || '', /التاريخ مرفوض/);
  assert.match(result.notice || '', /ما زالت على الهاتف/);

  calls.length = 0;
  const paused = await replayOutboxActions([...pending.values()], queue, {
    async checkIn() {},
    async checkOut() {},
    async report() { calls.push('report'); },
    async dailyReport() {},
  });
  assert.deepEqual(calls, [], 'the automatic timer does not hammer a permanent rejection');
  assert.equal(pending.size, 1);
  assert.match(paused.notice || '', /لم نكرر إرسالها تلقائيًا/);

  const manual = await replayOutboxActions([...pending.values()], queue, {
    async checkIn() {},
    async checkOut() {},
    async report() { calls.push('manual-report'); throw Object.assign(new Error('offline'), { status: 0 }); },
    async dailyReport() {},
  }, { retryRejected: true });
  assert.deepEqual(calls, ['manual-report'], 'the explicit manual retry can resend a rejected item');
  assert.equal(manual.sent, 0);
  assert.equal(pending.get('report')?.rejected, false, 'a transient manual retry resumes automatic retries');

  calls.length = 0;
  const recovered = await replayOutboxActions([...pending.values()], queue, {
    async checkIn() {},
    async checkOut() {},
    async report() { calls.push('automatic-retry'); },
    async dailyReport() {},
  });
  assert.deepEqual(calls, ['automatic-retry']);
  assert.equal(recovered.sent, 1);
  assert.equal(pending.size, 0);
});

test('an offline order is sent exactly as saved and stays queued on rejection', async () => {
  const order = { id: 'order-1', customerId: 'customer-1', notes: '', lines: [{ productId: 'product-1', qty: 2 }], send: true, recordedAt: 12345 };
  const entry = item('order', 'order', order);
  const pending = new Map([[entry.key, entry]]);
  const queue: Pick<Outbox, 'remove' | 'bump' | 'reject' | 'unreject'> = {
    async remove(key) { pending.delete(key); },
    async bump(key) { const x = pending.get(key); if (x) x.attempts++; },
    async reject(key) { const x = pending.get(key); if (x) x.rejected = true; },
    async unreject(key) { const x = pending.get(key); if (x) x.rejected = false; },
  };
  const seen: unknown[] = [];
  const send = {
    async checkIn() {}, async checkOut() {}, async report() {}, async dailyReport() {},
    async createOrder(value: typeof order) { seen.push(value); throw Object.assign(new Error('الطلبية قديمة'), { status: 422 }); },
  };
  const rejected = await replayOutboxActions([entry], queue, send);
  assert.equal(rejected.sent, 0);
  assert.equal(pending.get('order')?.rejected, true);
  assert.match(rejected.notice ?? '', /الطلبية قديمة/);
  assert.deepEqual(seen, [order]);
  const paused = await replayOutboxActions([entry], queue, send);
  assert.equal(paused.sent, 0);
  assert.equal(seen.length, 1);
});

test('an order linked to an offline visit waits until that visit is accepted', async () => {
  const order = { id: 'order-linked', customerId: 'customer', visitId: visit.id, notes: '', lines: [{ productId: 'item', qty: 1 }], recordedAt: 12346 };
  const initial = [item('checkin', 'visit-checkin', visit), item('order', 'order', order)];
  const pending = new Map(initial.map(entry => [entry.key, entry]));
  const queue: Pick<Outbox, 'remove' | 'bump' | 'reject' | 'unreject'> = {
    async remove(key) { pending.delete(key); }, async bump() {}, async reject() {}, async unreject() {},
  };
  const calls: string[] = [];
  let connected = false;
  const send = {
    async checkIn() { calls.push('visit'); if (!connected) throw Object.assign(new Error('offline'), { status: 0 }); },
    async checkOut() {}, async report() {}, async dailyReport() {},
    async createOrder() { calls.push('order'); },
  };
  await replayOutboxActions(initial, queue, send);
  assert.deepEqual(calls, ['visit']);
  assert.equal(pending.size, 2);
  connected = true;
  await replayOutboxActions([...pending.values()], queue, send);
  assert.deepEqual(calls, ['visit', 'visit', 'order']);
  assert.equal(pending.size, 0);
});
