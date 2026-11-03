import assert from 'node:assert/strict';
import test from 'node:test';
import { distanceMeters, type GeoPoint } from '../src/geo.js';

/**
 * Distance used to add up every consecutive pair of fixes, so a phone sitting on a desk with
 * ±20m GPS jitter "drove" several kilometers. These cases pin down the conservative rule:
 * a move only counts when it is bigger than the GPS accuracy behind it.
 */
const point = (lat: number, lng: number, accuracy: number, recordedAt: number): GeoPoint => ({ lat, lng, accuracy, speed: null, recordedAt });
const BASE = { lat: 31.2, lng: 29.9 };

test('standing still with GPS jitter does not add phantom distance', () => {
  // Real jitter is random, not a neat path: a parked phone wanders a few meters each reading.
  let seed = 42;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const points: GeoPoint[] = [];
  for (let i = 0; i < 120; i++) {
    const lat = BASE.lat + (random() - 0.5) * 0.00036; // ±20m
    const lng = BASE.lng + (random() - 0.5) * 0.00036;
    points.push(point(lat, lng, 25, 1_700_000_000_000 + i * 5000)); // 10 minutes parked
  }
  const meters = distanceMeters(points);
  assert.ok(meters < 80, `a parked phone must not accrue kilometers, got ${meters}`);
});

test('real movement between fixes is counted', () => {
  const points: GeoPoint[] = [];
  for (let i = 0; i < 4; i++) {
    points.push(point(BASE.lat + i * 0.0006, BASE.lng, 10, 1_700_000_000_000 + i * 30000));
  }
  const meters = distanceMeters(points);
  assert.ok(meters > 180 && meters < 215, `expected ~200m, got ${meters}`);
});

test('a single bad fix cannot teleport the route', () => {
  const points = [
    point(BASE.lat, BASE.lng, 8, 1_700_000_000_000),
    point(BASE.lat + 0.05, BASE.lng + 0.05, 8, 1_700_000_001_000), // ~7km in 1s
    point(BASE.lat + 0.0006, BASE.lng, 8, 1_700_000_060_000),
  ];
  const meters = distanceMeters(points);
  assert.ok(meters < 80, `the jump must not be counted, got ${meters}`);
});

test('points that report unusable accuracy are ignored', () => {
  const points = [
    point(BASE.lat, BASE.lng, 8, 1_700_000_000_000),
    point(BASE.lat + 0.003, BASE.lng, 900, 1_700_000_030_000), // network guess
    point(BASE.lat + 0.0006, BASE.lng, 8, 1_700_000_060_000),
  ];
  const meters = distanceMeters(points);
  assert.ok(meters > 50 && meters < 80, `expected the clean segment only, got ${meters}`);
});
