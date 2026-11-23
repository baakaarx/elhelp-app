import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, patch } from './api';
import { ago, formatNumber } from './session';
import { localDateText } from './dates';
import type { CollectionReport, Rep } from './types';

/**
 * التحصيل — who collected what, and what is still owed.
 *
 * A collection is an event, not a field: the same invoice gets paid in three visits, sometimes by the
 * engineer standing at the farm and sometimes by the office banking a cheque. Both are recorded and
 * both are shown, because the end-of-day reconciliation is exactly the difference between them, and a
 * report that prints only one number per invoice is a report nobody can settle against a drawer.
 *
 * A collection is never deleted. A mistake is corrected with a negative entry, so the trail of the
 * money stays readable.
 */
const PERIODS = [
  { id: 'month', label: 'الشهر ده' },
  { id: 'last-month', label: 'الشهر اللي فات' },
  { id: '30', label: 'آخر ٣٠ يوم' },
  { id: '7', label: 'أسبوع' },
  { id: 'year', label: 'السنة دي' },
];
const money = (value: number) => `${formatNumber(value)} ج.م`;

function periodWindow(period: string): { from: number; to: number; label: string } {
  const now = new Date();
  const day = 86400000;
  const start = (y: number, m: number) => new Date(y, m, 1, 0, 0, 0, 0).getTime();
  if (period === 'last-month') {
    const from = start(now.getFullYear(), now.getMonth() - 1);
    return { from, to: start(now.getFullYear(), now.getMonth()) - 1, label: localDateText(from) };
  }
  if (period === 'month') return { from: start(now.getFullYear(), now.getMonth()), to: now.getTime(), label: localDateText(start(now.getFullYear(), now.getMonth())) };
  if (period === 'year') return { from: start(now.getFullYear(), 0), to: now.getTime(), label: `١ يناير ${now.getFullYear()}` };
  const days = period === '7' ? 7 : 30;
  return { from: now.getTime() - days * day, to: now.getTime(), label: `آخر ${days} يوم` };
}

