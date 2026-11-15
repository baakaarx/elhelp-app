import type { Store } from '../../db.js';
import { dayBounds, localDate, distanceMeters } from '../../geo.js';

export function summarizeDay(store: Store, opts: { repId?: string; date?: string; timezone: string }) {
  const date = opts.date || localDate(opts.timezone);
  const bounds = dayBounds(date, opts.timezone);

  const reps = opts.repId
    ? store.all("SELECT id, name, color FROM users WHERE id=? AND role='rep'", opts.repId)
    : store.all("SELECT id, name, color FROM users WHERE role='rep' AND active=1");

  if (opts.repId && reps.length === 0) throw new Error('المهندس غير موجود');

  const results = reps.map(rep => {
    const repId = String(rep.id);
    // A shift that began before local midnight (a night visit) is still the shift this day
    // belongs to: without the fallback the summary said "no shift" while the engineer was
    // tracking, and the "shift without GPS" suggestion never fired for them.
    const shift = store.get('SELECT id, started_at, ended_at FROM shifts WHERE user_id=? AND started_at>=? AND started_at<? ORDER BY started_at DESC LIMIT 1', repId, bounds.start, bounds.end)
      || store.get('SELECT id, started_at, ended_at FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', repId);
    const points = store.all('SELECT lat,lng,accuracy,speed,recorded_at AS recordedAt FROM locations WHERE user_id=? AND recorded_at>=? AND recorded_at<? ORDER BY recorded_at', repId, bounds.start, bounds.end);
    const visits = store.all('SELECT id, customer_name, status, checked_in_at, checked_out_at, duration_seconds FROM visits WHERE user_id=? AND checked_in_at>=? AND checked_in_at<? ORDER BY checked_in_at', repId, bounds.start, bounds.end);
    const reports = store.all('SELECT id, title, type FROM reports WHERE user_id=? AND created_at>=? AND created_at<?', repId, bounds.start, bounds.end);
    const daily = store.get('SELECT id, status FROM daily_reports WHERE user_id=? AND report_date=?', repId, date);

    const distance = Math.round(distanceMeters(points as any));
    const openVisit = visits.find((v: any) => v.status === 'open');
    const closedVisits = visits.filter((v: any) => v.status === 'closed');

    return {
      repId,
      name: String(rep.name),
      color: String(rep.color),
      shift: shift ? { id: String(shift.id), startedAt: Number(shift.started_at), endedAt: shift.ended_at ? Number(shift.ended_at) : null } : null,
      distanceMeters: distance,
      pointCount: points.length,
      visitsTotal: visits.length,
      visitsClosed: closedVisits.length,
      openVisit: openVisit ? { id: String(openVisit.id), customer: String((openVisit as any).customer_name) } : null,
      reportsCount: reports.length,
      dailyReport: daily ? { id: String(daily.id), status: String(daily.status) } : null,
    };
  });

  const totalVisits = results.reduce((a, r) => a + r.visitsTotal, 0);
  const totalDistance = results.reduce((a, r) => a + r.distanceMeters, 0);

  const summary = opts.repId
    ? `ملخص ${date} للمهندس ${results[0]?.name || 'غير موجود'}: ${results[0]?.visitsTotal || 0} زيارات، ${((results[0]?.distanceMeters || 0) / 1000).toFixed(1)} كم، ${results[0]?.reportsCount || 0} تقارير.`
    : `ملخص ${date} للفريق (${results.length} مهندس): ${totalVisits} زيارات، ${(totalDistance / 1000).toFixed(1)} كم إجمالي المسافة.`;

  const suggestions: string[] = [];
  for (const r of results) {
    if (r.shift && r.pointCount === 0) suggestions.push(`${r.name}: وردية مفتوحة بلا إشارة GPS — تحقق من الأذونات`);
    if (r.visitsTotal === 0 && r.shift) suggestions.push(`${r.name}: لا زيارات اليوم — متابعة هاتفية مقترحة`);
    if (!r.dailyReport && r.visitsTotal > 0) suggestions.push(`${r.name}: لديه زيارات بدون تقرير يومي — تذكير`);
  }

  return {
    summary,
    details: { date, timezone: opts.timezone, reps: results },
    suggestions: suggestions.slice(0, 8),
  };
}
