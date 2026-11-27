import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';

const instance = createApp({dbPath:':memory:',production:false,adminEmail:'ranking@test.local',adminPassword:'AdminPassword123!',allowedOrigins:[],loginAccountLimit:500,loginRateLimit:{windowMs:60000,limit:5000}});
const client = request(instance.app);
test.after(async () => await instance.close());
const adminLogin = await client.post('/api/auth/login').send({email:'ranking@test.local',password:'AdminPassword123!'});
const admin = {Authorization:`Bearer ${adminLogin.body.token}`};
const post = async (path:string,body:object,auth=admin) => {const r=await client.post(path).set(auth).send(body);assert.ok(r.status<300,`${path}: ${r.status} ${JSON.stringify(r.body)}`);return r.body;};
const get = async (path:string) => {const r=await client.get(path).set(admin);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
const warehouse=(await post('/api/warehouse/warehouses',{name:'مخزن الترتيب'})).warehouse;
const product=(await post('/api/warehouse/products',{name:'صنف الترتيب',category:'other',unit:'عبوة'})).product;
await post('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:product.id,toWarehouseId:warehouse.id,qty:100});
const clients=[];
for(const name of ['ترتيب ألف','ترتيب باء','ترتيب جيم','ترتيب دال','ترتيب بلا شراء']) clients.push((await post('/api/customers',{name})).customer);
const sales:string[]=[];
for(let i=0;i<4;i++) {
 const id=randomUUID(); sales.push(id);
 await post('/api/sales',{id,customerId:clients[i].id,warehouseId:warehouse.id,paid:i===0?20:0,lines:[{productId:product.id,qty:1,price:100-i*20}]});
}
const ranking=()=>get('/api/sales/customer-ranking');
const detail=(id:string,offset=0)=>get(`/api/sales/customer-ranking/${id}?offset=${offset}`);

test('quartiles rank all purchasers, no purchase is unclassified, and searching does not change rank',async()=>{
 const r=await ranking(); assert.equal(r.total,5);
 assert.deepEqual(r.customers.slice(0,4).map((c:any)=>[c.purchases,c.category]),[[100,'A'],[80,'B'],[60,'C'],[40,'D']]);
 assert.equal(r.customers[4].category,null);assert.equal(r.customers[4].rank,null);
 const filtered=await get(`/api/sales/customer-ranking?q=${encodeURIComponent('ترتيب دال')}`);
 assert.equal(filtered.total,1);assert.equal(filtered.customers[0].category,'D');assert.equal(filtered.customers[0].rank,4);
 const full=await detail(clients[0].id);assert.equal(full.customer.purchases,100);assert.equal(full.customer.invoiceCount,1);assert.equal(full.due,80);
 assert.equal(full.hasOpening,false);assert.equal(full.invoices[0].original,100);assert.equal(full.invoices[0].net,100);assert.ok(full.invoices[0].invoiceNumber);
});

test('opening debt and receipt change balance but not purchases; a correction updates both correctly',async()=>{
 const customerId=clients[0].id;
 await post('/api/sales/opening',{id:randomUUID(),customerId,amount:50});
 await post('/api/sales/receipts',{id:randomUUID(),customerId,amount:30});
 let d=await detail(customerId);assert.equal(d.due,100);assert.equal(d.customer.purchases,100);assert.equal(d.hasOpening,true);
 const original=await get(`/api/sales/corrections/sale/${sales[0]}`);
 await post(`/api/sales/corrections/sale/${sales[0]}`,{id:randomUUID(),reason:'تصحيح كمية مسجلة بالخطأ',revision:original.revision,balancePiasters:original.balancePiasters,lines:[{lineId:original.lines[0].id,correctedMilli:250,returnedMilli:0,stockKind:null}],cash:null});
 d=await detail(customerId);assert.equal(d.due,75);assert.equal(d.customer.purchases,75);assert.equal(d.invoices[0].original,100);assert.equal(d.invoices[0].net,75);assert.equal(d.invoices[0].corrected,true);
 const statement=await get(`/api/sales/statement/${customerId}`);assert.equal(d.due,statement.due);
});

test('new confirmed sales change ranks immediately, equal totals keep the same category',async()=>{
 const customerId=clients[3].id;
 await post('/api/sales',{id:randomUUID(),customerId,warehouseId:warehouse.id,paid:0,lines:[{productId:product.id,qty:1,price:60}]});
 let r=await ranking();assert.equal(r.customers[0].id,customerId);assert.equal(r.customers[0].purchases,100);assert.equal(r.customers[0].category,'A');
 await post('/api/sales',{id:randomUUID(),customerId:clients[2].id,warehouseId:warehouse.id,paid:0,lines:[{productId:product.id,qty:1,price:40}]});
 r=await ranking();const tied=r.customers.filter((c:any)=>c.purchases===100);assert.equal(tied.length,2);assert.equal(tied[0].rank,tied[1].rank);assert.equal(tied[0].category,tied[1].category);
});

test('fully corrected invoices remain visible, with zero net and no misleading customer category',async()=>{
 const id=sales[1], original=await get(`/api/sales/corrections/sale/${id}`);
 await post(`/api/sales/corrections/sale/${id}`,{id:randomUUID(),reason:'إلغاء الصنف بعد المراجعة',revision:original.revision,balancePiasters:original.balancePiasters,lines:[{lineId:original.lines[0].id,correctedMilli:1000,returnedMilli:0,stockKind:null}],cash:null});
 const d=await detail(clients[1].id);assert.equal(d.customer.purchases,0);assert.equal(d.customer.category,null);assert.equal(d.invoices.length,1);assert.equal(d.invoices[0].original,80);assert.equal(d.invoices[0].net,0);
});

test('all invoices remain reachable across pages and warehouse and field roles cannot read prices',async()=>{
 const customerId=clients[4].id;
 for(let i=0;i<22;i++) await post('/api/sales',{id:randomUUID(),customerId,warehouseId:warehouse.id,paid:0,lines:[{productId:product.id,qty:0.01,price:1}]});
 const first=await detail(customerId),second=await detail(customerId,20);
 assert.equal(first.customer.invoiceCount,22);assert.equal(first.invoices.length,20);assert.equal(first.hasMore,true);assert.equal(second.invoices.length,2);assert.equal(second.hasMore,false);
 assert.equal(new Set([...first.invoices,...second.invoices].map((x:any)=>x.id)).size,22);
 const rep=(await post('/api/reps',{name:'مهندس',email:'rank-rep@test.local',password:'RepPassword123!',region:'القاهرة'})).user;
 const repToken=(await post('/api/auth/login',{email:'rank-rep@test.local',password:'RepPassword123!'})).token;
 const wh=(await post('/api/staff',{name:'مخزن',email:'rank-wh@test.local',password:'Warehouse12345!',accessScope:'warehouse'})).user;
 assert.ok(rep.id && wh.id);
 const whToken=(await post('/api/auth/login',{email:'rank-wh@test.local',password:'Warehouse12345!'})).token;
 for(const token of [repToken,whToken]) {
   assert.equal((await client.get('/api/sales/customer-ranking').set('Authorization',`Bearer ${token}`)).status,403);
   assert.equal((await client.get(`/api/sales/customer-ranking/${customerId}`).set('Authorization',`Bearer ${token}`)).status,403);
 }
 assert.equal((await client.get('/api/sales/customer-ranking?offset=-1').set(admin)).status,400);
 assert.equal((await client.get(`/api/sales/customer-ranking/${customerId}?offset=abc`).set(admin)).status,400);
 assert.equal((await client.get(`/api/sales/customer-ranking/${randomUUID()}`).set(admin)).status,404);
});

test('chart pagination includes all customers without changing their global category',async()=>{
  const before = await detail(clients[3].id);
  for(let i=0;i<25;i++) await post('/api/customers',{name:`قائمة صفحات ${String(i).padStart(2,'0')}`});
  const first=await get('/api/sales/customer-ranking?offset=0'), second=await get('/api/sales/customer-ranking?offset=20');
  assert.equal(first.total,30);assert.equal(first.customers.length,20);assert.equal(first.hasMore,true);
  assert.equal(second.customers.length,10);assert.equal(second.hasMore,false);
  assert.equal(new Set([...first.customers,...second.customers].map((c:any)=>c.id)).size,30);
  const after = await detail(clients[3].id);assert.equal(before.customer.category,after.customer.category);assert.equal(before.customer.rank,after.customer.rank);
});
