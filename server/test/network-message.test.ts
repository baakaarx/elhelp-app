import assert from 'node:assert/strict';
import test from 'node:test';
import { networkMessage } from '../../mobile/src/networkMessage.js';

test('a lost write response warns that it may have reached the server without claiming local storage', () => {
  for (const path of ['/api/orders', '/api/reports', '/api/shifts/start', '/api/me']) {
    const message = networkMessage(path, 'POST');
    assert.match(message, /قد تكون العملية وصلت/);
    assert.match(message, /قبل تكرارها/);
    assert.doesNotMatch(message, /محفوظ|لم يُحفظ/);
  }
});

test('reads and sign-in failures suggest checking the server and network', () => {
  for (const [path, method] of [['/api/me', 'GET'], ['/api/auth/login', 'POST'], ['/api/auth/oauth', 'POST']]) {
    const message = networkMessage(path, method);
    assert.match(message, /تشغيل السيرفر/);
    assert.doesNotMatch(message, /قد تكون العملية وصلت/);
  }
});
