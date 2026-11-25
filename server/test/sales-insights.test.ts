import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {dayBounds,localDate} from '../src/geo.js';

// A disposable, in-memory company: exercise the real order, price, stock, sale and payment APIs.
const instance=createApp({dbPath:':memory:',production:false,timezone:'Africa/Cairo',adminEmail:'analysis@test.local',adminPassword:'AdminPassword123!',loginAccountLimit:500,loginRateLimit:{windowMs:60000,limit:5000}});
const client=request(instance.app);test.after(async()=>await instance.close());
const adminLogin=await client.post('/api/auth/login').send({email:'analysis@test.local',password:'AdminPassword123!'});
const admin={Authorization:`Bearer ${adminLogin.body.token}`};
const post=async(path:string,body:object,auth=admin)=>{const res=await client.post(path).set(auth).send(body);assert.ok(res.status<300,`${path}: ${JSON.stringify(res.body)}`);return res.body;};
const day=localDate('Africa/Cairo');
const get=async()=>{const r=await client.get(`/api/sales-insights?from=${day}&to=${day}`).set(admin);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
const repA=(await post('/api/reps',{name:'مهندس أول',email:'a@analysis.test',password:'Password12345!',region:'طنطا'})).user;
const repB=(await post('/api/reps',{name:'مهندس تاني',email:'b@analysis.test',password:'Password12345!',region:'دمنهور'})).user;
const repToken=(await post('/api/auth/login',{email:'a@analysis.test',password:'Password12345!'})).token;
const repAuth={Authorization:`Bearer ${repToken}`};
const customerA=(await post('/api/customers',{name:'عميل أول',repId:repA.id})).customer;
const customerB=(await post('/api/customers',{name:'عميل تاني',repId:repB.id})).customer;
const warehouse=(await post('/api/warehouse/warehouses',{name:'مخزن تجريبي'})).warehouse;
const itemA=(await post('/api/warehouse/products',{name:'صنف ألف',category:'other',unit:'عبوة'})).product;
const itemB=(await post('/api/warehouse/products',{name:'صنف باء',category:'other',unit:'كيس'})).product;
await post('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:itemA.id,toWarehouseId:warehouse.id,qty:100});
await post('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:itemB.id,toWarehouseId:warehouse.id,qty:100});
let orderId='',saleId='';

test('simulation: order and pricing alone are not confirmed sales',async()=>{
 await post('/api/shifts/start',{consentVersion:'1.0',deviceId:'test-phone-analysis',location:{lat:31.2,lng:29.9,accuracy:8}},repAuth);
 await post('/api/visits/check-in',{id:randomUUID(),customerId:customerA.id,purpose:'visit',location:{lat:31.2,lng:29.9,accuracy:8}},repAuth);
 orderId=randomUUID();await post('/api/orders',{id:orderId,customerId:customerA.id,lines:[{productId:itemA.id,qty:2},{productId:itemB.id,qty:1}],send:true},repAuth);
 await post(`/api/orders/${orderId}/price`,{lines:[{productId:itemA.id,price:10},{productId:itemB.id,price:20}]});
 const r=await get();assert.equal(r.sales,0);assert.equal(r.salesCount,0);assert.equal(r.reps.find((x:any)=>x.id===repA.id).orders,1);assert.equal(r.reps.find((x:any)=>x.id===repA.id).visits,1);
});

test('simulation: sales, collections, stock, top customers and products reconcile exactly',async()=>{
 saleId=randomUUID();const sale={id:saleId,orderId,customerId:customerA.id,warehouseId:warehouse.id,paid:15};
 await post('/api/sales',sale);assert.equal((await client.post('/api/sales').set(admin).send(sale)).body.duplicate,true);
 assert.equal((await client.post('/api/sales').set(admin).send({...sale,id:randomUUID()})).status,409);
 await post('/api/sales/opening',{id:randomUUID(),customerId:customerA.id,amount:50});
 await post('/api/sales/receipts',{id:randomUUID(),customerId:customerA.id,amount:10});
 await post('/api/sales',{id:randomUUID(),customerId:customerB.id,warehouseId:warehouse.id,repId:repB.id,paid:0,lines:[{productId:itemA.id,qty:3,price:12}]});
 await post('/api/sales',{id:randomUUID(),customerId:customerB.id,warehouseId:warehouse.id,repId:null,paid:0,lines:[{productId:itemB.id,qty:5,price:5}]});
 const invalidRep=await client.post('/api/sales').set(admin).send({id:randomUUID(),customerId:customerB.id,warehouseId:warehouse.id,repId:randomUUID(),paid:0,lines:[{productId:itemA.id,qty:1,price:5}]});assert.equal(invalidRep.status,409);assert.equal(invalidRep.body.code,'REP');
 const bad=await client.post('/api/sales').set(admin).send({id:randomUUID(),customerId:customerB.id,warehouseId:warehouse.id,repId:repA.id,paid:0,lines:[{productId:itemA.id,qty:999,price:5}]});assert.equal(bad.status,409);
 let r=await get();assert.equal(r.sales,101);assert.equal(r.salesCount,3);assert.equal(r.customerCount,2);assert.equal(r.unassignedCount,1);assert.equal(r.unassignedSales,25);
 assert.equal(r.reps.find((x:any)=>x.id===repA.id).sales,40);assert.equal(r.reps.find((x:any)=>x.id===repB.id).sales,36);
 assert.equal(r.customers[0].id,customerB.id);assert.equal(r.customers[0].amount,61);assert.equal(r.customers[1].amount,40);
 assert.equal(r.customers[0].items.find((x:any)=>x.id===itemB.id).qty,5);
 assert.equal(r.productsByValue[0].id,itemA.id);assert.equal(r.productsByValue[0].amount,56);assert.equal(r.productsByValue[0].qty,5);
 assert.equal(r.productsByValue[0].consumers[0].id,customerB.id);assert.equal(r.productsByValue[0].consumers[0].qty,3);assert.equal(r.productsByValue[0].consumers[1].id,customerA.id);
 assert.equal(r.productsByQty[0].id,itemB.id);assert.equal(r.productsByQty[0].qty,6);assert.equal(r.productsByQty[0].amount,45);
 const stock=(await client.get(`/api/warehouse/stock?warehouseId=${warehouse.id}`).set(admin)).body.stock;
 assert.equal(stock.find((x:any)=>x.id===itemA.id).qty,95);assert.equal(stock.find((x:any)=>x.id===itemB.id).qty,94);
 const statement=(await client.get(`/api/sales/statement/${customerA.id}`).set(admin)).body;assert.equal(statement.due,65);assert.equal(statement.sales[0].total,40);
 // Moving the client must not transfer the old sale to the other engineer.
 await post(`/api/customers/${customerA.id}/assign`,{repId:repB.id});r=await get();assert.equal(r.reps.find((x:any)=>x.id===repA.id).sales,40);
});

test('existing order-backed history falls back to its surviving order; deleted engineer becomes unassigned',async()=>{
 instance.store.run('DELETE FROM office_sale_rep_v1 WHERE sale_id=?',saleId); // simulate sales written before this migration
 const replay=await client.post('/api/sales').set(admin).send({id:saleId,orderId,customerId:customerA.id,warehouseId:warehouse.id,paid:15});
 assert.equal(replay.status,200);assert.equal(replay.body.duplicate,true); // old request shape remains replayable
 let r=await get();assert.equal(r.reps.find((x:any)=>x.id===repA.id).sales,40);assert.equal(r.legacyOrders,1);
 const gone=await client.delete(`/api/reps/${repA.id}`).set(admin).send({confirm:true});assert.equal(gone.status,200,JSON.stringify(gone.body));
 r=await get();assert.equal(r.sales,101);assert.equal(r.unassignedCount,2);assert.equal(r.unassignedSales,65);
});

test('only full office accounts see analysis and invalid date ranges are rejected',async()=>{
 assert.equal((await client.get(`/api/sales-insights?from=${day}&to=${day}`).set(repAuth)).status,401); // engineer deleted above
 const staff=await post('/api/staff',{name:'حساب مخازن',email:'store@analysis.test',password:'Password12345!',accessScope:'warehouse'});
 assert.ok(staff.user.id);const whToken=(await post('/api/auth/login',{email:'store@analysis.test',password:'Password12345!'})).token;
 assert.equal((await client.get(`/api/sales-insights?from=${day}&to=${day}`).set('Authorization',`Bearer ${whToken}`)).status,403);
 assert.equal((await client.get('/api/sales-insights?from=2026-02-30&to=2026-03-01').set(admin)).status,400);
 assert.equal((await client.get('/api/sales-insights?from=2024-01-01&to=2026-01-01').set(admin)).status,400);
});


test('period boundaries follow the company timezone and never count an outside sale',async()=>{
 const bounds=dayBounds('2025-01-05','Africa/Cairo');
 const before=Number(instance.store.get('SELECT created_at FROM office_sales_v1 WHERE id=?',saleId)?.created_at);
 try {
   instance.store.run('UPDATE office_sales_v1 SET created_at=? WHERE id=?',bounds.start,saleId);
   let r=await client.get('/api/sales-insights?from=2025-01-05&to=2025-01-05').set(admin);
   assert.equal(r.body.sales,40);assert.equal(r.body.salesCount,1);assert.equal(r.body.productsByValue.reduce((n:number,p:any)=>n+p.amount,0),40);
   instance.store.run('UPDATE office_sales_v1 SET created_at=? WHERE id=?',bounds.end,saleId);
   r=await client.get('/api/sales-insights?from=2025-01-05&to=2025-01-05').set(admin);assert.equal(r.body.sales,0);
   r=await client.get('/api/sales-insights?from=2025-01-06&to=2025-01-06').set(admin);assert.equal(r.body.sales,40);
 } finally {instance.store.run('UPDATE office_sales_v1 SET created_at=? WHERE id=?',before,saleId);}
});

test('deleting an engineer never transfers their direct sale to a different engineer',async()=>{
 const gone=await client.delete(`/api/reps/${repB.id}`).set(admin).send({confirm:true});assert.equal(gone.status,200,JSON.stringify(gone.body));
 const r=await get();assert.equal(r.sales,101);assert.equal(r.salesCount,3);assert.equal(r.unassignedCount,3);assert.equal(r.unassignedSales,101);
 const statement=(await client.get(`/api/sales/statement/${customerB.id}`).set(admin)).body;
 assert.ok(statement.sales.some((s:any)=>s.repName===repB.name && s.repDeleted===1));
});
