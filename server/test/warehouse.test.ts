import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { io as socketClient } from 'socket.io-client';
import { createApp } from '../src/app.js';

const instance = createApp({ dbPath: ':memory:', production: false, adminEmail:'warehouse-admin@test.com', adminPassword:'AdminPassword123!', timezone:'Africa/Cairo', port:0, retentionDays:30, allowedOrigins:[], loginAccountLimit:500, loginRateLimit:{windowMs:60000,limit:5000} });
const client = request(instance.app);
test.after(async () => { await instance.close(); });
const adminLogin = await client.post('/api/auth/login').send({ email:'warehouse-admin@test.com', password:'AdminPassword123!' });
const admin = { Authorization:`Bearer ${adminLogin.body.token}` };

test('warehouse staff is isolated from office APIs and prices, including direct requests', async () => {
  const created = await client.post('/api/staff').set(admin).send({ name:'أمين مخزن',email:'warehouse@test.com',password:'Warehouse12345!',accessScope:'warehouse' });
  assert.equal(created.status,201,JSON.stringify(created.body));
  const login = await client.post('/api/auth/login').send({email:'warehouse@test.com',password:'Warehouse12345!'});
  assert.equal(login.status,200); assert.equal(login.body.user.accessScope,'warehouse');
  const wh = { Authorization:`Bearer ${login.body.token}` };
  for (const path of ['/api/overview','/api/orders','/api/products','/api/price-tiers','/api/customers','/api/staff','/api/agent/status']) {
    assert.equal((await client.get(path).set(wh)).status,403,path);
  }
  assert.equal((await client.post('/api/products').set(wh).send({})).status,403);
  assert.equal((await client.get('/api/auth/me').set(wh)).status,200);
  assert.equal((await client.get('/api/warehouse/products').set(wh)).status,200);
  assert.equal((await client.post('/api/warehouse/products').set(wh).send({name:'صنف اختبار',category:'other',unit:'عبوة',prices:[]})).status,400);
  const product = await client.post('/api/warehouse/products').set(wh).send({name:'صنف اختبار',category:'other',unit:'عبوة'});
  assert.equal(product.status,201,JSON.stringify(product.body));
  assert.ok(!('notes' in product.body.product));
  const sales = await client.post('/api/staff').set(admin).send({ name:'مبيعات',email:'sales@test.com',password:'SalesPassword123!',accessScope:'full' });
  assert.equal(sales.status,201);
  const loginSales = await client.post('/api/auth/login').send({email:'sales@test.com',password:'SalesPassword123!'});
  assert.equal((await client.get('/api/overview').set('Authorization',`Bearer ${loginSales.body.token}`)).status,200);
  const rep = await client.post('/api/reps').set(admin).send({ region: 'منطقة اختبار',name:'مهندس اختبار',email:'rep@warehouse.test',password:'Rep1234!Rep'});
  assert.equal(rep.status,201);
  const repLogin = await client.post('/api/auth/login').send({email:'rep@warehouse.test',password:'Rep1234!Rep'});
  assert.equal((await client.get('/api/warehouse/products').set('Authorization',`Bearer ${repLogin.body.token}`)).status,403);
});

test('stock starts unknown; opening, transfers, shortages and retries preserve exact balances', async () => {
  const w1 = (await client.post('/api/warehouse/warehouses').set(admin).send({name:'المخزن الرئيسي'})).body.warehouse.id;
  const w2 = (await client.post('/api/warehouse/warehouses').set(admin).send({name:'المخزن التاني'})).body.warehouse.id;
  const p = (await client.post('/api/warehouse/products').set(admin).send({name:'يوريا المخزن',category:'fertilizer',unit:'شيكارة'})).body.product.id;
  const stock = async (warehouseId:string) => (await client.get(`/api/warehouse/stock?warehouseId=${warehouseId}`).set(admin)).body.stock.find((x:any) => x.id===p).qty;
  const move = (data:object) => client.post('/api/warehouse/movements').set(admin).send(data);
  assert.equal(await stock(w1), null);
  assert.equal((await move({id:randomUUID(),kind:'in',productId:p,toWarehouseId:w1,qty:1})).status,409);
  assert.equal((await move({id:randomUUID(),kind:'opening',productId:p,toWarehouseId:w1,qty:5.5})).status,201);
  assert.equal((await move({id:randomUUID(),kind:'opening',productId:p,toWarehouseId:w2,qty:0})).status,201);
  const transfer = {id:randomUUID(),kind:'transfer',productId:p,fromWarehouseId:w1,toWarehouseId:w2,qty:1.125,note:'نقل'};
  assert.equal((await move(transfer)).status,201);
  assert.equal((await move(transfer)).body.duplicate,true);
  assert.equal((await move({...transfer,qty:2})).status,409);
  assert.equal(await stock(w1),4.375); assert.equal(await stock(w2),1.125);
  assert.equal((await move({id:randomUUID(),kind:'out',productId:p,fromWarehouseId:w2,qty:2})).status,409);
  assert.equal((await move({id:randomUUID(),kind:'transfer',productId:p,fromWarehouseId:w1,toWarehouseId:w1,qty:1})).status,400);
  assert.equal((await move({id:randomUUID(),kind:'in',productId:p,toWarehouseId:w1,qty:0.0001})).status,400);
  assert.equal((await client.delete(`/api/products/${p}`).set(admin)).status,409);
  assert.equal((await client.get(`/api/warehouse/movements?warehouseId=${w1}`).set(admin)).body.movements.length,2);
});

