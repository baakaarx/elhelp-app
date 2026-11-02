import type { Store } from '../../db.js';
import { dayBounds, distanceMeters, haversine } from '../../geo.js';

export function analyzeRoute(store: Store, opts: { repId: string; date?: string; timezone: string }) {
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const bounds = dayBounds(date, opts.timezone);
  const rep = store.get("SELECT id, name, color FROM users WHERE id=? AND role='rep'", opts.repId);
  if (!rep) throw new Error('المهندس غير موجود');

  const points = store.all(
    'SELECT lat,lng,accuracy,speed,recorded_at AS recordedAt FROM locations WHERE user_id=? AND recorded_at>=? AND recorded_at<? ORDER BY recorded_at',
    opts.repId, bounds.start, bounds.end
  ) as Array<{ lat: number; lng: number; accuracy: number | null; speed: number | null; recordedAt: number }>;

  const distance = Math.round(distanceMeters(points as any));

  // Detect anomalies
  const anomalies: Array<{ at: number; type: string; detail: string }> = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if ((a.accuracy !== null && a.accuracy > 100) || (b.accuracy !== null && b.accuracy > 100)) {
      anomalies.push({ at: b.recordedAt, type: 'دقة ضعيفة', detail: `دقة ${b.accuracy}m` });
      continue;
    }
    const meters = haversine(a, b);
    const seconds = (b.recordedAt - a.recordedAt) / 1000;
    if (seconds > 0 && seconds <= 600 && meters / seconds > 35) {
      anomalies.push({ at: b.recordedAt, type: 'قفزة غير منطقية', detail: `${Math.round(meters)}م في ${Math.round(seconds)}ث = ${Math.round((meters / seconds) * 3.6)} كم/س` });
    }
  }

  // Gaps
  const gaps: Array<{ from: number; to: number; minutes: number }> = [];
  for (let i = 1; i < points.length; i++) {
    const gap = (points[i].recordedAt - points[i - 1].recordedAt) / 60000;
    if (gap > 15) gaps.push({ from: points[i - 1].recordedAt, to: points[i].recordedAt, minutes: Math.round(gap) });
  }

  const visits = store.all('SELECT customer_name, in_lat, in_lng, checked_in_at FROM visits WHERE user_id=? AND checked_in_at>=? AND checked_in_at<?', opts.repId, bounds.start, bounds.end);

  let summary = `تحليل مسار ${String(rep.name)} في ${date}: ${points.length} نقطة، ${(distance / 1000).toFixed(1)} كم.`;
  if (anomalies.length === 0 && gaps.length === 0) summary += ' المسار نظيف بدون قفزات أو انقطاعات كبيرة.';
  else {
    if (anomalies.length) summary += ` ${anomalies.length} قفزة/دقة ضعيفة.`;
    if (gaps.length) summary += ` ${gaps.length} فجوة زمنية >15د.`;
  }

  const suggestions: string[] = [];
  if (points.length === 0) suggestions.push('لا توجد نقاط اليوم — تأكد أن المهندس بدأ الوردية ومنح إذن الموقع');
  if (gaps.length) suggestions.push(`يوجد ${gaps.length} انقطاع GPS — قد يكون فقدان شبكة أو توقف التطبيق`);
  if (anomalies.length > 3) suggestions.push('قفزات كثيرة — راجع إعدادات الجوال أو استخدم فلترة المسافة');
  if (visits.length > 0 && points.length > 0) suggestions.push(`${visits.length} زيارات مسجلة — قارن مواقع الزيارات بالمسار للتأكد`);

  return {
    summary,
    details: {
      rep: { id: String(rep.id), name: String(rep.name) },
      date,
      pointCount: points.length,
      distanceMeters: distance,
      anomalies: anomalies.slice(0, 20),
      gaps: gaps.slice(0, 10),
      visits: visits.map((v: any) => ({ customer: String(v.customer_name), at: Number(v.checked_in_at) })),
    },
    suggestions,
  };
}
