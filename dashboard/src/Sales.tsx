import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, post } from './api';
import { dateTimeText } from './dates';
import { formatNumber } from './session';
import Products from './Products';

type Customer = { id:string;name:string;phone:string;priceTierId:string|null;hasOpening:number };
type Product = { id:string;name:string;unit:string;unitSize:string };
type OrderLine = {productId:string;name:string;qty:number;price:number;unit:string;unitSize:string};
type Options = {customers:Customer[];products:Product[];warehouses:{id:string;name:string}[];prices:{productId:string;tierId:string;price:number}[];tiers:{id:string;name:string;active:number}[];orders:{id:string;customerId:string;customerName:string;total:number;lines:OrderLine[]}[]};
type Report = {count:number;sales:number;collected:number;due:number;debtors:{id:string;name:string;phone:string;due:number}[];latest:{id:string;orderId:string|null;customerName:string;warehouseName:string;total:number;paid:number;createdAt:number}[];payments:{customerName:string;amount:number;createdAt:number}[];soldItems:{name:string;unit:string;unitSize:string;qty:number;amount:number}[];stock:{warehouseId:string;warehouseName:string;productId:string;productName:string;unit:string;unitSize:string;qty:number|null}[]};
type Line = {key:string;productId:string;qty:string;price:string};
const emptyLine=():Line=>({key:crypto.randomUUID(),productId:'',qty:'',price:''});
const parse = (text:string) => {const s=text.trim().replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace('٫','.');return /^\d+(\.\d+)?$/.test(s)?Number(s):NaN;};
const qtyText=(n:number)=>n.toLocaleString('ar-EG',{maximumFractionDigits:3});
const cash=(n:number)=>`${n.toLocaleString('ar-EG',{maximumFractionDigits:2})} ج.م`;
const err=(e:unknown)=>e instanceof Error?e.message:'حصل خطأ. حاول تاني.';

