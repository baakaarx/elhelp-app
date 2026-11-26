import { useReveal } from './useReveal';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, patch, post } from './api';
import { formatNumber } from './session';
type StaffUser={id:string; name:string; email:string; accessScope:'full'|'warehouse';active:boolean};
export default function Staff() {
  const [list,setList]=useState<StaffUser[]|null>(null), [name,setName]=useState(''), [email,setEmail]=useState(''), [password,setPassword]=useState(''), [scope,setScope]=useState<'full'|'warehouse'>('warehouse'), [error,setError]=useState(''), [message,setMessage]=useState(''), [busy,setBusy]=useState(false);
  const resetForm=useReveal<HTMLFormElement>();
  const [resetUser,setResetUser]=useState<StaffUser|null>(null), [resetPassword,setResetPassword]=useState('');
  const [loadingList,setLoadingList]=useState(true), [passwordMin,setPasswordMin]=useState<number|null>(null);
  const listRequest=useRef(0);
  const load=async()=>{
    const request=++listRequest.current;setList(null);setLoadingList(true);
    try {const result=await api<{staff:StaffUser[];minimumPasswordLength:number}>('/api/staff');if(!Number.isInteger(result.minimumPasswordLength)||result.minimumPasswordLength<1||result.minimumPasswordLength>200)throw Error('تعذر معرفة شروط كلمة المرور؛ أعد تحميل الحسابات.');if(request===listRequest.current){setPasswordMin(result.minimumPasswordLength);setList(result.staff);}}
    catch(e){if(request===listRequest.current)throw e;}
    finally{if(request===listRequest.current)setLoadingList(false);}
  };
  useEffect(()=>{ void load().catch(e=>setError(e instanceof Error?e.message:'تعذر تحميل الحسابات.'));return()=>{listRequest.current++;}; },[]);
  async function retryLoad(){setError('');try{await load();}catch(e){setError(e instanceof Error?e.message:'تعذر تحميل الحسابات.');}}
  async function create(e:FormEvent) { e.preventDefault();setBusy(true);setError('');setMessage('');try {
    await post('/api/staff',{name,email,password,accessScope:scope}); setMessage(`اتعمل حساب ${name}.`); setName('');setEmail('');setPassword('');try {await load();} catch {setError('الحساب اتعمل، لكن القائمة ما اتحدّثتش. حدّث الصفحة قبل المحاولة مرة أخرى.');}
  } catch(e) { setError(e instanceof Error?e.message:'تعذر إنشاء الحساب.'); } finally {setBusy(false);} }
  async function update(user:StaffUser, data:{active?:boolean;password?:string}) { setBusy(true);setError('');setMessage('');try {
    await patch(`/api/staff/${user.id}`,data);setResetUser(null);setResetPassword('');setMessage(`تم تحديث حساب ${user.name}.`);try {await load();} catch {setError('الحساب اتحدّث، لكن القائمة ما اتحدّثتش. حدّث الصفحة قبل المحاولة مرة أخرى.');}
  } catch(e) { setError(e instanceof Error?e.message:'تعذر تعديل الحساب.'); } finally {setBusy(false);} }
  return <section className="page"><header className="page-head"><div><h2>حسابات المكتب والمخازن</h2><p className="muted">المبيعات لها صلاحية كاملة؛ المخازن لها الأصناف والمخازن فقط من غير أسعار.</p></div></header>
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="ok-text" role="status">{message}</p>}
    <form className="panel" onSubmit={create}><h3>حساب جديد</h3><div className="work-form">
      <label className="field inline"><span>الاسم</span><input required minLength={2} maxLength={120} value={name} onChange={e=>setName(e.target.value)} /></label>
      <label className="field inline"><span>البريد الإلكتروني</span><input required type="email" dir="ltr" value={email} onChange={e=>setEmail(e.target.value)} /></label>
      <label className="field inline"><span>كلمة المرور</span><input required minLength={passwordMin??undefined} type="password" dir="ltr" value={password} onChange={e=>setPassword(e.target.value)} /></label>
      <label className="field inline"><span>نوع الحساب</span><select value={scope} onChange={e=>setScope(e.target.value as typeof scope)}><option value="warehouse">مخازن</option><option value="full">مبيعات · صلاحية كاملة</option></select></label>
      <button className="btn primary sm" disabled={busy||list===null||passwordMin===null}>{busy?'جارٍ الإنشاء…':'إنشاء الحساب'}</button>
    </div><p className="muted small">صلاحية المبيعات الكاملة تشمل إدارة الحسابات وحذف البيانات. كلمة المرور {passwordMin===null?'حسب شروط السيرفر':`${formatNumber(passwordMin)} حرفًا على الأقل`}.</p></form>
    {resetUser && list!==null && <form className="panel reveal-target" ref={resetForm.ref} tabIndex={-1} onSubmit={e=>{e.preventDefault();void update(resetUser,{password:resetPassword});}}><h3>كلمة مرور جديدة لـ {resetUser.name}</h3>
      <label className="field inline"><span>كلمة المرور الجديدة</span><input required minLength={passwordMin??undefined} type="password" dir="ltr" value={resetPassword} onChange={e=>setResetPassword(e.target.value)} /></label>
      <button className="btn primary sm" disabled={busy}>حفظ كلمة المرور</button> <button type="button" className="btn ghost sm" onClick={()=>{setResetUser(null);setResetPassword('');}}>إلغاء</button>
      <p className="muted small">تغيير كلمة المرور بيخرج كل أجهزة الحساب.</p></form>}
    <div className="panel"><h3>الحسابات</h3>{list===null?(loadingList?<p>جارٍ تحميل الحسابات…</p>:<div><p>الحسابات غير متاحة؛ أعد التحميل قبل تعديلها أو إنشاء حساب آخر.</p><button type="button" className="btn ghost sm" disabled={busy} onClick={()=>void retryLoad()}>إعادة تحميل الحسابات</button></div>):<ul className="stack-list">{list.map(u=><li className="card staff-row" key={u.id}><strong>{u.name}</strong> · <span dir="ltr">{u.email}</span> · {u.accessScope==='warehouse'?'مخازن':'مبيعات / مدير'} · {u.active?'شغال':'موقوف'}
      <div className="filters"><button className="btn ghost sm" disabled={busy} onClick={()=>{setResetUser(u);setResetPassword('');resetForm.reveal();}}>كلمة مرور جديدة</button><button className="btn ghost sm" disabled={busy} onClick={()=>void update(u,{active:!u.active})}>{u.active?'إيقاف الحساب':'تفعيل الحساب'}</button></div></li>)}</ul>}</div>
  </section>;
}
