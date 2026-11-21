import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySilence, PRESENT_FRESH_MS, stationaryMinutes, STATIONARY_RADIUS_M } from '../src/fieldStatus.js';

/**
 * The two judgements the manager's screen used to make with one word.
 *
 * `stale_gps` covered a dead battery, a revoked permission and a coverage hole alike, which made
 * it arguable in every direction. These tests pin the distinction itself — the phone reaching the
 * API is what separates "no network" from "no position" — because the wording on the dashboard is
 * only as honest as this rule.
 */
const MINUTE = 60_000;
const LIMIT = 10 * MINUTE;

test('a silence inside the window is not a fault at all', () => {
  assert.equal(classifySilence({ silenceMs: 9 * MINUTE, limitMs: LIMIT, presenceMs: Number.POSITIVE_INFINITY }), 'ok',
    'no fix yet but still inside the limit stays quiet, even for a phone that never talked');
});

test('a phone that still reaches the API is out of position, not out of network', () => {
  // This is the case that used to be argued about: the app is talking, so "النت واقع" cannot be true.
  assert.equal(classifySilence({ silenceMs: 40 * MINUTE, limitMs: LIMIT, presenceMs: 20_000 }), 'gps_blocked');
  assert.equal(classifySilence({ silenceMs: 40 * MINUTE, limitMs: LIMIT, presenceMs: PRESENT_FRESH_MS }), 'gps_blocked',
    'three missed polls is the boundary, inclusive');
});

test('silence with no requests is reported as silence, not as a verdict', () => {
  assert.equal(classifySilence({ silenceMs: 40 * MINUTE, limitMs: LIMIT, presenceMs: 6 * MINUTE }), 'gone',
    'a dead phone and a dead zone look identical, and the alert must say so');
  assert.equal(classifySilence({ silenceMs: 40 * MINUTE, limitMs: LIMIT, presenceMs: Number.POSITIVE_INFINITY }), 'gone');
});

test('a wider window keeps a standing visit quiet', () => {
  const visitLimit = 30 * MINUTE;
  assert.equal(classifySilence({ silenceMs: 20 * MINUTE, limitMs: visitLimit, presenceMs: Number.POSITIVE_INFINITY }), 'ok');
  assert.equal(classifySilence({ silenceMs: 31 * MINUTE, limitMs: visitLimit, presenceMs: 40 * MINUTE }), 'gone');
});

const at = (minutesAgo: number) => Date.now() - minutesAgo * MINUTE;
const fix = (lat: number, lng: number, minutesAgo: number) => ({ lat, lng, recordedAt: at(minutesAgo) });
/** 0.0001° of latitude ≈ 11 m, so `SPOT`/`JITTER` are one place and `ELSEWHERE` is not. */
const SPOT = { lat: 31.24, lng: 29.96 };
const JITTER = { lat: SPOT.lat + 0.0002, lng: SPOT.lng };
const ELSEWHERE = { lat: SPOT.lat + 0.001, lng: SPOT.lng };

test('standing still is measured, and a move resets it', () => {
  const still = [fix(SPOT.lat, SPOT.lng, 60), fix(SPOT.lat, SPOT.lng, 30), fix(SPOT.lat, SPOT.lng, 0)];
  assert.equal(stationaryMinutes(still), 60, 'the whole run counts from the first fix in the spot');

  const moved = [fix(SPOT.lat, SPOT.lng, 60), fix(ELSEWHERE.lat, ELSEWHERE.lng, 30), fix(SPOT.lat, SPOT.lng, 0)];
  assert.equal(stationaryMinutes(moved), 0, 'the newest point is alone in its spot after a move');

  assert.equal(stationaryMinutes([]), 0, 'no trail, no claim');
});

test('a fix inside the radius still counts as the same place', () => {
  const jitter = [fix(JITTER.lat, JITTER.lng, 20), fix(SPOT.lat, SPOT.lng, 0)];
  assert.ok(STATIONARY_RADIUS_M >= 25, 'the radius has to swallow normal GPS jitter');
  assert.equal(stationaryMinutes(jitter), 20);
});
