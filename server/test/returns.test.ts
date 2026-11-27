import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

const app=createApp({dbPath:':memory:',production:false,adminEmail:'returns@test.local',adminPassword:'AdminPassword123!',loginRateLimit:{windowMs:60000,limit:5000},loginAccountLimit:500});
const client=request(app.app); test.after(async()=>app.close());
const login=await client.post('/api/auth/login').send({email:'returns@test.local',password:'AdminPassword123!'});
const auth={Authorization:`Bearer ${login.body.token}`};
async function post(path:string, body:object) {const r=await client.post(path).set(auth).send(body);assert.equal(r.status,201,JSON.stringify(r.body));return r.body;}
const warehouse=(await post('/api/warehouse/warehouses',{name:'مخزن البيع'})).warehouse.id;
const product=(await post('/api/warehouse/products',{name:'منتج المرتجع',category:'other',unit:'عبوة',unitSize:'١ لتر'})).product.id;
await post('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:product,toWarehouseId:warehouse,qty:10});
const customer=(await post('/api/customers',{name:'عميل المرتجع'})).customer.id;
const sale=randomUUID();await post('/api/sales',{id:sale,customerId:customer,warehouseId:warehouse,paid:500,lines:[{productId:product,qty:5,price:100}]});
const url=`/api/sales/corrections/sale/${sale}`;
const getDetail=async()=>(await client.get(url).set(auth)).body;
const stock=async(w:string)=>(await client.get(`/api/warehouse/stock?warehouseId=${w}`).set(auth)).body.stock.find((p:any)=>p.id===product).qty;

test('mixed return restores only good stock and isolates damage, preserving original invoice and money',async()=>{
 const d=await getDetail();const input={id:randomUUID(),reason:'مرتجع سليم وتالف',balancePiasters:d.balancePiasters,revision:d.revision,lines:[{lineId:d.lines[0].id,correctedMilli:3000,returnedMilli:3000,damagedMilli:2000,stockKind:'returned'}],cash:null};
 const result=await client.post(url).set(auth).send(input);assert.equal(result.status,201,JSON.stringify(result.body));
 const again=await client.post(url).set(auth).send(input);assert.equal(again.status,200);assert.equal(again.body.duplicate,true);
 const warehouses=(await client.get('/api/warehouse/warehouses').set(auth)).body.warehouses;
 const damage=warehouses.find((w:any)=>w.damaged);assert.ok(damage);assert.equal(warehouses.filter((w:any)=>w.damaged).length,1);
 assert.equal(await stock(warehouse),6);assert.equal(await stock(damage.id),2);
 const detail=await getDetail();assert.equal(detail.record.total,50000);assert.equal(detail.record.paid,50000);
 assert.equal(detail.balancePiasters,-30000);assert.equal(detail.lines[0].corrected,3000);assert.equal(detail.lines[0].returned,3000);
 assert.equal(detail.events[0].lines[0].damaged,2000);assert.equal(detail.events[0].lines[0].damagedWarehouseName,damage.name);
 const pdf=await client.get(`/api/sales/invoice/${sale}/pdf?version=${detail.version}`).set(auth);assert.equal(pdf.status,200);assert.match(pdf.headers['content-type'],/application\/pdf/);assert.ok(pdf.body.length>1000);
 const statement=(await client.get(`/api/sales/statement/${customer}`).set(auth)).body;assert.equal(statement.credit,300);
 const options=(await client.get('/api/sales/options').set(auth)).body;assert.ok(!options.warehouses.some((w:any)=>w.id===damage.id));
 const low=(await client.get('/api/warehouse/low-stock').set(auth)).body.items;assert.ok(!low.some((w:any)=>w.warehouseId===damage.id));
 const saleFromDamage=await client.post('/api/sales').set(auth).send({id:randomUUID(),customerId:customer,warehouseId:damage.id,paid:0,lines:[{productId:product,qty:1,price:100}]});assert.equal(saleFromDamage.status,409);assert.equal(saleFromDamage.body.code,'WAREHOUSE');
 const transfer=await client.post('/api/warehouse/movements').set(auth).send({id:randomUUID(),kind:'transfer',productId:product,fromWarehouseId:damage.id,toWarehouseId:warehouse,qty:1});assert.equal(transfer.status,409);assert.equal(transfer.body.code,'DAMAGED_READ_ONLY');
 assert.equal(await stock(damage.id),2);assert.equal(await stock(warehouse),6);
 const movements=(await client.get(`/api/warehouse/movements?warehouseId=${damage.id}`).set(auth)).body.movements;assert.equal(movements.length,1);assert.match(movements[0].note,new RegExp(`مرتجع تالف.*الفاتورة رقم ${detail.record.invoiceNumber}`));
 const goodMoves=(await client.get(`/api/warehouse/movements?warehouseId=${warehouse}`).set(auth)).body.movements;assert.ok(goodMoves.some((m:any)=>m.note.includes(`الفاتورة رقم ${detail.record.invoiceNumber}`)&&m.note.includes('إرجاع بضاعة سليمة')));
});

test('invalid or excessive returns never change balances, and cash refund is explicit',async()=>{
 const d=await getDetail();const base={id:randomUUID(),reason:'مرتجع آخر للتجربة',balancePiasters:d.balancePiasters,revision:d.revision,cash:null};
 for(const line of [
  {lineId:d.lines[0].id,correctedMilli:2001,returnedMilli:2001,damagedMilli:0,stockKind:'returned'},
  {lineId:d.lines[0].id,correctedMilli:1000,returnedMilli:1000,damagedMilli:1001,stockKind:'returned'},
  {lineId:d.lines[0].id,correctedMilli:1000,returnedMilli:1000,damagedMilli:1,stockKind:'error'},
 ]) assert.equal((await client.post(url).set(auth).send({...base,lines:[line]})).status,409);
 assert.equal((await getDetail()).balancePiasters,-30000);
 await post(url,{...base,lines:[],cash:{kind:'refund',amountPiasters:10000}});
 assert.equal((await getDetail()).balancePiasters,-20000);
});

test('a delayed damaged return does not correct the customer account twice',async()=>{
 let d=await getDetail();
 await post(url,{id:randomUUID(),reason:'تصحيح بيع قبل استلام البضاعة',balancePiasters:d.balancePiasters,revision:d.revision,lines:[{lineId:d.lines[0].id,correctedMilli:1000,returnedMilli:0,stockKind:null}],cash:null});
 d=await getDetail();assert.equal(d.balancePiasters,-30000);
 const late={id:randomUUID(),reason:'استلام تالف بعد التصحيح',balancePiasters:d.balancePiasters,revision:d.revision,lines:[{lineId:d.lines[0].id,correctedMilli:0,returnedMilli:1000,damagedMilli:1000,stockKind:'returned'}],cash:null};
 await post(url,late);assert.equal((await getDetail()).balancePiasters,-30000);
 assert.equal((await client.post(url).set(auth).send({...late,id:randomUUID()})).body.code,'STALE');
 const damaged=(await client.get('/api/warehouse/warehouses').set(auth)).body.warehouses.find((w:any)=>w.damaged);
 assert.equal(await stock(damaged.id),3);
 for(const movement of [
  {kind:'out',fromWarehouseId:damaged.id},
  {kind:'in',toWarehouseId:damaged.id},
  {kind:'transfer',fromWarehouseId:warehouse,toWarehouseId:damaged.id},
 ]) { const r=await client.post('/api/warehouse/movements').set(auth).send({id:randomUUID(),productId:product,qty:1,...movement});assert.equal(r.body.code,'DAMAGED_READ_ONLY'); }
 const create=await client.post('/api/warehouse/stock-items').set(auth).send({id:randomUUID(),warehouseId:damaged.id,product:{name:'منتج آخر',category:'other',unit:'عبوة',unitSize:''},qty:1});assert.equal(create.body.code,'DAMAGED_READ_ONLY');
});

test('failed mixed return rolls back all stock and accounting entries',async()=>{
 const p=(await post('/api/warehouse/products',{name:'منتج ثانٍ للذرية',category:'other',unit:'عبوة'})).product.id;
 await post('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:p,toWarehouseId:warehouse,qty:2});
 const id=randomUUID();await post('/api/sales',{id,customerId:customer,warehouseId:warehouse,paid:0,lines:[{productId:product,qty:1,price:10},{productId:p,qty:1,price:10}]});
 const path=`/api/sales/corrections/sale/${id}`;const d=(await client.get(path).set(auth)).body;
 const damaged=(await client.get('/api/warehouse/warehouses').set(auth)).body.warehouses.find((w:any)=>w.damaged);const before=await stock(damaged.id);
 app.store.run('DELETE FROM warehouse_stock WHERE warehouse_id=? AND product_id=?',warehouse,p);
 const r=await client.post(path).set(auth).send({id:randomUUID(),reason:'فحص التراجع الكامل',balancePiasters:d.balancePiasters,revision:d.revision,lines:[{lineId:d.lines[0].id,correctedMilli:1000,returnedMilli:1000,damagedMilli:1000,stockKind:'returned'},{lineId:d.lines[1].id,correctedMilli:1000,returnedMilli:1000,stockKind:'returned'}],cash:null});
 assert.equal(r.body.code,'STOCK');assert.equal(await stock(damaged.id),before);
 const after=(await client.get(path).set(auth)).body;assert.equal(after.revision,0);assert.equal(after.balancePiasters,d.balancePiasters);
});

test('partial split returns, fractional rounding, sale refund and later receipt refund reconcile',async()=>{
 const w=(await post('/api/warehouse/warehouses',{name:'مخزن مرتجع الكسور'})).warehouse.id;
 const c=(await post('/api/customers',{name:'عميل مرتجع الكسور'})).customer.id;
 await post('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:product,toWarehouseId:w,qty:5});
 const id=randomUUID();await post('/api/sales',{id,customerId:c,warehouseId:w,paid:3,lines:[{productId:product,qty:2.5,price:3.33}]});
 const receipt=randomUUID();await post('/api/sales/receipts',{id:receipt,customerId:c,amount:2});
 const path=`/api/sales/corrections/sale/${id}`;let d=(await client.get(path).set(auth)).body;
 assert.equal(d.record.total,833);assert.equal(d.balancePiasters,333);
 const operation={id:randomUUID(),reason:'مرتجع جزئي مختلط ورد مبلغ',balancePiasters:d.balancePiasters,revision:d.revision,lines:[{lineId:d.lines[0].id,correctedMilli:1000,returnedMilli:1000,damagedMilli:500,stockKind:'returned'}],cash:{kind:'refund',amountPiasters:200}};
 await post(path,operation);
 assert.equal((await client.post(path).set(auth).send({...operation,lines:[{...operation.lines[0],damagedMilli:1000}]})).status,409);
 d=(await client.get(path).set(auth)).body;assert.equal(d.balancePiasters,200);assert.equal(d.events[0].lines[0].amount,333);assert.equal(d.events[0].cash,200);
 const invalid=await client.post(path).set(auth).send({...operation,id:randomUUID(),revision:d.revision,balancePiasters:d.balancePiasters,lines:[operation.lines[0],operation.lines[0]]});assert.equal(invalid.body.code,'LINES');
 await post(path,{id:randomUUID(),reason:'تصحيح نصف وحدة قبل الاستلام',revision:d.revision,balancePiasters:d.balancePiasters,lines:[{lineId:d.lines[0].id,correctedMilli:500,returnedMilli:0,stockKind:null}],cash:null});
 d=(await client.get(path).set(auth)).body;assert.equal(d.balancePiasters,33);assert.equal(d.events[1].lines[0].amount,167);
 await post(path,{id:randomUUID(),reason:'استلام التالف بعد التصحيح',revision:d.revision,balancePiasters:d.balancePiasters,lines:[{lineId:d.lines[0].id,correctedMilli:0,returnedMilli:500,damagedMilli:500,stockKind:'returned'}],cash:null});
 d=(await client.get(path).set(auth)).body;assert.equal(d.balancePiasters,33);assert.equal(d.events[2].lines[0].amount,0);assert.equal(d.lines[0].correctedAmount,500);
 const damaged=(await client.get('/api/warehouse/warehouses').set(auth)).body.warehouses.find((x:any)=>x.damaged);
 assert.equal(await stock(w),3);assert.equal(await stock(damaged.id),4);
 const receiptPath=`/api/sales/corrections/receipt/${receipt}`,r=(await client.get(receiptPath).set(auth)).body;
 await post(receiptPath,{id:randomUUID(),reason:'رد جزء من الدفعة اللاحقة',revision:r.revision,balancePiasters:r.balancePiasters,lines:[],cash:{kind:'refund',amountPiasters:100}});
 const statement=(await client.get(`/api/sales/statement/${c}`).set(auth)).body;assert.equal(statement.balance,1.33);
 const detail=(await client.get(path).set(auth)).body;assert.equal(detail.cashRemaining,100);assert.equal(detail.record.paid,300);
 const ranking=(await client.get(`/api/sales/customer-ranking/${c}`).set(auth)).body;assert.equal(ranking.customer.purchases,3.33);assert.equal(ranking.due,1.33);
});

test('race and stale protection prevent duplicated split stock movements and refund',async()=>{
 const w=(await post('/api/warehouse/warehouses',{name:'مخزن مرتجع السباق'})).warehouse.id;
 const c=(await post('/api/customers',{name:'عميل مرتجع السباق'})).customer.id;
 await post('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:product,toWarehouseId:w,qty:4});
 const id=randomUUID();await post('/api/sales',{id,customerId:c,warehouseId:w,paid:20,lines:[{productId:product,qty:2,price:10}]});
 const path=`/api/sales/corrections/sale/${id}`,d=(await client.get(path).set(auth)).body;
 const operation={id:randomUUID(),reason:'مرتجع باختبار تداخل المعاملات',revision:d.revision,balancePiasters:d.balancePiasters,lines:[{lineId:d.lines[0].id,correctedMilli:2000,returnedMilli:2000,damagedMilli:1000,stockKind:'returned'}],cash:{kind:'refund',amountPiasters:500}};
 const original=app.store.transaction.bind(app.store);app.store.transaction=fn=>{original(fn);original(fn);};
 let r;try{r=await client.post(path).set(auth).send(operation);}finally{app.store.transaction=original;}
 assert.equal(r.status,200);assert.equal(r.body.duplicate,true);
 const after=(await client.get(path).set(auth)).body;assert.equal(after.revision,1);assert.equal(after.balancePiasters,-1500);assert.equal(after.cashRemaining,1500);
 assert.equal((await client.post(path).set(auth).send({...operation,id:randomUUID()})).body.code,'STALE');
 assert.equal(await stock(w),3);const damaged=(await client.get('/api/warehouse/warehouses').set(auth)).body.warehouses.find((x:any)=>x.damaged);assert.equal(await stock(damaged.id),5);
 assert.equal(Number(app.store.get('SELECT COUNT(*) AS n FROM inventory_movements WHERE note LIKE ?',`%${operation.id}%`)?.n),2);
});