test('account suspension and password reset revoke sessions and do not let a warehouse user administer staff', async () => {
  const created = await client.post('/api/staff').set(admin).send({ name:'أمين قابل للإيقاف', email:'suspended@test.com',password:'Warehouse12345!',accessScope:'warehouse' });
  assert.equal(created.status,201); const userId=created.body.user.id;
  const login = await client.post('/api/auth/login').send({email:'suspended@test.com',password:'Warehouse12345!'});
  const wh={ Authorization:`Bearer ${login.body.token}` };
  assert.equal((await client.patch(`/api/staff/${userId}`).set(wh).send({active:false})).status,403);
  assert.equal((await client.patch(`/api/staff/${userId}`).set(admin).send({active:false})).status,200);
  assert.equal((await client.get('/api/warehouse/warehouses').set(wh)).status,401);
  assert.equal((await client.post('/api/auth/login').send({email:'suspended@test.com',password:'Warehouse12345!'})).status,401);
  assert.equal((await client.patch(`/api/staff/${userId}`).set(admin).send({active:true,password:'NewWarehouse123!'})).status,200);
  assert.equal((await client.post('/api/auth/login').send({email:'suspended@test.com',password:'Warehouse12345!'})).status,401);
  assert.equal((await client.post('/api/auth/login').send({email:'suspended@test.com',password:'NewWarehouse123!'})).status,200);
});

test('unit and pack cannot change after stock is recorded through either API', async () => {
  const product = await client.post('/api/warehouse/products').set(admin).send({name:'صنف وحدة ثابتة',category:'other',unit:'عبوة',unitSize:'1 لتر'});
  const productId = product.body.product.id;
  const warehouse = await client.post('/api/warehouse/warehouses').set(admin).send({name:'مخزن وحدة ثابتة'});
  const warehouseId = warehouse.body.warehouse.id;
  assert.equal((await client.post('/api/warehouse/movements').set(admin).send({id:randomUUID(),kind:'opening',productId,toWarehouseId:warehouseId,qty:0})).status,201);
  assert.equal((await client.patch(`/api/warehouse/products/${productId}`).set(admin).send({unit:'كرتونة'})).status,409);
  assert.equal((await client.patch(`/api/products/${productId}`).set(admin).send({unitSize:'2 لتر'})).status,409);
  assert.equal((await client.patch(`/api/warehouse/products/${productId}`).set(admin).send({name:'صنف معدل'})).status,200);
});

test('assistant priorities do not treat unrecorded balances as zero', async () => {
  const result = await client.get('/api/work-priorities').set(admin);
  assert.equal(result.status,200);
  assert.ok(result.body.uninitialized > 0);
  assert.ok(result.body.emptyStockCount > 0);
  const names=result.body.emptyStock.map((x:any)=>x.productName);
  assert.ok(names.includes('صنف معدل'));
  assert.ok(!names.includes('صنف اختبار'));
});


test('warehouse accounts cannot subscribe to office live events', async () => {
  const login = await client.post('/api/auth/login').send({email:'warehouse@test.com',password:'Warehouse12345!'});
  assert.equal(login.status,200);
  await new Promise<void>(resolve => instance.httpServer.listen(0, '127.0.0.1', resolve));
  const port = (instance.httpServer.address() as {port:number}).port;
  const socket = socketClient(`http://127.0.0.1:${port}`, { auth:{token:login.body.token}, transports:['websocket'], reconnection:false });
  try {
    const result = await new Promise<string>(resolve => {
      socket.once('connect',()=>resolve('connected'));
      socket.once('connect_error',()=>resolve('rejected'));
      setTimeout(()=>resolve('timeout'),3000).unref();
    });
    assert.equal(result,'rejected');
  } finally { socket.close(); }
});


test('inbound stock and transfers reject unsafe integer balances without changing either warehouse', async () => {
  const w1 = (await client.post('/api/warehouse/warehouses').set(admin).send({name:'مخزن حد آمن مصدر'})).body.warehouse.id;
  const w2 = (await client.post('/api/warehouse/warehouses').set(admin).send({name:'مخزن حد آمن وجهة'})).body.warehouse.id;
  const p = (await client.post('/api/warehouse/products').set(admin).send({name:'صنف حد آمن',category:'other',unit:'عبوة'})).body.product.id;
  const move = (data:object) => client.post('/api/warehouse/movements').set(admin).send(data);
  await move({id:randomUUID(),kind:'opening',productId:p,toWarehouseId:w1,qty:1});
  await move({id:randomUUID(),kind:'opening',productId:p,toWarehouseId:w2,qty:0});
  instance.store.run('UPDATE warehouse_stock SET milli_qty=? WHERE warehouse_id=? AND product_id=?',Number.MAX_SAFE_INTEGER,w2,p);
  assert.equal((await move({id:randomUUID(),kind:'in',productId:p,toWarehouseId:w2,qty:0.001})).body.code,'STOCK_LIMIT');
  assert.equal((await move({id:randomUUID(),kind:'transfer',productId:p,fromWarehouseId:w1,toWarehouseId:w2,qty:1})).body.code,'STOCK_LIMIT');
  assert.equal(instance.store.get('SELECT milli_qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?',w1,p)?.milli_qty,1000);
  assert.equal(instance.store.get('SELECT milli_qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?',w2,p)?.milli_qty,Number.MAX_SAFE_INTEGER);
  assert.equal((await client.get(`/api/warehouse/movements?warehouseId=${w2}`).set(admin)).body.movements.length,1);
});


