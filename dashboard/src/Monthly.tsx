import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiBlob } from './api';
import { ago, durationText, formatNumber } from './session';
import { localMonth, shiftMonth } from './dates';
import type { KpiResponse, KpiRow, Rep } from './types';

type MonthlyResponse = KpiResponse & { month: string };

export default function Monthly({ reps, timezone }: { reps: Rep[]; timezone?: string }) {
  const currentMonth = localMonth(timezone);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  // Derive the default from the server timezone when it arrives; keep only explicit user choices.
  const month = selectedMonth ?? currentMonth;
  const key = month;
  const currentKey = useRef(key); currentKey.current = key;
  const requestId = useRef(0);
  const [result, setResult] = useState<{ key: string; data: MonthlyResponse } | null>(null);
  const data = result?.key === key ? result.data : null;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    if (!timezone) return;
    const id = ++requestId.current;
    setLoading(true); setError(''); setResult(null);
    try { const data = await api<MonthlyResponse>(`/api/monthly?month=${month}`); if (id === requestId.current && currentKey.current === key) setResult({ key, data }); }
    catch (e) { if (id === requestId.current && currentKey.current === key) setError(e instanceof Error ? e.message : 'تعذر تحميل السجل الشهري.'); }
    finally { if (id === requestId.current && currentKey.current === key) setLoading(false); }
  }, [month, timezone]);

  useEffect(() => { if (timezone) void load(); return () => { requestId.current++; }; }, [load, timezone]);

  const rows = useMemo(() => [...(data?.rows ?? [])].sort((a, b) => b.visits - a.visits || b.dailyReports - a.dailyReports), [data]);
  const totals = useMemo(() => rows.reduce((a, r) => ({
    visits: a.visits + r.visits,
    visitsCompleted: a.visitsCompleted + r.visitsCompleted,
    distanceMeters: a.distanceMeters + r.distanceMeters,
    reports: a.reports + r.reports,
    dailyReports: a.dailyReports + r.dailyReports,
    collected: a.collected + r.collected,
  }), { visits: 0, visitsCompleted: 0, distanceMeters: 0, reports: 0, dailyReports: 0, collected: 0 }), [rows]);

  // Excel (.xlsx) only: it carries the encoding and the columns inside the file, so Arabic
  // opens correctly on any machine. The CSV endpoints still exist for integrations.
  async function exportExcel() {
    setExporting(true);
    try {
      const blob = await apiBlob(`/api/monthly.xlsx?month=${month}`, {}, 'تعذر تصدير السجل الشهري. حاول مرة أخرى.');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `elhelb-monthly-${month}.xlsx`; document.body.appendChild(a); a.click(); a.remove();
      // Let the browser finish starting the download before releasing its blob URL.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر التصدير.'); }
    finally { setExporting(false); }
  }

  const months = useMemo(() => {
    const list: string[] = [];
    // Walk back month by month as strings: no Date object, so no timezone or day-overflow trap.
    for (let index = 0; index < 12; index++) list.push(shiftMonth(currentMonth, -index));
    return list;
  }, [currentMonth]);

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>السجل الشهري</h2>
          <p className="muted">سجل شهري لكل مهندس: عدد الزيارات وعدد التقارير (ميدانية + يومية) — جاهز للمراجعة والتصدير.</p>
        </div>
      </header>

      <div className="panel filters">
        <label className="field inline">
          <span>الشهر</span>
          <select value={month} onChange={e => setSelectedMonth(e.target.value)} disabled={!timezone}>
            {months.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <button className="btn primary sm" onClick={() => void load()} disabled={loading || !timezone}>{loading ? 'جارٍ التحميل…' : 'تحديث'}</button>
        <button className="btn primary sm" onClick={() => void exportExcel()} disabled={exporting || !timezone}>{exporting ? 'جارٍ التصدير…' : 'تصدير الشهر (Excel)'}</button>
        {error && <p className="error" role="alert">{error}</p>}
      </div>

      {!data && !error && <p role="status">جارٍ تحميل البيانات للفترة المختارة…</p>}
      {data && <>
      <div className="stats">
        <div className="card stat"><span className="muted small">إجمالي الزيارات</span><strong>{formatNumber(totals.visits)}</strong><small className="muted">{formatNumber(totals.visitsCompleted)} مكتملة</small></div>
        <div className="card stat"><span className="muted small">التقارير اليومية</span><strong>{formatNumber(totals.dailyReports)}</strong><small className="muted">الورقة الرسمية</small></div>
        <div className="card stat"><span className="muted small">التقارير الميدانية</span><strong>{formatNumber(totals.reports)}</strong><small className="muted">زيارة / تحصيل</small></div>
        <div className="card stat"><span className="muted small">المسافة المقطوعة</span><strong>{formatNumber(totals.distanceMeters / 1000)} كم</strong><small className="muted">تقديرية</small></div>
        <div className="card stat"><span className="muted small">إجمالي التحصيل</span><strong>{formatNumber(totals.collected)}</strong><small className="muted">ج.م</small></div>
      </div>

      <div className="panel">
        <h3 className="panel-title">سجل {month} · {formatNumber(rows.length)} مهندس</h3>
        {rows.length === 0 && !loading ? <p className="empty">لا توجد بيانات لهذا الشهر.</p> : (
          <div className="kpi-table-wrap">
            <table className="kpi-table">
              <thead>
                <tr>
                  <th>المهندس</th><th>المنطقة</th><th>زيارات</th><th>مكتملة</th><th>متوسط الزيارة</th><th>مسافة (كم)</th><th>تقارير ميدانية</th><th>تقارير يومية</th><th>تحصيل (ج.م)</th><th>آخر إشارة</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.repId}>
                    <td><span className="dot" style={{ background: r.color }} aria-hidden="true" /> {r.name}{r.active ? null : <em className="muted small"> · موقوف</em>}</td>
                    <td>{r.region || '—'}</td>
                    <td className="mono"><strong>{formatNumber(r.visits)}</strong></td>
                    <td className="mono">{formatNumber(r.visitsCompleted)}</td>
                    <td>{durationText(r.avgVisitSeconds)}</td>
                    <td className="mono">{formatNumber(r.distanceMeters / 1000)}</td>
                    <td className="mono">{formatNumber(r.reports)}</td>
                    <td className="mono"><strong>{formatNumber(r.dailyReports)}</strong></td>
                    <td className="mono">{r.collected ? formatNumber(r.collected) : '—'}</td>
                    <td>{r.lastFixAt ? ago(r.lastFixAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>الإجمالي</td><td>—</td><td>{formatNumber(totals.visits)}</td><td>{formatNumber(totals.visitsCompleted)}</td><td>—</td><td>{formatNumber(totals.distanceMeters / 1000)}</td><td>{formatNumber(totals.reports)}</td><td>{formatNumber(totals.dailyReports)}</td><td>{formatNumber(totals.collected)}</td><td>—</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="muted small" style={{ marginTop: 10 }}>
          {reps.length} مهندس على الحساب · البيانات حتى {data?.to ?? month} بتوقيت {data?.timezone ?? 'Africa/Cairo'}.
        </p>
      </div>
      </>}
    </section>
  );
}
