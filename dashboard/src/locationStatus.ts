import type { Rep } from './types';

/** GPS speed is an estimate; an old, weak or missing fix cannot prove motion. */
export function movementStatus(rep: Rep, now = Date.now()): string {
  const fix = rep.location;
  if (!rep.tracking) return 'خارج الوردية';
  if (!fix) return 'بانتظار أول موقع';
  if (now - fix.recordedAt > 90000 || fix.recordedAt > now + 120000) return 'الإشارة قديمة · الحركة غير معروفة';
  if (fix.accuracy == null || fix.accuracy > 100) return 'دقة الموقع ضعيفة · الحركة غير مؤكدة';
  if (fix.speed == null || !Number.isFinite(fix.speed) || fix.speed < 0) return 'السرعة غير متاحة';
  if (fix.speed >= 1) return `يتحرك تقريبًا · ${Math.round(fix.speed * 3.6)} كم/س`;
  if (fix.speed <= 0.5) return 'واقف تقريبًا';
  return 'الحركة غير مؤكدة';
}
