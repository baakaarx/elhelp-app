import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {createApp} from '../src/app.js';

const instance=createApp({dbPath:':memory:',production:false,adminEmail:'race-admin@test.local',adminPassword:'Password12345!',loginRateLimit:{windowMs:60000,limit:5000},loginAccountLimit:500});
const {app,store}=instance, client=request(app);test.after(async()=>instance.close());
const adminToken=(await client.post('/api/auth/login').send({email:'race-admin@test.local',password:'Password12345!'})).body.token;
const admin={Authorization:`Bearer ${adminToken}`};
const adminId=String(store.get('SELECT id FROM users WHERE email=?','race-admin@test.local')!.id);
async function otherAdmin(){const email=`${randomUUID()}@test.local`,password='Password12345!';const r=await client.post('/api/staff').set(admin).send({name:'مدير آخر',email,password,accessScope:'full'});assert.equal(r.status,201);return {id:r.body.user.id,email};}

test('concurrent shift starts reuse one shift and one initial location',async()=>{
 const email=`${randomUUID()}@test.local`,password='Password12345!';const made=await client.post('/api/reps').set(admin).send({name:'مهندس وردية',email,password,region:'الإسكندرية'});assert.equal(made.status,201);
 const token=(await client.post('/api/auth/login').send({email,password})).body.token, id=made.body.user.id;
 const transaction=store.transaction.bind(store);store.transaction=fn=>{transaction(fn);transaction(fn);};
 let response;try{response=await client.post('/api/shifts/start').set({Authorization:`Bearer ${token}`}).send({consentVersion:'1.0',deviceId:'test-device-123',location:{lat:31.2,lng:29.9,accuracy:8}});}finally{store.transaction=transaction;}
 assert.equal(response.status,200);assert.equal(store.get("SELECT COUNT(*) AS n FROM shifts WHERE user_id=? AND ended_at IS NULL",id)?.n,1);
 assert.equal(store.get('SELECT COUNT(*) AS n FROM locations WHERE user_id=?',id)?.n,1);
 assert.equal(response.body.shift.id,store.get('SELECT id FROM shifts WHERE user_id=?',id)?.id);
});

test('account deletion cannot race the removal of the last other manager',async()=>{
 const second=await otherAdmin(),transaction=store.transaction.bind(store);
 store.transaction=fn=>{store.run('UPDATE users SET active=0 WHERE id=?',second.id);transaction(fn);};
 let response;try{response=await client.delete('/api/me').set(admin).send({confirm:true,email:'race-admin@test.local'});}finally{store.transaction=transaction;}
 assert.equal(response.status,409);assert.equal(response.body.code,'LAST_ADMIN');
 assert.ok(store.get('SELECT id FROM users WHERE id=? AND active=1',adminId));
 store.run('UPDATE users SET active=1 WHERE id=?',second.id);
});

test('staff deactivation rechecks the last administrator and rolls back with audit failure',async()=>{
 const second=await otherAdmin();
 // Leave exactly two active full admins for this race.
 store.run("UPDATE users SET active=0 WHERE role='admin' AND id NOT IN (?,?)",adminId,second.id);
 const transaction=store.transaction.bind(store);
 store.transaction=fn=>{store.run('UPDATE users SET active=0 WHERE id=?',adminId);transaction(fn);};
 let response;try{response=await client.patch(`/api/staff/${second.id}`).set(admin).send({active:false});}finally{store.transaction=transaction;store.run('UPDATE users SET active=1 WHERE id=?',adminId);}
 assert.equal(response.status,409);assert.equal(store.get('SELECT active FROM users WHERE id=?',second.id)?.active,1);
 store.db.exec("CREATE TRIGGER fail_staff_update BEFORE INSERT ON audit_log WHEN NEW.action='staff.update' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
 try{response=await client.patch(`/api/staff/${second.id}`).set(admin).send({active:false});assert.equal(response.status,500);assert.equal(store.get('SELECT active FROM users WHERE id=?',second.id)?.active,1);}finally{store.db.exec('DROP TRIGGER fail_staff_update');}
});

test('shift creation and initial location roll back if audit fails',async()=>{
 const email=`${randomUUID()}@test.local`,password='Password12345!';const made=await client.post('/api/reps').set(admin).send({name:'مهندس ثاني',email,password,region:'الإسكندرية'});assert.equal(made.status,201);
 const id=made.body.user.id, token=(await client.post('/api/auth/login').send({email,password})).body.token;
 store.db.exec("CREATE TRIGGER fail_shift_start BEFORE INSERT ON audit_log WHEN NEW.action='shift.start' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
 try{const response=await client.post('/api/shifts/start').set({Authorization:`Bearer ${token}`}).send({consentVersion:'1.0',deviceId:'test-device-456',location:{lat:31.2,lng:29.9,accuracy:8}});
 assert.equal(response.status,500);assert.equal(store.get('SELECT COUNT(*) AS n FROM shifts WHERE user_id=?',id)?.n,0);assert.equal(store.get('SELECT COUNT(*) AS n FROM locations WHERE user_id=?',id)?.n,0);
 }finally{store.db.exec('DROP TRIGGER fail_shift_start');}
});

test('visit and daily report filters reject malformed or impossible dates',async()=>{
 for(const url of ['/api/visits?date=nonsense','/api/visits?date=2025-02-30','/api/visits?status=bogus','/api/daily-reports?from=nonsense','/api/daily-reports?to=2025-02-30','/api/daily-reports?from=2025-03-02&to=2025-03-01']){
  const response=await client.get(url).set(admin);assert.equal(response.status,400,`${url}: ${JSON.stringify(response.body)}`);
 }
 assert.equal((await client.get('/api/daily-reports?from=2025-01-01&to=2025-03-01').set(admin)).status,200);
});

test('staff creation rolls back if audit fails',async()=>{
 const email=`${randomUUID()}@test.local`;
 store.db.exec("CREATE TRIGGER fail_staff_create BEFORE INSERT ON audit_log WHEN NEW.action='staff.create' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
 try{const response=await client.post('/api/staff').set(admin).send({name:'حساب اختبار',email,password:'Password12345!',accessScope:'full'});assert.equal(response.status,500);assert.equal(store.get('SELECT id FROM users WHERE email=?',email),undefined);}
 finally{store.db.exec('DROP TRIGGER fail_staff_create');}
});

test('stop and logout leave shift and session intact if shift audit fails',async()=>{
 const email=`${randomUUID()}@test.local`,password='Password12345!';const made=await client.post('/api/reps').set(admin).send({name:'مهندس الإغلاق',email,password,region:'الإسكندرية'});assert.equal(made.status,201);
 const id=made.body.user.id, token=(await client.post('/api/auth/login').send({email,password})).body.token, auth={Authorization:`Bearer ${token}`};
 assert.equal((await client.post('/api/shifts/start').set(auth).send({consentVersion:'1.0',deviceId:'test-device-stop',location:{lat:31.2,lng:29.9,accuracy:8}})).status,200);
 store.db.exec("CREATE TRIGGER fail_shift_stop BEFORE INSERT ON audit_log WHEN NEW.action='shift.stop' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
 try{for(const route of ['/api/shifts/stop','/api/auth/logout']){assert.equal((await client.post(route).set(auth)).status,500);assert.ok(store.get('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL',id));assert.ok(store.get('SELECT user_id FROM sessions WHERE user_id=?',id));}}
 finally{store.db.exec('DROP TRIGGER fail_shift_stop');}
 assert.equal((await client.post('/api/shifts/stop').set(auth)).status,200);
});
