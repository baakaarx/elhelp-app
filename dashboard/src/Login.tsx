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
              <h1>مركز العمليات</h1>
              <p>الهلب جروب الدولية · مركز عمليات النخبة</p>
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
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn primary" disabled={busy}>{busy ? 'جارٍ الدخول…' : 'دخول →'}</button>
          </form>
          <SocialLogin onError={setError} />
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

function SocialLogin({ onError }: { onError: (message: string) => void }) {
  const unavailable = () => onError('تسجيل الدخول بـ Google وApple غير مفعّل حالياً.');
  return (
    <div className="stack" style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: 0.7 }}>
        <span style={{ flex: 1, height: 1, background: '#e2e8e1' }} />
        <span className="muted small">أو الدخول بدون كلمة سر</span>
        <span style={{ flex: 1, height: 1, background: '#e2e8e1' }} />
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <button type="button" className="btn ghost" onClick={unavailable} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderColor: '#dadce0', background: '#fff' }}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" style={{ flexShrink: 0 }}><path fill="#4285F4" d="M21.35 12.25c0-.72-.06-1.4-.18-2.06H12v3.9h5.24a4.48 4.48 0 0 1-1.95 2.94v2.54h3.17c1.85-1.71 2.89-4.22 2.89-7.32z" /><path fill="#34A853" d="M12 21.75c2.64 0 4.86-.87 6.48-2.36l-3.17-2.46c-.88.59-2.01.94-3.31.94-2.55 0-4.71-1.72-5.48-4.04H3.25v2.53A9.75 9.75 0 0 0 12 21.75z" /><path fill="#FBBC05" d="M6.52 13.83a5.86 5.86 0 0 1 0-3.66V7.64H3.25a9.75 9.75 0 0 0 0 8.72l3.27-2.53z" /><path fill="#EA4335" d="M12 6.13c1.44 0 2.73.5 3.75 1.47l2.81-2.81A9.36 9.36 0 0 0 12 2.25a9.75 9.75 0 0 0-8.75 5.39l3.27 2.53C7.29 7.85 9.45 6.13 12 6.13z" /></svg> المتابعة بـ Google (Gmail)
        </button>
        <button type="button" className="btn ghost" onClick={unavailable} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#000', color: '#fff', borderColor: '#000' }}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" style={{ flexShrink: 0 }}><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" /></svg> المتابعة بـ Apple (iCloud)
        </button>
      </div>
    </div>
  );
}
