import { useReveal } from './useReveal';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, post } from './api';
import { dateTimeText } from './dates';
import { hasInputPrecision } from './decimal';
import { recommendationQty } from './quantity';
import { formatNumber } from './session';
import Products from './Products';
import SaleInvoice, {type Detail} from './SaleInvoice';
import SaleCorrection, {type CorrectionPayload} from './SaleCorrection';

type Customer = { id:string;name:string;phone:string;priceTierId:string|null;hasOpening:number };
type Product = { id:string;name:string;unit:string;unitSize:string };
type OrderLine = {productId:string;name:string;qty:number;price:number|null;unit:string;unitSize:string;notes:string};
type Options = {customers:Customer[];statementCustomers:{id:string;name:string;phone:string;active:number}[];products:Product[];warehouses:{id:string;name:string}[];reps:{id:string;name:string;region:string}[];prices:{productId:string;tierId:string;price:number}[];tiers:{id:string;name:string;active:number}[];orders:{id:string;customerId:string;customerName:string;status:'sent'|'priced';notes:string;total:number|null;sentAt:number;pricedAt:number|null;repName:string;lines:OrderLine[]}[]};
type Report = {count:number;sales:number;collected:number;due:number;credit:number;creditors:{id:string;name:string;credit:number}[];debtors:{id:string;name:string;phone:string;due:number}[];latest:{id:string;invoiceNumber:number;orderId:string|null;customerName:string;warehouseName:string;total:number;paid:number;createdAt:number;corrected:number}[];payments:{customerName:string;amount:number;createdAt:number;corrected:number}[];soldItems:{name:string;unit:string;unitSize:string;qty:number;amount:number}[];stock:{warehouseId:string;warehouseName:string;productId:string;productName:string;unit:string;unitSize:string;qty:number|null}[]};
type Statement={customer:{name:string;phone:string};opening:{amount:number;actorName:string;createdAt:number}|null;balance:number;due:number;credit:number;moreSales:boolean;moreReceipts:boolean;salesOffset:number;receiptsOffset:number;sales:{id:string;invoiceNumber:number;total:number;paid:number;warehouseName:string;actorName:string;repName:string;repSource:string;repDeleted:number;createdAt:number;corrected:boolean;lines:{name:string;unit:string;unitSize:string;qty:number;price:number;amount:number}[]}[];receipts:{id:string;amount:number;actorName:string;createdAt:number;corrected:boolean}[]};
type Line = {key:string;productId:string;qty:string;price:string;priceEdited:boolean};
const emptyLine=():Line=>({key:crypto.randomUUID(),productId:'',qty:'',price:'',priceEdited:false});
const parse = (text:string) => {const s=text.trim().replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace('٫','.');return /^\d+(\.\d+)?$/.test(s)?Number(s):NaN;};
const qtyText=(n:number)=>n.toLocaleString('ar-EG',{maximumFractionDigits:3});
const cash=(n:number)=>`${n.toLocaleString('ar-EG',{maximumFractionDigits:2})} ج.م`;
const err=(e:unknown)=>e instanceof Error?e.message:'حصل خطأ. حاول تاني.';

