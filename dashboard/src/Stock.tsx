import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, patch, post } from './api';
import { ago, formatNumber } from './session';
import { dateTimeText, localDay } from './dates';
import type { Product, StockMovement, StockReport, StockRow, Warehouse } from './types';

/**
 * The warehouses — the only screen a stock account is given.
 *
 * Two jobs happen here and they are the two the sales floor cannot do for itself: the catalogue
 * (what a product is called and what it costs) and the level of what is on the shelf. There is no
 * editable «quantity in stock» field anywhere in this screen, and that is the point: the number is
 * always the sum of the movements below it, so a correction is a row with a name and a time on it
 * instead of a number somebody typed over the truth.
 */
const MOVEMENT_KINDS = [
  { id: 'receipt', label: 'استلام (بضاعة دخلت)' },
  { id: 'return', label: 'مرتجع من عميل' },
  { id: 'writeoff', label: 'خصم / تالف' },
  { id: 'count', label: 'جرد — الرصيد يبقى كذا' },
] as const;
const KIND_LABELS: Record<StockMovement['kind'], string> = {
  opening: 'رصيد ابتداي', receipt: 'استلام', sale: 'صرف بفاتورة', return: 'مرتجع', count: 'جرد', writeoff: 'خصم / تالف',
};
const emptyProduct = { name: '', unit: 'كرتونة', defaultPrice: '', notes: '' };
const emptyWarehouse = { name: '', governorate: '', district: '', notes: '' };

