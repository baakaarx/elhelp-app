import test from 'node:test';
import assert from 'node:assert/strict';
import { queueableAccuracy } from '../../mobile/src/trackingAccuracy.js';

test('weak and invalid accuracy cannot produce a fabricated fresh GPS fix', () => {
 for (const accuracy of [121, 300, 0, -1, Infinity, NaN]) assert.equal(queueableAccuracy(accuracy, 120), false);
 for (const accuracy of [1, 100, 120, null, undefined]) assert.equal(queueableAccuracy(accuracy, 120), true);
});
