import assert from 'node:assert/strict';
import test from 'node:test';
import { batteryText, batteryWarning, movementStatus, shiftText, STALE_FIX_MS, WEAK_ACCURACY_M } from '../../dashboard/src/locationStatus.js';
import type { Rep } from '../../dashboard/src/types.js';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

function rep(overrides: Partial<Rep> = {}, fix: Partial<NonNullable<Rep['location']>> = {}): Rep {
  return {
    id: 'r1', name: 'أحمد حسن', color: '#27745a', region: 'مدينة نصر', active: true,
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

test('the staleness window is ten minutes and matches the server default', () => {
  // 3 minutes was too twitchy, 30 hid a real gap. STALE_GPS_MINUTES (default 10) owns the
  // number and /api/overview sends it to the dashboard.
  assert.equal(STALE_FIX_MS, 10 * 60_000);
  assert.match(movementStatus(rep({}, { recordedAt: NOW - 5 * 60_000, speed: 0 }), NOW), /واقف تقريبًا/);
});

test('a fix older than the staleness window says how long it has been missing', () => {
  // The reported age is the real one, not the threshold — an 11-minute gap must say 11.
  const text = movementStatus(rep({}, { recordedAt: NOW - 11 * 60_000 }), NOW);
  assert.match(text, /لا إشارة من 11 دقيقة/);
  assert.match(text, /آخر موقع معروف/);
});

test('a configured server threshold overrides the default window', () => {
  const sixMinutesOld = rep({}, { recordedAt: NOW - 6 * 60_000, speed: 0 });
  assert.match(movementStatus(sixMinutesOld, NOW, 5 * 60_000), /لا إشارة/);
  assert.match(movementStatus(sixMinutesOld, NOW, 10 * 60_000), /واقف تقريبًا/);
});

test('a weak fix is described as weak instead of a confident position', () => {
  const text = movementStatus(rep({}, { accuracy: WEAK_ACCURACY_M + 60 }), NOW);
  assert.match(text, /إشارة ضعيفة ±160 م/);
});

test('being outside a shift wins over any location data', () => {
  assert.equal(movementStatus(rep({ tracking: false }), NOW), 'خارج الوردية');
  assert.equal(movementStatus(rep({ location: null }), NOW), 'بانتظار أول موقع');
});

/**
 * The engineer card had one rendering for «the day is finished» and «nothing arrived»: a dash. The
 * two sentences are different work for the manager, so they are now different strings.
 */
const HOUR = 3600000;

test('a shift that ended says when it ended instead of a dash', () => {
  const text = shiftText(rep({ tracking: false, shiftState: 'ended', shiftStartedAt: NOW - 3 * HOUR, shiftEndedAt: NOW - 15 * 60000 }), 'Africa/Cairo', NOW);
  assert.match(text, /انتهت/);
  assert.match(text, /٣ ساعة/);
  assert.ok(!text.includes('—'), `a dash is the ambiguity this removes: ${text}`);
});

test('a shift that is running counts up from its start', () => {
  const text = shiftText(rep({ tracking: true, shiftState: 'open', shiftStartedAt: NOW - 40 * 60000 }), 'Africa/Cairo', NOW);
  assert.match(text, /جارية/);
  assert.match(text, /٤٠ دقيقة/);
});

test('no shift at all is said in words, not drawn as an em dash', () => {
  assert.equal(shiftText(rep({ tracking: false, shiftState: 'none', shiftStartedAt: null }), 'Africa/Cairo', NOW), 'مفيش وردية في آخر ٢٤ ساعة');
});

test('an old shift is never described as no shift', () => {
  // The card must not invent «مفيش وردية» when the day simply fell outside the 24-hour window.
  const text = shiftText(rep({ tracking: false, shiftState: 'ended', shiftStartedAt: null }), 'Africa/Cairo', NOW);
  assert.match(text, /انتهت/);
  assert.ok(!text.includes('مفيش وردية'), text);
});

test('the status line names the minute the shift was stopped', () => {
  const status = movementStatus(rep({ tracking: false, shiftState: 'ended', shiftStartedAt: NOW - 3 * HOUR, shiftEndedAt: NOW - 60000 }), NOW, STALE_FIX_MS, 'Africa/Cairo');
  assert.match(status, /انتهت ورديته/);
});

test('the battery line uses the newest reading and admits its age', () => {
  assert.equal(batteryText(rep({ battery: { percent: 62, recordedAt: NOW - 60000 } }), NOW), '٦٢٪');
  assert.match(batteryText(rep({ battery: { percent: 62, recordedAt: NOW - 30 * 60000 } }), NOW), /من ٣٠ دقيقة/);
});

test('a battery read comes from the fix when the snapshot has no separate reading', () => {
  // Fixes from the background task carry `battery: null`, so the fallback is what keeps the row alive.
  assert.equal(batteryText(rep({}, { battery: 5 }), NOW), '٥٪');
  assert.equal(batteryText(rep({ battery: null }, { battery: null }), NOW), 'مفيش قراءة بطارية من التليفون');
});

test('the battery warning needs a recent number, not only a low one', () => {
  assert.equal(batteryWarning(rep({ battery: { percent: 8, recordedAt: NOW - 60000 } }), NOW), 8);
  // A reading three hours old is not "about to die now"; the warning used to sit on the card forever.
  assert.equal(batteryWarning(rep({ battery: { percent: 8, recordedAt: NOW - 3 * HOUR } }), NOW), null);
  // Background fixes carry no battery at all, so the last reading that did is what still warns.
  assert.equal(batteryWarning(rep({ battery: null }, { battery: 7, recordedAt: NOW - 120000 }), NOW), 7);
});
