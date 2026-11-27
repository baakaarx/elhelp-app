import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheFix, discardCachedFixForMockLocation, getCachedFix, lastKnownMaxAge } from '../../mobile/src/locationCache.js';

const fix = { lat: 31.2, lng: 29.9, accuracy: 8 };

test('a mocked native location invalidates an otherwise fresh cached GPS fix', () => {
  const now = Date.now();
  cacheFix(fix, now);
  assert.deepEqual(getCachedFix(30000, now + 1000), fix, 'the trusted fix is normally reusable');

  // Both foreground and background tracking call this as soon as the OS marks a position mocked.
  discardCachedFixForMockLocation();
  assert.equal(getCachedFix(30000, now + 1000), null, 'a later form must obtain a fresh OS fix');
});

test('cached GPS still expires at the requested freshness window', () => {
  const now = Date.now();
  cacheFix(fix, now);
  assert.equal(getCachedFix(30000, now + 30000), null);
});

test('fresh GPS requests do not use a last-known fix and other requests respect the age limit', () => {
  assert.equal(lastKnownMaxAge(0), null);
  assert.equal(lastKnownMaxAge(30000), 30000);
  assert.equal(lastKnownMaxAge(-1), null);
  assert.equal(lastKnownMaxAge(NaN), null);
});
