import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';
import { dateTimeText } from './dates';
import { recommendationQty } from './quantity';
import { formatNumber } from './session';

interface OrderLine { productId:string;productName:string;unit:string;unitSize:string;qty:number;notes:string }
interface OrderRow {
  id:string;customerName:string;customerPhone:string;customerActive:boolean;repName:string;repColor:string;
  status:'draft'|'sent'|'priced';sold:boolean;notes:string;recommendation:string;sentAt:number|null;recordedOffline:boolean;lines:OrderLine[];
}
type Filter='sent'|'all';

/** Recommendations are read-only: only sales invoices may contain prices. */
export default function Orders({timezone,version}:{timezone?:string;version:number;onDone:()=>void}) {
  const [filter,setFilter]=useState<Filter>('sent'),[offset,setOffset]=useState(0);
  const [result,setResult]=useState<{key:string;orders:OrderRow[];hasMore:boolean}|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const key=`${filter}:${offset}`,currentKey=useRef(key);currentKey.current=key;
  const ready=result?.key===key, orders=ready?result.orders:[];
  const requestId=useRef(0),pageSize=100;
  const load=useCallback(async()=>{
    const request=++requestId.current;setError('');setLoading(true);setResult(null);
    try {const data=await api<{orders:OrderRow[];hasMore:boolean}>(`/api/orders?${filter==='sent'?'status=sent&':''}limit=${pageSize}&offset=${offset}`);
      if(request===requestId.current&&currentKey.current===key)setResult({key,orders:data.orders,hasMore:data.hasMore});}
    catch(e){if(request===requestId.current&&currentKey.current===key)setError(e instanceof ApiError&&e.message?e.message:'تعذر تحميل الطلبيات.');}
    finally{if(request===requestId.current&&currentKey.current===key)setLoading(false);}
  },[filter,offset]);
  useEffect(()=>{void load();return()=>{requestId.current++;};},[load,version]);
  return <section className="panel orders-panel">
    <h2 className="panel-title">الطلبيات</h2>
    <p className="muted small">توصيات المهندسين بالأصناف والكميات فقط. فريق المبيعات يحدد الأسعار عند تسجيل الفاتورة.</p>
    <div className="tabs" role="tablist">{([{id:'sent',label:'مستنية فاتورة'},{id:'all',label:'الكل'}] as const).map(item=><button key={item.id} type="button" role="tab" aria-selected={filter===item.id} className={filter===item.id?'tab active':'tab'} onClick={()=>{if(filter!==item.id){setOffset(0);setLoading(true);setFilter(item.id);}}}>{item.label}</button>)}</div>
    {error&&<div><p className="error" role="alert">{error}</p><button className="btn ghost sm" disabled={loading} onClick={()=>void load()}>حاول تاني</button></div>}
    {!ready&&!error?<p className="empty">جارٍ تحميل الطلبيات…</p>:!ready?null:orders.length===0?<p className="empty">{filter==='sent'?'مفيش طلبية مستنية فاتورة حاليًا.':'مفيش طلبيات مسجلة لحد دلوقتي.'}</p>:<div className="order-cards">
      {orders.map(order=><article className="order-card" key={order.id}>
        <div className="order-card-head"><div><strong>{order.customerName}</strong>{order.customerPhone&&<small> · {order.customerPhone}</small>}</div><span className={order.sold?'pill ok':'pill warn'}>{order.sold?'اتسجلت لها فاتورة':'مستنية فاتورة'}</span></div>
        {!order.customerActive && !order.sold && <p className="notice">العميل موقوف؛ لا يمكن تسجيل فاتورة للطلبية حتى يعيد المكتب تفعيله.</p>}
        <p className="muted small">المهندس: {order.repName} · {order.sentAt?dateTimeText(order.sentAt,timezone):'—'}{order.recordedOffline?' · اتبعتت بعد رجوع الشبكة':''}</p>
        {order.recommendation?<p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}><strong>ترشيح المهندس:</strong> {order.recommendation}</p>:<ul>{order.lines.map(line=><li key={line.productId}><strong>{line.productName}</strong> · ترشيح {recommendationQty(line.qty)} {line.unit} {line.unitSize}{line.notes?` · ${line.notes}`:''}</li>)}</ul>}
        {order.notes&&<p className="muted small">ملاحظة المهندس: {order.notes}</p>}
      </article>)}
    </div>}
    {ready&&(offset>0||result.hasMore)&&<div className="confirm-pair" aria-label="صفحات الطلبيات"><button className="btn ghost sm" disabled={loading||offset===0} onClick={()=>{setLoading(true);setOffset(Math.max(0,offset-pageSize));}}>السابق</button><span className="muted small">صفحة {formatNumber(Math.floor(offset/pageSize)+1)}</span><button className="btn ghost sm" disabled={loading||!result.hasMore} onClick={()=>{setLoading(true);setOffset(offset+pageSize);}}>التالي</button></div>}
    <p className="muted small">لتسجيل فاتورة من طلبية، افتح المبيعات ثم «تسجيل فاتورة» واختار الطلبية.</p>
  </section>;
}