export default function Collections({ reps, version = 0, canCollect = true }: { reps: Rep[]; version?: number; canCollect?: boolean }) {
  const [period, setPeriod] = useState('month');
  const [repId, setRepId] = useState('all');
  const [report, setReport] = useState<CollectionReport | null>(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState<{ id: string; amount: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const { from, to } = periodWindow(period);
    const query = new URLSearchParams({ from: String(from), to: String(to) });
    if (repId !== 'all') query.set('repId', repId);
    try { setReport(await api<CollectionReport>(`/api/collections?${query}`)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل التحصيل.'); }
  }, [period, repId]);

  useEffect(() => { void refresh(); }, [refresh, version]);

  const span = useMemo(() => periodWindow(period), [period]);
  const rows = report?.byRep ?? [];
  const totals = report?.totals;
  // The engineer list is grouped by whoever owns the customer; an entry typed by the office for a
  // departed engineer lands under «بدون مهندس» rather than vanishing from the month.
  const mismatched = rows.filter(row => row.collected > 0 && row.outstanding > 0);

  async function recordPayment(invoiceId: string, amount: number) {
    setBusy(true);
    try {
      await patch(`/api/invoices/${invoiceId}`, { paidAmount: amount });
      setPaying(null);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تسجيل التحصيل.'); }
    finally { setBusy(false); }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>التحصيل</h2>
          <p className="muted">مين حصّل كام، ولسه على كل عميل قد إيه — بالسجل مش بالاجماليات.</p>
        </div>
        <div className="filters">
          <label className="field inline">
            <span>الفترة</span>
            <select value={period} onChange={event => setPeriod(event.target.value)}>
              {PERIODS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label className="field inline">
            <span>المهندس</span>
            <select value={repId} onChange={event => setRepId(event.target.value)}>
              <option value="all">الكل</option>
              {reps.map(rep => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
            </select>
          </label>
          <button className="btn ghost sm" onClick={() => void refresh()}>تحديث</button>
        </div>
      </header>

      {error && <p className="error banner" role="alert">{error}</p>}
      {!report ? <p className="muted">جارٍ التحميل…</p> : (
        <>
          <div className="stats">
            <div className="stat"><span className="label">المحصّل في الفترة</span><strong>{money(totals?.collected ?? 0)}</strong><small>{span.label} → {localDateText(span.to)} · {formatNumber(totals?.entries ?? 0)} عملية · {formatNumber(totals?.customers ?? 0)} عميل</small></div>
            <div className="stat"><span className="label">المهندس بيشيل الفلوس</span><strong>{money(rows.reduce((sum, row) => sum + row.fromField, 0))}</strong><small>المهندس كتبها في الميدان</small></div>
            <div className="stat"><span className="label">من المكتب</span><strong>{money(rows.reduce((sum, row) => sum + row.fromOffice, 0))}</strong><small>التحصيل اللي سجله المكتب</small></div>
            <div className="stat"><span className="label">لسه على العملاء</span><strong>{money(rows.reduce((sum, row) => sum + row.outstanding, 0))}</strong><small>{formatNumber(rows.reduce((sum, row) => sum + row.openInvoices, 0))} فاتورة مفتوحة</small></div>
          </div>

          {/* The register and the invoice books are written by the same code, so they must agree. When
              they do not, the difference is shown instead of hidden: it is the number someone will ask
              about at the end of the month, and a silent report is a worse answer than an ugly one. */}
          {report.lifetime && Math.abs(report.lifetime.difference) > 0.5 ? (
            <p className="error banner" role="alert">
              {`الفواتير بتقول إن المتسدد ${money(report.lifetime.paidOnInvoices)} والسجل بيقول ${money(report.lifetime.registered)} — الفرق ${money(report.lifetime.difference)}.`}
              {' '}ده بيحصل لما يكون فيه فلوس اتسجلت على الفواتير قبل ما سجل التحصيل يتفعّل؛ الترقية بتاعت السيرفر بتكتبها عملية واحدة لكل فاتورة، فلو الرقم فضل مختلف بعد التحديث اطلب مراجعة من المدير.
            </p>
          ) : null}

          <div className="panel">
            <h3 className="panel-title">كل مهندس حصّل كام</h3>
            {rows.length === 0 ? <p className="empty">مافيش تحصيل مسجل في الفترة دي.</p> : (
              <div className="kpi-table-wrap">
                <table className="kpi-table">
                  <thead>
                    <tr><th>المهندس</th><th>المحصّل</th><th>من الميدان</th><th>من المكتب</th><th>عدد العمليات</th><th>لسه عليه</th></tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <tr key={row.repId ?? 'none'}>
                        <td><span className="dot" style={{ background: row.repColor }} aria-hidden="true" /> {row.repName}</td>
                        <td className="mono"><strong>{money(row.collected)}</strong></td>
                        <td className="mono">{money(row.fromField)}</td>
                        <td className="mono muted">{money(row.fromOffice)}</td>
                        <td className="mono">{formatNumber(row.entries)}</td>
                        <td className={row.outstanding > 0 ? 'visit-marks' : 'muted small'}>
                          {money(row.outstanding)}{row.openInvoices ? ` · ${formatNumber(row.openInvoices)} فاتورة` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {mismatched.length > 0 && (
              <p className="muted small">
                {formatNumber(mismatched.length)} مهندس عنده تحصيل في الفترة ولسه عليه فواتير مفتوحة — دي التسوية اللي تتراجع آخر اليوم.
              </p>
            )}
          </div>

          <div className="two-col">
            <div className="panel">
              <h3 className="panel-title">أعلى العملاء تحصيلًا</h3>
              {report.byCustomer.length === 0 ? <p className="empty">مافيش.</p> : (
                <div className="kpi-table-wrap">
                  <table className="kpi-table">
                    <thead><tr><th>العميل</th><th>المحصّل</th><th>آخر تحصيل</th></tr></thead>
                    <tbody>
                      {report.byCustomer.map(row => (
                        <tr key={row.customerId ?? row.customerName}>
                          <td>{row.customerName}</td>
                          <td className="mono"><strong>{money(row.collected)}</strong></td>
                          <td className="muted small">{row.lastAt ? ago(row.lastAt) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="panel">
              <h3 className="panel-title">الفواتير اللي عليها باقي</h3>
              <UnpaidList repId={repId} canCollect={canCollect} paying={paying} setPaying={setPaying} busy={busy} onPaid={recordPayment} onError={setError} />
            </div>
          </div>

          <div className="panel">
            <h3 className="panel-title">سجل العمليات ({formatNumber(report.entries.length)})</h3>
            {report.entries.length === 0 ? <p className="empty">مافيش عملية في الفترة.</p> : (
              <div className="kpi-table-wrap">
                <table className="kpi-table">
                  <thead><tr><th>الوقت</th><th>العميل</th><th>المبلغ</th><th>الفاتورة</th><th>بتاع</th><th>سجلها</th></tr></thead>
                  <tbody>
                    {report.entries.map(entry => (
                      <tr key={entry.id}>
                        <td className="muted small">{localDateText(entry.createdAt)}</td>
                        <td>{entry.customerName || '—'}</td>
                        <td className={`mono ${entry.amount < 0 ? 'error' : 'ok-text'}`}>{entry.amount < 0 ? '' : '+'}{money(entry.amount)}</td>
                        <td className="mono muted small">{entry.invoiceNumber ?? '—'}{entry.invoiceTotal !== null ? ` (${money(entry.invoicePaid ?? 0)} / ${money(entry.invoiceTotal)})` : ''}</td>
                        <td>{entry.repName}</td>
                        <td className="muted small">{entry.recordedBy || '—'}{entry.source === 'field' ? ' · من الموبايل' : ''}{entry.note ? ` · ${entry.note}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small">التحصيل ما بيتحذفش — الغلط يتصلّح بعملية بالسالب، عشان يفضل أثر الفلوس مقروء.</p>
          </div>
        </>
      )}
    </section>
  );
}

/** The slice of an invoice row this screen touches; the register answers with the full invoice. */
interface InvoiceRow { id: string; number: string | null; customerName: string; repName: string; total: number; paidAmount: number; date: string }

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The follow-up list: unpaid bills, with the box that closes them. */
function UnpaidList({ repId, canCollect, paying, setPaying, busy, onPaid, onError }: {
  repId: string;
  canCollect: boolean;
  paying: { id: string; amount: string } | null;
  setPaying: (value: { id: string; amount: string } | null) => void;
  busy: boolean;
  onPaid: (invoiceId: string, amount: number) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [invoices, setInvoices] = useState<(InvoiceRow & { outstanding: number })[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    // «open» = unpaid *and* partially paid: a bill that still owes money is a follow-up, whether or
    // not something was banked against it. Filtering on `status=unpaid` here would hide exactly the
    // invoices the reconciliation is about.
    const query = new URLSearchParams({ open: '1', limit: '40' });
    if (repId !== 'all') query.set('repId', repId);
    try {
      const res = await api<{ invoices: InvoiceRow[] }>(`/api/invoices?${query}`);
      setInvoices(res.invoices.map(row => ({
        id: row.id, number: row.number, customerName: row.customerName, repName: row.repName,
        total: row.total, paidAmount: row.paidAmount, outstanding: Math.max(0, row.total - row.paidAmount), date: row.date,
      })));
    } catch (e) { onError(e instanceof Error ? e.message : 'تعذر تحميل الفواتير غير المحصلة.'); }
    finally { setLoading(false); }
  }, [repId, onError]);
  useEffect(() => { void load(); }, [load]);

  if (loading) return <p className="muted">جارٍ التحميل…</p>;
  if (invoices.length === 0) return <p className="empty">مافيش فاتورة غير محصلة خالص.</p>;
  return (
    <>
      <ul className="stack-list">
        {invoices.map(invoice => (
          <li key={invoice.id} className="card report">
            <div className="report-head">
              <div className="grow">
                <h3>{invoice.customerName}</h3>
                <p className="muted small"><span className="mono">{invoice.number ?? '—'}</span> · {invoice.repName} · {invoice.date}</p>
                <p className="visit-marks">عليه {money(invoice.outstanding)} من {money(invoice.total)}</p>
              </div>
              {paying?.id === invoice.id ? (
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <label className="field inline" style={{ margin: 0 }}>
                    <span>إجمالي المسدد بعد التحصيل ده (ج.م)</span>
                    <input className="mono" style={{ width: 130 }} value={paying.amount} onChange={event => setPaying({ id: invoice.id, amount: event.target.value })} />
                  </label>
                  <button className="btn primary sm" disabled={busy} onClick={() => { void onPaid(invoice.id, Number(paying.amount || 0)); setPaying(null); }}>سجّل</button>
                  <button className="btn ghost sm" onClick={() => setPaying(null)}>إلغاء</button>
                </span>
              ) : canCollect ? (
                <div className="report-actions">
                  <button className="btn ghost sm" onClick={() => setPaying({ id: invoice.id, amount: String(round2(invoice.paidAmount + invoice.outstanding)) })}>تسجيل تحصيل</button>
                </div>
              ) : <p className="muted small">التسجيل من حساب المكتب أو المدير.</p>}
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small">
        الخانة دي بتكتب «إجمالي المسدد على الفاتورة» مش «المبلغ اللي استلمته» — عشان كده اللي بيدخل سجل التحصيل هو الفرق بين اللي كتبته واللي كان مسجل قبلها، ومرتين تعديل في اليوم ما يظهروش كعمليتين.
        المسدد ما بيرجعش لورا بالتعديل: لو الفلوس اتسجلت غلط، الفاتورة تُلغى وتُسجّل من جديد — والإلغاء نفسه بيكتب عملية بالسالب في السجل، فالفاتورة الملغاة ما تسيبهاش فلوس محسوبة على لا حاجة.
      </p>
    </>
  );
}
