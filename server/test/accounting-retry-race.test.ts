import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

const instance = createApp({ dbPath: ':memory:', production: false, adminEmail: 'race@test.local', adminPassword: 'AdminPassword123!', allowedOrigins: [] });
const client = request(instance.app);
test.after(async () => instance.close());
const login = await client.post('/api/auth/login').send({ email: 'race@test.local', password: 'AdminPassword123!' });
const auth = { Authorization: `Bearer ${login.body.token}` };

/** Simulate the same request committing after the first lookup and before the lock. */
async function simulateRace(path: string, body: object) {
  const original = instance.store.transaction.bind(instance.store);
  instance.store.transaction = fn => { original(fn); original(fn); };
  try { return await client.post(path).set(auth).send(body); }
  finally { instance.store.transaction = original; }
}

test('opening, receipt and correction recover a request committed before the lock without applying it twice', async () => {
  const customer = (await client.post('/api/customers').set(auth).send({ name: 'عميل تزاحم الحساب' })).body.customer.id;
  const opening = { id: randomUUID(), customerId: customer, amount: 100 };
  const opened = await simulateRace('/api/sales/opening', opening);
  assert.equal(opened.status, 200, JSON.stringify(opened.body)); assert.equal(opened.body.duplicate, true);
  const receipt = { id: randomUUID(), customerId: customer, amount: 20 };
  const paid = await simulateRace('/api/sales/receipts', receipt);
  assert.equal(paid.status, 200, JSON.stringify(paid.body)); assert.equal(paid.body.duplicate, true);
  const path = `/api/sales/corrections/receipt/${receipt.id}`;
  const detail = (await client.get(path).set(auth)).body;
  const correction = { id: randomUUID(), reason: 'تصحيح تجربة التزاحم', balancePiasters: detail.balancePiasters, revision: detail.revision, lines: [], cash: { kind: 'refund', amountPiasters: 500 } };
  const corrected = await simulateRace(path, correction);
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body)); assert.equal(corrected.body.duplicate, true);
  const statement = (await client.get(`/api/sales/statement/${customer}`).set(auth)).body;
  assert.equal(statement.due, 85);
  assert.equal(statement.receipts.length, 1);
  assert.equal(Number(instance.store.get('SELECT COUNT(*) AS n FROM office_corrections_v1 WHERE receipt_id=?', receipt.id)?.n), 1);
});
