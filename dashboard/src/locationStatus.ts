import { formatNumber } from './session';
import { timeText } from './dates';
import type { Rep } from './types';

/**
 * A fix is not "stale" the moment it is a minute old: the app sends a heartbeat every 30s
 * while the engineer stands still, and a phone indoors can easily miss one. Three minutes
 * cried wolf on every pause; thirty minutes hid a real gap. Ten minutes is the default and
 * the server ships the live value (`staleGpsMinutes` on /api/overview) so the map text and
 * the manager alert fire at the same moment.
 */
export const STALE_FIX_MS = 600_000;
/** Above this the position is a guess; say so instead of showing a confident marker. */
export const WEAK_ACCURACY_M = 100;
/** From how many minutes on the card says "واقف في نفس المنطقة" instead of "واقف تقريبًا". */
export const STATIONARY_NOTICE_MINUTES = 15;
/** Same threshold the server warns at (`LOW_BATTERY_PERCENT` in `server/src/fieldStatus.ts`). */
export const LOW_BATTERY_PERCENT = 10;

/**
 * GPS speed is an estimate; an old, weak or missing fix cannot prove motion.
 * `staleMs` mirrors the server's `STALE_GPS_MINUTES`; pass it when the overview is loaded. The
 * per-engineer `staleLimitMinutes` from the server wins over it, because an engineer standing
 * inside a visit is allowed a longer silence (the alert list uses the same number).
 */
export function movementStatus(rep: Rep, now = Date.now(), staleMs = STALE_FIX_MS, timezone?: string): string {
  const fix = rep.location;
  // A shift that was stopped is not a missing reading: name the minute it ended, so "انتهت"
  // and "مفيش بيانات" cannot be confused on the same screen.
  if (!rep.tracking) {
    return rep.shiftState === 'ended' && rep.shiftEndedAt
      ? `انتهت ورديته ${timeText(rep.shiftEndedAt, timezone)}`
      : 'خارج الوردية';
  }
  if (!fix) return 'بانتظار أول موقع';
  const ageSeconds = Math.max(0, Math.round((now - fix.recordedAt) / 1000));
  if (fix.recordedAt > now + 120_000) return 'وقت الجهاز غير مضبوط · الحركة غير معروفة';
  const accuracyText = typeof fix.accuracy === 'number' ? `±${Math.round(fix.accuracy)} م` : '';
  const limitMs = rep.staleLimitMinutes ? rep.staleLimitMinutes * 60_000 : staleMs;
  if (now - fix.recordedAt > limitMs) {
    const minutes = Math.round(ageSeconds / 60);
    // The server already compared the silence with the phone's own requests, so show its verdict
    // instead of one phrase that lets a dead battery, a frozen app and a coverage hole hide behind
    // "النت واقع".
    if (rep.gap?.kind === 'gps_blocked') {
      return `التطبيق واصِل للسيرفر بس مفيش نقاط موقع من ${minutes} دقيقة — الموقع هو المقطوع، مش الشبكة`;
    }
    const battery = typeof rep.gap?.battery === 'number' ? rep.gap.battery : null;
    return `لا إشارة من ${minutes} دقيقة · ${battery !== null && battery <= 10 ? `التليفون فصل والبطارية ${Math.round(battery)}٪` : 'تليفون مقفول أو مكان بلا شبكة'} · آخر موقع معروف${accuracyText ? ` (${accuracyText})` : ''}`;
  }
  if (rep.openVisit && limitMs > staleMs && now - fix.recordedAt > staleMs) {
    // Still inside the widened window: name the reason instead of leaving the manager to imagine
    // a fault, and keep the customer visible so the visit itself is obvious at a glance.
    return `داخل زيارة عند ${rep.openVisit.customerName} · آخر موقع من ${Math.round(ageSeconds / 60)} دقيقة (موقع داخل مبنى)`;
  }
  if (fix.accuracy == null || fix.accuracy > WEAK_ACCURACY_M) {
    return `إشارة ضعيفة${accuracyText ? ` ${accuracyText}` : ''} · الحركة غير مؤكدة`;
  }
  // Standing still is a fact the manager is entitled to see, not an accusation — and the trail,
  // not the phone's speed sensor, is what proves it.
  const stationary = rep.stationaryMinutes ?? 0;
  if (stationary >= STATIONARY_NOTICE_MINUTES) return `واقف في نفس المنطقة من ${formatNumber(stationary)} دقيقة${accuracyText ? ` · دقة ${accuracyText}` : ''}`;
  if (fix.speed == null || !Number.isFinite(fix.speed) || fix.speed < 0) return 'السرعة غير متاحة';
  if (fix.speed >= 1) return `يتحرك تقريبًا · ${Math.round(fix.speed * 3.6)} كم/س${accuracyText ? ` · دقة ${accuracyText}` : ''}`;
  if (fix.speed <= 0.5) return `واقف تقريبًا${accuracyText ? ` · دقة ${accuracyText}` : ''}`;
  return 'الحركة غير مؤكدة';
}

