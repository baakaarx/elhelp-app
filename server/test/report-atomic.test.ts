import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { insertDailyReport, newDailyReportSchema } from '../src/dailyReports.js';
import { localDate } from '../src/geo.js';

const instance=createApp({dbPath:':memory:',production:false,adminEmail:'audit-report@test.local',adminPassword:'Password12345!',loginRateLimit:{windowMs:60000,limit:5000},loginAccountLimit:500});
const {app,store}=instance, client=request(app);test.after(async()=>instance.close());
const adminToken=(await client.post('/api/auth/login').send({email:'audit-report@test.local',password:'Password12345!'})).body.token;
const admin={Authorization:`Bearer ${adminToken}`};
async function makeRep(){const email=`${randomUUID()}@test.local`, password='Password12345!';const made=await client.post('/api/reps').set(admin).send({name:'مهندس الاختبار',email,password,region:'الإسكندرية'});assert.equal(made.status,201);const token=(await client.post('/api/auth/login').send({email,password})).body.token;return {id:made.body.user.id as string,auth:{Authorization:`Bearer ${token}`}};}
const rep=await makeRep(), other=await makeRep();
const today=localDate('Africa/Cairo');
const quick=(id=randomUUID())=>({id,type:'note',title:'تقرير اختبار',body:'محتوى',customer:'عميل',amount:null,location:{lat:31.2,lng:29.9,accuracy:8}});
const daily=(id=randomUUID())=>({version:1,id,engineerName:'مهندس اختبار',reportDate:today,leftAt:'',returnedAt:'',circumstances:'',signedName:'مهندس اختبار',confirmed:true,location:null,visits:[{customerName:'عميل اختبار',governorate:'',district:'',village:'',phone:'',areaFeddan:null,crops:'',recommendations:'',outcome:''}]});

test('quick report retry compares all data; failed audit rolls back report',async()=>{
 const body=quick();store.db.exec("CREATE TRIGGER fail_report_audit BEFORE INSERT ON audit_log WHEN NEW.action='report.create' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
 try{assert.equal((await client.post('/api/reports').set(rep.auth).send(body)).status,500);assert.equal(store.get('SELECT id FROM reports WHERE id=?',body.id),undefined);}finally{store.db.exec('DROP TRIGGER fail_report_audit');}
 assert.equal((await client.post('/api/reports').set(rep.auth).send(body)).status,201);
 assert.equal((await client.post('/api/reports').set(rep.auth).send(body)).body.duplicate,true);
 const changed=await client.post('/api/reports').set(rep.auth).send({...body,body:'محتوى مختلف'});assert.equal(changed.status,409);assert.equal(changed.body.code,'REPORT_ID_IN_USE');
 assert.equal((await client.post('/api/reports').set(other.auth).send(body)).status,409);
});

test('daily report and audit are atomic, matching retries succeed, changed data is refused',async()=>{
 const body=daily();store.db.exec("CREATE TRIGGER fail_daily_audit BEFORE INSERT ON audit_log WHEN NEW.action='daily_report.create' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
 try{assert.equal((await client.post('/api/daily-reports').set(rep.auth).send(body)).status,500);assert.equal(store.get('SELECT id FROM daily_reports WHERE id=?',body.id),undefined);assert.equal(store.get('SELECT id FROM daily_report_visits WHERE report_id=?',body.id),undefined);}finally{store.db.exec('DROP TRIGGER fail_daily_audit');}
 assert.equal((await client.post('/api/daily-reports').set(rep.auth).send(body)).status,201);
 assert.equal((await client.post('/api/daily-reports').set(rep.auth).send(body)).body.duplicate,true);
 assert.equal((await client.post('/api/daily-reports').set(rep.auth).send({...body,visits:[{...body.visits[0],outcome:'نتيجة مختلفة'}]})).body.code,'DAILY_REPORT_ID_IN_USE');
 assert.equal((await client.post('/api/daily-reports').set(rep.auth).send(daily())).body.code,'DAILY_REPORT_EXISTS');
 assert.equal((await client.post('/api/daily-reports').set(other.auth).send(body)).status,409);
});

test('a concurrent same-day report or a foreign id is not duplicated or exposed',async()=>{
 const actor=await makeRep(), body=daily(), already=daily(), transaction=store.transaction.bind(store);
 store.transaction=fn=>{insertDailyReport(store,actor.id,null,newDailyReportSchema.parse(already),Date.now(),'Africa/Cairo');transaction(fn);};
 let response;try{response=await client.post('/api/daily-reports').set(actor.auth).send(body);}finally{store.transaction=transaction;}
 assert.equal(response.status,409);assert.equal(response.body.code,'DAILY_REPORT_EXISTS');assert.equal(store.get('SELECT id FROM daily_reports WHERE id=?',body.id),undefined);
 const newcomer=await makeRep(), collision=daily();
 store.transaction=fn=>{insertDailyReport(store,other.id,null,newDailyReportSchema.parse(collision),Date.now(),'Africa/Cairo');transaction(fn);};
 try{response=await client.post('/api/daily-reports').set(newcomer.auth).send(collision);}finally{store.transaction=transaction;}
 assert.equal(response.status,409);assert.equal(response.body.report,undefined);
});

test('report review and delete roll back with audit failures, including daily visits',async()=>{
 const actor=await makeRep(), q=quick(), d=daily();
 assert.equal((await client.post('/api/reports').set(actor.auth).send(q)).status,201);
 assert.equal((await client.post('/api/daily-reports').set(actor.auth).send(d)).status,201);
 const cases=[
  {action:'report.review',send:()=>client.patch(`/api/reports/${q.id}`).set(admin).send({status:'reviewed'}),check:()=>assert.equal(store.get('SELECT status FROM reports WHERE id=?',q.id)?.status,'new')},
  {action:'daily_report.review',send:()=>client.patch(`/api/daily-reports/${d.id}`).set(admin).send({status:'reviewed'}),check:()=>assert.equal(store.get('SELECT status FROM daily_reports WHERE id=?',d.id)?.status,'new')},
  {action:'report.delete',send:()=>client.delete(`/api/reports/${q.id}`).set(admin),check:()=>assert.ok(store.get('SELECT id FROM reports WHERE id=?',q.id))},
  {action:'daily_report.delete',send:()=>client.delete(`/api/daily-reports/${d.id}`).set(admin),check:()=>{assert.ok(store.get('SELECT id FROM daily_reports WHERE id=?',d.id));assert.ok(store.get('SELECT id FROM daily_report_visits WHERE report_id=?',d.id));}},
 ];
 for(const c of cases){store.db.exec(`CREATE TRIGGER fail_report_edit_audit BEFORE INSERT ON audit_log WHEN NEW.action='${c.action}' BEGIN SELECT RAISE(ABORT,'audit failure'); END`);try{assert.equal((await c.send()).status,500);c.check();}finally{store.db.exec('DROP TRIGGER fail_report_edit_audit');}}
 for(const [path,id,action] of [['reports',q.id,'report.review'],['daily-reports',d.id,'daily_report.review']]){
  assert.equal((await client.patch(`/api/${path}/${id}`).set(admin).send({status:'reviewed'})).status,200);
  assert.equal((await client.patch(`/api/${path}/${id}`).set(admin).send({status:'reviewed'})).status,200);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM audit_log WHERE action=? AND metadata LIKE ?',action,`%${id}%`)?.n,1);
 }
});
