import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { tokenHash } from '../src/auth.js';
import { AUTO_CLOSED_OUTCOME } from '../src/db.js';
import { bookForToken } from './book.js';

/**
 * A visit typed where there is no signal.
 *
 * The app queues positions and reports, but a visit used to be refused outright: "لا يوجد اتصال"
 * and the customer visit was gone. Nothing about that is acceptable in a field product — the one
 * record the whole audit trail is built on disappeared because the farm had no bars.
 *
 * The phone now keeps the visit and sends it when the signal returns, naming the moment it was
 * recorded. The server accepts that moment only inside one of the engineer's own shifts and only
 * within a day, and marks the row so a replayed visit is never mistaken for a live one.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@offline.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  staleGpsMinutes: 10, idleReasonMinutes: 60,
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

const HOUR = 3600000;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let adminToken = '';
async function admin() {
  if (!adminToken) adminToken = String((await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword })).body.token);
  return adminToken;
}
async function makeRep(tag: string) {
  const email = `${tag}.${Date.now()}@offline.test`;
  // The token is resolved first: awaiting inside supertest's chain detaches the request from
  // the server and it fails with "Cannot read properties of null (reading 'address')".
  const adminTokenValue = await admin();
  const created = await client.post('/api/reps').set(auth(adminTokenValue))
    .send({ region: 'منطقة اختبار', name: `مهندس ${tag}`, email, password: 'RepPassword123!' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = String(created.body.user.id);
  const token = randomBytes(32).toString('base64url');
  store.run('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)',
    tokenHash(token), id, Date.now() + HOUR, Date.now());
  return { id, token, device: `device-${id.slice(0, 6)}` };
}
/** A shift that started an hour ago, so a visit can be replayed inside it. */
async function openShiftSince(rep: { token: string; device: string }, startedAgo: number) {
  const started = await client.post('/api/shifts/start').set(auth(rep.token))
    .send({ consentVersion: '1.0', deviceId: rep.device, deviceName: 'هاتف', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const shiftId = String(started.body.shift.id);
  store.run('UPDATE shifts SET started_at=? WHERE id=?', Date.now() - startedAgo, shiftId);
  return shiftId;
}
// Every body here is a visit the office book has to recognise, and the row is looked up from the
// token so the fixture stays one line: the payload of each test keeps describing its own case.
const checkIn = (token: string, body: Record<string, unknown>) =>
  client.post('/api/visits/check-in').set(auth(token)).send({ customerId: bookForToken(store, token, String(body.customerName || 'عميل التجربة')), ...body });
const visit = (token: string, id: string, body: Record<string, unknown>) =>
  client.post(`/api/visits/${id}/check-out`).set(auth(token)).send(body);

test('a visit recorded with no signal is accepted with the time the phone kept', async () => {
  const rep = await makeRep('offline');
  await openShiftSince(rep, HOUR);
  const id = randomUUID();
  const recordedAt = Date.now() - 40 * 60000;
  const res = await checkIn(rep.token, {
    id, customerName: 'مزرعة بدون شبكة', purpose: 'collection', location: { lat: 31.2, lng: 29.9, accuracy: 9 }, recordedAt,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.recordedOffline, true);
  assert.equal(res.body.visit.checkedInAt, recordedAt, 'the time the engineer actually arrived');
  assert.equal(res.body.visit.recordedOffline, true);
  const audit = store.get("SELECT * FROM audit_log WHERE action='visit.check_in_offline' AND user_id=?", rep.id);
  assert.ok(audit, 'the replay is in the audit trail');
});

test('an old queued visit survives without treating its amount as a receipt', async () => {
  const rep = await makeRep('roundtrip'); await openShiftSince(rep, 3 * HOUR);
  const id = randomUUID(), inAt = Date.now() - 2 * HOUR, outAt = inAt + 75 * 60000;
  assert.equal((await checkIn(rep.token, { id, customerName: 'مزرعة الجولة', purpose: 'collection', location: { lat: 31.2, lng: 29.9, accuracy: 8 }, recordedAt: inAt })).status, 201);
  const body = { outcome: 'متابعة', notes: '', amount: 900, location: null, recordedAt: outAt };
  const denied = await visit(rep.token, id, body);
  assert.equal(denied.status, 403); assert.equal(denied.body.code, 'FIELD_COLLECTION_DISABLED');
  assert.equal(store.get('SELECT status FROM visits WHERE id=?', id)?.status, 'open');
  assert.equal(store.get('SELECT id FROM reports WHERE id=?', `visit:${id}`), undefined);
  const closed = await visit(rep.token, id, { ...body, amount: null });
  assert.equal(closed.status, 200); assert.equal(closed.body.visit.checkedOutAt, outAt);
  assert.equal(closed.body.visit.durationSeconds, 75 * 60); assert.equal(closed.body.visit.recordedOffline, true);
});

test('a replayed visit is refused outside the shift it claims', async () => {
  const rep = await makeRep('outside');
  const shiftId = await openShiftSince(rep, HOUR);
  store.run('UPDATE shifts SET started_at=? WHERE id=?', Date.now() - 2 * HOUR, shiftId);
  // Two hours ago is before this shift started.
  const res = await checkIn(rep.token, { id: randomUUID(), customerName: 'مزرعة قبل الوردية', location: { lat: 31.2, lng: 29.9, accuracy: 8 }, recordedAt: Date.now() - 3 * HOUR });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.code, 'OFFLINE_VISIT_REJECTED');
});

test('a replayed visit is refused when the phone held it too long', async () => {
  const rep = await makeRep('stale');
  await openShiftSince(rep, 30 * HOUR);
  const res = await checkIn(rep.token, { id: randomUUID(), customerName: 'مزرعة قديمة', location: { lat: 31.2, lng: 29.9, accuracy: 8 }, recordedAt: Date.now() - 25 * HOUR });
  assert.equal(res.status, 422);
  assert.match(String(res.body.error), /٢٤ ساعة/);
});

test('a replayed visit cannot claim the future', async () => {
  const rep = await makeRep('future');
  await openShiftSince(rep, HOUR);
  assert.equal((await checkIn(rep.token, { id: randomUUID(), customerName: 'مزرعة المستقبل', location: { lat: 31.2, lng: 29.9, accuracy: 8 }, recordedAt: Date.now() + 5 * 60000 })).status, 422);
});

test('a replayed check-out cannot end before the visit began', async () => {
  const rep = await makeRep('backwards');
  await openShiftSince(rep, 3 * HOUR);
  const id = randomUUID();
  const inAt = Date.now() - 60 * 60000;
  assert.equal((await checkIn(rep.token, { id, customerName: 'مزرعة الترتيب', location: { lat: 31.2, lng: 29.9, accuracy: 8 }, recordedAt: inAt })).status, 201);
  const res = await visit(rep.token, id, { outcome: 'نتيجة', notes: '', amount: null, location: null, recordedAt: inAt - HOUR });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  const row = store.get('SELECT status, checked_out_at FROM visits WHERE id=?', id)!;
  assert.equal(row.status, 'open', 'and the visit is untouched');
});

test('a replayed visit that arrives while another is open is kept as a missing result', async () => {
  const rep = await makeRep('conflict');
  await openShiftSince(rep, 5 * HOUR);
  // A live visit is open right now.
  const live = randomUUID();
  assert.equal((await checkIn(rep.token, { id: live, customerName: 'زيارة جارية', location: { lat: 31.2, lng: 29.9, accuracy: 8 } })).status, 201);
  // An older visit, recorded offline, is replayed in the middle of it.
  const id = randomUUID();
  const inAt = Date.now() - 3 * HOUR;
  const outAt = inAt + 40 * 60000;
  const res = await checkIn(rep.token, { id, customerName: 'مزرعة متأخرة', location: { lat: 31.1, lng: 29.8, accuracy: 8 }, recordedAt: inAt });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.visit.status, 'closed', 'it does not steal the open slot');
  assert.equal(res.body.visit.outcome, AUTO_CLOSED_OUTCOME);
  assert.equal(res.body.visit.pendingResult, true, 'and it asks for its result');

  // The rest of the queued pair writes the result and the real duration.
  const closed = await visit(rep.token, id, { outcome: 'اتقفلت من غير شبكة', notes: '', amount: null, location: null, recordedAt: outAt });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.recordedLate, true);
  assert.equal(closed.body.visit.outcome, 'اتقفلت من غير شبكة');
  assert.equal(closed.body.visit.durationSeconds, 40 * 60);
  assert.equal(closed.body.visit.autoClosed, true, 'still outside the KPI average');
  assert.equal(store.get('SELECT status FROM visits WHERE id=?', live)!.status, 'open', 'the live visit is untouched');
});

