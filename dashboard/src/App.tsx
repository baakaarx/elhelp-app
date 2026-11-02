import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, getToken, patch, post } from './api';
import { ago, downloadKpisCsv, durationText, formatNumber, logout, me } from './session';
import Login from './Login';
import MapView from './MapView';
import Reports from './Reports';
import Performance from './Performance';
import type { ManagerAlert, Overview, Rep, Report, RouteResponse, User, Visit } from './types';
import { visitPurposeLabels } from './types';

type Tab = 'live' | 'performance' | 'reports' | 'team' | 'account';
const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'live', label: 'المتابعة الحية', icon: '◎' },
  { id: 'performance', label: 'الأداء والمؤشرات', icon: '▲' },
  { id: 'reports', label: 'التقارير', icon: '▤' },
  { id: 'team', label: 'الفريق', icon: '☷' },
  { id: 'account', label: 'الحساب والخصوصية', icon: '⚙' },
];

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [alerts, setAlerts] = useState<ManagerAlert[]>([]);
  const [tab, setTab] = useState<Tab>('live');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [routeDate, setRouteDate] = useState('');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now());
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => { me().then(setUser).catch(() => setUser(null)); }, []);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 5000); return () => clearInterval(timer); }, []);

  const refresh = useCallback(async () => {
    try {
      const [nextOverview, nextAlerts] = await Promise.all([
        api<Overview>('/api/overview'),
        api<{ alerts: ManagerAlert[] }>('/api/alerts'),
      ]);
      setOverview(nextOverview);
      setAlerts(nextAlerts.alerts);
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحديث البيانات.'); }
  }, []);

  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    refresh();
    const socket = io('/', { auth: { token: getToken() }, transports: ['websocket', 'polling'], reconnectionDelayMax: 5000 });
    socketRef.current = socket;
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('overview', (data: Overview) => setOverview(data));
    socket.on('report', () => refresh());
    socket.on('daily-report', () => refresh());
    socket.on('visit', () => refresh());
    const poll = setInterval(refresh, connected ? 30000 : 8000);
    return () => { clearInterval(poll); socket.close(); socketRef.current = null; };
    // `connected` is intentionally excluded: re-creating the socket on every connect event would churn connections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, refresh]);

  const reps = overview?.reps ?? [];
  const selected = useMemo(() => reps.find(r => r.id === selectedId) ?? null, [reps, selectedId]);
  const activeToday = reps.filter(r => r.location).length;
  const trackingNow = reps.filter(r => r.tracking).length;
  const totalKm = reps.reduce((sum, r) => sum + r.distanceMeters, 0);
  const warnCount = alerts.filter(a => a.level === 'warn').length;

  useEffect(() => {
    if (!selectedId) { setRoute(null); setVisits([]); return; }
    let cancelled = false;
    const query = routeDate ? `?date=${routeDate}` : '';
    api<RouteResponse>(`/api/reps/${selectedId}/route${query}`)
      .then(res => { if (!cancelled) setRoute(res); })
      .catch(() => { if (!cancelled) setRoute(null); });
    api<{ visits: Visit[] }>(`/api/visits?repId=${selectedId}${query.replace('?', '&')}`)
      .then(res => { if (!cancelled) setVisits(res.visits); })
      .catch(() => { if (!cancelled) setVisits([]); });
    return () => { cancelled = true; };
  }, [selectedId, routeDate, overview?.serverTime]);

  if (user === undefined) return <div className="boot">جارٍ التحقق من الجلسة…</div>;
  if (!user) return <Login onLogin={setUser} />;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">ه</span>
          <div><strong>الهلب</strong><small>متابعة الميدان</small></div>
        </div>
        <nav>
          {tabs.map(item => (
            <button key={item.id} className={tab === item.id ? 'nav-item active' : 'nav-item'} onClick={() => setTab(item.id)}>
              <span aria-hidden="true">{item.icon}</span> {item.label}
              {item.id === 'reports' && overview && overview.newReports > 0 && <em className="badge">{formatNumber(overview.newReports)}</em>}
              {item.id === 'live' && warnCount > 0 && <em className="badge warn">{formatNumber(warnCount)}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <p className="small"><span className={connected ? 'status ok' : 'status'} /> {connected ? 'متصل بالبث الحي' : 'وضع التحديث الدوري'}</p>
          {overview?.demo && <p className="pill demo">وضع تجريبي</p>}
          <p className="muted small">مدة الاحتفاظ: {formatNumber(overview?.retentionDays ?? 30)} يوم · {overview?.timezone ?? 'Africa/Cairo'}</p>
        </div>
      </aside>
      <main className="content">
        <header className="topbar">
          <div>
            <h1>{tabs.find(t => t.id === tab)?.label}</h1>
            <p className="muted small">{new Date(clock).toLocaleString('ar-EG', { dateStyle: 'full', timeStyle: 'short' })} · {user.name}</p>
          </div>
          <div className="topbar-actions">
            <button className="btn ghost sm" onClick={() => refresh()}>تحديث</button>
            <button className="btn ghost sm" onClick={async () => { await logout(); setUser(null); }}>خروج</button>
          </div>
        </header>
        {error && <p className="error banner" role="alert">{error}</p>}
        {tab === 'live' && (
          <section className="page">
            {alerts.length > 0 && <AlertsPanel alerts={alerts} onPick={repId => { if (repId) { setSelectedId(repId); } }} />}
            <div className="stats">
              <Stat label="مهندسون في الميدان" value={formatNumber(activeToday)} hint={`من ${formatNumber(reps.length)} مهندس`} />
              <Stat label="يتتبع الآن" value={formatNumber(trackingNow)} hint="وردية مفتوحة" />
              <Stat label="إجمالي مسافة اليوم" value={`${formatNumber(totalKm / 1000)} كم`} hint="تقديري بعد استبعاد النقاط الضعيفة" />
              <Stat label="بانتظار المراجعة" value={formatNumber(overview?.newReports ?? 0)} hint="تقارير ميدان ويومية" />
            </div>
            <div className="live-grid">
              <div className="panel map-panel">
                <MapView reps={reps} selectedId={selectedId} route={route} />
                <div className="map-controls">
                  <label className="field inline">
                    <span>يوم المسار</span>
                    <input type="date" value={routeDate} max={new Date().toISOString().slice(0, 10)} onChange={e => setRouteDate(e.target.value)} />
                  </label>
                  {routeDate && <button className="btn ghost sm" onClick={() => setRouteDate('')}>اليوم</button>}
                  {route && <span className="muted small">{route.date} · {formatNumber(route.distanceMeters / 1000)} كم · {formatNumber(route.points.length)} نقطة</span>}
                </div>
              </div>
              <div className="panel">
                <h3 className="panel-title">الفريق الآن</h3>
                <ul className="rep-list">
                  {reps.length === 0 && <li className="empty">لا يوجد مهندسون بعد. أضفهم من صفحة الفريق.</li>}
                  {reps.map(rep => (
                    <li key={rep.id}>
                      <button className={selectedId === rep.id ? 'rep active' : 'rep'} onClick={() => setSelectedId(rep.id)}>
                        <span className="dot" style={{ background: rep.color }} aria-hidden="true" />
                        <span className="grow">
                          <strong>{rep.name}</strong>
                          <small>{rep.region || 'بدون منطقة'} · {rep.tracking ? 'في وردية' : 'لا يتتبع'} · {formatNumber(rep.visitsToday)} زيارة · {ago(rep.lastSeen, clock)}</small>
                        </span>
                        <span className={rep.online ? 'status ok' : 'status'} title={rep.online ? 'متصل' : 'غير متصل'} />
                        <small className="mono">{formatNumber(rep.distanceMeters / 1000)} كم</small>
                      </button>
                    </li>
                  ))}
                </ul>
                {selected && (
                  <div className="selected-summary">
                    <h4>{selected.name}</h4>
                    <p className="muted small">{selected.phone || 'بدون هاتف'} · {selected.region || 'بدون منطقة'}</p>
                    <dl>
                      <div><dt>آخر إشارة</dt><dd>{ago(selected.lastSeen, clock)}</dd></div>
                      <div><dt>دقة الموقع</dt><dd>{selected.location?.accuracy ? `${formatNumber(selected.location.accuracy)} م` : '—'}</dd></div>
                      <div><dt>البطارية</dt><dd>{selected.location?.battery !== null && selected.location?.battery !== undefined ? `${formatNumber(selected.location.battery)}٪` : '—'}</dd></div>
                      <div><dt>بداية الوردية</dt><dd>{selected.shiftStartedAt ? new Date(selected.shiftStartedAt).toLocaleTimeString('ar-EG') : '—'}</dd></div>
                      <div><dt>زيارات اليوم</dt><dd>{formatNumber(selected.visitsToday)}</dd></div>
                      <div><dt>زيارة مفتوحة</dt><dd>{selected.openVisit ? selected.openVisit.customerName : 'لا'}</dd></div>
                    </dl>
                    {visits.length > 0 && (
                      <div className="selected-visits">
                        <h5>زيارات {routeDate || 'اليوم'}</h5>
                        <ul>
                          {visits.slice(0, 6).map(visit => (
                            <li key={visit.id}>
                              <span className="dot" style={{ background: visit.status === 'open' ? '#b45309' : '#2f7a5f' }} aria-hidden="true" />
                              <span className="grow"><strong>{visit.customerName}</strong><small>{visitPurposeLabels[visit.purpose]} · {new Date(visit.checkedInAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}{visit.status === 'open' ? ' · مفتوحة' : ` · ${durationText(visit.durationSeconds)}`}</small></span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
        {tab === 'performance' && <Performance reps={reps} />}
        {tab === 'reports' && <Reports reps={reps} onReviewed={refresh} />}
        {tab === 'team' && <Team reps={reps} onChange={refresh} />}
        {tab === 'account' && <Account user={user} overview={overview} />}
      </main>
    </div>
  );
}

function AlertsPanel({ alerts, onPick }: { alerts: ManagerAlert[]; onPick: (repId?: string) => void }) {
  const [open, setOpen] = useState(true);
  const warn = alerts.filter(a => a.level === 'warn');
  const shown = open ? alerts.slice(0, 8) : alerts.slice(0, 2);
  return (
    <div className="alerts-panel" role="region" aria-label="تنبيهات الميدان">
      <div className="alerts-head">
        <strong>تنبيهات الميدان <span className="pill warn">{formatNumber(warn.length)} مهم</span> <span className="pill">{formatNumber(alerts.length)} إجمالًا</span></strong>
        <button className="btn ghost sm" onClick={() => setOpen(value => !value)}>{open ? 'طي' : 'عرض الكل'}</button>
      </div>
      <ul>
        {shown.map(alert => (
          <li key={alert.id} className={alert.level === 'warn' ? 'alert warn' : 'alert'}>
            <span className="alert-dot" aria-hidden="true" />
            <div className="grow">
              <strong>{alert.title}{alert.repName ? ` · ${alert.repName}` : ''}</strong>
              <small>{alert.detail}</small>
            </div>
            {alert.repId && <button className="btn ghost sm" onClick={() => onPick(alert.repId)}>فتح</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="card stat"><span className="muted small">{label}</span><strong>{value}</strong><small className="muted">{hint}</small></div>;
}

function Team({ reps, onChange }: { reps: Rep[]; onChange: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '', region: '' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      await post('/api/reps', form);
      setMessage(`تم إنشاء حساب ${form.name}.`);
      setForm({ name: '', email: '', password: '', phone: '', region: '' });
      onChange();
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إنشاء الحساب.'); }
    finally { setBusy(false); }
  }
  async function toggle(rep: Rep) {
    try { await patch(`/api/reps/${rep.id}`, { active: !rep.active }); onChange(); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحديث الحساب.'); }
  }
  return (
    <section className="page">
      <header className="page-head"><div><h2>الفريق</h2><p className="muted">أضف المهندسين وتحكم في صلاحية الدخول والتتبع.</p></div></header>
      <div className="two-col">
        <div className="panel">
          <h3 className="panel-title">إضافة مهندس</h3>
          <form className="stack" onSubmit={submit}>
            <label className="field"><span>الاسم</span><input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="محمد أحمد" /></label>
            <label className="field"><span>البريد الإلكتروني</span><input required type="email" dir="ltr" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="rep@company.com" /></label>
            <label className="field"><span>كلمة مرور مؤقتة (١٠ أحرف على الأقل)</span><input required minLength={10} type="password" dir="ltr" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></label>
            <div className="row">
              <label className="field"><span>الهاتف</span><input dir="ltr" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></label>
              <label className="field"><span>المنطقة</span><input value={form.region} onChange={e => setForm({ ...form, region: e.target.value })} placeholder="الإسكندرية" /></label>
            </div>
            {message && <p className="ok-text">{message}</p>}
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn primary" disabled={busy}>{busy ? 'جارٍ الإنشاء…' : 'إنشاء الحساب'}</button>
          </form>
        </div>
        <div className="panel">
          <h3 className="panel-title">الحسابات ({formatNumber(reps.length)})</h3>
          <ul className="rep-list">
            {reps.map(rep => (
              <li key={rep.id} className="team-row">
                <span className="dot" style={{ background: rep.color }} aria-hidden="true" />
                <span className="grow"><strong>{rep.name}</strong><small dir="ltr">{rep.email}</small><small>{rep.isDemo ? 'حساب عرض تجريبي (محاكاة)' : rep.region || 'بدون منطقة'}{rep.active ? '' : ' · موقوف'}</small></span>
                <button className={rep.active ? 'btn ghost sm' : 'btn primary sm'} onClick={() => toggle(rep)}>{rep.active ? 'إيقاف' : 'تفعيل'}</button>
              </li>
            ))}
            {reps.length === 0 && <li className="empty">لا يوجد مهندسون بعد.</li>}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Account({ user, overview }: { user: User; overview: Overview | null }) {
  return (
    <section className="page">
      <header className="page-head"><div><h2>الحساب والخصوصية</h2><p className="muted">بياناتك وسياسة جمع الموقع.</p></div></header>
      <div className="two-col">
        <div className="panel">
          <h3 className="panel-title">بيانات الحساب</h3>
          <dl className="account-dl">
            <div><dt>الاسم</dt><dd>{user.name}</dd></div>
            <div><dt>البريد</dt><dd dir="ltr">{user.email}</dd></div>
            <div><dt>الدور</dt><dd>{user.role === 'admin' ? 'متابعة (مدير)' : 'مهندس مبيعات'}</dd></div>
            <div><dt>المنطقة</dt><dd>{user.region || '—'}</dd></div>
          </dl>
          <p className="muted small">تصدير المؤشرات متاح من صفحة «الأداء والمؤشرات» بصيغة CSV تفتح في Excel.</p>
        </div>
        <div className="panel prose">
          <h3 className="panel-title">الخصوصية والاحتفاظ</h3>
          <ul>
            <li>لا يبدأ التتبع إلا بعد موافقة صريحة داخل التطبيق، ويظهر مؤشر دائم أثناء التسجيل.</li>
            <li>تُرسل النقاط في دفعات كل ثانية تقريبًا، وتُحذف تلقائيًا بعد <b>{formatNumber(overview?.retentionDays ?? 30)}</b> يومًا.</li>
            <li>المسافات تقديرية لأغراض المتابعة، ولا تُستخدم كأساس وحيد للرواتب أو البدلات.</li>
            <li>كل عملية حساسة (بدء وردية، إنهاء زيارة، إيقاف حساب، تنزيل تقرير) تُسجل في سجل تدقيق.</li>
            <li>الملفات المرفوعة أو الحسابات التجريبية لا تتضمن بيانات عملاء حقيقية.</li>
          </ul>
          <p className="muted small">المنطقة الزمنية: {overview?.timezone ?? 'Africa/Cairo'} · إصدار الموافقة: 1.0</p>
        </div>
      </div>
    </section>
  );
}
