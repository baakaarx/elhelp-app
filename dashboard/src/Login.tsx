import { useState, type FormEvent } from 'react';
import { ApiError } from './api';
import { login } from './session';
import type { User } from './types';

export default function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  /** The server asked for the second factor: the field only appears once it does. */
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try { onLogin(await login(email.trim(), password, needsCode ? code.trim() : undefined)); }
    catch (e) {
      const apiError = e instanceof ApiError ? e : null;
      if (apiError?.code === 'TOTP_REQUIRED' || apiError?.code === 'TOTP_INVALID') setNeedsCode(true);
      setError(e instanceof Error ? e.message : 'تعذر تسجيل الدخول.');
    }
    finally { setBusy(false); }
  }
  return (
    <div className="login-wrap">
      <div className="login-shell">
        <aside className="login-aside">
          <img className="aside-logo" src="/elhelb-logo.gif" alt="شعار الهلب جروب" width={150} height={183} />
          <div>
            <h2>ELHELB GROUP</h2>
            <p className="tagline">مهندسو الميدان · منذ ١٩٩٣</p>
            <p className="aside-note">٣٠ عاماً من الريادة · من المختبر إلى الحقل، خبراؤنا يصنعون الأثر كل يوم.</p>
          </div>
          <ul>
            <li>✦ متابعة لحظية لفريق الميدان</li>
            <li>✦ توثيق إنجازات وزيارات موقعة رقمياً</li>
            <li>✦ ذكاء ميداني ومؤشرات تأثير قابلة للقياس</li>
          </ul>
        </aside>
        <div className="login-card">
          <div className="login-brand">
            <img className="brand-mark" src="/elhelb-emblem.png" alt="شعار الهلب جروب" width={52} height={52} />
            <div>
              <h1>مركز العمليات</h1>
              <p>الهلب جروب الدولية · متابعة الميدان</p>
            </div>
          </div>
          <form onSubmit={submit} className="stack">
            <label className="field">
              <span>البريد الإلكتروني</span>
              <input type="email" dir="ltr" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} placeholder="manager@company.com" />
            </label>
            <label className="field">
              <span>كلمة المرور</span>
              <input type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
            </label>
            {needsCode && (
              <label className="field">
                <span>رمز المصادقة الثنائية</span>
                <input type="text" dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                  value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" required={needsCode} />
              </label>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn primary" disabled={busy}>{busy ? 'جارٍ الدخول…' : 'دخول →'}</button>
          </form>
          <div className="login-switch">
            <span>مهندس مبيعات؟</span>
            <a href="/app" className="btn ghost sm">افتح تطبيق المهندس ←</a>
          </div>
          <div className="login-hint">
            <p className="muted small">🔒 بياناتك محمية بمعايير دولية. الموقع يُجمع أثناء المهمة فقط بموافقتك، ويُحذف تلقائياً بعد مدة الاحتفاظ.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
