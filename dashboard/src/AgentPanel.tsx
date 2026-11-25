import { useEffect, useState } from 'react';
import { api } from './api';
import { ago, formatNumber } from './session';
import type { ManagerAlert } from './types';

type Priorities = {
  orderCount:number; unassignedCustomers:number; openVisitCount:number; emptyStockCount:number; warehouses:number; uninitialized:number;
  waitingOrders:{id:string;customerName:string;repName:string;sentAt:number}[];
  openVisits:{id:string;customerName:string;repName:string;checkedInAt:number}[];
  emptyStock:{warehouseName:string;productName:string;unit:string;unitSize:string}[];
};
export default function AgentPanel({ alerts, onNavigate }: { alerts:ManagerAlert[]; onNavigate:(tab:'reports'|'customers'|'live'|'warehouses')=>void }) {
  const [data,setData]=useState<Priorities|null>(null), [error,setError]=useState(''), [loading,setLoading]=useState(true);
  async function load() { setLoading(true);try { setData(await api<Priorities>('/api/work-priorities'));setError(''); } catch(e) { setError(e instanceof Error?e.message:'تعذر تحميل الأولويات.'); } finally { setLoading(false); } }
  useEffect(()=>{ void load(); },[]);
  const fieldAlerts=alerts.filter(a=>a.code !== 'orders_awaiting_pricing');
  return <section className="page"><header className="page-head"><div><h2>أولويات الشغل</h2><p className="muted">ملخص من بيانات النظام الحالية يساعدك تعرف تبدأ منين. المساعد لا ينفّذ تغييرات من نفسه.</p></div><button className="btn ghost sm" onClick={()=>void load()} disabled={loading}>تحديث الأولويات</button></header>
    {error && <p className="error" role="alert">{error}</p>}{loading && !data ? <p className="muted">جارٍ التحميل…</p> : data && <>
      <div className="panel"><h3>المبيعات</h3><p>{formatNumber(data.orderCount)} طلبية مستنية التسعير · {formatNumber(data.unassignedCustomers)} عميل شغال من غير مهندس.</p>
        {data.waitingOrders.length > 0 && <ul>{data.waitingOrders.map(o=><li key={o.id}>{o.customerName} · {o.repName} · {ago(o.sentAt)}</li>)}</ul>}
        <div className="filters"><button className="btn primary sm" onClick={()=>onNavigate('reports')}>افتح الطلبيات والزيارات</button><button className="btn ghost sm" onClick={()=>onNavigate('customers')}>افتح العملاء</button></div></div>
      <div className="panel"><h3>الميدان</h3><p>{formatNumber(data.openVisitCount)} زيارة مفتوحة · {formatNumber(fieldAlerts.length)} تنبيه ميداني حالي.</p>
        {fieldAlerts.length>0 && <ul>{fieldAlerts.slice(0,5).map(a=><li key={a.id}>{a.repName ? `${a.repName}: ` : ''}{a.title}</li>)}</ul>}
        {data.openVisits.length>0 && <ul>{data.openVisits.slice(0,5).map(v=><li key={v.id}>{v.repName} عند {v.customerName} · {ago(v.checkedInAt)}</li>)}</ul>}
        <button className="btn ghost sm" onClick={()=>onNavigate('live')}>افتح المتابعة والتنبيهات</button></div>
      <div className="panel"><h3>المخازن</h3>{data.warehouses===0 ? <p>لسه مفيش مخازن؛ أضف المخازن وسجّل الأرصدة الافتتاحية.</p> : <><p>{formatNumber(data.emptyStockCount)} صنف رصيده المسجّل صفر في مخزن · {formatNumber(data.uninitialized)} رصيد افتتاحي لسه ما اتسجّلش.</p>
        {data.emptyStock.length>0 && <ul>{data.emptyStock.slice(0,10).map((s,i)=><li key={`${s.warehouseName}-${s.productName}-${i}`}>{s.productName} · {s.warehouseName}</li>)}</ul>}</>}
        <button className="btn ghost sm" onClick={()=>onNavigate('warehouses')}>افتح المخازن</button></div>
      <p className="muted small">التنبيه عن الرصيد الصفر يعتمد على الرصيد المسجّل فقط، مش جرد فعلي. الأرصدة اللي لسه ما اتسجلتش مش بنحسبها صفر.</p>
    </>}
  </section>;
}
