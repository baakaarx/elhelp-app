import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_AUTH_REQUIRED_EVENT, ApiError, api, del, getToken, patch, post, setToken } from './api';
import { dateTimeText, localDay, localDateText, timeText } from './dates';
import { ago, dashScope, durationText, formatNumber, isManager, logout, me, type DashScope } from './session';
import Login from './Login';
import MapView from './MapView';
import LocationName from './LocationName';
import { batteryText, batteryWarning, latestBattery, movementStatus, shiftText } from './locationStatus';
import Reports from './Reports';
import Customers from './Customers';
import Sales from './Sales';
import Stock from './Stock';
import Staff from './Staff';
import Performance from './Performance';
import AgentPanel from './AgentPanel';
import Monthly from './Monthly';
import type { IdleReport, ManagerAlert, Overview, Rep, RepImpact, Report, RouteResponse, User, Visit } from './types';
import ConfirmAction from './ConfirmAction';
import { visitPurposeLabels } from './types';

type Tab = 'live' | 'performance' | 'monthly' | 'reports' | 'customers' | 'sales' | 'stock' | 'team' | 'staff' | 'account' | 'agent';
const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'live', label: 'مركز العمليات', icon: '◈' },
  { id: 'monthly', label: 'السجل الشهري', icon: '▦' },
  { id: 'performance', label: 'مؤشرات التأثير', icon: '▲' },
  { id: 'reports', label: 'إنجازات وتقارير', icon: '✦' },
  { id: 'customers', label: 'العملاء', icon: '☰' },
  { id: 'sales', label: 'المبيعات', icon: '£' },
  { id: 'stock', label: 'المخازن', icon: '⛃' },
  { id: 'team', label: 'فريق الميدان', icon: '◆' },
  { id: 'staff', label: 'حسابات اللوحة', icon: '⚿' },
  { id: 'agent', label: 'المساعد الذكي', icon: '🤖' },
  { id: 'account', label: 'هويتي', icon: '◉' },
];

/**
 * Which tabs each dashboard account is offered, and the reason the list is a deny-by-default
 * allowlist rather than «hide the team tab» is that the same account is stopped on the server too
 * (scopeGate in the API). The list exists so a warehouse clerk never sees a screen that can only
 * answer 403; it is not what keeps the field private.
 */
