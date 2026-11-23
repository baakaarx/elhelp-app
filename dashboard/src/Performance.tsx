import { useCallback, useEffect, useMemo, useState } from 'react';
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
  const [data, setData] = useState<KpiResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    if (!timezone) return;
    setLoading(true); setError('');
    try { setData(await api<KpiResponse>(`/api/kpis?from=${from}&to=${to}`)); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل المؤشرات.'); }
    finally { setLoading(false); }
  }, [from, to, timezone]);

  useEffect(() => { if (timezone) void load(); }, [load, timezone]);

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
          <p className="muted">زيارات ومسافات وتحصيل لكل مهندس خلال الفترة — للمتابعة لا للحوافز.</p>
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
      <div className="stats">
        <div className="card stat"><span className="muted small">إجمالي الزيارات</span><strong>{formatNumber(totals.visits)}</strong><small className="muted">{formatNumber(totals.dailyReports)} تقرير يومي</small></div>
        <div className="card stat"><span className="muted small">المسافة المقطوعة</span><strong>{formatNumber(totals.distanceMeters / 1000)} كم</strong><small className="muted">تقديرية</small></div>
        <div className="card stat"><span className="muted small">تقارير الميدان</span><strong>{formatNumber(totals.reports)}</strong><small className="muted">ميداني</small></div>
        <div className="card stat"><span className="muted small">إجمالي التحصيل</span><strong>{formatNumber(totals.collected)}</strong><small className="muted">ج.م</small></div>
      </div>
      <SalesBoard data={data} from={from} to={to} loading={loading} />
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
          {formatNumber(reps.length)} مهندس على الحساب · التحصيل يُحسب من الزيارات المسجلة كـ«تحصيل» ومن تقارير التحصيل.
          المسافة تُستبعد منها النقاط الضعيفة الدقة، وهي تقديرية.
        </p>
      </div>
    </section>
  );
}

/**
 * «كل مهندس بيبيع بكام» — the money half of the same window.
 *
 * It reads the very rows the visit table reads, because `/api/kpis` already joins the register onto
 * each engineer: revenue and invoices from the invoices of the window, the target from the month the
 * window is opened in, and the best seller from the invoice lines. Nothing here is stored twice — a
 * percentage written next to a target is a number that goes stale the moment the office corrects an
 * invoice at eleven at night.
 *
 * Two «collected» numbers appear on this page and they are deliberately not the same. The column in
 * the table below comes from the invoices (what was banked against bills of this window); the one in
 * the field table comes from visits and daily reports marked as تحصيل (what the engineer says he
 * picked up). The gap between them is the reconciliation, not a bug.
 */
