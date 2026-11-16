import type { Store } from '../../db.js';
import { localDate } from '../../geo.js';

export function fieldAlerts(store: Store, opts: { timezone: string }) {
  const now = Date.now();
  const today = localDate(opts.timezone, now);

  // Reuse logic similar to app.ts alerts but as agent task
  const reps = store.all("SELECT id, name, color, last_seen FROM users WHERE role='rep' AND active=1");

  const alerts: Array<{ repId: string; repName: string; code: string; level: 'warn' | 'info'; title: string; detail: string }> = [];

  for (const rep of reps as any[]) {
    const repId = String(rep.id);
    const shift = store.get('SELECT id, started_at FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', repId);
    const lastPoint = store.get('SELECT recorded_at FROM locations WHERE user_id=? ORDER BY recorded_at DESC LIMIT 1', repId);
    // Counted against the *current* shift, not a rolling 24h window: yesterday's check-ins
    // used to mask a shift that opened hours ago and still has no visit.
    const shiftVisits = shift ? store.all('SELECT id FROM visits WHERE user_id=? AND checked_in_at>=?', repId, Number(shift.started_at)) : [];
    const dailyToday = store.get('SELECT id FROM daily_reports WHERE user_id=? AND report_date=?', repId, today);
    const pendingReviews = store.get("SELECT COUNT(*) as c FROM reports WHERE user_id=? AND status='new' AND created_at < ?", repId, now - 86400000);

    if (shift) {
      const shiftAgeMin = (now - Number(shift.started_at)) / 60000;
      if (!lastPoint) {
        alerts.push({ repId, repName: String(rep.name), code: 'no_signal', level: 'warn', title: 'وردية بلا إشارة', detail: `وردية مفتوحة منذ ${Math.round(shiftAgeMin)} دقيقة بدون أي نقطة GPS` });
      } else {
        const staleMin = (now - Number(lastPoint.recorded_at)) / 60000;
        if (staleMin > 15) {
          alerts.push({ repId, repName: String(rep.name), code: 'stale_gps', level: 'warn', title: 'انقطاع GPS', detail: `آخر إشارة منذ ${Math.round(staleMin)} دقيقة` });
        }
      }
      if (shiftVisits.length === 0 && shiftAgeMin > 60) {
        alerts.push({ repId, repName: String(rep.name), code: 'no_visits', level: 'info', title: 'بلا زيارات', detail: `وردية ${Math.round(shiftAgeMin)} دقيقة بدون تسجيل زيارة` });
      }
      if (!dailyToday && shiftAgeMin > 240) {
        alerts.push({ repId, repName: String(rep.name), code: 'missing_daily_report', level: 'info', title: 'تقرير يومي ناقص', detail: `لم يرسل التقرير اليومي لـ ${today}` });
      }
    }

    if (pendingReviews && Number(pendingReviews.c) > 3) {
      alerts.push({ repId, repName: String(rep.name), code: 'stale_reviews', level: 'info', title: 'تقارير متأخرة', detail: `${pendingReviews.c} تقارير لم تراجع لأكثر من يوم` });
    }
  }

  const summary = alerts.length === 0
    ? 'لا توجد تنبيهات ميدانية — الفريق يعمل بشكل طبيعي.'
    : `يوجد ${alerts.length} تنبيه: ${alerts.filter(a => a.level === 'warn').length} تحذير، ${alerts.filter(a => a.level === 'info').length} ملاحظة.`;

  const suggestions = alerts.slice(0, 5).map(a => `${a.repName}: ${a.title} — ${a.detail}`);

  return {
    summary,
    details: { generatedAt: now, alerts },
    suggestions,
  };
}