const VISIBLE_TABS: Record<DashScope, Tab[]> = {
  manager: ['live', 'monthly', 'performance', 'reports', 'customers', 'sales', 'stock', 'team', 'staff', 'agent', 'account'],
  // The sales office runs the whole register — it just does not hand out logins.
  sales: ['live', 'monthly', 'performance', 'reports', 'customers', 'sales', 'stock', 'team', 'agent', 'account'],
  stock: ['stock', 'account'],
};

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [alerts, setAlerts] = useState<ManagerAlert[]>([]);
  const [idleReports, setIdleReports] = useState<IdleReport[]>([]);
  const [tab, setTab] = useState<Tab>('live');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  /** Bumped whenever stock or sales data may have changed, so those screens reload themselves. */
  const [feedVersion, setFeedVersion] = useState(0);
  const bumpFeed = useCallback(() => setFeedVersion(value => value + 1), []);
  // Bumped by a deletion on this screen so the list refetches now, not on the 30-second clock.
  const [visitsVersion, setVisitsVersion] = useState(0);
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [routeDate, setRouteDate] = useState('');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  /**
   * Bumped whenever a report may have changed, so the reports screen reloads itself.
   *
   * That screen used to load once when it opened: a manager sitting on it while an engineer
   * submitted a daily report saw nothing until he switched tabs and came back.
   */
  const [reportsVersion, setReportsVersion] = useState(0);
  const bumpReports = useCallback(() => setReportsVersion(value => value + 1), []);
  const socketRef = useRef<Socket | null>(null);
  const liveRef = useRef(false);
  const clearSession = useCallback(() => {
    setToken(null);
    liveRef.current = false;
    setUser(null);
    setOverview(null);
    setAlerts([]);
    setIdleReports([]);
    setSelectedId(null);
    setVisits([]);
    setRoute(null);
    setRouteDate('');
    setConnected(false);
    setSyncedAt(null);
    setError('');
  }, []);

  useEffect(() => {
    window.addEventListener(API_AUTH_REQUIRED_EVENT, clearSession);
    return () => window.removeEventListener(API_AUTH_REQUIRED_EVENT, clearSession);
  }, [clearSession]);
  useEffect(() => { me().then(setUser).catch(() => setUser(null)); }, []);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 5000); return () => clearInterval(timer); }, []);

  const refresh = useCallback(async () => {
    try {
      const [nextOverview, nextAlerts, nextIdle] = await Promise.all([
        api<Overview>('/api/overview'),
        api<{ alerts: ManagerAlert[] }>('/api/alerts'),
        // Stillness justifications: the engineer sends them from the phone, and without them
        // the manager only saw the alert vanish — never why.
        api<{ reports: IdleReport[] }>('/api/idle-reports?limit=20').catch(() => ({ reports: [] })),
      ]);
      setOverview(nextOverview);
      setAlerts(nextAlerts.alerts);
      setIdleReports(nextIdle.reports);
      setSyncedAt(Date.now());
      setError('');
      // With no live socket the poll is the only thing that can notice a new report, so the
      // reports screen follows it; when the socket is up its events do that job instead.
      if (!liveRef.current) bumpReports();
    } catch (e) {
      // api() removes an expired/invalid token on 401. Move back to login as well, rather than
      // leaving the manager-looking dashboard mounted with requests that can never succeed.
      if (e instanceof ApiError && (e.status === 401 || e.code === 'CLIENT_ROLE_MISMATCH')) {
        clearSession();
        return;
      }
      setError(e instanceof Error ? e.message : 'تعذر تحديث البيانات.');
    }
  }, [bumpReports, clearSession]);

  const scope = dashScope(user);
  const allowedTabs = tabs.filter(item => VISIBLE_TABS[scope].includes(item.id));
  // A warehouse account has no field feed to wait for; asking for one would only put a 403 banner
  // over the one screen it is allowed to use.
  const wantsFieldFeed = scope !== 'stock';
  // A scope that cannot open the tab it was left on (a manager switching their own account to
  // warehouses, say) lands on the first tab it can use. Depends on primitives only, so the effect
  // runs when the scope or the tab changes and not on every render.
  useEffect(() => {
    const allowed = VISIBLE_TABS[scope];
    if (!allowed.includes(tab)) setTab(allowed[0] ?? 'account');
  }, [scope, tab]);

  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    if (!wantsFieldFeed) { bumpFeed(); return; }
    refresh();
    const socket = io('/', { auth: { token: getToken() }, transports: ['websocket', 'polling'], reconnectionDelayMax: 5000 });
    socketRef.current = socket;
    socket.on('connect', () => { liveRef.current = true; setConnected(true); });
    socket.on('disconnect', () => { liveRef.current = false; setConnected(false); });
    socket.on('connect_error', () => { liveRef.current = false; setConnected(false); });
    socket.on('overview', (data: Overview) => { setOverview(data); setSyncedAt(Date.now()); });
    socket.on('report', () => { bumpReports(); refresh(); });
    socket.on('daily-report', () => { bumpReports(); refresh(); });
    socket.on('visit', () => refresh());
    // Stock and invoices change under the sales office while it is looking at a total, so the same
    // ping that updates the map refreshes those two screens.
    socket.on('stock:changed', bumpFeed);
    socket.on('invoice', bumpFeed);
    return () => { liveRef.current = false; socket.close(); socketRef.current = null; };
    // `connected` is intentionally excluded: re-creating the socket on every connect event would
    // churn connections. The poll below has its own effect precisely so it can follow it.
  }, [user, refresh, bumpReports, bumpFeed, wantsFieldFeed]);

  // The polling rate depends on the live socket, and the value read when the socket effect ran
  // was always the initial `false` — so a connected dashboard kept asking three endpoints every
  // two seconds instead of every thirty. Re-creating only the timer keeps the socket untouched.
  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    // A warehouse account still needs its screen to move on its own while the clerk walks between
    // the shelf and the desk; there is just nothing field-shaped for it to poll.
    if (!wantsFieldFeed) {
      const slow = setInterval(bumpFeed, 30000);
      return () => clearInterval(slow);
    }
    const poll = setInterval(refresh, connected ? 30000 : 2000);
    return () => clearInterval(poll);
  }, [user, refresh, connected, wantsFieldFeed, bumpFeed]);

  const reps = overview?.reps ?? [];
  const selected = useMemo(() => reps.find(r => r.id === selectedId) ?? null, [reps, selectedId]);
  const trackingNow = reps.filter(r => r.tracking).length;
  const totalKm = reps.reduce((sum, r) => sum + r.distanceMeters, 0);
  const warnCount = alerts.filter(a => a.level === 'warn').length;
  // Server owns the threshold so the map text, alert list and fresh-signal count agree.
  const staleGpsMinutes = overview?.staleGpsMinutes ?? 10;
  const staleMs = staleGpsMinutes * 60000;
  // Compare GPS timestamps with the API clock, then advance it locally between refreshes; this
  // avoids a manager laptop's clock skew changing who appears to have a current signal.
  const serverNow = overview?.serverTime !== undefined && syncedAt !== null
    ? overview.serverTime + Math.max(0, clock - syncedAt)
    : clock;
  // A visit in progress widens the window for that engineer only (the server ships
  // `staleLimitMinutes`), so a manager counting "fresh signal" is counting the same people the
  // alert list leaves alone.
  const freshSignalCount = reps.filter(rep => {
    const recordedAt = rep.location?.recordedAt;
    const limitMs = rep.staleLimitMinutes ? rep.staleLimitMinutes * 60_000 : staleMs;
    return rep.tracking && typeof recordedAt === 'number'
      && recordedAt <= serverNow + 120_000
      && serverNow - recordedAt <= limitMs;
  }).length;
  const visitStaleMinutes = reps.reduce((max, rep) => Math.max(max, rep.staleLimitMinutes ?? 0), 0);
  const selectedIdle = useMemo(() => idleReports.find(r => r.userId === selectedId) ?? null, [idleReports, selectedId]);

  // The trail is refreshed on its own slow clock. Tying it to `overview.serverTime` meant every
  // live position update re-downloaded the selected engineer's whole day, several times a minute.
  useEffect(() => {
    if (!selectedId) { setRoute(null); setVisits([]); return; }
    let cancelled = false;
    // Do not leave the previous engineer/day visible while the new route is loading.
    setRoute(null);
    setVisits([]);
    // The panel is labelled "زيارات اليوم" when no date is picked, so it has to ask for that day:
    // without it the list showed every visit the engineer ever made under a "today" heading.
    const day = routeDate || localDay(overview?.timezone);
    const query = `?date=${day}`;
    const load = () => {
      api<RouteResponse>(`/api/reps/${selectedId}/route${query}`)
        .then(res => { if (!cancelled) setRoute(res); })
        .catch(() => { if (!cancelled) setRoute(null); });
      api<{ visits: Visit[] }>(`/api/visits${query}&repId=${selectedId}`)
        .then(res => { if (!cancelled) setVisits(res.visits); })
        .catch(() => { if (!cancelled) setVisits([]); });
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selectedId, routeDate, visitsVersion, overview?.timezone]);

  /*
   * A visit left open by a dead phone is the one field record that blocks the next one: the
   * engineer stands at the next door and gets «لديك زيارة مفتوحة». The manager can clear it here,
   * next to the map, instead of hunting for it in the reports page — which is where he is when it
   * happens.
   */
  async function removeVisit(id: string) {
    try {
      await del(`/api/visits/${id}`);
      setVisitsVersion(current => current + 1);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر حذف الزيارة.'); }
  }

  if (user === undefined) return <div className="boot">جارٍ التحقق من الجلسة…</div>;
  if (!user) return <Login onLogin={setUser} />;
  if (!isManager(user)) return <EngineerOnlyNotice />;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-img" src="/elhelb-mark.png" alt="الهلب جروب" width={44} height={44} />
          <div><strong>ELHELB GROUP</strong><small>شبكة الميدان · منذ 1993</small></div>
        </div>

        <nav>
          {allowedTabs.map(item => (
            <button key={item.id} className={tab === item.id ? 'nav-item active' : 'nav-item'} onClick={() => setTab(item.id)}>
              <span aria-hidden="true">{item.icon}</span> {item.label}
              {item.id === 'reports' && overview && overview.newReports > 0 && <em className="badge">{formatNumber(overview.newReports)}</em>}
              {item.id === 'live' && warnCount > 0 && <em className="badge warn">{formatNumber(warnCount)}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <p className="small"><span className={connected ? 'status ok' : 'status'} /> {connected ? 'متصل بالبث الحي' : 'وضع التحديث الدوري'}</p>
          <p className="muted small">{overview ? `مدة الاحتفاظ: ${formatNumber(overview.retentionDays)} يوم` : 'جارٍ التحميل…'} · {overview?.timezone ?? 'Africa/Cairo'}</p>
        </div>
      </aside>
      <main className="content">
        <header className="topbar">
          <div>
            <h1>{tabs.find(t => t.id === tab)?.label}</h1>
            <p className="muted small">{dateTimeText(clock, overview?.timezone)} · {user.name}</p>
          </div>
          <div className="topbar-actions">
            <button className="btn ghost sm" onClick={() => (wantsFieldFeed ? void refresh() : bumpFeed())}>تحديث</button>
            <button className="btn ghost sm" onClick={async () => {
              try { await logout(); } catch { /* Local logout still wins if the API is unreachable. */ }
              clearSession();
            }}>خروج</button>
          </div>
        </header>
        {error && <p className="error banner" role="alert">{error}</p>}
        {tab === 'live' && (
          <section className="page">
            {alerts.length > 0 && <AlertsPanel alerts={alerts} staleMinutes={overview?.staleGpsMinutes ?? 10} visitStaleMinutes={visitStaleMinutes} onPick={repId => { if (repId) { setSelectedId(repId); } }} />}
            {idleReports.length > 0 && <JustificationsPanel reports={idleReports} clock={clock} onPick={repId => setSelectedId(repId)} />}
            <div className="stats">
              <Stat label="مهندسون بإشارة حديثة" value={formatNumber(freshSignalCount)} hint={`موقع خلال ${formatNumber(staleGpsMinutes)} دقيقة · من ${formatNumber(trackingNow)} وردية مفتوحة`} />
              <Stat label="ورديات مفتوحة" value={formatNumber(trackingNow)} hint="المهندسون الذين بدأوا الوردية" />
              <Stat label="إجمالي مسافة اليوم" value={`${formatNumber(totalKm / 1000)} كم`} hint="تقديري بعد استبعاد النقاط الضعيفة" />
              <Stat label="بانتظار المراجعة" value={formatNumber(overview?.newReports ?? 0)} hint="تقارير ميدان ويومية" />
            </div>
            <div className="live-grid">
              <div className="panel map-panel">
                <MapView reps={reps} selectedId={selectedId} route={route} live={connected} syncedAt={syncedAt} timezone={overview?.timezone} />
                <div className="map-controls">
                  <label className="field inline">
                    <span>يوم المسار</span>
                    <input type="date" lang="ar-EG" value={routeDate} max={localDay(overview?.timezone)} onChange={e => setRouteDate(e.target.value)} />
                  </label>
                  {routeDate && <button className="btn ghost sm" onClick={() => setRouteDate('')}>اليوم</button>}
                  {route && <span className="muted small">{arabicDate(route.date)} · {formatNumber(route.distanceMeters / 1000)} كم · {formatNumber(route.pointCount ?? route.points.length)} نقطة</span>}
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
                          <small>{movementStatus(rep, clock, staleMs, overview?.timezone)} · آخر موقع {ago(rep.location?.recordedAt ?? null, clock)} · {formatNumber(rep.visitsToday)} زيارة</small>
                        </span>
                        {/* The warning that matters: every fix carries the phone's battery, so a
                            device about to go silent is visible before the trail stops. Both bounds
                            (which reading counts, how old it may be) live in `batteryWarning`. */}
                        {(() => {
                          const percent = batteryWarning(rep, clock);
                          if (percent === null) return null;
                          return <span className="pill warn" title={`آخر قراءة من ${ago(latestBattery(rep)?.recordedAt ?? null, clock)}`}>بطارية {formatNumber(percent)}٪</span>;
                        })()}
                        <span className={rep.online ? 'status ok' : 'status'} title={rep.online ? 'متصل' : 'غير متصل'} />
                        <small className="mono">{formatNumber(rep.distanceMeters / 1000)} كم</small>
                      </button>
                    </li>
                  ))}
                </ul>
                {selected && (
                  <div className="selected-summary">
                    <h4>{selected.name}</h4>
                    <p className="muted small">{selected.phone || 'بدون هاتف'} · {movementStatus(selected, clock, staleMs, overview?.timezone)}</p>
                    <LocationName key={selected.id} location={selected.location} timezone={overview?.timezone} />
                    {selectedIdle && <p className="muted small">آخر تبرير وقوف: {selectedIdle.reason} · {ago(selectedIdle.createdAt, clock)}</p>}
                    <dl>
                      <div><dt>آخر موقع</dt><dd>{ago(selected.location?.recordedAt ?? null, clock)}</dd></div>
                      <div><dt>دقة الموقع</dt><dd>{selected.location?.accuracy ? `${formatNumber(selected.location.accuracy)} م` : '—'}</dd></div>
                      <div><dt>البطارية</dt><dd>{batteryText(selected, clock)}</dd></div>
                      {/* Measured from the trail, not from the phone's speed sensor: this is what
                          "كان واقف من الصبح" means when someone has to answer for it. */}
                      <div><dt>وقوف متواصل</dt><dd>{(selected.stationaryMinutes ?? 0) >= 5 ? `${formatNumber(selected.stationaryMinutes!)} دقيقة في نفس المنطقة` : '—'}</dd></div>
                      <div><dt>بداية الوردية</dt><dd>{shiftText(selected, overview?.timezone, clock)}</dd></div>
                      <div><dt>زيارات اليوم</dt><dd>{formatNumber(selected.visitsToday)}</dd></div>
                      <div><dt>زيارة مفتوحة</dt><dd>{selected.openVisit ? selected.openVisit.customerName : 'لا'}</dd></div>
                    </dl>
                    {visits.length > 0 && (
                      <div className="selected-visits">
                        <h5>زيارات {routeDate || 'اليوم'} ({formatNumber(visits.length)})</h5>
                        <div className="visit-cards">
                          {visits.map(visit => (
                            <article key={visit.id} className="card report visit-card">
                              <div className="report-head">
                                <span className="dot" style={{ background: visit.status === 'open' ? '#b45309' : '#2f7a5f' }} aria-hidden="true" />
                                <div className="grow">
                                  <h3>{visit.customerName}</h3>
                                  <p className="muted small">
                                    {visitPurposeLabels[visit.purpose]} · دخول {timeText(visit.checkedInAt, overview?.timezone)}
                                    {visit.checkedOutAt ? ` · خروج ${timeText(visit.checkedOutAt, overview?.timezone)}` : ''}
                                    {visit.status === 'open' ? ' · مفتوحة' : visit.durationSeconds === null ? (visit.autoClosed ? ' · أُغلقت تلقائيًا' : ' · منتهية') : ` · ${durationText(visit.durationSeconds)}`}
                                  </p>
                                </div>
                                <span className={visit.status === 'open' ? 'pill warn' : 'pill ok'}>{visit.status === 'open' ? 'مفتوحة' : 'منتهية'}</span>
                              </div>
                              {(visit.governorate || visit.district || visit.village || visit.phone) && (
                                <p className="muted small">
                                  {[visit.governorate, visit.district, visit.village].filter(Boolean).join(' · ') || '—'}
                                  {visit.phone ? ` · ${visit.phone}` : ''}
                                </p>
                              )}
                              {visit.outcome && <p className="body-text"><strong>النتيجة:</strong> {visit.outcome}</p>}
                              {visit.notes && <p className="body-text"><strong>ملاحظات:</strong> {visit.notes}</p>}
                              {/* The two marks a manager has to be able to see without exporting:
                                  a visit typed with no signal, and one that ended without a result. */}
                              {(visit.recordedOffline || visit.pendingResult) && (
                                <p className="visit-marks">
                                  {visit.recordedOffline ? 'من غير شبكة' : ''}
                                  {visit.recordedOffline && visit.pendingResult ? ' · ' : ''}
                                  {visit.pendingResult ? 'بدون نتيجة' : ''}
                                </p>
                              )}
                              <div className="report-actions">
                                <ConfirmAction label="حذف الزيارة" confirmLabel="تأكيد حذف الزيارة"
                                  detail={visit.status === 'open'
                                    ? 'مفتوحة — حذفها يحرّر المهندس يسجّل الزيارة الجاية.'
                                    : 'هيُحذف التسجيل من السجل الشهري.'}
                                  onConfirm={() => removeVisit(visit.id)} />
                              </div>
                            </article>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
        {tab === 'performance' && <Performance reps={reps} staleGpsMinutes={overview?.staleGpsMinutes ?? 10} timezone={overview?.timezone} />}
        {tab === 'monthly' && <Monthly reps={reps} timezone={overview?.timezone} />}
        {tab === 'reports' && <Reports reps={reps} onReviewed={refresh} version={reportsVersion} timezone={overview?.timezone} />}
        {tab === 'customers' && <Customers />}
        {tab === 'sales' && <Sales version={feedVersion} canManageStaff={scope === 'manager'} />}
        // The sales office reads the shelves; the price and movement forms belong to the warehouse
        // account (and to the manager, who keeps the override).
        {tab === 'stock' && <Stock version={feedVersion} readOnly={scope === 'sales'} canCorrect={scope === 'manager'} />}
        {tab === 'team' && <Team reps={reps} onChange={refresh} timezone={overview?.timezone} />}
        {tab === 'staff' && scope === 'manager' && <Staff />}
        {tab === 'agent' && <AgentPanel reps={reps} timezone={overview?.timezone} />}
        {tab === 'account' && <Account user={user} overview={overview} onDeleted={clearSession} />}
      </main>
    </div>
  );
}

/**
 * A defensive fallback for an old or mis-scoped browser session. Engineer accounts belong in
 * the engineer client at /app; this manager dashboard never transfers the session there.
 */
function EngineerOnlyNotice() {
  useEffect(() => { setToken(null); }, []);
  return (
    <div className="boot redirect" role="alert">
      <div>
        <strong>حساب المهندس لا يدخل لوحة الإدارة.</strong>
        <p>استخدم APK على Android أو موقع المهندس على iPhone لمتابعة عملك.</p>
        <p className="small"><a href="/">الرجوع إلى دخول الإدارة</a></p>
      </div>
    </div>
  );
}

function AlertsPanel({ alerts, staleMinutes, visitStaleMinutes = 0, onPick }: { alerts: ManagerAlert[]; staleMinutes: number; visitStaleMinutes?: number; onPick: (repId?: string) => void }) {
  const [open, setOpen] = useState(true);
  const warn = alerts.filter(a => a.level === 'warn');
  const shown = open ? alerts : alerts.slice(0, 2);
  return (
    <div className="alerts-panel" role="region" aria-label="تنبيهات الميدان">
      <div className="alerts-head">
        <strong>تنبيهات الميدان <span className="pill warn">{formatNumber(warn.length)} مهم</span> <span className="pill">{formatNumber(alerts.length)} إجمالًا</span> <small className="muted">حد انقطاع الإشارة {formatNumber(staleMinutes)} دقيقة{visitStaleMinutes > staleMinutes ? ` · ${formatNumber(visitStaleMinutes)} دقيقة داخل زيارة مفتوحة` : ''}</small></strong>
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

function JustificationsPanel({ reports, clock, onPick }: { reports: IdleReport[]; clock: number; onPick: (repId: string) => void }) {
  const [open, setOpen] = useState(false);
  const shown = open ? reports : reports.slice(0, 3);
  return (
    <div className="alerts-panel" role="region" aria-label="تبريرات الوقوف">
      <div className="alerts-head">
        <strong>تبريرات الوقوف <span className="pill">{formatNumber(reports.length)}</span> <small className="muted">سبب السكون المرسل من الموبايل</small></strong>
        {reports.length > 3 && <button className="btn ghost sm" onClick={() => setOpen(value => !value)}>{open ? 'طي' : 'عرض الكل'}</button>}
      </div>
      <ul>
        {shown.map(item => (
          <li key={item.id} className="alert">
            <span className="alert-dot" aria-hidden="true" />
            <div className="grow">
              <strong>{item.repName}{item.durationMinutes ? ` · توقف ${formatNumber(item.durationMinutes)} دقيقة` : ''}</strong>
              <small>{item.reason} · {ago(item.createdAt, clock)}</small>
            </div>
            <button className="btn ghost sm" onClick={() => onPick(item.userId)}>فتح</button>
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

/** The warning inside the confirm step: real counts, or the honest «مفيش سجلات». */
function impactText(impact: RepImpact): string {
  const rows = [
    impact.visits ? `${formatNumber(impact.visits)} زيارة` : '',
    impact.reports ? `${formatNumber(impact.reports)} تقرير ميدان` : '',
    impact.dailyReports ? `${formatNumber(impact.dailyReports)} تقرير يومي` : '',
    impact.locations ? `${formatNumber(impact.locations)} نقطة موقع` : '',
    impact.shifts ? `${formatNumber(impact.shifts)} وردية` : '',
  ].filter(Boolean);
  return `هيُحذف نهائيًا: ${rows.length ? rows.join(' · ') : 'مفيش سجلات'}.${impact.trackingNow ? ' فيه وردية مفتوحة هتتقفل.' : ''}`;
}

function Team({ reps, onChange, timezone }: { reps: Rep[]; onChange: () => void | Promise<void>; timezone?: string }) {
  const [error, setError] = useState('');
  const [newRep, setNewRep] = useState({ name: '', email: '', password: '', phone: '', region: '' });
  const [createdReps, setCreatedReps] = useState<Rep[]>([]);
  const [creatingRep, setCreatingRep] = useState(false);
  const [createdRepMessage, setCreatedRepMessage] = useState('');
  const teamReps = useMemo(() => {
    const existingIds = new Set(reps.map(rep => rep.id));
    return [...reps, ...createdReps.filter(rep => !existingIds.has(rep.id))];
  }, [reps, createdReps]);
  async function createRep(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setCreatedRepMessage('');
    setCreatingRep(true);
    try {
      const result = await post<{ user: User }>('/api/reps', {
        name: newRep.name.trim(), email: newRep.email.trim(), password: newRep.password,
        phone: newRep.phone.trim(), region: newRep.region.trim(),
      });
      setCreatedReps(current => [{
        ...result.user, online: false, createdAt: Date.now(), tracking: false, shiftStartedAt: null,
        lastSeen: null, location: null, distanceMeters: 0, pointCount: 0, visitsToday: 0, openVisit: null,
      }, ...current.filter(rep => rep.id !== result.user.id)]);
      setNewRep({ name: '', email: '', password: '', phone: '', region: '' });
      await onChange();
      setCreatedRepMessage(`تم إنشاء حساب ${result.user.name} (${result.user.email}). أرسل له كلمة المرور التي اخترتها بأمان.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إنشاء حساب المهندس.'); }
    finally { setCreatingRep(false); }
  }
  // A representative who forgets their password cannot sign in and cannot be emailed: the
  // manager has to hand out a new one. Kept inline instead of a browser prompt so the field is
  // masked and the rule (ten characters) is visible while typing.
  const [passwordFor, setPasswordFor] = useState<{ id: string; name: string } | null>(null);
  const [passwordValue, setPasswordValue] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  async function savePassword() {
    if (!passwordFor) return;
    if (passwordValue.trim().length < 10) { setError('كلمة المرور الجديدة قصيرة — ١٠ أحرف على الأقل.'); return; }
    setSavingPassword(true);
    try {
      await post(`/api/reps/${passwordFor.id}/password`, { password: passwordValue.trim() });
      setError('');
      setPasswordFor(null);
      setPasswordValue('');
      onChange();
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تغيير كلمة المرور.'); }
    finally { setSavingPassword(false); }
  }
  /*
   * Deleting an engineer account is the one destructive thing this page can do, so it states what
   * goes with it. The counts come from the server on the first press (`GET /api/reps/:id/impact`)
   * rather than being guessed from the rows this page happens to hold — «امسح الحساب» and «امسح
   * سجله كله» are different requests, and only one of them is on offer here.
   */
  const [impacts, setImpacts] = useState<Record<string, string>>({});
  async function loadImpact(rep: Rep) {
    try {
      const impact = await api<RepImpact>(`/api/reps/${rep.id}/impact`);
      setImpacts(current => ({ ...current, [rep.id]: impactText(impact) }));
    } catch {
      setImpacts(current => ({ ...current, [rep.id]: 'تعذر حساب السجلات المرتبطة — الحذف يمسح الحساب وكل بياناته.' }));
    }
  }
  async function removeRep(rep: Rep) {
    try {
      await del(`/api/reps/${rep.id}`, { confirm: true });
      setError('');
      setCreatedReps(current => current.filter(row => row.id !== rep.id));
      await onChange();
      setCreatedRepMessage(`تم حذف حساب ${rep.name} وكل سجلاته الميدانية.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر حذف الحساب.'); }
  }
  const deleteButton = (rep: Rep) => (
    <ConfirmAction label="حذف الحساب" confirmLabel="تأكيد الحذف النهائي" busyLabel="جارٍ الحذف…"
      detail={impacts[rep.id] ?? 'جارٍ حساب سجلات الحساب…'} onArm={() => void loadImpact(rep)}
      onConfirm={() => removeRep(rep)} />
  );
  const passwordButton = (rep: Rep) => (
    <button className="btn ghost sm" onClick={() => { setError(''); setPasswordValue(''); setPasswordFor({ id: rep.id, name: rep.name }); }}>كلمة المرور</button>
  );
  const deviceButton = (rep: Rep) => (rep as any).deviceId ? (
    <button className="btn ghost sm" onClick={() => void resetDevice(rep)}>فك ربط الجهاز</button>
  ) : null;
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
  const pending = teamReps.filter(r => (r as any).approvalStatus === 'pending');
  const inWork = teamReps.filter(r => r.tracking || r.online);
  return (
    <section className="page">
      <header className="page-head"><div><h2>الفريق</h2><p className="muted">إدارة الفريق — من في الميدان حالاً وطابور القبول للمنضمين الجدد.</p></div></header>
      {error && <p className="error banner" role="alert">{error}</p>}
      <div className="panel">
        <h3 className="panel-title">إنشاء حساب مهندس</h3>
        <p className="muted small">أنشئ الحساب من هنا، ثم أرسل للمهندس بريده وكلمة المرور التي اخترتها عبر قناة آمنة. كلمة المرور ١٠ أحرف على الأقل.</p>
        <form className="stack" onSubmit={event => void createRep(event)}>
          <div className="two-col">
            <label className="field">
              <span>اسم المهندس</span>
              <input required minLength={2} maxLength={80} autoComplete="name" value={newRep.name}
                onChange={event => setNewRep(current => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="field">
              <span>البريد الإلكتروني</span>
              <input type="email" dir="ltr" required maxLength={254} autoComplete="email" value={newRep.email}
                onChange={event => setNewRep(current => ({ ...current, email: event.target.value }))} />
            </label>
            <label className="field">
              <span>كلمة المرور الأولية</span>
              <input type="password" dir="ltr" required minLength={10} maxLength={200} autoComplete="new-password"
                value={newRep.password} onChange={event => setNewRep(current => ({ ...current, password: event.target.value }))} />
            </label>
            <label className="field">
              <span>الهاتف <span className="muted">(اختياري)</span></span>
              <input type="tel" dir="ltr" maxLength={30} autoComplete="tel" value={newRep.phone}
                onChange={event => setNewRep(current => ({ ...current, phone: event.target.value }))} />
            </label>
            <label className="field">
              <span>المنطقة <span className="muted">(اختياري)</span></span>
              <input maxLength={80} autoComplete="address-level1" value={newRep.region}
                onChange={event => setNewRep(current => ({ ...current, region: event.target.value }))} />
            </label>
          </div>
          <div className="filters">
            <button className="btn primary" type="submit" disabled={creatingRep}>
              {creatingRep ? 'جارٍ إنشاء الحساب…' : 'إنشاء حساب المهندس'}
            </button>
          </div>
        </form>
        {createdRepMessage && <p className="ok-text" role="status">{createdRepMessage}</p>}
      </div>
      <div className="two-col">
        <div className="panel">
          <h3 className="panel-title">قبول المهندسين <span className="pill warn">{formatNumber(pending.length)} بانتظار الموافقة</span></h3>
          <p className="muted small">الحساب الذي تنشئه من النموذج أعلاه يصبح جاهزًا للدخول مباشرة. طلبات الانضمام المعلّقة (إن وُجدت) لا يمكنها الدخول حتى توافق عليها هنا.</p>
          <ul className="rep-list">
            {pending.length === 0 && <li className="empty">لا يوجد طلبات جديدة — كل المهندسين مقبولين.</li>}
            {pending.map(rep => (
              <li key={rep.id} className="team-row" style={{ borderColor: '#f0c27a', background: '#fffaf0' }}>
                <span className="dot" style={{ background: rep.color }} aria-hidden="true" />
                <span className="grow"><strong>{rep.name}</strong><small dir="ltr">{rep.email}</small><small>{(rep as any).oauthProvider ? `دخول عبر ${(rep as any).oauthProvider}` : rep.region || 'بدون منطقة'} · {rep.createdAt ? `انضم ${localDateText(rep.createdAt, timezone)}` : 'تاريخ الانضمام غير مسجّل'}</small>{(rep as any).deviceId ? <small className="mono" dir="ltr">📱 {(rep as any).deviceId.slice(0, 12)}…</small> : <small className="muted small">بدون جهاز بعد</small>}</span>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {deviceButton(rep)}
                  <button className="btn primary sm" onClick={() => approve(rep, 'approved')}>قبول</button>
                  <button className="btn ghost sm" onClick={() => approve(rep, 'rejected')}>رفض</button>
                  {deleteButton(rep)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h3 className="panel-title">الناس اللي في الشغل حالاً ({formatNumber(inWork.length)} / {formatNumber(teamReps.filter(r => r.active).length)})</h3>
          <p className="muted small">يظهر فقط المهندسين اللي فاتحين وردية أو متصلين الآن — مربوط بجهازهم.</p>
          <ul className="rep-list">
            {inWork.length === 0 && <li className="empty">مفيش حد في الشغل دلوقتي — أول ما يفتح وردية هيظهر هنا بعلامة خضراء.</li>}
            {inWork.map(rep => (
              <li key={rep.id} className="team-row">
                <span className="dot" style={{ background: rep.color }} aria-hidden="true" />
                <span className="grow"><strong>{rep.name}</strong><small dir="ltr">{rep.email}</small><small>{rep.tracking ? '● في وردية الآن' : '○ متصل'} · {rep.region || 'بدون منطقة'} · {formatNumber(rep.visitsToday)} زيارة اليوم · {rep.shiftStartedAt ? `بدأ ${timeText(rep.shiftStartedAt, timezone)}` : ''}</small>{(rep as any).deviceId ? <small className="mono" dir="ltr">📱 {(rep as any).deviceId.slice(0, 12)}…</small> : null}</span>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {deviceButton(rep)}
                  {passwordButton(rep)}
                  <button className={rep.active ? 'btn ghost sm' : 'btn primary sm'} onClick={() => toggle(rep)}>{rep.active ? 'إيقاف' : 'تفعيل'}</button>
                  {deleteButton(rep)}
                </span>
              </li>
            ))}
          </ul>
          {teamReps.filter(r => !inWork.includes(r) && (r as any).approvalStatus !== 'pending').length > 0 && (
            <>
              <h4 className="muted small" style={{ marginTop: 12 }}>باقي الفريق (خارج الوردية)</h4>
              <ul className="rep-list muted">
                {teamReps.filter(r => !inWork.includes(r) && (r as any).approvalStatus !== 'pending').map(rep => (
                  <li key={rep.id} className="team-row" style={{ opacity: rep.active ? 0.85 : 0.65 }}>
                    <span className="dot" style={{ background: rep.color }} aria-hidden="true" />
                    <span className="grow"><strong>{rep.name}</strong><small>{rep.region || 'بدون منطقة'}{rep.active ? '' : ' · الحساب متوقف'}</small></span>
                    {deviceButton(rep)}
                    {passwordButton(rep)}
                    <button className={rep.active ? 'btn ghost sm' : 'btn primary sm'} onClick={() => toggle(rep)}>{rep.active ? 'إيقاف' : 'تفعيل'}</button>
                    {deleteButton(rep)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {passwordFor && (
            <div className="panel" style={{ marginTop: 12, borderColor: '#f0c27a', background: '#fffaf0' }}>
              <h4 className="panel-title">كلمة مرور جديدة لـ {passwordFor.name}</h4>
              <p className="muted small">
                اكتبها له بنفسك بأمان — مفيش استرجاع بالبريد. تغييرها يخرج كل أجهزته من الحساب فورًا،
                فالوردية المفتوحة عليه تتقفل.
              </p>
              <div className="filters">
                <label className="field inline">
                  <span>كلمة المرور</span>
                  <input type="password" dir="ltr" autoComplete="new-password" value={passwordValue}
                    placeholder="10 أحرف على الأقل" onChange={event => setPasswordValue(event.target.value)} />
                </label>
                <button className="btn primary sm" onClick={() => void savePassword()} disabled={savingPassword}>
                  {savingPassword ? 'جارٍ الحفظ…' : 'حفظ'}
                </button>
                <button className="btn ghost sm" onClick={() => { setPasswordFor(null); setPasswordValue(''); }}>إلغاء</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function DeleteAccountPanel({ user, onDeleted }: { user: User; onDeleted: () => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !busy && email.trim().toLowerCase() === user.email.toLowerCase();

  async function remove() {
    if (!window.confirm('حذف الحساب نهائيًا؟ سيُحذف حسابك وكل بياناتك (الموقع، الورديات، التقارير) ولا يمكن التراجع.')) return;
    setBusy(true); setError(null);
    try {
      await api('/api/me', { method: 'DELETE', body: JSON.stringify({ confirm: true, email: user.email }) });
      setToken(null);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر حذف الحساب.');
    } finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <h3 className="panel-title">حذف الحساب نهائيًا</h3>
      <p className="muted small">
        حق الحذف متاح من داخل التطبيق نفسه (وللطلبات من المتاجر): يُحذف الحساب مع الموقع والورديات
        والزيارات والتقارير فورًا، وتُلغى كل جلساته. اكتب بريد الحساب للتأكيد.
      </p>
      <div className="filters">
        <label className="field inline">
          <span>تأكيد البريد</span>
          <input dir="ltr" value={email} onChange={event => setEmail(event.target.value)} placeholder={user.email} />
        </label>
        <button className="btn danger sm" disabled={!ready} onClick={() => void remove()}>
          {busy ? 'جارٍ الحذف…' : 'حذف الحساب نهائيًا'}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function ChangePasswordPanel() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const ready = !busy && current.length > 0 && next.length >= 12;

  async function save() {
    setBusy(true); setMessage(null);
    try {
      await api('/api/me/password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      setCurrent(''); setNext('');
      setMessage({ tone: 'ok', text: 'تم تغيير كلمة المرور. كل الأجهزة الأخرى تم تسجيل خروجها.' });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : 'تعذر تغيير كلمة المرور.' });
    } finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <h3 className="panel-title">كلمة المرور</h3>
      <p className="muted small">
        كلمة مرور المدير ١٢ حرفًا على الأقل. بعد التغيير تُلغى جلسات كل الأجهزة الأخرى، وتبقى هذه الجلسة مفتوحة.
      </p>
      <div className="filters">
        <label className="field inline">
          <span>الحالية</span>
          <input type="password" dir="ltr" value={current} onChange={event => setCurrent(event.target.value)} autoComplete="current-password" />
        </label>
        <label className="field inline">
          <span>الجديدة</span>
          <input type="password" dir="ltr" value={next} onChange={event => setNext(event.target.value)} autoComplete="new-password" />
        </label>
        <button className="btn primary sm" disabled={!ready} onClick={() => void save()}>
          {busy ? 'جارٍ الحفظ…' : 'تغيير كلمة المرور'}
        </button>
      </div>
      {message && <p className={message.tone === 'ok' ? 'muted small' : 'error'} role="status">{message.text}</p>}
    </div>
  );
}

function Account({ user, overview, onDeleted }: { user: User; overview: Overview | null; onDeleted: () => void }) {
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
          <p className="muted small">تصدير المؤشرات متاح من صفحة «الأداء والمؤشرات» كملف Excel (.xlsx) يفتح مباشرة بالعربي.</p>
        </div>
        <div className="panel prose">
          <h3 className="panel-title">الخصوصية والاحتفاظ</h3>
          <ul>
            <li>لا يبدأ التتبع إلا بعد موافقة صريحة داخل التطبيق، ويظهر مؤشر دائم أثناء التسجيل.</li>
            <li>
              تُرسل النقاط في دفعات كل ثانية تقريبًا.{' '}
              {overview
                ? <>تُحذف تلقائيًا بعد <b>{formatNumber(overview.retentionDays)}</b> يومًا.</>
                : <span className="muted">مدة الاحتفاظ غير متاحة حاليًا.</span>}
            </li>
            <li>المسافات تقديرية لأغراض المتابعة، ولا تُستخدم كأساس وحيد للرواتب أو البدلات.</li>
            <li>كل عملية حساسة (بدء وردية، إنهاء زيارة، إيقاف حساب، تنزيل تقرير) تُسجل في سجل تدقيق.</li>
          </ul>
          <p className="muted small">المنطقة الزمنية: {overview?.timezone ?? 'Africa/Cairo'} · إصدار الموافقة: 1.0</p>
          <p><a className="btn ghost sm" href="/privacy" target="_blank" rel="noreferrer">سياسة الخصوصية المنشورة (رابط عام)</a></p>
        </div>
      </div>
      <ChangePasswordPanel />
      <DeleteAccountPanel user={user} onDeleted={onDeleted} />
    </section>
  );
}
