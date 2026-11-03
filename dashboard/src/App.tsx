import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, getToken, patch, post, setToken } from './api';
import { ENGINEER_APP_PATH, ago, durationText, formatNumber, isManager, logout, me } from './session';
import Login from './Login';
import MapView from './MapView';
import LocationName from './LocationName';
import { movementStatus } from './locationStatus';
import Reports from './Reports';
import Performance from './Performance';
import AgentPanel from './AgentPanel';
import Monthly from './Monthly';
import type { ManagerAlert, Overview, Rep, Report, RouteResponse, User, Visit } from './types';
import { visitPurposeLabels } from './types';

type Tab = 'live' | 'performance' | 'monthly' | 'reports' | 'team' | 'account' | 'agent';
const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'live', label: 'مركز العمليات', icon: '◈' },
  { id: 'monthly', label: 'السجل الشهري', icon: '▦' },
  { id: 'performance', label: 'مؤشرات التأثير', icon: '▲' },
  { id: 'reports', label: 'إنجازات وتقارير', icon: '✦' },
  { id: 'team', label: 'نخبة الفريق', icon: '◆' },
  { id: 'agent', label: 'المساعد الذكي', icon: '🤖' },
  { id: 'account', label: 'هويتي', icon: '◉' },
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
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
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
      setSyncedAt(Date.now());
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
    socket.on('overview', (data: Overview) => { setOverview(data); setSyncedAt(Date.now()); });
    socket.on('report', () => refresh());
    socket.on('daily-report', () => refresh());
    socket.on('visit', () => refresh());
    const poll = setInterval(refresh, connected ? 30000 : 2000);
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
  if (!isManager(user)) return <EngineerRedirect />;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-img" src="/elhelb-mark.png" alt="الهلب جروب" width={44} height={44} />
          <div><strong>ELHELB GROUP</strong><small>Elite Field Network · منذ 1993</small></div>
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
                <MapView reps={reps} selectedId={selectedId} route={route} live={connected} syncedAt={syncedAt} />
                <div className="map-controls">
                  <label className="field inline">
                    <span>يوم المسار</span>
                    <input type="date" lang="ar-EG" value={routeDate} max={new Date().toISOString().slice(0, 10)} onChange={e => setRouteDate(e.target.value)} />
                  </label>
                  {routeDate && <button className="btn ghost sm" onClick={() => setRouteDate('')}>اليوم</button>}
                  {route && <span className="muted small">{arabicDate(route.date)} · {formatNumber(route.distanceMeters / 1000)} كم · {formatNumber(route.points.length)} نقطة</span>}
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
                          <small>{movementStatus(rep, clock)} · آخر موقع {ago(rep.location?.recordedAt ?? null, clock)} · {formatNumber(rep.visitsToday)} زيارة</small>
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
                    <p className="muted small">{selected.phone || 'بدون هاتف'} · {movementStatus(selected, clock)}</p>
                    <LocationName key={selected.id} location={selected.location} />
                    <dl>
                      <div><dt>آخر موقع</dt><dd>{ago(selected.location?.recordedAt ?? null, clock)}</dd></div>
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
        {tab === 'monthly' && <Monthly reps={reps} />}
        {tab === 'reports' && <Reports reps={reps} onReviewed={refresh} />}
        {tab === 'team' && <Team reps={reps} onChange={refresh} />}
        {tab === 'agent' && <AgentPanel reps={reps} />}
        {tab === 'account' && <Account user={user} overview={overview} />}
      </main>
    </div>
  );
}

/**
 * A representative who signs in here is sent to the engineer app instead of seeing an
 * empty manager shell (every admin endpoint would 403). The dashboard token is cleared
 * first so /app cannot bounce back into this same redirect.
 */
