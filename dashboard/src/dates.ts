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
export function dayBefore(days: number, timeZone: string = DEFAULT_TIMEZONE, at: number = Date.now()): string {
  const [year, month, day] = localDay(timeZone, at).split('-').map(Number);
  // Do calendar arithmetic on a UTC date-only value. Subtracting 24-hour durations shifts the
  // answer across DST transitions (Africa/Cairo changes at local midnight).
  const target = new Date(Date.UTC(year, month - 1, day - Math.trunc(days)));
  return `${String(target.getUTCFullYear()).padStart(4, '0')}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(target.getUTCDate()).padStart(2, '0')}`;
}

/** A timestamp in the installation's timezone, not the dashboard browser's local timezone. */
export function timeText(at: number, timeZone: string = DEFAULT_TIMEZONE): string {
  return new Date(at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', timeZone });
}

/** Daily-report work times are stored as `HH:MM`; show them with صباحاً/مساءً. */
export function formatClockArabic(value: string): string {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return value || '—';
  const hour = Number(match[1]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return value;
  const period = hour >= 12 ? 'مساءً' : 'صباحاً';
  const hour12 = hour % 12 || 12;
  return `${String(hour12).padStart(2, '0')}:${match[2]} ${period}`;
}

/** A date and time for an event, formatted on the installation's clock. */
export function dateTimeText(at: number, timeZone: string = DEFAULT_TIMEZONE): string {
  return new Date(at).toLocaleString('ar-EG', { dateStyle: 'full', timeStyle: 'short', timeZone });
}

/** A calendar date for an event, formatted on the installation's clock. */
export function localDateText(at: number, timeZone: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone }).format(at);
}

/** String arithmetic on `YYYY-MM`, so month lists never depend on a date object's timezone. */
export function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(monthNumber)) return month;
  const index = year * 12 + (monthNumber - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
