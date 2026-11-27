import {useReveal} from './useReveal';
import {useState, type FormEvent} from 'react';
import {hasInputPrecision, normalizeDecimal} from './decimal';
import {CorrectionHistory, cashP, qtyM, type Detail} from './SaleInvoice';

type LineInput={lineId:string;correctedMilli:number;returnedMilli:number;damagedMilli?:number;stockKind:'returned'|'error'|null};
export type CorrectionPayload={reason:string;balancePiasters:number;revision:number;lines:LineInput[];cash:{kind:'error'|'refund';amountPiasters:number}|null};
const parse=(s:string)=>{const v=normalizeDecimal(s);return v===''?0:/^\d+(\.\d+)?$/.test(v)?Number(v):NaN;};
const exact=(text:string,places:number)=>text.trim()==='' || (hasInputPrecision(text,places) && Number.isFinite(parse(text)));
const account=(p:number)=>p<0?`رصيد لصالح العميل ${cashP(-p)}`:`باقي على العميل ${cashP(p)}`;
export default function SaleCorrection({detail,timezone,busy,onBack,onSave,returnMode=false}:{detail:Detail;timezone?:string;busy:boolean;onBack:()=>void;onSave:(v:CorrectionPayload)=>Promise<void>;returnMode?:boolean}){
 const reviewPanel=useReveal<HTMLDivElement>();
 const [reason,setReason]=useState(''),[cashKind,setCashKind]=useState(''),[cash,setCash]=useState(''),[inputs,setInputs]=useState<Record<string,{corrected:string;returned:string;stockKind:string}>>({}),[returnInputs,setReturnInputs]=useState<Record<string,{good:string;damaged:string;prior:string}>>({}),[review,setReview]=useState<CorrectionPayload|null>(null),[error,setError]=useState('');
 const setReturnLine=(id:string,key:'good'|'damaged'|'prior',value:string)=>setReturnInputs(old=>({...old,[id]:{good:old[id]?.good??'',damaged:old[id]?.damaged??'',prior:old[id]?.prior??'',[key]:value}}));
 const setLine=(id:string,k:'corrected'|'returned'|'stockKind',v:string)=>setInputs(old=>({...old,[id]:{corrected:old[id]?.corrected??'',returned:old[id]?.returned??'',stockKind:old[id]?.stockKind??'',[k]:v}}));
 function prepare(e:FormEvent){e.preventDefault();setError('');const lines:LineInput[]=[];
  if(returnMode){
   for(const l of detail.lines){
    const goodText=returnInputs[l.id]?.good??'',damagedText=returnInputs[l.id]?.damaged??'',priorText=returnInputs[l.id]?.prior??'';
    if(!exact(goodText,3)||!exact(damagedText,3)||!exact(priorText,3)){setError('كمية المرتجع تقبل حتى ٣ أرقام عشرية.');return;}
    const good=Math.round(parse(goodText)*1000),damaged=Math.round(parse(damagedText)*1000),prior=Math.round(parse(priorText)*1000),total=good+damaged;
    if(total && l.corrected>l.returned && !priorText.trim()){setError(`حدد كمية ${l.name} المصححة سابقًا ضمن المرتجع الحالي، أو اكتب صفر إذا لم تُصحّح سابقًا.`);return;}
    if(prior>total||prior>l.corrected-l.returned){setError(`راجع كمية ${l.name} المصححة سابقًا ولم تُستلم: لا تتجاوز المرتجع الحالي أو المتبقي من التصحيح السابق.`);return;}
    if(l.corrected+total-prior>l.qty){setError(`كمية مرتجع ${l.name} أكبر من الكمية المتبقية من الفاتورة.`);return;}
    if(total) lines.push({lineId:l.id,correctedMilli:total-prior,returnedMilli:total,...(damaged?{damagedMilli:damaged}:{}),stockKind:'returned'});
   }
  } else for(const l of detail.lines){const q=parse(inputs[l.id]?.corrected??''),r=parse(inputs[l.id]?.returned??'');
   if(!exact(inputs[l.id]?.corrected??'',3)||!exact(inputs[l.id]?.returned??'',3)){setError('الكمية تقبل حتى ٣ أرقام عشرية.');return;}
   const qm=Math.round(q*1000),rm=Math.round(r*1000);
   if(l.corrected+qm>l.qty||l.returned+rm>l.corrected+qm){setError(`راجع كمية ${l.name}: لا تتجاوز المباع أو الكمية المصححة.`);return;}
   const kind=inputs[l.id]?.stockKind??'';if(rm&&kind!=='returned'&&kind!=='error'){setError(`حدد حالة البضاعة للصنف ${l.name}.`);return;}
   if(qm||rm)lines.push({lineId:l.id,correctedMilli:qm,returnedMilli:rm,stockKind:rm?kind as 'returned'|'error':null});
  }
  if(returnMode&&!lines.length){setError('اكتب كمية واحدة مرتجعة على الأقل.');return;}
  const value=parse(cash);if(!exact(cash,2)||Math.round(value*100)>detail.cashRemaining){setError('راجع مبلغ التصحيح: لا يتجاوز المدفوع المتبقي ويقبل رقمين عشريين.');return;}
  const money=Math.round(value*100);if(money&&cashKind!=='refund'&&cashKind!=='error'){setError('اختار حالة المبلغ.');return;}
  if(!money&&cashKind){setError('اكتب مبلغ التصحيح أو اختار لا تغيير.');return;}
  if(!lines.length&&!money){setError('حدد تصحيحًا واحدًا على الأقل.');return;}
  if(reason.trim().length<5){setError('اكتب سببًا واضحًا من ٥ حروف على الأقل.');return;}
  setReview({reason:reason.trim(),revision:detail.revision,balancePiasters:detail.balancePiasters,lines,cash:money?{kind:cashKind as 'error'|'refund',amountPiasters:money}:null});reviewPanel.reveal();
 }
 const correctionAmount=review?.lines.reduce((sum,x)=>{const l=detail.lines.find(y=>y.id===x.lineId)!;return sum+Number((BigInt(l.corrected+x.correctedMilli)*BigInt(l.price)+500n)/1000n)-l.correctedAmount;},0)??0;
 const projected=detail.balancePiasters-correctionAmount+(review?.cash?.amountPiasters??0);
 return <div className="panel"><h3>{returnMode?'تسجيل مرتجع':detail.type==='sale'?'تصحيح بيعة أو تسجيل مرتجع':'تصحيح دفعة'}</h3><p>العميل: <strong>{detail.record.currentName}</strong> · المرجع: <span dir="ltr">{detail.record.id}</span></p>
  {detail.type==='sale'&&<p>رقم الفاتورة: <strong>{detail.record.invoiceNumber ?? 'غير متاح'}</strong> · مخزن الفاتورة (وجهة السليم): <strong>{detail.record.currentWarehouse || detail.snapshot?.warehouseName || 'غير متاح'}</strong></p>}
  <p className="notice">الفاتورة الأصلية محفوظة. الرصيد يعتمد على العمليات المسجلة فقط؛ إذا كان هناك رصيد سابق خارج النظام فتأكد من تسجيله.</p>
  <CorrectionHistory detail={detail} timezone={timezone}/>
  {!review?<form className="stack" onSubmit={prepare}>
   {returnMode&&<><h4>الأصناف المستلمة من العميل</h4><p>اكتب الكميات التي استلمتها فعلًا. السليم يرجع لمخزن الفاتورة، والتالف يُسجّل في مخزن مرتجعات تالف منفصل لا يُباع منه. قيمة المرتجع بسعر الفاتورة الأصلي.</p>{detail.lines.map(l=><div className="panel" key={l.id}><strong>{l.name} · {l.unit} {l.unitSize}</strong><p>المباع أصلًا {qtyM(l.qty)} · صُحّح سابقًا {qtyM(l.corrected)} · المتبقي غير المصحح {qtyM(l.qty-l.corrected)} · مصحح سابقًا ولم يُسجّل استلامه {qtyM(l.corrected-l.returned)}</p><div className="work-form"><label className="field"><span>الكمية السليمة المرتجعة - {l.name} · {l.unit} {l.unitSize}</span><input inputMode="decimal" value={returnInputs[l.id]?.good??''} onChange={e=>setReturnLine(l.id,'good',e.target.value)} placeholder="0" /></label><label className="field"><span>الكمية التالفة المرتجعة - {l.name} · {l.unit} {l.unitSize}</span><input inputMode="decimal" value={returnInputs[l.id]?.damaged??''} onChange={e=>setReturnLine(l.id,'damaged',e.target.value)} placeholder="0" /></label>{l.corrected>l.returned&&<label className="field"><span>من المرتجع الحالي: كمية صُححت ماليًا سابقًا ولم يُسجّل استلامها - {l.name} · {l.unit} {l.unitSize}</span><input inputMode="decimal" value={returnInputs[l.id]?.prior??''} onChange={e=>setReturnLine(l.id,'prior',e.target.value)} placeholder="0" /></label>}</div>{l.corrected>l.returned&&<p>اكتب في الحقل الأخير الكمية التي صُححت في الحساب سابقًا حتى لا تُخصم قيمتها مرة ثانية، أو اكتب صفر إذا لم يُصحَّح أي جزء من المرتجع الحالي.</p>}</div>)}</>}
   {!returnMode&&detail.lines.length>0&&<><h4>الأصناف</h4><p>اكتب فقط الكميات الجديدة في هذا التصحيح. القيمة تُحسب من سعر البيع الأصلي بالقرش؛ تعديل سعر الصنف وحده غير متاح هنا، راجع المسؤول ولا تسجله كمرتجع غير حقيقي. الكمية المضافة للمخزن لا تزيد عن الكمية المصححة، ويمكن تسجيلها لاحقًا. ميّز بين بضاعة رجعت فعلًا وبضاعة لم تخرج وخُصمت بالخطأ. هذا النموذج يعيد للمخزن الصالح فقط؛ لتسجيل البضاعة التالفة استخدم زر «تسجيل مرتجع» من الفاتورة.</p>
   {detail.lines.map(l=>{const lineName=detail.lines.filter(x=>x.name===l.name).length>1?`${l.name} · ${l.unit} ${l.unitSize}`:l.name;return <div className="panel" key={l.id}><strong>{l.name} · {l.unit} {l.unitSize}</strong><p>المباع أصلًا {qtyM(l.qty)} · مصحح سابقًا {qtyM(l.corrected)} · أضيف للمخزن بعد تصحيح {qtyM(l.returned)}</p>
    <div className="work-form"><label className="field"><span>كمية إضافية لتصحيح البيع - {lineName}</span><input inputMode="decimal" value={inputs[l.id]?.corrected??''} onChange={e=>setLine(l.id,'corrected',e.target.value)} placeholder="0" /></label>
    <label className="field"><span>كمية تضاف للمخزن الآن - {lineName}</span><input inputMode="decimal" value={inputs[l.id]?.returned??''} onChange={e=>setLine(l.id,'returned',e.target.value)} placeholder="0" /></label>
    {parse(inputs[l.id]?.returned??'')>0&&<label className="field"><span>حالة البضاعة - {lineName}</span><select required value={inputs[l.id]?.stockKind??''} onChange={e=>setLine(l.id,'stockKind',e.target.value)}><option value="">اختار الحالة</option><option value="returned">بضاعة سليمة خرجت ثم رجعت فعلًا</option><option value="error">البضاعة لم تخرج وخصم المخزون كان خطأ</option></select></label>}</div></div>;})}</>}
   <h4>المبلغ المدفوع {detail.type==='sale'?'وقت البيع':'في هذه الدفعة'}</h4><p>المبلغ الأصلي {cashP(detail.record.paid)} · المتاح للتصحيح {cashP(detail.cashRemaining)}. الدفعات اللاحقة تُصحّح كل واحدة لوحدها.</p>
   <label className="field"><span>حالة المبلغ</span><select value={cashKind} onChange={e=>{setCashKind(e.target.value);if(!e.target.value)setCash('');}}><option value="">لا تغيير في المبلغ</option>{!returnMode&&<option value="error">اتسجل بالغلط ولم يُستلم</option>}<option value="refund">استُلم ثم رُد للعميل فعلًا</option></select></label>
   {cashKind&&<label className="field"><span>المبلغ المصحح (ج.م)</span><input inputMode="decimal" required value={cash} onChange={e=>setCash(e.target.value)} /></label>}
   <label className="field"><span>سبب التصحيح</span><textarea required minLength={5} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} /></label>
   {error&&<p className="error" role="alert">{error}</p>}<div className="filters"><button className="btn primary" disabled={busy}>{returnMode?'مراجعة المرتجع':'مراجعة التصحيح'}</button><button type="button" className="btn ghost" disabled={busy} onClick={onBack}>رجوع</button></div>
  </form>:<div aria-label="مراجعة التصحيح" className="reveal-target" ref={reviewPanel.ref} tabIndex={-1}><p><strong>السبب:</strong> {review.reason}</p>
   {review.lines.map(x=>{const l=detail.lines.find(y=>y.id===x.lineId)!,good=x.returnedMilli-(x.damagedMilli??0);return <p key={x.lineId}>{l.name} · {l.unit} {l.unitSize}: تصحيح البيع {qtyM(x.correctedMilli)}{good>0&&` · ${x.stockKind==='error'?'لم تخرج والخصم خطأ':'سليم لمخزن الفاتورة'} ${qtyM(good)}`}{(x.damagedMilli??0)>0&&` · تالف لمخزن التالف ${qtyM(x.damagedMilli??0)}`}</p>;})}
   <p>قيمة تخفيض البيعة: {cashP(correctionAmount)}</p>{review.cash&&<p>{review.cash.kind==='error'?'سُجل خطأ ولم يُستلم':'رُد للعميل بالفعل'}: {cashP(review.cash.amountPiasters)}</p>}
   <p><strong>قبل:</strong> {account(detail.balancePiasters)} · <strong>بعد:</strong> {account(projected)}</p>
   <p className="notice">أكد حالة البضاعة كما حدثت فعلًا، ولا تؤكد رد الفلوس إلا بعد ردها فعليًا. لا يمكن حذف التصحيح بعد حفظه.</p>
   <div className="filters"><button className="btn primary" disabled={busy} onClick={()=>void onSave(review)}>{returnMode?'تأكيد المرتجع':'تأكيد التصحيح'}</button><button className="btn ghost" disabled={busy} onClick={()=>setReview(null)}>رجوع للتعديل</button></div></div>}
 </div>;
}
