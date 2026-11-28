import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {createApp} from '../src/app.js';

const instance=createApp({dbPath:':memory:',production:false,adminEmail:'customer-race@test.local',adminPassword:'Password12345!',loginRateLimit:{windowMs:60000,limit:5000},loginAccountLimit:500});
const {store,app}=instance,client=request(app);test.after(async()=>instance.close());
const auth={Authorization:`Bearer ${(await client.post('/api/auth/login').send({email:'customer-race@test.local',password:'Password12345!'})).body.token}`};
const email=`${randomUUID()}@test.local`,password='Password12345!';
const rep=(await client.post('/api/reps').set(auth).send({name:'مهندس اختبار',email,password,region:'طنطا'})).body.user.id;
const token=(await client.post('/api/auth/login').send({email,password})).body.token,repAuth={Authorization:`Bearer ${token}`};
async function customer(name:string,repId?:string){const r=await client.post('/api/customers').set(auth).send({name,...(repId?{repId}:{})});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.customer.id as string;}

test('approval status, session revocation and audit commit together; sessions also verify approval',async()=>{
 for(const trigger of ["CREATE TRIGGER failed BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'failure'); END","CREATE TRIGGER failed BEFORE INSERT ON audit_log WHEN NEW.action='rep.approval' BEGIN SELECT RAISE(ABORT,'failure'); END"]) {
  store.db.exec(trigger);try{assert.equal((await client.patch(`/api/reps/${rep}/approval`).set(auth).send({status:'rejected'})).status,500);assert.equal(store.get('SELECT approval_status FROM users WHERE id=?',rep)?.approval_status,'approved');assert.equal((await client.get('/api/auth/me').set(repAuth)).status,200);}finally{store.db.exec('DROP TRIGGER failed');}
 }
 store.run("UPDATE users SET approval_status='pending' WHERE id=?",rep);
 assert.equal((await client.get('/api/auth/me').set(repAuth)).status,401);
 store.run("UPDATE users SET approval_status='approved' WHERE id=?",rep);
 assert.equal((await client.patch(`/api/reps/${rep}/approval`).set(auth).send({status:'rejected'})).status,200);
 assert.equal((await client.get('/api/auth/me').set(repAuth)).status,401);
});

test('customer mutations are atomic with audit',async()=>{
 const id=await customer(`عميل ${randomUUID()}`,rep);
 const cases=[{action:'customer.create',send:()=>client.post('/api/customers').set(auth).send({name:'إنشاء مرفوض'}),verify:()=>assert.equal(store.get("SELECT id FROM customers WHERE name='إنشاء مرفوض'"),undefined)},
 {action:'customer.update',send:()=>client.patch(`/api/customers/${id}`).set(auth).send({phone:'123'}),verify:()=>assert.equal(store.get('SELECT phone FROM customers WHERE id=?',id)?.phone,'')},
 {action:'customer.assign',send:()=>client.post(`/api/customers/${id}/assign`).set(auth).send({repId:null}),verify:()=>assert.equal(store.get('SELECT rep_id FROM customers WHERE id=?',id)?.rep_id,rep)},
 {action:'customer.delete',send:()=>client.delete(`/api/customers/${id}`).set(auth),verify:()=>assert.ok(store.get('SELECT id FROM customers WHERE id=?',id))}];
 for(const c of cases){store.db.exec(`CREATE TRIGGER failed BEFORE INSERT ON audit_log WHEN NEW.action='${c.action}' BEGIN SELECT RAISE(ABORT,'failure'); END`);try{assert.equal((await c.send()).status,500);c.verify();}finally{store.db.exec('DROP TRIGGER failed');}}
});

test('customer update/delete and duplicate checks re-read under the write lock',async()=>{
 const id=await customer(`عميل ${randomUUID()}`,rep),tx=store.transaction.bind(store);
 store.transaction=fn=>{store.run('UPDATE customers SET phone=? WHERE id=?','98765',id);tx(fn);};
 let r;try{r=await client.patch(`/api/customers/${id}`).set(auth).send({notes:'تعديل'});}finally{store.transaction=tx;}
 assert.equal(r.status,200);assert.equal(store.get('SELECT phone FROM customers WHERE id=?',id)?.phone,'98765');
 const visit=randomUUID();store.transaction=fn=>{store.run('INSERT INTO visits(id,user_id,customer_name,customer_id,checked_in_at,created_at) VALUES(?,?,?,?,?,?)',visit,rep,'زيارة',id,Date.now(),Date.now());tx(fn);};
 try{r=await client.delete(`/api/customers/${id}`).set(auth);}finally{store.transaction=tx;}
 assert.equal(r.status,409);assert.equal(r.body.code,'CUSTOMER_HAS_VISITS');assert.equal(store.get('SELECT customer_id FROM visits WHERE id=?',visit)?.customer_id,id);
 const name=`شركة ${randomUUID()}`,other=randomUUID();
 store.transaction=fn=>{store.run('INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,?,?,?)',other,name,Date.now(),Date.now());tx(fn);};
 try{r=await client.post('/api/customers').set(auth).send({name});}finally{store.transaction=tx;}
 assert.equal(r.status,409);assert.equal(r.body.code,'CUSTOMER_EXISTS');assert.equal(store.get('SELECT COUNT(*) AS n FROM customers WHERE name=?',name)?.n,1);
 const assigned=await customer(name,rep);r=await client.post(`/api/customers/${assigned}/assign`).set(auth).send({repId:null});assert.equal(r.status,409);assert.equal(r.body.code,'CUSTOMER_EXISTS');
});

test('area transfer rechecks the destination and rolls back its audit',async()=>{
 const area=`منطقة ${randomUUID()}`,name=`عميل ${randomUUID()}`;
 const r=await client.post('/api/customers').set(auth).send({name,repId:rep,governorate:area});assert.equal(r.status,201);const id=r.body.customer.id;
 const body={governorate:area,repId:null,onlyUnassigned:false};const tx=store.transaction.bind(store),other=randomUUID();
 store.transaction=fn=>{store.run('INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,?,?,?)',other,name,Date.now(),Date.now());tx(fn);};
 let moved;try{moved=await client.post('/api/customers/assign-area').set(auth).send(body);}finally{store.transaction=tx;}
 assert.equal(moved.status,409);assert.equal(moved.body.code,'CUSTOMER_EXISTS');assert.equal(store.get('SELECT rep_id FROM customers WHERE id=?',id)?.rep_id,rep);
 store.run('DELETE FROM customers WHERE id=?',other);
 store.db.exec("CREATE TRIGGER failed BEFORE INSERT ON audit_log WHEN NEW.action='customer.assignArea' BEGIN SELECT RAISE(ABORT,'failure'); END");
 try{assert.equal((await client.post('/api/customers/assign-area').set(auth).send(body)).status,500);assert.equal(store.get('SELECT rep_id FROM customers WHERE id=?',id)?.rep_id,rep);}finally{store.db.exec('DROP TRIGGER failed');}
});
