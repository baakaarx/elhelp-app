import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { dayBefore, localDay } from './dates';
import { ago, formatNumber } from './session';
import type { ManagerAlert } from './types';

type Priorities = {
  orderCount:number; unassignedCustomers:number; openVisitCount:number; emptyStockCount:number; warehouses:number; uninitialized:number;
  waitingOrders:{id:string;customerName:string;repName:string;sentAt:number}[];
  openVisits:{id:string;customerName:string;repName:string;checkedInAt:number}[];
  emptyStock:{warehouseName:string;productName:string;unit:string;unitSize:string}[];
};
type Product = {id:string;name:string;unit:string;unitSize:string;qty:number;amount:number;consumers?:{id:string;name:string;phone:string;qty:number;amount:number}[]};
type Insights = {
  from:string;to:string;timezone:string;salesCount:number;customerCount:number;sales:number;unassignedCount:number;unassignedSales:number;legacyOrders:number;
  reps:{id:string;name:string;region:string;active:boolean;visits:number;orders:number;salesCount:number;sales:number;legacyOrders:number}[];
  customers:{id:string;name:string;phone:string;count:number;amount:number;items:Product[]}[];
  productsByValue:Product[];productsByQty:Product[];
};
const cash=(v:number)=>`${v.toLocaleString('ar-EG',{maximumFractionDigits:2})} ج.م`;
const quantity=(v:number)=>v.toLocaleString('ar-EG',{maximumFractionDigits:3});

