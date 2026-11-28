import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {createApp} from '../src/app.js';

test('tier audit rollback and last active tier cannot be deleted', async () => {
 const instance=createApp({dbPath:':memory:',production:false,adminEmail:'repair@test.local',adminPassword:'AdminPassword123!'});
 try {
  const client=request(instance.app), token=(await client.post('/api/auth/login').send({email:'repair@test.local',password:'AdminPassword123!'})).body.token;
  const auth={Authorization:`Bearer ${token}`};
  const tier=(await client.post('/api/price-tiers').set(auth).send({name:'نوع للمراجعة'})).body.tier;
  instance.store.db.exec("CREATE TRIGGER test_tier_failure BEFORE INSERT ON audit_log WHEN NEW.action='tier.update' BEGIN SELECT RAISE(ABORT,'audit failed'); END");
  const fail=await client.patch(`/api/price-tiers/${tier.id}`).set(auth).send({name:'لا يُحفظ'});
  assert.equal(fail.status,500);assert.equal(instance.store.get('SELECT name FROM price_tiers WHERE id=?',tier.id)?.name,'نوع للمراجعة');
  instance.store.db.exec('DROP TRIGGER test_tier_failure');
  instance.store.run('UPDATE price_tiers SET active=0 WHERE id<>?',tier.id);
  const response=await client.delete(`/api/price-tiers/${tier.id}`).set(auth);
  assert.equal(response.status,409);assert.equal(instance.store.get('SELECT active FROM price_tiers WHERE id=?',tier.id)?.active,1);
 } finally { await instance.close(); }
});

test('sales verify product review snapshot and return matching request IDs on save and replay', async () => {
 const instance=createApp({dbPath:':memory:',production:false,adminEmail:'repair-sales@test.local',adminPassword:'AdminPassword123!'});
 try {
  const client=request(instance.app),token=(await client.post('/api/auth/login').send({email:'repair-sales@test.local',password:'AdminPassword123!'})).body.token;
  const auth={Authorization:`Bearer ${token}`};
  const c=(await client.post('/api/customers').set(auth).send({name:'عميل'})).body.customer;
  const w=(await client.post('/api/warehouse/warehouses').set(auth).send({name:'مخزن'})).body.warehouse;
  const p=(await client.post('/api/warehouse/products').set(auth).send({name:'صنف',category:'other',unit:'عبوة',unitSize:'١ لتر'})).body.product;
  assert.equal((await client.post('/api/warehouse/movements').set(auth).send({id:randomUUID(),kind:'opening',productId:p.id,toWarehouseId:w.id,qty:5})).status,201);
  const body={id:randomUUID(),customerId:c.id,warehouseId:w.id,paid:0,lines:[{productId:p.id,qty:1,price:10,productSnapshot:{name:p.name,unit:p.unit,unitSize:p.unitSize}}]};
  // Simulate another committed catalogue update after the review was rendered.
  instance.store.run('UPDATE products SET unit_size=? WHERE id=?','٥ لتر',p.id);
  const stale=await client.post('/api/sales').set(auth).send(body);
  assert.equal(stale.status,409);assert.equal(stale.body.code,'PRODUCT_CHANGED');
  assert.equal(instance.store.get('SELECT COUNT(*) AS n FROM office_sales_v1 WHERE id=?',body.id)?.n,0);
  body.lines[0].productSnapshot.unitSize='٥ لتر';
  const saved=await client.post('/api/sales').set(auth).send(body);assert.equal(saved.status,201);assert.equal(saved.body.requestId,body.id);
  const repeat=await client.post('/api/sales').set(auth).send(body);assert.equal(repeat.status,200);assert.equal(repeat.body.requestId,body.id);assert.equal(repeat.body.duplicate,true);
  const conflict=await client.post('/api/sales').set(auth).send({...body,paid:1});assert.equal(conflict.status,409);assert.equal(conflict.body.code,'REQUEST_CONFLICT');
 } finally { await instance.close(); }
});
