import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, post } from './api';
import { dateTimeText } from './dates';
import { ago, formatNumber } from './session';

/**
 * الطلبيات — the queue the field feeds and this screen closes.
 *
 * One order has two authors, and the dashboard is where the second half gets written. The engineer
 * sent customer + items + quantities; nothing on his side ever carried a number, and nothing that
 * happens here travels back as one — the office adds prices and stamps the order closed. That is
 * the whole loop the workflow asked for: an order arrives, the tab lights up, the team opens it,
 * prices it, and the row locks itself.
 *
 * Pricing is deliberately one press per order: opening an order shows the lines with the customer's
 * own list price already typed into each box, and ختم التسعير either takes every line (with the
 * tier it came from recorded, when the number matches the list) or says out loud which line is still
 * empty. «باليد» is what happens for a customer with no price type — the box starts empty, and a
 * number typed there stays the office's own, without a tier pretending to vouch for it.
 */
export interface OrderLine {
  productId: string;
  productName: string;
  unit: string;
  unitSize: string;
  qty: number;
  notes: string;
  price?: number | null;
  tierId?: string | null;
  suggestedPrice?: number | null;
}
export interface OrderRow {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  visitId: string | null;
  status: 'draft' | 'sent' | 'priced';
  notes: string;
  recordedOffline: boolean;
  createdAt: number;
  sentAt: number | null;
  repName: string;
  repColor: string;
  total: number | null;
  pricedAt: number | null;
  pricedByName: string | null;
  customerTierId: string | null;
  customerTierName: string;
  lines: OrderLine[];
}

type Filter = 'sent' | 'priced' | 'all';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'sent', label: 'مستنية التسعير' },
  { id: 'priced', label: 'متسعّرة' },
  { id: 'all', label: 'الكل' },
];

function messageOf(e: unknown, fallback: string) {
  if (e instanceof ApiError && e.message) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}
/** Money is the one place the dashboard may keep decimals — integers in, kuruş-style out, no rounding of a price. */
const money = (value: number) => `${value.toLocaleString('ar-EG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ج.م`;
const parsePrice = (text: string) => {
  const normalized = text.trim().replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/[٫,]/g, '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value <= 1_000_000_000 ? value : null;
};
const quantity = (value: number) => value.toLocaleString('ar-EG', { maximumFractionDigits: 20 });
const lineSummary = (order: OrderRow) => order.lines
  .map(line => `${quantity(line.qty)} ${line.unit}${line.unitSize ? ` ${line.unitSize}` : ''} ${line.productName}`)
  .join(' · ');