export default function AgentPanel({ alerts, onNavigate, timezone }: { alerts:ManagerAlert[]; onNavigate:(tab:'reports'|'customers'|'live'|'warehouses')=>void;timezone?:string }) {
  const [priorities,setPriorities]=useState<Priorities|null>(null), [priorityError,setPriorityError]=useState('');
  const [range,setRange]=useState<{from:string;to:string}|null>(null);
  const from=range?.from??dayBefore(29,timezone), to=range?.to??localDay(timezone);
  const [data,setData]=useState<Insights|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const requestVersion=useRef(0);
  const load=useCallback(async()=>{
    if(!timezone)return;
    const version=++requestVersion.current;
    setLoading(true);setError('');setData(null);
    try{const result=await api<Insights>(`/api/sales-insights?${new URLSearchParams({from,to})}`);if(version===requestVersion.current)setData(result);}
    catch(e){if(version===requestVersion.current)setError(e instanceof Error?e.message:'تعذر تحميل التحليل.');}
    finally{if(version===requestVersion.current)setLoading(false);}
  },[from,to,timezone]);
  const loadPriorities=useCallback(async()=>{try{setPriorities(await api<Priorities>('/api/work-priorities'));setPriorityError('');}catch(e){setPriorityError(e instanceof Error?e.message:'تعذر تحميل الأولويات.');}},[]);
  useEffect(()=>{void load();return()=>{requestVersion.current++;};},[load]);
  useEffect(()=>{void loadPriorities();},[loadPriorities]);
  const fieldAlerts=alerts.filter(a=>a.code!=='orders_awaiting_pricing');
  const preset=(days:number)=>{if(timezone)setRange({from:dayBefore(days-1,timezone),to:localDay(timezone)});};
  return <section className="page agent-insights"><header className="page-head"><div><h2>تحليل المبيعات والأداء</h2><p className="muted">أرقام محسوبة من البيانات المسجلة؛ المساعد لا ينفّذ عمليات من نفسه.</p></div><button className="btn ghost sm" onClick={()=>{void load();void loadPriorities();}} disabled={loading||!timezone}>تحديث التحليل</button></header>
    <div className="panel"><div className="filters"><button className="btn ghost sm" onClick={()=>preset(1)} disabled={!timezone}>اليوم</button><button className="btn ghost sm" onClick={()=>preset(7)} disabled={!timezone}>٧ أيام</button><button className="btn ghost sm" onClick={()=>preset(30)} disabled={!timezone}>٣٠ يوم</button>
      <label className="field inline"><span>من</span><input type="date" value={from} max={to} disabled={!timezone} onChange={e=>setRange({from:e.target.value,to})}/></label>
      <label className="field inline"><span>إلى</span><input type="date" value={to} min={from} max={timezone?localDay(timezone):undefined} disabled={!timezone} onChange={e=>setRange({from,to:e.target.value})}/></label></div></div>
    {error&&<p className="error" role="alert">{error}</p>}{loading||!timezone?<p className="muted">جارٍ حساب الأرقام…</p>:data&&<>
      <div className="stats"><div className="stat"><span className="label">قيمة البيعات المؤكدة</span><strong>{cash(data.sales)}</strong><small>{formatNumber(data.salesCount)} بيعة في الفترة</small></div><div className="stat"><span className="label">بيع من غير مهندس محدد</span><strong>{cash(data.unassignedSales)}</strong><small>{formatNumber(data.unassignedCount)} بيعة غير منسوبة</small></div><div className="stat"><span className="label">عملاء اشتروا</span><strong>{formatNumber(data.customerCount)}</strong><small>المعروض أعلى ١٠ عملاء</small></div></div>
      <p className="notice">المبيعات حسب تاريخ تأكيد البيعة وصافي حالتها الحالية بعد التصحيحات، حتى لو التصحيح حصل بعد الفترة. مش الطلبيات المتسعّرة أو التحصيل. ما بنحسبش الربح لأن تكلفة الشراء غير مسجّلة.</p>
      <div className="panel"><h3>أداء المهندسين</h3><p className="muted small">الزيارات بتاريخ الزيارة، والطلبيات بتاريخ إرسالها، والبيعات بتاريخ تأكيدها. دي أرقام منفصلة وما بتتجمعش على بعض.</p>
        {data.reps.length===0?<p className="muted">لسه مفيش مهندسين مسجلين.</p>:<div className="kpi-table-wrap"><table className="kpi-table"><thead><tr><th>المهندس</th><th>المنطقة</th><th>الزيارات</th><th>طلبيات مرسلة</th><th>بيعات مؤكدة</th><th>قيمة البيعات</th></tr></thead><tbody>{data.reps.map(r=><tr key={r.id}><td>{r.name}{!r.active&&' · موقوف'}</td><td>{r.region||'—'}</td><td>{formatNumber(r.visits)}</td><td>{formatNumber(r.orders)}</td><td>{formatNumber(r.salesCount)}</td><td>{cash(r.sales)}</td></tr>)}</tbody></table></div>}
        <p className="muted small">بيعة الطلبية للمهندس اللي سجّلها؛ البيعة المباشرة للمهندس المختار وقت البيع. {data.legacyOrders>0?`${formatNumber(data.legacyOrders)} بيعة قديمة نُسبت لمهندس الطلبية المحفوظة. `:''}البيعات من غير مهندس، أو اللي فقدت بيانات المهندس القديم، ظاهرة في الإجمالي غير المنسوب. الزيارات المتاحة حسب مدة الاحتفاظ.</p></div>
      <div className="panel"><h3>أعلى العملاء شراءً بالقيمة</h3><p className="muted small">افتح العميل لتشوف الكمية المباعة من كل صنف؛ ما بنجمعش وحدات مختلفة كأنها وحدة واحدة.</p>
        {data.customers.length===0?<p className="muted">مفيش بيعات مؤكدة في الفترة.</p>:data.customers.map(c=><details key={c.id} className="insight-customer"><summary>{c.name}{c.phone?` · ${c.phone}`:''} · رقم {c.id.slice(-6)} · {cash(c.amount)} · {formatNumber(c.count)} بيعة</summary><ul className="sale-order-lines">{c.items.map(p=><li key={`${p.id}:${p.unit}:${p.unitSize}`}>{p.name} · {quantity(p.qty)} {p.unit} {p.unitSize} · {cash(p.amount)}</li>)}</ul><p className="muted small">أعلى ١٠ أصناف للعميل حسب القيمة.</p></details>)}</div>
      <ProductTable title="الأصناف الأعلى مبيعًا بالقيمة" rows={data.productsByValue} note="افتح أي صنف لتشوف العملاء الأكثر شراءً له بالكمية." />
      <ProductTable title="الأصناف الأعلى مبيعًا بعدد العبوات" rows={data.productsByQty} note="الترتيب بعدد الوحدات المسجلة لكل صنف؛ حجم ونوع العبوة قد يختلفان من صنف لآخر." />
    </>}
    <details className="panel"><summary><strong>أولويات الشغل الحالية</strong></summary>{priorityError&&<p className="error">{priorityError}</p>}{!priorities?<p className="muted">جارٍ تحميل الأولويات…</p>:<>
      <h3>المبيعات</h3><p>{formatNumber(priorities.orderCount)} طلبية مستنية التسعير · {formatNumber(priorities.unassignedCustomers)} عميل شغال من غير مهندس.</p>
      {priorities.waitingOrders.length>0&&<ul>{priorities.waitingOrders.map(o=><li key={o.id}>{o.customerName} · {o.repName} · {ago(o.sentAt)}</li>)}</ul>}
      <div className="filters"><button className="btn ghost sm" onClick={()=>onNavigate('reports')}>افتح الطلبيات والزيارات</button><button className="btn ghost sm" onClick={()=>onNavigate('customers')}>افتح العملاء</button></div>
      <h3>الميدان</h3><p>{formatNumber(priorities.openVisitCount)} زيارة مفتوحة · {formatNumber(fieldAlerts.length)} تنبيه ميداني حالي.</p>{fieldAlerts.length>0&&<ul>{fieldAlerts.slice(0,5).map(a=><li key={a.id}>{a.repName?`${a.repName}: `:''}{a.title}</li>)}</ul>}
      {priorities.openVisits.length>0&&<ul>{priorities.openVisits.slice(0,5).map(v=><li key={v.id}>{v.repName} عند {v.customerName} · {ago(v.checkedInAt)}</li>)}</ul>}
      <button className="btn ghost sm" onClick={()=>onNavigate('live')}>افتح المتابعة والتنبيهات</button>
      <h3>المخازن</h3>{priorities.warehouses===0?<p>لسه مفيش مخازن؛ سجّل المخازن والأرصدة الافتتاحية.</p>:<p>{formatNumber(priorities.emptyStockCount)} صنف رصيده المسجّل صفر · {formatNumber(priorities.uninitialized)} رصيد افتتاحي غير مسجّل.</p>}
      {priorities.emptyStock.length>0&&<ul>{priorities.emptyStock.slice(0,10).map((s,i)=><li key={`${s.warehouseName}-${s.productName}-${i}`}>{s.productName} · {s.warehouseName}</li>)}</ul>}<button className="btn ghost sm" onClick={()=>onNavigate('warehouses')}>افتح المخازن</button><p className="muted small">الرصيد غير المسجّل مش بنحسبه صفر.</p>
    </>}</details>
  </section>;
}
function ProductTable({title,rows,note}:{title:string;rows:Product[];note?:string}) {
  return <div className="panel"><h3>{title}</h3>{note&&<p className="muted small">{note}</p>}{rows.length===0?<p className="muted">مفيش بيعات مؤكدة في الفترة.</p>:<div className="kpi-table-wrap"><table className="kpi-table"><thead><tr><th>الصنف والعبوة</th><th>الكمية</th><th>قيمة البيع</th></tr></thead><tbody>{rows.map(p=><tr key={`${p.id}:${p.unit}:${p.unitSize}`}><td><details><summary>{p.name} · {p.unit} {p.unitSize}</summary><p className="muted small">أعلى العملاء استهلاكًا للصنف:</p><ul>{p.consumers?.map(c=><li key={c.id}>{c.name}{c.phone?` · ${c.phone}`:''} · رقم {c.id.slice(-6)} · {quantity(c.qty)} {p.unit} · {cash(c.amount)}</li>)}</ul></details></td><td>{quantity(p.qty)} {p.unit}</td><td>{cash(p.amount)}</td></tr>)}</tbody></table></div>}</div>;
}
