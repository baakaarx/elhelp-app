import {useEffect,useState} from 'react';
import {ApiError,api,apiBlob} from './api';
import { dateTimeText } from './dates';

export type Detail={type:'sale'|'receipt';record:{id:string;invoiceNumber?:number;customerId:string;total?:number;paid:number;createdAt:number;actorName:string;currentName:string;currentPhone?:string;currentGovernorate?:string;currentDistrict?:string;currentVillage?:string;currentWarehouse?:string};
 snapshot:{customerName:string;phone:string;governorate:string;district:string;village:string;warehouseName:string;repName:string}|null;
 lines:{id:string;name:string;unit:string;unitSize:string;qty:number;price:number;amount:number;corrected:number;returned:number;correctedAmount:number}[];
 events:{id:string;reason:string;cashKind:'error'|'refund'|null;cash:number;actorName:string;createdAt:number;lines:{name:string;unit:string;unitSize:string;corrected:number;returned:number;amount:number;stockKind:'returned'|'error'|null}[]}[];
 revision:number;version:string;balancePiasters:number;cashRemaining:number};
export const cashP=(p:number)=>`${(p/100).toLocaleString('ar-EG',{maximumFractionDigits:2})} ج.م`;
export const qtyM=(m:number)=>(m/1000).toLocaleString('ar-EG',{maximumFractionDigits:3});
export function CorrectionHistory({detail,timezone}:{detail:Detail;timezone?:string}) {
 return <>{detail.events.length>0&&<div><h4>سجل التصحيحات</h4>{detail.events.map(e=><div key={e.id} className="invoice-event"><p><strong>{dateTimeText(e.createdAt,timezone)} · {e.actorName}</strong> · {e.reason}</p>
  <p className="small">مرجع التصحيح: <span dir="ltr">{e.id}</span></p>
  {e.lines.map((l,i)=><p key={i}>{l.name}: كمية مصححة {qtyM(l.corrected)} {l.unit} {l.unitSize}، قيمة مصححة {cashP(l.amount)} {l.stockKind&&` · ${l.stockKind==='error'?'لم تخرج والخصم كان خطأ':'رجعت للمخزن'}: ${qtyM(l.returned)}`}</p>)}
  {e.cashKind&&<p>{e.cashKind==='error'?'مبلغ سُجل خطأ ولم يُستلم':'مبلغ أُعيد للعميل'}: {cashP(e.cash)}</p>}
 </div>)}</div>}</>;
}
export default function SaleInvoice({detail,timezone,onBack,onRefresh}:{detail:Detail;timezone?:string;onBack:()=>void;onRefresh:(detail:Detail)=>void}) {
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[stale,setStale]=useState(false);
 const [file,setFile]=useState<string>('');
 useEffect(()=>()=>{if(file)URL.revokeObjectURL(file);},[file]);
 const detailPath=`/api/sales/corrections/sale/${encodeURIComponent(detail.record.id)}`;
 async function refresh(){setBusy(true);setError('');try{onRefresh(await api<Detail>(detailPath));setStale(false);}catch(e){setError(e instanceof Error?e.message:'تعذر تحديث الفاتورة.');}finally{setBusy(false);}}
 async function print(){setBusy(true);setError('');try{
  const latest=await api<Detail>(detailPath);
  if(latest.version!==detail.version){setStale(true);setError('الفاتورة اتغيرت. حدّثها وراجعها قبل الطباعة.');return;}
  window.print();
 }catch(e){setError(e instanceof Error?e.message:'تعذر مراجعة الفاتورة قبل الطباعة.');}finally{setBusy(false);}}
 async function download(){setBusy(true);setError('');try{
  const blob=await apiBlob(`/api/sales/invoice/${encodeURIComponent(detail.record.id)}/pdf?version=${encodeURIComponent(detail.version)}`,{},'تعذر تنزيل الفاتورة.');
  if(blob.type.split(';')[0]!=='application/pdf')throw new Error('تعذر تنزيل ملف PDF صالح. حاول مرة أخرى.');
  const url=URL.createObjectURL(blob);setFile(url);
  const a=document.createElement('a');a.href=url;a.download=`invoice-${detail.record.invoiceNumber}.pdf`;document.body.appendChild(a);a.click();a.remove();
 }catch(e){if(e instanceof ApiError&&e.code==='INVOICE_CHANGED')setStale(true);setError(e instanceof Error?e.message:'تعذر تنزيل الفاتورة.');}finally{setBusy(false);}}
 const r=detail.record,c=detail.snapshot??{customerName:r.currentName,phone:r.currentPhone??'',governorate:r.currentGovernorate??'',district:r.currentDistrict??'',village:r.currentVillage??'',warehouseName:r.currentWarehouse??'',repName:''};
 return <><div className="filters"><button className="btn primary" disabled={busy||stale} onClick={()=>void print()}>طباعة الفاتورة</button><button className="btn ghost" disabled={busy||stale} onClick={()=>void download()}>تحميل PDF</button><button className="btn ghost" disabled={busy} onClick={onBack}>رجوع للحساب</button></div>
  {file&&!stale&&<p className="notice" role="status">ملف الفاتورة جاهز. لو التنزيل ما بدأش، <a href={file} download={`invoice-${detail.record.invoiceNumber}.pdf`}>اضغط هنا لحفظ PDF</a> أو <a href={file} target="_blank" rel="noopener noreferrer">افتح الفاتورة في صفحة جديدة</a>. لو المتصفح منع الاثنين داخل المعاينة، افتح النظام في تبويب مستقل ثم حاول تاني.</p>}
  {!detail.snapshot&&<p className="notice">للمكتب: بيانات العميل المعروضة هي البيانات الحالية لأن النسخة وقت البيع غير محفوظة. راجعها قبل تسليم الفاتورة.</p>}
  {error&&<p className="error" role="alert">{error}</p>}{stale&&<button className="btn ghost" disabled={busy} onClick={()=>void refresh()}>تحديث الفاتورة ومراجعتها</button>}
  <article className="panel invoice-print" dir="rtl">
  <header className="invoice-brand"><div className="invoice-title"><h2>الهلب جروب</h2><h3>فاتورة بيع</h3><p>ليست فاتورة ضريبية إلكترونية</p></div><div className="invoice-logo"><img src="/elhelb-logo.png" alt="شعار الهلب جروب" /></div></header>
  {detail.events.length>0&&<p className="notice"><strong>البيعة عليها تصحيحات — التفاصيل بالأسفل.</strong></p>}
  <div className="invoice-meta"><p>رقم الفاتورة: <strong>{r.invoiceNumber}</strong></p><p>تاريخ البيع: {dateTimeText(r.createdAt,timezone)}</p>
  <p>{detail.snapshot?'العميل':'العميل (البيانات الحالية)'}: <strong>{c.customerName}</strong> {c.phone}</p><p>{[c.governorate,c.district,c.village].filter(Boolean).join(' · ')}</p></div>
  <div className="kpi-table-wrap"><table className="kpi-table"><thead><tr><th>الصنف</th><th>{detail.events.length?'الكمية قبل التصحيح':'الكمية'}</th><th>سعر الوحدة</th><th>{detail.events.length?'القيمة قبل التصحيح':'القيمة'}</th></tr></thead><tbody>{detail.lines.map(l=><tr key={l.id}><td>{l.name} · {l.unit} {l.unitSize}</td><td>{qtyM(l.qty)}</td><td>{cashP(l.price)}</td><td>{cashP(l.amount)}</td></tr>)}</tbody></table></div>
  <p><strong>{detail.events.length?'الإجمالي قبل التصحيح':'الإجمالي'}: {cashP(r.total??0)} · المدفوع وقت البيع: {cashP(r.paid)} · الباقي وقت البيع: {cashP((r.total??0)-r.paid)}</strong></p>
  <p>المبالغ تخص وقت البيع؛ الدفعات اللاحقة تُراجع في كشف حساب العميل.</p>
  <CorrectionHistory detail={detail} timezone={timezone} />
  {detail.events.length>0&&<p><strong>قيمة البيعة الحالية بعد تصحيح الأصناف: {cashP((r.total??0)-detail.lines.reduce((sum,l)=>sum+l.correctedAmount,0))}</strong></p>}
  </article></>;
}
