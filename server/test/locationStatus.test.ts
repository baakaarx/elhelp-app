import assert from 'node:assert/strict';
import test from 'node:test';
import { movementStatus, STALE_FIX_MS, WEAK_ACCURACY_M } from '../../dashboard/src/locationStatus.js';
import type { Rep } from '../../dashboard/src/types.js';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

function rep(overrides: Partial<Rep> = {}, fix: Partial<NonNullable<Rep['location']>> = {}): Rep {
  return {
    id: 'r1', name: 'أحمد حسن', color: '#27745a', region: 'مدينة نصر', isDemo: false, active: true,
    tracking: true, online: true, visitsToday: 0, openVisit: null, location: null,
    ...overrides,
    ...(overrides.location === null ? {} : {
      location: {
        lat: 31.2, lng: 29.9, accuracy: 12, speed: 3.2, recordedAt: NOW - 5000, ...fix,
      },
    }),
  } as unknown as Rep;
}

test('a moving engineer with a fresh, accurate fix reports movement', () => {
  assert.match(movementStatus(rep(), NOW), /يتحرك تقريبًا · 12 كم\/س/);
});

test('a stationary engineer is not reported as moving', () => {
  assert.match(movementStatus(rep({}, { speed: 0.2 }), NOW), /واقف تقريبًا/);
});

test('a fix a minute old is still fresh — the app heartbeats every 30s', () => {
  // This used to flip to "الإشارة قديمة" after 90s, which is shorter than one missed beat.
  assert.match(movementStatus(rep({}, { recordedAt: NOW - 60_000 }), NOW), /واقف|يتحرك/);
  assert.ok(STALE_FIX_MS > 120_000);
});

test('a fix older than the staleness window says how long it has been missing', () => {
  const text = movementStatus(rep({}, { recordedAt: NOW - (STALE_FIX_MS + 60_000) }), NOW);
  assert.match(text, /لا إشارة من 4 دقيقة/);
  assert.match(text, /آخر موقع معروف/);
});

test('a weak fix is described as weak instead of a confident position', () => {
  const text = movementStatus(rep({}, { accuracy: WEAK_ACCURACY_M + 60 }), NOW);
  assert.match(text, /إشارة ضعيفة ±160 م/);
});

test('being outside a shift wins over any location data', () => {
  assert.equal(movementStatus(rep({ tracking: false }), NOW), 'خارج الوردية');
  assert.equal(movementStatus(rep({ location: null }), NOW), 'بانتظار أول موقع');
});
