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
 assert.equal((await client.post(`/api/orders/${orderId}/price`).set(auth).send({lines:[{productId:prod,price:9}]})).status,410);
 assert.equal((await overview()).sales,25.63);
 const input={id:randomUUID(),orderId,customerId:customer,warehouseId:wh,paid:0,lines:[{productId:prod,qty:1,price:9}]};
 assert.equal((await client.post('/api/sales').set(auth).send(input)).status,201);
 assert.equal((await client.post('/api/sales').set(auth).send({...input,id:randomUUID()})).status,409);
 assert.equal((await overview()).sales,34.63);assert.equal(await stock(),6.5);
});

test('warehouse account and engineer cannot see financial data or record sales',async()=>{
 await client.post('/api/staff').set(auth).send({name:'مخازن',email:'wh@sales.test',password:'Warehouse12345!',accessScope:'warehouse'});
 const token=(await client.post('/api/auth/login').send({email:'wh@sales.test',password:'Warehouse12345!'})).body.token;
 for(const path of ['/api/sales/options','/api/sales/overview'])assert.equal((await client.get(path).set('Authorization',`Bearer ${token}`)).status,403);
 assert.equal((await client.post('/api/sales').set('Authorization',`Bearer ${token}`).send({})).status,403);
 assert.equal((await client.put(`/api/products/${prod}/prices`).set('Authorization',`Bearer ${token}`).send({prices:[]})).status,403);
 assert.equal((await client.post(`/api/orders/${randomUUID()}/price`).set('Authorization',`Bearer ${token}`).send({lines:[]})).status,403);
});

test('removing an engineer preserves the customer and confirmed financial history',async()=>{
 const reps=(await client.get('/api/reps').set(auth)).body.reps;
 const rep=reps.find((r:any)=>r.email==='field@sales.test');
 assert.equal((await client.delete(`/api/reps/${rep.id}`).set(auth).send({confirm:true})).status,200);
 const report=await overview();assert.equal(report.sales,34.63);assert.equal(report.due,109.13);
 assert.equal(report.debtors.find((r:any)=>r.id===customer).name,'عميل مبيعات');
 assert.equal((await client.delete(`/api/customers/${customer}`).set(auth)).status,409);
});

test('customer statement shows the recorded opening, sales, line items and receipts',async()=>{
 const statement=await client.get(`/api/sales/statement/${customer}`).set(auth);
 assert.equal(statement.status,200); assert.equal(statement.body.opening.amount,100);
 assert.equal(statement.body.due,109.13);assert.equal(statement.body.sales.length,2);
 assert.equal(statement.body.sales[1].lines[0].price,10.25);assert.equal(statement.body.sales[1].lines[0].qty,2.5);
 assert.equal(statement.body.receipts[0].amount,20.5);
 const token=(await client.post('/api/auth/login').send({email:'wh@sales.test',password:'Warehouse12345!'})).body.token;
 assert.equal((await client.get(`/api/sales/statement/${customer}`).set('Authorization',`Bearer ${token}`)).status,403);
});

test('competing receipts cannot overpay a customer balance',async()=>{
 const cust=(await client.post('/api/customers').set(auth).send({name:'عميل دفعات متزامنة'})).body.customer.id;
 await client.post('/api/sales/opening').set(auth).send({id:randomUUID(),customerId:cust,amount:100});
 const results=await Promise.all([1,2].map(()=>client.post('/api/sales/receipts').set(auth).send({id:randomUUID(),customerId:cust,amount:70})));
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 assert.equal((await client.get(`/api/sales/statement/${cust}`).set(auth)).body.due,30);
});

