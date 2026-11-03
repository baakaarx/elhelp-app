import { useEffect, useState, type FormEvent } from 'react';
import { login, loginWithSocial } from './session';
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
          <SocialLogin onLogin={onLogin} onError={setError} />
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

function SocialLogin({ onLogin, onError }: { onLogin: (u: User) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const clientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || (window as any).__GOOGLE_CLIENT_ID__ || '';
  useEffect(() => {
    if (!clientId) return;
    const id = 'google-gsi';
    if (document.getElementById(id)) return;
    const s = document.createElement('script'); s.id = id; s.src = 'https://accounts.google.com/gsi/client'; (s as any).async = true; document.head.appendChild(s);
    s.onload = () => {
      try {
        const google = (window as any).google;
        if (!google?.accounts?.id) return;
        google.accounts.id.initialize({
          client_id: clientId,
          callback: async (resp: any) => {
            try { setBusy('google'); const u = await loginWithSocial('google', resp.credential); onLogin(u); } catch (e: any) { onError(e?.message || 'فشل تسجيل الدخول بـ Google'); } finally { setBusy(null); }
          },
          auto_select: false,
        });
      } catch {}
    };
  }, [clientId, onLogin, onError]);
  const promptToken = async (provider: 'google' | 'apple') => {
    const t = window.prompt(provider === 'google' ? 'الصق Google ID Token (للاختبار) — أو سيتم فتح نافذة Google إن كان مُعداً' : 'الصق Apple ID Token (للاختبار)');
    if (!t) return;
    setBusy(provider);
    try { const u = await loginWithSocial(provider, t.trim()); onLogin(u); } catch (e: any) { onError(e?.message || `فشل تسجيل الدخول بـ ${provider}`); } finally { setBusy(null); }
  };
  const handleGoogle = () => {
    const google = (window as any).google;
    if (clientId && google?.accounts?.id?.prompt) {
      try { google.accounts.id.prompt(); return; } catch {}
      const holder = document.getElementById('g_id_signin');
      if (holder) {
        try { google.accounts.id.renderButton(holder, { theme: 'outline', size: 'large', text: 'continue_with', locale: 'ar' }); holder.style.display = 'block'; return; } catch {}
      }
    }
    promptToken('google');
  };
  return (
    <div className="stack" style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: 0.7 }}>
        <span style={{ flex: 1, height: 1, background: '#e2e8e1' }} />
        <span className="muted small">أو الدخول بدون كلمة سر</span>
        <span style={{ flex: 1, height: 1, background: '#e2e8e1' }} />
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <button type="button" className="btn ghost" onClick={handleGoogle} disabled={!!busy} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderColor: '#dadce0', background: '#fff' }}>
          <span style={{ fontSize: 16 }}>🔵</span> {busy === 'google' ? 'جارٍ…' : 'المتابعة بـ Google (Gmail)'}
        </button>
        <div id="g_id_signin" style={{ display: 'none', textAlign: 'center' }} />
        <button type="button" className="btn ghost" onClick={() => promptToken('apple')} disabled={!!busy} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#000', color: '#fff', borderColor: '#000' }}>
          <span style={{ fontSize: 14 }}></span> {busy === 'apple' ? 'جارٍ…' : 'المتابعة بـ Apple (iCloud)'}
        </button>
        <p className="muted small" style={{ textAlign: 'center', lineHeight: 1.6 }}>
          الدخول الاجتماعي ينشئ حسابك تلقائياً وينتظر <b>موافقة المدير</b> قبل التفعيل — بدون تسجيل يدوي.
          {!clientId && <span> · للتفعيل الكامل يضع المدير <code>VITE_GOOGLE_CLIENT_ID</code> في Vercel</span>}
        </p>
      </div>
    </div>
  );
}
