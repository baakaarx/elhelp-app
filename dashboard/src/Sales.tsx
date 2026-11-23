import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, post } from './api';
import { ago, formatNumber } from './session';
import { dateTimeText, localDay } from './dates';
import type { Customer, Invoice, InvoiceLine, Product, Rep, SalesSummary, Warehouse } from './types';

/**
 * The sales office: what was sold, what it came to, and what is still owed.
 *
 * This is where an invoice is written. The engineer in the field never prices anything and never
 * edits one after the fact — the office types it, the server does the arithmetic, and the warehouse
 * is debounced by the same save. The three tables below are the same rows seen from the three
 * questions the office actually asks: who sold, what sold, and who has not paid.
 */
const STATUS_LABELS: Record<Invoice['status'], string> = { unpaid: 'غير محصلة', partial: 'جزئية', paid: 'محصّلة' };
const STATUS_TONE: Record<Invoice['status'], string> = { unpaid: 'error', partial: 'visit-marks', paid: 'muted small' };
const PERIODS = [{ days: 7, label: 'أسبوع' }, { days: 30, label: 'الشهر' }, { days: 90, label: '٣ شهور' }, { days: 365, label: 'السنة' }];
const money = (value: number) => `${formatNumber(value)} ج.م`;

interface LineDraft { productId: string; qty: string; unitPrice: string }
const emptyLine = (): LineDraft => ({ productId: '', qty: '', unitPrice: '' });

