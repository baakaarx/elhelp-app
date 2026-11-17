import assert from 'node:assert/strict';
import test from 'node:test';
import { trustedFix, isMockedLocation, MOCK_LOCATION_MESSAGE, type NativeLocationLike } from '../../mobile/src/locationIntegrity.js';

function position(mocked?: boolean, coords: NativeLocationLike['coords'] = { latitude: 31.2, longitude: 29.9, accuracy: 8 }): NativeLocationLike {
  return { coords, ...(mocked === undefined ? {} : { mocked }) };
}

test('OS-flagged simulated positions never become trusted fixes', () => {
  const simulated = position(true);
  assert.equal(isMockedLocation(simulated), true);
  assert.equal(trustedFix(simulated, 120), null);
  assert.match(MOCK_LOCATION_MESSAGE, /مُحاكى/);
});

test('real and older native positions without a mock verdict retain valid GPS', () => {
  const real = position(false);
  assert.equal(isMockedLocation(real), false);
  assert.deepEqual(trustedFix(real, 120), { lat: 31.2, lng: 29.9, accuracy: 8 });
  assert.equal(isMockedLocation(position()), false, 'missing OS metadata is not mistaken for a mock');
  assert.deepEqual(trustedFix(position(), 120), { lat: 31.2, lng: 29.9, accuracy: 8 });
});

test('the trust filter still rejects invalid coordinates and coarse guesses', () => {
  assert.equal(trustedFix(position(false, { latitude: 91, longitude: 29, accuracy: 8 }), 120), null);
  assert.equal(trustedFix(position(false, { latitude: 31, longitude: 29, accuracy: 121 }), 120), null);
});
