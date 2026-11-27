import assert from 'node:assert/strict';
import test from 'node:test';
import { outboxOwnership } from '../../mobile/src/outboxOwnership.js';

test('pending work is replayed only for the account that queued it', () => {
  assert.deepEqual(outboxOwnership('engineer-a', 'engineer-a', 3), { allowed: true });
  const switched = outboxOwnership('engineer-a', 'engineer-b', 3);
  assert.equal(switched.allowed, false);
  assert.match(switched.notice || '', /لن نرسلها بالحساب الحالي/);
  assert.match(switched.notice || '', /لا تمسح بيانات التطبيق/);
});

test('legacy work with no recorded owner remains on the device instead of being misattributed', () => {
  const legacy = outboxOwnership(null, 'engineer-b', 1);
  assert.equal(legacy.allowed, false);
  assert.match(legacy.notice || '', /مش معروف صاحبها/);
  assert.match(legacy.notice || '', /لا تمسح بيانات التطبيق/);
});

test('an unknown or signed-out session cannot replay saved work', () => {
  const signedOut = outboxOwnership('engineer-a', null, 2);
  assert.equal(signedOut.allowed, false);
  assert.match(signedOut.notice || '', /سجّل الدخول بالحساب الذي حفظها/);
});

test('an empty queue can safely be claimed by the next signed-in account', () => {
  assert.deepEqual(outboxOwnership('engineer-a', 'engineer-b', 0), { allowed: true });
});
