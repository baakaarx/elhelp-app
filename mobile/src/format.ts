/**
 * Arabic keyboards (and pasted text) type ٠-٩ / ۰-۹, and money is separated with ٬ or ٫.
 * `Number('٥٠٠')` is NaN, which silently turned a 500 EGP collection into null or zero.
 */
export function normalizeDigits(value: string): string {
  return value
    .replace(/[\u0660-\u0669]/g, char => String(char.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, char => String(char.charCodeAt(0) - 0x06F0));
}

/** Reads a number the way an Arabic keyboard writes it; null when the text is not a number. */
export function parseNumberText(value: string): number | null {
  const cleaned = normalizeDigits(value)
    .replace(/[\u066C\u060C,\s\u00A0]/g, '') // thousands separators and spaces
    .replace(/\u066B/g, '.');                   // Arabic decimal separator
  if (cleaned === '') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export const hhmmss = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
};
/**
 * The installation's timezone, sent by the server with every summary. A phone whose own clock
 * zone is wrong (travel, a manual change, a roaming SIM) used to label its visits and its shift
 * start in that wrong zone, so the times on the engineer's screen disagreed with the ones the
 * manager saw for the very same record.
 */
export const DEFAULT_TIMEZONE = 'Africa/Cairo';
export const clockText = (now = Date.now(), timeZone = DEFAULT_TIMEZONE) =>
  new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone }).format(now);
/** `HH:MM` for one timestamp, on the installation's clock. */
export const timeText = (at: number, timeZone = DEFAULT_TIMEZONE) =>
  new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit', timeZone }).format(at);

export type DayPeriod = 'AM' | 'PM';

/**
 * Daily-report work times are stored as canonical 24-hour `HH:MM` so the server, the
 * dashboard and the PDF can compare them safely. The phone UI shows them with صباحاً/مساءً.
 */
export function parseClockInput(value: string, period: DayPeriod = 'AM'): string | null {
  const cleaned = normalizeDigits(value)
    .replace(/صباحاً|مساءً|صباحا|مساءا|ص|م|AM|PM|am|pm/gi, '')
    .replace(/[^\d:]/g, '')
    .trim();
  if (!cleaned) return '';
  const match = cleaned.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  if (hour <= 12) {
    if (period === 'AM') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function clockPeriod(value: string): DayPeriod {
  const hour = Number(normalizeDigits(value).split(':')[0]);
  return Number.isFinite(hour) && hour >= 12 ? 'PM' : 'AM';
}

/** `08:30` -> `08:30 صباحاً`, `17:00` -> `05:00 مساءً`. Empty/invalid values stay readable. */
export function formatClockArabic(value: string): string {
  const canonical = parseClockInput(value, clockPeriod(value));
  if (!canonical) return value || '—';
  const [hourText, minuteText] = canonical.split(':');
  const hour = Number(hourText);
  const period = hour >= 12 ? 'مساءً' : 'صباحاً';
  const hour12 = hour % 12 || 12;
  return `${String(hour12).padStart(2, '0')}:${minuteText} ${period}`;
}
/** `D/M` on the installation's clock — a row from another day must not read as today's. */
export const dayText = (at: number, timeZone = DEFAULT_TIMEZONE) =>
  new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'numeric', timeZone }).format(at);
/** Is this timestamp on today's date, on the installation's clock? */
export function isToday(at: number, timeZone = DEFAULT_TIMEZONE, now = Date.now()) {
  const format = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone });
  return format.format(at) === format.format(now);
}
export function agoText(ts: number | null, now = Date.now()) {
  if (!ts) return 'لا يوجد';
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 45) return 'الآن';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `قبل ${minutes} دقيقة`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `قبل ${hours} ساعة`;
  return `قبل ${Math.round(hours / 24)} يوم`;
}
