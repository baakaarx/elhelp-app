import type { Rep } from './types';

/**
 * A fix is not "stale" the moment it is a minute old: the app sends a heartbeat every 30s
 * while the engineer stands still, and a phone indoors can easily miss one. Three minutes
 * still means "we do not know where they are", without crying wolf on every pause.
 */
export const STALE_FIX_MS = 180_000;
/** Above this the position is a guess; say so instead of showing a confident marker. */
export const WEAK_ACCURACY_M = 100;

/** GPS speed is an estimate; an old, weak or missing fix cannot prove motion. */
export function movementStatus(rep: Rep, now = Date.now()): string {
  const fix = rep.location;
  if (!rep.tracking) return 'خارج الوردية';
  if (!fix) return 'بانتظار أول موقع';
  const ageSeconds = Math.max(0, Math.round((now - fix.recordedAt) / 1000));
  if (fix.recordedAt > now + 120_000) return 'وقت الجهاز غير مضبوط · الحركة غير معروفة';
  const accuracyText = typeof fix.accuracy === 'number' ? `±${Math.round(fix.accuracy)} م` : '';
  if (now - fix.recordedAt > STALE_FIX_MS) {
    // Say why: either the phone stopped sending, or the reading never met the accuracy gate.
    return `لا إشارة من ${Math.round(ageSeconds / 60)} دقيقة · آخر موقع معروف${accuracyText ? ` (${accuracyText})` : ''}`;
  }
  if (fix.accuracy == null || fix.accuracy > WEAK_ACCURACY_M) {
    return `إشارة ضعيفة${accuracyText ? ` ${accuracyText}` : ''} · الحركة غير مؤكدة`;
  }
  if (fix.speed == null || !Number.isFinite(fix.speed) || fix.speed < 0) return 'السرعة غير متاحة';
  if (fix.speed >= 1) return `يتحرك تقريبًا · ${Math.round(fix.speed * 3.6)} كم/س${accuracyText ? ` · دقة ${accuracyText}` : ''}`;
  if (fix.speed <= 0.5) return `واقف تقريبًا${accuracyText ? ` · دقة ${accuracyText}` : ''}`;
  return 'الحركة غير مؤكدة';
}