test('a live visit still works exactly as before', async () => {
  const rep = await makeRep('live');
  await openShiftSince(rep, HOUR);
  const id = randomUUID();
  const res = await checkIn(rep.token, { id, customerName: 'مزرعة عادية', location: { lat: 31.2, lng: 29.9, accuracy: 8 } });
  assert.equal(res.status, 201);
  assert.equal(res.body.visit.recordedOffline, false);
  assert.ok(Math.abs(Number(res.body.visit.checkedInAt) - Date.now()) < 5000, 'the server clock is used');
  const closed = await visit(rep.token, id, { outcome: 'نتيجة', notes: '', amount: null, location: null });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.visit.recordedOffline, false);
});

test('a failed audit rolls back normal and automatically closed visit results, allowing a safe retry', async () => {
  const rep = await makeRep('visit-atomic'); await openShiftSince(rep, HOUR);
  for (const automatic of [false, true]) {
    const id = randomUUID();
    assert.equal((await checkIn(rep.token, { id, customerName: `عميل ${automatic}`, purpose: 'visit', location: { lat: 31.2, lng: 29.9, accuracy: 8 } })).status, 201);
    if (automatic) store.run("UPDATE visits SET status='closed', auto_closed=1, outcome=? WHERE id=?", AUTO_CLOSED_OUTCOME, id);
    const before = store.get('SELECT status, outcome, checked_out_at FROM visits WHERE id=?', id);
    store.db.exec("CREATE TRIGGER fail_visit_audit_for_test BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    const body = { outcome: 'متابعة', notes: '', amount: null, location: null };
    try {
      assert.equal((await visit(rep.token, id, body)).status, 500);
      assert.deepEqual(store.get('SELECT status, outcome, checked_out_at FROM visits WHERE id=?', id), before);
    } finally { store.db.exec('DROP TRIGGER fail_visit_audit_for_test'); }
    assert.equal((await visit(rep.token, id, body)).status, 200);
    assert.equal((await visit(rep.token, id, body)).body.duplicate, true);
  }
});

test('visit check-in and audit commit together, with safe retry after failure', async () => {
  const rep=await makeRep('visit-start-atomic'); await openShiftSince(rep,HOUR);
  const id=randomUUID(), body={id,customerName:'عميل التدقيق',location:{lat:31.2,lng:29.9,accuracy:8}};
  store.db.exec("CREATE TRIGGER fail_visit_start_audit BEFORE INSERT ON audit_log WHEN NEW.action='visit.check_in' BEGIN SELECT RAISE(ABORT,'visit audit failed'); END");
  try { assert.equal((await checkIn(rep.token,body)).status,500); assert.equal(store.get('SELECT id FROM visits WHERE id=?',id),undefined); }
  finally {store.db.exec('DROP TRIGGER fail_visit_start_audit');}
  assert.equal((await checkIn(rep.token,body)).status,201);
  assert.equal((await checkIn(rep.token,body)).body.duplicate,true);
});

test('check-in checks open visit again under the lock and refuses a different payload for an existing id',async()=>{
  const rep=await makeRep('visit-start-race');await openShiftSince(rep,HOUR);
  const first=randomUUID(), input={id:first,customerName:'عميل السباق الأول',location:{lat:31.2,lng:29.9,accuracy:8}};
  assert.equal((await checkIn(rep.token,input)).status,201);
  assert.equal((await checkIn(rep.token,{...input,location:{lat:31.3,lng:29.9,accuracy:8}})).body.code,'VISIT_ID_IN_USE');
  store.run("UPDATE visits SET status='closed' WHERE id=?",first);
  const transaction=store.transaction.bind(store), second=randomUUID();
  store.transaction=fn=>{store.run("UPDATE visits SET status='open' WHERE id=?",first);transaction(fn);};
  let result;try {result=await checkIn(rep.token,{id:second,customerName:'عميل السباق الثاني',location:{lat:31.2,lng:29.9,accuracy:8}});}finally{store.transaction=transaction;}
  assert.equal(result.status,409);assert.equal(result.body.openVisitId,first);
  assert.equal(store.get('SELECT id FROM visits WHERE id=?',second),undefined);
});

test('concurrent checkout or late-result save does not overwrite an existing result',async()=>{
 const rep=await makeRep('visit-close-race');await openShiftSince(rep,HOUR);
 for(const automatic of [false,true]) {
  const id=randomUUID();assert.equal((await checkIn(rep.token,{id,customerName:`عميل إغلاق ${automatic}`,location:{lat:31.2,lng:29.9,accuracy:8}})).status,201);
  if(automatic)store.run("UPDATE visits SET status='closed',auto_closed=1,outcome=? WHERE id=?",AUTO_CLOSED_OUTCOME,id);
  const transaction=store.transaction.bind(store);
  store.transaction=fn=>{store.run("UPDATE visits SET status='closed',outcome='نتيجة وصلت أولاً' WHERE id=?",id);transaction(fn);};
  let result;try{result=await visit(rep.token,id,{outcome:'نتيجة متأخرة مختلفة',notes:'',amount:null,location:null});}finally{store.transaction=transaction;}
  assert.equal(result.status,409);assert.equal(result.body.code,'VISIT_CHANGED');
  assert.equal(store.get('SELECT outcome FROM visits WHERE id=?',id)?.outcome,'نتيجة وصلت أولاً');
  assert.equal((await visit(rep.token,id,{outcome:'نتيجة متأخرة مختلفة',notes:'',amount:null,location:null})).body.code,'VISIT_RESULT_CONFLICT');
 }
});

test('deleting a visit rolls back if its audit cannot be saved',async()=>{
 const rep=await makeRep('delete-audit');await openShiftSince(rep,HOUR);
 const id=randomUUID(), created=await checkIn(rep.token,{id,customerName:'مزرعة حذف',purpose:'visit',location:{lat:31.2,lng:29.9,accuracy:8}});
 assert.equal(created.status,201,JSON.stringify(created.body));
 store.db.exec("CREATE TRIGGER fail_delete_visit BEFORE INSERT ON audit_log WHEN NEW.action='visit.delete' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
 try{const result=await client.delete(`/api/visits/${id}`).set(auth(await admin()));assert.equal(result.status,500);assert.ok(store.get('SELECT id FROM visits WHERE id=?',id));}
 finally{store.db.exec('DROP TRIGGER fail_delete_visit');}
 assert.equal((await client.delete(`/api/visits/${id}`).set(auth(await admin()))).status,200);
});
