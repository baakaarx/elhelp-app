import { dateTimeText } from './dates';

export type Detail={type:'sale'|'receipt';record:{id:string;customerId:string;total?:number;paid:number;createdAt:number;actorName:string;currentName:string;currentPhone?:string;currentGovernorate?:string;currentDistrict?:string;currentVillage?:string;currentWarehouse?:string};
 snapshot:{customerName:string;phone:string;governorate:string;district:string;village:string;warehouseName:string;repName:string}|null;
 lines:{id:string;name:string;unit:string;unitSize:string;qty:number;price:number;amount:number;corrected:number;returned:number;correctedAmount:number}[];
 events:{id:string;reason:string;cashKind:'error'|'refund'|null;cash:number;actorName:string;createdAt:number;lines:{name:string;unit:string;unitSize:string;corrected:number;returned:number;amount:number;stockKind:'returned'|'error'|null}[]}[];
 revision:number;balancePiasters:number;cashRemaining:number};
export const cashP=(p:number)=>`${(p/100).toLocaleString('ar-EG',{maximumFractionDigits:2})} ج.م`;
export const qtyM=(m:number)=>(m/1000).toLocaleString('ar-EG',{maximumFractionDigits:3});
export function CorrectionHistory({detail,timezone}:{detail:Detail;timezone?:string}) {
 return <>{detail.events.length>0&&<div><h4>سجل التصحيحات</h4>{detail.events.map(e=><div key={e.id} className="invoice-event"><p><strong>{dateTimeText(e.createdAt,timezone)} · {e.actorName}</strong> · {e.reason}</p>
  <p className="small">مرجع التصحيح: <span dir="ltr">{e.id}</span></p>
  {e.lines.map((l,i)=><p key={i}>{l.name}: كمية مصححة {qtyM(l.corrected)} {l.unit} {l.unitSize}، قيمة مصححة {cashP(l.amount)} {l.stockKind&&` · ${l.stockKind==='error'?'لم تخرج والخصم كان خطأ':'رجعت للمخزن'}: ${qtyM(l.returned)}`}</p>)}
  {e.cashKind&&<p>{e.cashKind==='error'?'مبلغ سُجل خطأ ولم يُستلم':'مبلغ أُعيد للعميل'}: {cashP(e.cash)}</p>}
 </div>)}</div>}</>;
}
export default function SaleInvoice({detail,timezone,onBack}:{detail:Detail;timezone?:string;onBack:()=>void}) {
 const r=detail.record,c=detail.snapshot??{customerName:r.currentName,phone:r.currentPhone??'',governorate:r.currentGovernorate??'',district:r.currentDistrict??'',village:r.currentVillage??'',warehouseName:r.currentWarehouse??'',repName:''};
 return <><div className="filters"><button className="btn primary" onClick={()=>window.print()}>طباعة الفاتورة</button><button className="btn ghost" onClick={onBack}>رجوع للحساب</button></div>
  <article className="panel invoice-print" dir="rtl"><h2>فاتورة بيع داخلية</h2><p>مستند داخلي — ليست فاتورة ضريبية إلكترونية</p>
  {detail.events.length>0&&<p className="notice"><strong>البيعة عليها تصحيحات — التفاصيل بالأسفل.</strong></p>}
  {!detail.snapshot&&<p className="notice">بيعة قديمة: بيانات العميل والمخزن الحالية وليست نسخة محفوظة وقت البيع؛ المهندس غير موضح هنا.</p>}
  <p>رقم المرجع: <span dir="ltr">{r.id}</span></p><p>تاريخ البيع: {dateTimeText(r.createdAt,timezone)}</p>
  <p>العميل: <strong>{c.customerName}</strong> {c.phone} · {[c.governorate,c.district,c.village].filter(Boolean).join(' · ')}</p>
  <p>المخزن: {c.warehouseName} · المهندس: {c.repName||'غير محدد'} · المسجّل: {r.actorName}</p>
  <div className="kpi-table-wrap"><table className="kpi-table"><thead><tr><th>الصنف</th><th>الكمية الأصلية</th><th>سعر الوحدة</th><th>القيمة الأصلية</th></tr></thead><tbody>{detail.lines.map(l=><tr key={l.id}><td>{l.name} · {l.unit} {l.unitSize}</td><td>{qtyM(l.qty)}</td><td>{cashP(l.price)}</td><td>{cashP(l.amount)}</td></tr>)}</tbody></table></div>
  <p><strong>الإجمالي الأصلي: {cashP(r.total??0)} · المدفوع وقت البيع: {cashP(r.paid)} · الباقي وقت البيع: {cashP((r.total??0)-r.paid)}</strong></p>
  <p>الدفعات اللاحقة تُسجّل على حساب العميل، وليست موزّعة على فاتورة بعينها. راجع كشف الحساب للرصيد الحالي.</p>
  <CorrectionHistory detail={detail} timezone={timezone} />
  {detail.events.length>0&&<p><strong>قيمة البيعة الحالية بعد تصحيح الأصناف: {cashP((r.total??0)-detail.lines.reduce((sum,l)=>sum+l.correctedAmount,0))}</strong></p>}
  </article></>;
}