test('a priced order whose rounded total differs is not silently changed into a sale',async()=>{
 const rep=(await client.post('/api/reps').set(auth).send({name:'مهندس تقريب',email:'round@sales.test',password:'Password12345!',region:'طنطا'})).body.user.id;
 const cust=(await client.post('/api/customers').set(auth).send({name:'عميل تقريب',repId:rep})).body.customer.id;
 const second=(await client.post('/api/warehouse/products').set(auth).send({name:'صنف تقريب',category:'other',unit:'عبوة'})).body.product.id;
 await client.post('/api/warehouse/movements').set(auth).send({id:randomUUID(),kind:'opening',productId:second,toWarehouseId:wh,qty:1});
 const repAuth={Authorization:`Bearer ${(await client.post('/api/auth/login').send({email:'round@sales.test',password:'Password12345!'})).body.token}`};
 const orderId=randomUUID();
 assert.equal((await client.post('/api/orders').set(repAuth).send({id:orderId,customerId:cust,lines:[{productId:prod,qty:0.005},{productId:second,qty:0.005}],send:true})).status,201);
 // Simulate an immutable historical priced order from before order pricing was disabled.
 app.store.run("UPDATE orders SET status='priced',total=0.01 WHERE id=?",orderId);
 app.store.run('UPDATE order_lines SET price=1 WHERE order_id=?',orderId);
 const before=await stock();const sale=await client.post('/api/sales').set(auth).send({id:randomUUID(),orderId,customerId:cust,warehouseId:wh,paid:0});
 assert.equal(sale.status,409);assert.equal(sale.body.code,'ORDER_TOTAL');assert.equal(await stock(),before);
 assert.equal((await client.get(`/api/sales/statement/${cust}`).set(auth)).body.sales.length,0);
});

