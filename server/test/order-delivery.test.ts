import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverOrderSafely, isConfirmedOrderResponse } from '../../mobile/src/orderDelivery.js';
import type { OrderInput } from '../../mobile/src/types.js';

const order: OrderInput = { id: 'order-1', customerId: 'customer-1', notes: 'ملاحظات', send: true, lines: [{ productId: 'product-1', qty: 3 }] };
const response = { duplicate: false, order: { id: order.id, customerId: order.customerId, status: 'sent', notes: order.notes, lines: [{ productId: 'product-1', qty: 3, notes: '' }] } };

test('save before sending, and remove only after a confirmed reply', async () => {
  const calls: string[] = [];
  const result = await deliverOrderSafely(order, {
    async save(payload) { calls.push('save'); assert.equal(payload.recordedAt, 123); },
    async send(payload) { calls.push('send'); assert.deepEqual(payload, order); },
    async remove(id) { calls.push('remove'); assert.equal(id, order.id); },
  }, 123);
  assert.deepEqual(result, { status: 'sent' });
  assert.deepEqual(calls, ['save', 'send', 'remove']);
});

test('failed local save never sends; uncertain responses retain the exact id for retry', async () => {
  let sends = 0;
  await assert.rejects(deliverOrderSafely(order, {
    async save() { throw new Error('storage full'); }, async send() { sends++; }, async remove() {},
  }), /storage full/);
  assert.equal(sends, 0);
  for (const status of [0, 408, 429, 500, 503, 401]) {
    let saved: (OrderInput & { recordedAt: number }) | undefined;
    let removed = false;
    const result = await deliverOrderSafely(order, {
      async save(value) { saved = value; },
      async send() { throw Object.assign(new Error('failure'), { status }); },
      async remove() { removed = true; },
    }, 123);
    assert.equal(result.status, 'queued', `HTTP ${status}`);
    assert.equal(saved?.id, order.id);
    assert.equal(saved?.recordedAt, 123);
    assert.equal(removed, false);
    if (status === 401) assert.deepEqual(result, { status: 'queued', reason: 'session' });
  }
});

test('a definitive rejection is reported, and a failed delete does not invite a duplicate', async () => {
  const failure = Object.assign(new Error('invalid'), { status: 400 });
  let removed = false;
  await assert.rejects(deliverOrderSafely(order, {
    async save() {}, async send() { throw failure; }, async remove() { removed = true; },
  }), /invalid/);
  assert.equal(removed, true);
  const result = await deliverOrderSafely(order, {
    async save() {}, async send() {}, async remove() { throw new Error('storage unavailable'); },
  });
  assert.deepEqual(result, { status: 'queued', reason: 'storage' });
});

test('confirmation requires the matching order and quantities, not just HTTP 200', () => {
  assert.equal(isConfirmedOrderResponse(order, response), true);
  assert.equal(isConfirmedOrderResponse(order, { ...response, duplicate: true }), true);
  assert.equal(isConfirmedOrderResponse(order, null), false);
  assert.equal(isConfirmedOrderResponse(order, { ...response, order: { ...response.order, id: 'other' } }), false);
  assert.equal(isConfirmedOrderResponse(order, { ...response, order: { ...response.order, customerId: 'other' } }), false);
  assert.equal(isConfirmedOrderResponse(order, { ...response, order: { ...response.order, status: 'draft' } }), false);
  assert.equal(isConfirmedOrderResponse(order, { ...response, order: { ...response.order, lines: [{ productId: 'product-1', qty: 4, notes: '' }] } }), false);
});
