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
          <img className="aside-logo" src="/elhelb-logo.gif" alt="شعار الهلب جروب" width={150} height={183} />
          <div>
            <h2>ELHELB GROUP</h2>
            <p className="tagline">نخبة الخبراء الميدانيين · منذ ١٩٩٣</p>
            <p className="aside-note">٣٠ عاماً من الريادة · من المختبر إلى الحقل، خبراؤنا يصنعون الأثر كل يوم.</p>
          </div>
          <ul>
            <li>✦ مركز عمليات النخبة — رؤية لحظية لفريقك</li>
            <li>✦ توثيق إنجازات وزيارات موقعة رقمياً</li>
            <li>✦ ذكاء ميداني ومؤشرات تأثير قابلة للقياس</li>
          </ul>
        </aside>
        <div className="login-card">
          <div className="login-brand">
            <img className="brand-mark" src="/elhelb-emblem.png" alt="شعار الهلب جروب" width={52} height={52} />
            <div>
              <h1>Elite Operations Center</h1>
              <p>الهلب جروب الدولية · مركز عمليات النخبة</p>
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
            <button className="btn primary" disabled={busy}>{busy ? 'جارٍ الدخول…' : 'دخول مركز النخبة →'}</button>
          </form>
          <div className="login-switch">
            <span>مهندس مبيعات؟</span>
            <a href="/app" className="btn ghost sm">افتح تطبيق المهندس ←</a>
          </div>
          <div className="login-hint">
            <p>دخول النخبة التجريبي: <b dir="ltr">admin@mandoub.test</b> / <b dir="ltr">Demo1234!</b></p>
            <p className="muted small">🔒 بياناتك محمية بمعايير دولية. الموقع يُجمع أثناء المهمة فقط بموافقتك، ويُحذف تلقائياً بعد مدة الاحتفاظ.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
