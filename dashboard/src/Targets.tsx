import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, put } from './api';
import { formatNumber } from './session';
import { localDateText, localDay } from './dates';
import type { TargetRow, TargetsResponse } from './types';

/**
 * الأهداف الشهرية.
 *
 * A target is a plan, so the table behind this screen stores nothing but the plan: the revenue and the
 * progress bar are computed from the invoices every time the page opens. That is deliberate — a
 * percentage saved next to the target is a percentage that goes stale the first time an invoice is
 * voided, and a manager arguing with a sales office about a month needs the number to move when the
 * money moves.
 *
 * Only the manager account can write here. A number an engineer can set for himself is not a target,
 * it is a wish — and the whole point of the row is that it comes from above and is measured below.
 */
const money = (value: number) => `${formatNumber(value)} ج.م`;

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(y, m - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('ar-EG', { month: 'long', year: 'numeric' });
};

export default function Targets({ version = 0, canManage = false }: { version?: number; canManage?: boolean }) {
  const [month, setMonth] = useState(localDay().slice(0, 7));
  const [data, setData] = useState<TargetsResponse | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setData(await api<TargetsResponse>(`/api/targets?month=${month}`)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل الأهداف.'); }
  }, [month]);
  useEffect(() => { void refresh(); }, [refresh, version]);

  const rows = useMemo(() => data ? [...data.reps, ...data.retired] : [], [data]);
  const missing = rows.filter(row => row.target === 0).length;
  const totalTarget = rows.reduce((sum, row) => sum + row.target, 0);

  async function save(row: TargetRow | null, value: { revenue: string; invoices: string; note: string }) {
    const key = row?.repId ?? 'company';
    setSaving(key);
    try {
      await put('/api/targets', {
        month,
        repId: row?.repId ?? null,
        revenue: Number(value.revenue || 0),
        invoices: Number(value.invoices || 0),
        note: value.note.trim(),
      });
      setError('');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر حفظ الهدف.'); }
    finally { setSaving(null); }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>الأهداف الشهرية</h2>
          <p className="muted">هدف لكل مهندس وهدف للشركة — والنسبة محسوبة من الفواتير نفسها، مش من رقم مكتوب جنبه.</p>
        </div>
        <div className="filters">
          <button className="btn ghost sm" onClick={() => setMonth(value => shiftMonth(value, -1))} aria-label="الشهر اللي فات">←</button>
          <label className="field inline">
            <span>الشهر</span>
            <input className="mono" type="month" lang="ar-EG" value={month} onChange={event => setMonth(event.target.value || localDay().slice(0, 7))} />
          </label>
          <button className="btn ghost sm" onClick={() => setMonth(value => shiftMonth(value, 1))} aria-label="الشهر الجاي">→</button>
          <button className="btn ghost sm" onClick={() => setMonth(localDay().slice(0, 7))}>الشهر ده</button>
        </div>
      </header>

      {error && <p className="error banner" role="alert">{error}</p>}
      {!data ? <p className="muted">جارٍ التحميل…</p> : (
        <>
          <p className="muted small">
            {monthLabel(month)} · من {data.from} إلى {data.to}
            {data.isCurrentMonth ? '' : ' · شهر مقفل: التعديل فيه يغيّر الخطة retrospective، والماضي ما بيتغيّرش.'}
          </p>
          <div className="stats">
            <div className="stat"><span className="label">هدف الشركة</span><strong>{money(data.company.target || totalTarget)}</strong><small>{formatNumber(data.company.invoiceTarget)} فاتورة مستهدفة · مجموع أهداف المهندسين {money(totalTarget)}</small></div>
            <div className="stat"><span className="label">اللي اتباع</span><strong>{money(data.company.revenue)}</strong><small>{formatNumber(data.company.invoices)} فاتورة · حصّل {money(data.company.collected)}</small></div>
            <div className="stat"><span className="label">لسه على الهدف</span><strong>{money(data.company.remaining)}</strong><small>{data.company.progress === null ? 'مافيش هدف الشركة مسجل' : `${formatNumber(data.company.progress)}٪ من الهدف`}</small></div>
            <div className="stat"><span className="label">مهندسين من غير هدف</span><strong>{formatNumber(missing)}</strong><small>من {formatNumber(rows.length)} — دول اللي المشايفة بتاعتهم تفلت</small></div>
          </div>

          <TargetEditor row={data.company} label="هدف الشركة كله" repId={null} saving={saving} canManage={canManage} onSave={value => save(null, value)} />

          <div className="panel">
            <h3 className="panel-title">الأهداف لكل مهندس</h3>
            {rows.length === 0 ? <p className="empty">مافيش مهندسين نشطين — ضيف مهندس من فريق الميدان الأول.</p> : (
              <div className="kpi-table-wrap">
                <table className="kpi-table">
                  <thead>
                    <tr><th>المهندس</th><th>الهدف</th><th>اللي اتباع</th><th>نسبة الهدف</th><th>فواتير</th><th>حصّل</th><th>لسه</th></tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <tr key={row.repId ?? 'none'} style={row.repActive ? undefined : { opacity: 0.6 }}>
                        <td>
                          <span className="dot" style={{ background: row.repColor }} aria-hidden="true" /> {row.repName}
                          {!row.repActive && <span className="muted small"> · مش نشط</span>}
                        </td>
                        <td className="mono"><strong>{row.target ? money(row.target) : <span className="error">مافيش</span>}</strong></td>
                        <td className="mono">{money(row.revenue)}</td>
                        <td>
                          {row.progress === null ? <span className="muted small">—</span> : (
                            <span className={`bar-cell ${row.progress >= 100 ? 'ok-text' : row.progress >= 60 ? '' : 'visit-marks'}`}>
                              <span className="bar" role="progressbar" aria-valuenow={row.progress} aria-valuemin={0} aria-valuemax={100}>
                                <i style={{ width: `${Math.min(100, row.progress)}%` }} />
                              </span>
                              <span className="mono">{formatNumber(row.progress)}٪</span>
                            </span>
                          )}
                        </td>
                        <td className="mono">{formatNumber(row.invoices)}{row.invoiceTarget ? ` / ${formatNumber(row.invoiceTarget)}` : ''}</td>
                        <td className="mono">{money(row.collected)}</td>
                        <td className={row.remaining > 0 ? 'visit-marks' : 'muted small'}>{row.remaining > 0 ? money(row.remaining) : 'خلص'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small">
              ملاحظة: «اللي اتباع» محسوب من الفواتير غير الملغاة بتاريخ الفاتورة جوه الشهر، بس. لو عايز ترجّع لعربية اتلغت، الفاتورة الملغاة ما تدخلش.
            </p>
          </div>

          <div className="two-col">
            {rows.filter(row => row.repId !== null).map(row => (
              <TargetEditor key={row.repId} row={row} label={row.repName} repId={row.repId} saving={saving} canManage={canManage} onSave={value => save(row, value)} />
            ))}
          </div>
          <p className="muted small">
            {`الهندسة بتاعة الشاشة: الرقم اللي في العمود «اللي اتباع» ما بيتكتبش — بيتحسب. عشان كده لو المكتب صحّح فاتورة الساعة ١١ بالليل، النسبة بتتحرّك معاه.`}
          </p>
        </>
      )}
    </section>
  );
}

function TargetEditor({ row, label, repId, saving, canManage, onSave }: {
  row: TargetRow;
  label: string;
  repId: string | null;
  saving: string | null;
  canManage: boolean;
  onSave: (value: { revenue: string; invoices: string; note: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState({ revenue: row.target ? String(row.target) : '', invoices: row.invoiceTarget ? String(row.invoiceTarget) : '', note: row.note ?? '' });
  useEffect(() => { setValue({ revenue: row.target ? String(row.target) : '', invoices: row.invoiceTarget ? String(row.invoiceTarget) : '', note: row.note ?? '' }); }, [row.target, row.invoiceTarget, row.note]);
  const key = repId ?? 'company';
  return (
    <div className="panel">
      <h3 className="panel-title">
        {label}
        {!open && canManage && <button className="btn ghost sm" onClick={() => setOpen(true)}>{row.target ? 'تعديل الهدف' : 'تحديد هدف'}</button>}
      </h3>
      {open ? (
        <>
          <div className="two-col">
            <label className="field"><span>هدف البيع (ج.م)</span><input className="mono" value={value.revenue} onChange={event => setValue(v => ({ ...v, revenue: event.target.value }))} /></label>
            <label className="field"><span>عدد الفواتير (اختياري)</span><input className="mono" value={value.invoices} onChange={event => setValue(v => ({ ...v, invoices: event.target.value }))} /></label>
            <label className="field" style={{ gridColumn: '1 / -1' }}><span>ملاحظة على الهدف</span><input value={value.note} onChange={event => setValue(v => ({ ...v, note: event.target.value }))} /></label>
          </div>
          <div className="filters">
            <button className="btn primary sm" disabled={saving === key} onClick={() => { void onSave(value); setOpen(false); }}>{saving === key ? 'جارٍ الحفظ…' : 'حفظ الهدف'}</button>
            <button className="btn ghost sm" onClick={() => setOpen(false)}>إلغاء</button>
            <span className="muted small">{row.updatedBy ? `آخر تعديل: ${row.updatedBy} · ${row.updatedAt ? localDateText(row.updatedAt) : ''}` : 'لسه ما اتحدّدش'}</span>
          </div>
        </>
      ) : (
        <p className="muted small">
          {row.target ? `الهدف ${money(row.target)}` : 'مافيش هدف مسجل للشهر ده'}
          {row.invoiceTarget ? ` · ${formatNumber(row.invoiceTarget)} فاتورة` : ''}
          {row.note ? ` · ${row.note}` : ''}
        </p>
      )}
    </div>
  );
}
