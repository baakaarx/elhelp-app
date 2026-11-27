import { useReveal } from './useReveal';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, patch, post } from './api';
import { dateTimeText } from './dates';
import { hasInputPrecision, normalizeDecimal } from './decimal';
import ConfirmAction from './ConfirmAction';

type Warehouse = { id:string; name:string };
type Stock = { id:string; name:string; category:string; unit:string; unitSize:string; active:boolean; qty:number|null };
type Movement = { id:string; kind:'opening'|'in'|'out'|'transfer'; productName:string; qty:number; unit:string; unitSize:string; fromName:string|null; toName:string|null; actorName:string; note:string; createdAt:number };
const labels = { opening:'رصيد افتتاحي', in:'إضافة', out:'صرف', transfer:'نقل' } as const;
const parseQty = (value:string) => { const normalized=normalizeDecimal(value); return /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : NaN; };
const qtyText = (value:number) => value.toLocaleString('ar-EG',{maximumFractionDigits:3});
type PendingMovement = {body:{id:string;kind:Movement['kind'];productId:string;qty:number;note:string;fromWarehouseId?:string;toWarehouseId?:string}; description:string; path?:undefined} | {path:'/api/warehouse/stock-items';body:{id:string;warehouseId:string;product:{name:string;category:string;unit:string;unitSize:string};qty:number};description:string};
type LowStock = {warehouseId:string;warehouseName:string;productId:string;productName:string;unit:string;unitSize:string;qty:number};

