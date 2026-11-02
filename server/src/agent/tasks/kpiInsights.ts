import type { Store } from '../../db.js';
import { dayBounds, distanceMeters } from '../../geo.js';

export interface KpiLikeRow {
  repId: string;
  name: string;
  color: string;
  region: string;
  distanceMeters: number;
  visits: number;
  visitsCompleted: number;
  avgVisitSeconds: number | null;
  reports: number;
  collected: number;
  dailyReports: number;
}

export function kpiInsights(store: Store, opts: { from: string; to: string; timezone: string }) {
  const fromBounds = dayBounds(opts.from, opts.timezone);
  const toBounds = dayBounds(opts.to, opts.timezone);
  const fromMs = fromBounds.start;
  const toMs = toBounds.end;

  const reps = store.all("SELECT id, name, color, region, is_demo FROM users WHERE role='rep' AND active=1 ORDER BY name");

  const rows: KpiLikeRow[] = reps.map((u: any) => {
    const repId = String(u.id);
    const points = store.all('SELECT lat,lng,accuracy,recorded_at AS recordedAt FROM locations WHERE user_id=? AND recorded_at>=? AND recorded_at<?', repId, fromMs, toMs) as any[];
    const visits = store.all('SELECT status, duration_seconds, amount FROM visits WHERE user_id=? AND checked_in_at>=? AND checked_in_at<?', repId, fromMs, toMs) as any[];
    const reports = store.all('SELECT amount FROM reports WHERE user_id=? AND created_at>=? AND created_at<?', repId, fromMs, toMs) as any[];
    const dailyReports = store.all('SELECT id FROM daily_reports WHERE user_id=? AND created_at>=? AND created_at<?', repId, fromMs, toMs) as any[];

    const closed = visits.filter(v => v.status === 'closed' && v.duration_seconds);
    const avgVisit = closed.length ? Math.round(closed.reduce((a, v) => a + Number(v.duration_seconds), 0) / closed.length) : null;
    const collectedVisits = visits.reduce((a, v) => a + (Number(v.amount) || 0), 0);
    const collectedReports = reports.reduce((a, r) => a + (Number(r.amount) || 0), 0);

    return {
      repId,
      name: String(u.name),
      color: String(u.color),
      region: String(u.region || ''),
      distanceMeters: Math.round(distanceMeters(points)),
      visits: visits.length,
      visitsCompleted: visits.filter(v => v.status === 'closed').length,
      avgVisitSeconds: avgVisit,
      reports: reports.length,
      collected: collectedVisits + collectedReports,
      dailyReports: dailyReports.length,
      isDemo: !!u.is_demo,
    } as any;
  }).filter((r: any) => !r.isDemo);

  // Sort by visits desc
  const sorted = [...rows].sort((a, b) => b.visits - a.visits);
  const top = sorted[0];
  const low = sorted[sorted.length - 1];

  const insights: string[] = [];
  const suggestions: string[] = [];

  if (rows.length === 0) {
    return { summary: 'لا توجد بيانات KPI في الفترة المحددة.', details: { from: opts.from, to: opts.to, rows: [] }, suggestions: [] };
  }

  if (top) insights.push(`الأكثر زيارات: ${top.name} (${top.visits} زيارة، ${top.visitsCompleted} مكتملة)`);
  if (low && rows.length > 1) insights.push(`الأقل زيارات: ${low.name} (${low.visits} زيارة)`);

  for (const r of rows) {
    if (r.avgVisitSeconds !== null && r.avgVisitSeconds < 300) {
      insights.push(`${r.name}: متوسط زيارة قصير جداً (${Math.round(r.avgVisitSeconds / 60)} دقائق) — احتمال تسجيل صوري`);
      suggestions.push(`راجع جودة زيارات ${r.name} — متوسط ${Math.round(r.avgVisitSeconds / 60)} دقائق فقط`);
    }
    if (r.visits > 0 && r.dailyReports === 0) {
      insights.push(`${r.name}: ${r.visits} زيارة بدون أي تقرير يومي`);
      suggestions.push(`ذكّر ${r.name} بإرسال التقرير اليومي`);
    }
    if (r.collected > 0) {
      insights.push(`${r.name}: تحصيل ${r.collected.toLocaleString('ar-EG')} ج`);
    }
  }

  const totalVisits = rows.reduce((a, r) => a + r.visits, 0);
  const totalDistance = rows.reduce((a, r) => a + r.distanceMeters, 0);
  const totalCollected = rows.reduce((a, r) => a + r.collected, 0);

  const summary = `تحليل ${opts.from} → ${opts.to}: ${totalVisits} زيارة، ${(totalDistance / 1000).toFixed(1)} كم، تحصيل ${totalCollected.toLocaleString('ar-EG')} ج لـ ${rows.length} مهندس.`;

  return {
    summary,
    details: { from: opts.from, to: opts.to, timezone: opts.timezone, rows: sorted, insights },
    suggestions: suggestions.slice(0, 6),
  };
}
