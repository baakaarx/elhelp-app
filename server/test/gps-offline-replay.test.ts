import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { replayLocationOutbox } from '../../mobile/src/locationQueue.js';
import type { GeoPoint } from '../../mobile/src/types.js';

const storage=new Map<string,string>();
(globalThis as unknown as {localStorage:Storage}).localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>{storage.set(k,v);},removeItem:k=>{storage.delete(k);},clear:()=>storage.clear(),key:()=>null,length:0} as Storage;
const {createQueue}=await import('../../mobile/src/queue.web.js');
const instance=createApp({dbPath:':memory:',production:false,adminEmail:'gps-offline@test.local',adminPassword:'AdminPassword123!',retentionDays:365,loginRateLimit:{windowMs:60000,limit:5000}});
const client=request(instance.app);test.after(async()=>instance.close());
const admin=(await client.post('/api/auth/login').send({email:'gps-offline@test.local',password:'AdminPassword123!'})).body.token;
await client.post('/api/reps').set('Authorization',`Bearer ${admin}`).send({name:'مهندس المزامنة',email:'gps-rep@test.local',password:'RepPassword123!',region:'الاسكندرية'});
const token=(await client.post('/api/auth/login').send({email:'gps-rep@test.local',password:'RepPassword123!'})).body.token;
const auth={Authorization:`Bearer ${token}`};
const start=await client.post('/api/shifts/start').set(auth).send({consentVersion:'1.0',deviceId:'gps-offline-phone',location:{lat:31.2,lng:29.9,accuracy:8}});
assert.equal(start.status,200);const shift=start.body.shift.id;
const now=Date.now(),hour=3600000;
instance.store.run('UPDATE shifts SET started_at=?,ended_at=? WHERE id=?',now-36*hour,now-25*hour,shift);
const makePoint=(id:string,at:number):GeoPoint=>({id,shiftId:shift,lat:31.2,lng:29.9,accuracy:8,speed:null,heading:null,battery:null,recordedAt:at});
const send=async(points:GeoPoint[])=>{const r=await client.post('/api/locations').set(auth).send({points});if(r.status!==200)throw Object.assign(new Error(r.body.error),{status:r.status,code:r.body.code});return r.body as {accepted:number;duplicates:number};};

test('old valid fixes are sent, rejected fixes remain, and valid newer work is not blocked',async()=>{
 const queue=await createQueue();const old=makePoint(randomUUID(),now-30*hour),bad=makePoint(randomUUID(),now-20*hour),other=makePoint(randomUUID(),now-29*hour);
 for(const p of [old,bad,other])await queue.add('location',p);
 assert.equal(await replayLocationOutbox(await queue.listForReplay(200),queue,send),2);
 assert.equal(await queue.countRejectedLocations(),1);assert.equal(await queue.count(),1);
 assert.equal(instance.store.get('SELECT COUNT(*) AS n FROM locations WHERE point_id IN (?,?)',old.id,other.id)?.n,2);
 assert.equal(instance.store.get('SELECT COUNT(*) AS n FROM locations WHERE point_id=?',bad.id)?.n,0);
 assert.deepEqual(await queue.listForReplay(),[]);
 assert.equal((await queue.listForReplay(200,true))[0].key,bad.id);
 const later=makePoint(randomUUID(),now-28*hour);await queue.add('location',later);
 assert.equal(await replayLocationOutbox(await queue.listForReplay(),queue,send),1);assert.equal(await queue.count(),1);
});

test('a lost acknowledgement retries the same IDs without duplicate points',async()=>{
 const queue=await createQueue();const p=makePoint(randomUUID(),now-27*hour);await queue.add('location',p);
 const lost=async(points:GeoPoint[])=>{await send(points);throw {status:0};};
 assert.equal(await replayLocationOutbox(await queue.listForReplay(),queue,lost),0);assert.equal(await queue.count(),2);
 assert.equal(await replayLocationOutbox(await queue.listForReplay(),queue,send),1);assert.equal(await queue.count(),1);
 assert.equal(instance.store.get('SELECT COUNT(*) AS n FROM locations WHERE point_id=?',p.id)?.n,1);
});

test('unreadable or mismatched row and unconfirmed response never remove saved data',async()=>{
 const queue=await createQueue();const p=makePoint(randomUUID(),now-26*hour);await queue.add('location',p);
 const items=await queue.listForReplay();const row=items.find(x=>x.key===p.id)!;
 const mismatched={...row,payload:JSON.stringify({...p,id:'different-key'})};
 let called=false;await replayLocationOutbox([mismatched],queue,async()=>{called=true;return {accepted:0,duplicates:0};});
 assert.equal(called,false);assert.ok((await queue.listForReplay(200,true)).find(x=>x.key===p.id)?.rejected);
 const q=makePoint(randomUUID(),now-26*hour);await queue.add('location',q);
 assert.equal(await replayLocationOutbox(await queue.listForReplay(),queue,async()=>({accepted:0,duplicates:0})),0);
 assert.ok((await queue.list()).some(x=>x.key===q.id));
});

test('manual retry sends previously rejected points when the server can accept them',async()=>{
 // Illustrates a reviewed/repaired shift boundary, without automatically altering one in production.
 instance.store.run('UPDATE shifts SET ended_at=? WHERE id=?',now-19*hour,shift);
 const queue=await createQueue();const rows=await queue.listForReplay(200,true);
 assert.equal(rows.length,3);assert.equal(await replayLocationOutbox(rows,queue,send),3);
 assert.equal(await queue.count(),0);assert.equal(await queue.countRejectedLocations(),0);
});
