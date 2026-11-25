import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, patch, post } from './api';

type Warehouse = { id:string; name:string };
type Stock = { id:string; name:string; category:string; unit:string; unitSize:string; active:boolean; qty:number|null };
type Movement = { id:string; kind:'opening'|'in'|'out'|'transfer'; productName:string; qty:number; unit:string; fromName:string|null; toName:string|null; actorName:string; note:string; createdAt:number };
const labels = { opening:'رصيد افتتاحي', in:'إضافة', out:'صرف', transfer:'نقل' } as const;
const parseQty = (value:string) => Number(value.trim().replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace('٫','.'));

export default function Warehouses() {
  const [warehouses,setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId,setWarehouseId] = useState('');
  const [stock,setStock] = useState<Stock[]>([]);
  const [movements,setMovements] = useState<Movement[]>([]);
  const [newWarehouse,setNewWarehouse] = useState('');
  const [editing,setEditing] = useState<Stock|null>(null);
  const [editName,setEditName] = useState('');
  const [editCategory,setEditCategory] = useState('other');
  const [editUnit,setEditUnit] = useState('');
  const [editUnitSize,setEditUnitSize] = useState('');
  const [productName,setProductName] = useState('');
  const [unit,setUnit] = useState('');
  const [unitSize,setUnitSize] = useState('');
  const [category,setCategory] = useState('other');
  const [kind,setKind] = useState<Movement['kind']>('opening');
  const [productId,setProductId] = useState('');
  const [destination,setDestination] = useState('');
  const [qty,setQty] = useState('');
  const [note,setNote] = useState('');
  const [message,setMessage] = useState('');
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const requestId = useRef('');
  const loadWarehouses = useCallback(async () => {
    const result = await api<{warehouses:Warehouse[]}>('/api/warehouse/warehouses');
    setWarehouses(result.warehouses);
    setWarehouseId(current => current || result.warehouses[0]?.id || '');
  }, []);
  const loadStock = useCallback(async () => {
    if (!warehouseId) { setStock([]); setMovements([]); return; }
    const [s,m] = await Promise.all([
      api<{stock:Stock[]}>(`/api/warehouse/stock?warehouseId=${encodeURIComponent(warehouseId)}`),
      api<{movements:Movement[]}>(`/api/warehouse/movements?warehouseId=${encodeURIComponent(warehouseId)}`),
    ]);
    setStock(s.stock); setMovements(m.movements);
  }, [warehouseId]);
  useEffect(() => { void loadWarehouses().catch(e => setError(e.message)); }, [loadWarehouses]);
  useEffect(() => { let cancelled = false; if (!warehouseId) { setStock([]); setMovements([]); return; }
    Promise.all([api<{stock:Stock[]}>(`/api/warehouse/stock?warehouseId=${encodeURIComponent(warehouseId)}`),api<{movements:Movement[]}>(`/api/warehouse/movements?warehouseId=${encodeURIComponent(warehouseId)}`)])
      .then(([s,m]) => { if (!cancelled) { setStock(s.stock); setMovements(m.movements); } })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [warehouseId]);
  async function perform(task:()=>Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : 'تعذر الحفظ.'); } finally { setBusy(false); }
  }
  async function addWarehouse(event:FormEvent) {
    event.preventDefault(); await perform(async () => {
      const r = await post<{warehouse:Warehouse}>('/api/warehouse/warehouses',{name:newWarehouse});
      setNewWarehouse(''); await loadWarehouses(); setWarehouseId(r.warehouse.id); setMessage('المخزن اتضاف.');
    });
  }
  async function addProduct(event:FormEvent) {
    event.preventDefault(); await perform(async () => {
      await post('/api/warehouse/products',{name:productName,category,unit,unitSize});
      setProductName(''); setUnit(''); setUnitSize(''); await loadStock(); setMessage('الصنف اتضاف؛ سجّل رصيده الافتتاحي في كل مخزن.');
    });
  }
  async function submitMovement(event:FormEvent) {
    event.preventDefault();
    if (!qty.trim() || !Number.isFinite(parseQty(qty))) { setError('اكتب كمية صحيحة.'); return; }
    await perform(async () => {
      const body = { id:requestId.current || (requestId.current = crypto.randomUUID()),kind,productId,qty:parseQty(qty),note,
        ...(kind === 'opening' || kind === 'in' ? {toWarehouseId:warehouseId} : {fromWarehouseId:warehouseId}),
        ...(kind === 'transfer' ? {toWarehouseId:destination} : {}) };
      await post('/api/warehouse/movements',body);
      requestId.current = ''; setQty(''); setNote(''); await loadStock(); setMessage('الحركة اتحفظت.');
    });
  }
  const resetRequest = () => { requestId.current = ''; };
  return <section className="page">
    <header className="page-head"><div><h2>المخازن والأصناف</h2><p className="muted">لكل مخزن رصيد مستقل. سجّل الرصيد الافتتاحي قبل الإضافة أو الصرف أو النقل.</p></div></header>
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="ok-text" role="status">{message}</p>}
    <div className="panel">
      <form className="filters" onSubmit={addWarehouse}><label className="field inline"><span>اسم مخزن جديد</span><input value={newWarehouse} onChange={e=>setNewWarehouse(e.target.value)} minLength={2} maxLength={120} required /></label><button className="btn primary sm" disabled={busy}>إضافة مخزن</button></form>
      <label className="field inline"><span>المخزن</span><select disabled={busy} value={warehouseId} onChange={e=>{setWarehouseId(e.target.value); setProductId(''); setStock([]); setMovements([]); resetRequest();}}><option value="">اختار مخزن</option>{warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
    </div>
    <div className="panel"><h3>إضافة صنف</h3><form className="filters" onSubmit={addProduct}>
      <label className="field inline"><span>اسم الصنف</span><input required minLength={2} maxLength={120} value={productName} onChange={e=>setProductName(e.target.value)} /></label>
      <label className="field inline"><span>التصنيف</span><select value={category} onChange={e=>setCategory(e.target.value)}><option value="other">أخرى</option><option value="fertilizer">أسمدة</option><option value="pesticide">مبيدات</option></select></label>
      <label className="field inline"><span>الوحدة</span><input required maxLength={40} value={unit} onChange={e=>setUnit(e.target.value)} placeholder="شيكارة أو عبوة" /></label>
      <label className="field inline"><span>حجم العبوة</span><input maxLength={60} value={unitSize} onChange={e=>setUnitSize(e.target.value)} /></label>
      <button className="btn primary sm" disabled={busy}>إضافة صنف</button></form></div>
    {warehouseId && <>
      {editing && <form className="panel" onSubmit={e=>{e.preventDefault();void perform(async()=>{await patch(`/api/warehouse/products/${editing.id}`,{name:editName,category:editCategory,unit:editUnit,unitSize:editUnitSize});setEditing(null);await loadStock();setMessage('الصنف اتعدل.');});}}><h3>تعديل الصنف</h3><div className="filters">
        <label className="field inline"><span>اسم الصنف</span><input required minLength={2} maxLength={120} value={editName} onChange={e=>setEditName(e.target.value)} /></label>
        <label className="field inline"><span>تصنيف الصنف</span><select value={editCategory} onChange={e=>setEditCategory(e.target.value)}><option value="other">أخرى</option><option value="fertilizer">أسمدة</option><option value="pesticide">مبيدات</option></select></label>
        <label className="field inline"><span>الوحدة</span><input required maxLength={40} value={editUnit} onChange={e=>setEditUnit(e.target.value)} /></label>
        <label className="field inline"><span>حجم العبوة</span><input maxLength={60} value={editUnitSize} onChange={e=>setEditUnitSize(e.target.value)} /></label>
        <button className="btn primary sm" disabled={busy}>حفظ التعديل</button><button type="button" className="btn ghost sm" onClick={()=>setEditing(null)}>إلغاء</button>
      </div><p className="muted small">الوحدة والعبوة ما تتغيرش بعد تسجيل رصيد للصنف.</p></form>}
      <div className="panel"><h3>تسجيل حركة</h3><form className="filters" onSubmit={submitMovement}>
        <label className="field inline"><span>نوع الحركة</span><select value={kind} onChange={e=>{setKind(e.target.value as Movement['kind']);resetRequest();}}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field inline"><span>الصنف</span><select required value={productId} onChange={e=>{setProductId(e.target.value);resetRequest();}}><option value="">اختار الصنف</option>{stock.map(p=><option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (موقوف)'} · {p.unit}{p.unitSize ? ` ${p.unitSize}` : ''}</option>)}</select></label>
        {kind === 'transfer' && <label className="field inline"><span>إلى مخزن</span><select required value={destination} onChange={e=>{setDestination(e.target.value);resetRequest();}}><option value="">اختار المخزن</option>{warehouses.filter(w=>w.id!==warehouseId).map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
        <label className="field inline"><span>الكمية</span><input required inputMode="decimal" value={qty} onChange={e=>{setQty(e.target.value);resetRequest();}} placeholder="مثال: 10 أو 1.5" /></label>
        <label className="field inline"><span>ملاحظة</span><input maxLength={500} value={note} onChange={e=>{setNote(e.target.value);resetRequest();}} /></label>
        <button className="btn primary sm" disabled={busy}>{busy ? 'جارٍ الحفظ…' : 'حفظ الحركة'}</button>
      </form><p className="muted small">لو الرصيد الافتتاحي صفر اكتبه صفر. النقل يحتاج تسجيل الرصيد الافتتاحي في المخزنين.</p></div>
      <div className="panel"><h3>أرصدة المخزن</h3><div className="kpi-table-wrap"><table className="kpi-table"><thead><tr><th>الصنف</th><th>الوحدة</th><th>الرصيد</th><th>الحالة</th><th></th></tr></thead><tbody>
        {stock.map(p=><tr key={p.id}><td>{p.name}</td><td>{p.unit} {p.unitSize}</td><td>{p.qty === null ? 'لم يُسجَّل' : p.qty}</td><td>{p.active ? 'شغال' : 'موقوف'}</td><td><button className="btn ghost sm" onClick={()=>{setEditing(p);setEditName(p.name);setEditCategory(p.category);setEditUnit(p.unit);setEditUnitSize(p.unitSize);}}>تعديل</button> <button className="btn ghost sm" disabled={busy} onClick={()=>void perform(async()=>{await patch(`/api/warehouse/products/${p.id}`,{active:!p.active});await loadStock();})}>{p.active?'وقف':'تفعيل'}</button></td></tr>)}
      </tbody></table></div>{stock.length===0 && <p className="muted">مفيش أصناف لسه.</p>}</div>
      <div className="panel"><h3>آخر حركات المخزن</h3><div className="kpi-table-wrap"><table className="kpi-table"><thead><tr><th>الحركة</th><th>الصنف والكمية</th><th>من / إلى</th><th>بواسطة</th><th>الوقت</th><th>ملاحظة</th></tr></thead><tbody>
        {movements.map(m=><tr key={m.id}><td>{labels[m.kind]}</td><td>{m.productName} · {m.qty} {m.unit}</td><td>{m.fromName || '—'} / {m.toName || '—'}</td><td>{m.actorName}</td><td>{new Date(m.createdAt).toLocaleString('ar-EG')}</td><td>{m.note || '—'}</td></tr>)}
      </tbody></table></div>{movements.length===0 && <p className="muted">مفيش حركات لسه.</p>}</div>
    </>}
  </section>;
}
