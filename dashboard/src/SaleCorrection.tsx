import {useState, type FormEvent} from 'react';
import {hasInputPrecision} from './decimal';
import {CorrectionHistory, cashP, qtyM, type Detail} from './SaleInvoice';

type LineInput={lineId:string;correctedMilli:number;returnedMilli:number;stockKind:'returned'|'error'|null};
export type CorrectionPayload={reason:string;balancePiasters:number;revision:number;lines:LineInput[];cash:{kind:'error'|'refund';amountPiasters:number}|null};
const parse=(s:string)=>{const v=s.trim().replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace('٫','.');return v===''?0:/^\d+(\.\d+)?$/.test(v)?Number(v):NaN;};
const exact=(text:string,places:number)=>text.trim()==='' || (hasInputPrecision(text,places) && Number.isFinite(parse(text)));
const account=(p:number)=>p<0?`رصيد لصالح العميل ${cashP(-p)}`:`باقي على العميل ${cashP(p)}`;
export default function SaleCorrection({detail,timezone,busy,onBack,onSave}:{detail:Detail;timezone?:string;busy:boolean;onBack:()=>void;onSave:(v:CorrectionPayload)=>Promise<void>}){
 const [reason,setReason]=useState(''),[cashKind,setCashKind]=useState(''),[cash,setCash]=useState(''),[inputs,setInputs]=useState<Record<string,{corrected:string;returned:string;stockKind:string}>>({}),[review,setReview]=useState<CorrectionPayload|null>(null),[error,setError]=useState('');
 const setLine=(id:string,k:'corrected'|'returned'|'stockKind',v:string)=>setInputs(old=>({...old,[id]:{corrected:old[id]?.corrected??'',returned:old[id]?.returned??'',stockKind:old[id]?.stockKind??'',[k]:v}}));
 function prepare(e:FormEvent){e.preventDefault();setError('');const lines:LineInput[]=[];
  for(const l of detail.lines){const q=parse(inputs[l.id]?.corrected??''),r=parse(inputs[l.id]?.returned??'');
   if(!exact(inputs[l.id]?.corrected??'',3)||!exact(inputs[l.id]?.returned??'',3)){setError('الكمية تقبل حتى ٣ أرقام عشرية.');return;}
   const qm=Math.round(q*1000),rm=Math.round(r*1000);
   if(l.corrected+qm>l.qty||l.returned+rm>l.corrected+qm){setError(`راجع كمية ${l.name}: لا تتجاوز المباع أو الكمية المصححة.`);return;}
   const kind=inputs[l.id]?.stockKind??'';if(rm&&kind!=='returned'&&kind!=='error'){setError(`حدد حالة البضاعة للصنف ${l.name}.`);return;}
   if(qm||rm)lines.push({lineId:l.id,correctedMilli:qm,returnedMilli:rm,stockKind:rm?kind as 'returned'|'error':null});
  }
  const value=parse(cash);if(!exact(cash,2)||Math.round(value*100)>detail.cashRemaining){setError('راجع مبلغ التصحيح: لا يتجاوز المدفوع المتبقي ويقبل رقمين عشريين.');return;}
  const money=Math.round(value*100);if(money&&cashKind!=='refund'&&cashKind!=='error'){setError('اختار حالة المبلغ.');return;}
  if(!money&&cashKind){setError('اكتب مبلغ التصحيح أو اختار لا تغيير.');return;}
  if(!lines.length&&!money){setError('حدد تصحيحًا واحدًا على الأقل.');return;}
  if(reason.trim().length<5){setError('اكتب سببًا واضحًا من ٥ حروف على الأقل.');return;}
  setReview({reason:reason.trim(),revision:detail.revision,balancePiasters:detail.balancePiasters,lines,cash:money?{kind:cashKind as 'error'|'refund',amountPiasters:money}:null});
 }
 const correctionAmount=review?.lines.reduce((sum,x)=>{const l=detail.lines.find(y=>y.id===x.lineId)!;return sum+Number((BigInt(l.corrected+x.correctedMilli)*BigInt(l.price)+500n)/1000n)-l.correctedAmount;},0)??0;
 const projected=detail.balancePiasters-correctionAmount+(review?.cash?.amountPiasters??0);
 return <div className="panel"><h3>{detail.type==='sale'?'تصحيح بيعة أو تسجيل مرتجع':'تصحيح دفعة'}</h3><p>العميل: <strong>{detail.record.currentName}</strong> · المرجع: <span dir="ltr">{detail.record.id}</span></p>
  <p className="notice">الأصل محفوظ. المبالغ والرصيد من العمليات المسجلة هنا فقط؛ المديونية القديمة غير المسجلة قد تجعل الرصيد غير مكتمل.</p>
  <CorrectionHistory detail={detail} timezone={timezone}/>
  {!review?<form className="stack" onSubmit={prepare}>
   {detail.lines.length>0&&<><h4>الأصناف</h4><p>اكتب فقط الكميات الجديدة في هذا التصحيح. القيمة تُحسب من سعر البيع الأصلي بالقرش؛ تعديل سعر الصنف وحده غير متاح هنا، راجع المسؤول ولا تسجله كمرتجع غير حقيقي. الكمية المضافة للمخزن لا تزيد عن الكمية المصححة، ويمكن تسجيلها لاحقًا. ميّز بين بضاعة رجعت فعلًا وبضاعة لم تخرج وخُصمت بالخطأ.</p>
   {detail.lines.map(l=><div className="panel" key={l.id}><strong>{l.name} · {l.unit} {l.unitSize}</strong><p>المباع أصلًا {qtyM(l.qty)} · مصحح سابقًا {qtyM(l.corrected)} · أضيف للمخزن بعد تصحيح {qtyM(l.returned)}</p>
    <div className="work-form"><label className="field"><span>كمية إضافية لتصحيح البيع - {l.name}</span><input inputMode="decimal" value={inputs[l.id]?.corrected??''} onChange={e=>setLine(l.id,'corrected',e.target.value)} placeholder="0" /></label>
    <label className="field"><span>كمية تضاف للمخزن الآن - {l.name}</span><input inputMode="decimal" value={inputs[l.id]?.returned??''} onChange={e=>setLine(l.id,'returned',e.target.value)} placeholder="0" /></label>
    {parse(inputs[l.id]?.returned??'')>0&&<label className="field"><span>حالة البضاعة - {l.name}</span><select required value={inputs[l.id]?.stockKind??''} onChange={e=>setLine(l.id,'stockKind',e.target.value)}><option value="">اختار الحالة</option><option value="returned">البضاعة خرجت ثم رجعت فعلًا</option><option value="error">البضاعة لم تخرج وخصم المخزون كان خطأ</option></select></label>}</div></div>)}</>}
   <h4>المبلغ المدفوع {detail.type==='sale'?'وقت البيع':'في هذه الدفعة'}</h4><p>المبلغ الأصلي {cashP(detail.record.paid)} · المتاح للتصحيح {cashP(detail.cashRemaining)}. الدفعات اللاحقة تُصحّح كل واحدة لوحدها.</p>
   <label className="field"><span>حالة المبلغ</span><select value={cashKind} onChange={e=>{setCashKind(e.target.value);if(!e.target.value)setCash('');}}><option value="">لا تغيير في المبلغ</option><option value="error">اتسجل بالغلط ولم يُستلم</option><option value="refund">استُلم ثم رُد للعميل فعلًا</option></select></label>
   {cashKind&&<label className="field"><span>المبلغ المصحح (ج.م)</span><input inputMode="decimal" required value={cash} onChange={e=>setCash(e.target.value)} /></label>}
   <label className="field"><span>سبب التصحيح</span><textarea required minLength={5} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} /></label>
   {error&&<p className="error" role="alert">{error}</p>}<div className="filters"><button className="btn primary" disabled={busy}>مراجعة التصحيح</button><button type="button" className="btn ghost" disabled={busy} onClick={onBack}>رجوع</button></div>
  </form>:<div aria-label="مراجعة التصحيح"><p><strong>السبب:</strong> {review.reason}</p>
   {review.lines.map(x=>{const l=detail.lines.find(y=>y.id===x.lineId)!;return <p key={x.lineId}>{l.name}: تصحيح {qtyM(x.correctedMilli)} · إضافة للمخزن {qtyM(x.returnedMilli)} {l.unit} {l.unitSize} {x.stockKind==='error'?'(لم تخرج والخصم خطأ)':x.stockKind==='returned'?'(رجعت فعلًا)':''}</p>;})}
   <p>قيمة تخفيض البيعة: {cashP(correctionAmount)}</p>{review.cash&&<p>{review.cash.kind==='error'?'سُجل خطأ ولم يُستلم':'رُد للعميل بالفعل'}: {cashP(review.cash.amountPiasters)}</p>}
   <p><strong>قبل:</strong> {account(detail.balancePiasters)} · <strong>بعد:</strong> {account(projected)}</p>
   <p className="notice">أكد حالة البضاعة كما حدثت فعلًا، ولا تؤكد رد الفلوس إلا بعد ردها فعليًا. لا يمكن حذف التصحيح بعد حفظه.</p>
   <div className="filters"><button className="btn primary" disabled={busy} onClick={()=>void onSave(review)}>تأكيد التصحيح</button><button className="btn ghost" disabled={busy} onClick={()=>setReview(null)}>رجوع للتعديل</button></div></div>}
 </div>;
}
