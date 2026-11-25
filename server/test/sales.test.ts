import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';

const app=createApp({dbPath:':memory:',production:false,adminEmail:'sales-test@local.test',adminPassword:'AdminPassword123!',allowedOrigins:[],loginAccountLimit:500,loginRateLimit:{windowMs:60000,limit:5000}});
const client=request(app.app);
test.after(async()=>await app.close());
const adminLogin=await client.post('/api/auth/login').send({email:'sales-test@local.test',password:'AdminPassword123!'});
const auth={Authorization:`Bearer ${adminLogin.body.token}`};
const customer=(await client.post('/api/customers').set(auth).send({name:'عميل مبيعات'})).body.customer.id;
const wh=(await client.post('/api/warehouse/warehouses').set(auth).send({name:'مخزن مبيعات'})).body.warehouse.id;
const prod=(await client.post('/api/warehouse/products').set(auth).send({name:'صنف مبيعات',category:'other',unit:'عبوة'})).body.product.id;
const open=await client.post('/api/warehouse/movements').set(auth).send({id:randomUUID(),kind:'opening',productId:prod,toWarehouseId:wh,qty:10});
assert.equal(open.status,201);
const stock=async()=>(await client.get(`/api/warehouse/stock?warehouseId=${wh}`).set(auth)).body.stock.find((x:any)=>x.id===prod).qty;
const overview=async()=>(await client.get('/api/sales/overview').set(auth)).body;

test('confirmed sale records partial payment, stock and customer balance exactly once',async()=>{
 const input={id:randomUUID(),customerId:customer,warehouseId:wh,paid:5,lines:[{productId:prod,qty:2.5,price:10.25}]};
 assert.equal((await client.post('/api/sales').set(auth).send(input)).status,201);
 assert.equal((await client.post('/api/sales').set(auth).send(input)).body.duplicate,true);
 assert.equal((await client.post('/api/sales').set(auth).send({...input,paid:4})).status,409);
 assert.equal(await stock(),7.5);
 const report=await overview();assert.equal(report.sales,25.63);assert.equal(report.collected,5);assert.equal(report.due,20.63);assert.equal(report.debtors[0].name,'عميل مبيعات');
 assert.equal(report.soldItems[0].qty,2.5);assert.equal(report.soldItems[0].amount,25.63);
 const movements=(await client.get(`/api/warehouse/movements?warehouseId=${wh}`).set(auth)).body.movements;
 assert.equal(movements.length,2);assert.equal(movements[0].kind,'out');assert.ok(!JSON.stringify(movements).includes('10.25'));
});

test('rejecting bad sales never partially changes stock or balances',async()=>{
 const second=(await client.post('/api/warehouse/products').set(auth).send({name:'صنف بدون رصيد',category:'other',unit:'عبوة'})).body.product.id;
 for(const lines of [[{productId:prod,qty:1,price:2},{productId:second,qty:1,price:3}],[{productId:prod,qty:99,price:2}],[{productId:prod,qty:1.0001,price:2}]]){
  assert.equal((await client.post('/api/sales').set(auth).send({id:randomUUID(),customerId:customer,warehouseId:wh,paid:0,lines})).status,409);
 }
 assert.equal(await stock(),7.5); assert.equal((await overview()).sales,25.63);
 assert.equal((await client.post('/api/sales').set(auth).send({id:randomUUID(),customerId:customer,warehouseId:wh,paid:99,lines:[{productId:prod,qty:1,price:2}]})).status,409);
});

test('opening debt and later receipts are explicit, idempotent and cannot overpay',async()=>{
 const opening={id:randomUUID(),customerId:customer,amount:100};
 assert.equal((await client.post('/api/sales/opening').set(auth).send(opening)).status,201);
 assert.equal((await client.post('/api/sales/opening').set(auth).send(opening)).body.duplicate,true);
 assert.equal((await client.post('/api/sales/opening').set(auth).send({...opening,id:randomUUID()})).status,409);
 const pay={id:randomUUID(),customerId:customer,amount:20.5};
 assert.equal((await client.post('/api/sales/receipts').set(auth).send(pay)).status,201);
 assert.equal((await client.post('/api/sales/receipts').set(auth).send(pay)).body.duplicate,true);
 assert.equal((await client.post('/api/sales/receipts').set(auth).send({...pay,id:randomUUID(),amount:101})).status,409);
 const report=await overview(); assert.equal(report.sales,25.63);assert.equal(report.collected,25.5);assert.equal(report.due,100.13);
 assert.equal((await client.delete(`/api/customers/${customer}`).set(auth)).status,409);
});

test('pricing an order is not a sale; confirming it deducts stock once',async()=>{
 const rep=(await client.post('/api/reps').set(auth).send({name:'مهندس بيع',email:'field@sales.test',password:'Password12345!',region:'طنطا'})).body.user.id;
 await client.post(`/api/customers/${customer}/assign`).set(auth).send({repId:rep});
 const repAuth={Authorization:`Bearer ${(await client.post('/api/auth/login').send({email:'field@sales.test',password:'Password12345!'})).body.token}`};
 const orderId=randomUUID();
 assert.equal((await client.post('/api/orders').set(repAuth).send({id:orderId,customerId:customer,lines:[{productId:prod,qty:1}],send:true})).status,201);
 assert.equal((await client.post(`/api/orders/${orderId}/price`).set(auth).send({lines:[{productId:prod,price:9}]})).status,200);
 assert.equal((await overview()).sales,25.63);
 const input={id:randomUUID(),orderId,customerId:customer,warehouseId:wh,paid:0};
 assert.equal((await client.post('/api/sales').set(auth).send(input)).status,201);
 assert.equal((await client.post('/api/sales').set(auth).send({...input,id:randomUUID()})).status,409);
 assert.equal((await overview()).sales,34.63);assert.equal(await stock(),6.5);
});

test('warehouse account and engineer cannot see financial data or record sales',async()=>{
 await client.post('/api/staff').set(auth).send({name:'مخازن',email:'wh@sales.test',password:'Warehouse12345!',accessScope:'warehouse'});
 const token=(await client.post('/api/auth/login').send({email:'wh@sales.test',password:'Warehouse12345!'})).body.token;
 for(const path of ['/api/sales/options','/api/sales/overview'])assert.equal((await client.get(path).set('Authorization',`Bearer ${token}`)).status,403);
 assert.equal((await client.post('/api/sales').set('Authorization',`Bearer ${token}`).send({})).status,403);
});

test('removing an engineer preserves the customer and confirmed financial history',async()=>{
 const reps=(await client.get('/api/reps').set(auth)).body.reps;
 const rep=reps.find((r:any)=>r.email==='field@sales.test');
 assert.equal((await client.delete(`/api/reps/${rep.id}`).set(auth).send({confirm:true})).status,200);
 const report=await overview();assert.equal(report.sales,34.63);assert.equal(report.due,109.13);
 assert.equal(report.debtors.find((r:any)=>r.id===customer).name,'عميل مبيعات');
 assert.equal((await client.delete(`/api/customers/${customer}`).set(auth)).status,409);
});