export default function Warehouses({userId}:{userId:string}) {
  const pendingKey=`mandoub.warehouse.pending.${userId}`;
  const safeOperations=typeof globalThis.crypto?.randomUUID==='function' && !!navigator.locks;
  // Keep the exact request until a definite response; a reload or second tab must not create a new ID.
  const [pendingRaw,setPendingRaw]=useState<string|null>(()=>{try{return localStorage.getItem(pendingKey);}catch{return 'unreadable';}});
  const [timezone,setTimezone]=useState<string|null>(null);
  const [needsRefresh,setNeedsRefresh]=useState(false);
  const sending=useRef(false);
  const refreshVersion=useRef(0);
  let pending:PendingMovement|null=null;
  try { if(pendingRaw) { const parsed=JSON.parse(pendingRaw); if(!parsed?.body?.id || typeof parsed.description!=='string' || (parsed.path!==undefined && parsed.path!=='/api/warehouse/stock-items')) throw Error(); pending=parsed; } } catch { /* Fail closed on unreadable saved data. */ }
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
  const [initialQty,setInitialQty] = useState('');
  const [lowStock,setLowStock] = useState<LowStock[]|null>(null);
  const [lowError,setLowError] = useState(false);
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
  const lowRequest=useRef(0);
  const loadLowStock=useCallback(async()=>{
    const n=++lowRequest.current, controller=new AbortController();
    // A stalled request must not leave an old green "no alerts" message visible forever.
    const timeout=setTimeout(()=>controller.abort(),8000);
    try {
      const r=await api<{items:LowStock[]}>('/api/warehouse/low-stock',{signal:controller.signal});
      if(!Array.isArray(r?.items) || r.items.some(x=>!x || typeof x.warehouseId!=='string' || typeof x.warehouseName!=='string' || typeof x.productId!=='string' || typeof x.productName!=='string' || typeof x.unit!=='string' || typeof x.unitSize!=='string' || typeof x.qty!=='number' || !Number.isFinite(x.qty))) throw Error('invalid low stock response');
      if(n===lowRequest.current){setLowStock(r.items);setLowError(false);}
    } catch {if(n===lowRequest.current)setLowError(true);} finally {clearTimeout(timeout);}
  },[]);
  useEffect(()=>{
    void loadLowStock();const timer=setInterval(()=>void loadLowStock(),10000);
    const onVisible=()=>{if(document.visibilityState==='visible')void loadLowStock();};
    document.addEventListener('visibilitychange',onVisible);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);lowRequest.current++;};
  },[loadLowStock]);
  async function perform(task:()=>Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : 'تعذر الحفظ.'); } finally { setBusy(false); }
  }
  async function addWarehouse(event:FormEvent) {
    event.preventDefault(); await perform(async () => {
      const r = await post<{warehouse:Warehouse}>('/api/warehouse/warehouses',{name:newWarehouse});
      setNewWarehouse(''); setMessage('المخزن اتضاف.');
      try {await loadWarehouses();setEditing(null);setProductId('');setDestination('');setWarehouseId(r.warehouse.id);} catch {setError('المخزن اتضاف، لكن القائمة ما اتحدّثتش. حدّث الصفحة قبل المحاولة مرة أخرى.');}
    });
  }
  async function addProduct(event:FormEvent) {
    event.preventDefault();
    if (!warehouseId || !stockReady || pendingRaw || needsRefresh) {setError('اختار المخزن وحدّث أرصدته قبل إضافة الصنف.');return;}
    if (!Number.isFinite(parseQty(initialQty)) || !hasInputPrecision(initialQty,3)) {setError('اكتب الرصيد الافتتاحي؛ الصفر مسموح وبحد أقصى ٣ أرقام عشرية.');return;}
    const operation:PendingMovement={path:'/api/warehouse/stock-items',body:{id:crypto.randomUUID(),warehouseId,product:{name:productName,category,unit,unitSize},qty:parseQty(initialQty)},description:`إضافة ${productName} · ${unit} ${unitSize} إلى ${warehouses.find(w=>w.id===warehouseId)?.name} برصيد ${initialQty}`};
    await finishMovement(operation);
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
      try {await post(operation.path || '/api/warehouse/movements',operation.body);localStorage.removeItem(pendingKey);setPendingRaw(null);}
      catch(e) {
        if(e instanceof ApiError && e.status>=400 && e.status<500 && ![401,403,408,429].includes(e.status)){localStorage.removeItem(pendingKey);setPendingRaw(null);}
        throw e;
      }
    }); } finally {sending.current=false;}
  }
  async function finishMovement(operation:PendingMovement) {
    await perform(async()=>{
      await sendMovement(operation);setQty('');setNote('');if(operation.path){setProductName('');setUnit('');setUnitSize('');setInitialQty('');}setMessage(operation.path?'الصنف اتضاف للمخزن والرصيد اتحفظ.':'الحركة اتحفظت.');void loadLowStock();
      try {await loadStock();} catch {refreshVersion.current++;setNeedsRefresh(true);setError('الحركة اتحفظت، لكن الأرصدة ما اتحدّثتش. أعد تحميل الأرصدة قبل تسجيل حركة تانية.');}
    });
  }
  async function submitMovement(event:FormEvent) {
    event.preventDefault();
    if(pendingRaw || needsRefresh || !stockReady){setError('راجع الحركة المعلقة وحدّث الأرصدة قبل تسجيل حركة تانية.');return;}
    if (!Number.isFinite(parseQty(qty)) || !hasInputPrecision(qty,3)) { setError('اكتب كمية صحيحة بحد أقصى ٣ أرقام بعد العلامة العشرية.'); return; }
    if (kind!=='opening' && parseQty(qty)===0) {setError('اكتب كمية أكبر من صفر للحركة؛ الصفر مسموح للرصيد الافتتاحي فقط.');return;}
    const body = {id:crypto.randomUUID(),kind,productId,qty:parseQty(qty),note,
      ...(kind === 'opening' || kind === 'in' ? {toWarehouseId:warehouseId} : {fromWarehouseId:warehouseId}),
      ...(kind === 'transfer' ? {toWarehouseId:destination} : {})};
    const description=`${labels[kind]} · ${stock.find(p=>p.id===productId) ? `${stock.find(p=>p.id===productId)!.name} · ${stock.find(p=>p.id===productId)!.unit} ${stock.find(p=>p.id===productId)!.unitSize}` : 'صنف'} · ${qtyText(body.qty)} · ${warehouses.find(w=>w.id===warehouseId)?.name || 'مخزن'}${kind==='transfer'?` إلى ${warehouses.find(w=>w.id===destination)?.name || 'مخزن'}`:''}`;
    await finishMovement({body,description});
  }
  return <section className="page">
    <header className="page-head"><div><h2>المخازن والأصناف</h2><p className="muted">اختار المخزن أولًا؛ كل صنف يظهر في المخزن اللي اتسجّل له رصيد فيه فقط. الفواتير المؤكدة تخصم تلقائيًا، مش محتاجة حركة صرف يدوية.</p></div></header>
    {!safeOperations && <p className="error" role="alert">حفظ الأرصدة غير متاح لأن المتصفح لا يوفر حماية العمليات على هذا الرابط. افتح اللوحة على نفس جهاز السيرفر عبر localhost، أو استخدم HTTPS ومتصفحًا حديثًا.</p>}
    {pendingRaw && <div className="notice" role="alert"><strong>في حركة مخزون لم نتأكد من نتيجتها.</strong><p>{pending ? pending.description : 'تعذر قراءة الحركة المحفوظة على الجهاز؛ راجع المسؤول قبل تسجيل حركة أخرى.'}</p><p>قد تكون اتحفظت بالفعل. اضغط للتأكد بنفس رقم الحركة، حتى بعد تحديث الصفحة.</p>{pending && <button type="button" className="btn primary sm" disabled={busy} onClick={()=>void finishMovement(pending!)}>التأكد من الحركة المعلقة</button>}</div>}
    {needsRefresh && <p className="notice">لازم تعيد تحميل الأرصدة وتتأكد منها قبل تسجيل حركة جديدة.</p>}
    {legacyHistory && <p className="notice">فيه حركات مخزون قديمة محفوظة بشكل منفصل، ومش داخلة في الأرصدة هنا. راجع الجرد وسجّل الأرصدة الافتتاحية.</p>}
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="ok-text" role="status">{message}</p>}
    <div className="panel">
      <form className="filters warehouse-picker" onSubmit={addWarehouse}><label className="field inline"><span>اسم مخزن جديد</span><input value={newWarehouse} onChange={e=>setNewWarehouse(e.target.value)} minLength={2} maxLength={120} required /></label><button className="btn primary sm" disabled={busy}>إضافة مخزن</button></form>
      <label className="field inline warehouse-current"><span>المخزن</span><select disabled={busy} value={warehouseId} onChange={e=>{if (e.target.value === warehouseId) return; setWarehouseId(e.target.value); setEditing(null); setProductId(''); setDestination(''); setError(''); setStock([]); setMovements([]);}}><option value="">اختار مخزن</option>{warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
    </div>
    <div className="panel" aria-label="تنبيهات نقص المخزون"><h3>تنبيهات نقص المخزون</h3>{lowError?<p className="error" role="alert">تعذر تحديث التنبيهات؛ البيانات قديمة. تحقق من الاتصال.</p>:lowStock===null?<p>جارٍ تحميل التنبيهات…</p>:lowStock.length===0?<p className="muted">لا يوجد رصيد مسجّل أقل من ١٠٠ وحدة.</p>:<ul>{lowStock.map(item=><li key={`${item.warehouseId}:${item.productId}`}>{item.warehouseName} · {item.productName} · {item.unit} {item.unitSize}: متبقي {qtyText(item.qty)} {item.unit}</li>)}</ul>}<p className="muted small">يظهر الرصيد الأقل من ١٠٠ من وحدة الصنف المسجّلة، وتتحدث القائمة كل ١٠ ثوانٍ أثناء فتح اللوحة. الأصناف بلا رصيد مسجّل لا تظهر كصفر.</p></div>
    <div className="panel"><h3>إضافة صنف</h3><p><strong>المخزن الذي سيُضاف إليه الصنف: {warehouses.find(w=>w.id===warehouseId)?.name || 'لم يُحدَّد'}</strong></p><p className="muted small">الصنف الجديد ورصيده الأول يضافان للمخزن المحدد فقط. لتسجيل صنف موجود في مخزن آخر اختاره من حركة الرصيد الافتتاحي أدناه.</p><form className="work-form" onSubmit={addProduct}>
      <label className="field inline"><span>اسم الصنف</span><input required minLength={2} maxLength={120} value={productName} onChange={e=>setProductName(e.target.value)} /></label>
      <label className="field inline"><span>التصنيف</span><select value={category} onChange={e=>setCategory(e.target.value)}><option value="other">أخرى</option><option value="fertilizer">أسمدة</option><option value="pesticide">مبيدات</option></select></label>
      <label className="field inline"><span>الوحدة</span><input required maxLength={40} value={unit} onChange={e=>setUnit(e.target.value)} placeholder="مثال: عبوة أو شيكارة" /></label>
      <label className="field inline"><span>حجم العبوة</span><input maxLength={60} value={unitSize} onChange={e=>setUnitSize(e.target.value)} placeholder="مثال: ١ لتر أو ١٠٠ جم" /></label>
      <label className="field inline"><span>الرصيد الافتتاحي للمخزن المحدد</span><input required inputMode="decimal" value={initialQty} onChange={e=>setInitialQty(e.target.value)} placeholder="مثال: 100" /></label>
      <button className="btn primary sm" disabled={busy || !stockReady || !!pendingRaw || needsRefresh || !safeOperations}>إضافة صنف</button></form></div>
    {warehouseId && <>
      {editing && <form className="panel reveal-target" ref={editForm.ref} tabIndex={-1} onSubmit={e=>{e.preventDefault();void perform(async()=>{await patch(`/api/warehouse/products/${editing.id}`,{name:editName,category:editCategory,unit:editUnit,unitSize:editUnitSize});setEditing(null);setMessage('الصنف اتعدل.');try {await loadStock();} catch {setError('الصنف اتعدل، لكن القائمة ما اتحدّثتش. حدّث الصفحة قبل المحاولة مرة أخرى.');}});}}><h3>تعديل الصنف</h3><div className="work-form">
        <label className="field inline"><span>اسم الصنف</span><input required minLength={2} maxLength={120} value={editName} onChange={e=>setEditName(e.target.value)} /></label>
        <label className="field inline"><span>تصنيف الصنف</span><select value={editCategory} onChange={e=>setEditCategory(e.target.value)}><option value="other">أخرى</option><option value="fertilizer">أسمدة</option><option value="pesticide">مبيدات</option></select></label>
        <label className="field inline"><span>الوحدة</span><input required maxLength={40} value={editUnit} onChange={e=>setEditUnit(e.target.value)} /></label>
        <label className="field inline"><span>حجم العبوة</span><input maxLength={60} value={editUnitSize} onChange={e=>setEditUnitSize(e.target.value)} /></label>
        <button className="btn primary sm" disabled={busy}>حفظ التعديل</button><button type="button" className="btn ghost sm" onClick={()=>setEditing(null)}>إلغاء</button>
      </div><p className="muted small">تعديل اسم أو حالة الصنف ينعكس على كل المخازن. الوحدة والعبوة ما تتغيرش بعد تسجيل رصيد للصنف.</p></form>}
      <div className="panel"><h3>تسجيل حركة</h3><p className="muted small">لإضافة صنف موجود لهذا المخزن اختار رصيد افتتاحي. الزيادة للمخزن من «إضافة»؛ صرف الفواتير تلقائي.</p><form className="work-form" onSubmit={submitMovement}><fieldset disabled={busy || !!pendingRaw || needsRefresh || !stockReady || !safeOperations} className="work-form warehouse-movement-fields">
        <label className="field inline"><span>نوع الحركة</span><select value={kind} onChange={e=>{setKind(e.target.value as Movement['kind']);setProductId('');}}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field inline"><span>الصنف</span><select required value={productId} onChange={e=>{setProductId(e.target.value);}}><option value="">اختار الصنف</option>{stock.filter(p=>kind==='opening' ? p.qty===null && p.active : p.qty!==null && p.active).map(p=><option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (موقوف)'} · {p.unit}{p.unitSize ? ` ${p.unitSize}` : ''}</option>)}</select></label>
        {kind === 'transfer' && <label className="field inline"><span>إلى مخزن</span><select required value={destination} onChange={e=>{setDestination(e.target.value);}}><option value="">اختار المخزن</option>{warehouses.filter(w=>w.id!==warehouseId).map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
        <label className="field inline"><span>الكمية</span><input required inputMode="decimal" value={qty} onChange={e=>{setQty(e.target.value);}} placeholder="مثال: 10 أو 1.5" /></label>
        <label className="field inline"><span>ملاحظة</span><input maxLength={500} value={note} onChange={e=>{setNote(e.target.value);}} /></label>
        <button className="btn primary sm" disabled={busy}>{busy ? 'جارٍ الحفظ…' : 'حفظ الحركة'}</button>
      </fieldset></form><p className="muted small">لو الرصيد الافتتاحي صفر اكتبه صفر. النقل يحتاج تسجيل الرصيد الافتتاحي في المخزنين.</p></div>
      {warehouseId && (!stockReady || needsRefresh) && (stockLoading ? <p role="status">جارٍ تحميل أرصدة المخزن وحركاته…</p> : <div className="notice">الأرصدة والحركات غير متاحة الآن. حدّثها قبل تسجيل حركة. <button type="button" className="btn ghost sm" disabled={busy} onClick={()=>{setError('');void loadStock().catch(e=>setError(`تعذر تحميل أرصدة المخزن وحركاته. ${e instanceof Error ? e.message : ''}`));}}>إعادة تحميل الأرصدة</button></div>)}
      {stockReady && !needsRefresh && <><div className="panel"><h3>أرصدة المخزن</h3><p className="muted small">الأرصدة قد تتغير عند تأكيد الفواتير. حدّثها للاطلاع على آخر الأرقام.</p><button type="button" className="btn ghost sm" disabled={busy} onClick={()=>{setError('');void loadStock().catch(e=>setError(`تعذر تحميل الأرصدة. ${e instanceof Error ? e.message : ''}`));}}>تحديث أرصدة المخزن</button><div className="kpi-table-wrap"><table className="kpi-table"><thead><tr><th>الصنف</th><th>الوحدة</th><th>الرصيد</th><th>الحالة</th><th></th></tr></thead><tbody>
        {stock.filter(p=>p.qty!==null).map(p=><tr key={p.id}><td>{p.name}</td><td>{p.unit} {p.unitSize}</td><td>{p.qty === null ? 'لم يُسجَّل' : qtyText(p.qty)}</td><td>{p.active ? 'شغال' : 'موقوف'}</td><td><button className="btn ghost sm" onClick={()=>{setEditing(p);setEditName(p.name);setEditCategory(p.category);setEditUnit(p.unit);setEditUnitSize(p.unitSize);editForm.reveal();}}>تعديل</button> <ConfirmAction label={p.active?'وقف':'تفعيل'} confirmLabel={p.active?'تأكيد الإيقاف':'تأكيد التفعيل'} confirmDisabled={busy} detail="الحالة تتغير للصنف في كل المخازن والمبيعات، مش المخزن الحالي فقط." onConfirm={async()=>{await perform(async()=>{await patch(`/api/warehouse/products/${p.id}`,{active:!p.active});setMessage(p.active?'الصنف اتوقف في كل المخازن.':'الصنف اتفعّل في كل المخازن.');void loadLowStock();try {await loadStock();} catch {setError('حالة الصنف اتغيرت، لكن القائمة ما اتحدّثتش. حدّث الصفحة قبل المحاولة مرة أخرى.');}});}} /></td></tr>)}
      </tbody></table></div>{stock.every(p=>p.qty===null) && <p className="muted">مفيش أصناف مسجّل لها رصيد في المخزن ده.</p>}</div>
      <div className="panel"><h3>آخر حركات المخزن</h3><div className="kpi-table-wrap"><table className="kpi-table"><thead><tr><th>الحركة</th><th>الصنف والكمية</th><th>من / إلى</th><th>بواسطة</th><th>الوقت</th><th>ملاحظة</th></tr></thead><tbody>
        {movements.map(m=><tr key={m.id}><td>{labels[m.kind]}</td><td>{m.productName} · {qtyText(m.qty)} {m.unit} {m.unitSize}</td><td>{m.fromName || '—'} / {m.toName || '—'}</td><td>{m.actorName}</td><td>{timezone ? dateTimeText(m.createdAt,timezone) : 'الوقت غير متاح'}</td><td>{m.note || '—'}</td></tr>)}
      </tbody></table></div>{movements.length===0 && <p className="muted">مفيش حركات لسه.</p>}</div></>}
    </>}
  </section>;
}