export default function Orders({ timezone, version, onDone }: { timezone?: string; version: number; onDone: () => void }) {
  const [filter, setFilter] = useState<Filter>('sent');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const requestId = useRef(0);
  const pageSize = 100;
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState('');
  // Typed prices live per (order, product) until the stamp lands; closing an order resets its sheet.
  const [typed, setTyped] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const request = ++requestId.current;
    setError('');
    try {
      const res = await api<{ orders: OrderRow[]; hasMore: boolean }>(`/api/orders?${filter === 'all' ? '' : `status=${filter}&`}limit=${pageSize}&offset=${offset}`);
      if (request === requestId.current) { setOrders(res.orders); setHasMore(res.hasMore); }
    } catch (e) {
      if (request === requestId.current) setError(messageOf(e, 'تعذر تحميل الطلبيات.'));
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [filter, offset]);
  useEffect(() => { void load(); return () => { requestId.current++; }; }, [load, version]);

  const priceOf = useCallback((order: OrderRow, line: OrderLine) => {
    const typedValue = typed[order.id]?.[line.productId];
    if (typedValue !== undefined) return typedValue;
    if (order.status === 'priced' && typeof line.price === 'number') return String(line.price);
    return line.suggestedPrice === null || line.suggestedPrice === undefined ? '' : String(line.suggestedPrice);
  }, [typed]);

  const openOrder = orders.find(order => order.id === openId) ?? null;
  const openPlan = useMemo(() => {
    if (!openOrder || openOrder.status !== 'sent') return null;
    const missing = openOrder.lines.filter(line => parsePrice(priceOf(openOrder, line)) === null).map(line => line.productName);
    const total = openOrder.lines.reduce((sum, line) => sum + (parsePrice(priceOf(openOrder, line)) ?? 0) * line.qty, 0);
    return { missing, total: Math.round(total * 100) / 100 };
  }, [openOrder, priceOf]);

  async function stampClosed(order: OrderRow) {
    if (order.lines.some(line => parsePrice(priceOf(order, line)) === null)) {
      setError('اكتب سعر صحيح لكل صنف قبل ختم الطلبية.');
      return;
    }
    const lines = order.lines.map(line => {
      const price = parsePrice(priceOf(order, line))!;
      const edit: { productId: string; price: number; tierId?: string } = { productId: line.productId, price };
      // A number that equals this customer's list price came from the list — say so on the line, so
      // «ليه السعر ده؟» has an answer. A typed-over number is the office's own and keeps no tier.
      if (order.customerTierId && price !== null && price === line.suggestedPrice) edit.tierId = order.customerTierId;
      return edit;
    });
    setBusy(order.id);
    setError('');
    try {
      await post(`/api/orders/${order.id}/price`, { lines });
      setOpenId('');
      setTyped(values => { const next = { ...values }; delete next[order.id]; return next; });
      onDone();
      await load();
    } catch (e) {
      setError(messageOf(e, 'تعذر ختم التسعير.'));
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="panel orders-panel">
      <h2 className="panel-title">الطلبيات</h2>
      <div className="tabs" role="tablist">
        {FILTERS.map(item => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            className={filter === item.id ? 'tab active' : 'tab'}
            onClick={() => { if (filter !== item.id) { setOffset(0); setOpenId(''); setFilter(item.id); setLoading(true); } }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {loading ? (
        <p className="empty">جارٍ تحميل الطابور…</p>
      ) : orders.length === 0 ? (
        <p className="empty">
          {filter === 'sent'
            ? 'مفيش طلبية مستنية التسعير — أول ما مندوب يبعث واحدة من الموبايل هتظهر هنا على طول.'
            : 'مفيش طلبيات مسجلة لحد دلوقتي.'}
        </p>
      ) : (
        <div className="kpi-table-wrap orders-table">
          <table className="kpi-table">
            <thead>
              <tr><th>العميل</th><th>من</th><th>الأصناف والكميات</th><th>المبلغ</th><th>الحالة</th><th></th></tr>
            </thead>
            <tbody>
              {orders.map(order => {
                const open = openId === order.id;
                return (
                  <Fragment key={order.id}>
                    <tr className={open ? 'row-open' : undefined}>
                      <td>
                        <strong>{order.customerName}</strong>
                        {order.customerPhone ? <small className="muted">{order.customerPhone}</small> : null}
                        {order.notes ? <small className="muted">ملاحظة المندوب: {order.notes}</small> : null}
                      </td>
                      <td>
                        <span className="pill" style={{ opacity: 1 }}>
                          <span className="dot" style={{ background: order.repColor }} aria-hidden="true" /> {order.repName}
                        </span>
                        <small className="muted">
                          {order.sentAt ? `${ago(order.sentAt)}${order.recordedOffline ? ' · اتبعتت لما الشبكة رجعت' : ''}` : 'لسه مسودة على التليفون'}
                        </small>
                      </td>
                      <td><small className="mono">{lineSummary(order)}</small></td>
                      <td className="mono">
                        {order.status === 'priced' && order.total !== null
                          ? <strong>{money(order.total)}</strong>
                          : order.status === 'sent' && open && openPlan
                            ? <>{money(openPlan.total)} {openPlan.missing.length ? <span className="muted small">· {formatNumber(openPlan.missing.length)} من غير سعر</span> : <span className="muted small">· جاهز</span>}</>
                            : <span className="pill warn">لسه من غير مبلغ</span>}
                      </td>
                      <td>
                        {order.status === 'priced'
                          ? <span className="pill ok">اتقفلت · {order.pricedByName ?? 'المكتب'} · {order.pricedAt ? dateTimeText(order.pricedAt, timezone) : ''}</span>
                          : order.status === 'sent'
                            ? <span className="pill warn">مستنية التسعير</span>
                            : <span className="pill">مسودة عند المندوب</span>}
                      </td>
                      <td>
                        <button
                          className={open ? 'btn ghost sm' : order.status === 'sent' ? 'btn primary sm' : 'btn ghost sm'}
                          onClick={() => { setOpenId(open ? '' : order.id); setError(''); }}
                        >
                          {open ? 'قفل الورقة' : order.status === 'sent' ? 'افتح للتسعير' : 'عرض السطور'}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="order-lines-row">
                        <td colSpan={6}>
                          <div className="stack">
                            <p className="muted small">
                              نوع سعر العميل: {order.customerTierName
                                ? `«${order.customerTierName}» — اللي بيوافق اللوحة بيتقفل بالنوع، واللي يتعدّل عليه بيتسجّل باليد`
                                : 'من غير تحديد — التسعير باليد، ومفيش نوع يرتبط بيه السطر'}
                            </p>
                            {order.lines.map(line => (
                              <div className="order-line" key={line.productId}>
                                <span className="grow">
                                  <strong>{line.productName}</strong>
                                  <small className="muted">
                                    {quantity(line.qty)} × {line.unit}{line.unitSize ? ` (${line.unitSize})` : ''}
                                    {line.notes ? ` · ${line.notes}` : ''}
                                  </small>
                                </span>
                                {order.status === 'priced' ? (
                                  <span className="mono">{typeof line.price === 'number' ? `${money(line.price)}${line.tierId ? '' : ' باليد'}` : '—'}</span>
                                ) : (
                                  <label className="price-field">
                                    <span>سعر الوحدة</span>
                                    <input
                                      className="price-input mono"
                                      inputMode="decimal"
                                      value={priceOf(order, line)}
                                      onChange={event => {
                                        const value = event.target.value;
                                        setTyped(prev => ({ ...prev, [order.id]: { ...(prev[order.id] ?? {}), [line.productId]: value } }));
                                      }}
                                      placeholder={line.suggestedPrice == null ? 'باليد' : ''}
                                      aria-label={`سعر ${line.productName}`}
                                    />
                                  </label>
                                )}
                              </div>
                            ))}
                            {order.status === 'sent' && openPlan && (
                              <div className="confirm-pair">
                                <button className="btn primary sm" disabled={busy !== '' || openPlan.missing.length > 0} onClick={() => void stampClosed(order)}>
                                  {busy === order.id ? 'جارٍ الختم…' : `ختم التسعير · ${money(openPlan.total)}`}
                                </button>
                                <button className="btn ghost sm" disabled={busy !== ''} onClick={() => { setOpenId(''); setError(''); }}>رجوع</button>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {(offset > 0 || hasMore) && <div className="confirm-pair" aria-label="صفحات الطلبيات">
        <button className="btn ghost sm" disabled={loading || offset === 0} onClick={() => { setLoading(true); setOpenId(''); setOffset(Math.max(0, offset - pageSize)); }}>السابق</button>
        <span className="muted small">صفحة {formatNumber(Math.floor(offset / pageSize) + 1)}</span>
        <button className="btn ghost sm" disabled={loading || !hasMore} onClick={() => { setLoading(true); setOpenId(''); setOffset(offset + pageSize); }}>التالي</button>
      </div>}
      <p className="muted small">
        المهندس ما بيشوفش الأسعار. بعد ختم التسعير الطلبية بتتقفل، ولو فيها غلطة بلّغ المسؤول.
      </p>
    </section>
  );
}
