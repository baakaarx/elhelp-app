import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldQueue } from '../../mobile/src/retry.js';

/**
 * What the two report screens treat as "keep it and try later".
 *
 * Only a thrown fetch (status 0) used to count, so a 502 from the proxy while the service was
 * being restarted lost the report the engineer had just typed.
 */
const err = (status: number) => Object.assign(new Error('x'), { status });

test('no connection and a server that is down are queued', () => {
  for (const status of [0, 500, 502, 503, 504, 429]) {
    assert.equal(shouldQueue(err(status)), true, `status ${status} should be queued`);
  }
});

test('a rejected request is shown to the engineer, never queued', () => {
  for (const status of [400, 401, 403, 409, 422]) {
    assert.equal(shouldQueue(err(status)), false, `status ${status} must not be queued`);
  }
});

test('an error without a status counts as offline', () => {
  assert.equal(shouldQueue(new Error('network down')), true);
  assert.equal(shouldQueue(null), true);
});
