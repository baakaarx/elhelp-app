import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';

const instance = createApp({ dbPath: ':memory:', production: false, adminEmail: 'policy@test.local', adminPassword: 'TestPassword123!', allowedOrigins: [], loginAccountLimit: 500, loginRateLimit: { windowMs: 60000, limit: 5000 } });
const client = request(instance.app);
test.after(async () => { await instance.close(); });

test('only office receipts reduce the correct customer balance, atomically and exactly once', async () => {
  const adminLogin = await client.post('/api/auth/login').send({ email: 'policy@test.local', password: 'TestPassword123!' });
  const admin = { Authorization: `Bearer ${adminLogin.body.token}` };
  const rep = await client.post('/api/reps').set(admin).send({ name: 'مهندس اختبار', email: 'field-policy@test.local', password: 'RepPassword123!', region: 'الإسكندرية' });
  assert.equal(rep.status, 201, JSON.stringify(rep.body));
  const engineer = { Authorization: `Bearer ${(await client.post('/api/auth/login').send({ email: 'field-policy@test.local', password: 'RepPassword123!' })).body.token}` };
  const a = (await client.post('/api/customers').set(admin).send({ name: 'عميل ألف', repId: rep.body.user.id })).body.customer.id;
  const b = (await client.post('/api/customers').set(admin).send({ name: 'عميل باء' })).body.customer.id;
  for (const customerId of [a, b]) assert.equal((await client.post('/api/sales/opening').set(admin).send({ id: randomUUID(), customerId, amount: 100 })).status, 201);
  const due = async (id: string) => (await client.get(`/api/sales/statement/${id}`).set(admin)).body.due;
  const receipt = { id: randomUUID(), customerId: a, amount: 25.25 };
  assert.equal((await client.post('/api/sales/receipts').set(engineer).send(receipt)).status, 403);
  const fieldReport = { id: randomUUID(), type: 'collection', title: 'تحصيل', customer: 'عميل ألف', amount: 25.25, location: null };
  const denied = await client.post('/api/reports').set(engineer).send(fieldReport);
  assert.equal(denied.status, 403); assert.equal(denied.body.code, 'FIELD_COLLECTION_DISABLED');
  assert.equal(await due(a), 100); assert.equal(await due(b), 100);
  instance.store.db.exec("CREATE TRIGGER fail_receipt_audit BEFORE INSERT ON audit_log WHEN NEW.action='sales.receipt' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
  try {
    assert.equal((await client.post('/api/sales/receipts').set(admin).send(receipt)).status, 500);
    assert.equal(await due(a), 100);
    assert.equal(instance.store.get('SELECT id FROM office_receipts_v1 WHERE id=?', receipt.id), undefined);
  } finally { instance.store.db.exec('DROP TRIGGER fail_receipt_audit'); }
  const results = await Promise.all([client.post('/api/sales/receipts').set(admin).send(receipt), client.post('/api/sales/receipts').set(admin).send(receipt)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  assert.equal(await due(a), 74.75); assert.equal(await due(b), 100);
  const statement = (await client.get(`/api/sales/statement/${a}`).set(admin)).body;
  assert.equal(statement.receipts.length, 1); assert.equal(statement.receipts[0].amount, 25.25);
  assert.equal((await client.post('/api/sales/receipts').set(admin).send({ ...receipt, amount: 30 })).status, 409);
  assert.equal((await client.post('/api/sales/receipts').set(admin).send({ id: randomUUID(), customerId: a, amount: 75 })).status, 409);
  assert.equal(await due(a), 74.75);
});

test('previously saved field reports can be retried unchanged, not overwritten or counted as receipts', async () => {
  const admin = { Authorization: `Bearer ${(await client.post('/api/auth/login').send({ email: 'policy@test.local', password: 'TestPassword123!' })).body.token}` };
  const login = await client.post('/api/auth/login').send({ email: 'field-policy@test.local', password: 'RepPassword123!' });
  const engineer = { Authorization: `Bearer ${login.body.token}` };
  const report = { id: randomUUID(), type: 'collection', title: 'سجل قديم', body: '', customer: 'عميل ألف', amount: 10, location: null };
  instance.store.run("INSERT INTO reports(id,user_id,type,title,body,customer,amount,created_at) VALUES (?,?,?,?,?,?,?,?)", report.id, login.body.user.id, report.type, report.title, report.body, report.customer, report.amount, Date.now());
  const duplicate = await client.post('/api/reports').set(engineer).send(report);
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true);
  assert.equal((await client.post('/api/reports').set(engineer).send({ ...report, amount: 11 })).status, 403);
  const a = instance.store.get('SELECT id FROM customers WHERE name=?', 'عميل ألف')!.id;
  const statement = await client.get(`/api/sales/statement/${a}`).set(admin);
  assert.equal(statement.body.due, 74.75); assert.equal(statement.body.receipts.length, 1);
  assert.equal(instance.store.get('SELECT amount FROM reports WHERE id=?', report.id)?.amount, 10);
});
