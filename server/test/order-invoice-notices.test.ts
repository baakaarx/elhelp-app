import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { setPushTransport } from '../src/push.js';

test('invoice creates one private durable engineer notice and sends one best-effort push only after commit',async()=>{
 const app=createApp({dbPath:':memory:',production:false,adminEmail:'notice@test.local',adminPassword:'AdminPassword123!',loginRateLimit:{windowMs:60000,limit:5000}});
 const c=request(app.app);const seen:any[]=[];
 setPushTransport(async body=>{const messages=JSON.parse(body);seen.push(...messages);return {status:200,json:{data:messages.map(()=>({status:'ok'}))}};});
 try {
  const adminToken=(await c.post('/api/auth/login').send({email:'notice@test.local',password:'AdminPassword123!'})).body.token;
  const admin={'X-Mandoub-Token':adminToken,'X-Mandoub-Client':'admin'};
  const createRep=async(email:string)=>{const r=await c.post('/api/reps').set(admin).send({name:email,email,password:'RepPassword123!',region:'طنطا'});assert.equal(r.status,201);const login=await c.post('/api/auth/login').send({email,password:'RepPassword123!'});return {id:r.body.user.id,auth:{'X-Mandoub-Token':login.body.token,'X-Mandoub-Client':'rep'}};};
  const a=await createRep('notice-a@test.local'),b=await createRep('notice-b@test.local');
  const token=`ExpoPushToken[${'A'.repeat(24)}]`,other=`ExpoPushToken[${'B'.repeat(24)}]`;
  for(const [rep,t] of [[a,token],[b,other]] as const) app.store.run('INSERT INTO push_tokens(token,user_id,platform,device_id,created_at,updated_at) VALUES(?,?,?,?,?,?)',t,rep.id,'android',randomUUID(),Date.now(),Date.now());
  const customer=(await c.post('/api/customers').set(admin).send({name:'عميل التنبيه',repId:a.id})).body.customer;
  const wh=(await c.post('/api/warehouse/warehouses').set(admin).send({name:'مخزن التنبيه'})).body.warehouse;
  const product=(await c.post('/api/warehouse/stock-items').set(admin).send({id:randomUUID(),warehouseId:wh.id,product:{name:'صنف تنبيه',category:'other',unit:'عبوة'},qty:3})).body.productId;
  const orderId=randomUUID();assert.equal((await c.post('/api/orders').set(a.auth).send({id:orderId,customerId:customer.id,recommendation:'ترشيح',lines:[],send:true})).status,201);
  const sale={id:randomUUID(),orderId,customerId:customer.id,warehouseId:wh.id,paid:0,lines:[{productId:product,qty:4,price:20}]};
  assert.equal((await c.post('/api/sales').set(admin).send(sale)).status,409);
  assert.deepEqual((await c.get('/api/me/order-invoice-notices').set(a.auth)).body.notices,[]);assert.equal(seen.length,0);
  sale.lines[0].qty=2;assert.equal((await c.post('/api/sales').set(admin).send(sale)).status,201);
  assert.equal((await c.post('/api/sales').set(admin).send(sale)).body.duplicate,true);
  assert.equal((await c.post('/api/sales').set(admin).send({...sale,id:randomUUID()})).status,409);
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(seen.length,1);assert.equal(seen[0].to,token);assert.equal(seen[0].data.orderId,orderId);assert.deepEqual(Object.keys(seen[0].data).sort(),['orderId','type']);assert.ok(!String(seen[0].body).includes(customer.name));
  const mine=await c.get('/api/me/order-invoice-notices').set(a.auth);assert.equal(mine.body.notices.length,1);assert.equal(mine.body.notices[0].customerName,customer.name);assert.equal(mine.headers['cache-control'],'private, no-store');
  assert.deepEqual((await c.get('/api/me/order-invoice-notices').set(b.auth)).body.notices,[]);
  assert.equal((await c.get('/api/me/order-invoice-notices').set(admin)).status,403);
  assert.equal((await c.post(`/api/me/order-invoice-notices/${orderId}/read`).set(b.auth)).status,404);
  assert.equal((await c.post(`/api/me/order-invoice-notices/${orderId}/read`).set(a.auth)).status,200);
  assert.equal((await c.post(`/api/me/order-invoice-notices/${orderId}/read`).set(a.auth)).status,200);
  assert.deepEqual((await c.get('/api/me/order-invoice-notices').set(a.auth)).body.notices,[]);
 } finally {setPushTransport(null);await app.close();}
});
