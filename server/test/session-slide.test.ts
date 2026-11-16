import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MAX_SESSION_MS, SESSION_MS, tokenHash } from '../src/auth.js';

/**
 * A session used all day must not expire in the middle of it.
 *
 * The expiry was fixed at twelve hours from the login, so a shift that started at eight in the
 * morning lost its engineer at eight in the evening: the app dropped to the login screen and the
 * phone stopped reporting the position he was still expected to be reporting.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@slide.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  staleGpsMinutes: 10, idleReasonMinutes: 60,
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

async function signedIn() {
  const login = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
  return String(login.body.token);
}

test('a used session slides forward instead of expiring at the twelve-hour mark', async () => {
  const token = await signedIn();
  // An hour from dying: the state a session reaches at the end of a long shift.
  const almostDone = Date.now() + 60 * 60000;
  store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?', almostDone, tokenHash(token));

  const me = await client.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(me.status, 200);
  const expiry = Number(store.get('SELECT expires_at FROM sessions WHERE token_hash=?', tokenHash(token))!.expires_at);
  assert.ok(expiry > almostDone, 'the session was extended');
  assert.ok(expiry > Date.now() + SESSION_MS - 120000, 'and by a full session, not by a little');
});

test('a fresh session is not rewritten on every request', async () => {
  const token = await signedIn();
  const before = Number(store.get('SELECT expires_at FROM sessions WHERE token_hash=?', tokenHash(token))!.expires_at);
  await client.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  await client.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  const after = Number(store.get('SELECT expires_at FROM sessions WHERE token_hash=?', tokenHash(token))!.expires_at);
  assert.equal(after, before, 'a session issued a moment ago is already fresh');
});

test('an expired session stays expired', async () => {
  const token = await signedIn();
  store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?', Date.now() - 1000, tokenHash(token));
  assert.equal((await client.get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status, 401);
  const row = store.get('SELECT expires_at FROM sessions WHERE token_hash=?', tokenHash(token));
  assert.ok(!row || Number(row.expires_at) <= Date.now(), 'and it is not resurrected');
});

test('a signed-out session is not resurrected by the slide', async () => {
  const token = await signedIn();
  await client.post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
  assert.equal((await client.get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status, 401);
});

test('the login of a session is still capped by the account, not by the clock', async () => {
  // The slide must not turn a stolen token into a permanent one: a session that is *not* used
  // keeps its original expiry.
  const token = await signedIn();
  const fixed = Date.now() + 30 * 60000;
  store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?', fixed, tokenHash(token));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(Number(store.get('SELECT expires_at FROM sessions WHERE token_hash=?', tokenHash(token))!.expires_at), fixed);
});

test('a used session never slides past thirty days from its first login', async () => {
  const token = await signedIn();
  const born = Date.now() - 29 * 86400000;
  // A credential copied off a phone and used every day for a month: it still has to die.
  store.run('UPDATE sessions SET created_at=? WHERE token_hash=?', born, tokenHash(token));
  store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?', Date.now() + 60000, tokenHash(token));

  const me = await client.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(me.status, 200, 'the day before the ceiling still works');
  const expiry = Number(store.get('SELECT expires_at FROM sessions WHERE token_hash=?', tokenHash(token))!.expires_at);
  assert.ok(expiry <= born + MAX_SESSION_MS + 1000, `slid to ${expiry}, past the ceiling`);
  assert.ok(expiry > Date.now(), 'but it is still alive today');

  // One day later the same token is worthless, however much it was used.
  store.run('UPDATE sessions SET created_at=? WHERE token_hash=?', Date.now() - MAX_SESSION_MS - 1000, tokenHash(token));
  store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?', Date.now() + 60000, tokenHash(token));
  const later = await client.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  const after = Number(store.get('SELECT expires_at FROM sessions WHERE token_hash=?', tokenHash(token))!.expires_at);
  assert.ok(after <= Date.now(), 'the ceiling stopped the slide');
  assert.ok([200, 401].includes(later.status));
});