function SalesBoard({ data, from, to, loading }: { data: KpiResponse | null; from: string; to: string; loading: boolean }) {
  const rows = useMemo(() => [...(data?.rows ?? [])]
    .filter(row => (row.invoices ?? 0) > 0 || (row.revenue ?? 0) > 0 || (row.target ?? 0) > 0)
    .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0) || (b.collected2 ?? 0) - (a.collected2 ?? 0)), [data]);
  const company = data?.company;
  const target = company?.target ?? 0;
  const revenue = company?.sales.revenue ?? 0;
  const progress = target > 0 ? Math.round((revenue / target) * 100) : null;
  const money = (value: number) => `${formatNumber(value)} ج.م`;

  return (
    <div className="panel">
      <h3 className="panel-title">كل مهندس بيبيع بكام · {from} ← {to}</h3>
      {company && (
        <div className="stats">
          <div className="stat"><span className="label">البيع في الفترة</span><strong>{money(company.sales.revenue)}</strong><small>{formatNumber(company.sales.invoices)} فاتورة</small></div>
          <div className="stat"><span className="label">هدف الشركة</span><strong>{target ? money(target) : '—'}</strong><small>{progress === null ? 'لا يوجد هدف مسجل للشهر اللي النطاق فيه' : `${formatNumber(progress)}٪ تحقق`}</small></div>
          <div className="stat"><span className="label">المسدد على الفواتير</span><strong>{money(company.sales.collected)}</strong><small>{money(company.sales.outstanding)} لسه على العملاء</small></div>
          <div className="stat"><span className="label">الأكثر مبيعًا</span><strong>{company.sales.topProduct?.name || '—'}</strong>
            <small>{company.sales.topProduct ? `${formatNumber(company.sales.topProduct.qty)} ${company.sales.topProduct.unit} · ${money(company.sales.topProduct.revenue)} · ${formatNumber(company.sales.stockShort)} فاتورة نقصت من المخزن` : 'مافيش بيع في الفترة'}</small></div>
        </div>
      )}
      {rows.length === 0 && !loading ? <p className="empty">مافيش فاتورة ولا هدف في الفترة دي.</p> : (
        <div className="kpi-table-wrap">
          <table className="money-table">
            <thead>
              <tr>
                <th>المهندس</th><th>البيع (ج.م)</th><th>فواتير</th><th>نسبة الهدف</th>
                <th>مسدد (ج.م)</th><th>باقي على العملاء</th><th>الأكثر مبيعًا له</th><th>نقص مخزن</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const rowTarget = row.target ?? 0;
                return (
                  <tr key={row.repId}>
                    <td><span className="dot" style={{ background: row.color }} aria-hidden="true" /> {row.name}{row.active ? null : <em className="muted small"> · موقوف</em>}</td>
                    <td className="mono"><strong>{money(row.revenue ?? 0)}</strong></td>
                    <td className="mono">{formatNumber(row.invoices ?? 0)}{row.targetInvoices ? ` / ${formatNumber(row.targetInvoices)}` : ''}</td>
                    <td>
                      {row.targetProgress === null || row.targetProgress === undefined ? (
                        <span className="muted small">{rowTarget ? '—' : 'مافيش هدف'}</span>
                      ) : (
                        <span className={`bar-cell ${row.targetProgress >= 100 ? 'ok-text' : row.targetProgress >= 60 ? '' : 'visit-marks'}`}>
                          <span className="bar" role="progressbar" aria-valuenow={row.targetProgress} aria-valuemin={0} aria-valuemax={100}>
                            <i style={{ width: `${Math.min(100, row.targetProgress)}%` }} />
                          </span>
                          <span className="mono">{formatNumber(row.targetProgress)}٪</span>
                        </span>
                      )}
                    </td>
                    <td className="mono">{money(row.collected2 ?? 0)}</td>
                    <td className={(row.outstanding ?? 0) > 0 ? 'visit-marks' : 'muted small'}>{money(row.outstanding ?? 0)}</td>
                    <td>{row.topProduct ? <span>{row.topProduct} <small className="muted">{formatNumber(row.topProductQty ?? 0)} {row.topProductUnit} · {money(row.topProductRevenue ?? 0)}</small></span> : <span className="muted small">—</span>}</td>
                    <td className={(row.stockShortInvoices ?? 0) > 0 ? 'visit-marks' : 'muted small'}>{formatNumber(row.stockShortInvoices ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>الإجمالي</td><td className="mono">{money(revenue)}</td>
                <td className="mono">{formatNumber(company?.sales.invoices ?? 0)}</td>
                <td className="mono">{progress === null ? '—' : `${formatNumber(progress)}٪`}</td>
                <td className="mono">{money(company?.sales.collected ?? 0)}</td>
                <td className="mono">{money(company?.sales.outstanding ?? 0)}</td>
                <td className="muted small">{company?.sales.topProduct?.name || '—'}</td>
                <td className="mono">{formatNumber(company?.sales.stockShort ?? 0)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>
        البيع محسوب من الفواتير غير الملغاة بتاريخ الفاتورة جوه النطاق، والمسدد هو اللي على الفواتير دي نفسها —
        يعني فلوس استلمها المكتب على فاتورة قديمة بتظهر تحت الشهر اللي اتسدد فيه، مش شهر الفاتورة.
        «نسبة الهدف» بتقارن بهدف الشهر: نفس الشهر لو النطاق جوه شهر واحد، وشهر آخر يوم في النطاق لو عدّى أكتر من شهر — والتفصيل الشهري الدقيق في تبويب الأهداف.
      </p>
    </div>
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
