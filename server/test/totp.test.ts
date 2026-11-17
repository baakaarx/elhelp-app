import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { base32Decode, base32Encode, newTotpSecret, otpauthUrl, totpCode, verifyTotp } from '../src/totp.js';

/**
 * A manager account can see every trail, every collection and every account. A password is the
 * one secret that leaks through a shared laptop or a screenshot; six digits from a phone cost the
 * owner ten seconds a day.
 */
test('the algorithm matches the RFC 6238 vectors', () => {
  // The RFC's own secret, "12345678901234567890", as base32.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpCode(secret, 59 * 1000), '287082');
  assert.equal(totpCode(secret, 1111111109 * 1000), '081804');
  assert.equal(totpCode(secret, 1234567890 * 1000), '005924');
});

test('base32 survives what people paste', () => {
  const secret = newTotpSecret();
  assert.equal(secret.length, 32);
  assert.equal(base32Encode(base32Decode(secret)), secret);
  const messy = secret.toLowerCase().replace(/(.{4})/g, '$1 ').trim();
  assert.equal(totpCode(messy, 1000), totpCode(secret, 1000));
  assert.throws(() => base32Decode('not base32!'));
});

test('the code window is one step either side, not ten', () => {
  const secret = newTotpSecret();
  const at = 1_700_000_000_000;
  assert.ok(verifyTotp(secret, totpCode(secret, at), at));
  assert.ok(verifyTotp(secret, totpCode(secret, at - 30000), at), 'the code that just changed');
  assert.ok(verifyTotp(secret, totpCode(secret, at + 30000), at), 'a phone running a step ahead');
  assert.ok(!verifyTotp(secret, totpCode(secret, at + 90000), at), 'three steps ahead is not a drift');
  assert.ok(!verifyTotp(secret, '12345', at), 'five digits is not a code');
  assert.ok(!verifyTotp(secret, '', at));
});

test('the setup link is what an authenticator app expects', () => {
  const secret = newTotpSecret();
  const url = otpauthUrl(secret, 'manager@company.com');
  assert.ok(url.startsWith('otpauth://totp/'));
  assert.match(url, new RegExp(`secret=${secret}`));
  assert.match(url, /digits=6/);
  assert.match(url, /period=30/);
});

test('the setup CLI works from a clean checkout without server/dist', () => {
  const cliUrl = new URL('../../scripts/totp.mjs', import.meta.url);
  const cliSource = readFileSync(cliUrl, 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.totp, 'node --experimental-strip-types scripts/totp.mjs');
  assert.match(cliSource, /server\/src\/totp\.ts/);
  assert.doesNotMatch(cliSource, /server\/dist/);

  const root = fileURLToPath(new URL('../../', import.meta.url));
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', fileURLToPath(cliUrl), '--code', secret,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /code now:\s+\d{6}/);
  assert.match(result.stdout, /next code:\s+\d{6}/);
});

const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@totp.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  staleGpsMinutes: 10, idleReasonMinutes: 60,
  adminTotpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
};
const instance = createApp(config);
const { app } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

test('the manager login asks for the six digits', async () => {
  const withoutCode = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
  assert.equal(withoutCode.status, 401);
  assert.equal(withoutCode.body.code, 'TOTP_REQUIRED');

  const wrong = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword, code: '000000' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'TOTP_INVALID');

  const right = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword, code: totpCode(config.adminTotpSecret) });
  assert.equal(right.status, 200, JSON.stringify(right.body));
  assert.ok(right.body.token, 'and a session is issued only then');
});

test('a wrong password is still a wrong password, not a hint about two-factor', async () => {
  const res = await client.post('/api/auth/login').send({ email: config.adminEmail, password: 'wrong-password', code: totpCode(config.adminTotpSecret) });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, undefined);
  assert.match(String(res.body.error), /كلمة المرور/);
});
