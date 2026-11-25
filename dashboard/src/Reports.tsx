import { useEffect, useMemo, useState } from 'react';
import { api, del } from './api';
import { durationText, formatNumber } from './session';
import { dateTimeText } from './dates';
import { visitPurposeLabels, type Rep, type Visit } from './types';
import ConfirmAction from './ConfirmAction';
import Orders from './Orders';

export default function Reports({ reps, onReviewed, version = 0, ordersVersion = 0, sentOrders = 0, timezone }: { reps: Rep[]; onReviewed: () => void; version?: number; ordersVersion?: number; sentOrders?: number; timezone?: string }) {
  const [tab, setTab] = useState<'visits' | 'orders'>('visits');
  const [visits, setVisits] = useState<Visit[]>([]);
  const [visitStatus, setVisitStatus] = useState<'all' | 'open' | 'closed'>('all');
  const [repId, setRepId] = useState('all');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    api<{ visits: Visit[] }>('/api/visits').then(res => { if (!cancelled) { setVisits(res.visits); setError(''); } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'تعذر تحميل الزيارات.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [version]);
  const visibleVisits = useMemo(() => visits.filter(v => (visitStatus === 'all' || v.status === visitStatus) && (repId === 'all' || v.userId === repId)), [visits, visitStatus, repId]);
  async function remove(id: string) {
    try { await del(`/api/visits/${id}`); setVisits(list => list.filter(row => row.id !== id)); setError(''); onReviewed(); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر حذف الزيارة.'); }
  }
  return <section className="page">
    <header className="page-head"><div><h2>الزيارات والطلبيات</h2><p className="muted">زيارات المهندسين والطلبيات المرسلة للمكتب.</p></div>
      {sentOrders > 0 && <span className="pill warn">{formatNumber(sentOrders)} طلبية مستنية التسعير</span>}</header>
    <div className="tabs" role="tablist">
      <button role="tab" aria-selected={tab === 'visits'} className={tab === 'visits' ? 'tab active' : 'tab'} onClick={() => setTab('visits')}>الزيارات ({formatNumber(visits.length)})</button>
      <button role="tab" aria-selected={tab === 'orders'} className={tab === 'orders' ? 'tab active' : 'tab'} onClick={() => setTab('orders')}>الطلبيات{sentOrders > 0 ? ` (${formatNumber(sentOrders)} مستنية)` : ''}</button>
    </div>
    {tab === 'orders' ? <Orders timezone={timezone} version={ordersVersion} onDone={onReviewed} /> : <>
      <div className="filters">
        <label className="field inline"><span>الحالة</span><select value={visitStatus} onChange={e => setVisitStatus(e.target.value as typeof visitStatus)}><option value="all">الكل</option><option value="open">مفتوحة</option><option value="closed">منتهية</option></select></label>
        <label className="field inline"><span>المهندس</span><select value={repId} onChange={e => setRepId(e.target.value)}><option value="all">كل الفريق</option>{reps.map(rep => <option key={rep.id} value={rep.id}>{rep.name}</option>)}</select></label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {loading ? <p className="muted">جارٍ التحميل…</p> : (
        visibleVisits.length === 0 ? <p className="empty">لا توجد زيارات بهذه الفلاتر بعد.</p> : (
          <ul className="stack-list">
            {visibleVisits.map(visit => (
              <li key={visit.id} className="card report">
                <div className="report-head">
                  <span className="dot" style={{ background: visit.repColor }} aria-hidden="true" />
                  <div className="grow">
                    <h3>{visit.customerName} <span className="muted small">· {visit.repName}</span></h3>
                    <p className="muted small">
                      {visitPurposeLabels[visit.purpose]} · دخول {dateTimeText(visit.checkedInAt, timezone)}
                      {visit.checkedOutAt ? ` · خروج ${dateTimeText(visit.checkedOutAt, timezone)}` : ' · مفتوحة'}
                      {visit.durationSeconds !== null ? ` · ${durationText(visit.durationSeconds)}` : ''}
                      {visit.autoClosed ? ' · أُغلقت تلقائيًا' : ''}
                    </p>
                  </div>
                  <span className={visit.status === 'open' ? 'pill warn' : 'pill ok'}>{visit.status === 'open' ? 'مفتوحة' : 'منتهية'}</span>
                </div>
                <div className="visits">
                  <table>
                    <thead><tr><th>المحافظة</th><th>المركز</th><th>القرية</th><th>الهاتف</th><th>النتيجة</th><th>ملاحظات</th></tr></thead>
                    <tbody>
                      <tr>
                        <td>{visit.governorate || '—'}</td><td>{visit.district || '—'}</td><td>{visit.village || '—'}</td>
                        <td dir="ltr">{visit.phone || '—'}</td><td>{visit.outcome || '—'}</td><td>{visit.notes || '—'}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {(visit.recordedOffline || visit.pendingResult) && (
                  <p className="visit-marks">
                    {visit.recordedOffline ? 'من غير شبكة' : ''}
                    {visit.recordedOffline && visit.pendingResult ? ' · ' : ''}
                    {visit.pendingResult ? 'بدون نتيجة' : ''}
                  </p>
                )}
                <div className="report-actions">
                  <ConfirmAction label="حذف الزيارة" confirmLabel="تأكيد حذف الزيارة"
                    detail={visit.status === 'open'
                      ? `زيارة ${visit.customerName} لسه مفتوحة — حذفها يحرّر ${visit.repName} يسجّل الزيارة الجاية.`
                      : `هيُحذف تسجيل «${visit.customerName}» بدليل موقعه من السجل، مش هيتقفل بس.`}
                    onConfirm={() => remove(visit.id)} />
                </div>
              </li>
            ))}
          </ul>
        )
      )}
    </>}
  </section>;
}
