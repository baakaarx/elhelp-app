import { useReveal } from './useReveal';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, patch, post } from './api';
import { dateTimeText } from './dates';
import { hasInputPrecision } from './decimal';

type Warehouse = { id:string; name:string };
type Stock = { id:string; name:string; category:string; unit:string; unitSize:string; active:boolean; qty:number|null };
type Movement = { id:string; kind:'opening'|'in'|'out'|'transfer'; productName:string; qty:number; unit:string; fromName:string|null; toName:string|null; actorName:string; note:string; createdAt:number };
const labels = { opening:'رصيد افتتاحي', in:'إضافة', out:'صرف', transfer:'نقل' } as const;
const parseQty = (value:string) => { const normalized=value.trim().replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace('٫','.'); return /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : NaN; };
const qtyText = (value:number) => value.toLocaleString('ar-EG',{maximumFractionDigits:3});
type PendingMovement = {body:{id:string;kind:Movement['kind'];productId:string;qty:number;note:string;fromWarehouseId?:string;toWarehouseId?:string}; description:string};

export default function Warehouses({userId}:{userId:string}) {
  const pendingKey=`mandoub.warehouse.pending.${userId}`;
  // Keep the exact request until a definite response; a reload or second tab must not create a new ID.
  const [pendingRaw,setPendingRaw]=useState<string|null>(()=>{try{return localStorage.getItem(pendingKey);}catch{return 'unreadable';}});
  const [timezone,setTimezone]=useState<string|null>(null);
  const [needsRefresh,setNeedsRefresh]=useState(false);
  const sending=useRef(false);
  const refreshVersion=useRef(0);
  let pending:PendingMovement|null=null;
  try { if(pendingRaw) { const parsed=JSON.parse(pendingRaw); if(!parsed?.body?.id || typeof parsed.description!=='string') throw Error(); pending=parsed; } } catch { /* Fail closed on unreadable saved data. */ }
  useEffect(()=>{const sync=(e:StorageEvent)=>{if(e.key===pendingKey){refreshVersion.current++;setPendingRaw(e.newValue);if(!e.newValue)setNeedsRefresh(true);}};window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);},[pendingKey]);
  useEffect(()=>{api<{timezone:string}>('/api/health').then(x=>setTimezone(x.timezone)).catch(()=>setTimezone(null));},[]);
  const [warehouses,setWarehouses] = useState<Warehouse[]>([]);
  const [legacyHistory,setLegacyHistory] = useState(false);
  const [warehouseId,setWarehouseId] = useState('');
  const currentWarehouse=useRef(warehouseId);currentWarehouse.current=warehouseId;
  const stockRequest=useRef(0);
  const [stockLoadedFor,setStockLoadedFor]=useState(''),[stockLoading,setStockLoading]=useState(false);
  const stockReady=!!warehouseId && stockLoadedFor===warehouseId;
  const [stock,setStock] = useState<Stock[]>([]);
  const [movements,setMovements] = useState<Movement[]>([]);
  const [newWarehouse,setNewWarehouse] = useState('');
  const [editing,setEditing] = useState<Stock|null>(null);
  const editForm = useReveal<HTMLFormElement>();
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
  const loadWarehouses = useCallback(async () => {
    const result = await api<{warehouses:Warehouse[]; legacyHistory:boolean}>('/api/warehouse/warehouses');
    setWarehouses(result.warehouses);
    setLegacyHistory(result.legacyHistory);
    setWarehouseId(current => current || result.warehouses[0]?.id || '');
  }, []);
  const loadStock = useCallback(async () => {
    if (currentWarehouse.current !== warehouseId) return;
    const request=++stockRequest.current, refreshAtStart=refreshVersion.current;
    setStockLoadedFor('');setStock([]);setMovements([]);
    if (!warehouseId) {setStockLoading(false);return;}
    setStockLoading(true);
    try {
      const [s,m] = await Promise.all([
        api<{stock:Stock[]}>(`/api/warehouse/stock?warehouseId=${encodeURIComponent(warehouseId)}`),
        api<{movements:Movement[]}>(`/api/warehouse/movements?warehouseId=${encodeURIComponent(warehouseId)}`),
      ]);
      if(request===stockRequest.current && currentWarehouse.current===warehouseId) {
        setStock(s.stock);setMovements(m.movements);setStockLoadedFor(warehouseId);
        try {if(refreshAtStart===refreshVersion.current && localStorage.getItem(pendingKey)===null)setNeedsRefresh(false);} catch {setNeedsRefresh(true);}
      }
    } catch(e) {
      if(request===stockRequest.current && currentWarehouse.current===warehouseId) throw e;
    } finally {
      if(request===stockRequest.current && currentWarehouse.current===warehouseId) setStockLoading(false);
    }
  }, [warehouseId,pendingKey]);
  useEffect(() => { void loadWarehouses().catch(e => setError(e.message)); }, [loadWarehouses]);
  useEffect(() => {
    void loadStock().catch(e=>setError(`تعذر تحميل أرصدة المخزن وحركاته. ${e instanceof Error ? e.message : ''}`));
    return () => {stockRequest.current++;};
  }, [loadStock]);
  async function perform(task:()=>Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : 'تعذر الحفظ.'); } finally { setBusy(false); }
  }
  async function addWarehouse(event:FormEvent) {
    event.preventDefault(); await perform(async () => {
      const r = await post<{warehouse:Warehouse}>('/api/warehouse/warehouses',{name:newWarehouse});
      setNewWarehouse(''); setMessage('المخزن اتضاف.');
      try {await loadWarehouses();setWarehouseId(r.warehouse.id);} catch {setError('المخزن اتضاف، لكن القائمة ما اتحدّثتش. حدّث الصفحة قبل المحاولة مرة أخرى.');}
    });
  }
  async function addProduct(event:FormEvent) {
    event.preventDefault(); await perform(async () => {
      await post('/api/warehouse/products',{name:productName,category,unit,unitSize});
      setProductName(''); setUnit(''); setUnitSize(''); setMessage('الصنف اتضاف؛ سجّل رصيده الافتتاحي في كل مخزن.');
      try {await loadStock();} catch {setError('الصنف اتضاف، لكن القائمة ما اتحدّثتش. حدّث الصفحة قبل المحاولة مرة أخرى.');}
    });
  }
  async function sendMovement(operation:PendingMovement) {
    if(sending.current) throw Error('الحركة لسه بتتحفظ.');
    if(!navigator.locks) throw Error('المتصفح لا يدعم حماية العمليات بين التبويبات. افتح النظام بمتصفح حديث واتصال آمن.');
    sending.current=true;
    try { await navigator.locks.request(pendingKey,{ifAvailable:true},async lock=>{
      if(!lock) throw Error('في حركة تانية بتتحفظ على الجهاز. انتظر وحدّث الأرصدة.');
      const serialized=JSON.stringify(operation), existing=localStorage.getItem(pendingKey);
      if(existing && existing!==serialized) {setPendingRaw(existing);throw Error('في حركة معلقة على الجهاز. لازم تتأكد منها الأول.');}
      localStorage.setItem(pendingKey,serialized);setPendingRaw(serialized);
      try {await post('/api/warehouse/movements',operation.body);localStorage.removeItem(pendingKey);setPendingRaw(null);}
      catch(e) {
        if(e instanceof ApiError && e.status>=400 && e.status<500 && ![401,403,408,429].includes(e.status)){localStorage.removeItem(pendingKey);setPendingRaw(null);}
        throw e;
      }
    }); } finally {sending.current=false;}
  }
  async function finishMovement(operation:PendingMovement) {
    await perform(async()=>{
      await sendMovement(operation);setQty('');setNote('');setMessage('الحركة اتحفظت.');
      try {await loadStock();} catch {refreshVersion.current++;setNeedsRefresh(true);setError('الحركة اتحفظت، لكن الأرصدة ما اتحدّثتش. أعد تحميل الأرصدة قبل تسجيل حركة تانية.');}
    });
  }
  async function submitMovement(event:FormEvent) {
    event.preventDefault();
    if(pendingRaw || needsRefresh || !stockReady){setError('راجع الحركة المعلقة وحدّث الأرصدة قبل تسجيل حركة تانية.');return;}
    if (!Number.isFinite(parseQty(qty)) || !hasInputPrecision(qty,3)) { setError('اكتب كمية صحيحة بحد أقصى ٣ أرقام بعد العلامة العشرية.'); return; }
    const body = {id:crypto.randomUUID(),kind,productId,qty:parseQty(qty),note,
      ...(kind === 'opening' || kind === 'in' ? {toWarehouseId:warehouseId} : {fromWarehouseId:warehouseId}),
      ...(kind === 'transfer' ? {toWarehouseId:destination} : {})};
    const description=`${labels[kind]} · ${stock.find(p=>p.id===productId)?.name || 'صنف'} · ${qtyText(body.qty)} · ${warehouses.find(w=>w.id===warehouseId)?.name || 'مخزن'}${kind==='transfer'?` إلى ${warehouses.find(w=>w.id===destination)?.name || 'مخزن'}`:''}`;
    await finishMovement({body,description});
  }
  return <section className="page">
    <header className="page-head"><div><h2>المخازن والأصناف</h2><p className="muted">لكل مخزن رصيد مستقل. سجّل الرصيد الافتتاحي قبل الإضافة أو الصرف أو النقل.</p></div></header>
    {pendingRaw && <div className="notice" role="alert"><strong>في حركة مخزون لم نتأكد من نتيجتها.</strong><p>{pending ? pending.description : 'تعذر قراءة الحركة المحفوظة على الجهاز؛ راجع المسؤول قبل تسجيل حركة أخرى.'}</p><p>قد تكون اتحفظت بالفعل. اضغط للتأكد بنفس رقم الحركة، حتى بعد تحديث الصفحة.</p>{pending && <button type="button" className="btn primary sm" disabled={busy} onClick={()=>void finishMovement(pending!)}>التأكد من الحركة المعلقة</button>}</div>}
    {needsRefresh && <p className="notice">لازم تعيد تحميل الأرصدة وتتأكد منها قبل تسجيل حركة جديدة.</p>}
    {legacyHistory && <p className="notice">فيه حركات مخزون قديمة محفوظة بشكل منفصل، ومش داخلة في الأرصدة هنا. راجع الجرد وسجّل الأرصدة الافتتاحية.</p>}
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="ok-text" role="status">{message}</p>}
    <div className="panel">
      <form className="filters warehouse-picker" onSubmit={addWarehouse}><label className="field inline"><span>اسم مخزن جديد</span><input value={newWarehouse} onChange={e=>setNewWarehouse(e.target.value)} minLength={2} maxLength={120} required /></label><button className="btn primary sm" disabled={busy}>إضافة مخزن</button></form>
      <label className="field inline warehouse-current"><span>المخزن</span><select disabled={busy} value={warehouseId} onChange={e=>{if (e.target.value === warehouseId) return; setWarehouseId(e.target.value); setProductId(''); setDestination(''); setError(''); setStock([]); setMovements([]);}}><option value="">اختار مخزن</option>{warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
    </div>
    <div className="panel"><h3>إضافة صنف</h3><form className="work-form" onSubmit={addProduct}>
      <label className="field inline"><span>اسم الصنف</span><input required minLength={2} maxLength={120} value={productName} onChange={e=>setProductName(e.target.value)} /></label>
      <label className="field inline"><span>التصنيف</span><select value={category} onChange={e=>setCategory(e.target.value)}><option value="other">أخرى</option><option value="fertilizer">أسمدة</option><option value="pesticide">مبيدات</option></select></label>
      <label className="field inline"><span>الوحدة</span><input required maxLength={40} value={unit} onChange={e=>setUnit(e.target.value)} placeholder="شيكارة أو عبوة" /></label>
      <label className="field inline"><span>حجم العبوة</span><input maxLength={60} value={unitSize} onChange={e=>setUnitSize(e.target.value)} /></label>
      <button className="btn primary sm" disabled={busy}>إضافة صنف</button></form></div>
    {warehouseId && <>
      {editing && <form className="panel reveal-target" ref={editForm.ref} tabIndex={-1} onSubmit={e=>{e.preventDefault();void perform(async()=>{await patch(`/api/warehouse/products/${editing.id}`,{name:editName,category:editCategory,unit:editUnit,unitSize:editUnitSize});setEditing(null);setMessage('الصنف اتعدل.');try {await loadStock();} catch {setError('الصنف اتعدل، لكن القائمة ما اتحدّثتش. حدّث الصفحة قبل المحاولة مرة أخرى.');}});}}><h3>تعديل الصنف</h3><div className="work-form">
        <label className="field inline"><span>اسم الصنف</span><input required minLength={2} maxLength={120} value={editName} onChange={e=>setEditName(e.target.value)} /></label>
        <label className="field inline"><span>تصنيف الصنف</span><select value={editCategory} onChange={e=>setEditCategory(e.target.value)}><option value="other">أخرى</option><option value="fertilizer">أسمدة</option><option value="pesticide">مبيدات</option></select></label>
        <label className="field inline"><span>الوحدة</span><input required maxLength={40} value={editUnit} onChange={e=>setEditUnit(e.target.value)} /></label>
        <label className="field inline"><span>حجم العبوة</span><input maxLength={60} value={editUnitSize} onChange={e=>setEditUnitSize(e.target.value)} /></label>
        <button className="btn primary sm" disabled={busy}>حفظ التعديل</button><button type="button" className="btn ghost sm" onClick={()=>setEditing(null)}>إلغاء</button>
      </div><p className="muted small">الوحدة والعبوة ما تتغيرش بعد تسجيل رصيد للصنف.</p></form>}
      <div className="panel"><h3>تسجيل حركة</h3><form className="work-form" onSubmit={submitMovement}><fieldset disabled={busy || !!pendingRaw || needsRefresh || !stockReady} className="work-form warehouse-movement-fields">
        <label className="field inline"><span>نوع الحركة</span><select value={kind} onChange={e=>{setKind(e.target.value as Movement['kind']);}}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field inline"><span>الصنف</span><select required value={productId} onChange={e=>{setProductId(e.target.value);}}><option value="">اختار الصنف</option>{stock.map(p=><option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (موقوف)'} · {p.unit}{p.unitSize ? ` ${p.unitSize}` : ''}</option>)}</select></label>
        {kind === 'transfer' && <label className="field inline"><span>إلى مخزن</span><select required value={destination} onChange={e=>{setDestination(e.target.value);}}><option value="">اختار المخزن</option>{warehouses.filter(w=>w.id!==warehouseId).map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
        <label className="field inline"><span>الكمية</span><input required inputMode="decimal" value={qty} onChange={e=>{setQty(e.target.value);}} placeholder="مثال: 10 أو 1.5" /></label>
        <label className="field inline"><span>ملاحظة</span><input maxLength={500} value={note} onChange={e=>{setNote(e.target.value);}} /></label>
        <button className="btn primary sm" disabled={busy}>{busy ? 'جارٍ الحفظ…' : 'حفظ الحركة'}</button>
      </fieldset></form><p className="muted small">لو الرصيد الافتتاحي صفر اكتبه صفر. النقل يحتاج تسجيل الرصيد الافتتاحي في المخزنين.</p></div>
      {warehouseId && (!stockReady || needsRefresh) && (stockLoading ? <p role="status">جارٍ تحميل أرصدة المخزن وحركاته…</p> : <div className="notice">الأرصدة والحركات غير متاحة الآن. حدّثها قبل تسجيل حركة. <button type="button" className="btn ghost sm" disabled={busy} onClick={()=>{setError('');void loadStock().catch(e=>setError(`تعذر تحميل أرصدة المخزن وحركاته. ${e instanceof Error ? e.message : ''}`));}}>إعادة تحميل الأرصدة</button></div>)}
      {stockReady && !needsRefresh && <><div className="panel"><h3>أرصدة المخزن</h3><div className="kpi-table-wrap"><table className="kpi-table"><thead><tr><th>الصنف</th><th>الوحدة</th><th>الرصيد</th><th>الحالة</th><th></th></tr></thead><tbody>
        {stock.map(p=><tr key={p.id}><td>{p.name}</td><td>{p.unit} {p.unitSize}</td><td>{p.qty === null ? 'لم يُسجَّل' : qtyText(p.qty)}</td><td>{p.active ? 'شغال' : 'موقوف'}</td><td><button className="btn ghost sm" onClick={()=>{setEditing(p);setEditName(p.name);setEditCategory(p.category);setEditUnit(p.unit);setEditUnitSize(p.unitSize);editForm.reveal();}}>تعديل</button> <button className="btn ghost sm" disabled={busy} onClick={()=>void perform(async()=>{await patch(`/api/warehouse/products/${p.id}`,{active:!p.active});setMessage(p.active?'الصنف اتوقف.':'الصنف اتفعّل.');try {await loadStock();} catch {setError('حالة الصنف اتغيرت، لكن القائمة ما اتحدّثتش. حدّث الصفحة قبل المحاولة مرة أخرى.');}})}>{p.active?'وقف':'تفعيل'}</button></td></tr>)}
      </tbody></table></div>{stock.length===0 && <p className="muted">مفيش أصناف لسه.</p>}</div>
      <div className="panel"><h3>آخر حركات المخزن</h3><div className="kpi-table-wrap"><table className="kpi-table"><thead><tr><th>الحركة</th><th>الصنف والكمية</th><th>من / إلى</th><th>بواسطة</th><th>الوقت</th><th>ملاحظة</th></tr></thead><tbody>
        {movements.map(m=><tr key={m.id}><td>{labels[m.kind]}</td><td>{m.productName} · {qtyText(m.qty)} {m.unit}</td><td>{m.fromName || '—'} / {m.toName || '—'}</td><td>{m.actorName}</td><td>{timezone ? dateTimeText(m.createdAt,timezone) : 'الوقت غير متاح'}</td><td>{m.note || '—'}</td></tr>)}
      </tbody></table></div>{movements.length===0 && <p className="muted">مفيش حركات لسه.</p>}</div></>}
    </>}
  </section>;
}
