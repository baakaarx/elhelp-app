import assert from 'node:assert/strict';
import test from 'node:test';
import { contentSecurityPolicy } from '../src/csp.js';

/**
 * The dashboard used to allow four third-party script origins (`accounts.google.com`,
 * `apis.google.com`, `www.gstatic.com`, `appleid.cdn-apple.com`) for a social sign-in that only
 * exists in the native app. These tests pin the two policies so a future edit cannot quietly
 * re-open the manager surface, and cannot drop what the engineer build really needs.
 */
const dashboard = contentSecurityPolicy(false);
const engineer = contentSecurityPolicy(true);
const directive = (policy: string, name: string) =>
  policy.split('; ').find(part => part.startsWith(`${name} `)) ?? '';

test('the manager dashboard loads no third-party script', () => {
  const script = directive(dashboard, 'script-src');
  assert.ok(script, 'script-src must be present');
  assert.match(script, /'self'/);
  assert.ok(!script.includes('google'), `unexpected Google script origin: ${script}`);
  assert.ok(!script.includes('apple'), `unexpected Apple script origin: ${script}`);
  assert.ok(!script.includes('unsafe-eval'), 'the dashboard bundle needs no eval');
  assert.ok(!script.includes('unsafe-inline'), 'no page on the manager surface has an inline script');
});

test('the engineer web build keeps the inline-script exception it needs', () => {
  assert.match(directive(engineer, 'script-src'), /'unsafe-inline'/, 'Metro inlines its bootstrap');
});

test('the dashboard loads no remote font or stylesheet', () => {
  assert.ok(!directive(dashboard, 'style-src').includes('google'));
  assert.ok(!directive(dashboard, 'font-src').includes('gstatic'));
});

test('the engineer web build keeps eval and its Google-hosted font', () => {
  assert.match(directive(engineer, 'script-src'), /'unsafe-eval'/, 'Metro needs eval');
  assert.match(directive(engineer, 'font-src'), /fonts\.gstatic\.com/);
  assert.ok(!directive(engineer, 'script-src').includes('google'), 'a font host must never be a script host');
});

test('the map still works: tiles and reverse geocoding stay allowed', () => {
  for (const policy of [dashboard, engineer]) {
    assert.match(directive(policy, 'img-src'), /https:\/\/server\.arcgisonline\.com/);
    assert.match(directive(policy, 'connect-src'), /https:\/\/geocode\.arcgis\.com/);
    assert.match(directive(policy, 'connect-src'), /wss:/, 'Socket.IO must be able to upgrade');
  }
});

test('the websocket allowance is the request host, not every host', () => {
  const named = contentSecurityPolicy(false, 'tracking.example.com');
  const connect = directive(named, 'connect-src');
  assert.match(connect, /wss:\/\/tracking\.example\.com/);
  assert.match(connect, /ws:\/\/tracking\.example\.com/);
  assert.ok(!/(^| )wss:( |$)/.test(connect), `a bare scheme must be gone: ${connect}`);
  // A header that cannot be pasted into a policy falls back instead of emitting broken syntax.
  for (const host of ['', null, 'evil.com; script-src *', 'a b', "x'", 'tracking.example.com/../../x']) {
    const policy = directive(contentSecurityPolicy(false, host as string | null), 'connect-src');
    assert.match(policy, /(^| )wss:( |$)/, `"${host}" should fall back to the scheme`);
    assert.ok(!policy.includes('script-src'), 'a host can never inject a directive');
  }
  // IPv6 literal plus port is a legal host and must survive verbatim.
  assert.match(directive(contentSecurityPolicy(false, '[::1]:3000'), 'connect-src'), /wss:\/\/\[::1\]:3000/);
});

test('both surfaces keep the hardening directives', () => {
  for (const policy of [dashboard, engineer]) {
    assert.equal(directive(policy, 'default-src'), "default-src 'self'");
    assert.equal(directive(policy, 'object-src'), "object-src 'none'");
    assert.equal(directive(policy, 'frame-src'), "frame-src 'none'");
    assert.equal(directive(policy, 'base-uri'), "base-uri 'self'");
    assert.equal(directive(policy, 'form-action'), "form-action 'self'");
    assert.equal(directive(policy, 'frame-ancestors'), "frame-ancestors 'self'");
  }
});