function EngineerRedirect() {
  useEffect(() => {
    // Hand the session over so the engineer lands signed in instead of typing the same
    // credentials twice. The key matches mobile/src/storage.ts on web; the dashboard token
    // is cleared immediately so /app cannot bounce back into this redirect.
    const token = getToken();
    if (token) {
      try { window.localStorage.setItem('mandoub_token', token); } catch { /* private mode */ }
    }
    setToken(null);
    window.location.replace(ENGINEER_APP_PATH);
  }, []);
  return (
    <div className="boot redirect">
      <p>هذا الحساب لمهندس مبيعات — جارٍ تحويلك إلى تطبيق المهندس…</p>
      <p className="small"><a href={ENGINEER_APP_PATH}>افتح تطبيق المهندس</a></p>
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

const arabicDate = (iso: string) => {
  const date = new Date(`${iso}T00:00:00`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' });
};

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="stat"><span className="label">{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}

function Team({ reps, onChange }: { reps: Rep[]; onChange: () => void }) {
  const [error, setError] = useState('');
  async function toggle(rep: Rep) {
    try { await patch(`/api/reps/${rep.id}`, { active: !rep.active }); onChange(); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحديث الحساب.'); }
  }
  async function approve(rep: Rep, status: 'approved' | 'rejected') {
    try { await patch(`/api/reps/${rep.id}/approval`, { status }); onChange(); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحديث الموافقة.'); }
  }
  async function resetDevice(rep: Rep) {
    try { await post(`/api/reps/${rep.id}/reset-device`, {}); onChange(); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر إعادة ربط الجهاز.'); }
  }
  const pending = reps.filter(r => (r as any).approvalStatus === 'pending');
  const inWork = reps.filter(r => r.tracking || r.online);
  return (
    <section className="page">
      <header className="page-head"><div><h2>الفريق</h2><p className="muted">إدارة الفريق — من في الميدان حالاً وطابور القبول للمنضمين الجدد.</p></div></header>
      {error && <p className="error banner" role="alert">{error}</p>}
      <div className="two-col">
        <div className="panel">
          <h3 className="panel-title">قبول المهندسين <span className="pill warn">{formatNumber(pending.length)} بانتظار الموافقة</span></h3>
          <p className="muted small">اللي سجّل بـ Google / Apple بيستنى موافقتك — اضغط قبول ليبدأ شغله فوراً، أو رفض لحجبه. بدون تسجيل يدوي.</p>
          <ul className="rep-list">
            {pending.length === 0 && <li className="empty">لا يوجد طلبات جديدة — كل المهندسين مقبولين.</li>}
            {pending.map(rep => (
              <li key={rep.id} className="team-row" style={{ borderColor: '#f0c27a', background: '#fffaf0' }}>
                <span className="dot" style={{ background: rep.color }} aria-hidden="true" />
                <span className="grow"><strong>{rep.name}</strong><small dir="ltr">{rep.email}</small><small>{(rep as any).oauthProvider ? `دخول عبر ${(rep as any).oauthProvider}` : rep.region || 'بدون منطقة'} · {new Date((rep as any).created_at || Date.now()).toLocaleDateString('ar-EG')}</small>{(rep as any).deviceId ? <small className="mono" dir="ltr">📱 {(rep as any).deviceId.slice(0, 12)}…</small> : <small className="muted small">بدون جهاز بعد</small>}</span>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button className="btn primary sm" onClick={() => approve(rep, 'approved')}>قبول</button>
                  <button className="btn ghost sm" onClick={() => approve(rep, 'rejected')}>رفض</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h3 className="panel-title">الناس اللي في الشغل حالاً ({formatNumber(inWork.length)} / {formatNumber(reps.filter(r => r.active).length)})</h3>
          <p className="muted small">يظهر فقط المهندسين اللي فاتحين وردية أو متصلين الآن — مربوط بجهازهم.</p>
          <ul className="rep-list">
            {inWork.length === 0 && <li className="empty">مفيش حد في الشغل دلوقتي — أول ما يفتح وردية هيظهر هنا بعلامة خضراء.</li>}
            {inWork.map(rep => (
              <li key={rep.id} className="team-row">
                <span className="dot" style={{ background: rep.color }} aria-hidden="true" />
                <span className="grow"><strong>{rep.name}</strong><small dir="ltr">{rep.email}</small><small>{rep.tracking ? '● في وردية الآن' : '○ متصل'} · {rep.region || 'بدون منطقة'} · {formatNumber(rep.visitsToday)} زيارة اليوم · {rep.shiftStartedAt ? `بدأ ${new Date(rep.shiftStartedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}` : ''}</small>{(rep as any).deviceId ? <small className="mono" dir="ltr">📱 {(rep as any).deviceId.slice(0, 12)}…</small> : null}</span>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(rep as any).deviceId && <button className="btn ghost sm" onClick={() => resetDevice(rep)}>فك ربط الجهاز</button>}
                  <button className={rep.active ? 'btn ghost sm' : 'btn primary sm'} onClick={() => toggle(rep)}>{rep.active ? 'إيقاف' : 'تفعيل'}</button>
                </span>
              </li>
            ))}
          </ul>
          {reps.filter(r => !inWork.includes(r) && r.active && (r as any).approvalStatus !== 'pending').length > 0 && (
            <>
              <h4 className="muted small" style={{ marginTop: 12 }}>باقي الفريق (خارج الوردية)</h4>
              <ul className="rep-list muted">
                {reps.filter(r => !inWork.includes(r) && r.active && (r as any).approvalStatus !== 'pending').slice(0, 8).map(rep => (
                  <li key={rep.id} className="team-row" style={{ opacity: 0.85 }}>
                    <span className="dot" style={{ background: rep.color }} aria-hidden="true" />
                    <span className="grow"><strong>{rep.name}</strong><small>{rep.region || 'بدون منطقة'}</small></span>
                    <button className="btn ghost sm" onClick={() => toggle(rep)}>إيقاف</button>
                  </li>
                ))}
              </ul>
            </>
          )}
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