type Pending = {path:string; body:unknown; kind:'sale'|'receipt'|'opening'|'correction'};
export default function Sales({timezone,userId}:{timezone?:string;userId:string}) {
  const pendingKey=`mandoub.sales.pending.${userId}`;
  const operationPanel=useReveal<HTMLDivElement>();
  const errorPanel=useReveal<HTMLParagraphElement>();
  const [pending,setPending]=useState<Pending|null>(()=>{try {const raw=localStorage.getItem(pendingKey);return raw?JSON.parse(raw) as Pending:null;}catch{return null;}});
  const sending=useRef(false);
  const [view,setView]=useState<'summary'|'prices'|'advanced'>('summary');
  const [options,setOptions]=useState<Options|null>(null), [report,setReport]=useState<Report|null>(null);
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const showError=(text:string)=>{setError(text);errorPanel.reveal();};
  const [needsRefresh,setNeedsRefresh]=useState(false);
  const [review,setReview]=useState<'sale'|'receipt'|'opening'|null>(null);
  const [showSale,setShowSale]=useState(false),[mode,setMode]=useState<'direct'|'order'>('direct');
  const [repChoice,setRepChoice]=useState('');
  const [customerId,setCustomerId]=useState(''),[warehouseId,setWarehouseId]=useState(''),[orderId,setOrderId]=useState(''),[paid,setPaid]=useState(''),[lines,setLines]=useState<Line[]>([emptyLine()]);
  const [receiptCustomer,setReceiptCustomer]=useState(''),[receiptAmount,setReceiptAmount]=useState('');
  const [openingCustomer,setOpeningCustomer]=useState(''),[openingAmount,setOpeningAmount]=useState('');
  const [statementCustomer,setStatementCustomer]=useState(''),[statement,setStatement]=useState<Statement|null>(null),[statementBusy,setStatementBusy]=useState(false);
  const statementRequest=useRef(0),currentStatementCustomer=useRef(statementCustomer);currentStatementCustomer.current=statementCustomer;
  const [detail,setDetail]=useState<Detail|null>(null),[detailMode,setDetailMode]=useState<'invoice'|'correction'|null>(null);
  const [priceProduct,setPriceProduct]=useState(''),[priceTier,setPriceTier]=useState(''),[priceInput,setPriceInput]=useState('');
  const saleRequest=useRef(''),receiptRequest=useRef(''),openingRequest=useRef('');
  const load=useCallback(async()=>{statementRequest.current++;setStatementBusy(false);setStatement(null);setLoading(true);try {const [o,r]=await Promise.all([api<Options>('/api/sales/options'),api<Report>('/api/sales/overview')]);setOptions(o);setReport(r);setStatement(null);setNeedsRefresh(false);setError('');}catch(e){showError(err(e));}finally{setLoading(false);}},[]);
  useEffect(()=>{void load();return()=>{statementRequest.current++;};},[load]);
  const selectedOrder=options?.orders.find(o=>o.id===orderId);
  const currentLines = lines.map(l=>({qty:parse(l.qty),price:parse(l.price)}));
  const validLines=currentLines.length>0 && currentLines.every((l,i)=>Number.isFinite(l.qty)&&l.qty>0&&l.qty<=100_000&&hasInputPrecision(lines[i].qty,3)&&Number.isFinite(l.price)&&l.price>=0&&l.price<=1_000_000_000&&hasInputPrecision(lines[i].price,2));
  const total=validLines?currentLines.reduce((sum,l)=>sum+Number((BigInt(Math.round(l.qty*1000))*BigInt(Math.round(l.price*100))+500n)/1000n),0)/100:0;
  const paidValue=parse(paid);
  const changeLine=(key:string, patch:Partial<Line>)=>{saleRequest.current='';setLines(prev=>prev.map(line=>line.key===key?{...line,...patch}:line));};
  const suggested=(productId:string,customer:string)=>{const tier=options?.customers.find(c=>c.id===customer)?.priceTierId;const value=options?.prices.find(p=>p.productId===productId&&p.tierId===tier)?.price;return value===undefined?'':String(value);};
  const refreshAfter=async(success:string)=>{statementRequest.current++;setStatementBusy(false);setStatement(null);setMessage(success);try{const [o,r]=await Promise.all([api<Options>('/api/sales/options'),api<Report>('/api/sales/overview')]);setOptions(o);setReport(r);setNeedsRefresh(false);}catch{setNeedsRefresh(true);showError(`${success} لكن الشاشة ما اتحدّثتش. لازم تحدّث الأرقام قبل عملية جديدة.`);}};
  // Tabs on the same device share a single durable pending operation. Web Locks serializes
  // the read/write across tabs where supported; storage events also block other open tabs.
  useEffect(()=>{const sync=(event:StorageEvent)=>{if(event.key!==pendingKey)return;try{setPending(event.newValue?JSON.parse(event.newValue) as Pending:null);if(!event.newValue)setNeedsRefresh(true);}catch{showError('تعذر قراءة العملية المعلقة. راجع المسؤول قبل التسجيل.');}};window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);},[pendingKey]);
  async function sendOperation(operation:Pending) {
    if (sending.current) throw new Error('العملية لسه بتتحفظ.');
    if(!navigator.locks) throw new Error('المتصفح لا يدعم حماية العمليات بين التبويبات. افتح النظام بمتصفح حديث واتصال آمن.');
    sending.current=true;
    const run=async()=>{
      const raw=localStorage.getItem(pendingKey);
      if(raw && raw!==JSON.stringify(operation)) {
        try{setPending(JSON.parse(raw) as Pending);}catch{showError('تعذر قراءة العملية المعلقة. راجع المسؤول قبل التسجيل.');}
        throw new Error('في عملية معلقة على الجهاز. لازم تتأكد منها الأول.');
      }
      try {
        localStorage.setItem(pendingKey,JSON.stringify(operation));
        setPending(operation);operationPanel.reveal();
        await post(operation.path,operation.body);
        localStorage.removeItem(pendingKey);setPending(null);
      } catch(e) {
        // Authentication or a lost response might follow an earlier successful commit.
        if(e instanceof ApiError && e.status>=400 && e.status<500 && e.status!==401 && e.status!==403 && e.status!==408 && e.status!==429) {
          localStorage.removeItem(pendingKey);setPending(null);
        }
        throw e;
      }
    };
    try {await navigator.locks.request(pendingKey,{ifAvailable:true},async lock=>{if(!lock)throw new Error('في عملية تانية بتتحفظ على الجهاز. انتظر وحدّث الأرقام.');await run();});}
    finally {sending.current=false;}
  }
  async function retryPending(){if(!pending)return;setBusy(true);setError('');try {
    await sendOperation(pending);setReview(null);setDetail(null);setDetailMode(null);saleRequest.current='';receiptRequest.current='';openingRequest.current='';
    setShowSale(false);setRepChoice('');setLines([emptyLine()]);setPaid('');setOrderId('');setReceiptCustomer('');setReceiptAmount('');setOpeningCustomer('');setOpeningAmount('');
    await refreshAfter('اتأكدنا من العملية واتحدّثت الأرقام.');
  }catch(e){if(e instanceof ApiError && ['ORDER_CHANGED','ORDER_SOLD','ORDER'].includes(e.code??'')){setReview(null);setShowSale(false);setOrderId('');setNeedsRefresh(true);}showError(err(e));}finally{setBusy(false);}}
  function saveSale(event:FormEvent) {event.preventDefault();setError('');setMessage('');
    if(!validLines || !Number.isFinite(paidValue) || paidValue<0 || paidValue>total || !hasInputPrecision(paid,2)){showError('راجع الكميات والأسعار والمبلغ المدفوع: الكمية حتى ٣ أرقام عشرية، والمبالغ حتى رقمين.');return;}
    if(mode==='direct' && (lines.some(l=>!l.productId) || new Set(lines.map(l=>l.productId)).size!==lines.length)){showError('اختار كل صنف مرة واحدة.');return;}
    if(mode==='order' && !selectedOrder){showError('اختار طلبية مرسلة.');return;}
    setReview('sale');operationPanel.reveal();
  }
  function entry(event:FormEvent,kind:'receipt'|'opening'){event.preventDefault();setError('');setMessage('');const value=parse(kind==='receipt'?receiptAmount:openingAmount);
    if(!Number.isFinite(value)||value<0||value>1_000_000_000||(kind==='receipt'&&value===0)||!hasInputPrecision(kind==='receipt'?receiptAmount:openingAmount,2)){showError('اكتب مبلغ صحيح بالجنيه والقرش.');return;}
    if(kind==='receipt' && value>(report?.debtors.find(c=>c.id===receiptCustomer)?.due??0)){showError('الدفعة أكبر من المبلغ المسجّل على العميل.');return;}
    setReview(kind);operationPanel.reveal();
  }
  async function confirmReview(){if(!review)return;setError('');setMessage('');setBusy(true);
    try {
      if(review==='sale'){
        const body={id:saleRequest.current||(saleRequest.current=crypto.randomUUID()),customerId,warehouseId,paid:paidValue,...(mode==='order'?{orderId,lines:lines.map(l=>({productId:l.productId,qty:parse(l.qty),price:parse(l.price)}))}:{repId:repChoice==='none'?null:repChoice,lines:lines.map(l=>({productId:l.productId,qty:parse(l.qty),price:parse(l.price)}))})};
        await sendOperation({path:'/api/sales',body,kind:'sale'});saleRequest.current='';setPaid('');setOrderId('');setLines([emptyLine()]);setShowSale(false);setRepChoice('');setReview(null);await refreshAfter('الفاتورة اتسجلت واتخصمت الكمية من المخزن.');
      } else {
        const ref=review==='receipt'?receiptRequest:openingRequest;
        await sendOperation({path:`/api/sales/${review==='receipt'?'receipts':'opening'}`,body:{id:ref.current||(ref.current=crypto.randomUUID()),customerId:review==='receipt'?receiptCustomer:openingCustomer,amount:parse(review==='receipt'?receiptAmount:openingAmount)},kind:review});
        ref.current='';if(review==='receipt'){setReceiptAmount('');setReceiptCustomer('');}else{setOpeningAmount('');setOpeningCustomer('');}
        const success=review==='receipt'?'الدفعة اتحفظت.':'المديونية القديمة اتحفظت.';setReview(null);await refreshAfter(success);
      }
    }catch(e){if(e instanceof ApiError && ['ORDER_CHANGED','ORDER_SOLD','ORDER'].includes(e.code??'')){setReview(null);setShowSale(false);setOrderId('');setNeedsRefresh(true);}showError(err(e));}finally{setBusy(false);}
  }
  async function showStatement(salesOffset=0,receiptsOffset=0){if(!statementCustomer)return;const customer=statementCustomer,request=++statementRequest.current;setStatementBusy(true);setError('');try{const result=await api<Statement>(`/api/sales/statement/${encodeURIComponent(customer)}?salesOffset=${salesOffset}&receiptsOffset=${receiptsOffset}`);if(request===statementRequest.current&&currentStatementCustomer.current===customer)setStatement(result);}catch(e){if(request===statementRequest.current&&currentStatementCustomer.current===customer){setStatement(null);showError(err(e));}}finally{if(request===statementRequest.current&&currentStatementCustomer.current===customer)setStatementBusy(false);}}
  async function openDetail(type:'sale'|'receipt',id:string,mode:'invoice'|'correction') {setError('');setMessage('');setBusy(true);try {
    const d=await api<Detail>(`/api/sales/corrections/${type}/${encodeURIComponent(id)}`);setDetail(d);setDetailMode(mode);operationPanel.reveal();
  }catch(e){showError(err(e));}finally{setBusy(false);}}
  async function saveCorrection(values:CorrectionPayload) {if(!detail)return;setError('');setBusy(true);try{
    await sendOperation({path:`/api/sales/corrections/${detail.type}/${encodeURIComponent(detail.record.id)}`,body:{id:crypto.randomUUID(),...values},kind:'correction'});
    setDetail(null);setDetailMode(null);await refreshAfter('التصحيح اتحفظ. راجع الحساب بعد التحديث.');
  }catch(e){showError(err(e));}finally{setBusy(false);}}
  async function savePrice(event:FormEvent){event.preventDefault();setError('');setMessage('');const value=parse(priceInput);if(!Number.isFinite(value)||value<0||value>1_000_000_000||!hasInputPrecision(priceInput,2)){showError('اكتب سعر صحيح بالجنيه والقرش.');return;}setBusy(true);try{
    await api(`/api/products/${priceProduct}/prices`,{method:'PUT',body:JSON.stringify({prices:[{tierId:priceTier,price:value}]})});await refreshAfter('السعر اتحفظ.');
  }catch(e){showError(err(e));}finally{setBusy(false);}}
  const selectPrice=(product:string,tier:string)=>{setPriceProduct(product);setPriceTier(tier);const value=options?.prices.find(p=>p.productId===product&&p.tierId===tier)?.price;setPriceInput(value===undefined?'':String(value));};
  return <section className="page sales-page">
    <header className="page-head"><div><h2>المبيعات والمخزون</h2><p className="muted">تابع البيعات والباقي على العملاء وأرصدة المخازن.</p></div><div className="filters">
      <button className="btn ghost sm" disabled={!!pending||!!review||!!detailMode||needsRefresh||busy} onClick={()=>{setView(view==='prices'?'summary':'prices');setError('');setMessage('');}}>{view==='prices'?'رجوع للملخص':'تعديل الأسعار'}</button>
      {view==='summary'&&!pending&&!review&&!detailMode&&!needsRefresh&&<button className="btn primary" onClick={()=>{setShowSale(!showSale);setError('');setMessage('');}}>{showSale?'إغلاق':'تسجيل فاتورة'}</button>}
    </div></header>
    {error&&<p className="error reveal-target" ref={errorPanel.ref} tabIndex={-1} role="alert">{error}</p>}{message&&<p className="ok-text" role="status">{message}</p>}
    {pending?<div className="panel reveal-target" tabIndex={-1} ref={operationPanel.ref}><h3>عملية محتاجة تأكيد</h3><p>الاتصال وقف قبل ما نتأكد من حفظ {pending.kind==='sale'?'الفاتورة':pending.kind==='receipt'?'الدفعة':pending.kind==='correction'?'التصحيح':'المديونية القديمة'}. اضغط تأكيد العملية لإعادة إرسال نفس الطلب بأمان، من غير تكرار.</p><button className="btn primary" disabled={busy} onClick={()=>void retryPending()}>تأكيد العملية</button></div>:needsRefresh?<div className="panel"><h3>لازم نحدّث الأرقام الأول</h3><p>العملية اتحفظت، لكن الأرقام المعروضة ممكن تكون قديمة. حدّثها قبل أي عملية جديدة.</p><button className="btn primary" disabled={loading} onClick={()=>void load()}>تحديث الأرقام</button></div>:loading&&!options?<p>جارٍ التحميل…</p>:!options||!report?<button className="btn ghost sm" onClick={()=>void load()}>حاول تاني</button> :review?<div className="panel reveal-target" ref={operationPanel.ref} tabIndex={-1} aria-label="مراجعة العملية"><h3>راجع البيانات قبل الحفظ</h3>
      {review==='sale'?<>
        <p><strong>العميل:</strong> {options.customers.find(c=>c.id===customerId)?.name} {options.customers.find(c=>c.id===customerId)?.phone} · رقم {customerId.slice(-6)}</p>
        <p><strong>المخزن:</strong> {options.warehouses.find(w=>w.id===warehouseId)?.name}</p>
        <p><strong>المهندس:</strong> {mode==='order'?selectedOrder?.repName:repChoice==='none'?'بدون مهندس':options.reps.find(r=>r.id===repChoice)?.name}</p>
        {mode==='order'&&selectedOrder&&<p><strong>الطلبية:</strong> {dateTimeText(selectedOrder.sentAt,timezone)} · رقم {selectedOrder.id.slice(-8)}</p>}
        <ul className="sale-order-lines">{(lines.map(l=>{const p=mode==='order'?selectedOrder?.lines.find(x=>x.productId===l.productId):options.products.find(x=>x.id===l.productId);return {productId:l.productId,name:p?.name??'',unit:p?.unit??'',unitSize:p?.unitSize??'',qty:parse(l.qty),price:parse(l.price)};})).map(l=><li key={l.productId}><strong>{l.name}</strong> · {qtyText(l.qty)} {l.unit} {l.unitSize} × {cash(l.price)} للوحدة{mode==='order'&&selectedOrder&&` · ترشيح المهندس: ${recommendationQty(selectedOrder.lines.find(x=>x.productId===l.productId)!.qty)}`}</li>)}</ul>
        {mode==='order'&&selectedOrder&&selectedOrder.lines.some(l=>!lines.some(x=>x.productId===l.productId))&&<p className="notice">أصناف مستبعدة من الفاتورة: {selectedOrder.lines.filter(l=>!lines.some(x=>x.productId===l.productId)).map(l=>l.name).join('، ')}. ترشيح المهندس الأصلي محفوظ.</p>}
        <p><strong>الإجمالي: {cash(total)} · المدفوع الآن: {cash(paidValue)} · الباقي من الفاتورة: {cash(Math.round((total-paidValue)*100)/100)}</strong></p>
        {!options.customers.find(c=>c.id===customerId)?.hasOpening&&<p className="notice">المديونية القديمة للعميل لسه ما اتسجلتش؛ الباقي المسجّل قد لا يكون الرصيد الحقيقي.</p>}{mode==='direct'&&options.orders.some(o=>o.customerId===customerId)&&<p className="notice">تأكد إن الفاتورة دي مش نفس طلبية مرسلة للعميل.</p>}<p className="notice">بعد التأكيد هيتخصم المخزون، والفاتورة لا يمكن تعديلها مباشرة؛ التصحيح مسجل ومراجع. راجع العميل والأصناف والمبلغ كويس.</p>
      </>:<>
        <p><strong>العميل:</strong> {(review==='receipt'?report.debtors.find(c=>c.id===receiptCustomer):options.customers.find(c=>c.id===openingCustomer))?.name} · رقم {(review==='receipt'?receiptCustomer:openingCustomer).slice(-6)}</p>
        {review==='receipt'?<>{!options.customers.find(c=>c.id===receiptCustomer)?.hasOpening&&<p className="notice">المديونية القديمة للعميل لسه ما اتسجلتش؛ الباقي المسجّل قد لا يكون الرصيد الحقيقي.</p>}<p><strong>الباقي المسجّل قبل الدفعة:</strong> {cash(report.debtors.find(c=>c.id===receiptCustomer)?.due??0)}</p><p><strong>الدفعة:</strong> {cash(parse(receiptAmount))} · <strong>الباقي بعدها:</strong> {cash(Math.round(((report.debtors.find(c=>c.id===receiptCustomer)?.due??0)-parse(receiptAmount))*100)/100)}</p></>:<><p><strong>المديونية القديمة:</strong> {cash(parse(openingAmount))}</p><p className="notice">تتسجل مرة واحدة ولا يمكن تعديلها من الشاشة. تأكد إنها لا تشمل البيعات المسجلة هنا.</p></>}
      </>}
      <div className="filters"><button className="btn primary" disabled={busy} onClick={()=>void confirmReview()}>تأكيد وحفظ</button><button className="btn ghost" disabled={busy} onClick={()=>{setReview(null);setError('');}}>رجوع للتعديل</button></div>
    </div>:detail&&detailMode==='invoice'?<div className="reveal-target" tabIndex={-1} ref={operationPanel.ref}><SaleInvoice key={detail.version} detail={detail} timezone={timezone} onRefresh={setDetail} onBack={()=>{setDetail(null);setDetailMode(null);}}/></div>:detail&&detailMode==='correction'?<div className="reveal-target" tabIndex={-1} ref={operationPanel.ref}><SaleCorrection key={`${detail.type}:${detail.record.id}:${detail.revision}`} detail={detail} timezone={timezone} busy={busy} onBack={()=>{setDetail(null);setDetailMode(null);}} onSave={saveCorrection}/></div>:view==='advanced'?<><button className="btn ghost sm" onClick={()=>{setView('prices');void load();}}>رجوع للتسعير</button><Products timezone={timezone} /></>:view==='prices'?<>
      <form className="panel" onSubmit={savePrice}><h3>تعديل سعر صنف</h3><div className="work-form">
        <label className="field"><span>الصنف</span><select required value={priceProduct} onChange={e=>selectPrice(e.target.value,priceTier)}><option value="">اختار الصنف</option>{options.products.map(p=><option key={p.id} value={p.id}>{p.name} · {p.unit} {p.unitSize}</option>)}</select></label>
        <label className="field"><span>نوع السعر</span><select required value={priceTier} onChange={e=>selectPrice(priceProduct,e.target.value)}><option value="">اختار نوع السعر</option>{options.tiers.filter(t=>t.active).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label className="field"><span>سعر العبوة (ج.م)</span><input required inputMode="decimal" value={priceInput} onChange={e=>setPriceInput(e.target.value)} placeholder="اكتب السعر" /></label>
        <button className="btn primary" disabled={busy}>حفظ السعر</button>
      </div><p className="muted small">السعر للعبوة المكتوبة، وبيتقترح حسب نوع سعر العميل. تقدر تغيّره عند البيع.</p></form>
      <button className="btn ghost sm" onClick={()=>setView('advanced')}>إدارة الأصناف وأنواع الأسعار</button>
    </>:<>
      {showSale&&<form className="panel" onSubmit={saveSale}><h3>تسجيل فاتورة</h3><p className="muted small">تأكيد الفاتورة بيسجّل البيع وبيخصم الكمية من المخزن. فريق المبيعات يحدد الأسعار هنا.</p><div className="work-form">
        <label className="field"><span>نوع الفاتورة</span><select value={mode} onChange={e=>{setMode(e.target.value as typeof mode);setOrderId('');setCustomerId('');setRepChoice('');setLines([emptyLine()]);saleRequest.current='';}}><option value="direct">فاتورة مباشرة</option><option value="order">من طلبية مرسلة</option></select></label>
        {mode==='order'&&<label className="field"><span>الطلبية</span><select required value={orderId} onChange={e=>{const o=options.orders.find(x=>x.id===e.target.value);setOrderId(e.target.value);setCustomerId(o?.customerId||'');setLines(o?o.lines.map(l=>({key:l.productId,productId:l.productId,qty:String(l.qty),price:suggested(l.productId,o.customerId),priceEdited:false})):[emptyLine()]);saleRequest.current='';}}><option value="">اختار طلبية</option>{options.orders.map(o=><option key={o.id} value={o.id}>{o.customerName} · {o.repName} · {dateTimeText(o.sentAt,timezone)} · مرسلة · {o.id.slice(-8)}</option>)}</select></label>}
        <label className="field"><span>العميل</span><select required value={customerId} disabled={mode==='order'} onChange={e=>{setCustomerId(e.target.value);setLines(ls=>ls.map(l=>l.priceEdited?l:{...l,price:suggested(l.productId,e.target.value)}));saleRequest.current='';}}><option value="">اختار العميل</option>{options.customers.map(c=><option key={c.id} value={c.id}>{c.name}{c.phone?` · ${c.phone}`:''} · رقم {c.id.slice(-6)}</option>)}</select></label>
        {mode==='direct'?<label className="field"><span>المهندس المسؤول</span><select required value={repChoice} onChange={e=>{setRepChoice(e.target.value);saleRequest.current='';}}><option value="">اختار المهندس أو بدون مهندس</option><option value="none">بدون مهندس</option>{options.reps.map(r=><option key={r.id} value={r.id}>{r.name} · {r.region} · {r.id.slice(-6)}</option>)}</select></label>:selectedOrder&&<p><strong>مهندس الطلبية:</strong> {selectedOrder.repName}</p>}
        <label className="field"><span>المخزن</span><select required value={warehouseId} onChange={e=>{setWarehouseId(e.target.value);saleRequest.current='';}}><option value="">اختار المخزن</option>{options.warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
      </div>
      {mode==='direct'&&customerId&&options.orders.some(o=>o.customerId===customerId)&&<p className="notice">للعميل طلبيات مرسلة لم تُسجّل لها فاتورة. لو دي نفس العملية، اختار «من طلبية مرسلة» عشان ما تتكررش.</p>}
      {mode==='direct'?<div className="stack">{lines.map((l,i)=><div className="sale-line" key={l.key}>
        <label className="field"><span>الصنف {formatNumber(i+1)}</span><select required value={l.productId} onChange={e=>changeLine(l.key,{productId:e.target.value,price:suggested(e.target.value,customerId),priceEdited:false})}><option value="">اختار الصنف</option>{options.products.map(p=><option key={p.id} value={p.id}>{p.name} · {p.unit} {p.unitSize}</option>)}</select></label>
        <label className="field"><span>الكمية</span><input required inputMode="decimal" value={l.qty} onChange={e=>changeLine(l.key,{qty:e.target.value})} /></label>
        <label className="field"><span>سعر الوحدة (ج.م)</span><input required inputMode="decimal" value={l.price} onChange={e=>changeLine(l.key,{price:e.target.value,priceEdited:true})} /></label>
        {lines.length>1&&<button type="button" className="btn ghost sm" onClick={()=>{setLines(v=>v.filter(x=>x.key!==l.key));saleRequest.current='';}}>إزالة الصنف</button>}
      </div>)}<button type="button" className="btn ghost sm" onClick={()=>{setLines(v=>[...v,emptyLine()]);saleRequest.current='';}}>إضافة صنف</button></div>:selectedOrder&&<div className="stack">
        {selectedOrder.notes&&<p className="notice">ملاحظة المهندس: {selectedOrder.notes}</p>}
          <p className="muted small">كمية المهندس للترشيح فقط ومحفوظة كما أرسلها. اكتب الكمية المباعة بحد أقصى ٣ أرقام بعد العلامة العشرية، وحدد السعر، أو استبعد صنفًا لم يُبع.</p>
          {selectedOrder.lines.map(l=>{const edit=lines.find(x=>x.productId===l.productId);return <div className="sale-line" key={l.productId}>
            <label><input type="checkbox" checked={!!edit} onChange={e=>{saleRequest.current='';setLines(prev=>e.target.checked?[...prev,{key:l.productId,productId:l.productId,qty:String(l.qty),price:suggested(l.productId,selectedOrder.customerId),priceEdited:false}]:prev.filter(x=>x.productId!==l.productId));}} /> بيع {l.name}</label>
            <span>ترشيح المهندس: {recommendationQty(l.qty)} {l.unit} {l.unitSize}{l.notes?` · ${l.notes}`:''}</span>
            {edit&&<><label className="field"><span>الكمية المباعة · {l.name}</span><input required inputMode="decimal" value={edit.qty} onChange={e=>changeLine(edit.key,{qty:e.target.value})} /></label>
            <label className="field"><span>سعر الوحدة · {l.name} (ج.م)</span><input required inputMode="decimal" value={edit.price} onChange={e=>changeLine(edit.key,{price:e.target.value,priceEdited:true})} /></label></>}
          </div>;})}
      </div>}
      {mode==='order'&&selectedOrder&&!validLines&&<p className="error">اختار صنفًا على الأقل واكتب كمية صحيحة وسعرًا بالجنيه والقرش لكل صنف مباع.</p>}
      <p className="muted small">قيمة كل صنف بتتقرب لأقرب قرش قبل جمع الإجمالي.</p>
      <div className="work-form"><label className="field"><span>المدفوع دلوقتي (ج.م)</span><input required inputMode="decimal" value={paid} onChange={e=>{setPaid(e.target.value);saleRequest.current='';}} placeholder="اكتب 0 لو كله آجل" /></label></div>
      <p><strong>الإجمالي: {validLines?cash(total):'اكتب الكميات والأسعار'}</strong>{validLines&&Number.isFinite(paidValue)&&paidValue<=total?` · الباقي: ${cash(Math.round((total-paidValue)*100)/100)}`:''}</p>
      <p className="muted small">بعد التأكيد، لا يمكن تعديل الفاتورة مباشرة؛ أي تصحيح يتسجل بسبب واضح.</p><button className="btn primary" disabled={busy}>مراجعة الفاتورة</button>
      </form>}
      <div className="stats"><div className="stat"><span className="label">صافي الفواتير المسجّلة</span><strong>{cash(report.sales)}</strong><small>{formatNumber(report.count)} فاتورة</small></div><div className="stat"><span className="label">المدفوع المسجّل</span><strong>{cash(report.collected)}</strong><small>بعد تصحيح المبالغ وردها</small></div><div className="stat"><span className="label">الباقي المسجّل على العملاء</span><strong>{cash(report.due)}</strong><small>يشمل المديونية القديمة المسجلة</small></div></div>
      <p className="notice">الأرقام من العمليات المسجلة هنا فقط. ترشيحات المهندسين والتحصيلات القديمة مش فواتير أو دفعات مؤكدة هنا؛ سجّل المديونية القديمة بعد مراجعتها، حتى لو صفر. لو ما تسجلتش، الباقي المعروض مش بالضرورة الرصيد الحقيقي. صافي البيعات بعد التصحيحات الحالية.</p>
      <div className="panel"><h3>الباقي على العملاء</h3>{report.debtors.length===0?<p className="muted">مفيش مبالغ متبقية من العمليات المسجلة.</p>:<div className="kpi-table-wrap"><table className="kpi-table sales-table"><thead><tr><th>العميل</th><th>الباقي</th><th></th></tr></thead><tbody>{report.debtors.map(c=><tr key={c.id}><td>{c.name}{c.phone&&<small> · {c.phone}</small>} <small>· رقم {c.id.slice(-6)}</small></td><td>{cash(c.due)}</td><td><button className="btn ghost sm" onClick={()=>{setReceiptCustomer(c.id);receiptRequest.current='';document.getElementById('sales-receipt')?.scrollIntoView({behavior:'smooth',block:'center'});}}>تسجيل دفعة</button></td></tr>)}</tbody></table></div>}
      <form id="sales-receipt" onSubmit={e=>void entry(e,'receipt')}><h4>تسجيل دفعة</h4><div className="work-form"><label className="field"><span>العميل</span><select required value={receiptCustomer} onChange={e=>{setReceiptCustomer(e.target.value);receiptRequest.current='';}}><option value="">اختار العميل</option>{report.debtors.map(c=><option key={c.id} value={c.id}>{c.name}{c.phone?` · ${c.phone}`:''} · رقم {c.id.slice(-6)} · {cash(c.due)}</option>)}</select></label><label className="field"><span>المبلغ (ج.م)</span><input required inputMode="decimal" value={receiptAmount} onChange={e=>{setReceiptAmount(e.target.value);receiptRequest.current='';}} /></label><button className="btn primary sm" disabled={busy}>مراجعة الدفعة</button></div></form>
      <details><summary>تسجيل مديونية قديمة</summary><p className="muted small">اكتب الرصيد القديم مرة واحدة لكل عميل بعد مراجعته، من غير البيعات المسجلة هنا. ما ينفعش تعدّله بعد الحفظ.</p><form onSubmit={e=>void entry(e,'opening')}><div className="work-form"><label className="field"><span>العميل للمديونية القديمة</span><select required value={openingCustomer} onChange={e=>{setOpeningCustomer(e.target.value);openingRequest.current='';}}><option value="">اختار العميل</option>{options.customers.filter(c=>!c.hasOpening).map(c=><option key={c.id} value={c.id}>{c.name}{c.phone?` · ${c.phone}`:''} · رقم {c.id.slice(-6)}</option>)}</select></label><label className="field"><span>الرصيد القديم (ج.م)</span><input required inputMode="decimal" value={openingAmount} onChange={e=>{setOpeningAmount(e.target.value);openingRequest.current='';}} /></label><button className="btn primary sm" disabled={busy}>مراجعة المديونية</button></div></form></details></div>
      {report.credit>0&&<div className="panel"><h3>أرصدة لصالح العملاء: {cash(report.credit)}</h3><p>رصيد العميل بعد التصحيحات قد يكون لصالحه؛ ليس مبلغًا تم رده تلقائيًا.</p><ul>{report.creditors.map(c=><li key={c.id}>{c.name} · رقم {c.id.slice(-6)} · {cash(c.credit)}</li>)}</ul></div>}
      <div className="panel"><h3>مراجعة حساب عميل</h3><p className="muted small">شوف المديونية القديمة والبيعات والدفعات المسجلة هنا بالتفصيل.</p><div className="work-form">
        <label className="field"><span>العميل لمراجعة الحساب</span><select value={statementCustomer} onChange={e=>{statementRequest.current++;setStatementBusy(false);setStatementCustomer(e.target.value);setStatement(null);}}><option value="">اختار العميل</option>{options.statementCustomers.map(c=><option key={c.id} value={c.id}>{c.name}{c.phone?` · ${c.phone}`:''} · رقم {c.id.slice(-6)}{c.active?'':' · موقوف'}</option>)}</select></label>
        <button className="btn ghost sm" disabled={!statementCustomer||statementBusy} onClick={()=>void showStatement()}>عرض الحساب</button></div>
        {statement&&<div aria-label="حساب العميل"><h4>{statement.customer.name} {statement.customer.phone}</h4><p><strong>{statement.credit>0?`رصيد لصالح العميل: ${cash(statement.credit)}`:`الباقي المسجّل: ${cash(statement.due)}`}</strong></p>
        <p>المديونية القديمة: {statement.opening?`${cash(statement.opening.amount)} · ${statement.opening.actorName} · ${dateTimeText(statement.opening.createdAt,timezone)}`:'لم تُسجّل بعد — الباقي قد يكون غير مكتمل.'}</p>
        <h4>البيعات</h4>{!statement.sales.length?<p className="muted">لا توجد بيعات مسجلة.</p>:statement.sales.map(s=><details key={s.id}><summary>{dateTimeText(s.createdAt,timezone)} · {cash(s.total)} · فاتورة رقم {formatNumber(s.invoiceNumber)} · القيمة الأصلية{s.corrected?' · عليها تصحيحات':''}</summary><div className="filters"><button className="btn ghost sm" disabled={busy} onClick={()=>void openDetail('sale',s.id,'invoice')}>عرض الفاتورة</button><button className="btn ghost sm" disabled={busy} onClick={()=>void openDetail('sale',s.id,'correction')}>تصحيح أو تسجيل مرتجع</button></div><p>المخزن: {s.warehouseName} · المهندس: {s.repName||'غير محدد'}{s.repDeleted?' (حساب محذوف)':s.repSource==='legacy'?' (من الطلبية القديمة)':''} · المسجّل: {s.actorName} · المدفوع وقت البيع: {cash(s.paid)}</p><ul className="sale-order-lines">{s.lines.map((l,i)=><li key={i}>{l.name} · {qtyText(l.qty)} {l.unit} {l.unitSize} × {cash(l.price)} = {cash(l.amount)}</li>)}</ul></details>)}
        {(statement.moreSales||statement.salesOffset>0)&&<div className="filters"><button className="btn ghost sm" disabled={statementBusy||statement.salesOffset===0} onClick={()=>void showStatement(Math.max(0,statement.salesOffset-100),statement.receiptsOffset)}>بيعات أحدث</button><button className="btn ghost sm" disabled={statementBusy||!statement.moreSales} onClick={()=>void showStatement(statement.salesOffset+100,statement.receiptsOffset)}>بيعات أقدم</button></div>}<h4>الدفعات اللاحقة</h4>{!statement.receipts.length?<p className="muted">لا توجد دفعات لاحقة مسجلة.</p>:<ul className="stack-list">{statement.receipts.map(r=><li key={r.id}>{dateTimeText(r.createdAt,timezone)} · {cash(r.amount)} · {r.actorName} · رقم {r.id.slice(-8)} {r.corrected?'· عليها تصحيحات':''} <button className="btn ghost sm" disabled={busy} onClick={()=>void openDetail('receipt',r.id,'correction')}>تصحيح الدفعة</button></li>)}</ul>}{(statement.moreReceipts||statement.receiptsOffset>0)&&<div className="filters"><button className="btn ghost sm" disabled={statementBusy||statement.receiptsOffset===0} onClick={()=>void showStatement(statement.salesOffset,Math.max(0,statement.receiptsOffset-100))}>دفعات أحدث</button><button className="btn ghost sm" disabled={statementBusy||!statement.moreReceipts} onClick={()=>void showStatement(statement.salesOffset,statement.receiptsOffset+100)}>دفعات أقدم</button></div>}</div>}
      </div>
      <div className="panel"><h3>المباع حسب الصنف</h3>{report.soldItems.length===0?<p className="muted">مفيش فواتير مسجلة لسه.</p>:<div className="kpi-table-wrap"><table className="kpi-table sales-table"><thead><tr><th>الصنف</th><th>الكمية المباعة</th><th>قيمة البيع</th></tr></thead><tbody>{report.soldItems.map((p,i)=><tr key={i}><td>{p.name}</td><td>{qtyText(p.qty)} {p.unit} {p.unitSize}</td><td>{cash(p.amount)}</td></tr>)}</tbody></table></div>}</div>
      <div className="panel"><h3>الموجود في المخازن</h3>{report.stock.length===0?<p className="muted">ضيف مخزن وصنف عشان تظهر الأرصدة.</p>:<div className="kpi-table-wrap"><table className="kpi-table sales-table"><thead><tr><th>المخزن</th><th>الصنف</th><th>الرصيد</th></tr></thead><tbody>{report.stock.map(s=><tr key={`${s.warehouseId}:${s.productId}`}><td>{s.warehouseName}</td><td>{s.productName}</td><td>{s.qty===null?'الرصيد لم يُسجّل':`${qtyText(s.qty)} ${s.unit} ${s.unitSize}`}</td></tr>)}</tbody></table></div>}</div>
      <div className="panel"><h3>آخر الفواتير</h3>{report.latest.length===0?<p className="muted">مفيش فواتير مسجلة لسه.</p>:<div className="kpi-table-wrap"><table className="kpi-table sales-table"><thead><tr><th>رقم الفاتورة</th><th>العميل</th><th>المخزن</th><th>قيمة البيع وقت التسجيل</th><th>المدفوع وقت البيع</th><th>التاريخ</th></tr></thead><tbody>{report.latest.map(s=><tr key={s.id}><td>{formatNumber(s.invoiceNumber)}</td><td>{s.customerName}</td><td>{s.warehouseName}</td><td>{cash(s.total)} {s.corrected?'· عليها تصحيحات':''}</td><td>{cash(s.paid)}</td><td>{dateTimeText(s.createdAt,timezone)} <button className="btn ghost sm" disabled={busy} onClick={()=>void openDetail('sale',s.id,'invoice')}>الفاتورة</button></td></tr>)}</tbody></table></div>}<p className="muted small">آخر ٥٠ فاتورة؛ الإجماليات فوق لكل الفواتير المسجلة.</p></div>
      {report.payments.length>0&&<div className="panel"><h3>آخر الدفعات</h3><ul className="stack-list">{report.payments.map((p,i)=><li key={i}>{p.customerName} · {cash(p.amount)} · {dateTimeText(p.createdAt,timezone)} {p.corrected?'· عليها تصحيحات':''}</li>)}</ul><p className="muted small">آخر ٥٠ دفعة.</p></div>}
    </>}
  </section>;
}
