import assert from 'node:assert/strict';
import test from 'node:test';
import { contentSecurityPolicy } from '../src/csp.js';

const policy = contentSecurityPolicy();
const directive = (value: string, name: string) =>
  value.split('; ').find(part => part.startsWith(`${name} `)) ?? '';

test('every browser page uses the strict manager-site script policy', () => {
  const script = directive(policy, 'script-src');
  assert.equal(script, "script-src 'self'");
  assert.ok(!script.includes('unsafe-eval'));
  assert.ok(!script.includes('unsafe-inline'));
  assert.ok(!script.includes('google'));
  assert.ok(!script.includes('apple'));
});

test('the manager website loads no remote font or stylesheet', () => {
  assert.equal(directive(policy, 'font-src'), "font-src 'self' data:");
  assert.ok(!directive(policy, 'style-src').includes('google'));
  assert.ok(!directive(policy, 'font-src').includes('gstatic'));
});

test('the engineer website allows only the Apple sign-in SDK beyond same-origin scripts', () => {
  const engineer = contentSecurityPolicy('field.example.com', 'engineer');
  const script = directive(engineer, 'script-src');
  assert.equal(script, "script-src 'self' https://appleid.cdn-apple.com");
  assert.ok(!script.includes('unsafe-eval'));
  assert.ok(!script.includes('unsafe-inline'));
  assert.ok(!script.includes('accounts.google.com'));
  assert.match(directive(engineer, 'connect-src'), /https:\/\/appleid\.apple\.com/);
  assert.match(directive(engineer, 'frame-src'), /https:\/\/appleid\.apple\.com/);
  assert.equal(directive(policy, 'script-src'), "script-src 'self'", 'manager policy stays unchanged');
});

test('the map tiles and reverse geocoder remain available', () => {
  assert.match(directive(policy, 'img-src'), /https:\/\/server\.arcgisonline\.com/);
  assert.match(directive(policy, 'connect-src'), /https:\/\/geocode\.arcgis\.com/);
  assert.match(directive(policy, 'connect-src'), /wss:/, 'Socket.IO must be able to upgrade');
});

test('the websocket allowance is the request host, not every host', () => {
  const named = contentSecurityPolicy('tracking.example.com');
  const connect = directive(named, 'connect-src');
  assert.match(connect, /wss:\/\/tracking\.example\.com/);
  assert.match(connect, /ws:\/\/tracking\.example\.com/);
  assert.ok(!/(^| )wss:( |$)/.test(connect), `a bare scheme must be gone: ${connect}`);
  // A header that cannot be pasted into a policy falls back instead of emitting broken syntax.
  for (const host of ['', null, 'evil.com; script-src *', 'a b', "x'", 'tracking.example.com/../../x']) {
    const value = directive(contentSecurityPolicy(host), 'connect-src');
    assert.match(value, /(^| )wss:( |$)/, `"${host}" should fall back to the scheme`);
    assert.ok(!value.includes('script-src'), 'a host can never inject a directive');
  }
  // IPv6 literal plus port is a legal host and must survive verbatim.
  assert.match(directive(contentSecurityPolicy('[::1]:3000'), 'connect-src'), /wss:\/\/\[::1\]:3000/);
});

test('the dashboard policy keeps the browser hardening directives', () => {
  assert.equal(directive(policy, 'default-src'), "default-src 'self'");
  assert.equal(directive(policy, 'object-src'), "object-src 'none'");
  assert.equal(directive(policy, 'frame-src'), "frame-src 'none'");
  assert.equal(directive(policy, 'base-uri'), "base-uri 'self'");
  assert.equal(directive(policy, 'form-action'), "form-action 'self'");
  assert.equal(directive(policy, 'frame-ancestors'), "frame-ancestors 'self'");
});