test('stock rejects excess precision, including near zero, without initializing a balance',async()=>{
  const w=(await client.post('/api/warehouse/warehouses').set(admin).send({name:'مخزن دقة إضافية'})).body.warehouse.id;
  const p=(await client.post('/api/warehouse/products').set(admin).send({name:'صنف دقة إضافية',category:'other',unit:'عبوة'})).body.product.id;
  for(const qty of [0.000000001,1.000000001]) {
    const result=await client.post('/api/warehouse/movements').set(admin).send({id:randomUUID(),kind:'opening',productId:p,toWarehouseId:w,qty});
    assert.equal(result.status,400);
  }
  const stock=(await client.get(`/api/warehouse/stock?warehouseId=${w}`).set(admin)).body.stock.find((x:any)=>x.id===p);
  assert.equal(stock.qty,null);
  assert.equal((await client.post('/api/warehouse/movements').set(admin).send({id:randomUUID(),kind:'opening',productId:p,toWarehouseId:w,qty:1.001})).status,201);
});


test('previously recorded movement with legacy fractional input remains safe to retry', async()=>{
  const w=(await client.post('/api/warehouse/warehouses').set(admin).send({name:'مخزن محاولة قديمة'})).body.warehouse.id;
  const p=(await client.post('/api/warehouse/products').set(admin).send({name:'صنف محاولة قديمة',category:'other',unit:'عبوة'})).body.product.id;
  const id=randomUUID(),qty=1.000000001;
  instance.store.run('INSERT INTO warehouse_stock(warehouse_id,product_id,milli_qty) VALUES(?,?,?)',w,p,1000);
  instance.store.run("INSERT INTO inventory_movements(id,kind,product_id,from_warehouse_id,to_warehouse_id,milli_qty,note,actor_id,actor_name,created_at) VALUES(?,'opening',?,NULL,?,1000,'',?,?,?)",id,p,w,adminLogin.body.user.id,adminLogin.body.user.name,Date.now());
  const result=await client.post('/api/warehouse/movements').set(admin).send({id,kind:'opening',productId:p,toWarehouseId:w,qty});
  assert.equal(result.status,200);assert.equal(result.body.duplicate,true);
  assert.equal((await client.get(`/api/warehouse/stock?warehouseId=${w}`).set(admin)).body.stock.find((x:any)=>x.id===p).qty,1);
});


test('same product and unit with distinct known packs remains separate in both APIs', async () => {
 const name=`عبوات مراجعة ${randomUUID()}`;
 const a=await client.post('/api/warehouse/products').set(admin).send({name,category:'other',unit:'عبوة',unitSize:'١٠٠ جم'});assert.equal(a.status,201);
 const b=await client.post('/api/products').set(admin).send({name,unit:'عبوة',unitSize:'٢٥٠ جم'});assert.equal(b.status,201,JSON.stringify(b.body));
 assert.equal((await client.post('/api/warehouse/products').set(admin).send({name,category:'other',unit:'عبوة',unitSize:'١٠٠ جم'})).status,409);
 assert.equal((await client.post('/api/warehouse/products').set(admin).send({name,category:'other',unit:'عبوة'})).status,409);
 assert.equal((await client.patch(`/api/warehouse/products/${b.body.product.id}`).set(admin).send({unitSize:'١٠٠ جم'})).status,409);
 assert.equal((await client.patch(`/api/products/${b.body.product.id}`).set(admin).send({unitSize:''})).status,409);
});

test('zero is allowed only for opening stock and gives a specific error otherwise',async()=>{
 const w=await client.post('/api/warehouse/warehouses').set(admin).send({name:`مخزن صفر ${randomUUID()}`});
 const p=await client.post('/api/warehouse/products').set(admin).send({name:`صنف صفر ${randomUUID()}`,category:'other',unit:'عبوة'});
 const base={productId:p.body.product.id,toWarehouseId:w.body.warehouse.id,qty:0};
 const zero=await client.post('/api/warehouse/movements').set(admin).send({...base,id:randomUUID(),kind:'in'});
 assert.equal(zero.status,400);assert.match(zero.body.error,/أكبر من صفر/);
 const opening=await client.post('/api/warehouse/movements').set(admin).send({...base,id:randomUUID(),kind:'opening'});assert.equal(opening.status,201);
});
