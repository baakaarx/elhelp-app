import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {localDate} from '../src/geo.js';

const instance=createApp({dbPath:':memory:',production:false,timezone:'Africa/Cairo',adminEmail:'corrections@test.local',adminPassword:'AdminPassword123!',loginAccountLimit:500,loginRateLimit:{windowMs:60000,limit:5000}});
const client=request(instance.app);test.after(async()=>await instance.close());
const login=await client.post('/api/auth/login').send({email:'corrections@test.local',password:'AdminPassword123!'});const auth={Authorization:`Bearer ${login.body.token}`};
const send=async(path:string,body:object)=>{const r=await client.post(path).set(auth).send(body);assert.ok(r.status<300,`${path}: ${r.status} ${JSON.stringify(r.body)}`);return r.body;};
const get=async(path:string)=>{const r=await client.get(path).set(auth);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
const warehouse=(await send('/api/warehouse/warehouses',{name:'مخزن تصحيح'})).warehouse;
const product=(await send('/api/warehouse/products',{name:'صنف تصحيح',category:'other',unit:'عبوة'})).product;
await send('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:product.id,toWarehouseId:warehouse.id,qty:10});
const customer=(await send('/api/customers',{name:'عميل تصحيح',phone:'01000000000'})).customer;
const sale=randomUUID();await send('/api/sales',{id:sale,customerId:customer.id,warehouseId:warehouse.id,paid:30,lines:[{productId:product.id,qty:2,price:50}]});
const receipt=randomUUID();await send('/api/sales/receipts',{id:receipt,customerId:customer.id,amount:20});
const detail=(type:string,id:string)=>get(`/api/sales/corrections/${type}/${id}`);
const stmt=()=>get(`/api/sales/statement/${customer.id}`);
const stock=async()=>(await get(`/api/warehouse/stock?warehouseId=${warehouse.id}`)).stock.find((x:any)=>x.id===product.id).qty;
const payload=(d:any,lines:any[]=[],cash:any=null)=>({id:randomUUID(),reason:'تصحيح موثق للتجربة',balancePiasters:d.balancePiasters,revision:d.revision,lines,cash});
const url=(type:string,id:string)=>`/api/sales/corrections/${type}/${id}`;

test('invoice uses frozen details and retains original values',async()=>{
 await client.patch(`/api/customers/${customer.id}`).set(auth).send({name:'اسم جديد للعميل'});
 const d=await detail('sale',sale);assert.equal(d.snapshot.customerName,'عميل تصحيح');assert.equal(d.record.total,10000);assert.equal(d.record.paid,3000);assert.equal(d.lines[0].amount,10000);assert.equal(d.balancePiasters,5000);assert.equal(await stock(),8);
});
test('partial correction and later physical return, with retries and stale protection',async()=>{
 let d=await detail('sale',sale);const line=d.lines[0];
 const bad=payload(d,[{lineId:line.id,correctedMilli:500,returnedMilli:501,stockKind:'returned'}]);assert.equal((await client.post(url('sale',sale)).set(auth).send(bad)).status,409);assert.equal(await stock(),8);
 const op=payload(d,[{lineId:line.id,correctedMilli:500,returnedMilli:0,stockKind:null}]);assert.equal((await client.post(url('sale',sale)).set(auth).send(op)).status,201);
 assert.equal((await client.post(url('sale',sale)).set(auth).send(op)).body.duplicate,true);
 assert.equal((await client.post(url('sale',sale)).set(auth).send({...op,reason:'تغيير العملية'})).status,409);
 assert.equal((await client.post(url('sale',sale)).set(auth).send({...op,id:randomUUID()})).body.code,'STALE');
 d=await detail('sale',sale);assert.equal(d.lines[0].corrected,500);assert.equal(d.lines[0].returned,0);assert.equal(d.lines[0].correctedAmount,2500);assert.equal(d.balancePiasters,2500);
 let o=await get('/api/sales/overview');assert.equal(o.sales,75);assert.equal(o.collected,50);assert.equal(o.soldItems[0].qty,1.5);
 const day=localDate('Africa/Cairo');const insight=await get(`/api/sales-insights?from=${day}&to=${day}`);assert.equal(insight.sales,75);assert.equal(insight.productsByValue[0].qty,1.5);
 await send(url('sale',sale),payload(d,[{lineId:line.id,correctedMilli:0,returnedMilli:500,stockKind:'returned'}]));assert.equal(await stock(),8.5);
 d=await detail('sale',sale);assert.equal(d.lines[0].returned,500);assert.equal(d.balancePiasters,2500);
});
test('incorrect payment and later cash refund affect cash and balance but not original',async()=>{
 let d=await detail('sale',sale);await send(url('sale',sale),payload(d,[],{kind:'error',amountPiasters:1000}));
 d=await detail('sale',sale);assert.equal(d.cashRemaining,2000);assert.equal(d.balancePiasters,3500);assert.equal(d.record.paid,3000);
 await send(url('sale',sale),payload(d,[],{kind:'refund',amountPiasters:500}));
 d=await detail('sale',sale);assert.equal(d.cashRemaining,1500);assert.equal(d.balancePiasters,4000);assert.deepEqual(d.events.slice(-2).map((x:any)=>x.cashKind),['error','refund']);
 const excessive=payload(d,[],{kind:'refund',amountPiasters:1501});assert.equal((await client.post(url('sale',sale)).set(auth).send(excessive)).body.code,'CASH');
 let r=await detail('receipt',receipt);await send(url('receipt',receipt),payload(r,[],{kind:'refund',amountPiasters:2000}));
 r=await detail('receipt',receipt);assert.equal(r.cashRemaining,0);assert.equal(r.balancePiasters,6000);assert.equal((await stmt()).due,60);
 const o=await get('/api/sales/overview');assert.equal(o.sales,75);assert.equal(o.collected,15);
});
test('full reversal creates customer credit and all reports agree',async()=>{
 let d=await detail('sale',sale);await send(url('sale',sale),payload(d,[{lineId:d.lines[0].id,correctedMilli:1500,returnedMilli:1500,stockKind:'returned'}]));
 d=await detail('sale',sale);assert.equal(d.balancePiasters,-1500);assert.equal(await stock(),10);
 const s=await stmt();assert.equal(s.credit,15);assert.equal(s.due,0);assert.equal(s.sales[0].corrected,true);
 const o=await get('/api/sales/overview');assert.equal(o.sales,0);assert.equal(o.count,0);assert.equal(o.collected,15);assert.equal(o.credit,15);assert.equal(o.soldItems.length,0);
 const day=localDate('Africa/Cairo');const insight=await get(`/api/sales-insights?from=${day}&to=${day}`);assert.equal(insight.sales,0);assert.equal(insight.salesCount,0);assert.equal(insight.productsByValue.length,0);
 d=await detail('sale',sale);await send(url('sale',sale),payload(d,[],{kind:'refund',amountPiasters:1500}));assert.equal((await stmt()).balance,0);
});
test('cumulative rounding is invariant to splitting fractional corrections',async()=>{
 const c=(await send('/api/customers',{name:'تقريب'})).customer,id=randomUUID();await send('/api/sales',{id,customerId:c.id,warehouseId:warehouse.id,paid:0,lines:[{productId:product.id,qty:0.003,price:5}]});
 for(let i=0;i<3;i++){const d=await detail('sale',id);await send(url('sale',id),payload(d,[{lineId:d.lines[0].id,correctedMilli:1,returnedMilli:0,stockKind:null}]));}
 const d=await detail('sale',id);assert.equal(d.lines[0].amount,2);assert.equal(d.lines[0].correctedAmount,2);assert.equal(d.balancePiasters,0);
});
test('rollback restores stock and correction entries on failure',async()=>{
 const c=(await send('/api/customers',{name:'فشل الذرية'})).customer;
 const p=(await send('/api/warehouse/products',{name:'صنف ثاني',category:'other',unit:'عبوة'})).product;
 await send('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:p.id,toWarehouseId:warehouse.id,qty:10});
 const id=randomUUID();await send('/api/sales',{id,customerId:c.id,warehouseId:warehouse.id,paid:0,lines:[{productId:product.id,qty:1,price:5},{productId:p.id,qty:1,price:5}]});
 const d=await detail('sale',id),before=await stock();instance.store.run('DELETE FROM warehouse_stock WHERE warehouse_id=? AND product_id=?',warehouse.id,p.id);
 const op=payload(d,d.lines.map((l:any)=>({lineId:l.id,correctedMilli:1000,returnedMilli:1000,stockKind:'returned'})));
 assert.equal((await client.post(url('sale',id)).set(auth).send(op)).body.code,'STOCK');assert.equal(await stock(),before);assert.equal((await detail('sale',id)).revision,0);assert.equal((await detail('sale',id)).balancePiasters,1000);
});
test('legacy snapshot is absent and office permission is required',async()=>{
 instance.store.run('DELETE FROM office_invoice_snapshots_v1 WHERE sale_id=?',sale);const d=await detail('sale',sale);assert.equal(d.snapshot,null);assert.equal(d.record.currentName,'اسم جديد للعميل');
 await send('/api/staff',{name:'مخازن',email:'store@correction.test',password:'Password12345!',accessScope:'warehouse'});
 const token=(await send('/api/auth/login',{email:'store@correction.test',password:'Password12345!'})).token;
 assert.equal((await client.get(url('sale',sale)).set('Authorization',`Bearer ${token}`)).status,403);
 assert.equal((await client.post(url('sale',sale)).set('Authorization',`Bearer ${token}`).send({})).status,403);
});
test('competing corrections with the same revision cannot both deduct or return stock',async()=>{
 const c=(await send('/api/customers',{name:'عميل تنافس'})).customer,id=randomUUID();
 await send('/api/sales',{id,customerId:c.id,warehouseId:warehouse.id,paid:0,lines:[{productId:product.id,qty:1,price:5}]});
 const d=await detail('sale',id),before=await stock();
 const mk=()=>payload(d,[{lineId:d.lines[0].id,correctedMilli:1000,returnedMilli:1000,stockKind:'returned'}]);
 const [a,b]=await Promise.all([client.post(url('sale',id)).set(auth).send(mk()),client.post(url('sale',id)).set(auth).send(mk())]);
 assert.deepEqual([a.status,b.status].sort(),[201,409]);assert.equal(await stock(),before+1);assert.equal((await detail('sale',id)).revision,1);assert.equal((await detail('sale',id)).balancePiasters,0);
});
test('statement paginates older sales and payments independently',async()=>{
 const c=(await send('/api/customers',{name:'عميل صفحات'})).customer;
 const sales:string[]=[],receipts:string[]=[];
 for(let i=0;i<101;i++){
  const id=randomUUID(),rid=randomUUID();sales.push(id);receipts.push(rid);
  instance.store.run('INSERT INTO office_sales_v1 VALUES(?,?,?,?,?,?,?,?,?,?)',id,null,c.id,warehouse.id,100,0,null,'اختبار','{}',i);
  instance.store.run('INSERT INTO office_sales_lines_v1 VALUES(?,?,?,?,?,?,?,?,?)',randomUUID(),id,product.id,'صنف','عبوة','',1000,100,100);
  instance.store.run('INSERT INTO office_receipts_v1 VALUES(?,?,?,?,?,?,?)',rid,c.id,1,null,'اختبار','{}',i);
 }
 const first=await get(`/api/sales/statement/${c.id}`);assert.equal(first.sales.length,100);assert.equal(first.receipts.length,100);assert.equal(first.moreSales,true);assert.equal(first.moreReceipts,true);
 const older=await get(`/api/sales/statement/${c.id}?salesOffset=100&receiptsOffset=100`);assert.equal(older.sales[0].id,sales[0]);assert.equal(older.receipts[0].id,receipts[0]);assert.equal(older.moreSales,false);assert.equal(older.moreReceipts,false);
 assert.equal((await client.get(`/api/sales/statement/${c.id}?salesOffset=-1`).set(auth)).status,400);
});

test('stock deduction error is recorded distinctly from an actual return',async()=>{
 const c=(await send('/api/customers',{name:'خصم مخزون خطأ'})).customer,id=randomUUID();await send('/api/sales',{id,customerId:c.id,warehouseId:warehouse.id,paid:0,lines:[{productId:product.id,qty:1,price:5}]});
 const d=await detail('sale',id),before=await stock();
 const unspecified=payload(d,[{lineId:d.lines[0].id,correctedMilli:1000,returnedMilli:1000,stockKind:null}]);assert.equal((await client.post(url('sale',id)).set(auth).send(unspecified)).body.code,'LINES');
 const op=payload(d,[{lineId:d.lines[0].id,correctedMilli:1000,returnedMilli:1000,stockKind:'error'}]);await send(url('sale',id),op);const after=await detail('sale',id);assert.equal(after.events[0].lines[0].stockKind,'error');assert.equal(await stock(),before+1);
});

test('past-period reports show current net sale state rather than attributing the correction to today',async()=>{
 const c=(await send('/api/customers',{name:'عميل تاريخ التصحيح'})).customer,id=randomUUID();await send('/api/sales',{id,customerId:c.id,warehouseId:warehouse.id,paid:0,lines:[{productId:product.id,qty:1,price:5}]});
 instance.store.run('UPDATE office_sales_v1 SET created_at=? WHERE id=?',Date.parse('2025-01-02T10:00:00Z'),id);
 const d=await detail('sale',id);await send(url('sale',id),payload(d,[{lineId:d.lines[0].id,correctedMilli:500,returnedMilli:0,stockKind:null}]));
 const report=await get('/api/sales-insights?from=2025-01-02&to=2025-01-02');assert.equal(report.salesCount,1);assert.equal(report.sales,2.5);assert.equal(report.customers[0].items[0].qty,0.5);
});
