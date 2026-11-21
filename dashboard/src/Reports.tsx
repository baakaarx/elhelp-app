import { useEffect, useMemo, useRef, useState } from 'react';
import { api, del, patch } from './api';
import { ago, downloadDailyReportPdf, durationText, formatNumber } from './session';
import { dateTimeText, formatClockArabic } from './dates';
import { reportTypeLabels, visitPurposeLabels, type DailyReport, type Rep, type Report, type Visit } from './types';
import ConfirmAction from './ConfirmAction';

type Tab = 'field' | 'daily' | 'visits';

/**
 * `version` is bumped by the shell whenever a report arrives (over the live socket, or by the
 * poll when the socket is down). Without it this screen loaded once and a manager watching it
 * never saw a report that came in while he was looking at it.
 */
export default function Reports({ reps, onReviewed, version = 0, timezone }: { reps: Rep[]; onReviewed: () => void; version?: number; timezone?: string }) {
  const [tab, setTab] = useState<Tab>('daily');
  const [reports, setReports] = useState<Report[]>([]);
  const [daily, setDaily] = useState<DailyReport[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [status, setStatus] = useState<'all' | 'new' | 'reviewed'>('all');
  const [visitStatus, setVisitStatus] = useState<'all' | 'open' | 'closed'>('all');
  const [repId, setRepId] = useState('all');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState<string | null>(null);
  const loadedOnce = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // A silent refresh of a list the manager is already reading: only the first load shows the
    // loading line, otherwise every incoming report would blank the screen for a moment.
    if (!loadedOnce.current) setLoading(true);
    setError('');
    Promise.all([
      api<{ reports: Report[] }>('/api/reports'),
      api<{ reports: DailyReport[] }>('/api/daily-reports'),
      api<{ visits: Visit[] }>('/api/visits'),
    ]).then(([field, dailyRes, visitsRes]) => {
      if (cancelled) return;
      setReports(field.reports);
      setDaily(dailyRes.reports);
      setVisits(visitsRes.visits);
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'تعذر تحميل التقارير.'); })
      .finally(() => { if (!cancelled) { loadedOnce.current = true; setLoading(false); } });
    return () => { cancelled = true; };
  }, [version]);

  const visibleReports = useMemo(() => reports.filter(r => (status === 'all' || r.status === status) && (repId === 'all' || r.userId === repId)), [reports, status, repId]);
  const visibleDaily = useMemo(() => daily.filter(r => (status === 'all' || r.status === status) && (repId === 'all' || r.userId === repId)), [daily, status, repId]);
  const visibleVisits = useMemo(() => visits.filter(v => (visitStatus === 'all' || v.status === visitStatus) && (repId === 'all' || v.userId === repId)), [visits, visitStatus, repId]);
  const pending = useMemo(() => [...reports, ...daily].filter(r => r.status === 'new').length, [reports, daily]);

  async function review(kind: 'field' | 'daily', id: string) {
    try {
      if (kind === 'field') {
        const res = await patch<{ report: Report }>(`/api/reports/${id}`, { status: 'reviewed' });
        setReports(list => list.map(r => (r.id === id ? res.report : r)));
      } else {
        const res = await patch<{ report: DailyReport }>(`/api/daily-reports/${id}`, { status: 'reviewed' });
        setDaily(list => list.map(r => (r.id === id ? res.report : r)));
      }
      onReviewed();
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحديث التقرير.'); }
  }
  /**
   * Remove a row from the register.
   *
   * Only the manager: a field record an engineer can delete himself is a field record he can
   * delete when it stops matching the story. The button therefore says what disappears (a signed
   * day, a visit with its GPS proof) instead of asking a generic «متأكد؟».
   */
  async function remove(kind: 'field' | 'daily' | 'visit', id: string) {
    try {
      if (kind === 'field') {
        await del(`/api/reports/${id}`);
        setReports(list => list.filter(row => row.id !== id));
      } else if (kind === 'daily') {
        await del(`/api/daily-reports/${id}`);
        setDaily(list => list.filter(row => row.id !== id));
      } else {
        await del(`/api/visits/${id}`);
        setVisits(list => list.filter(row => row.id !== id));
      }
      setError('');
      onReviewed();
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر الحذف.'); }
  }
  async function download(report: DailyReport) {
    setDownloading(report.id);
    // Chromium drops Arabic anchor filenames to a generic "download"; keep the PDF name portable.
    try { await downloadDailyReportPdf(report.id, `daily-report-${report.reportDate}.pdf`); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تنزيل الملف.'); }
    finally { setDownloading(null); }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>التقارير</h2>
          <p className="muted">تقارير الميدان والتقارير اليومية الموقّعة إلكترونيًا وزيارات الميدان من المهندسين.</p>
        </div>
        <span className="pill warn">{formatNumber(pending)} بانتظار المراجعة</span>
      </header>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'daily'} className={tab === 'daily' ? 'tab active' : 'tab'} onClick={() => setTab('daily')}>التقارير اليومية ({formatNumber(daily.length)})</button>
        <button role="tab" aria-selected={tab === 'field'} className={tab === 'field' ? 'tab active' : 'tab'} onClick={() => setTab('field')}>تقارير الميدان ({formatNumber(reports.length)})</button>
        <button role="tab" aria-selected={tab === 'visits'} className={tab === 'visits' ? 'tab active' : 'tab'} onClick={() => setTab('visits')}>الزيارات ({formatNumber(visits.length)})</button>
      </div>
      <div className="filters">
        <label className="field inline">
          <span>الحالة</span>
          {tab === 'visits' ? (
            <select value={visitStatus} onChange={e => setVisitStatus(e.target.value as typeof visitStatus)}>
              <option value="all">الكل</option>
              <option value="open">مفتوحة</option>
              <option value="closed">منتهية</option>
            </select>
          ) : (
            <select value={status} onChange={e => setStatus(e.target.value as typeof status)}>
              <option value="all">الكل</option>
              <option value="new">جديد</option>
              <option value="reviewed">تمت المراجعة</option>
            </select>
          )}
        </label>
        <label className="field inline">
          <span>المهندس</span>
          <select value={repId} onChange={e => setRepId(e.target.value)}>
            <option value="all">كل الفريق</option>
            {reps.map(rep => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
          </select>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      {loading ? <p className="muted">جارٍ التحميل…</p> : tab === 'daily' ? (
        visibleDaily.length === 0 ? <p className="empty">لا توجد تقارير يومية بهذه الفلاتر بعد.</p> : (
          <ul className="stack-list">
            {visibleDaily.map(report => (
              <li key={report.id} className="card report">
                <div className="report-head">
                  <span className="dot" style={{ background: report.repColor }} aria-hidden="true" />
                  <div className="grow">
                    <h3>{report.engineerName} <span className="muted small">· {report.dayName} {report.reportDate}</span></h3>
                    <p className="muted small">
                      {report.leftAt ? `خروج ${formatClockArabic(report.leftAt)}` : 'بدون وقت خروج'} · {report.returnedAt ? `عودة ${formatClockArabic(report.returnedAt)}` : 'بدون وقت عودة'} · {formatNumber(report.visits.length)} زيارة · {ago(report.createdAt)}
                    </p>
                  </div>
                  <span className={report.status === 'new' ? 'pill warn' : 'pill ok'}>{report.status === 'new' ? 'جديد' : 'تمت المراجعة'}</span>
                </div>
                <div className="visits">
                    <table>
                      <thead><tr><th>م</th><th>اسم العميل / المزرعة</th><th>المحافظة</th><th>المركز</th><th>القرية</th><th>الهاتف</th><th>الفدان</th><th>المحاصيل</th><th>التوصيات</th><th>النتيجة</th></tr></thead>
                      <tbody>
                        {report.visits.map(visit => (
                          <tr key={visit.id ?? visit.position}>
                            <td>{visit.position}</td><td>{visit.customerName}</td><td>{visit.governorate || '—'}</td><td>{visit.district || '—'}</td>
                            <td>{visit.village || '—'}</td><td dir="ltr">{visit.phone || '—'}</td><td>{visit.areaFeddan ?? '—'}</td><td>{visit.crops || '—'}</td>
                            <td>{visit.recommendations || '—'}</td><td>{visit.outcome || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="muted small">توقيع إلكتروني: {report.signedName} · {dateTimeText(report.signedAt, timezone)}</p>
                </div>
                <div className="report-actions">
                  <button className="btn ghost" disabled={downloading === report.id} onClick={() => download(report)}>{downloading === report.id ? 'جارٍ التجهيز…' : 'تنزيل PDF'}</button>
                  {report.status === 'new' && <button className="btn primary sm" onClick={() => review('daily', report.id)}>تمت المراجعة</button>}
                  <ConfirmAction label="حذف اليوم" confirmLabel="تأكيد حذف التقرير"
                    detail={`هيُحذف تقرير ${report.dayName} ${report.reportDate} بكل زياراته (${formatNumber(report.visits.length)}) وتوقيعه — السجل الشهري هيتراجع.`}
                    onConfirm={() => remove('daily', report.id)} />
                </div>
              </li>
            ))}
          </ul>
        )
      ) : tab === 'field' ? (
        visibleReports.length === 0 ? <p className="empty">لا توجد تقارير ميدان بهذه الفلاتر بعد.</p> : (
          <ul className="stack-list">
            {visibleReports.map(report => (
              <li key={report.id} className="card report">
                <div className="report-head">
                  <span className="dot" style={{ background: report.repColor }} aria-hidden="true" />
                  <div className="grow">
                    <h3>{report.title}</h3>
                    <p className="muted small">{report.repName} · {reportTypeLabels[report.type]} · {ago(report.createdAt)}{report.customer ? ` · ${report.customer}` : ''}{report.amount !== null ? ` · ${formatNumber(report.amount)} ج.م` : ''}</p>
                  </div>
                  <span className={report.status === 'new' ? 'pill warn' : 'pill ok'}>{report.status === 'new' ? 'جديد' : 'تمت المراجعة'}</span>
                </div>
                {report.body && <p className="body-text">{report.body}</p>}
                <div className="report-actions">
                  {report.lat !== null && report.lng !== null && (
                    <a className="btn ghost sm" href={`https://www.openstreetmap.org/?mlat=${report.lat}&mlon=${report.lng}#map=18/${report.lat}/${report.lng}`} target="_blank" rel="noreferrer">الموقع على الخريطة</a>
                  )}
                  {report.status === 'new' && <button className="btn primary sm" onClick={() => review('field', report.id)}>تمت المراجعة</button>}
                  <ConfirmAction label="حذف التقرير" confirmLabel="تأكيد حذف التقرير"
                    detail={`هيُحذف «${report.title}» لـ${report.repName} — بدون مراجعة لاحقة.`}
                    onConfirm={() => remove('field', report.id)} />
                </div>
              </li>
            ))}
          </ul>
        )
      ) : (
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
                    onConfirm={() => remove('visit', visit.id)} />
                </div>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}
