import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import LocationName from './LocationName';
import { movementStatus } from './locationStatus';
import { ago, downloadKpisExcel, durationText, formatNumber } from './session';
import type { KpiResponse, KpiRow, Rep } from './types';

const today = () => new Date().toLocaleDateString('en-CA');
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA');

export default function Performance({ reps }: { reps: Rep[] }) {
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(today());
  const [data, setData] = useState<KpiResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await api<KpiResponse>(`/api/kpis?from=${from}&to=${to}`)); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل المؤشرات.'); }
    finally { setLoading(false); }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => [...(data?.rows ?? [])].sort((a, b) => b.visits - a.visits || b.distanceMeters - a.distanceMeters), [data]);
  const totals = useMemo(() => rows.reduce((acc, row) => ({
    visits: acc.visits + row.visits,
    distanceMeters: acc.distanceMeters + row.distanceMeters,
    reports: acc.reports + row.reports,
    collected: acc.collected + row.collected,
    dailyReports: acc.dailyReports + row.dailyReports,
  }), { visits: 0, distanceMeters: 0, reports: 0, collected: 0, dailyReports: 0 }), [rows]);

  async function exportExcel() {
    setExporting(true);
    try { await downloadKpisExcel(from, to); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر التصدير.'); }
    finally { setExporting(false); }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>الأداء والمؤشرات</h2>
          <p className="muted">زيارات ومسافات وتحصيل لكل مهندس خلال الفترة — للمتابعة لا للحوافز.</p>
        </div>
        <div className="row">
          <button className="btn ghost sm" onClick={() => { setFrom(daysAgo(0)); setTo(daysAgo(0)); }}>اليوم</button>
          <button className="btn ghost sm" onClick={() => { setFrom(daysAgo(6)); setTo(daysAgo(0)); }}>٧ أيام</button>
          <button className="btn ghost sm" onClick={() => { setFrom(daysAgo(29)); setTo(daysAgo(0)); }}>٣٠ يوم</button>
        </div>
      </header>
      <div className="panel filters">
        <label className="field inline"><span>من</span><input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
        <label className="field inline"><span>إلى</span><input type="date" value={to} min={from} max={today()} onChange={e => setTo(e.target.value)} /></label>
        <button className="btn primary sm" onClick={() => void load()} disabled={loading}>{loading ? 'جارٍ التحميل…' : 'تحديث'}</button>
        <button className="btn primary sm" onClick={() => void exportExcel()} disabled={exporting}>{exporting ? 'جارٍ التصدير…' : 'تصدير Excel (.xlsx)'}</button>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <div className="stats">
        <div className="card stat"><span className="muted small">إجمالي الزيارات</span><strong>{formatNumber(totals.visits)}</strong><small className="muted">{formatNumber(totals.dailyReports)} تقرير يومي</small></div>
        <div className="card stat"><span className="muted small">المسافة المقطوعة</span><strong>{formatNumber(totals.distanceMeters / 1000)} كم</strong><small className="muted">تقديرية</small></div>
        <div className="card stat"><span className="muted small">تقارير الميدان</span><strong>{formatNumber(totals.reports)}</strong><small className="muted">ميداني</small></div>
        <div className="card stat"><span className="muted small">إجمالي التحصيل</span><strong>{formatNumber(totals.collected)}</strong><small className="muted">ج.م</small></div>
      </div>
      <div className="panel">
        <h3 className="panel-title">مقارنة الفريق · {from} ← {to}</h3>
        {rows.length === 0 && !loading ? <p className="empty">لا توجد بيانات في هذه الفترة.</p> : (
          <div className="kpi-table-wrap">
            <table className="kpi-table">
              <thead>
                <tr>
                  <th>المهندس</th><th>المنطقة المسجلة / الموقع</th><th>أيام نشاط</th><th>زيارات</th><th>متوسط الزيارة</th>
                  <th>مسافة (كم)</th><th>تقارير</th><th>تحصيل (ج.م)</th><th>تقارير يومية</th><th>آخر إشارة</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => <KpiTableRow key={row.repId} row={row} rep={reps.find(rep => rep.id === row.repId)} />)}
              </tbody>
              <tfoot>
                <tr>
                  <td>الإجمالي</td><td>—</td><td>—</td><td>{formatNumber(totals.visits)}</td><td>—</td>
                  <td>{formatNumber(totals.distanceMeters / 1000)}</td><td>{formatNumber(totals.reports)}</td>
                  <td>{formatNumber(totals.collected)}</td><td>{formatNumber(totals.dailyReports)}</td><td>—</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="muted small" style={{ marginTop: 10 }}>
          {formatNumber(reps.length)} مهندس على الحساب · التحصيل يُحسب من الزيارات المسجلة كـ«تحصيل» ومن تقارير التحصيل.
          المسافة تُستبعد منها النقاط الضعيفة الدقة، وهي تقديرية.
        </p>
      </div>
    </section>
  );
}

function KpiTableRow({ row, rep }: { row: KpiRow; rep?: Rep }) {
  const bar = Math.min(100, row.visits * 12);
  return (
    <tr>
      <td><span className="dot" style={{ background: row.color }} aria-hidden="true" /> {row.name}{row.isDemo ? <em className="muted small"> (تجريبي)</em> : null}{row.active ? null : <em className="muted small"> · موقوف</em>}</td>
      <td>{row.region && row.region !== 'موقعك الحقيقي' ? <div>{row.region} <small className="muted">(مسجلة)</small></div> : null}{rep ? <div>{movementStatus(rep)}</div> : null}<LocationName location={rep?.location ?? null} /></td>
      <td className="mono">{formatNumber(row.daysWithData)}</td>
      <td>
        <div className="bar-cell"><span className="mono">{formatNumber(row.visits)}</span><span className="bar"><i style={{ width: `${bar}%` }} /></span></div>
      </td>
      <td>{durationText(row.avgVisitSeconds)}</td>
      <td className="mono">{formatNumber(row.distanceMeters / 1000)}</td>
      <td className="mono">{formatNumber(row.reports)}</td>
      <td className="mono">{row.collected ? formatNumber(row.collected) : '—'}</td>
      <td className="mono">{formatNumber(row.dailyReports)}</td>
      <td>{row.lastFixAt ? ago(row.lastFixAt) : '—'}</td>
    </tr>
  );
}
