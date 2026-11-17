import assert from 'node:assert/strict';
import test from 'node:test';
import { dateTimeText, dayBefore, localDay, localDateText, timeText } from '../../dashboard/src/dates.js';

test('performance date presets subtract calendar days across Cairo DST transitions', () => {
  const cases = [
    { at: '2026-04-24T21:30:00.000Z', today: '2026-04-25', sixDaysEarlier: '2026-04-19' },
    { at: '2026-10-29T21:30:00.000Z', today: '2026-10-29', sixDaysEarlier: '2026-10-23' },
  ];
  for (const sample of cases) {
    const at = Date.parse(sample.at);
    assert.equal(localDay('Africa/Cairo', at), sample.today);
    assert.equal(dayBefore(6, 'Africa/Cairo', at), sample.sixDaysEarlier);
  }
});

test('dashboard event formatters use the installation timezone', () => {
  const at = Date.parse('2026-11-02T22:30:00.000Z');
  assert.notEqual(timeText(at, 'UTC'), timeText(at, 'Africa/Cairo'));
  assert.notEqual(localDateText(at, 'UTC'), localDateText(at, 'Africa/Cairo'));
  assert.notEqual(dateTimeText(at, 'UTC'), dateTimeText(at, 'Africa/Cairo'));
});
