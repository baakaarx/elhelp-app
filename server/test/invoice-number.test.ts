import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import request from 'supertest';
import {createApp} from '../src/app.js';

test('invoice numbers migrate old sales once, survive restarts, rollback failed sales, and serialize concurrent sales',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'elhelp-invoices-')),dbPath=join(dir,'test.db');
 const config={dbPath,production:false,adminEmail:'number@local.test',adminPassword:'AdminPassword123!',loginAccountLimit:500,loginRateLimit:{windowMs:60000,limit:5000}};
 let app=createApp(config);
 try {
  let api=request(app.app);const auth={Authorization:`Bearer ${(await api.post('/api/auth/login').send({email:config.adminEmail,password:config.adminPassword})).body.token}`};
  const send=async(path:string,body:object)=>{const r=await api.post(path).set(auth).send(body);assert.ok(r.status<300,`${path} ${r.status} ${JSON.stringify(r.body)}`);return r.body;};
  const c=(await send('/api/customers',{name:'عميل ترقيم'})).customer,w=(await send('/api/warehouse/warehouses',{name:'مخزن ترقيم'})).warehouse;
  const p=(await send('/api/warehouse/products',{name:'صنف ترقيم',category:'other',unit:'عبوة'})).product;
  await send('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:p.id,toWarehouseId:w.id,qty:20});
  const input=(id:string,qty=1)=>({id,customerId:c.id,warehouseId:w.id,paid:0,lines:[{productId:p.id,qty,price:5}]});
  const a=input(randomUUID()),b=input(randomUUID());await send('/api/sales',a);await send('/api/sales',b);
  assert.deepEqual(app.store.all('SELECT number,sale_id FROM office_invoice_numbers_v1 ORDER BY number').map(x=>x.number),[1,2]);
  // Recreate the situation of a pre-numbering installation without modifying its financial data.
  app.store.db.exec('DROP TABLE office_invoice_numbers_v1');await app.close();
  app=createApp(config);api=request(app.app);
  let rows=app.store.all('SELECT number,sale_id FROM office_invoice_numbers_v1 ORDER BY number');
  assert.deepEqual(rows.map(x=>x.sale_id),[a.id,b.id]);assert.deepEqual(rows.map(x=>x.number),[1,2]);
  assert.equal((await api.post('/api/sales').set(auth).send(a)).body.duplicate,true);
  assert.equal((await api.post('/api/sales').set(auth).send(input(randomUUID(),999))).status,409);
  const result=await Promise.all([api.post('/api/sales').set(auth).send(input(randomUUID())),api.post('/api/sales').set(auth).send(input(randomUUID()))]);
  assert.deepEqual(result.map(r=>r.status),[201,201]);
  rows=app.store.all('SELECT number,sale_id FROM office_invoice_numbers_v1 ORDER BY number');assert.deepEqual(rows.map(x=>x.number),[1,2,3,4]);
  await app.close();app=createApp(config);
  assert.deepEqual(app.store.all('SELECT number,sale_id FROM office_invoice_numbers_v1 ORDER BY number'),rows);
  assert.equal(app.store.get('SELECT COUNT(*) AS n FROM office_sales_v1')?.n,4);
 } finally {await app.close();rmSync(dir,{recursive:true,force:true});}
});