export default function Sales({ version = 0, canManageStaff = false }: { version?: number; canManageStaff?: boolean }) {
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [reps, setReps] = useState<Rep[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [period, setPeriod] = useState(30);
  const [repFilter, setRepFilter] = useState('all');
  const [warehouseFilter, setWarehouseFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [includeVoided, setIncludeVoided] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lines, setLines] = useState<InvoiceLine[] | null>(null);
  const [composing, setComposing] = useState(false);

  const refresh = useCallback(async () => {
    const to = Date.now();
    const from = to - period * 86400000;
    const scope = new URLSearchParams({ from: String(from), to: String(to) });
    if (repFilter !== 'all') scope.set('repId', repFilter);
    if (warehouseFilter !== 'all') scope.set('warehouseId', warehouseFilter);
    const list = new URLSearchParams({ limit: '120' });
    if (repFilter !== 'all') list.set('repId', repFilter);
    if (warehouseFilter !== 'all') list.set('warehouseId', warehouseFilter);
    if (statusFilter !== 'all') list.set('status', statusFilter);
    if (query.trim()) list.set('q', query.trim());
    if (includeVoided) list.set('includeVoided', '1');
    try {
      const [s, i] = await Promise.all([
        api<SalesSummary>(`/api/sales/summary?${scope}`),
        api<{ invoices: Invoice[] }>(`/api/invoices?${list}`),
      ]);
      setSummary(s); setInvoices(i.invoices); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل المبيعات.'); }
    finally { setLoaded(true); }
  }, [period, repFilter, warehouseFilter, statusFilter, query, includeVoided]);

  useEffect(() => { void refresh(); }, [refresh, version]);
  useEffect(() => {
    void Promise.all([
      api<{ reps: Rep[] }>('/api/reps'),
      api<{ warehouses: Warehouse[] }>('/api/warehouses'),
      api<{ products: Product[] }>('/api/products'),
    ]).then(([r, w, p]) => { setReps(r.reps); setWarehouses(w.warehouses); setProducts(p.products); }).catch(() => undefined);
  }, []);

  /** The lines are fetched when a row is opened, not for all hundred rows at once. */
  async function open(invoice: Invoice) {
    if (expanded === invoice.id) { setExpanded(null); setLines(null); return; }
    setExpanded(invoice.id); setLines(null);
    try { setLines((await api<{ lines: InvoiceLine[] }>(`/api/invoices/${invoice.id}`)).lines); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل سطور الفاتورة.'); setExpanded(null); }
  }

  const totals = summary?.totals;
  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>المبيعات</h2>
          <p className="muted">الفواتير بتتكتب من هنا: الأصناف والكمية والقيمة. الرقم النهائي يحسبه السيرفر، والخصم من المخزن يتم في نفس الحفظ.</p>
        </div>
        <button className="btn primary" onClick={() => setComposing(value => !value)}>{composing ? 'إلغاء الكتابة' : 'فاتورة جديدة'}</button>
      </header>

      <div className="filters">
        <label className="field inline">
          <span>الفترة</span>
          <select value={period} onChange={event => setPeriod(Number(event.target.value))}>
            {PERIODS.map(item => <option key={item.days} value={item.days}>{item.label}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>المهندس</span>
          <select value={repFilter} onChange={event => setRepFilter(event.target.value)}>
            <option value="all">الكل</option>
            {reps.map(rep => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>المخزن</span>
          <select value={warehouseFilter} onChange={event => setWarehouseFilter(event.target.value)}>
            <option value="all">كل المخازن</option>
            {warehouses.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span>السداد</span>
          <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
            <option value="all">الكل</option>
            <option value="unpaid">غير محصلة</option>
            <option value="partial">جزئية</option>
            <option value="paid">محصّلة</option>
          </select>
        </label>
        <label className="field inline">
          <span>دوّر</span>
          <input value={query} placeholder="رقم الفاتورة أو اسم العميل" onChange={event => setQuery(event.target.value)} />
        </label>
        <label className="field inline"><span>الملغاة</span>
          <input type="checkbox" checked={includeVoided} onChange={event => setIncludeVoided(event.target.checked)} style={{ width: 'auto' }} />
        </label>
        <button className="btn ghost sm" onClick={() => void refresh()}>تحديث</button>
      </div>

      {error && <p className="error banner" role="alert">{error}</p>}
      {!loaded ? <p className="muted">جارٍ التحميل…</p> : !totals ? <p className="error">مافيش بيانات.</p> : (
        <>
          <div className="stats">
            <div className="stat"><span className="label">إجمالي المبيعات</span><strong>{money(totals.total)}</strong><small>{formatNumber(totals.count)} فاتورة · {localDay()} وما قبلها {period} يوم</small></div>
            <div className="stat"><span className="label">المحصّل</span><strong>{money(totals.paid)}</strong><small>من {money(totals.total)}</small></div>
            <div className="stat"><span className="label">لسه على العملاء</span><strong>{money(totals.outstanding)}</strong><small>ده اللي بيدخل تقارير التحصيل</small></div>
            <div className="stat"><span className="label">متوسط الفاتورة</span><strong>{money(totals.averageInvoice)}</strong><small>{totals.stockShort ? `${formatNumber(totals.stockShort)} فاتورة على مخزن عاجز` : 'مفيش عجز مخزون'}</small></div>
          </div>

          {composing && <InvoiceComposer reps={reps} warehouses={warehouses} products={products} canManageStaff={canManageStaff} onDone={() => { setComposing(false); void refresh(); }} onError={setError} />}

          <div className="two-col">
            <div className="panel">
              <h3 className="panel-title">كل مهندس بيبيع بكام</h3>
              {summary.byRep.length === 0 ? <p className="empty">مافيش فواتير في الفترة دي.</p> : (
                <div className="kpi-table-wrap">
                  <table className="kpi-table">
                    <thead><tr><th>المهندس</th><th>فواتير</th><th>باع</th><th>المحصّل</th><th>لسه</th></tr></thead>
                    <tbody>
                      {summary.byRep.map(row => (
                        <tr key={row.repId ?? 'none'}>
                          <td><span className="dot" style={{ background: row.repColor }} aria-hidden="true" /> {row.repName}</td>
                          <td className="mono">{formatNumber(row.invoices)}</td>
                          <td className="mono"><strong>{money(row.total)}</strong></td>
                          <td className="mono">{money(row.paid)}</td>
                          <td className={row.outstanding > 0 ? 'visit-marks' : 'muted small'}>{money(row.outstanding)}{row.openInvoices ? ` · ${formatNumber(row.openInvoices)} فاتورة مفتوحة` : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="panel">
              <h3 className="panel-title">الأكثر مبيعًا</h3>
              {summary.topProducts.length === 0 ? <p className="empty">مافيش أصناف اتباعت في الفترة دي.</p> : (
                <div className="kpi-table-wrap">
                  <table className="kpi-table">
                    <thead><tr><th>الصنف</th><th>الكمية</th><th>القيمة</th></tr></thead>
                    <tbody>
                      {summary.topProducts.map((row, index) => (
                        <tr key={row.productId ?? `${row.productName}-${index}`}>
                          <td>{row.productName}</td>
                          <td className="mono">{formatNumber(row.qty)} {row.unit}</td>
                          <td className="mono"><strong>{money(row.revenue)}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <h3 className="panel-title">الفواتير</h3>
            {invoices.length === 0 ? <p className="empty">مافيش فواتير بالفلاتر دي.</p> : (
              <ul className="stack-list">
                {invoices.map(invoice => (
                  <li key={invoice.id} className="card report" style={invoice.voided ? { opacity: 0.55 } : undefined}>
                    <div className="report-head">
                      <span className="dot" style={{ background: invoice.repColor }} aria-hidden="true" />
                      <div className="grow">
                        <h3>
                          <button className="btn ghost sm" onClick={() => void open(invoice)} style={{ padding: 0, border: 'none', fontFamily: 'inherit', fontSize: 'inherit' }}>{invoice.customerName}</button>
                          {invoice.voided && <span className="muted small"> · ملغاة</span>}
                          {invoice.stockShort && !invoice.voided && <span className="visit-marks"> · مخزن عاجز</span>}
                        </h3>
                        <p className="muted small">
                          <span className="mono">{invoice.number ?? '—'}</span> · {invoice.repName} · {invoice.warehouseName} · {dateTimeText(invoice.invoiceDate)}
                          {invoice.lineCount ? ` · ${formatNumber(invoice.lineCount)} سطر` : ''}
                        </p>
                        <p className={STATUS_TONE[invoice.status]}>
                          {money(invoice.total)} · {STATUS_LABELS[invoice.status]}
                          {invoice.paidAmount > 0 && invoice.status !== 'paid' ? ` (اتدفّع ${money(invoice.paidAmount)})` : ''}
                          {invoice.discount ? ` · خصم ${money(invoice.discount)}` : ''}
                          {invoice.note ? ` · ${invoice.note}` : ''}
                          {invoice.voided && invoice.voidReason ? ` · سبب الإلغاء: ${invoice.voidReason}` : ''}
                        </p>
                      </div>
                      <span className={`pill ${invoice.status === 'paid' ? 'ok' : invoice.status === 'partial' ? 'warn' : 'warn'}`}>{ago(invoice.createdAt)}</span>
                    </div>
                    {expanded === invoice.id && (
                      <div className="selected-summary">
                        {lines === null ? <p className="muted small">جارٍ التحميل…</p> : (
                          <table className="kpi-table">
                            <thead><tr><th>الصنف</th><th>كمية</th><th>السعر</th><th>الإجمالي</th></tr></thead>
                            <tbody>
                              {lines.map(line => (
                                <tr key={line.id}>
                                  <td>{line.productName} <span className="muted small">{line.unit}</span></td>
                                  <td className="mono">{formatNumber(line.qty)}</td>
                                  <td className="mono">{money(line.unitPrice)}</td>
                                  <td className="mono">{money(line.lineTotal)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {!invoice.voided && <PaymentRow invoice={invoice} onDone={() => void refresh()} onError={setError} />}
                      </div>
                    )}
                    {!invoice.voided && (
                      <div className="report-actions">
                        <VoidButton invoice={invoice} onDone={() => void refresh()} onError={setError} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">الفاتورة ما بتتحذفش — تلغى بسبب، والكمية ترجع للمخزن. ترقيم الفواتير من السيرفر: INV-السنة-رقم.</p>
          </div>

          {summary.balances.length > 0 && (
            <div className="panel">
              <h3 className="panel-title">أعلى مديونيات</h3>
              <div className="kpi-table-wrap">
                <table className="kpi-table">
                  <thead><tr><th>العميل</th><th>عليه</th><th>فواتير</th><th>آخر فاتورة</th></tr></thead>
                  <tbody>
                    {summary.balances.map(row => (
                      <tr key={row.customerId ?? row.customerName}>
                        <td>{row.customerName}</td>
                        <td className="mono error"><strong>{money(row.outstanding)}</strong></td>
                        <td className="mono">{formatNumber(row.invoices)}</td>
                        <td className="muted small">{row.lastInvoiceAt ? dateTimeText(row.lastInvoiceAt) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Collecting money is the only edit an invoice accepts after it is written. */
function PaymentRow({ invoice, onDone, onError }: { invoice: Invoice; onDone: () => void; onError: (message: string) => void }) {
  const [amount, setAmount] = useState(String(invoice.paidAmount || ''));
  const [busy, setBusy] = useState(false);
  const due = Math.max(0, invoice.total - invoice.paidAmount);
  return (
    <div className="filters">
      <label className="field inline">
        <span>المسدد (ج.م)</span>
        <input className="mono" style={{ width: 110 }} value={amount} onChange={event => setAmount(event.target.value)} />
      </label>
      <button
        className="btn primary sm" disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await post(`/api/invoices/${invoice.id}`, { paidAmount: Number(amount || 0) });
            onDone();
          } catch (e) { onError(e instanceof Error ? e.message : 'تعذر تسجيل التحصيل.'); }
          finally { setBusy(false); }
        }}
      >سجّل التحصيل</button>
      <span className="muted small">المتبقي {money(due)} — لو المسدد وصل للإجمالي الفاتورة تتقفل لوحدها.</span>
    </div>
  );
}

function VoidButton({ invoice, onDone, onError }: { invoice: Invoice; onDone: () => void; onError: (message: string) => void }) {
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) return <button className="btn ghost sm" onClick={() => setAsking(true)}>إلغاء الفاتورة</button>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input placeholder="السبب (مطلوب)" value={reason} onChange={event => setReason(event.target.value)} />
      <button
        className="btn danger sm" disabled={busy || reason.trim().length < 2}
        onClick={async () => {
          setBusy(true);
          try { await post(`/api/invoices/${invoice.id}/void`, { reason: reason.trim() }); onDone(); }
          catch (e) { onError(e instanceof Error ? e.message : 'تعذر إلغاء الفاتورة.'); }
          finally { setBusy(false); setAsking(false); setReason(''); }
        }}
      >تأكيد الإلغاء</button>
      <button className="btn ghost sm" onClick={() => setAsking(false)}>تراجع</button>
      <span className="muted small">الكمية هترجع للمخزن.</span>
    </span>
  );
}

/**
 * Writing an invoice.
 *
 * The totals shown while typing are only a preview: the server adds the same numbers up again and
 * keeps its own answer. Two rules are enforced here because they are the two that would otherwise
 * be argued about later — the customer decides which engineer the sale belongs to, and a product's
 * price comes from the catalogue unless somebody here overwrites it on purpose.
 */
function InvoiceComposer({ reps, warehouses, products, canManageStaff, onDone, onError }: {
  reps: Rep[];
  warehouses: Warehouse[];
  products: Product[];
  canManageStaff: boolean;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [repId, setRepId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  /** Stock figures for the warehouse this invoice will draw on — not the global total. */
  const [localProducts, setLocalProducts] = useState<Product[]>([]);
  const [draftLines, setDraftLines] = useState<LineDraft[]>([emptyLine()]);
  const [discount, setDiscount] = useState('');
  const [paidAmount, setPaidAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!repId) { setCustomers([]); return; }
    api<{ customers: Customer[] }>(`/api/customers?repId=${repId}`).then(res => setCustomers(res.customers)).catch(e => onError(e instanceof Error ? e.message : 'تعذر تحميل قائمة العملاء.'));
  }, [repId, onError]);

  // The «short» warning has to be about the warehouse the truck will leave from: forty bags in
  // برج العرب says nothing about whether the store this order will be filled from can cover it.
  useEffect(() => {
    if (!warehouseId) { setLocalProducts(products); return; }
    let ignored = false;
    api<{ products: Product[] }>(`/api/products?warehouseId=${warehouseId}`)
      .then(res => { if (!ignored) setLocalProducts(res.products); })
      .catch(() => { if (!ignored) setLocalProducts(products); });
    return () => { ignored = true; };
  }, [warehouseId, products]);

  useEffect(() => { if (!warehouseId && warehouses[0]) setWarehouseId(warehouses[0].id); }, [warehouses, warehouseId]);

  const resolved = draftLines
    .map(line => {
      const product = localProducts.find(item => item.id === line.productId) ?? products.find(item => item.id === line.productId);
      const qty = Number(line.qty || 0);
      const unitPrice = line.unitPrice === '' ? Number(product?.defaultPrice ?? 0) : Number(line.unitPrice);
      return product && qty > 0 ? { productId: product.id, qty, unitPrice, lineTotal: Math.round(qty * unitPrice * 100) / 100, name: product.name } : null;
    })
    .filter(Boolean) as { productId: string; qty: number; unitPrice: number; lineTotal: number; name: string }[];
  const subtotal = Math.round(resolved.reduce((sum, line) => sum + line.lineTotal, 0) * 100) / 100;
  const total = Math.max(0, subtotal - Number(discount || 0));
  // A product nobody has received yet has no figure to break: it is un-counted, not out of stock.
  // Only a shelf that was actually measured can be called short, otherwise a fresh catalogue would
  // scream a warning on every invoice until somebody types the first receipt.
  const shortLines = resolved.filter(line => {
    const product = localProducts.find(item => item.id === line.productId);
    return product ? product.lastMovementAt !== null && line.qty > product.onHand : false;
  });

  async function submit() {
    if (!customerId || !warehouseId || resolved.length === 0) { onError('اختار العميل والمخزن وسطر واحد فيه كمية على الأقل.'); return; }
    setBusy(true);
    try {
      const res = await post<{ invoice: Invoice; stockShort: boolean }>('/api/invoices', {
        customerId, warehouseId, lines: resolved.map(line => ({ productId: line.productId, qty: line.qty, unitPrice: line.unitPrice })),
        discount: Number(discount || 0), paidAmount: Number(paidAmount || 0), note: note.trim(),
      });
      if (res.stockShort) onError('الفاتورة اتسجلت، بس المخزن هيفضل بالسالب لحد الجرد — سجّلها في تبويب المخازن.');
      onDone();
    } catch (e) { onError(e instanceof Error ? e.message : 'تعذر حفظ الفاتورة.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <h3 className="panel-title">فاتورة جديدة</h3>
      <div className="two-col">
        <label className="field">
          <span>المهندس</span>
          <select value={repId} onChange={event => { setRepId(event.target.value); setCustomerId(''); }}>
            <option value="">اختار المهندس…</option>
            {reps.map(rep => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>العميل</span>
          <select value={customerId} onChange={event => setCustomerId(event.target.value)} disabled={!repId}>
            <option value="">{repId ? 'اختار من قائمة عملاء المهندس…' : 'اختار المهندس الأول'}</option>
            {customers.map(item => <option key={item.id} value={item.id}>{item.name} ({item.visitCount} زيارة)</option>)}
          </select>
        </label>
        <label className="field">
          <span>المخزن اللي هيصرف</span>
          <select value={warehouseId} onChange={event => setWarehouseId(event.target.value)}>
            <option value="">اختار المخزن…</option>
            {warehouses.filter(item => item.active).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>تاريخ الفاتورة</span>
          <input value={localDay()} readOnly className="mono" />
        </label>
      </div>

      <table className="kpi-table">
        <thead><tr><th>الصنف</th><th>كمية</th><th>السعر</th><th>الإجمالي</th><th></th></tr></thead>
        <tbody>
          {draftLines.map((line, index) => {
            const product = products.find(item => item.id === line.productId);
            return (
              <tr key={index}>
                <td>
                  <select value={line.productId} onChange={event => setDraftLines(list => list.map((item, at) => (at === index ? { ...item, productId: event.target.value, unitPrice: String(products.find(p => p.id === event.target.value)?.defaultPrice ?? '') } : item)))}>
                    <option value="">—</option>
                    {products.filter(item => item.active).map(item => <option key={item.id} value={item.id}>{item.name} ({formatNumber(item.defaultPrice)} ج.م)</option>)}
                  </select>
                </td>
                <td><input className="mono" style={{ width: 70 }} value={line.qty} onChange={event => setDraftLines(list => list.map((item, at) => (at === index ? { ...item, qty: event.target.value } : item)))} /></td>
                <td><input className="mono" style={{ width: 80 }} value={line.unitPrice} onChange={event => setDraftLines(list => list.map((item, at) => (at === index ? { ...item, unitPrice: event.target.value } : item)))} /></td>
                <td className="mono">{product ? `${formatNumber(Math.round(Number(line.qty || 0) * Number(line.unitPrice || product.defaultPrice) * 100) / 100)} ج.م` : '—'}</td>
                <td>
                  <button className="btn ghost sm" onClick={() => setDraftLines(list => (list.length > 1 ? list.filter((_, at) => at !== index) : [emptyLine()]))}>شيل</button>
                  {index === draftLines.length - 1 && <button className="btn ghost sm" onClick={() => setDraftLines(list => [...list, emptyLine()])}>+ سطر</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="two-col">
        <label className="field"><span>خصم (ج.م)</span><input className="mono" value={discount} onChange={event => setDiscount(event.target.value)} /></label>
        <label className="field"><span>مسدد دلوقتي (ج.م)</span><input className="mono" value={paidAmount} onChange={event => setPaidAmount(event.target.value)} /></label>
        <label className="field" style={{ gridColumn: '1 / -1' }}><span>ملاحظة على الفاتورة</span><input value={note} onChange={event => setNote(event.target.value)} /></label>
      </div>

      <p className="muted small">
        {canManageStaff ? 'الفاتورة تتنسب لمهندس العميل؛ تغيير النسبة للمدير وحده.' : 'الفاتورة تتنسب لمهندس العميل.'}
        {' · '}الإجمالي <strong className="mono">{money(total)}</strong>{subtotal !== total ? ` (بعد خصم ${money(Number(discount || 0))})` : ''}
      </p>
      {shortLines.length > 0 && (
        <p className="visit-marks">
          {shortLines.map(line => line.name).join(' · ')} — الكمية أكتر من المتاح. الفاتورة هتتسجل والمخزن يفضل بالسالب لحد ما يتجر.
        </p>
      )}
      <div className="filters">
        <button className="btn primary" disabled={busy || !customerId || !warehouseId || resolved.length === 0} onClick={() => void submit()}>{busy ? 'جارٍ الحفظ…' : 'حفظ الفاتورة وخصم المخزن'}</button>
      </div>
    </div>
  );
}
