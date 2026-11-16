/**
 * A live smoke test against a running server: every promise this product makes, in the order an
 * engineer and a manager meet them.
 *
 * The unit suites (`npm test`) cover each endpoint on a throwaway in-memory database. They cannot
 * see the things that broke in production — the middleware order around a route, the CSP header,
 * the rate limiter, an env var that never reached the process, the dashboard build. This script
 * talks to a real server over HTTP only, exactly like the two apps do, and it is deliberately
 * readable: when a check fails, the name of the check is the bug report.
 *
 *   npm run build
 *   DB_PATH=/tmp/smoke.db PORT=3114 ADMIN_EMAIL=admin@smoke.test ADMIN_PASSWORD='AdminPassword123!' \
 *     NODE_ENV=production node server/dist/index.js &
 *   BASE=http://127.0.0.1:3114 ADMIN_EMAIL=admin@smoke.test ADMIN_PASSWORD='AdminPassword123!' npm run smoke
 *
 * It creates its own engineer (a fresh address each run) and never deletes anything else, so it is
 * safe against a copy of a production database — but read that sentence twice before pointing it
 * at the live one.
 */
const BASE = (process.env.BASE || process.env.SMOKE_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@smoke.test';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AdminPassword123!';
const REP_PASSWORD = 'RepPassword123!';

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok   ${name}`); return; }
  failures.push({ name, detail });
  console.log(`  FAIL ${name}${detail ? ` → ${detail}` : ''}`);
}
const section = title => console.log(`\n${title}`);

function headers(token, client = 'admin') {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Mandoub-Client': client,
    ...(token ? { 'X-Mandoub-Token': token } : {}),
  };
}

async function call(method, path, token, body, client) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(token, client),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML pages and PDFs are not JSON */ }
  return { status: res.status, headers: res.headers, text, body: json };
}
const get = (path, token, client) => call('GET', path, token, undefined, client);
const post = (path, token, body, client) => call('POST', path, token, body, client);
const patch = (path, token, body, client) => call('PATCH', path, token, body, client);
const del = (path, token, body, client) => call('DELETE', path, token, body, client);

const fix = (lat = 31.2, lng = 29.9, accuracy = 8) => ({ lat, lng, accuracy });
/** The login route is limited per address (15 per quarter of an hour) on purpose. A smoke run
 *  spends about eight of them, so a second run from the same address in the same window will be
 *  answered with 429 — say so instead of reporting a password as broken. */
const signIn = (email, password) => post('/api/auth/login', null, { email, password });
const limiterHint = res => (res?.status === 429 ? ' — the login limiter (15 per 15 min per address) is in the way: wait a quarter of an hour or run from another address' : '');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(Date.now());
const runaway = `smoke.${Date.now()}@smoke.test`;

const adminLogin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
const admin = adminLogin.body?.token;
if (!admin) {
  console.error(`cannot sign in as ${ADMIN_EMAIL} (${adminLogin.status}) on ${BASE} — is that account created there?${limiterHint(adminLogin)}`);
  process.exit(1);
}

section('the server stands up');
const health = await get('/api/health');
check('health answers', health.status === 200 && typeof health.body?.ok === 'boolean', JSON.stringify(health.body).slice(0, 80));
check('the idle threshold is a number of minutes', Number.isFinite(health.body?.idleReasonMinutes), String(health.body?.idleReasonMinutes));

section('the public pages the stores require');
const privacy = await get('/privacy', null, 'web');
check('the privacy page opens without a login', privacy.status === 200 && privacy.text.includes('الخصوصية'));
check('it is served with a content security policy', (privacy.headers.get('content-security-policy') || '').includes("default-src 'self'"));
const csp = privacy.headers.get('content-security-policy') || '';
const scriptSrc = (csp.match(/script-src[^;]*/) || [''])[0];
check('no inline script is allowed (a stored XSS cannot run)', scriptSrc !== '' && !scriptSrc.includes('unsafe-inline'), scriptSrc);
const deletion = await get('/delete-account', null, 'web');
check('the account deletion page opens without a login', deletion.status === 200 && deletion.text.includes('حذف'));

section('nobody reads anybody else');
const wrongPassword = await signIn(ADMIN_EMAIL, 'wrong-password-here');
check('a wrong password is refused', wrongPassword.status === 401, `${wrongPassword.status}${limiterHint(wrongPassword)}`);
check('no token means no answer', (await get('/api/kpis')).status === 401);
check('a made-up token is refused', (await get('/api/kpis', 'not-a-real-token')).status === 401);

section('the manager creates an engineer');
const created = await post('/api/reps', admin, { name: 'مهندس الدخان', email: runaway, password: REP_PASSWORD });
check('the account is created', created.status === 201, JSON.stringify(created.body).slice(0, 120));
const repId = String(created.body?.user?.id || '');
check('the same address cannot be used twice', [400, 409].includes((await post('/api/reps', admin, { name: 'مهندس مكرر', email: runaway, password: REP_PASSWORD })).status));
const repLogin = await signIn(runaway, REP_PASSWORD);
const rep = repLogin.body?.token;
check('the engineer can sign in', Boolean(rep), `${repLogin.status}${limiterHint(repLogin)}`);
check('and cannot read the team dashboard', (await get('/api/kpis', rep, 'rep')).status === 403);
check('nor the manager alerts', (await get('/api/alerts', rep, 'rep')).status === 403);
check('nor the agent console', (await get('/api/agent/status', rep, 'rep')).status === 403);
check('nor another engineer trail', (await get(`/api/reps/${repId}/route`, admin, 'admin')).status === 200 && (await get('/api/reps/someone-else/route', rep, 'rep')).status === 403);

section('a shift needs a real GPS fix and an honest consent');
const noGps = await post('/api/shifts/start', rep, { consentVersion: '1.0', deviceId: 'smoke-device-1' }, 'rep');
check('starting a shift without a location is refused', noGps.status === 422, JSON.stringify(noGps.body).slice(0, 90));
const noConsent = await post('/api/shifts/start', rep, { deviceId: 'smoke-device-1', location: fix() }, 'rep');
check('starting a shift without consent is refused', noConsent.status === 400, JSON.stringify(noConsent.body).slice(0, 90));
const started = await post('/api/shifts/start', rep, { consentVersion: '1.0', deviceId: 'smoke-device-1', deviceName: 'هاتف', location: fix() }, 'rep');
check('the shift opens with consent and a fix', started.status === 200, JSON.stringify(started.body).slice(0, 90));
const shiftId = String(started.body?.shift?.id || '');
check('a second device cannot take over the shift', (await post('/api/shifts/start', rep, { consentVersion: '1.0', deviceId: 'other-device-9', deviceName: 'هاتف تاني', location: fix() }, 'rep')).status === 403);

section('position batches are validated');
const recent = Date.now();
const points = Array.from({ length: 3 }, (_, index) => ({ id: crypto.randomUUID(), shiftId, lat: 31.2 + index / 1000, lng: 29.9, accuracy: 8, speed: 3, heading: 90, battery: 70, recordedAt: recent + index * 1000 }));
const pushed = await post('/api/locations', rep, { points }, 'rep');
check('a batch inside the shift is accepted', pushed.status === 200 && pushed.body?.accepted === 3, JSON.stringify(pushed.body).slice(0, 80));
check('the same batch again is counted as duplicates', (await post('/api/locations', rep, { points }, 'rep')).body?.duplicates === 3);
const beforeShift = await post('/api/locations', rep, { points: [{ ...points[0], id: crypto.randomUUID(), recordedAt: recent - 3 * 86400000 }] }, 'rep');
check('a fix from before the shift is refused as a batch', beforeShift.status === 422, JSON.stringify(beforeShift.body).slice(0, 80));
check('and from the future too', (await post('/api/locations', rep, { points: [{ ...points[0], id: crypto.randomUUID(), recordedAt: recent + 3600000 }] }, 'rep')).status === 422);

section('a visit is a check-in, a result and a duration');
const visitId = crypto.randomUUID();
const checkedIn = await post('/api/visits/check-in', rep, { id: visitId, customerName: 'مزرعة الدخان', purpose: 'collection', location: fix(31.2, 29.9, 7) }, 'rep');
check('the check-in is recorded with its GPS proof', checkedIn.status === 201 && checkedIn.body?.visit?.inAccuracy === 7, JSON.stringify(checkedIn.body).slice(0, 120));
check('the two system flags are booleans, not 0/1', checkedIn.body?.visit?.autoClosed === false && checkedIn.body?.visit?.pendingResult === false);
check('a second open visit is refused, and the message names the fix', (await post('/api/visits/check-in', rep, { id: crypto.randomUUID(), customerName: 'زيارة تانية', location: fix() }, 'rep')).status === 409);
check('a visit without a location is refused', (await post('/api/visits/check-in', rep, { id: crypto.randomUUID(), customerName: 'بدون موقع' }, 'rep')).status === 422);
check('a check-out without a result is refused', (await post(`/api/visits/${visitId}/check-out`, rep, { outcome: '', notes: '', amount: null, location: null }, 'rep')).status === 400);
const closed = await post(`/api/visits/${visitId}/check-out`, rep, { outcome: 'اتحصّل ١٥٠٠ ج.م', notes: '', amount: 1500, location: fix() }, 'rep');
check('the check-out closes the visit and keeps the result', closed.status === 200 && closed.body?.visit?.status === 'closed' && closed.body?.visit?.outcome === 'اتحصّل ١٥٠٠ ج.م', JSON.stringify(closed.body).slice(0, 120));
check('the duration is measured, not zero', Number(closed.body?.visit?.durationSeconds) >= 0);
check('sending the same check-out again is a duplicate', (await post(`/api/visits/${visitId}/check-out`, rep, { outcome: 'نتيجة تانية', notes: '', amount: null, location: null }, 'rep')).body?.duplicate === true);
const collections = (await get('/api/reports?type=collection', admin)).body?.reports?.filter(report => report.id === `visit:${visitId}`) || [];
check('a collection reaches the manager feed exactly once', collections.length === 1 && Number(collections[0].amount) === 1500, JSON.stringify(collections.map(item => item.amount)));

section('a visit typed where there is no signal');
const offlineId = crypto.randomUUID();
const offline = await post('/api/visits/check-in', rep, {
  id: offlineId, customerName: 'مزرعة بدون شبكة', purpose: 'visit', location: fix(31.2, 29.9, 9), recordedAt: Date.now(),
}, 'rep');
check('the replayed check-in is accepted', offline.status === 201 && offline.body?.recordedOffline === true, JSON.stringify(offline.body).slice(0, 120));
const offlineClosed = await post(`/api/visits/${offlineId}/check-out`, rep, { outcome: 'اتقفلت من غير شبكة', notes: '', amount: null, location: null, recordedAt: Date.now() }, 'rep');
check('and its check-out too, with a measured duration', offlineClosed.status === 200 && Number(offlineClosed.body?.visit?.durationSeconds) >= 0, JSON.stringify(offlineClosed.body).slice(0, 100));
const staleReplay = await post('/api/visits/check-in', rep, {
  id: crypto.randomUUID(), customerName: 'مزرعة قديمة', location: fix(), recordedAt: Date.now() - 30 * 3600000,
}, 'rep');
check('a replay older than a day is refused', staleReplay.status === 422 && staleReplay.body?.code === 'OFFLINE_VISIT_REJECTED', JSON.stringify(staleReplay.body).slice(0, 100));

section('the shift ends, and no visit is left without a result');
const shifted = await post('/api/visits/check-in', rep, { id: crypto.randomUUID(), customerName: 'مزرعة الإقفال', location: fix() }, 'rep');
check('a new visit opens after the first one is finished', shifted.status === 201, JSON.stringify(shifted.body).slice(0, 90));
const secondVisit = String(shifted.body?.visit?.id);
check('the shift ends', (await post('/api/shifts/stop', rep, {}, 'rep')).status === 200);
const listed = await get('/api/visits', rep, 'rep');
const stranded = (listed.body?.visits || []).find(visit => visit.id === secondVisit);
check('the visit the shift left open is closed', stranded?.status === 'closed', JSON.stringify(stranded).slice(0, 120));
check('and it is flagged as missing its result', stranded?.pendingResult === true);
const late = await post(`/api/visits/${secondVisit}/check-out`, rep, { outcome: 'اتقفلت بعد الوردية', notes: '', amount: 0, location: null }, 'rep');
check('the result can still be typed after the shift', late.status === 200 && late.body?.recordedLate === true, JSON.stringify(late.body).slice(0, 100));
check('and the row stops asking for it', late.body?.visit?.pendingResult === false);
check('replaying the late result cannot rewrite it', (await post(`/api/visits/${secondVisit}/check-out`, rep, { outcome: 'كلام تاني', notes: '', amount: 0, location: null }, 'rep')).body?.duplicate === true);
const reopened = await post('/api/shifts/start', rep, { consentVersion: '1.0', deviceId: 'smoke-device-1', location: fix() }, 'rep');
check('a new shift opens', reopened.status === 200);
check('and a new visit is accepted (the dead end is gone)', (await post('/api/visits/check-in', rep, { id: crypto.randomUUID(), customerName: 'مزرعة تالتة', location: fix() }, 'rep')).status === 201);

section('an idle stop needs a reason');
const idle = await post('/api/shifts/idle', rep, { reason: 'مستني رد العميل على التليفون', location: fix(), deviceId: 'smoke-device-1' }, 'rep');
check('the justification is stored', idle.status === 201 && Boolean(idle.body?.id), JSON.stringify(idle.body).slice(0, 90));
check('the engineer sees his own justifications', ((await get('/api/idle-reports', rep, 'rep')).body?.reports || []).length >= 1);
check('and the manager sees them on the board', ((await get('/api/idle-reports', admin)).body?.reports || []).length >= 1);

section('the daily report is one paper per day');
const dailyVisit = index => ({ customerName: `عميل ${index + 1}`, governorate: 'البحيرة', district: 'إيتاي البارود', village: 'قرية', phone: '01000000000', areaFeddan: 3.5, crops: 'قمح', recommendations: 'رية خفيفة', outcome: 'تم الاتفاق' });
const dailyBody = (extra = {}) => ({
  version: 1, id: crypto.randomUUID(), engineerName: 'مهندس الدخان', reportDate: today,
  leftAt: '08:30', returnedAt: '17:00', circumstances: 'يوم عادي',
  visits: [dailyVisit(0), dailyVisit(1)], signedName: 'مهندس الدخان', confirmed: true, location: fix(), ...extra,
});
const daily = await post('/api/daily-reports', rep, dailyBody(), 'rep');
check('the daily report is accepted', daily.status === 201, JSON.stringify(daily.body).slice(0, 140));
const again = await post('/api/daily-reports', rep, dailyBody(), 'rep');
check('a second one for the same day is refused by name', again.status === 409 && again.body?.code === 'DAILY_REPORT_EXISTS', JSON.stringify(again.body).slice(0, 100));
const tooMany = await post('/api/daily-reports', rep, dailyBody({ visits: Array.from({ length: 31 }, (_, index) => dailyVisit(index)) }), 'rep');
check('thirty-one rows in one day is refused', tooMany.status === 400, String(tooMany.status));
const pdf = await get(`/api/daily-reports/${daily.body?.report?.id}/pdf`, rep, 'rep');
check('the paper form is a real PDF', pdf.status === 200 && pdf.text.startsWith('%PDF'), pdf.text.slice(0, 8));

section('the reports the manager reads');
const teamReports = await get('/api/overview', admin);
check('the board loads', teamReports.status === 200 && Array.isArray(teamReports.body?.reps));
const kpis = await get(`/api/kpis?from=${today}&to=${today}`, admin);
check('the KPIs load', kpis.status === 200);
check('the average visit duration is a number or empty, never NaN', (() => {
  const rows = kpis.body?.rows || kpis.body?.kpis || [];
  return rows.every(row => row.avgVisitSeconds === null || Number.isFinite(Number(row.avgVisitSeconds)));
})(), JSON.stringify(kpis.body).slice(0, 120));
const csv = await get(`/api/kpis.csv?from=${today}&to=${today}`, admin);
check('the CSV export answers with a team table', csv.status === 200 && csv.text.includes('المهندس'), csv.text.slice(0, 20));
const monthly = await get('/api/monthly.xlsx', admin);
check('the monthly Excel file is a real workbook', monthly.status === 200 && monthly.text.startsWith('PK'), monthly.text.slice(0, 4));
const summary = await get('/api/me/summary', rep, 'rep');
check('the engineer summary carries what the phone draws',
  summary.status === 200 && summary.body?.timezone === 'Africa/Cairo'
  && Number.isFinite(Number(summary.body?.distanceMeters)) && Number.isFinite(Number(summary.body?.visitsTotal))
  && 'openVisit' in (summary.body || {}), JSON.stringify(summary.body).slice(0, 120));
check('a month that does not exist is refused', (await get('/api/monthly?month=2026-13', admin)).status === 400);
check('an inverted date range is refused', (await get(`/api/kpis?from=${today}&to=2000-01-01`, admin)).status === 400);
check('two years at once is refused', (await get('/api/kpis?from=2020-01-01&to=2026-01-01', admin)).status === 400);

section('the registers the owner asks for on paper');
const visitsCsv = await get(`/api/visits.csv?from=${today}&to=${today}`, admin);
check('the visits register exports', visitsCsv.status === 200 && visitsCsv.text.includes('مزرعة بدون شبكة'), String(visitsCsv.status));
const visitsXlsx = await get(`/api/visits.xlsx?from=${today}&to=${today}`, admin);
check('and as a workbook', visitsXlsx.status === 200 && visitsXlsx.text.startsWith('PK'), visitsXlsx.text.slice(0, 4));
const idleCsv = await get('/api/idle-reports.csv', admin);
check('the justifications export', idleCsv.status === 200 && idleCsv.text.includes('مستني'), String(idleCsv.status));
check('an engineer cannot export them', (await get('/api/visits.csv', rep, 'rep')).status === 403);
check('a malformed date is refused, not exported as today', (await get('/api/visits.csv?from=nonsense', admin)).status === 400);
const narrowed = await get(`/api/reports?from=${today}&to=${today}`, admin);
check('the reports feed narrows by date', narrowed.status === 200 && Array.isArray(narrowed.body?.reports), String(narrowed.status));

section('the escape hatches are closed');
check('social login says it is unavailable instead of trusting a token', [400, 503].includes((await post('/api/auth/oauth', null, { provider: 'google', idToken: 'x' })).status));
const lastAdmin = await del('/api/me', admin, { confirm: true, email: ADMIN_EMAIL });
check('the last manager cannot delete himself', lastAdmin.status === 409 && lastAdmin.body?.code === 'LAST_ADMIN', JSON.stringify(lastAdmin.body).slice(0, 100));

section('the CSV cannot run a formula');
const formula = await post('/api/reports', rep, { id: crypto.randomUUID(), type: 'note', title: "=cmd|' /C calc'!A0", body: '@SUM(1+1)', customer: '+966', amount: 1, location: fix() }, 'rep');
check('the report is stored', formula.status === 201, JSON.stringify(formula.body).slice(0, 90));
const escaped = await get(`/api/kpis.csv?from=${today}&to=${today}`, admin);
check('no cell starts with a bare formula character', !/^[=+@]/m.test(escaped.text.split('\n').filter(line => line.includes('cmd') || line.includes('SUM')).join('\n')));

section('the live view is live, not a poll');
const waitFor = (register, ms = 4000) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), ms);
  register(value => { clearTimeout(timer); resolve(value); });
});
let adminSocket = null, repSocket = null;
try {
  const { io } = await import('socket.io-client');
  const nextOverview = [];
  adminSocket = io(BASE, { auth: { token: admin }, transports: ['websocket'], reconnection: false });
  adminSocket.on('overview', payload => { for (const handler of nextOverview.splice(0)) handler(payload); });
  const first = await waitFor(handler => nextOverview.push(handler));
  check('a manager socket receives the board on connect', Boolean(first?.reps), 'no overview event');
  const afterIdle = waitFor(handler => nextOverview.push(handler));
  await post('/api/shifts/idle', rep, { reason: 'وقفة قصيرة للتفتيش', location: fix(), deviceId: 'brand-new-phone' }, 'rep');
  check('and an event when an engineer moves', Boolean(await afterIdle), 'no live update after the idle report');

  repSocket = io(BASE, { auth: { token: rep }, transports: ['websocket'], reconnection: false });
  const shiftEvent = await waitFor(handler => repSocket.once('shift', handler));
  check('an engineer socket receives his shift', shiftEvent === null || typeof shiftEvent === 'object');

  const intruder = io(BASE, { auth: { token: 'not-a-real-token' }, transports: ['websocket'], reconnection: false });
  const refused = await waitFor(handler => intruder.once('connect_error', handler));
  check('a socket without a valid session is refused', Boolean(refused), 'it connected');
  intruder.close();
} catch (error) {
  check('the live channel can be exercised', false, error?.message || String(error));
} finally {
  adminSocket?.close();
  repSocket?.close();
}

section('the web surfaces the stores and the manager open');
const root = await get('/', null, 'web');
check('the manager dashboard is served', root.status === 200 && root.text.includes('<div id="root"'), String(root.status));
const asset = (root.text.match(/src="([^"]+\.js)"/) || [])[1];
const assetRes = asset ? await get(asset, null, 'web') : { status: 0, text: '' };
check('its bundle loads from the same origin', assetRes.status === 200 && String(assetRes.text).length > 1000, `${asset} → ${assetRes.status}`);
const rootScriptSrc = ((root.headers.get('content-security-policy') || '').match(/script-src[^;]*/) || [''])[0];
check('the dashboard policy forbids inline script', rootScriptSrc === "script-src 'self'", rootScriptSrc);
const appPage = await get('/app', null, 'web');
check('the engineer web build has its own page', appPage.status === 200);

section('a password change locks the other devices out');
const secondLogin = await signIn(runaway, REP_PASSWORD);
const secondSession = secondLogin.body?.token;
check('a second session signs in', Boolean(secondSession), `${secondLogin.status}${limiterHint(secondLogin)}`);
check('the password is changed', (await post('/api/me/password', rep, { currentPassword: REP_PASSWORD, newPassword: 'RepPassword456!' }, 'rep')).status === 200);
check('the other device is signed out', (await get('/api/auth/me', secondSession, 'rep')).status === 401);
check('the session that changed it stays alive', (await get('/api/auth/me', rep, 'rep')).status === 200);
const oldPassword = await signIn(runaway, REP_PASSWORD);
check('and the old password no longer signs in', oldPassword.status === 401, `${oldPassword.status}${limiterHint(oldPassword)}`);

section('an engineer cannot read another engineer paper');
const otherEmail = `smoke.other.${Date.now()}@smoke.test`;
const other = await post('/api/reps', admin, { name: 'مهندس تاني', email: otherEmail, password: REP_PASSWORD });
check('a second engineer exists', other.status === 201, JSON.stringify(other.body).slice(0, 90));
const otherLogin = await signIn(otherEmail, REP_PASSWORD);
const otherToken = otherLogin.body?.token;
const otherReport = await post('/api/reports', otherToken, { id: crypto.randomUUID(), type: 'note', title: 'تقرير المهندس التاني', body: '', customer: '', amount: null, location: fix() }, 'rep');
check('his report is stored', otherReport.status === 201);
check('it is not readable by the first engineer', (await get(`/api/reports/${otherReport.body?.report?.id}`, rep, 'rep')).status === 403);
check('the manager reads it', (await get(`/api/reports/${otherReport.body?.report?.id}`, admin)).status === 200);

section('a forgotten password is reset by the manager');
const otherId = String(other.body?.user?.id || '');
const reset = await post(`/api/reps/${otherId}/password`, admin, { password: 'RepPassword000!' });
check('the manager sets a new password', reset.status === 200, JSON.stringify(reset.body).slice(0, 90));
const stalePassword = await signIn(otherEmail, REP_PASSWORD);
check('the old one stops working', stalePassword.status === 401, `${stalePassword.status}${limiterHint(stalePassword)}`);
const freshPassword = await signIn(otherEmail, 'RepPassword000!');
check('the new one signs in', freshPassword.status === 200, `${freshPassword.status}${limiterHint(freshPassword)}`);

section('the device binding can be reset by the manager');
check('the engineer is bound to his phone', (await post('/api/shifts/start', rep, { consentVersion: '1.0', deviceId: 'brand-new-phone', location: fix() }, 'rep')).status === 403);
check('the manager resets the binding', (await post(`/api/reps/${repId}/reset-device`, admin, {})).status === 200, '');
check('and the new phone can work', (await post('/api/shifts/start', rep, { consentVersion: '1.0', deviceId: 'brand-new-phone', location: fix() }, 'rep')).status === 200);

section('the monthly register the company files');
check('as a workbook', (await get('/api/monthly.xlsx?month=' + today.slice(0, 7), admin)).status === 200);
check('and as CSV', (await get('/api/monthly.csv?month=' + today.slice(0, 7), admin)).status === 200);

section('junk in, an answer out — never a crash');
/*
 * A validation error is a 4xx with a sentence the app can show. A 5xx is a stack trace, and in a
 * product where the engineer is standing in a field it is the difference between "fix your input"
 * and "call support". These payloads are the shapes a broken or hostile client sends.
 */
const junk = [
  null, [], {}, 0, -1, 1e309, 'x', ' '.repeat(40), true,
  { __proto__: { polluted: 1 } }, { constructor: 'x' },
  { lat: 'north', lng: 'east', accuracy: 'high' }, { points: 'nope' }, { points: [null, 1, 'x'] },
  { outcome: { a: 1 }, notes: [1, 2], amount: 'lots', location: null }, 'x'.repeat(3000),
];
const junkRoutes = [
  ['POST', '/api/locations'], ['POST', '/api/reports'], ['POST', '/api/daily-reports'],
  ['POST', '/api/shifts/idle'], ['POST', '/api/presence'], ['POST', '/api/visits/check-in'],
  ['POST', `/api/visits/${crypto.randomUUID()}/check-out`], ['POST', '/api/reps'], ['POST', '/api/me/password'],
  ['GET', '/api/visits?date=9999-99-99'], ['GET', '/api/me/summary?date=nonsense'],
  ['GET', '/api/kpis?from=x&to=y'], ['GET', '/api/monthly?month=x'], ['GET', '/api/idle-reports?limit=Infinity'],
];
let crashes = 0;
let answered = 0;
for (const [method, path] of junkRoutes) {
  for (const payload of junk) {
    const res = method === 'POST' ? await post(path, rep, payload, 'rep') : await get(path, rep, 'rep');
    answered += 1;
    if (res.status >= 500) { crashes += 1; console.log(`    ${res.status} ${path} <- ${JSON.stringify(payload).slice(0, 60)}`); }
  }
}
check(`no request crashes the server (${answered} hostile requests)`, crashes === 0, `${crashes} answered 5xx`);

section('an account can erase itself');
check('the engineer confirms with his email', (await del('/api/me', rep, { confirm: true, email: runaway }, 'rep')).status === 200);
const afterErase = await signIn(runaway, 'RepPassword456!');
check('then he cannot sign in again', afterErase.status === 401, `${afterErase.status}${limiterHint(afterErase)}`);
check('and his token is dead', (await get('/api/auth/me', rep, 'rep')).status === 401);

console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
  console.log(`\nfailed:`);
  for (const failure of failures) console.log(`  - ${failure.name}${failure.detail ? ` :: ${failure.detail}` : ''}`);
  process.exit(1);
}