/** Under an hour in minutes, above it in hours — the unit the manager actually reasons in. */
function lengthText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  return minutes < 60 ? `${formatNumber(minutes)} دقيقة` : `${formatNumber(Math.round(minutes / 60))} ساعة`;
}

/**
 * The shift line on the engineer's card.
 *
 * `—` used to appear the second a shift was stopped, which the manager reads as «the server lost
 * the day» — while the truth was «he finished it at ٢:١٠ م» or «he never opened one». Both are now
 * said in words, because that difference is exactly what a follow-up call is about.
 */
export function shiftText(rep: Rep, timezone?: string, now = Date.now()): string {
  // Only `none` is allowed to say there was no shift: a shift that ran before the 24-hour window
  // still gets its start time, and inventing «مفيش وردية» over it would be the same lie as «—».
  if (rep.shiftState === 'none' || (!rep.shiftState && !rep.shiftStartedAt)) return 'مفيش وردية في آخر ٢٤ ساعة';
  if (!rep.shiftStartedAt) return rep.shiftState === 'ended' ? 'انتهت الوردية' : 'في وردية الآن';
  const started = timeText(rep.shiftStartedAt, timezone);
  if (rep.shiftState === 'ended' && rep.shiftEndedAt) {
    return `انتهت ${timeText(rep.shiftEndedAt, timezone)} · مدتها ${lengthText(rep.shiftEndedAt - rep.shiftStartedAt)}`;
  }
  return `جارية من ${started} · ${lengthText(now - rep.shiftStartedAt)}`;
}

/**
 * The newest battery reading, with its age.
 *
 * A fix can legitimately carry no battery (the background task never reads it), so showing `—`
 * for the newest row hid a phone sitting at ٦٪. The value is labelled by age instead of being
 * presented as current.
 */
/** The newest level the phone reported, whichever field of the snapshot carried it. */
export function latestBattery(rep: Rep): { percent: number; recordedAt: number } | null {
  return rep.battery
    ?? (rep.location?.battery != null ? { percent: Number(rep.location.battery), recordedAt: rep.location.recordedAt } : null);
}

export function batteryText(rep: Rep, now = Date.now()): string {
  const reading = latestBattery(rep);
  if (!reading) return 'مفيش قراءة بطارية من التليفون';
  const minutes = Math.max(0, Math.round((now - reading.recordedAt) / 60000));
  return `${formatNumber(reading.percent)}٪${minutes > 5 ? ` · من ${formatNumber(minutes)} دقيقة` : ''}`;
}

/**
 * The percent worth warning about, or `null`.
 *
 * Two ways this used to be wrong at once: a background fix has no battery, so the warning never
 * fired for a phone that was dying quietly; and once the reading was kept without an age, an
 * engineer's phone from yesterday held the warning open forever. Both bounds live here so the rule
 * can be read — and tested — in one place.
 */
export const BATTERY_WARN_FRESH_MS = 2 * 3600000;
export function batteryWarning(rep: Rep, now = Date.now()): number | null {
  const reading = latestBattery(rep);
  if (!reading || reading.percent > LOW_BATTERY_PERCENT) return null;
  return now - reading.recordedAt <= BATTERY_WARN_FRESH_MS ? reading.percent : null;
}
