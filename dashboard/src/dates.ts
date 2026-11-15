/**
 * Calendar dates on the installation's clock, never the browser's.
 *
 * Every range sent to `/api/kpis`, `/api/monthly` and `/api/reps/:id/route` is a calendar day
 * in `TIMEZONE` (the server resolves the boundaries). Formatting "today" with the browser's
 * own zone shifted the default range by a day for any manager whose laptop is not set to that
 * zone — the whole team sees yesterday when it clicks "اليوم" — and it made the route date
 * input refuse today's date between local midnight and 02:00–03:00, because
 * `toISOString()` always reports UTC.
 */
export const DEFAULT_TIMEZONE = 'Africa/Cairo';

function parts(at: number, timeZone: string) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const value = (type: string) => formatted.find(part => part.type === type)?.value ?? '';
  return { year: value('year'), month: value('month'), day: value('day') };
}

/** `YYYY-MM-DD` as seen in the installation's timezone. */
export function localDay(timeZone: string = DEFAULT_TIMEZONE, at: number = Date.now()): string {
  const { year, month, day } = parts(at, timeZone);
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM` as seen in the installation's timezone. */
export function localMonth(timeZone: string = DEFAULT_TIMEZONE, at: number = Date.now()): string {
  return localDay(timeZone, at).slice(0, 7);
}

/** The same calendar day, `days` days earlier — still resolved on the installation's clock. */
export function dayBefore(days: number, timeZone: string = DEFAULT_TIMEZONE): string {
  return localDay(timeZone, Date.now() - days * 86400000);
}

/** String arithmetic on `YYYY-MM`, so month lists never depend on a date object's timezone. */
export function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(monthNumber)) return month;
  const index = year * 12 + (monthNumber - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