export default function Stock({ readOnly = false, canCorrect = false, version = 0 }: { readOnly?: boolean; canCorrect?: boolean; version?: number }) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [rows, setRows] = useState<StockRow[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [warehouseId, setWarehouseId] = useState('all');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [showAllProducts, setShowAllProducts] = useState(false);
  const [productForm, setProductForm] = useState(emptyProduct);
  const [addingProduct, setAddingProduct] = useState(false);
  const [priceEdit, setPriceEdit] = useState<{ id: string; price: string } | null>(null);
  // The warehouse is part of the movement, not a filter above it. It used to be only the filter — so
  // with «كل المخازن» showing, a receipt silently went to whichever store came first in the list,
  // which is exactly how a shelf ends up wrong in two places at once.
  const [moveForm, setMoveForm] = useState({ productId: '', warehouseId: '', qty: '', kind: 'receipt' as (typeof MOVEMENT_KINDS)[number]['id'], note: '', dated: false, date: '' });
  const [movementError, setMovementError] = useState('');
  const [period, setPeriod] = useState('this-month');
  const [report, setReport] = useState<StockReport | null>(null);
  const [busy, setBusy] = useState(false);

/**
   * The month the statement covers. «this month» and «last month» are calendar months rather than
   * «the last 30 days» because a warehouse statement is read against the paper one, and a period
   * that moves every day cannot be compared to a month that does not.
   */
  const window = useMemo(() => {
    const now = new Date();
    const day = 86400000;
    const start = (y: number, m: number) => new Date(y, m, 1, 0, 0, 0, 0).getTime();
    if (period === 'this-month') return { from: start(now.getFullYear(), now.getMonth()), to: now.getTime() };
    if (period === 'last-month') return { from: start(now.getFullYear(), now.getMonth() - 1), to: start(now.getFullYear(), now.getMonth()) - 1 };
    if (period === 'year') return { from: start(now.getFullYear(), 0), to: now.getTime() };
    if (period === '60') return { from: now.getTime() - 60 * day, to: now.getTime() };
    return { from: now.getTime() - 30 * day, to: now.getTime() };
  }, [period]);

  const refresh = useCallback(async () => {
    const scope = warehouseId === 'all' ? '' : `?warehouseId=${warehouseId}`;
    try {
      const [w, p, s, m] = await Promise.all([
        api<{ warehouses: Warehouse[] }>('/api/warehouses?includeInactive=1'),
        api<{ products: Product[] }>('/api/products?includeInactive=1'),
        api<{ rows: StockRow[] }>(`/api/stock${scope}`),
        api<{ movements: StockMovement[] }>(`/api/stock/movements${scope ? `${scope}&limit=60` : '?limit=60'}`),
      ]);
      setWarehouses(w.warehouses);
      setProducts(p.products);
      setRows(s.rows);
      setMovements(m.movements);
      setError('');
      const reportQuery = new URLSearchParams({ from: String(window.from), to: String(window.to) });
      if (warehouseId !== 'all') reportQuery.set('warehouseId', warehouseId);
      const statement = await api<StockReport>(`/api/stock/report?${reportQuery}`).catch(() => null);
      setReport(statement);
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل بيانات المخازن.'); }
    finally { setLoaded(true); }
  }, [warehouseId, window]);
  useEffect(() => { void refresh(); }, [refresh, version]);

  const onHandFor = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.productId, (map.get(row.productId) || 0) + row.onHand);
    return map;
  }, [rows]);
  const visibleProducts = useMemo(() => {
    const list = showAllProducts ? products : products.filter(product => product.active);
    // The warehouse selector is a filter on the stock figure, not on the catalogue: a product nobody
    // has received yet still has to be priced, or the first invoice for it cannot be written.
    return list.map(product => ({ ...product, onHand: warehouseId === 'all'
      ? product.onHand
      : (rows.find(row => row.productId === product.id && row.warehouseId === warehouseId)?.onHand ?? 0) }));
  }, [products, showAllProducts, warehouseId, rows]);
  const negative = useMemo(() => rows.filter(row => row.onHand < 0), [rows]);
  const activeWarehouses = useMemo(() => warehouses.filter(item => item.active), [warehouses]);
  // Whatever the screen is already looking at is the sensible default for the form; «all» is not a
  // warehouse, so the form falls back to the only store there is rather than a random first row.
  const suggestedWarehouse = warehouseId !== 'all' ? warehouseId
    : activeWarehouses.length === 1 ? activeWarehouses[0].id : '';
  const movementWarehouse = moveForm.warehouseId || suggestedWarehouse;
  useEffect(() => { setMoveForm(form => ({ ...form, warehouseId: '' })); }, [warehouseId]);

  async function saveProduct() {
    if (productForm.name.trim().length < 2) { setError('اكتب اسم المنتج.'); return; }
    setBusy(true);
    try {
      await post('/api/products', {
        name: productForm.name.trim(), unit: productForm.unit.trim() || 'كرتونة',
        defaultPrice: Number(productForm.defaultPrice || 0), notes: productForm.notes.trim(),
      });
      setProductForm(emptyProduct); setAddingProduct(false); setError('');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة المنتج.'); }
    finally { setBusy(false); }
  }

  async function savePrice(product: Product) {
    if (!priceEdit) return;
    setBusy(true);
    try {
      await patch(`/api/products/${product.id}`, { defaultPrice: Number(priceEdit.price || 0) });
      setPriceEdit(null); setError('');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تعديل السعر.'); }
    finally { setBusy(false); }
  }

  async function toggleProduct(product: Product) {
    try { await patch(`/api/products/${product.id}`, { active: !product.active }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تغيير حالة الصنف.'); }
  }

  async function saveMovement() {
    if (!moveForm.productId || !Number(moveForm.qty)) { setMovementError('اختار الصنف واكتب الكمية.'); return; }
    if (!movementWarehouse) {
      setMovementError('اختار المخزن الأول — الحركة لازم تنسب لمخزن واحد، ومش من العدل أخمنه إنت.');
      return;
    }
    if (moveForm.dated && !moveForm.date) { setMovementError('اكتب تاريخ الحركة، أو سيّب الصندوق متلغّي.'); return; }
    setBusy(true);
    try {
      await post('/api/stock/movements', {
        productId: moveForm.productId, warehouseId: movementWarehouse,
        kind: moveForm.kind, qty: Number(moveForm.qty), note: moveForm.note.trim(),
        // A dated row is the manager's correction for a truck that was typed late; the server puts it
        // on the day it happened, which is what keeps «الفاتح» in the monthly statement honest.
        ...(moveForm.dated ? { at: new Date(`${moveForm.date}T12:00:00`).getTime() } : {}),
      });
      setMoveForm(form => ({ ...form, qty: '', note: '', dated: false, date: '' })); setMovementError(''); setError('');
      await refresh();
    } catch (e) { setMovementError(e instanceof Error ? e.message : 'تعذر تسجيل الحركة.'); }
    finally { setBusy(false); }
  }

  async function saveWarehouse(body: { name: string; governorate: string; district: string; notes: string }) {
    try { await post('/api/warehouses', body); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة المخزن.'); }
  }

  async function toggleWarehouse(warehouse: Warehouse) {
    try { await patch(`/api/warehouses/${warehouse.id}`, { active: !warehouse.active }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تغيير حالة المخزن.'); }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>المخازن</h2>
          <p className="muted">الأصناف وأسعارها، وفاضل قد إيه في كل مخزن. الرصيد ناتج حركة، مش رقم بيتكتب.</p>
        </div>
        <div className="filters">
          <label className="field inline">
            <span>المخزن</span>
            <select value={warehouseId} onChange={event => setWarehouseId(event.target.value)}>
              <option value="all">كل المخازن</option>
              {warehouses.map(item => <option key={item.id} value={item.id}>{item.name}{item.active ? '' : ' (متوقف)'}</option>)}
            </select>
          </label>
          <button className="btn ghost sm" onClick={() => void refresh()}>تحديث</button>
        </div>
      </header>

      {error && <p className="error banner" role="alert">{error}</p>}
      {readOnly && (
        <p className="muted small">الحساب ده بيشوف المخازن ويقارنها، بس التسعير وتسجيل الحركات لحساب المخازن — أو للمدير لو فيه تصحيح مستعجل.</p>
      )}
      {readOnly && (
        <p className="muted small">
          الحساب ده بيشوف المخازن ويقارنها، بس التسعير وتسجيل الحركات لحساب المخازن — أو للمدير لو فيه تصحيح مستعجل.
        </p>
      )}

      {negative.length > 0 && (
        <p className="error banner" role="alert">
          {formatNumber(negative.length)} صنف رصيده بالسالب — البضاعة خرجت أكتر من المسجل. الجرد هيظبط، بس الفاتورة ما تتلغاش.
        </p>
      )}

      <div className="panel">
        <h3 className="panel-title">فاضل قد إيه</h3>
        {!loaded ? <p className="muted">جارٍ التحميل…</p> : rows.length === 0 ? (
          <p className="empty">مفيش حركة مسجلة لحد دلوقتي — سجّل استلام أو جرد عشان يظهر رصيد.</p>
        ) : (
          <div className="kpi-table-wrap">
            <table className="kpi-table">
              <thead>
                <tr><th>الصنف</th><th>المخزن</th><th>الرصيده</th><th>سعر الوحدة</th><th>آخر حركة</th></tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={`${row.warehouseId}:${row.productId}`}>
                    <td>{row.productName} <span className="muted small">/ {row.unit}</span></td>
                    <td>{row.warehouseName}</td>
                    <td className={row.low ? 'error' : ''}>
                      <strong className="mono">{formatNumber(row.onHand)}</strong> {row.unit}
                    </td>
                    <td className="mono">{formatNumber(row.price)} ج.م</td>
                    <td className="muted small">{row.lastMovementAt ? ago(row.lastMovementAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h3 className="panel-title">
          سجل المخزن الشهري
          <label className="field inline">
            <span>الفترة</span>
            <select value={period} onChange={event => setPeriod(event.target.value)}>
              <option value="this-month">الشهر ده</option>
              <option value="last-month">الشهر اللي فات</option>
              <option value="30">آخر ٣٠ يوم</option>
              <option value="60">آخر ٦٠ يوم</option>
              <option value="year">السنة دي</option>
            </select>
          </label>
        </h3>
        <p className="muted small">
          {localDay(undefined, window.from)} → {localDay(undefined, window.to)} · «الفاتح» هو مجموع كل الحركة اللي قبل الفترة، مش رقم فاكره حد.
          {report && !report.valuesVisible ? ' — الحساب ده بيشوف الكميات بس؛ القيمة على المكتب.' : ''}
        </p>
        {!report ? <p className="muted">جارٍ التحميل…</p> : report.rows.length === 0 ? (
          <p className="empty">مافيش حركة في الفترة دي — الرصيد اللي فوق هو اللي من قبلها.</p>
        ) : (
          <>
            <div className="kpi-table-wrap">
              <table className="kpi-table">
                <thead>
                  <tr>
                    <th>المخزن</th><th>الصنف</th><th>الفاتح</th><th>داخل</th><th>خارج</th><th>تسويات</th><th>الرصيده</th>
                    {report.valuesVisible ? <th>قيمة المخزون</th> : <th>عدد الحركات</th>}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map(row => (
                    <tr key={`${row.warehouseId}:${row.productId}`}>
                      <td className="muted small">{row.warehouseName || '—'}</td>
                      <td>{row.productName} <span className="muted small">/ {row.unit}</span></td>
                      <td className="mono">{formatNumber(row.opening)}</td>
                      <td className="mono ok-text">+{formatNumber(row.inQty)}</td>
                      <td className="mono error">−{formatNumber(row.outQty)}</td>
                      <td className="mono">{row.adjustments ? `${row.adjustments > 0 ? '+' : ''}${formatNumber(row.adjustments)}` : '—'}</td>
                      <td className={row.closing < 0 ? 'mono error' : 'mono'}><strong>{formatNumber(row.closing)}</strong></td>
                      {report.valuesVisible
                        ? <td className="mono">{formatNumber(row.closingValue ?? 0)} ج.م</td>
                        : <td className="muted small">{formatNumber(row.movements)} حركة</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">
              {report.valuesVisible
                ? `الإجمالي: داخل ${formatNumber(report.totals.inValue ?? 0)} ج.م · خارج ${formatNumber(report.totals.outValue ?? 0)} ج.م · قيمة اللي على الرفوف ${formatNumber(report.totals.closingValue ?? 0)} ج.م (بسعر النهاردة).`
                : `الإجمالي: داخل ${formatNumber(report.totals.inQty ?? 0)} · خارج ${formatNumber(report.totals.outQty ?? 0)} وحدة.`}
            </p>
            <details className="panel">
              <summary className="panel-title">كشف العمليات ({formatNumber(report.ledger.length)}{report.truncated ? ' — آخر ٤٠٠ بس' : ''})</summary>
              <div className="kpi-table-wrap">
                <table className="kpi-table">
                  <thead><tr><th>التاريخ</th><th>العملية</th><th>الصنف</th><th>المخزن</th><th>الكمية</th>{report.valuesVisible && <th>القيمة</th>}<th>مين عملها</th></tr></thead>
                  <tbody>
                    {report.ledger.map(item => (
                      <tr key={item.id}>
                        <td className="muted small">{dateTimeText(item.createdAt)}</td>
                        <td>{KIND_LABELS[item.kind] || item.kind}</td>
                        <td>{item.productName}</td>
                        <td className="muted small">{item.warehouseName || '—'}</td>
                        <td className={`mono ${item.qty < 0 ? 'error' : 'ok-text'}`}>{item.qty > 0 ? '+' : ''}{formatNumber(item.qty)}</td>
                        {report.valuesVisible && <td className="mono">{formatNumber(item.value ?? 0)} ج.م</td>}
                        <td className="muted small">{item.by || '—'}{item.invoiceNumber ? ` · ${item.invoiceNumber}` : ''}{item.note ? ` · ${item.note}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </div>

      <div className="two-col">
        <div className="panel">
          <h3 className="panel-title">
            الأصناف
            <button className="btn ghost sm" onClick={() => setShowAllProducts(value => !value)}>{showAllProducts ? 'المتوقفة مختفية' : 'اعرض المتوقف'}</button>
          </h3>
          {products.length === 0 ? <p className="empty">لسه مافيش أصناف — ضيف أول صنف بالسعر.</p> : (
            <ul className="stack-list">
              {visibleProducts.map(product => (
                <li key={product.id} className="card report" style={product.active ? undefined : { opacity: 0.6 }}>
                  <div className="report-head">
                    <div className="grow">
                      <h3>{product.name} {!product.active && <span className="muted small">· متوقف</span>}</h3>
                      <p className="muted small">
                        الوحدة: {product.unit} · سعر الوحدة {formatNumber(product.defaultPrice)} ج.م · {formatNumber(product.soldLines)} سطر فاتورة
                        {product.notes ? ` · ${product.notes}` : ''}
                      </p>
                      <p className={onHandFor.get(product.id) ? 'muted small' : 'visit-marks'}>
                        متاح {warehouseId === 'all' ? 'في كل المخازن' : `في «${warehouses.find(item => item.id === warehouseId)?.name}»`}: {formatNumber(product.onHand)} {product.unit}
                      </p>
                    </div>
                    {!readOnly && (priceEdit?.id === product.id ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input className="mono" style={{ width: 90 }} value={priceEdit.price} onChange={event => setPriceEdit({ id: product.id, price: event.target.value })} />
                        <button className="btn primary sm" disabled={busy} onClick={() => void savePrice(product)}>سعر</button>
                        <button className="btn ghost sm" onClick={() => setPriceEdit(null)}>إلغاء</button>
                      </span>
                    ) : (
                      <div className="report-actions">
                        <button className="btn ghost sm" onClick={() => setPriceEdit({ id: product.id, price: String(product.defaultPrice) })}>عدّل سعر الوحدة</button>
                        <button className="btn ghost sm" onClick={() => void toggleProduct(product)}>{product.active ? 'إيقاف' : 'تفعيل'}</button>
                      </div>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {!readOnly && (addingProduct ? (
            <div className="panel">
              <h4 className="panel-title">صنف جديد</h4>
              <div className="two-col">
                <label className="field"><span>اسم الصنف</span><input value={productForm.name} onChange={event => setProductForm(f => ({ ...f, name: event.target.value }))} /></label>
                <label className="field"><span>الوحدة</span><input value={productForm.unit} onChange={event => setProductForm(f => ({ ...f, unit: event.target.value }))} /></label>
                <label className="field">
                  <span>سعر الوحدة (ج.م){productForm.unit.trim() ? ` لكل ${productForm.unit.trim()}` : ''}</span>
                  <input className="mono" value={productForm.defaultPrice} onChange={event => setProductForm(f => ({ ...f, defaultPrice: event.target.value }))} />
                </label>
                <label className="field"><span>ملاحظة</span><input value={productForm.notes} onChange={event => setProductForm(f => ({ ...f, notes: event.target.value }))} /></label>
              </div>
              <p className="muted small">
                السعر دا سعر الوحدة اللي فوقها، مش الإجمالي. الفاتورة بتضربه في الكمية: {formatNumber(Number(productForm.defaultPrice || 0))} × ٣ {productForm.unit.trim() || 'كراتين'} = {formatNumber(Number(productForm.defaultPrice || 0) * 3)} ج.م.
                لو عايز تسعّر الشيكارة لوحدها، اكتب الوحدة «شيكارة» بدل الكرتونة.
              </p>
              <div className="filters">
                <button className="btn primary sm" disabled={busy} onClick={() => void saveProduct()}>{busy ? 'جارٍ الحفظ…' : 'حفظ الصنف'}</button>
                <button className="btn ghost sm" onClick={() => { setAddingProduct(false); setProductForm(emptyProduct); }}>إلغاء</button>
              </div>
            </div>
          ) : <button className="btn ghost sm" onClick={() => setAddingProduct(true)}>+ صنف جديد</button>)}
        </div>

        <div className="panel">
          <h3 className="panel-title">حركة المخزن</h3>
          {!readOnly && (
            <div className="two-col">
              <label className="field">
                <span>الصنف</span>
                <select value={moveForm.productId} onChange={event => setMoveForm(f => ({ ...f, productId: event.target.value }))}>
                  <option value="">اختار…</option>
                  {products.filter(item => item.active).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label className="field">
                <span>المخزن</span>
                <select value={movementWarehouse} onChange={event => setMoveForm(form => ({ ...form, warehouseId: event.target.value }))}>
                  <option value="">{activeWarehouses.length ? 'اختار المخزن…' : 'مافيش مخزن شغال — ضيف مخزن الأول'}</option>
                  {activeWarehouses.map(item => <option key={item.id} value={item.id}>{item.name}{item.governorate ? ` — ${item.governorate}` : ''}</option>)}
                </select>
              </label>
              <label className="field">
                <span>الحركة</span>
                <select value={moveForm.kind} onChange={event => setMoveForm(f => ({ ...f, kind: event.target.value as typeof moveForm.kind }))}>
                  {MOVEMENT_KINDS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              <label className="field">
                <span>{moveForm.kind === 'count' ? 'الرصيده بعد الجرد' : 'الكمية'}</span>
                <input className="mono" value={moveForm.qty} onChange={event => setMoveForm(f => ({ ...f, qty: event.target.value }))} />
              </label>
              <label className="field"><span>ملاحظة</span><input value={moveForm.note} onChange={event => setMoveForm(f => ({ ...f, note: event.target.value }))} /></label>
              {/* Manager only — the server refuses a backdate from any other account, and a dated count
                  is refused outright, because «the level that day was X» cannot be honoured against
                  today's figure. */}
              {!readOnly && canCorrect && (
                <label className="field inline">
                  <span>تصحيح بتاريخ قديم</span>
                  <input type="checkbox" checked={moveForm.dated} style={{ width: 'auto' }}
                    onChange={event => setMoveForm(f => ({ ...f, dated: event.target.checked, date: event.target.checked ? localDay() : '' }))} />
                  {moveForm.dated && <input type="date" lang="ar-EG" value={moveForm.date} onChange={event => setMoveForm(f => ({ ...f, date: event.target.value }))} />}
                </label>
              )}
            </div>
          )}
          {!readOnly && (
              <div className="filters">
              <button className="btn primary sm" disabled={busy || !movementWarehouse} onClick={() => void saveMovement()}>سجّل الحركة</button>
              <span className="muted small">
                {movementError
                  ? <span className="error">{movementError}</span>
                  : movementWarehouse ? `هتتنفّذ على «${warehouses.find(item => item.id === movementWarehouse)?.name}»` : 'اختار المخزن عشان الزر يشتغل.'}
              </span>
            </div>
          )}
          {movements.length === 0 ? <p className="empty">مفيش حركات.</p> : (
            <div className="kpi-table-wrap">
              <table className="kpi-table">
                <thead><tr><th>الحركة</th><th>الصنف</th><th>المخزن</th><th>الكمية</th><th>بتاع</th></tr></thead>
                <tbody>
                  {movements.map(item => (
                    <tr key={item.id}>
                      <td>{KIND_LABELS[item.kind] || item.kind}</td>
                      <td>{item.productName}</td>
                      <td className="muted small">{item.warehouseName}</td>
                      <td className={`mono ${item.qty < 0 ? 'error' : ''}`}>{item.qty > 0 ? '+' : ''}{formatNumber(item.qty)}</td>
                      <td className="muted small">{item.by} · {ago(item.createdAt)}{item.invoiceNumber ? ` · ${item.invoiceNumber}` : ''}{item.note ? ` · ${item.note}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <WarehousePanel warehouses={warehouses} readOnly={readOnly} onSave={saveWarehouse} onToggle={toggleWarehouse} />
    </section>
  );
}

function WarehousePanel({ warehouses, readOnly, onSave, onToggle }: {
  warehouses: Warehouse[];
  readOnly: boolean;
  onSave: (body: { name: string; governorate: string; district: string; notes: string }) => Promise<void>;
  onToggle: (warehouse: Warehouse) => Promise<void>;
}) {
  const [form, setForm] = useState(emptyWarehouse);
  const [open, setOpen] = useState(false);
  return (
    <div className="panel">
      <h3 className="panel-title">
        المخازن ({formatNumber(warehouses.length)})
        {!readOnly && <button className="btn ghost sm" onClick={() => setOpen(value => !value)}>{open ? 'إلغاء' : '+ مخزن جديد'}</button>}
      </h3>
      <p className="muted small">مخزن لكل منطقة. المخزن اللي عليه فواتير ما بيتحذفش — يتوقف بس، عشان الفاتورة يفضل لها مصدر.</p>
      {open && (
        <div className="two-col">
          <label className="field"><span>اسم المخزن</span><input value={form.name} onChange={event => setForm(f => ({ ...f, name: event.target.value }))} /></label>
          <label className="field"><span>المحافظة</span><input value={form.governorate} onChange={event => setForm(f => ({ ...f, governorate: event.target.value }))} /></label>
          <label className="field"><span>المركز</span><input value={form.district} onChange={event => setForm(f => ({ ...f, district: event.target.value }))} /></label>
          <label className="field"><span>ملاحظة</span><input value={form.notes} onChange={event => setForm(f => ({ ...f, notes: event.target.value }))} /></label>
          <div className="filters">
            <button className="btn primary sm" disabled={form.name.trim().length < 2} onClick={() => { void onSave({ ...form, name: form.name.trim() }); setForm(emptyWarehouse); setOpen(false); }}>حفظ</button>
          </div>
        </div>
      )}
      <ul className="stack-list">
        {warehouses.map(item => (
          <li key={item.id} className="card report" style={item.active ? undefined : { opacity: 0.6 }}>
            <div className="report-head">
              <div className="grow">
                <h3>{item.name} {!item.active && <span className="muted small">· متوقف</span>}</h3>
                <p className="muted small">
                  {[item.governorate, item.district].filter(Boolean).join(' · ') || 'من غير منطقة'}
                  {' · '}{formatNumber(item.productCount)} صنف عليه حركة · {formatNumber(item.invoiceCount)} فاتورة
                </p>
              </div>
              {!readOnly && <div className="report-actions"><button className="btn ghost sm" onClick={() => void onToggle(item)}>{item.active ? 'إيقاف' : 'تفعيل'}</button></div>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