type Pending = {path:string; body:unknown; kind:'sale'|'receipt'|'opening'};
export default function Sales({timezone,userId}:{timezone?:string;userId:string}) {
  const pendingKey=`mandoub.sales.pending.${userId}`;
  const [pending,setPending]=useState<Pending|null>(()=>{try {const raw=localStorage.getItem(pendingKey);return raw?JSON.parse(raw) as Pending:null;}catch{return null;}});
  const sending=useRef(false);
  const [view,setView]=useState<'summary'|'prices'|'advanced'>('summary');
  const [options,setOptions]=useState<Options|null>(null), [report,setReport]=useState<Report|null>(null);
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [showSale,setShowSale]=useState(false),[mode,setMode]=useState<'direct'|'order'>('direct');
  const [customerId,setCustomerId]=useState(''),[warehouseId,setWarehouseId]=useState(''),[orderId,setOrderId]=useState(''),[paid,setPaid]=useState(''),[lines,setLines]=useState<Line[]>([emptyLine()]);
  const [receiptCustomer,setReceiptCustomer]=useState(''),[receiptAmount,setReceiptAmount]=useState('');
  const [openingCustomer,setOpeningCustomer]=useState(''),[openingAmount,setOpeningAmount]=useState('');
  const [priceProduct,setPriceProduct]=useState(''),[priceTier,setPriceTier]=useState(''),[priceInput,setPriceInput]=useState('');
  const saleRequest=useRef(''),receiptRequest=useRef(''),openingRequest=useRef('');
  const load=useCallback(async()=>{setLoading(true);try {const [o,r]=await Promise.all([api<Options>('/api/sales/options'),api<Report>('/api/sales/overview')]);setOptions(o);setReport(r);setError('');}catch(e){setError(err(e));}finally{setLoading(false);}},[]);
  useEffect(()=>{void load();},[load]);
  const selectedOrder=options?.orders.find(o=>o.id===orderId);
  const currentLines = mode==='order' ? (selectedOrder?.lines??[]).map(l=>({qty:l.qty,price:l.price})) : lines.map(l=>({qty:parse(l.qty),price:parse(l.price)}));
  const validLines=currentLines.length>0 && currentLines.every(l=>Number.isFinite(l.qty)&&l.qty>0&&l.qty<=100_000&&Math.abs(l.qty*1000-Math.round(l.qty*1000))<0.00001&&Number.isFinite(l.price)&&l.price>=0&&l.price<=1_000_000_000&&Math.abs(l.price*100-Math.round(l.price*100))<0.00001);
  const total=validLines?currentLines.reduce((sum,l)=>sum+Number((BigInt(Math.round(l.qty*1000))*BigInt(Math.round(l.price*100))+500n)/1000n),0)/100:0;
  const paidValue=parse(paid);
  const changeLine=(key:string, patch:Partial<Line>)=>{saleRequest.current='';setLines(prev=>prev.map(line=>line.key===key?{...line,...patch}:line));};
  const suggested=(productId:string,customer:string)=>{const tier=options?.customers.find(c=>c.id===customer)?.priceTierId;const value=options?.prices.find(p=>p.productId===productId&&p.tierId===tier)?.price;return value===undefined?'':String(value);};
  const refreshAfter=async(success:string)=>{setMessage(success);try{const [o,r]=await Promise.all([api<Options>('/api/sales/options'),api<Report>('/api/sales/overview')]);setOptions(o);setReport(r);}catch{setError(`${success} لكن الشاشة ما اتحدّثتش. حدّث الصفحة قبل أي عملية جديدة.`);}};
  // Persist the exact operation before sending: a lost response or a page reload must not create a second sale.
  async function sendOperation(operation:Pending) {
    if (sending.current) throw new Error('العملية لسه بتتحفظ.');
    sending.current=true;
    try {
      localStorage.setItem(pendingKey,JSON.stringify(operation));
      setPending(operation);
      await post(operation.path,operation.body);
      localStorage.removeItem(pendingKey);setPending(null);
    } catch(e) {
      // A validation/conflict response means this server rejected the transaction. Other failures may
      // have occurred after commit, so keep the exact request until it can be retried idempotently.
      if(e instanceof ApiError && e.status>=400 && e.status<500 && e.status!==401 && e.status!==403 && e.status!==408 && e.status!==429) {
        localStorage.removeItem(pendingKey);setPending(null);
      }
      throw e;
    } finally {sending.current=false;}
  }
  async function retryPending(){if(!pending)return;setBusy(true);setError('');try {
    await sendOperation(pending);saleRequest.current='';receiptRequest.current='';openingRequest.current='';
    setShowSale(false);setLines([emptyLine()]);setPaid('');setOrderId('');setReceiptCustomer('');setReceiptAmount('');setOpeningCustomer('');setOpeningAmount('');
    await refreshAfter('اتأكدنا من العملية واتحدّثت الأرقام.');
  }catch(e){setError(err(e));}finally{setBusy(false);}}
  async function saveSale(event:FormEvent) {event.preventDefault();setError('');setMessage('');
    if(!validLines || !Number.isFinite(paidValue) || paidValue<0 || paidValue>total || Math.abs(paidValue*100-Math.round(paidValue*100))>0.00001){setError('راجع الكميات والأسعار والمبلغ المدفوع.');return;}
    if(mode==='direct' && lines.some(l=>!l.productId)){setError('اختار الأصناف.');return;}
    setBusy(true);try {
      const body={id:saleRequest.current||(saleRequest.current=crypto.randomUUID()),customerId,warehouseId,paid:paidValue,...(mode==='order'?{orderId,lines:[]}:{lines:lines.map(l=>({productId:l.productId,qty:parse(l.qty),price:parse(l.price)}))})};
      await sendOperation({path:'/api/sales',body,kind:'sale'});saleRequest.current='';setPaid('');setOrderId('');setLines([emptyLine()]);setShowSale(false);await refreshAfter('البيعة اتسجلت واتخصمت من المخزن.');
    }catch(e){setError(err(e));}finally{setBusy(false);}
  }
  async function entry(event:FormEvent,kind:'receipt'|'opening'){event.preventDefault();setError('');setMessage('');const value=parse(kind==='receipt'?receiptAmount:openingAmount);
    if(!Number.isFinite(value)||value<0||(kind==='receipt'&&value===0)||Math.abs(value*100-Math.round(value*100))>0.00001){setError('اكتب مبلغ صحيح بالجنيه والقرش.');return;}
    const ref=kind==='receipt'?receiptRequest:openingRequest;setBusy(true);try{
      await sendOperation({path:`/api/sales/${kind==='receipt'?'receipts':'opening'}`,body:{id:ref.current||(ref.current=crypto.randomUUID()),customerId:kind==='receipt'?receiptCustomer:openingCustomer,amount:value},kind});
      ref.current='';if(kind==='receipt'){setReceiptAmount('');setReceiptCustomer('');}else{setOpeningAmount('');setOpeningCustomer('');}await refreshAfter(kind==='receipt'?'الدفعة اتحفظت.':'المديونية القديمة اتحفظت.');
    }catch(e){setError(err(e));}finally{setBusy(false);}}
  async function savePrice(event:FormEvent){event.preventDefault();setError('');setMessage('');const value=parse(priceInput);if(!Number.isFinite(value)||value<0||Math.abs(value*100-Math.round(value*100))>0.00001){setError('اكتب سعر صحيح بالجنيه والقرش.');return;}setBusy(true);try{
    await api(`/api/products/${priceProduct}/prices`,{method:'PUT',body:JSON.stringify({prices:[{tierId:priceTier,price:value}]})});await refreshAfter('السعر اتحفظ.');
  }catch(e){setError(err(e));}finally{setBusy(false);}}
  const selectPrice=(product:string,tier:string)=>{setPriceProduct(product);setPriceTier(tier);const value=options?.prices.find(p=>p.productId===product&&p.tierId===tier)?.price;setPriceInput(value===undefined?'':String(value));};
  return <section className="page sales-page">
    <header className="page-head"><div><h2>المبيعات والمخزون</h2><p className="muted">تابع البيعات والباقي على العملاء وأرصدة المخازن.</p></div><div className="filters">
      <button className="btn ghost sm" disabled={!!pending||busy} onClick={()=>{setView(view==='prices'?'summary':'prices');setError('');setMessage('');}}>{view==='prices'?'رجوع للملخص':'تعديل الأسعار'}</button>
      {view==='summary'&&!pending&&<button className="btn primary" onClick={()=>{setShowSale(!showSale);setError('');setMessage('');}}>{showSale?'إغلاق':'تسجيل بيعة'}</button>}
    </div></header>
    {error&&<p className="error" role="alert">{error}</p>}{message&&<p className="ok-text" role="status">{message}</p>}
    {pending?<div className="panel"><h3>عملية محتاجة تأكيد</h3><p>الاتصال وقف قبل ما نتأكد من حفظ {pending.kind==='sale'?'البيعة':pending.kind==='receipt'?'الدفعة':'المديونية القديمة'}. اضغط تأكيد العملية لإعادة إرسال نفس الطلب بأمان، من غير تكرار.</p><button className="btn primary" disabled={busy} onClick={()=>void retryPending()}>تأكيد العملية</button></div>:loading&&!options?<p>جارٍ التحميل…</p>:!options||!report?<button className="btn ghost sm" onClick={()=>void load()}>حاول تاني</button>:view==='advanced'?<><button className="btn ghost sm" onClick={()=>{setView('prices');void load();}}>رجوع للتسعير</button><Products timezone={timezone} /></>:view==='prices'?<>
      <form className="panel" onSubmit={savePrice}><h3>تعديل سعر صنف</h3><div className="work-form">
        <label className="field"><span>الصنف</span><select required value={priceProduct} onChange={e=>selectPrice(e.target.value,priceTier)}><option value="">اختار الصنف</option>{options.products.map(p=><option key={p.id} value={p.id}>{p.name} · {p.unit} {p.unitSize}</option>)}</select></label>
        <label className="field"><span>نوع السعر</span><select required value={priceTier} onChange={e=>selectPrice(priceProduct,e.target.value)}><option value="">اختار نوع السعر</option>{options.tiers.filter(t=>t.active).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label className="field"><span>سعر العبوة (ج.م)</span><input required inputMode="decimal" value={priceInput} onChange={e=>setPriceInput(e.target.value)} placeholder="اكتب السعر" /></label>
        <button className="btn primary" disabled={busy}>حفظ السعر</button>
      </div><p className="muted small">السعر للعبوة المكتوبة، وبيتقترح حسب نوع سعر العميل. تقدر تغيّره عند البيع.</p></form>
      <button className="btn ghost sm" onClick={()=>setView('advanced')}>إدارة الأصناف وأنواع الأسعار</button>
    </>:<>
      {showSale&&<form className="panel" onSubmit={saveSale}><h3>تسجيل بيعة</h3><p className="muted small">تأكيد البيعة بيخصم الكمية من المخزن. التسعير لوحده مش بيعة.</p><div className="work-form">
        <label className="field"><span>طريقة البيع</span><select value={mode} onChange={e=>{setMode(e.target.value as typeof mode);setOrderId('');saleRequest.current='';}}><option value="direct">بيعة مباشرة</option><option value="order">من طلبية متسعّرة</option></select></label>
        {mode==='order'&&<label className="field"><span>الطلبية</span><select required value={orderId} onChange={e=>{const o=options.orders.find(x=>x.id===e.target.value);setOrderId(e.target.value);setCustomerId(o?.customerId||'');saleRequest.current='';}}><option value="">اختار طلبية</option>{options.orders.map(o=><option key={o.id} value={o.id}>{o.customerName} · طلبية متسعّرة</option>)}</select></label>}
        <label className="field"><span>العميل</span><select required value={customerId} disabled={mode==='order'} onChange={e=>{setCustomerId(e.target.value);setLines(ls=>ls.map(l=>({...l,price:suggested(l.productId,e.target.value)})));saleRequest.current='';}}><option value="">اختار العميل</option>{options.customers.map(c=><option key={c.id} value={c.id}>{c.name}{c.phone?` · ${c.phone}`:''}</option>)}</select></label>
        <label className="field"><span>المخزن</span><select required value={warehouseId} onChange={e=>{setWarehouseId(e.target.value);saleRequest.current='';}}><option value="">اختار المخزن</option>{options.warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
      </div>
      {mode==='direct'?<div className="stack">{lines.map((l,i)=><div className="sale-line" key={l.key}>
        <label className="field"><span>الصنف {formatNumber(i+1)}</span><select required value={l.productId} onChange={e=>changeLine(l.key,{productId:e.target.value,price:suggested(e.target.value,customerId)})}><option value="">اختار الصنف</option>{options.products.map(p=><option key={p.id} value={p.id}>{p.name} · {p.unit} {p.unitSize}</option>)}</select></label>
        <label className="field"><span>الكمية</span><input required inputMode="decimal" value={l.qty} onChange={e=>changeLine(l.key,{qty:e.target.value})} /></label>
        <label className="field"><span>سعر الوحدة (ج.م)</span><input required inputMode="decimal" value={l.price} onChange={e=>changeLine(l.key,{price:e.target.value})} /></label>
        {lines.length>1&&<button type="button" className="btn ghost sm" onClick={()=>{setLines(v=>v.filter(x=>x.key!==l.key));saleRequest.current='';}}>إزالة الصنف</button>}
      </div>)}<button type="button" className="btn ghost sm" onClick={()=>{setLines(v=>[...v,emptyLine()]);saleRequest.current='';}}>إضافة صنف</button></div>:selectedOrder&&<ul className="sale-order-lines">{selectedOrder.lines.map(l=><li key={l.productId}>{l.name} · {qtyText(l.qty)} {l.unit} · {cash(l.price)} للوحدة</li>)}</ul>}
      {mode==='order'&&selectedOrder&&!validLines&&<p className="error">الطلبية فيها سعر بأكثر من رقمين عشريين أو كمية بأكثر من ٣ أرقام عشرية، ومينفعش نسجلها كبيعة من غير مراجعة المسؤول.</p>}
      <p className="muted small">قيمة كل صنف بتتقرب لأقرب قرش قبل جمع الإجمالي.</p>
      <div className="work-form"><label className="field"><span>المدفوع دلوقتي (ج.م)</span><input required inputMode="decimal" value={paid} onChange={e=>{setPaid(e.target.value);saleRequest.current='';}} placeholder="اكتب 0 لو كله آجل" /></label></div>
      <p><strong>الإجمالي: {validLines?cash(total):'اكتب الكميات والأسعار'}</strong>{validLines&&Number.isFinite(paidValue)&&paidValue<=total?` · الباقي: ${cash(Math.round((total-paidValue)*100)/100)}`:''}</p>
      <p className="muted small">بعد التأكيد، ما ينفعش تعديل البيعة من الشاشة دي.</p><button className="btn primary" disabled={busy}>تأكيد البيع وخصم المخزون</button>
      </form>}
      <div className="stats"><div className="stat"><span className="label">إجمالي البيعات المؤكدة</span><strong>{cash(report.sales)}</strong><small>{formatNumber(report.count)} بيعة</small></div><div className="stat"><span className="label">المدفوع المسجّل</span><strong>{cash(report.collected)}</strong><small>دفعات البيعات والتحصيلات المسجلة هنا</small></div><div className="stat"><span className="label">الباقي على العملاء</span><strong>{cash(report.due)}</strong><small>يشمل المديونية القديمة المسجلة</small></div></div>
      <p className="notice">الأرقام من العمليات المسجلة هنا فقط. الطلبيات المتسعّرة والتحصيلات القديمة مش مبيعات أو دفعات مؤكدة هنا؛ سجّل المديونية القديمة بعد مراجعتها.</p>
      <div className="panel"><h3>الباقي على العملاء</h3>{report.debtors.length===0?<p className="muted">مفيش مبالغ متبقية من العمليات المسجلة.</p>:<div className="kpi-table-wrap"><table className="kpi-table sales-table"><thead><tr><th>العميل</th><th>الباقي</th><th></th></tr></thead><tbody>{report.debtors.map(c=><tr key={c.id}><td>{c.name}{c.phone&&<small> · {c.phone}</small>}</td><td>{cash(c.due)}</td><td><button className="btn ghost sm" onClick={()=>{setReceiptCustomer(c.id);receiptRequest.current='';document.getElementById('sales-receipt')?.scrollIntoView({behavior:'smooth',block:'center'});}}>تسجيل دفعة</button></td></tr>)}</tbody></table></div>}
      <form id="sales-receipt" onSubmit={e=>void entry(e,'receipt')}><h4>تسجيل دفعة</h4><div className="work-form"><label className="field"><span>العميل</span><select required value={receiptCustomer} onChange={e=>{setReceiptCustomer(e.target.value);receiptRequest.current='';}}><option value="">اختار العميل</option>{report.debtors.map(c=><option key={c.id} value={c.id}>{c.name} · {cash(c.due)}</option>)}</select></label><label className="field"><span>المبلغ (ج.م)</span><input required inputMode="decimal" value={receiptAmount} onChange={e=>{setReceiptAmount(e.target.value);receiptRequest.current='';}} /></label><button className="btn primary sm" disabled={busy}>حفظ الدفعة</button></div></form>
      <details><summary>تسجيل مديونية قديمة</summary><p className="muted small">اكتب الرصيد القديم مرة واحدة لكل عميل بعد مراجعته، من غير البيعات المسجلة هنا. ما ينفعش تعدّله بعد الحفظ.</p><form onSubmit={e=>void entry(e,'opening')}><div className="work-form"><label className="field"><span>العميل للمديونية القديمة</span><select required value={openingCustomer} onChange={e=>{setOpeningCustomer(e.target.value);openingRequest.current='';}}><option value="">اختار العميل</option>{options.customers.filter(c=>!c.hasOpening).map(c=><option key={c.id} value={c.id}>{c.name}{c.phone?` · ${c.phone}`:''}</option>)}</select></label><label className="field"><span>الرصيد القديم (ج.م)</span><input required inputMode="decimal" value={openingAmount} onChange={e=>{setOpeningAmount(e.target.value);openingRequest.current='';}} /></label><button className="btn primary sm" disabled={busy}>حفظ المديونية القديمة</button></div></form></details></div>
      <div className="panel"><h3>المباع حسب الصنف</h3>{report.soldItems.length===0?<p className="muted">مفيش بيعات مؤكدة لسه.</p>:<div className="kpi-table-wrap"><table className="kpi-table sales-table"><thead><tr><th>الصنف</th><th>الكمية المباعة</th><th>قيمة البيع</th></tr></thead><tbody>{report.soldItems.map((p,i)=><tr key={i}><td>{p.name}</td><td>{qtyText(p.qty)} {p.unit} {p.unitSize}</td><td>{cash(p.amount)}</td></tr>)}</tbody></table></div>}</div>
      <div className="panel"><h3>الموجود في المخازن</h3>{report.stock.length===0?<p className="muted">ضيف مخزن وصنف عشان تظهر الأرصدة.</p>:<div className="kpi-table-wrap"><table className="kpi-table sales-table"><thead><tr><th>المخزن</th><th>الصنف</th><th>الرصيد</th></tr></thead><tbody>{report.stock.map(s=><tr key={`${s.warehouseId}:${s.productId}`}><td>{s.warehouseName}</td><td>{s.productName}</td><td>{s.qty===null?'الرصيد لم يُسجّل':`${qtyText(s.qty)} ${s.unit} ${s.unitSize}`}</td></tr>)}</tbody></table></div>}</div>
      <div className="panel"><h3>آخر البيعات</h3>{report.latest.length===0?<p className="muted">مفيش بيعات مؤكدة لسه.</p>:<div className="kpi-table-wrap"><table className="kpi-table sales-table"><thead><tr><th>العميل</th><th>المخزن</th><th>البيعة</th><th>المدفوع وقتها</th><th>التاريخ</th></tr></thead><tbody>{report.latest.map(s=><tr key={s.id}><td>{s.customerName}</td><td>{s.warehouseName}</td><td>{cash(s.total)}</td><td>{cash(s.paid)}</td><td>{dateTimeText(s.createdAt,timezone)}</td></tr>)}</tbody></table></div>}<p className="muted small">آخر ٥٠ بيعة؛ الإجماليات فوق لكل البيعات المسجلة.</p></div>
      {report.payments.length>0&&<div className="panel"><h3>آخر الدفعات</h3><ul className="stack-list">{report.payments.map((p,i)=><li key={i}>{p.customerName} · {cash(p.amount)} · {dateTimeText(p.createdAt,timezone)}</li>)}</ul><p className="muted small">آخر ٥٠ دفعة.</p></div>}
    </>}
  </section>;
}
