import { useState, type FormEvent } from 'react';
import { login } from './session';
import type { User } from './types';

export default function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try { onLogin(await login(email.trim(), password)); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تسجيل الدخول.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="login-wrap">
      <div className="login-shell">
        <aside className="login-aside">
          <img src="/elhelb-logo.png" alt="شعار الهلب جروب" width={132} height={160} />
          <div>
            <h2>الهلب جروب</h2>
            <p className="tagline">مبيدات وأسمدة زراعية · منذ ١٩٩٣</p>
          </div>
          <ul>
            <li>متابعة ميدانية لحظية لمهندسي المبيعات</li>
            <li>زيارات وتقارير يومية موقّعة إلكترونيًا</li>
            <li>مؤشرات أداء ومسارات قابلة للمراجعة</li>
          </ul>
        </aside>
        <div className="login-card">
          <div className="login-brand">
            <span className="brand-mark" aria-hidden="true">ه</span>
            <div>
              <h1>لوحة متابعة الميدان</h1>
              <p>الهلب جروب · إدارة مهندسي المبيعات والتقارير</p>
            </div>
          </div>
          <form onSubmit={submit} className="stack">
            <label className="field">
              <span>البريد الإلكتروني</span>
              <input type="email" dir="ltr" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@mandoub.test" />
            </label>
            <label className="field">
              <span>كلمة المرور</span>
              <input type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn primary" disabled={busy}>{busy ? 'جارٍ الدخول…' : 'دخول لوحة المتابعة'}</button>
          </form>
          <div className="login-switch">
            <span>مهندس مبيعات؟</span>
            <a href="/app" className="btn ghost sm">افتح تطبيق المهندس ←</a>
          </div>
          <div className="login-hint">
            <p>حساب عرض تجريبي: <b dir="ltr">admin@mandoub.test</b> / <b dir="ltr">Demo1234!</b></p>
            <p className="muted small">يتم جمع الموقع أثناء الوردية فقط، بموافقة صريحة من المهندس، وتُحذف البيانات بعد مدة الاحتفاظ.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
