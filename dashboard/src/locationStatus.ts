import { formatNumber } from './session';
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

/**
 * GPS speed is an estimate; an old, weak or missing fix cannot prove motion.
 * `staleMs` mirrors the server's `STALE_GPS_MINUTES`; pass it when the overview is loaded. The
 * per-engineer `staleLimitMinutes` from the server wins over it, because an engineer standing
 * inside a visit is allowed a longer silence (the alert list uses the same number).
 */
export function movementStatus(rep: Rep, now = Date.now(), staleMs = STALE_FIX_MS): string {
  const fix = rep.location;
  if (!rep.tracking) return 'خارج الوردية';
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
