import assert from 'node:assert/strict';
import test from 'node:test';
import { isPushToken, sendPush, setPushTransport, type PushMessage } from '../src/push.js';

const token = (n: number) => `ExpoPushToken[${String(n).padStart(24, '0')}]`;

test('only Expo or Exponent push tokens with a non-empty payload are accepted', () => {
  assert.equal(isPushToken(token(1)), true);
  assert.equal(isPushToken(`ExponentPushToken[${'a'.repeat(24)}]`), true);
  assert.equal(isPushToken('fcm-device-token'), false);
  assert.equal(isPushToken('ExpoPushToken[]'), false);
  assert.equal(isPushToken('ExpoPushToken[not a token]'), false);
  assert.equal(isPushToken(null), false);
});

test('pushes are sent in batches of 100 and invalid input is not sent', async () => {
  const bodies: Array<Array<{ to: string }>> = [];
  setPushTransport(async body => {
    const messages = JSON.parse(body) as Array<{ to: string }>;
    bodies.push(messages);
    return { status: 200, json: { data: messages.map(() => ({ status: 'ok' })) } };
  });
  try {
    const messages: PushMessage[] = Array.from({ length: 201 }, (_, index) => ({
      to: token(index), title: 'تحديث', body: 'افتح التطبيق',
    }));
    messages.push({ to: 'not-a-token', title: 'ignored', body: 'ignored' });
    const result = await sendPush(messages);
    assert.deepEqual(bodies.map(batch => batch.length), [100, 100, 1]);
    assert.equal(result.delivered, 201);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.invalid, []);
  } finally { setPushTransport(null); }
});

test('an uninstalled device is separated from retryable service failures', async () => {
  setPushTransport(async body => {
    const messages = JSON.parse(body) as Array<{ to: string }>;
    return {
      status: 200,
      json: { data: [
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', details: { error: 'MessageRateExceeded' } },
        ...messages.slice(2).map(() => ({ status: 'ok' })),
      ] },
    };
  });
  try {
    const result = await sendPush([0, 1, 2].map(n => ({ to: token(n), title: 'x', body: 'y' })));
    assert.deepEqual(result.invalid, [token(0)]);
    assert.equal(result.failed, 1);
    assert.equal(result.delivered, 1);
  } finally { setPushTransport(null); }
});

test('a failing push service never throws into a saved operation', async () => {
  setPushTransport(async () => { throw new Error('offline'); });
  try {
    const result = await sendPush([{ to: token(1), title: 'x', body: 'y' }]);
    assert.deepEqual(result, { delivered: 0, invalid: [], failed: 1 });
  } finally { setPushTransport(null); }
});
