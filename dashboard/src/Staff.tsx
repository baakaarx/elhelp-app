import { useCallback, useEffect, useState } from 'react';
import { api, patch, post } from './api';
import { ago } from './session';
import type { StaffAccount } from './types';

/**
 * Dashboard accounts, and what each one is allowed to open.
 *
 * This is the only place a `sales` or `stock` login comes from, and the manager alone reaches it:
 * an account that can hand out dashboard logins is an account that can hand out a manager, so the
 * sales office — which sees everything else — is refused here on purpose. The password is set once
 * by the manager for the same reason there is no self-signup anywhere in this product.
 */
/** The server owns this number; the form only refuses early so nobody types eleven and reads an error. */
const MIN_PASSWORD = 12;
const SCOPES = [
  { id: 'sales', label: 'مدير المبيعات', hint: 'كل حاجة في اللوحة: المبيعات، الفواتير، المخازن، الميدان.' },
  { id: 'stock', label: 'مسؤول المخازن', hint: 'الأصناف والأسعار والحركات بس — مفيش عملاء ولا ميدان.' },
] as const;

export default function Staff() {
  const [staff, setStaff] = useState<StaffAccount[]>([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', email: '', password: '', scope: 'stock' as 'sales' | 'stock' });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState<{ id: string; value: string } | null>(null);

  const refresh = useCallback(async () => {
    try { setStaff((await api<{ staff: StaffAccount[] }>('/api/staff')).staff); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل حسابات اللوحة.'); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function create() {
    setBusy(true);
    try {
      await post('/api/staff', { ...form, name: form.name.trim(), email: form.email.trim().toLowerCase() });
      setForm({ name: '', email: '', password: '', scope: 'stock' }); setOpen(false); setError('');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إنشاء الحساب.'); }
    finally { setBusy(false); }
  }

  async function update(account: StaffAccount, body: Record<string, unknown>) {
    try { await patch(`/api/staff/${account.id}`, body); setError(''); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تعديل الحساب.'); }
  }

  async function changePassword() {
    if (!reset) return;
    try { await post(`/api/staff/${reset.id}/password`, { password: reset.value }); setReset(null); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تغيير كلمة المرور.'); }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>حسابات اللوحة</h2>
          <p className="muted">مدير المبيعات ومسؤول المخازن — كل واحد بيشوف اللي يشتغل عليه بس.</p>
        </div>
        <button className="btn primary" onClick={() => setOpen(value => !value)}>{open ? 'إلغاء' : '+ حساب جديد'}</button>
      </header>

      {error && <p className="error banner" role="alert">{error}</p>}

      {open && (
        <div className="panel">
          <h3 className="panel-title">حساب لوحة جديد</h3>
          <div className="two-col">
            <label className="field"><span>الاسم</span><input value={form.name} onChange={event => setForm(f => ({ ...f, name: event.target.value }))} /></label>
            <label className="field"><span>البريد الإلكتروني</span><input dir="ltr" value={form.email} onChange={event => setForm(f => ({ ...f, email: event.target.value }))} /></label>
            <label className="field"><span>كلمة المرور ({MIN_PASSWORD} حرف على الأقل)</span><input dir="ltr" type="password" value={form.password} onChange={event => setForm(f => ({ ...f, password: event.target.value }))} /></label>
            <label className="field">
              <span>الصلاحية</span>
              <select value={form.scope} onChange={event => setForm(f => ({ ...f, scope: event.target.value as 'sales' | 'stock' }))}>
                {SCOPES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
              <small className="muted">{SCOPES.find(item => item.id === form.scope)?.hint}</small>
            </label>
          </div>
          <div className="filters">
            <button className="btn primary sm" disabled={busy || form.name.trim().length < 2 || !form.email.includes('@') || form.password.length < MIN_PASSWORD} onClick={() => void create()}>
              {busy ? 'جارٍ الإنشاء…' : 'إنشاء الحساب'}
            </button>
            <span className="muted small">مفيش تسجيل ذاتي: المدير بيشغّل اللوحة بيده.</span>
          </div>
        </div>
      )}

      <ul className="stack-list">
        {staff.map(account => (
          <li key={account.id} className="card report" style={account.active ? undefined : { opacity: 0.6 }}>
            <div className="report-head">
              <div className="grow">
                <h3>{account.name} {!account.active && <span className="muted small">· متوقف</span>}</h3>
                <p className="muted small" dir="ltr">{account.email}</p>
                <p className="muted small">
                  {account.scope === 'manager' ? 'مدير (كل الصلاحيات)' : account.scope === 'sales' ? 'مكتب المبيعات' : 'المخازن بس'}
                  {' · '}آخر ظهور: {account.lastSeen ? ago(account.lastSeen) : 'لم يظهر بعد'} · الحساب منشأ من {ago(account.createdAt)}
                </p>
              </div>
              <span className={`pill ${account.active ? 'ok' : 'warn'}`}>{account.active ? 'شغال' : 'متوقف'}</span>
            </div>
            <div className="report-actions">
              {account.scope !== 'manager' && (
                <select value={account.scope} onChange={event => void update(account, { scope: event.target.value })} aria-label="الصلاحية">
                  <option value="sales">مدير المبيعات</option>
                  <option value="stock">مسؤول المخازن</option>
                </select>
              )}
              {reset?.id === account.id ? (
                <>
                  <input dir="ltr" type="password" style={{ width: 180 }} placeholder="كلمة المرور الجديدة" value={reset.value} onChange={event => setReset({ id: account.id, value: event.target.value })} />
                  <button className="btn primary sm" disabled={reset.value.length < MIN_PASSWORD} onClick={() => void changePassword()}>احفظ</button>
                  <button className="btn ghost sm" onClick={() => setReset(null)}>إلغاء</button>
                </>
              ) : (
                <button className="btn ghost sm" onClick={() => setReset({ id: account.id, value: '' })}>تغيير كلمة المرور</button>
              )}
              <button className="btn ghost sm" onClick={() => void update(account, { active: !account.active })}>{account.active ? 'إيقاف' : 'تفعيل'}</button>
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small">لو كلمة المرور اتغيّرت، كل جهاز داخل بيها بيتقفل فورًا. الحساب الوحيد اللي صلاحية كاملة ما بيتوقفش من هنا عشان اللوحة متفضلش مقفولة.</p>
    </section>
  );
}
