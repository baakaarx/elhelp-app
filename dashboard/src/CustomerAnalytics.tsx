import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { dateTimeText, timeText } from './dates';
import { formatNumber } from './session';
import SaleInvoice, { type Detail } from './SaleInvoice';

type CustomerRank = { id: string; name: string; phone: string; active: boolean; purchases: number; invoiceCount: number; rank: number | null; category: 'A' | 'B' | 'C' | 'D' | null };
type Ranking = { customers: CustomerRank[]; total: number; offset: number; limit: number; hasMore: boolean; updatedAt: number };
type Invoice = { id: string; invoiceNumber: number | null; original: number; paid: number; net: number; createdAt: number; corrected: boolean };
type CustomerDetail = { customer: CustomerRank; due: number; credit: number; hasOpening: boolean; invoices: Invoice[]; offset: number; hasMore: boolean; updatedAt: number };
const money = (n: number) => `${n.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م`;
const categoryText = (c: CustomerRank) => c.category ? `فئة ${c.category}` : 'بدون صافي مشتريات';

/** Read-only analysis: never derives a customer's debt from a chart or from field reports. */
export default function CustomerAnalytics({ requestedCustomer, timezone }: { requestedCustomer: { id: string; nonce: number } | null; timezone?: string }) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [ranking, setRanking] = useState<Ranking | null>(null);
  const [rankingError, setRankingError] = useState('');
  const [selected, setSelected] = useState('');
  const [invoicePage, setInvoicePage] = useState(0);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [invoice, setInvoice] = useState<Detail | null>(null);
  const [invoiceError, setInvoiceError] = useState('');
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const invoiceRequest = useRef(0);
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => { const timer = setTimeout(() => { setPage(0); setQuery(search.trim()); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    if (!requestedCustomer) return;
    invoiceRequest.current++; setInvoice(null); setInvoiceError(''); setInvoiceBusy(false);
    setDetail(null); setDetailError(''); setInvoicePage(0); setSelected(requestedCustomer.id); setRefresh(n => n + 1);
  }, [requestedCustomer]);
  useEffect(() => {
    let active = true, pending = false;
    setRanking(null); setRankingError('');
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const params = new URLSearchParams({ q: query, offset: String(page * 20) });
        const data = await api<Ranking>(`/api/sales/customer-ranking?${params}`);
        if (active) { setRanking(data); setRankingError(''); }
      } catch (e) { if (active) setRankingError(e instanceof Error ? e.message : 'تعذر تحميل التحليل.'); }
      finally { pending = false; }
    }
    void load(); const timer = setInterval(() => void load(), 15000);
    const onFocus = () => void load(); window.addEventListener('focus', onFocus);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [page, query, refresh]);
  useEffect(() => {
    if (!selected) return;
    let active = true, pending = false;
    setDetail(null); setDetailError('');
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const data = await api<CustomerDetail>(`/api/sales/customer-ranking/${encodeURIComponent(selected)}?offset=${invoicePage * 20}`);
        if (active) { setDetail(data); setDetailError(''); }
      } catch (e) { if (active) setDetailError(e instanceof Error ? e.message : 'تعذر تحميل حساب العميل.'); }
      finally { pending = false; }
    }
    void load(); const timer = setInterval(() => void load(), 15000);
    const onFocus = () => void load(); window.addEventListener('focus', onFocus);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [selected, invoicePage, refresh]);

  function selectCustomer(id: string) {
    invoiceRequest.current++; setInvoice(null); setInvoiceError(''); setInvoiceBusy(false);
    if (id !== selected) { setDetail(null); setDetailError(''); setInvoicePage(0); setSelected(id); }
    else if (invoicePage !== 0) setInvoicePage(0);
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }
  async function openInvoice(id: string) {
    const request = ++invoiceRequest.current; setInvoiceBusy(true); setInvoiceError(''); setInvoice(null);
    try {
      const result = await api<Detail>(`/api/sales/corrections/sale/${encodeURIComponent(id)}`);
      if (request === invoiceRequest.current) setInvoice(result);
    } catch (e) { if (request === invoiceRequest.current) setInvoiceError(e instanceof Error ? e.message : 'تعذر تحميل الفاتورة.'); }
    finally { if (request === invoiceRequest.current) setInvoiceBusy(false); }
  }

  const max = Math.max(0, ...(ranking?.customers.map(c => c.purchases) ?? []));
  return <section className="customer-analysis" aria-label="تحليل مشتريات العملاء">
    <div className="panel customer-chart-panel">
      <div className="customer-chart-head"><div><p className="customer-eyebrow">صورة مباشرة للعملاء</p><h3>مشتريات العملاء والفئات</h3><p className="muted small">صافي الفواتير المؤكدة بعد التصحيحات · كل الوقت · يتحدّث تلقائيًا تقريبًا كل ١٥ ثانية أثناء فتح الصفحة</p></div>
        <button type="button" className="btn ghost sm" onClick={() => setRefresh(n => n + 1)}>تحديث التحليل</button></div>
      <p className="customer-chart-explain">نرتّب العملاء المشترين من الأعلى للأقل ونقسمهم أربع مجموعات تقريبية: <b>A</b> الأعلى ثم <b>B</b> و<b>C</b> و<b>D</b>. المتساويون في المشتريات لهم نفس الفئة، والعميل بدون صافي مشتريات لا يُصنّف. يشمل الموقوفين للحفاظ على ترتيب التاريخ. التصنيف للتحليل فقط ولا يغيّر نوع سعر العميل.</p>
      <div className="customer-chart-toolbar"><label className="field inline"><span>بحث في الرسم</span><input value={search} onChange={e => setSearch(e.target.value)} placeholder="اسم العميل أو تليفونه" /></label>
        {ranking && <span className="muted small">{formatNumber(ranking.total)} عميل · آخر تحديث {timeText(ranking.updatedAt, timezone)}</span>}</div>
      {rankingError && <p className="error" role="alert">تعذر تحديث التحليل. {ranking ? 'الأرقام المعروضة قديمة؛ جرّب التحديث. ' : ''}{rankingError}</p>}
      {!ranking && !rankingError && <p role="status">جارٍ تحميل التحليل…</p>}
      {ranking && ranking.customers.length === 0 && <p className="empty">لا يوجد عملاء مطابقون للبحث.</p>}
      {ranking && ranking.customers.length > 0 && <><p className="muted small">اضغط على عمود العميل لعرض فواتيره وحسابه. ارتفاع الأعمدة مقارنة بأكبر مشتريات في الصفحة.</p>
        <div className="customer-chart-scroll"><div className="customer-bars" role="group" aria-label="رسم مشتريات العملاء">
          {ranking.customers.map(c => <button key={c.id} type="button" className={`customer-bar-item ${selected === c.id ? 'selected' : ''}`} onClick={() => selectCustomer(c.id)} aria-label={`عرض حساب ${c.name}، ${categoryText(c)}، مشتريات ${money(c.purchases)}`}>
            <span className="customer-bar-value">{money(c.purchases)}</span>
            <span className="customer-bar-track"><span className={`customer-bar-fill category-${c.category ?? 'none'}`} style={{ height: `${max > 0 ? Math.max(2, c.purchases / max * 100) : 2}%` }} /></span>
            <span className="customer-bar-name">{c.name}{!c.active && ' · موقوف'}</span><span className={`customer-category category-${c.category ?? 'none'}`}>{categoryText(c)}</span>
          </button>)}
        </div></div>
        {(page > 0 || ranking.hasMore) && <div className="filters"><button className="btn ghost sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>العملاء السابقون</button><span>صفحة {formatNumber(page + 1)}</span><button className="btn ghost sm" disabled={!ranking.hasMore} onClick={() => setPage(p => p + 1)}>العملاء التاليون</button></div>}</>}
    </div>
    {selected && <section className="panel customer-detail" ref={detailRef} tabIndex={-1} aria-label="تفاصيل العميل">
      <div className="customer-chart-head"><h3>حساب العميل وفواتيره</h3><button className="btn ghost sm" onClick={() => { invoiceRequest.current++; setSelected(''); setDetail(null); setInvoice(null); }}>إغلاق التفاصيل</button></div>
      {detailError && <p className="error" role="alert">تعذر تحديث الحساب. {detail ? 'الأرقام المعروضة قديمة؛ حدّث التحليل. ' : ''}{detailError}</p>}
      {!detail && !detailError && <p role="status">جارٍ تحميل حساب العميل…</p>}
      {detail && <><div className="customer-detail-title"><div><h3>{detail.customer.name} {!detail.customer.active && <span className="muted small">· موقوف</span>}</h3><span className="muted small">{detail.customer.phone || 'بدون تليفون'} · رقم {detail.customer.id.slice(-6)}</span></div><span className={`customer-category category-${detail.customer.category ?? 'none'}`}>{categoryText(detail.customer)}</span></div>
        <div className="customer-detail-stats"><div><span>صافي المشتريات المسجلة</span><strong>{money(detail.customer.purchases)}</strong></div><div><span>المديونية المسجلة الآن</span><strong>{money(detail.due)}</strong></div><div><span>عدد الفواتير</span><strong>{formatNumber(detail.customer.invoiceCount)}</strong></div>{detail.credit > 0 && <div><span>رصيد لصالح العميل</span><strong>{money(detail.credit)}</strong></div>}</div>
        {!detail.hasOpening && <p className="notice">المديونية القديمة لم تُسجّل لهذا العميل؛ المديونية الظاهرة قد لا تكون الرصيد الحقيقي.</p>}
        <p className="muted small">المشتريات صافي الفواتير بعد تصحيح الأصناف. المديونية تشمل الدفعات والرصيد القديم المسجل والتصحيحات؛ الطلبية وحدها ليست فاتورة.</p>
        <h4>فواتير العميل</h4>
        {detail.invoices.length === 0 ? <p className="muted">لا توجد فواتير في هذه الصفحة.</p> : <div className="kpi-table-wrap"><table className="kpi-table"><thead><tr><th>الفاتورة</th><th>التاريخ</th><th>القيمة الأصلية</th><th>بعد التصحيح</th><th></th></tr></thead><tbody>{detail.invoices.map(i => <tr key={i.id}><td>{i.invoiceNumber === null ? 'رقم غير متاح' : `رقم ${formatNumber(i.invoiceNumber)}`}{i.corrected && <small>عليها تصحيحات</small>}</td><td>{dateTimeText(i.createdAt, timezone)}</td><td>{money(i.original)}</td><td>{money(i.net)}</td><td><button type="button" className="btn ghost sm" disabled={invoiceBusy} onClick={() => void openInvoice(i.id)}>عرض الفاتورة</button></td></tr>)}</tbody></table></div>}
        {(invoicePage > 0 || detail.hasMore) && <div className="filters"><button className="btn ghost sm" disabled={invoicePage === 0} onClick={() => { invoiceRequest.current++; setInvoice(null); setInvoiceError(''); setInvoiceBusy(false); setInvoicePage(p => p - 1); }}>فواتير أحدث</button><span>صفحة {formatNumber(invoicePage + 1)}</span><button className="btn ghost sm" disabled={!detail.hasMore} onClick={() => { invoiceRequest.current++; setInvoice(null); setInvoiceError(''); setInvoiceBusy(false); setInvoicePage(p => p + 1); }}>فواتير أقدم</button></div>}
        {invoiceBusy && <p role="status">جارٍ تحميل الفاتورة…</p>}{invoiceError && <p className="error" role="alert">{invoiceError}</p>}
        {invoice && <SaleInvoice detail={invoice} timezone={timezone} onBack={() => setInvoice(null)} onRefresh={setInvoice} />}
      </>}
    </section>}
  </section>;
}