test('two simultaneous submissions of the same sale id record and deduct only once',async()=>{
 const cust=(await client.post('/api/customers').set(auth).send({name:'عميل عملية متكررة'})).body.customer.id;
 const before=await stock();const input={id:randomUUID(),customerId:cust,warehouseId:wh,paid:1,lines:[{productId:prod,qty:1,price:2}]};
 const results=await Promise.all([client.post('/api/sales').set(auth).send(input),client.post('/api/sales').set(auth).send(input)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(await stock(),before-1);
 const statement=(await client.get(`/api/sales/statement/${cust}`).set(auth)).body;assert.equal(statement.sales.length,1);assert.equal(statement.due,1);
});

test('sent recommendations become one sale with office quantities, preserving the original and excluding sold orders from queues',async()=>{
 const rep=(await client.post('/api/reps').set(auth).send({name:'مهندس ترشيح',email:'recommend@sales.test',password:'Password12345!',region:'طنطا'})).body.user.id;
 const cust=(await client.post('/api/customers').set(auth).send({name:'عميل ترشيح',repId:rep})).body.customer.id;
 const second=(await client.post('/api/warehouse/products').set(auth).send({name:'ترشيح غير مباع',category:'other',unit:'عبوة'})).body.product.id;
 const repAuth={Authorization:`Bearer ${(await client.post('/api/auth/login').send({email:'recommend@sales.test',password:'Password12345!'})).body.token}`};
 const orderId=randomUUID();
 assert.equal((await client.post('/api/orders').set(repAuth).send({id:orderId,customerId:cust,notes:'راجع المزارع',lines:[{productId:prod,qty:3,notes:'ترشيح'},{productId:second,qty:7}],send:true})).status,201);
 const opts=(await client.get('/api/sales/options').set(auth)).body;assert.equal(opts.orders.find((o:any)=>o.id===orderId).status,'sent');
 assert.ok((await client.get('/api/orders?status=sent').set(auth)).body.orders.some((o:any)=>o.id===orderId));
 const before=await stock();
 const base={id:randomUUID(),customerId:cust,warehouseId:wh,orderId,paid:2,lines:[{productId:prod,qty:1.5,price:4.25}]};
 assert.equal((await client.post('/api/sales').set(repAuth).send(base)).status,403);
 assert.equal((await client.get('/api/sales/options').set(repAuth)).status,403);
 assert.equal((await client.post('/api/sales').set(auth).send({...base,id:randomUUID(),lines:[{productId:randomUUID(),qty:1,price:1}]})).body.code,'ORDER_LINES');
 assert.equal((await client.post('/api/sales').set(auth).send({...base,id:randomUUID(),lines:[]})).body.code,'ORDER_LINES');
 assert.equal((await client.post('/api/sales').set(auth).send({...base,id:randomUUID(),lines:[{productId:prod,qty:1,price:1},{productId:second,qty:1,price:1}]})).body.code,'NO_OPENING');
 assert.equal(await stock(),before);
 const results=await Promise.all([client.post('/api/sales').set(auth).send(base),client.post('/api/sales').set(auth).send(base)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
 assert.equal((await client.post('/api/sales').set(auth).send({...base,id:randomUUID()})).body.code,'ORDER_SOLD');
 assert.equal((await client.post(`/api/orders/${orderId}/price`).set(auth).send({lines:[{productId:prod,price:1},{productId:second,price:1}]})).body.code,'ORDER_PRICING_DISABLED');
 assert.equal(await stock(),before-1.5);
 const statement=(await client.get(`/api/sales/statement/${cust}`).set(auth)).body;
 assert.equal(statement.sales.length,1);assert.equal(statement.sales[0].repName,'مهندس ترشيح');assert.equal(statement.sales[0].total,6.38);assert.equal(statement.due,4.38);assert.equal(statement.sales[0].lines[0].qty,1.5);
 assert.ok(!(await client.get('/api/sales/options').set(auth)).body.orders.some((o:any)=>o.id===orderId));
 assert.ok(!(await client.get('/api/orders?status=sent').set(auth)).body.orders.some((o:any)=>o.id===orderId));
 assert.ok(!(await client.get('/api/work-priorities').set(auth)).body.waitingOrders.some((o:any)=>o.id===orderId));
 const original=(await client.get('/api/orders').set(repAuth)).body.orders.find((o:any)=>o.id===orderId);
 assert.equal(original.sold,true);assert.equal(original.status,'sent');assert.deepEqual(original.lines.map((l:any)=>l.qty),[3,7]);assert.ok(!JSON.stringify(original).includes('price'));
});

test('pricing and selling the same unpriced order cannot both commit',async()=>{
 const rep=(await client.post('/api/reps').set(auth).send({name:'مهندس تزامن',email:'race-recommend@sales.test',password:'Password12345!',region:'طنطا'})).body.user.id;
 const cust=(await client.post('/api/customers').set(auth).send({name:'عميل تزامن ترشيح',repId:rep})).body.customer.id;
 const repAuth={Authorization:`Bearer ${(await client.post('/api/auth/login').send({email:'race-recommend@sales.test',password:'Password12345!'})).body.token}`};
 const orderId=randomUUID();await client.post('/api/orders').set(repAuth).send({id:orderId,customerId:cust,lines:[{productId:prod,qty:1}],send:true});
 const before=await stock();
 const [price,sale]=await Promise.all([
  client.post(`/api/orders/${orderId}/price`).set(auth).send({lines:[{productId:prod,price:20}]}),
  client.post('/api/sales').set(auth).send({id:randomUUID(),orderId,customerId:cust,warehouseId:wh,paid:0,lines:[{productId:prod,qty:1,price:10}]})
 ]);
 assert.equal(price.status,410);assert.equal(price.body.code,'ORDER_PRICING_DISABLED');assert.equal(sale.status,201);
 assert.equal(await stock(),before-1);
});

test('competing sale IDs for the same recommendation deduct stock only once',async()=>{
 const rep=(await client.post('/api/reps').set(auth).send({name:'مهندس بيع متزامن',email:'race-two-sales@sales.test',password:'Password12345!',region:'طنطا'})).body.user.id;
 const cust=(await client.post('/api/customers').set(auth).send({name:'عميل بيع متزامن',repId:rep})).body.customer.id;
 const repAuth={Authorization:`Bearer ${(await client.post('/api/auth/login').send({email:'race-two-sales@sales.test',password:'Password12345!'})).body.token}`};
 const orderId=randomUUID();await client.post('/api/orders').set(repAuth).send({id:orderId,customerId:cust,lines:[{productId:prod,qty:1}],send:true});
 const before=await stock();const body={orderId,customerId:cust,warehouseId:wh,paid:0,lines:[{productId:prod,qty:1,price:5}]};
 const results=await Promise.all([client.post('/api/sales').set(auth).send({...body,id:randomUUID()}),client.post('/api/sales').set(auth).send({...body,id:randomUUID()})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(results.find(r=>r.status===409)?.body.code,'ORDER_SOLD');
 assert.equal(await stock(),before-1);assert.equal((await client.get(`/api/sales/statement/${cust}`).set(auth)).body.sales.length,1);
});

test('historical priced recommendations can be invoiced with new quantities and prices without altering the old record',async()=>{
 const rep=(await client.post('/api/reps').set(auth).send({name:'مهندس طلبية قديمة',email:'old-recommend@sales.test',password:'Password12345!',region:'طنطا'})).body.user.id;
 const cust=(await client.post('/api/customers').set(auth).send({name:'عميل طلبية قديمة',repId:rep})).body.customer.id;
 const repAuth={Authorization:`Bearer ${(await client.post('/api/auth/login').send({email:'old-recommend@sales.test',password:'Password12345!'})).body.token}`};
 const orderId=randomUUID();await client.post('/api/orders').set(repAuth).send({id:orderId,customerId:cust,lines:[{productId:prod,qty:2}],send:true});
 app.store.run("UPDATE orders SET status='priced',total=40 WHERE id=?",orderId);app.store.run('UPDATE order_lines SET price=20 WHERE order_id=?',orderId);
 const queue=await client.get('/api/orders?status=sent').set(auth);assert.ok(queue.body.orders.some((o:any)=>o.id===orderId));
 const before=await stock();const input={id:randomUUID(),orderId,customerId:cust,warehouseId:wh,paid:0,lines:[{productId:prod,qty:1,price:7}]};
 const result=await client.post('/api/sales').set(auth).send(input);assert.equal(result.status,201,JSON.stringify(result.body));
 assert.equal((await client.post('/api/sales').set(auth).send(input)).body.duplicate,true);assert.equal(await stock(),before-1);
 const original=app.store.get('SELECT qty,price FROM order_lines WHERE order_id=?',orderId);assert.equal(original?.qty,2);assert.equal(original?.price,20);
 const statement=(await client.get(`/api/sales/statement/${cust}`).set(auth)).body;assert.equal(statement.sales[0].total,7);assert.equal(statement.sales[0].lines[0].qty,1);
 assert.ok(!(await client.get('/api/orders?status=sent').set(auth)).body.orders.some((o:any)=>o.id===orderId));
});


test('near-zero and excess precision cannot be silently rounded in sales, receipts or openings',async()=>{
 const cust=(await client.post('/api/customers').set(auth).send({name:'عميل دقة مالية'})).body.customer.id;
 const before=await stock();
 for(const line of [{qty:1,price:0.00000001},{qty:1.000000001,price:10},{qty:1,price:1.000000001}]){
  const r=await client.post('/api/sales').set(auth).send({id:randomUUID(),customerId:cust,warehouseId:wh,paid:0,lines:[{productId:prod,...line}]});
  assert.equal(r.status,409);assert.equal(r.body.code,'PRECISION');
 }
 const paid=await client.post('/api/sales').set(auth).send({id:randomUUID(),customerId:cust,warehouseId:wh,paid:0.00000001,lines:[{productId:prod,qty:1,price:2}]});
 assert.equal(paid.body.code,'PRECISION');
 assert.equal((await client.post('/api/sales/opening').set(auth).send({id:randomUUID(),customerId:cust,amount:0.00000001})).status,400);
 assert.equal((await client.post('/api/sales/receipts').set(auth).send({id:randomUUID(),customerId:cust,amount:0.00000001})).status,400);
 assert.equal(await stock(),before);
 assert.equal((await client.get(`/api/sales/statement/${cust}`).set(auth)).body.sales.length,0);
 assert.equal((await client.post('/api/sales/opening').set(auth).send({id:randomUUID(),customerId:cust,amount:0.29})).status,201);
 assert.equal((await client.post('/api/sales/receipts').set(auth).send({id:randomUUID(),customerId:cust,amount:0.29})).status,201);
 assert.equal((await client.get(`/api/sales/statement/${cust}`).set(auth)).body.balance,0);
});

test('a retry of a previously accepted near-zero entry remains idempotent after precision validation',async()=>{
 const cust=(await client.post('/api/customers').set(auth).send({name:'عميل إعادة عملية تاريخية'})).body.customer.id;
 const id=randomUUID(), body={id,customerId:cust,amount:0.00000001};
 app.store.run('INSERT INTO office_debts_v1 VALUES(?,?,?,?,?,?,?)',id,cust,0,adminLogin.body.user.id,adminLogin.body.user.name,JSON.stringify(body),Date.now());
 const response=await client.post('/api/sales/opening').set(auth).send(body);
 assert.equal(response.status,200);assert.equal(response.body.duplicate,true);
 const receiptId=randomUUID(), receipt={id:receiptId,customerId:cust,amount:1.000000001};
 app.store.run('INSERT INTO office_receipts_v1 VALUES(?,?,?,?,?,?,?)',receiptId,cust,100,adminLogin.body.user.id,adminLogin.body.user.name,JSON.stringify(receipt),Date.now());
 const retry=await client.post('/api/sales/receipts').set(auth).send(receipt);
 assert.equal(retry.status,200);assert.equal(retry.body.duplicate,true);
});
