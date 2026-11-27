import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import LocationName from './LocationName';
import { movementStatus } from './locationStatus';
import { ago, downloadKpisExcel, durationText, formatNumber } from './session';
import { dayBefore, localDay } from './dates';
import type { KpiResponse, KpiRow, Rep } from './types';

export default function Performance({ reps, staleGpsMinutes = 10, timezone }: { reps: Rep[]; staleGpsMinutes?: number; timezone?: string }) {
  const today = () => localDay(timezone);
  const daysAgo = (days: number) => dayBefore(days, timezone);
  const [rangeOverride, setRangeOverride] = useState<{ from: string; to: string } | null>(null);
  const from = rangeOverride?.from ?? dayBefore(6, timezone);
  const to = rangeOverride?.to ?? localDay(timezone);
  const setFrom = (value: string) => setRangeOverride(current => ({
    from: value,
    to: current?.to ?? today(),
  }));
  const setTo = (value: string) => setRangeOverride(current => ({
    from: current?.from ?? daysAgo(6),
    to: value,
  }));
  const key = `${from}:${to}`;
  const currentKey = useRef(key); currentKey.current = key;
  const requestId = useRef(0);
  const [result, setResult] = useState<{ key: string; data: KpiResponse } | null>(null);
  const data = result?.key === key ? result.data : null;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    if (!timezone) return;
    const id = ++requestId.current;
    setLoading(true); setError(''); setResult(null);
    try { const data = await api<KpiResponse>(`/api/kpis?from=${from}&to=${to}`); if (id === requestId.current && currentKey.current === key) setResult({ key, data }); }
    catch (e) { if (id === requestId.current && currentKey.current === key) setError(e instanceof Error ? e.message : 'تعذر تحميل المؤشرات.'); }
    finally { if (id === requestId.current && currentKey.current === key) setLoading(false); }
  }, [from, to, timezone]);

  useEffect(() => { if (timezone) void load(); return () => { requestId.current++; }; }, [load, timezone]);

  const rows = useMemo(() => [...(data?.rows ?? [])].sort((a, b) => b.visits - a.visits || b.distanceMeters - a.distanceMeters), [data]);
  const totals = useMemo(() => rows.reduce((acc, row) => ({
    visits: acc.visits + row.visits,
    distanceMeters: acc.distanceMeters + row.distanceMeters,
    reports: acc.reports + row.reports,
    collected: acc.collected + row.collected,
    dailyReports: acc.dailyReports + row.dailyReports,
  }), { visits: 0, distanceMeters: 0, reports: 0, collected: 0, dailyReports: 0 }), [rows]);

  const applyPreset = (days: number) => setRangeOverride({
    from: daysAgo(days - 1),
    to: today(),
  });

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
          <p className="muted">زيارات ومسافات الفريق خلال الفترة — للمتابعة لا للحوافز.</p>
        </div>
        <div className="row">
          <button className="btn ghost sm" onClick={() => applyPreset(1)} disabled={!timezone}>اليوم</button>
          <button className="btn ghost sm" onClick={() => applyPreset(7)} disabled={!timezone}>٧ أيام</button>
          <button className="btn ghost sm" onClick={() => applyPreset(30)} disabled={!timezone}>٣٠ يوم</button>
        </div>
      </header>
      <div className="panel filters">
        <label className="field inline"><span>من</span><input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} disabled={!timezone} /></label>
        <label className="field inline"><span>إلى</span><input type="date" value={to} min={from} max={today()} onChange={e => setTo(e.target.value)} disabled={!timezone} /></label>
        <button className="btn primary sm" onClick={() => void load()} disabled={loading || !timezone}>{loading ? 'جارٍ التحميل…' : 'تحديث'}</button>
        <button className="btn primary sm" onClick={() => void exportExcel()} disabled={exporting || !timezone}>{exporting ? 'جارٍ التصدير…' : 'تصدير Excel (.xlsx)'}</button>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      {!data && !error && <p role="status">جارٍ تحميل البيانات للفترة المختارة…</p>}
      {data && <>
      <div className="stats">
        <div className="card stat"><span className="muted small">إجمالي الزيارات</span><strong>{formatNumber(totals.visits)}</strong><small className="muted">{formatNumber(totals.dailyReports)} تقرير يومي</small></div>
        <div className="card stat"><span className="muted small">المسافة المقطوعة</span><strong>{formatNumber(totals.distanceMeters / 1000)} كم</strong><small className="muted">تقديرية</small></div>
        <div className="card stat"><span className="muted small">تقارير الميدان</span><strong>{formatNumber(totals.reports)}</strong><small className="muted">ميداني</small></div>
        <div className="card stat"><span className="muted small">مبالغ ميدانية قديمة</span><strong>{formatNumber(totals.collected)}</strong><small className="muted">ج.م</small></div>
      </div>
      <div className="panel">
        <h3 className="panel-title">مقارنة الفريق · {from} ← {to}</h3>
        {rows.length === 0 && !loading ? <p className="empty">لا توجد بيانات في هذه الفترة.</p> : (
          <div className="kpi-table-wrap">
            <table className="kpi-table">
              <thead>
                <tr>
                  <th>المهندس</th><th>المنطقة المسجلة / الموقع</th><th>أيام نشاط</th><th>زيارات</th><th>متوسط الزيارة</th>
                  <th>مسافة (كم)</th><th>تقارير</th><th>مبالغ ميدانية قديمة (ج.م)</th><th>تقارير يومية</th><th>آخر إشارة</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => <KpiTableRow key={row.repId} row={row} rep={reps.find(rep => rep.id === row.repId)} staleMinutes={staleGpsMinutes} timezone={timezone} />)}
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
          {formatNumber(reps.length)} مهندس على الحساب · المبالغ الميدانية القديمة ليست دفعات مبيعات ولا تخصم من حساب العميل؛ راجع المبيعات قبل تسجيل أي دفعة.
          المسافة تُستبعد منها النقاط الضعيفة الدقة، وهي تقديرية.
        </p>
      </div>
      </>}
    </section>
  );
}

function KpiTableRow({ row, rep, staleMinutes, timezone }: { row: KpiRow; rep?: Rep; staleMinutes: number; timezone?: string }) {
  const bar = Math.min(100, row.visits * 12);
  return (
    <tr>
      <td><span className="dot" style={{ background: row.color }} aria-hidden="true" /> {row.name}{row.active ? null : <em className="muted small"> · موقوف</em>}</td>
      <td>{row.region && row.region !== 'موقعك الحقيقي' ? <div>{row.region} <small className="muted">(مسجلة)</small></div> : null}{rep ? <div>{movementStatus(rep, Date.now(), staleMinutes * 60000)}</div> : null}<LocationName location={rep?.location ?? null} timezone={timezone} /></td>
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
