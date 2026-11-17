import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { z } from 'zod';
import { AUTO_CLOSED_OUTCOME, runCleanup, Store } from './db.js';
import { MIN_ADMIN_PASSWORD_LENGTH, readConfig, type Config } from './config.js';
import { clientHint, clientRoleMismatch, createSession, hashPassword, publicUser, requestToken, requireAuth, sessionUser, verifyPassword, tokenHash, setSessionCookie, clearSessionCookies, SESSION_MS } from './auth.js';
import { dayBounds, distanceMeters, haversine, localDate, type GeoPoint } from './geo.js';
import { newDailyReportSchema, dailyReportRow, listDailyReports, insertDailyReport, validateReportDate } from './dailyReports.js';
import { dailyReportPdf } from './dailyPdf.js';
import { deleteAccountPage, privacyPage } from './privacy.js';
import { OauthError, verifyIdToken } from './oauth.js';
import { verifyTotp } from './totp.js';
import { createAgentRouter } from './agent/router.js';
import { buildXlsx, XLSX_CONTENT_TYPE, type CellValue } from './xlsx.js';
import { contentSecurityPolicy } from './csp.js';
import { isPushToken, sendPush } from './push.js';

const CONSENT_VERSION = '1.0';
/** How far a phone's clock may run ahead before every fix in the batch is refused. */
const CLOCK_SKEW_TOLERANCE_MS = 10 * 60000;
/** GPS points looser than this are cell/network guesses, not reliable field positions. */
const MAX_GPS_ACCURACY_M = 120;
/** Drift below this is normal jitter around "now" and is not treated as a wrong clock. */
const CLOCK_SKEW_FLOOR_MS = 60000;
const credentials = z.object({ email: z.email().max(254).transform(x => x.toLowerCase().trim()), password: z.string().min(1).max(200) });
const oauthLogin = z.object({
  provider: z.enum(['google', 'apple']),
  idToken: z.string().min(40).max(8192),
  /** Apple sends the person's name only on the first authorization, so the app forwards it. */
  name: z.string().trim().max(120).optional(),
});
const newRep = z.object({
  name: z.string().trim().min(2).max(80), email: z.email().max(254).transform(x => x.toLowerCase().trim()),
  password: z.string().min(10).max(200), phone: z.string().trim().max(30).default(''), region: z.string().trim().max(80).default(''),
});
/**
 * Each engineer needs their own colour: the live map draws one pin per account, and every
 * account used to inherit the same default, so a team of six looked like a single person.
 */
const REP_COLORS = ['#28745b', '#1f6feb', '#b8611a', '#7a3ea8', '#0f766e', '#b02a37', '#3f6212', '#a16207'];
function nextRepColor(used: string[]): string {
  const taken = used.map(color => color.toLowerCase());
  const counts = REP_COLORS.map(color => taken.filter(value => value === color).length);
  // The least-used colour keeps a larger team distinguishable instead of repeating the first.
  const fewest = Math.min(...counts);
  return REP_COLORS[counts.indexOf(fewest)];
}
const pointSchema = z.object({
  id: z.uuid(), shiftId: z.uuid(), lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().positive().max(MAX_GPS_ACCURACY_M).nullable(), speed: z.number().finite().min(0).max(150).nullable(),
  heading: z.number().finite().min(0).lt(360).nullable(), battery: z.number().finite().min(0).max(100).nullable(),
  recordedAt: z.number().int().nonnegative(),
}).strict();
const batchSchema = z.object({ points: z.array(pointSchema).min(1).max(100) }).strict();
const pushTokenSchema = z.object({
  token: z.string().trim().min(20).max(256).refine(isPushToken, 'Expo push token غير صالح.'),
  platform: z.enum(['ios', 'android']),
  deviceId: z.string().trim().min(3).max(120),
}).strict();
const pushTokenDeleteSchema = z.object({ deviceId: z.string().trim().min(3).max(120) }).strict();
const mockLocationSchema = z.object({
  shiftId: z.uuid(), deviceId: z.string().trim().min(3).max(120),
}).strict();
export const REPORT_TYPES = ['visit', 'order', 'collection', 'note', 'issue', 'other'] as const;
const reportLocation = z.object({
  lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().min(0).max(100000).nullable(),
}).strict();
/** A required, usable GPS fix for operations whose location is mandatory. */
const gpsLocation = reportLocation.extend({
  accuracy: z.number().finite().positive().max(MAX_GPS_ACCURACY_M).nullable(),
});
const newReport = z.object({
  id: z.uuid(), type: z.enum(REPORT_TYPES),
  title: z.string().trim().min(2).max(120), body: z.string().trim().max(4000).default(''),
  customer: z.string().trim().max(120).default(''),
  amount: z.number().finite().min(0).max(1_000_000_000).nullable().default(null),
  location: reportLocation.nullable().default(null),
}).strict();

const startShiftSchema = z.object({
  consentVersion: z.literal(CONSENT_VERSION),
  location: gpsLocation,
  deviceId: z.string().trim().min(3).max(120),
  deviceName: z.string().trim().max(120).optional().default(''),
}).strict();
const newVisit = z.object({
  id: z.uuid(),
  customerName: z.string().trim().min(2, 'اسم العميل / المزرعة مطلوب.').max(120),
  governorate: z.string().trim().max(80).default(''),
  district: z.string().trim().max(80).default(''),
  village: z.string().trim().max(120).default(''),
  phone: z.string().trim().max(30).default(''),
  purpose: z.enum(['visit', 'order', 'collection', 'note', 'issue', 'other']).default('visit'),
  notes: z.string().trim().max(1000).default(''),
  location: gpsLocation,
  deviceId: z.string().trim().min(3).max(120).optional(),
  deviceName: z.string().trim().max(120).optional(),
  /**
   * The moment the engineer actually checked in, sent only by the offline queue (a live request
   * has no reason to name a time the server already knows).
   */
  recordedAt: z.number().int().nonnegative().optional(),
}).strict();
const closeVisit = z.object({
  /**
   * The check-out sheet marks this field required, but the server accepted an empty one: a
   * visit could close with no result in the manager's timeline. The rule now lives here too,
   * so an older build (or a direct API call) cannot produce a result-less visit.
   */
  outcome: z.string().trim().min(2, 'اكتب نتيجة الزيارة قبل الإنهاء.').max(1000),
  notes: z.string().trim().max(1000).default(''),
  amount: z.number().finite().min(0).max(1_000_000_000).nullable().default(null),
  location: reportLocation.nullable().default(null),
  /** Same as a check-in: the instant the phone closed the visit, when it had no signal. */
  recordedAt: z.number().int().nonnegative().optional(),
}).strict();

/** How far back a visit typed with no signal may still be accepted. */
const OFFLINE_WINDOW_MS = 24 * 3600000;

export function createApp(overrides: Partial<Config> = {}) {
  const config = { ...readConfig(), ...overrides };
  const store = new Store(config.dbPath);
  const app = express();
  const httpServer = createServer(app);
  const originCheck = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    callback(null, !origin || config.allowedOrigins.includes(origin));
  };
  const io = new Server(httpServer, { cors: { origin: originCheck }, maxHttpBufferSize: 128 * 1024, serveClient: false });
  app.disable('x-powered-by');
  // Behind Caddy every request arrives from 127.0.0.1. Without this the rate limiters would
  // share one bucket for the whole team (`TRUST_PROXY=loopback` by default, see config.ts).
  app.set('trust proxy', config.trustProxy);
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    // The engineer app is served from the same origin; production keeps SAMEORIGIN framing.
    frameguard: config.production ? { action: 'sameorigin' } : false,
    crossOriginResourcePolicy: config.production ? { policy: 'same-origin' } : false,
  }));
  /*
   * The policy is set here, before any route, not in index.ts: the server-rendered pages
   * (`/privacy`, `/delete-account`) end the response inside their own handler, so a middleware
   * registered after the routes — which is where it used to live — never ran for them and the
   * two pages the stores link to were served with no policy at all.
   */
  app.use((req, res, next) => {
    if (config.production && !req.path.startsWith('/api') && !req.path.startsWith('/socket.io')) {
      // The request's own host is what Socket.IO upgrades to, so the policy names it instead of
      // allowing a websocket to any host at all.
      res.setHeader('Content-Security-Policy', contentSecurityPolicy(req.headers.host));
    }
    next();
  });
  app.use(cors({ origin: originCheck }));
  app.use(express.json({ limit: '128kb' }));
  // Anonymous calls are counted per address; signed-in ones per session token. Keying only by
  // address made twenty engineers behind one office NAT share a single budget, so the whole
  // team started seeing 429s at random during the day.
  const identityKey = (req: express.Request) => {
    const token = requestToken(req);
    // Only a token that belongs to a live session counts: otherwise a client could mint a
    // random header on every call and land in a fresh bucket, which is no limit at all.
    const user = token ? sessionUser(store, token) : undefined;
    if (user) return `user:${user.id}`;
    return `ip:${ipKeyGenerator(req.ip ?? '')}`;
  };
  const apiLimiter = rateLimit({ ...config.apiRateLimit, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: identityKey, message: { error: 'طلبات كثيرة جدًا. حاول بعد دقيقة.' } });
  // High-frequency GPS has its own authenticated per-representative budget, so one busy
  // office IP does not throttle the whole team's one-second updates.
  app.use('/api', (req, res, next) => req.path === '/locations' ? next() : apiLimiter(req, res, next));
  if (!store.get("SELECT id FROM users WHERE role='admin'")) {
    if (!config.adminPassword) throw new Error('ADMIN_PASSWORD is required to initialize the first administrator.');
    store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)', randomUUID(), 'متابعة الهلب', config.adminEmail, hashPassword(config.adminPassword), 'admin', Date.now());
  }
  const auth = requireAuth(store);
  const adminOnly = requireAuth(store, 'admin');
  const repOnly = requireAuth(store, 'rep');
  const locationLimiter = rateLimit({ windowMs: 60000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: (_req, res) => String(res.locals.user.id), message: { error: 'تحديثات موقع كثيرة جدًا. حاول بعد دقيقة.' } });
  const mockLocationLimiter = rateLimit({ windowMs: 60 * 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: (_req, res) => String(res.locals.user.id), message: { error: 'تم تسجيل بلاغات كثيرة عن الموقع الوهمي. حاول بعد ساعة.' } });
  const pushRegistrationLimiter = rateLimit({ windowMs: 60 * 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: (_req, res) => String(res.locals.user.id), message: { error: 'طلبات تسجيل الإشعارات كثيرة. حاول بعد ساعة.' } });
  function notifyUser(userId: string, title: string, body: string, data: Record<string, unknown>) {
    const tokens = store.all('SELECT token FROM push_tokens WHERE user_id=?', userId) as Array<{ token: string }>;
    if (!tokens.length) return;
    void sendPush(tokens.map(row => ({ to: String(row.token), title, body, data }))).then(result => {
      try {
        for (const token of result.invalid) store.run('DELETE FROM push_tokens WHERE token=?', token);
        if (result.failed) console.warn(`[push] ${result.failed} notification(s) were not accepted; token records remain registered for future events.`);
      } catch (error) { console.error('[push] could not update push-token state:', error); }
    }).catch(error => console.error('[push] send failed without affecting the saved operation:', error));
  }
  app.get('/api/push/status', repOnly, (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ enabled: !!store.get('SELECT 1 FROM push_tokens WHERE user_id=? LIMIT 1', res.locals.user.id) });
  });
  app.post('/api/push/token', repOnly, pushRegistrationLimiter, (req, res) => {
    const parsed = pushTokenSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'رمز الإشعارات أو بيانات الجهاز غير صالحة.' }); return; }
    const user = res.locals.user;
    const boundDevice = String(user.device_id || '').trim();
    if (!boundDevice) {
      res.status(409).json({ error: 'ابدأ وردية من هذا الهاتف مرة واحدة قبل تفعيل إشعارات المراجعة.', code: 'DEVICE_NOT_BOUND' }); return;
    }
    if (parsed.data.deviceId !== boundDevice) {
      res.status(403).json({ error: 'رمز الإشعارات صادر من هاتف غير مرتبط بالحساب.', code: 'DEVICE_MISMATCH' }); return;
    }
    const owner = store.get('SELECT user_id, device_id FROM push_tokens WHERE token=?', parsed.data.token) as { user_id: string; device_id: string } | undefined;
    if (owner && (owner.user_id !== user.id || owner.device_id !== parsed.data.deviceId)) {
      res.status(409).json({ error: 'رمز الإشعارات مرتبط بحساب أو جهاز آخر.', code: 'PUSH_TOKEN_IN_USE' }); return;
    }
    const now = Date.now();
    store.run(`INSERT INTO push_tokens(token,user_id,platform,device_id,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id,device_id) DO UPDATE SET token=excluded.token, platform=excluded.platform, updated_at=excluded.updated_at`,
    parsed.data.token, user.id, parsed.data.platform, parsed.data.deviceId, now, now);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true });
  });
  app.delete('/api/push/token', repOnly, (req, res) => {
    const parsed = pushTokenDeleteSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'معرّف الجهاز غير صالح.' }); return; }
    store.run('DELETE FROM push_tokens WHERE user_id=? AND device_id=?', res.locals.user.id, parsed.data.deviceId);
    res.json({ ok: true });
  });
  app.post('/api/security/mock-location', repOnly, mockLocationLimiter, (req, res) => {
    const parsed = mockLocationSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'بيانات رصد الموقع غير صالحة.' }); return; }
    const user = res.locals.user;
    const shift = store.get('SELECT id, device_id FROM shifts WHERE id=? AND user_id=? AND ended_at IS NULL', parsed.data.shiftId, user.id) as { id: string; device_id: string } | undefined;
    if (!shift) { res.status(409).json({ error: 'الوردية غير مفتوحة لهذا الحساب.', code: 'SHIFT_NOT_OPEN' }); return; }
    const boundDevice = String(shift.device_id || user.device_id || '').trim();
    if (!boundDevice) { res.status(409).json({ error: 'الوردية غير مرتبطة بجهاز موثّق.', code: 'DEVICE_NOT_BOUND' }); return; }
    if (parsed.data.deviceId !== boundDevice) {
      res.status(403).json({ error: 'بلاغ الموقع صادر من هاتف غير مرتبط بالوردية.', code: 'DEVICE_MISMATCH' }); return;
    }
    const result = store.run('INSERT OR IGNORE INTO mock_location_events(id,user_id,shift_id,device_id,created_at) VALUES (?,?,?,?,?)',
      randomUUID(), user.id, shift.id, parsed.data.deviceId, Date.now());
    if (result.changes) {
      store.audit(user.id, 'location.mock_detected', { shiftId: shift.id });
      invalidateKpis(); broadcast();
    }
    res.status(result.changes ? 201 : 200).json({ ok: true, duplicate: !result.changes });
  });
  const dayStatsCache = new Map<string, { day: string; computedAt: number; distanceMeters: number; pointCount: number }>();
  // A month for the whole team is hundreds of thousands of fixes. The page, the CSV and the
  // workbook ask for the same rows seconds apart, so the result is reused — and any change the
  // manager could be looking for (a visit, a report, an account) clears it immediately.
  const KPI_CACHE_MS = 30000;
  const kpiCache = new Map<string, { at: number; rows: ReturnType<typeof kpiRows> }>();
  function invalidateKpis() { kpiCache.clear(); }
  // A leaked password list is replayed from many addresses, so the per-IP limiter alone is not
  // enough: too many failures on one account also freeze that account for a quarter of an hour.
  const LOGIN_FAILURE_LIMIT = config.loginAccountLimit;
  const LOGIN_FAILURE_WINDOW = config.loginRateLimit.windowMs;
  const loginFailures = new Map<string, { count: number; resetAt: number }>();
  function loginIsFrozen(email: string): boolean {
    const record = loginFailures.get(email);
    return !!record && record.resetAt > Date.now() && record.count >= LOGIN_FAILURE_LIMIT;
  }
  function noteLoginFailure(email: string) {
    const now = Date.now();
    const record = loginFailures.get(email);
    const next = record && record.resetAt > now
      ? { count: record.count + 1, resetAt: record.resetAt }
      : { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW };
    loginFailures.set(email, next);
    if (loginFailures.size > 2000) {
      for (const [key, value] of loginFailures) if (value.resetAt <= now) loginFailures.delete(key);
      // Guessing at thousands of different addresses leaves nothing to expire, so the map used
      // to grow without limit and every later failure paid for a full scan. Dropping the oldest
      // entries keeps the cost flat; the limit that matters (per account) still applies.
      if (loginFailures.size > 4000) {
        let excess = loginFailures.size - 3000;
        for (const key of loginFailures.keys()) { if (excess <= 0) break; loginFailures.delete(key); excess -= 1; }
      }
    }
  }

  function endShift(userId: string) {
    const shift = store.get('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', userId);
    if (shift) {
      const now = Date.now();
      store.run('UPDATE shifts SET ended_at=? WHERE id=?', now, shift.id);
      // The visit still running belongs to this shift. Leaving it open made the next check-in
      // fail with "لديك زيارة مفتوحة" — on a phone that only shows it in another tab — and kept
      // a stopwatch alive on both screens for the rest of the day.
      store.run(`UPDATE visits SET status='closed', auto_closed=1, checked_out_at=?,
          duration_seconds = MAX(0, (? - checked_in_at) / 1000),
          outcome = CASE WHEN TRIM(COALESCE(outcome,''))='' THEN ? ELSE outcome END
        WHERE user_id=? AND status='open'`, now, now, AUTO_CLOSED_OUTCOME, userId);
      store.audit(userId, 'shift.stop');
    }
  }
  function repSnapshot(user: Record<string, any>) {
    const location = store.get('SELECT *, received_at AS receivedAt FROM locations WHERE user_id=? ORDER BY recorded_at DESC, received_at DESC LIMIT 1', user.id);
    const shift = store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', user.id);
    const bounds = dayBounds(localDate(config.timezone), config.timezone);
    const day = localDate(config.timezone);
    let stats = dayStatsCache.get(user.id);
    if (!stats || stats.day !== day || Date.now() - stats.computedAt > 15000) {
      const points = store.all('SELECT lat,lng,accuracy,speed,recorded_at AS recordedAt FROM locations WHERE user_id=? AND recorded_at>=? AND recorded_at<? ORDER BY recorded_at, received_at', user.id, bounds.start, bounds.end) as unknown as GeoPoint[];
      stats = { day, computedAt: Date.now(), distanceMeters: Math.round(distanceMeters(points)), pointCount: points.length };
      // One entry per engineer; the map is cleared hourly, and a hard cap keeps a long-lived
      // process from growing it without bound if accounts are created and removed often.
      if (dayStatsCache.size > 500) dayStatsCache.clear();
      dayStatsCache.set(user.id, stats);
    }
    const online = io.sockets.adapter.rooms.get(`user:${user.id}`)?.size ? true : !!user.last_seen && Date.now() - user.last_seen < 75000;
    const visitStats = store.get(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open FROM visits WHERE user_id=? AND checked_in_at>=? AND checked_in_at<?`, user.id, bounds.start, bounds.end);
    const openVisit = store.get("SELECT id, customer_name AS customerName, checked_in_at AS checkedInAt FROM visits WHERE user_id=? AND status='open' ORDER BY checked_in_at DESC LIMIT 1", user.id);
    return {
      ...publicUser(user), lastSeen: user.last_seen || null, online, tracking: !!shift,
      // The team page shows when the engineer joined; without it the page printed "today".
      createdAt: user.created_at || null,
      shiftStartedAt: shift?.started_at || null,
      location: location ? { lat: location.lat, lng: location.lng, accuracy: location.accuracy, speed: location.speed, heading: location.heading, battery: location.battery, recordedAt: location.recorded_at, receivedAt: location.receivedAt, source: location.source } : null,
      distanceMeters: stats.distanceMeters, pointCount: stats.pointCount,
      visitsToday: Number(visitStats?.total || 0), openVisit: openVisit || null,
    };
  }
  function overview() {
    const reps = store.all("SELECT * FROM users WHERE role='rep' ORDER BY created_at, name").map(repSnapshot);
    const newReports = ((store.get("SELECT COUNT(*) AS c FROM reports WHERE status='new'")?.c as number) || 0)
      + ((store.get("SELECT COUNT(*) AS c FROM daily_reports WHERE status='new'")?.c as number) || 0);
    // The dashboard needs the same staleness threshold the alerts use, otherwise the map and
    // the alert list disagree about who lost their signal.
    return { reps, serverTime: Date.now(), timezone: config.timezone, retentionDays: config.retentionDays, newReports, staleGpsMinutes: config.staleGpsMinutes };
  }
  function reportRow(id: string) {
    return store.get(`SELECT r.id, r.user_id AS userId, r.shift_id AS shiftId, r.type, r.title, r.body, r.customer, r.amount,
      r.lat, r.lng, r.accuracy, r.status, r.created_at AS createdAt, r.reviewed_at AS reviewedAt,
      u.name AS repName, u.color AS repColor
      FROM reports r JOIN users u ON u.id=r.user_id WHERE r.id=?`, id);
  }
  const ROUTE_MAX_POINTS = 600;
  /** Evenly spaced sample that always keeps the first and last fix, so the trail still ends on the phone. */
  function thinPolyline<T>(points: T[], max: number): T[] {
    if (points.length <= max) return points;
    const step = (points.length - 1) / (max - 1);
    return Array.from({ length: max }, (_, index) => points[Math.round(index * step)]);
  }
  // A visit the system closed still shows the automatic text until the engineer writes the real
  // result. That comparison is the only thing standing between him and a lost record.
  const PENDING_RESULT_SQL = `(v.auto_closed=1 AND v.outcome='${AUTO_CLOSED_OUTCOME.replace(/'/g, "''")}')`;
  const VISIT_SELECT = `SELECT v.id, v.user_id AS userId, v.customer_name AS customerName, v.governorate, v.district,
    v.village, v.phone, v.purpose, v.notes, v.outcome, v.status, v.checked_in_at AS checkedInAt,
    v.checked_out_at AS checkedOutAt, v.duration_seconds AS durationSeconds,
    v.auto_closed AS autoClosed, v.recorded_offline AS recordedOffline, ${PENDING_RESULT_SQL} AS pendingResult,
    v.in_lat AS inLat, v.in_lng AS inLng, v.in_accuracy AS inAccuracy,
    v.out_lat AS outLat, v.out_lng AS outLng,
    u.name AS repName, u.color AS repColor
    FROM visits v JOIN users u ON u.id = v.user_id`;
  // SQLite has no boolean: the two flags come back as 0/1. They are booleans on the wire so a
  // client can compare with `=== true` instead of guessing (`mobile/src/VisitSheets.tsx` did,
  // and a closed visit was labelled as if it were still running).
  const asVisit = <T extends Record<string, any> | undefined>(row: T): T =>
    (row ? {
      ...row,
      autoClosed: Boolean(row.autoClosed),
      pendingResult: Boolean(row.pendingResult),
      recordedOffline: Boolean(row.recordedOffline),
    } : row) as T;
  function visitRow(id: string) { return asVisit(store.get(`${VISIT_SELECT} WHERE v.id=?`, id)); }
  function listVisits(filter: { userId?: string; repId?: string; date?: string; status?: string }) {
    const where: string[] = []; const params: any[] = [];
    if (filter.userId) { where.push('v.user_id=?'); params.push(filter.userId); }
    if (filter.repId) { where.push('v.user_id=?'); params.push(filter.repId); }
    if (filter.status) { where.push('v.status=?'); params.push(filter.status); }
    if (filter.date) {
      const bounds = dayBounds(filter.date, config.timezone);
      where.push('v.checked_in_at>=? AND v.checked_in_at<?'); params.push(bounds.start, bounds.end);
    }
    return store.all(`${VISIT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY v.checked_in_at DESC LIMIT 300`, ...params).map(asVisit);
  }
  function dayDistance(userId: string, start: number, end: number) {
    const points = store.all('SELECT lat,lng,accuracy,speed,recorded_at AS recordedAt FROM locations WHERE user_id=? AND recorded_at>=? AND recorded_at<? ORDER BY recorded_at, received_at', userId, start, end) as unknown as GeoPoint[];
    const lastPoint = points[points.length - 1];
    return { meters: Math.round(distanceMeters(points)), points: points.length, first: points[0]?.recordedAt ?? null, last: lastPoint?.recordedAt ?? null, lastAccuracy: lastPoint?.accuracy ?? null };
  }
  /**
   * Distance over a range, walked one day at a time: loading a month of fixes for one engineer
   * at once is millions of rows on a busy installation, while a single shift fits easily.
   */
  // A completed local calendar day is reused by monthly registers. Late offline fixes and
  // retention cleanup explicitly invalidate it; otherwise one replay could leave stale distance
  // in memory for the rest of the process lifetime.
  const DAY_MS = 86400000;
  const dayDistanceCache = new Map<string, { meters: number; points: number }>();
  function invalidateDistanceDay(userId: string, recordedAt: number) {
    const date = localDate(config.timezone, recordedAt);
    const bounds = dayBounds(date, config.timezone);
    dayDistanceCache.delete(`${userId}|${bounds.start}|${bounds.end}`);
  }
  function invalidateDistanceForUser(userId: string) {
    const prefix = `${userId}|`;
    for (const key of dayDistanceCache.keys()) if (key.startsWith(prefix)) dayDistanceCache.delete(key);
  }
  function rangeDistance(userId: string, start: number, end: number) {
    let meters = 0;
    let points = 0;
    const oldestCacheable = Date.now() - config.retentionDays * DAY_MS;
    for (let cursor = start; cursor < end;) {
      // `dayBounds` follows local midnights (including 23/25-hour DST days). Adding 24 hours
      // here shifted all later cut points for a month around a clock change.
      const next = Math.min(end, dayBounds(localDate(config.timezone, cursor), config.timezone).end);
      const key = `${userId}|${cursor}|${next}`;
      const cacheable = next < Date.now() - 5 * 60000 && cursor >= oldestCacheable;
      const hit = cacheable ? dayDistanceCache.get(key) : undefined;
      if (hit) {
        meters += hit.meters;
        points += hit.points;
      } else {
        const day = dayDistance(userId, cursor, next);
        meters += day.meters;
        points += day.points;
        if (cacheable) {
          if (dayDistanceCache.size > 8000) dayDistanceCache.clear();
          dayDistanceCache.set(key, { meters: day.meters, points: day.points });
        }
      }
      cursor = next;
    }
    return { meters: Math.round(meters), points };
  }
  function listReports(filter: { userId?: string; type?: string; status?: string; repId?: string; from?: string; to?: string }) {
    const where: string[] = []; const params: any[] = [];
    if (filter.userId) { where.push('r.user_id=?'); params.push(filter.userId); }
    if (filter.repId) { where.push('r.user_id=?'); params.push(filter.repId); }
    if (filter.type) { where.push('r.type=?'); params.push(filter.type); }
    if (filter.status) { where.push('r.status=?'); params.push(filter.status); }
    // The feed is capped at 300 rows; a range is the only way to see an older page of it.
    if (filter.from) { where.push('r.created_at>=?'); params.push(dayBounds(filter.from, config.timezone).start); }
    if (filter.to) { where.push('r.created_at<?'); params.push(dayBounds(filter.to, config.timezone).end); }
    const sql = `SELECT r.id, r.user_id AS userId, r.shift_id AS shiftId, r.type, r.title, r.body, r.customer, r.amount,
      r.lat, r.lng, r.accuracy, r.status, r.created_at AS createdAt, r.reviewed_at AS reviewedAt,
      u.name AS repName, u.color AS repColor
      FROM reports r JOIN users u ON u.id=r.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      -- Unreviewed first: the feed is capped, and a backlog of more than 300 reports used to hide
      -- the oldest ones forever, so the manager could never clear it.
      ORDER BY (r.status='new') DESC, r.created_at DESC LIMIT 300`;
    return store.all(sql, ...params);
  }
  let broadcastTimer: NodeJS.Timeout | undefined;
  let closing = false;
  function broadcast() {
    if (closing || broadcastTimer) return;
    broadcastTimer = setTimeout(() => { broadcastTimer = undefined; io.to('admins').emit('overview', overview()); }, 150);
  }

  io.use((socket, next) => {
    const user = sessionUser(store, socket.handshake.auth.token);
    if (!user) return next(new Error('Unauthorized'));
    socket.data.user = user;
    const session = store.get('SELECT expires_at FROM sessions WHERE token_hash=?', tokenHash(socket.handshake.auth.token));
    socket.data.expiresAt = session?.expires_at || Date.now();
    next();
  });
  io.on('connection', socket => {
    const user = socket.data.user;
    /*
     * A live socket outlives its own expiry when the session keeps sliding (the engineer's app
     * polls every fifteen seconds), so the timer re-reads the row instead of dropping a working
     * connection at the twelve-hour mark.
     */
    let expiryTimer: NodeJS.Timeout;
    const scheduleExpiry = () => {
      const delay = Math.max(1000, socket.data.expiresAt - Date.now());
      expiryTimer = setTimeout(() => {
        const session = store.get('SELECT expires_at FROM sessions WHERE token_hash=?', tokenHash(socket.handshake.auth.token));
        if (!session || Number(session.expires_at) <= Date.now()) { socket.disconnect(true); return; }
        socket.data.expiresAt = Number(session.expires_at);
        scheduleExpiry();
      }, delay);
      expiryTimer.unref();
    };
    scheduleExpiry();
    socket.once('disconnect', () => clearTimeout(expiryTimer));
    socket.join(`user:${user.id}`);
    if (user.role === 'admin') { socket.join('admins'); socket.emit('overview', overview()); }
    else socket.emit('shift', store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', user.id) || null);
    invalidateKpis(); broadcast();
    socket.on('disconnect', broadcast);
  });

  app.get('/api/health', (_req, res) => { res.json({ ok: true, timezone: config.timezone, retentionDays: config.retentionDays, consentVersion: CONSENT_VERSION, staleGpsMinutes: config.staleGpsMinutes, idleReasonMinutes: config.idleReasonMinutes }); });
  app.post('/api/auth/login', rateLimit({ ...config.loginRateLimit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'محاولات دخول كثيرة. انتظر ربع ساعة.' } }), (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'أدخل بريدًا إلكترونيًا صحيحًا وكلمة مرور.' }); return; }
    if (loginIsFrozen(parsed.data.email)) {
      res.status(429).json({ error: 'محاولات دخول كثيرة على هذا الحساب. انتظر ١٥ دقيقة أو اطلب من مدير المتابعة تغيير كلمة المرور.', code: 'ACCOUNT_THROTTLED' }); return;
    }
    const user = store.get('SELECT * FROM users WHERE email=? AND active=1', parsed.data.email);
    // Run scrypt even for unknown accounts to reduce account-enumeration timing differences.
    const dummy = '00000000000000000000000000000000:' + '00'.repeat(64);
    const valid = verifyPassword(parsed.data.password, user?.password_hash || dummy);
    if (!user || !valid) {
      noteLoginFailure(parsed.data.email);
      res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' }); return;
    }
    const client = clientHint(req);
    if (client && user.role !== client) { res.status(403).json(clientRoleMismatch(client)); return; }
    /*
     * A second factor for the manager account, asked for after the password so a wrong password
     * never reveals whether two-factor is on. Reps are unaffected: a phone is already bound to one
     * device, and a field engineer typing a code before every shift was not worth it. Social
     * sign-in for a manager keeps the provider's own second factor, which is why this lives on the
     * password route only.
     */
    if (user.role === 'admin' && config.adminTotpSecret) {
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      if (!code.trim()) { res.status(401).json({ error: 'أدخل رمز المصادقة الثنائية من تطبيق المصادقة.', code: 'TOTP_REQUIRED' }); return; }
      if (!verifyTotp(config.adminTotpSecret, code)) {
        noteLoginFailure(parsed.data.email);
        res.status(401).json({ error: 'رمز المصادقة غير صحيح أو انتهت صلاحيته — جرّب الرمز الحالي.', code: 'TOTP_INVALID' });
        return;
      }
    }
    if (user.approval_status === 'pending') { res.status(403).json({ error: 'حسابك بانتظار موافقة المدير — سيتم تفعيله قريبًا.', code: 'PENDING_APPROVAL' }); return; }
    if (user.approval_status === 'rejected') { res.status(403).json({ error: 'تم رفض حسابك — تواصل مع الإدارة.', code: 'REJECTED' }); return; }
    loginFailures.delete(parsed.data.email);
    const session = createSession(store, user.id);
    setSessionCookie(req, res, user.role as 'admin' | 'rep', session.token, SESSION_MS);
    store.audit(user.id, 'auth.login');
    res.json({ ...session, user: publicUser(user) });
  });

  /* ── Sign in with Google / Apple ────────────────────────────────────────────────
     The phone signs in with the provider's own SDK and posts the resulting ID token; the
     server verifies the signature and the claims, then issues the same session a password
     login would. Accounts are never created here: an unknown address gets a clear "ask your
     manager", because the app is an internal tool and a Google account is not a licence. */
  app.post('/api/auth/oauth', rateLimit({ ...config.loginRateLimit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'محاولات دخول كثيرة. انتظر ربع ساعة.' } }), async (req, res) => {
    const parsed = oauthLogin.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'طلب تسجيل دخول غير صالح.' }); return; }
    const { provider, idToken, name } = parsed.data;
    const audiences = (provider === 'google' ? config.oauthGoogleClientIds : config.oauthAppleClientIds) ?? [];
    if (!audiences.length) { res.status(400).json({ error: 'تسجيل الدخول بـ' + (provider === 'google' ? 'Google' : 'Apple') + ' غير مفعّل على السيرفر.', code: 'OAUTH_DISABLED' }); return; }

    let identity;
    try {
      identity = await verifyIdToken(provider, idToken, { audiences });
    } catch (error) {
      if (error instanceof OauthError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      throw error;
    }

    // Linked account first: Apple only returns the email on the very first authorization.
    const user = store.get('SELECT * FROM users WHERE oauth_provider=? AND oauth_subject=?', provider, identity.subject)
      || (identity.email ? store.get('SELECT * FROM users WHERE email=?', identity.email) : undefined);
    if (!user) {
      res.status(403).json({ error: 'مفيش حساب في الهلب جروب بالبريد ده. اطلب من مدير المتابعة يضيفك الأول.', code: 'ACCOUNT_NOT_FOUND' });
      return;
    }
    const client = clientHint(req);
    if (client && user.role !== client) { res.status(403).json(clientRoleMismatch(client)); return; }
    if (!user.active) { res.status(403).json({ error: 'الحساب متوقف — تواصل مع الإدارة.', code: 'ACCOUNT_DISABLED' }); return; }
    if (user.approval_status === 'pending') { res.status(403).json({ error: 'حسابك بانتظار موافقة المدير — سيتم تفعيله قريبًا.', code: 'PENDING_APPROVAL' }); return; }
    if (user.approval_status === 'rejected') { res.status(403).json({ error: 'تم رفض حسابك — تواصل مع الإدارة.', code: 'REJECTED' }); return; }
    if (user.oauth_subject && (user.oauth_provider !== provider || user.oauth_subject !== identity.subject)) {
      // The address is already tied to another Google/Apple account: refuse instead of
      // silently moving the link to whoever controls a matching address today.
      res.status(409).json({ error: 'الحساب ده مربوط بحساب ' + (String(user.oauth_provider) === 'apple' ? 'Apple' : 'Google') + ' تاني. كلّم مدير المتابعة يفكّ الربط.', code: 'ACCOUNT_LINKED' });
      return;
    }
    if (!user.oauth_subject) {
      store.run('UPDATE users SET oauth_provider=?, oauth_subject=? WHERE id=?', provider, identity.subject, user.id);
      if (name && !user.name) store.run('UPDATE users SET name=? WHERE id=?', name, user.id);
    }

    const session = createSession(store, user.id);
    setSessionCookie(req, res, user.role as 'admin' | 'rep', session.token, SESSION_MS);
    store.audit(user.id, `auth.login.${provider}`);
    res.json({ ...session, user: publicUser(store.get('SELECT * FROM users WHERE id=?', user.id)!) });
  });

  /* Which social buttons the app is allowed to show — the server is the only one that knows
     whether it can verify those tokens, so the app asks instead of guessing from a build flag. */
  app.get('/api/auth/providers', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      google: ((config.oauthGoogleClientIds ?? []) as string[]).length > 0,
      apple: ((config.oauthAppleClientIds ?? []) as string[]).length > 0,
    });
  });
  // Do not accept social tokens until their signature, issuer and audience are verified.
  // Decoding a JWT alone lets anyone impersonate an existing account.
  app.post('/api/auth/social', (_req, res) => {
    res.status(503).json({ error: 'تسجيل الدخول بـ Google وApple غير مفعّل حالياً.', code: 'SOCIAL_LOGIN_UNAVAILABLE' });
  });
  app.patch('/api/reps/:id/approval', adminOnly, (req, res) => {
    const parsed = z.object({ status: z.enum(['approved', 'rejected', 'pending']) }).strict().safeParse(req.body);
    const user = store.get("SELECT * FROM users WHERE id=? AND role='rep'", String(req.params.id));
    if (!parsed.success || !user) { res.status(400).json({ error: 'بيانات الموافقة غير صحيحة.' }); return; }
    const previousStatus = String(user.approval_status || 'approved');
    store.run('UPDATE users SET approval_status=? WHERE id=?', parsed.data.status, user.id);
    if (parsed.data.status !== 'approved') { store.run('DELETE FROM sessions WHERE user_id=?', user.id); io.in(`user:${user.id}`).disconnectSockets(true); }
    if (previousStatus !== parsed.data.status) {
      const message = parsed.data.status === 'approved'
        ? 'تم تفعيل حسابك. يمكنك تسجيل الدخول ومتابعة عملك.'
        : parsed.data.status === 'rejected' ? 'تم تحديث حالة حسابك. تواصل مع مدير المتابعة.' : 'حسابك بانتظار مراجعة الإدارة.';
      notifyUser(user.id, 'تحديث حالة الحساب', message, { type: 'account_status', status: parsed.data.status });
    }
    store.audit(res.locals.user.id, 'rep.approval', { repId: user.id, status: parsed.data.status });
    invalidateKpis(); broadcast();
    res.json({ user: publicUser(store.get('SELECT * FROM users WHERE id=?', user.id)!) });
  });
  app.get('/api/auth/me', auth, (_req, res) => { res.json({ user: publicUser(res.locals.user) }); });
  // The manager creates accounts with a password they chose; the owner must be able to replace
  // it without asking anyone to edit the database by hand.
  const passwordChangeSchema = z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(10).max(200),
  }).strict();
  app.post('/api/me/password', auth, (req, res) => {
    const parsed = passwordChangeSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'كلمة المرور الجديدة قصيرة — ١٠ أحرف على الأقل.', code: 'PASSWORD_TOO_SHORT' }); return; }
    const user = res.locals.user;
    if (!verifyPassword(parsed.data.currentPassword, user.password_hash)) {
      res.status(403).json({ error: 'كلمة المرور الحالية غير صحيحة.', code: 'WRONG_PASSWORD' }); return;
    }
    if (parsed.data.newPassword === parsed.data.currentPassword) {
      res.status(400).json({ error: 'اختر كلمة مرور مختلفة عن الحالية.', code: 'SAME_PASSWORD' }); return;
    }
    if (user.role === 'admin' && parsed.data.newPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `كلمة مرور المدير ${MIN_ADMIN_PASSWORD_LENGTH} حرفًا على الأقل.`, code: 'PASSWORD_TOO_SHORT' }); return;
    }
    store.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(parsed.data.newPassword), user.id);
    // Every other device is signed out, so a password change cannot leave an old session alive.
    store.run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', user.id, res.locals.tokenHash);
    // A live socket keeps its identity from the handshake, so deleting the row is not enough:
    // the other devices must be dropped or they keep receiving live updates.
    io.in(`user:${user.id}`).disconnectSockets(true);
    store.audit(user.id, 'auth.password_change');
    res.json({ ok: true });
  });
  app.post('/api/auth/logout', auth, (req, res) => {
    if (res.locals.user.role === 'rep') endShift(res.locals.user.id);
    // Logging out must stop notifications on the old phone before another person can use it.
    store.run('DELETE FROM push_tokens WHERE user_id=?', res.locals.user.id);
    store.run('DELETE FROM sessions WHERE token_hash=?', res.locals.tokenHash);
    clearSessionCookies(req, res);
    store.audit(res.locals.user.id, 'auth.logout');
    io.in(`user:${res.locals.user.id}`).disconnectSockets(true);
    invalidateKpis(); broadcast();
    res.json({ ok: true });
  });
  // ---- Public privacy policy: both app stores require a reachable URL for it ----
  app.get('/privacy', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.type('html').send(privacyPage(config));
  });
  // ---- Public deletion page: the web link Google Play asks for in Data safety ----
  // It has to open without the app and without a login, and say exactly what is erased.
  app.get('/delete-account', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.type('html').send(deleteAccountPage(config));
  });

  // ---- Right to erasure, from inside the app ----
  // The stores require a real in-app deletion path, not an email address. The typed email is
  // the confirmation step: it cannot be triggered by a stray tap or a replayed request.
  const deleteAccountSchema = z.object({
    confirm: z.literal(true),
    email: z.email().max(254).transform(value => value.toLowerCase().trim()),
  }).strict();
  app.delete('/api/me', auth, (req, res) => {
    const parsed = deleteAccountSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'أكّد الحذف بكتابة بريد حسابك.', code: 'CONFIRM_REQUIRED' }); return; }
    const user = res.locals.user;
    if (parsed.data.email !== String(user.email).toLowerCase()) {
      res.status(422).json({ error: 'البريد المكتوب لا يطابق بريد الحساب.', code: 'EMAIL_MISMATCH' }); return;
    }
    if (user.role === 'admin') {
      const admins = Number(store.get("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1")?.c || 0);
      // Deleting the only manager would leave an installation nobody can administer.
      if (admins <= 1) {
        res.status(409).json({ error: 'هذا آخر حساب مدير. أضف مديرًا آخر أو احذف الحساب من قاعدة البيانات على السيرفر.', code: 'LAST_ADMIN' }); return;
      }
    }
    const snapshot = { id: user.id, role: user.role };
    // One transaction: a half-deleted account (sessions gone, rows left behind) is worse than
    // none, and SQLite does not support nesting them.
    store.transaction(() => {
      endShift(user.id);
      store.run('DELETE FROM sessions WHERE user_id=?', user.id);
      // Every table that holds personal data references users(id) ON DELETE CASCADE.
      store.run('DELETE FROM users WHERE id=?', user.id);
      // The audit trail outlives the account on purpose: it records that the deletion happened
      // without keeping anything that identifies the person beyond a short opaque prefix.
      store.run('INSERT INTO audit_log(user_id,action,created_at,metadata) VALUES (?,?,?,?)',
        `deleted:${String(snapshot.id).slice(0, 8)}`, 'account.delete', Date.now(), JSON.stringify({ role: snapshot.role }));
    });
    io.in(`user:${snapshot.id}`).disconnectSockets(true);
    clearSessionCookies(req, res);
    invalidateDistanceForUser(snapshot.id);
    invalidateKpis(); broadcast();
    res.json({ ok: true });
  });

  app.get('/api/overview', adminOnly, (_req, res) => res.json(overview()));
  app.get('/api/reps', adminOnly, (_req, res) => res.json({ reps: overview().reps }));
  app.post('/api/reps', adminOnly, (req, res) => {
    const parsed = newRep.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'راجع الاسم والبريد وكلمة المرور (١٠ أحرف على الأقل).' }); return; }
    const data = parsed.data;
    if (store.get('SELECT id FROM users WHERE email=?', data.email)) { res.status(409).json({ error: 'البريد الإلكتروني مستخدم بالفعل.' }); return; }
    const id = randomUUID();
    const usedColors = store.all("SELECT color FROM users WHERE role='rep'").map(row => String(row.color || ''));
    store.run('INSERT INTO users(id,name,email,password_hash,role,phone,region,color,created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, data.name, data.email, hashPassword(data.password), 'rep', data.phone, data.region, nextRepColor(usedColors), Date.now());
    store.audit(res.locals.user.id, 'rep.create', { repId: id });
    invalidateKpis(); broadcast();
    res.status(201).json({ user: publicUser(store.get('SELECT * FROM users WHERE id=?', id)!) });
  });
  app.patch('/api/reps/:id', adminOnly, (req, res) => {
    const parsed = z.object({ active: z.boolean() }).strict().safeParse(req.body);
    const user = store.get("SELECT * FROM users WHERE id=? AND role='rep'", String(req.params.id));
    if (!parsed.success || !user) { res.status(400).json({ error: 'بيانات المهندس أو الحالة غير صحيحة.' }); return; }
    store.run('UPDATE users SET active=? WHERE id=?', Number(parsed.data.active), user.id);
    if (!parsed.data.active) {
      endShift(user.id);
      store.run('DELETE FROM sessions WHERE user_id=?', user.id);
      io.in(`user:${user.id}`).disconnectSockets(true);
    }
    store.audit(res.locals.user.id, parsed.data.active ? 'rep.enable' : 'rep.disable', { repId: user.id });
    invalidateKpis(); broadcast();
    res.json({ user: publicUser(store.get('SELECT * FROM users WHERE id=?', user.id)!) });
  });
  app.get('/api/reps/:id/route', auth, (req, res) => {
    const id = String(req.params.id);
    if (res.locals.user.role !== 'admin' && res.locals.user.id !== id) { res.status(403).json({ error: 'يمكنك عرض مسارك فقط.' }); return; }
    const date = typeof req.query.date === 'string' ? req.query.date : localDate(config.timezone);
    let bounds;
    try { bounds = dayBounds(date, config.timezone); } catch { res.status(400).json({ error: 'التاريخ غير صحيح.' }); return; }
    if (!store.get("SELECT id FROM users WHERE id=? AND role='rep'", id)) { res.status(404).json({ error: 'المهندس غير موجود.' }); return; }
    const requested = Number(req.query.maxPoints);
    const maxPoints = Number.isFinite(requested) ? Math.min(5000, Math.max(200, Math.round(requested))) : ROUTE_MAX_POINTS;
    const rows = store.all(`SELECT point_id AS id,lat,lng,accuracy,speed,heading,battery,recorded_at AS recordedAt,received_at AS receivedAt,source,shift_id AS shiftId
      FROM locations WHERE user_id=? AND recorded_at>=? AND recorded_at<? ORDER BY recorded_at, received_at LIMIT 20001`, id, bounds.start, bounds.end);
    const truncated = rows.length > 20000;
    const all = (truncated ? rows.slice(0, 20000) : rows) as unknown as GeoPoint[];
    // The trail is drawn, never recomputed client-side: a full day at one fix per second is
    // ~28k points (≈5 MB). Distance still uses every point; only the polyline is thinned.
    const points = all.length > maxPoints ? thinPolyline(all, maxPoints) : all;
    res.json({
      date, timezone: config.timezone, points, pointCount: all.length,
      sampled: points.length < all.length, truncated,
      distanceMeters: Math.round(distanceMeters(all)),
    });
  });
  app.get('/api/me/shift', repOnly, (req, res) => {
    const shift = store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', res.locals.user.id);
    // The engineer app polls this every fifteen seconds and only reads `shift`, so it asks for
    // `?snapshot=0`; the snapshot walks the whole day's fixes and is kept for API consumers.
    const snapshot = req.query.snapshot === '0' ? undefined : repSnapshot(res.locals.user);
    res.json({ shift: shift || null, snapshot, consentVersion: CONSENT_VERSION });
  });
  const deviceTaken = (owner: string) =>
    `هذا الحساب مرتبط بهاتف آخر (${owner.slice(0, 8)}…). تواصل مع المدير لإعادة الربط.`;
  /**
   * Binds the account to the first phone that starts a shift.
   *
   * The first write is conditional, so two phones that race the very first start cannot both
   * believe they own the account: whoever loses the update is told to ask the manager instead
   * of taking the account over silently.
   */
  const bindDevice = (user: any, deviceId: string): string | null => {
    const existing = String(user.device_id || '').trim();
    if (!existing) {
      store.run("UPDATE users SET device_id=? WHERE id=? AND (device_id IS NULL OR device_id='')", deviceId, user.id);
      const owner = String(store.get('SELECT device_id FROM users WHERE id=?', user.id)?.device_id || '').trim();
      return owner === deviceId ? null : deviceTaken(owner);
    }
    if (existing !== deviceId) return deviceTaken(existing);
    return null;
  };
  app.post('/api/shifts/start', repOnly, (req, res) => {
    const parsed = startShiftSchema.safeParse(req.body);
    if (!parsed.success) {
      const hasLocation = req.body && typeof req.body.location === 'object' && req.body.location !== null;
      const gpsIssue = parsed.error.issues.some(issue => issue.path[0] === 'location');
      const hasDevice = req.body && typeof req.body.deviceId === 'string' && req.body.deviceId.trim().length >= 3;
      if (!hasLocation || gpsIssue) {
        res.status(422).json({
          error: hasLocation ? 'إشارة GPS غير صالحة أو دقتها أضعف من ١٢٠ مترًا. انتظر حتى تثبت الإشارة.' : 'GPS مطلوب — فعّل الموقع وامنح الإذن قبل بدء الوردية.',
          code: 'GPS_REQUIRED', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })),
        }); return;
      }
      if (!hasDevice) { res.status(422).json({ error: 'الجهاز غير موثّق — أرسل معرّف الهاتف.', code: 'DEVICE_REQUIRED', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return; }
      res.status(400).json({ error: 'بيانات بدء الوردية غير صحيحة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return;
    }
    const deviceErr = bindDevice(res.locals.user, parsed.data.deviceId);
    if (deviceErr) { res.status(403).json({ error: deviceErr, code: 'DEVICE_MISMATCH' }); return; }
    let shift = store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', res.locals.user.id);
    if (!shift) {
      const id = randomUUID(), now = Date.now();
      store.transaction(() => {
        store.run('INSERT INTO shifts(id,user_id,started_at,consent_version,consent_at,device_id,device_name,start_lat,start_lng,start_accuracy) VALUES (?,?,?,?,?,?,?,?,?,?)',
          id, res.locals.user.id, now, CONSENT_VERSION, now, parsed.data.deviceId, parsed.data.deviceName || '', parsed.data.location.lat, parsed.data.location.lng, parsed.data.location.accuracy ?? null);
        store.run(`INSERT INTO locations(point_id,user_id,shift_id,lat,lng,accuracy,speed,heading,battery,recorded_at,received_at,source)
          VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,?,'gps')`, randomUUID(), res.locals.user.id, id, parsed.data.location.lat, parsed.data.location.lng, parsed.data.location.accuracy ?? null, now, now);
        store.run('UPDATE users SET last_seen=? WHERE id=?', now, res.locals.user.id);
        store.audit(res.locals.user.id, 'shift.start', { consentVersion: CONSENT_VERSION, deviceId: parsed.data.deviceId, lat: parsed.data.location.lat, lng: parsed.data.location.lng });
      });
      shift = store.get('SELECT * FROM shifts WHERE id=?', id);
    }
    invalidateKpis(); broadcast();
    res.json({ shift });
  });
  const idleSchema = z.object({ reason: z.string().trim().min(5).max(1000), location: gpsLocation, deviceId: z.string().trim().min(3).max(120) }).strict();
  app.post('/api/shifts/idle', repOnly, (req, res) => {
    const parsed = idleSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'سبب الوقوف مطلوب مع الموقع — لا يمكن ترك الحقل فارغًا.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return; }
    const deviceErr = bindDevice(res.locals.user, parsed.data.deviceId);
    if (deviceErr) { res.status(403).json({ error: deviceErr, code: 'DEVICE_MISMATCH' }); return; }
    const shift = store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', res.locals.user.id);
    const now = Date.now();
    const lastLoc = store.get('SELECT recorded_at FROM locations WHERE user_id=? ORDER BY recorded_at DESC LIMIT 1', res.locals.user.id);
    const idleMinutes = lastLoc ? Math.round((now - Number(lastLoc.recorded_at)) / 60000) : 0;
    const id = randomUUID();
    store.run('INSERT INTO idle_reports(id,user_id,shift_id,lat,lng,accuracy,reason,duration_minutes,device_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, res.locals.user.id, shift?.id ?? null, parsed.data.location.lat, parsed.data.location.lng, parsed.data.location.accuracy ?? null, parsed.data.reason, idleMinutes, parsed.data.deviceId, now);
    store.audit(res.locals.user.id, 'shift.idle_report', { reason: parsed.data.reason, idleMinutes, deviceId: parsed.data.deviceId });
    invalidateKpis(); broadcast();
    res.status(201).json({ id, idleMinutes });
  });
  app.post('/api/shifts/stop', repOnly, (_req, res) => { endShift(res.locals.user.id); broadcast(); res.json({ ok: true }); });
  app.post('/api/presence', repOnly, (_req, res) => {
    store.run('UPDATE users SET last_seen=? WHERE id=?', Date.now(), res.locals.user.id);
    broadcast();
    res.json({ ok: true });
  });
  app.post('/api/locations', repOnly, locationLimiter, (req, res) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'بيانات الموقع غير صالحة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return; }
    const now = Date.now(), cutoff = now - config.retentionDays * 86400000;
    // A phone whose clock runs fast used to lose its whole day: every fix looked like it came
    // from the future, the batch was rejected, and the engineer saw "everything is sent" while
    // the manager saw no signal. A real offset is measured from the newest fix and removed from
    // the whole batch, which keeps the spacing between fixes intact. A few seconds of drift is
    // ordinary jitter and is left alone, so a fix taken exactly at the shift start still counts.
    const newestStamp = parsed.data.points.reduce((latest, point) => Math.max(latest, point.recordedAt), 0);
    const drift = newestStamp > now ? newestStamp - now : 0;
    if (drift > CLOCK_SKEW_TOLERANCE_MS) {
      res.status(422).json({
        error: 'ساعة الهاتف متقدمة كثيرًا عن السيرفر. فعّل «الوقت التلقائي» في إعدادات الهاتف ثم أعد المحاولة.',
        code: 'CLOCK_SKEW', skewMinutes: Math.round(drift / 60000),
      }); return;
    }
    const clockSkew = drift > CLOCK_SKEW_FLOOR_MS ? drift : 0;
    const shiftCache = new Map<string, Record<string, any> | undefined>();
    const stamped = (recordedAt: number, shift: Record<string, any>) => {
      if (!clockSkew) return recordedAt;
      const corrected = Math.min(now, recordedAt - clockSkew);
      // Correcting a fast clock can pull the first fix of the shift a little before its start;
      // the fix belongs to that shift, so it is pinned to the boundary instead of being dropped.
      return corrected < Number(shift.started_at) ? Number(shift.started_at) : corrected;
    };
    for (const point of parsed.data.points) {
      if (!shiftCache.has(point.shiftId)) shiftCache.set(point.shiftId, store.get('SELECT * FROM shifts WHERE id=? AND user_id=?', point.shiftId, res.locals.user.id));
      const shift = shiftCache.get(point.shiftId);
      const recordedAt = shift ? stamped(point.recordedAt, shift) : point.recordedAt;
      if (!shift || recordedAt > (shift.ended_at ?? now) + 5000 || recordedAt < cutoff
        || (!clockSkew && recordedAt < Number(shift.started_at))) {
        res.status(422).json({ error: 'نقطة خارج وردية مصرح بها أو خارج مدة الاحتفاظ. لن يتم قبول الدفعة.' }); return;
      }
    }
    let accepted = 0, duplicates = 0;
    const historicalFixes: number[] = [];
    store.transaction(() => {
      for (const p of parsed.data.points) {
        const recordedAt = stamped(p.recordedAt, shiftCache.get(p.shiftId) as Record<string, any>);
        const result = store.run(`INSERT OR IGNORE INTO locations(point_id,user_id,shift_id,lat,lng,accuracy,speed,heading,battery,recorded_at,received_at,source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, p.id, res.locals.user.id, p.shiftId, p.lat, p.lng, p.accuracy, p.speed, p.heading, p.battery,
          recordedAt, now, 'gps');
        if (result.changes) {
          accepted++;
          if (recordedAt < now - 5 * 60000) historicalFixes.push(recordedAt);
        } else duplicates++;
      }
      store.run('UPDATE users SET last_seen=? WHERE id=?', now, res.locals.user.id);
    });
    // Recent fixes cannot belong to a completed cached day, so they only refresh the live view.
    // A delayed offline batch can change an older report: evict each affected calendar day and
    // the short-lived response cache, but do not make every second of a live track rebuild KPIs.
    for (const recordedAt of historicalFixes) invalidateDistanceDay(res.locals.user.id, recordedAt);
    if (historicalFixes.length) invalidateKpis();
    broadcast();
    res.json({ accepted, duplicates });
  });
  // ---- Field visits: check in / check out around a customer with GPS proof ----
  app.post('/api/visits/check-in', repOnly, (req, res) => {
    const parsed = newVisit.safeParse(req.body);
    if (!parsed.success) {
      const hasLoc = req.body && typeof req.body.location === 'object' && req.body.location !== null && typeof req.body.location.lat === 'number';
      const gpsIssue = parsed.error.issues.some(issue => issue.path[0] === 'location');
      if (!hasLoc || gpsIssue) {
        res.status(422).json({
          error: hasLoc ? 'إشارة GPS غير صالحة أو دقتها أضعف من ١٢٠ مترًا. انتظر حتى تثبت الإشارة.' : 'GPS مطلوب — فعّل الموقع قبل تسجيل الزيارة.',
          code: 'GPS_REQUIRED', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })),
        }); return;
      }
      res.status(400).json({ error: 'راجع بيانات الزيارة: اسم العميل مطلوب.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return;
    }
    if (req.body && typeof req.body.deviceId === 'string' && req.body.deviceId.trim().length >= 3) {
      const de = bindDevice(res.locals.user, String(req.body.deviceId).trim());
      if (de) { res.status(403).json({ error: de, code: 'DEVICE_MISMATCH' }); return; }
    }
    const data = parsed.data;
    const existing = visitRow(data.id);
    if (existing) {
      if (existing.userId !== res.locals.user.id) { res.status(409).json({ error: 'معرّف الزيارة مستخدم بالفعل.' }); return; }
      res.status(200).json({ visit: existing, duplicate: true }); return;
    }
    /*
     * A visit typed in a field with no signal is sent later by the phone's outbox, naming the
     * moment it was actually recorded. The server cannot see that moment, so the only thing it
     * can check is that the time falls inside one of this engineer's own shifts and inside the
     * window a phone may hold a visit. The row is marked `recordedOffline` so the manager can
     * tell a live record from a replayed one.
     */
    const now = Date.now();
    let checkedInAt = now;
    let offline = false;
    if (data.recordedAt !== undefined) {
      const at = Number(data.recordedAt);
      const insideShift = store.get('SELECT id FROM shifts WHERE user_id=? AND started_at<=? AND (ended_at IS NULL OR ended_at>=?) ORDER BY started_at DESC LIMIT 1',
        res.locals.user.id, at, at);
      const reason = at > now + 60000 ? 'الوقت المرسل في المستقبل.'
        : at < now - OFFLINE_WINDOW_MS ? 'الزيارة أقدم من ٢٤ ساعة، مش ممكن تتسجل بأثر رجعي.'
        : !insideShift ? 'مفيش وردية مسجلة في الوقت ده.'
        : '';
      if (reason) { res.status(422).json({ error: `الزيارة المتأخرة مرفوضة: ${reason}`, code: 'OFFLINE_VISIT_REJECTED' }); return; }
      checkedInAt = at;
      offline = true;
    } else {
      const shift = store.get('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', res.locals.user.id);
      if (!shift) { res.status(409).json({ error: 'ابدأ الوردية أولًا قبل تسجيل الزيارة.' }); return; }
    }
    const open = store.get('SELECT id, checked_in_at AS checkedInAt FROM visits WHERE user_id=? AND status=?', res.locals.user.id, 'open');
    if (open && !offline) {
      // Saying "لديك زيارة مفتوحة" while the visit is not on this screen is how an engineer
      // gets stuck: name the day so he knows where to look (it is listed under "الزيارات").
      const fromEarlier = localDate(config.timezone, Number(open.checkedInAt)) !== localDate(config.timezone);
      res.status(409).json({
        error: fromEarlier
          ? 'لديك زيارة مفتوحة من يوم سابق — افتح تبويب «الزيارات»، ستجدها بالأعلى، واقفلها الأول.'
          : 'لديك زيارة مفتوحة. أنهِها قبل بدء زيارة جديدة.',
        openVisitId: open.id,
      });
      return;
    }
    /*
     * A replayed visit that arrives while another visit is open is already over: it is stored
     * closed with the automatic marker, which is exactly the "missing result" row the engineer
     * can finish from the visits screen. Refusing it would silently delete a customer visit that
     * really happened.
     */
    const closedOnArrival = Boolean(open);
    store.run(`INSERT INTO visits(id,user_id,customer_name,governorate,district,village,phone,purpose,notes,status,checked_in_at,checked_out_at,duration_seconds,auto_closed,recorded_offline,outcome,in_lat,in_lng,in_accuracy,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, data.id, res.locals.user.id, data.customerName, data.governorate,
      data.district, data.village, data.phone, data.purpose, data.notes,
      closedOnArrival ? 'closed' : 'open', checkedInAt, closedOnArrival ? checkedInAt : null,
      closedOnArrival ? 0 : null, closedOnArrival ? 1 : 0, offline ? 1 : 0,
      closedOnArrival ? AUTO_CLOSED_OUTCOME : '',
      data.location.lat, data.location.lng, data.location.accuracy ?? null, now);
    store.audit(res.locals.user.id, offline ? 'visit.check_in_offline' : 'visit.check_in',
      { visitId: data.id, purpose: data.purpose, ...(offline ? { recordedAt: checkedInAt } : {}) });
    io.to('admins').emit('visit', visitRow(data.id));
    invalidateKpis(); broadcast();
    res.status(201).json({ visit: visitRow(data.id), duplicate: false, ...(offline ? { recordedOffline: true } : {}) });
  });
  app.post('/api/visits/:id/check-out', repOnly, (req, res) => {
    const parsed = closeVisit.safeParse(req.body ?? {});
    // The first broken rule is the useful sentence ("اكتب نتيجة الزيارة…"), not the generic one.
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات إنهاء الزيارة غير صحيحة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return; }
    const visit = visitRow(String(req.params.id));
    if (!visit || visit.userId !== res.locals.user.id) { res.status(404).json({ error: 'الزيارة غير موجودة.' }); return; }
    const now = Date.now();
    if (visit.status === 'closed') {
      /*
       * A visit the system closed because the shift ended (or the app was killed) never got its
       * result. The row is closed, so the normal path answered "duplicate" and the engineer had
       * no way to say what happened — the one field the audit trail exists for. Writing the
       * result now is allowed; the duration stays unknown, so `auto_closed` stays set and the
       * KPI average keeps ignoring it.
       */
      // Only while the result is still the automatic text: once it is written it is not
      // rewritten by a retry (the queued request may arrive twice), exactly like a normal visit.
      if (Number(visit.autoClosed) !== 1 || visit.outcome !== AUTO_CLOSED_OUTCOME) {
        res.json({ visit, duplicate: true });
        return;
      }
      const late = parsed.data;
      // A visit replayed from the outbox knows both ends: the check-in it was queued with and the
      // moment the phone closed it. Apply the same time window as a normal offline check-out;
      // silently clamping a future or stale `recordedAt` made the export claim the wrong time.
      let lateAt: number | null = null;
      if (late.recordedAt !== undefined) {
        const at = Number(late.recordedAt);
        const reason = at > now + 60000 ? 'الوقت المرسل في المستقبل.'
          : at < now - OFFLINE_WINDOW_MS ? 'الإنهاء أقدم من ٢٤ ساعة، مش ممكن يتسجل بأثر رجعي.'
          : at < Number(visit.checkedInAt) - 60000 ? 'وقت الإنهاء قبل وقت الزيارة.'
          : '';
        if (reason) { res.status(422).json({ error: `الإنهاء المتأخر مرفوض: ${reason}`, code: 'OFFLINE_VISIT_REJECTED' }); return; }
        lateAt = Math.max(Number(visit.checkedInAt), at);
      }
      const lateDuration = lateAt === null ? null : Math.max(0, Math.round((lateAt - Number(visit.checkedInAt)) / 1000));
      store.run('UPDATE visits SET outcome=?, notes=?, out_lat=?, out_lng=? WHERE id=?',
        late.outcome, late.notes || visit.notes, late.location?.lat ?? null, late.location?.lng ?? null, visit.id);
      if (lateAt !== null) {
        store.run('UPDATE visits SET checked_out_at=?, duration_seconds=?, recorded_offline=1 WHERE id=?', lateAt, lateDuration, visit.id);
      }
      if (late.amount !== null && late.amount > 0) {
        store.run(`INSERT OR IGNORE INTO reports(id,user_id,shift_id,type,title,body,customer,amount,lat,lng,accuracy,status,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'new',?)`, `visit:${visit.id}`, res.locals.user.id, null, 'collection',
          `تحصيل - ${visit.customerName}`, late.outcome || visit.notes, visit.customerName, late.amount,
          late.location?.lat ?? visit.inLat ?? null, late.location?.lng ?? visit.inLng ?? null, late.location?.accuracy ?? null, lateAt ?? Date.now());
      }
      store.audit(res.locals.user.id, 'visit.result_recorded_late', { visitId: visit.id });
      io.to('admins').emit('visit', visitRow(visit.id));
      invalidateKpis(); broadcast();
      res.json({ visit: visitRow(visit.id), duplicate: false, recordedLate: true });
      return;
    }
    const data = parsed.data;
    /*
     * The outbox sends the instant the visit was closed on the phone. It has to be inside the
     * visit itself, inside the window a phone may hold, and never in the future — otherwise the
     * duration would be negative or invented, and a negative duration is worse than none.
     */
    let closedAt = now;
    let offline = false;
    if (data.recordedAt !== undefined) {
      const at = Number(data.recordedAt);
      const reason = at > now + 60000 ? 'الوقت المرسل في المستقبل.'
        : at < now - OFFLINE_WINDOW_MS ? 'الإنهاء أقدم من ٢٤ ساعة، مش ممكن يتسجل بأثر رجعي.'
        : at < Number(visit.checkedInAt) - 60000 ? 'وقت الإنهاء قبل وقت الزيارة.'
        : '';
      if (reason) { res.status(422).json({ error: `الإنهاء المتأخر مرفوض: ${reason}`, code: 'OFFLINE_VISIT_REJECTED' }); return; }
      closedAt = Math.max(Number(visit.checkedInAt), at);
      offline = true;
    }
    const duration = Math.max(0, Math.round((closedAt - Number(visit.checkedInAt)) / 1000));
    store.run(`UPDATE visits SET status='closed', checked_out_at=?, duration_seconds=?, outcome=?, notes=?,
      out_lat=?, out_lng=?, recorded_offline=MAX(recorded_offline, ?) WHERE id=?`, closedAt, duration, data.outcome, data.notes || visit.notes,
      data.location?.lat ?? null, data.location?.lng ?? null, offline ? 1 : 0, visit.id);
    // A collection is also a financial event: mirror it into the reports feed for the manager.
    if (data.amount !== null && data.amount > 0) {
      store.run(`INSERT OR IGNORE INTO reports(id,user_id,shift_id,type,title,body,customer,amount,lat,lng,accuracy,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'new',?)`, `visit:${visit.id}`, res.locals.user.id, null, 'collection',
        `تحصيل - ${visit.customerName}`, data.outcome || visit.notes, visit.customerName, data.amount,
        data.location?.lat ?? visit.inLat ?? null, data.location?.lng ?? visit.inLng ?? null, data.location?.accuracy ?? null, closedAt);
    }
    store.audit(res.locals.user.id, offline ? 'visit.check_out_offline' : 'visit.check_out',
      { visitId: visit.id, durationSeconds: duration, ...(offline ? { recordedAt: closedAt } : {}) });
    io.to('admins').emit('visit', visitRow(visit.id));
    invalidateKpis(); broadcast();
    res.json({ visit: visitRow(visit.id), duplicate: false });
  });
  app.get('/api/visits', auth, (req, res) => {
    const isAdmin = res.locals.user.role === 'admin';
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    const status = req.query.status === 'open' || req.query.status === 'closed' ? req.query.status : undefined;
    const repId = isAdmin && typeof req.query.repId === 'string' ? req.query.repId : undefined;
    if (date) { try { dayBounds(date, config.timezone); } catch { res.status(400).json({ error: 'التاريخ غير صحيح.' }); return; } }
    // The engineer app's screen is titled "زيارات اليوم" and asks without a date, so it used to
    // list — and count — every visit the account ever recorded. Yesterday's visits belong to
    // `?date=`, and the manager's feed still spans everything unless a date is given.
    const scopeDate = date ?? (isAdmin ? undefined : localDate(config.timezone));
    const visits = listVisits({ userId: isAdmin ? repId : res.locals.user.id, date: scopeDate, status });
    // The manager's feed, and any explicit day, are answered exactly as asked.
    if (isAdmin || date) { res.json({ visits }); return; }
    /*
     * The engineer's screen is titled "today", but two kinds of visit it must still show belong
     * to an earlier day:
     *   - one the system closed because the app was killed (the cleanup ran the next morning):
     *     the result is missing and this screen is the only place it can be typed;
     *   - one still open for an account with no running shift: nothing else can close it, and
     *     every check-in is refused with a message about it.
     * Both come along from the last two weeks. An open visit is not a "closed" row, so a filter
     * for closed results asks only for the first kind.
     */
    const wantsOpen = status !== 'closed';
    const wantsPending = status !== 'open';
    const extraSql = wantsOpen && wantsPending ? `(v.status='open' OR ${PENDING_RESULT_SQL})`
      : wantsOpen ? "v.status='open'" : PENDING_RESULT_SQL;
    const pending = store.all(`${VISIT_SELECT} WHERE v.user_id=? AND ${extraSql} AND v.checked_in_at>=? ORDER BY v.checked_in_at DESC LIMIT 50`,
      res.locals.user.id, Date.now() - 14 * 86400000) as Array<Record<string, any>>;
    const seen = new Set(visits.map(visit => String(visit.id)));
    const missing = pending.filter(visit => !seen.has(String(visit.id)));
    const merged: Array<Record<string, any>> = missing.length
      ? [...missing, ...(visits as Array<Record<string, any>>)].sort((a, b) => Number(b.checkedInAt) - Number(a.checkedInAt))
      : (visits as Array<Record<string, any>>);
    res.json({ visits: merged });
  });
  app.get('/api/me/summary', repOnly, (req, res) => {
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : localDate(config.timezone);
    let bounds;
    try { bounds = dayBounds(date, config.timezone); } catch { res.status(400).json({ error: 'التاريخ غير صحيح.' }); return; }
    const user = res.locals.user;
    // For today the figures come from the snapshot the live view already keeps warm, instead of
    // walking the whole day again on every poll. Any other date is computed on demand, because
    // the snapshot only ever describes today.
    const isToday = date === localDate(config.timezone);
    const snapshot = isToday ? repSnapshot(user) : null;
    const distance = snapshot
      ? {
          meters: snapshot.distanceMeters,
          points: snapshot.pointCount,
          first: (store.get('SELECT MIN(recorded_at) AS at FROM locations WHERE user_id=? AND recorded_at>=? AND recorded_at<?', user.id, bounds.start, bounds.end)?.at ?? null) as number | null,
          last: snapshot.location?.recordedAt ?? null,
          lastAccuracy: snapshot.location?.accuracy ?? null,
        }
      : dayDistance(user.id, bounds.start, bounds.end);
    const visits = listVisits({ userId: user.id, date });
    const completed = visits.filter(v => v.status === 'closed');
    const measured = completed.filter(v => !v.autoClosed && v.durationSeconds !== null);
    const open = visits.find(v => v.status === 'open') || null;
    // Auto-closed visits have no measured checkout, so they count as completed but not in an
    // average. The manager KPI already follows this rule; the engineer summary must agree.
    const avgVisitSeconds = measured.length ? Math.round(measured.reduce((sum, v) => sum + Number(v.durationSeconds), 0) / measured.length) : null;
    const collections = store.get("SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS total FROM reports WHERE user_id=? AND type='collection' AND created_at>=? AND created_at<?", user.id, bounds.start, bounds.end);
    const daily = store.get('SELECT id, status, created_at AS createdAt FROM daily_reports WHERE user_id=? AND report_date=?', user.id, date);
    const shift = store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', user.id);
    res.json({
      date, timezone: config.timezone, shift: shift || null,
      // The app tells the engineer how long the data is kept; it has to ask, because the
      // number lives in the server config (and used to be hard-coded as "30 days" in the UI).
      retentionDays: config.retentionDays,
      // The banner that asks for a stillness reason uses the server's threshold, not its own.
      idleReasonMinutes: config.idleReasonMinutes,
      distanceMeters: distance.meters, pointCount: distance.points, firstFixAt: distance.first, lastFixAt: distance.last, lastFixAccuracy: distance.lastAccuracy,
      visitsTotal: visits.length, visitsCompleted: completed.length, openVisit: open, avgVisitSeconds,
      collectionsCount: Number(collections?.c || 0), collectionAmount: Number(collections?.total || 0),
      dailyReport: daily || null,
    });
  });
  // ---- Manager view: exception alerts + per-representative KPIs ----
  app.get('/api/alerts', adminOnly, (_req, res) => {
    const now = Date.now();
    const today = localDate(config.timezone);
    const bounds = dayBounds(today, config.timezone);
    const alerts: Array<Record<string, any>> = [];
    const reps = store.all("SELECT * FROM users WHERE role='rep' AND active=1 ORDER BY name");
    for (const rep of reps) {
      const shift = store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', rep.id);
      const last = store.get('SELECT MAX(recorded_at) AS at FROM locations WHERE user_id=?', rep.id);
      const lastAt = last?.at ? Number(last.at) : null;
      // One threshold for the whole product (`STALE_GPS_MINUTES`, default 10): the map says
      // "لا إشارة" at exactly the moment this alert fires.
      const staleMs = config.staleGpsMinutes * 60000;
      if (shift && lastAt && now - lastAt > staleMs) {
        const staleMinutes = Math.round((now - lastAt) / 60000);
        alerts.push({
          id: `${rep.id}:stale`, level: 'warn', code: 'stale_gps', repId: rep.id, repName: rep.name,
          title: 'انقطاع في إرسال الموقع',
          detail: `آخر إشارة قبل ${staleMinutes} دقيقة (حد التنبيه ${config.staleGpsMinutes} دقيقة) — تأكد من فتح التطبيق والسماح بالموقع.`,
          at: lastAt,
        });
      }
      // One threshold for the phone banner and this alert (`IDLE_REASON_MINUTES`, default 60).
      if (shift && lastAt && now - lastAt > config.idleReasonMinutes * 60000) {
        // A justification covers the window it was written in, so an engineer who explained
        // himself ten minutes ago is not alerted again straight away.
        const recentJustification = store.get('SELECT id FROM idle_reports WHERE user_id=? AND created_at>?', rep.id, now - (config.idleReasonMinutes + 10) * 60000);
        if (!recentJustification) {
          alerts.push({ id: `${rep.id}:idle`, level: 'warn', code: 'idle_without_reason', repId: rep.id, repName: rep.name, title: `سكون ${config.idleReasonMinutes} دقيقة بدون تبرير`, detail: `لا حركة منذ ${Math.round((now - lastAt) / 60000)} دقيقة ولم يُرسل تبرير وقوف.`, at: lastAt });
        }
      }
      if (shift && !lastAt && now - Number(shift.started_at) > 20 * 60000) {
        alerts.push({ id: `${rep.id}:nosignal`, level: 'warn', code: 'no_signal', repId: rep.id, repName: rep.name, title: 'وردية بدون أي إشارة', detail: 'بدأ الوردية ولم تُسجل أي نقطة موقع بعد.', at: Number(shift.started_at) });
      }
      const visitsToday = store.get('SELECT COUNT(*) AS c FROM visits WHERE user_id=? AND checked_in_at>=? AND checked_in_at<?', rep.id, bounds.start, bounds.end)!;
      const hasActivity = !!lastAt && lastAt >= bounds.start;
      if (hasActivity && Number(visitsToday.c) === 0 && now - bounds.start > 2 * 3600000) {
        alerts.push({ id: `${rep.id}:novisit`, level: 'info', code: 'no_visits', repId: rep.id, repName: rep.name, title: 'لا زيارات مسجلة اليوم', detail: 'المهندس في الميدان لكن لم يسجل أي زيارة اليوم.', at: bounds.start });
      }
      /*
       * A visit is a claim about being somewhere. The native app now drops fixes the OS marks as
       * simulated and reports that flag, but a modified/rooted client can still omit it — this is
       * not hardware attestation. The independent trail checks below remain useful: a visit far
       * from every fix of that morning, or two visits at the same coordinates to five decimals,
       * is worth a manager's attention even though it is not proof.
       */
      const dayVisits = store.all(`SELECT id, customer_name AS customerName, checked_in_at AS checkedInAt,
          in_lat AS lat, in_lng AS lng, in_accuracy AS accuracy FROM visits
          WHERE user_id=? AND checked_in_at>=? AND checked_in_at<? ORDER BY checked_in_at`, rep.id, bounds.start, bounds.end) as Array<Record<string, any>>;
      const offTrail: string[] = [];
      const seenPlaces = new Map<string, string>();
      for (const dayVisit of dayVisits) {
        if (dayVisit.lat === null || dayVisit.lng === null) continue;
        const place = `${Number(dayVisit.lat).toFixed(5)},${Number(dayVisit.lng).toFixed(5)}`;
        const twin = seenPlaces.get(place);
        if (twin) {
          alerts.push({
            id: `${rep.id}:sameplace:${dayVisit.id}`, level: 'info', code: 'same_visit_location', repId: rep.id, repName: rep.name,
            title: 'زيارتان في نفس الإحداثيات',
            detail: `زيارة «${dayVisit.customerName}» وزيارة «${twin}» مسجلتان على نفس النقطة بالظبط — راجع الموقع لو المسافة بينهم بعيدة.`,
            at: Number(dayVisit.checkedInAt),
          });
        } else seenPlaces.set(place, String(dayVisit.customerName));
        const near = store.get(`SELECT lat, lng FROM locations WHERE user_id=? AND recorded_at BETWEEN ? AND ?
            ORDER BY ABS(recorded_at-?) LIMIT 1`,
        rep.id, Number(dayVisit.checkedInAt) - 10 * 60000, Number(dayVisit.checkedInAt) + 10 * 60000, Number(dayVisit.checkedInAt)) as Record<string, any> | undefined;
        // No fix within ten minutes of the check-in at all is a gap, not a contradiction: the
        // phone may have been in a dead spot. Only a fix that *contradicts* the visit is alerted.
        if (near && haversine({ lat: Number(dayVisit.lat), lng: Number(dayVisit.lng) }, { lat: Number(near.lat), lng: Number(near.lng) }) > 2000) {
          offTrail.push(String(dayVisit.customerName));
        }
      }
      if (offTrail.length) {
        alerts.push({
          id: `${rep.id}:offtrail`, level: 'warn', code: 'visit_off_trail', repId: rep.id, repName: rep.name,
          title: 'زيارة مسجلة بعيدًا عن المسار',
          detail: `${offTrail.length} زيارة (${offTrail.slice(0, 3).join('، ')}) اتسجلت على بعد أكثر من ٢ كيلومتر من أقرب إشارة موقع في نفس الوقت — تُراجع مع المهندس.`,
          at: now,
        });
      }
      // An open visit is what hides "the engineer forgot to close it": the pair check-in /
      // check-out is the record the manager relies on, so an unclosed one must surface.
      const openVisit = store.get('SELECT id, customer_name AS customerName, checked_in_at AS checkedInAt FROM visits WHERE user_id=? AND status=? ORDER BY checked_in_at LIMIT 1', rep.id, 'open');
      if (openVisit) {
        const openMinutes = Math.max(0, Math.round((now - Number(openVisit.checkedInAt)) / 60000));
        if (openMinutes >= 180) {
          const hours = Math.floor(openMinutes / 60);
          const rest = openMinutes % 60;
          const hoursText = hours >= 3 && hours <= 10 ? `${hours} ساعات` : `${hours} ساعة`;
          alerts.push({
            id: `${rep.id}:openvisit`, level: 'warn', code: 'long_open_visit', repId: rep.id, repName: rep.name,
            title: 'زيارة مفتوحة منذ فترة طويلة',
            detail: `زيارة «${openVisit.customerName}» مفتوحة منذ ${hoursText}${rest ? ` و${rest} دقيقة` : ''} بدون تسجيل خروج.`,
            at: Number(openVisit.checkedInAt),
          });
        }
        if (!shift) {
          alerts.push({
            id: `${rep.id}:orphanvisit`, level: 'warn', code: 'open_visit_without_shift', repId: rep.id, repName: rep.name,
            title: 'زيارة مفتوحة بعد انتهاء الوردية',
            detail: `الوردية مغلقة وزيارة «${openVisit.customerName}» لسه مفتوحة — لازم تتقفل بحضور (check-out).`,
            at: Number(openVisit.checkedInAt),
          });
        }
      }
      const daily = store.get('SELECT id FROM daily_reports WHERE user_id=? AND report_date=?', rep.id, today);
      const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
      if (hasActivity && !daily && localHour >= 16) {
        alerts.push({ id: `${rep.id}:daily`, level: 'warn', code: 'missing_daily_report', repId: rep.id, repName: rep.name, title: 'تقرير يومي غير مُرسل', detail: 'مر وقت العمل ولم يُرسل التقرير اليومي بعد.', at: bounds.start });
      }
    }
    // This is an operating-system signal reported by the installed app, not forensic proof:
    // modified/rooted clients can still lie. Keep it visible in the same manager alert feed so
    // a native mock-provider hit is investigated instead of silently discarded on the phone.
    const mockEvents = store.all(`SELECT e.id, e.created_at AS at, u.id AS repId, u.name AS repName
      FROM mock_location_events e JOIN users u ON u.id=e.user_id
      WHERE e.created_at>? AND u.active=1 ORDER BY e.created_at DESC LIMIT 100`, now - 24 * 3600000) as Array<Record<string, any>>;
    for (const event of mockEvents) alerts.push({
      id: `mock-location:${event.id}`, level: 'warn', code: 'mock_gps_detected', repId: String(event.repId), repName: String(event.repName),
      title: 'اكتُشف موقع مُحاكى من نظام التشغيل',
      detail: 'الهاتف أبلغ أن مزوّد الموقع وضع علامة «محاكى» على إشارة GPS. تم تجاهل النقطة؛ تحقّق من الجهاز مع المهندس.',
      at: Number(event.at),
    });
    const staleReviews = store.get('SELECT COUNT(*) AS c FROM reports WHERE status=? AND created_at<?', 'new', now - 24 * 3600000)!;
    if (Number(staleReviews.c) > 0) {
      alerts.push({ id: 'reports:stale', level: 'info', code: 'stale_reviews', title: 'تقارير بانتظار المراجعة', detail: `${staleReviews.c} تقرير مضى عليه أكثر من ٢٤ ساعة.`, at: now });
    }
    const order = { warn: 0, info: 1 } as Record<string, number>;
    alerts.sort((a, b) => (order[a.level] - order[b.level]) || (b.at - a.at));
    res.json({ alerts, generatedAt: now, date: today });
  });
  app.get('/api/idle-reports', auth, (req, res) => {
    const isAdmin = res.locals.user.role === 'admin';
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    let where = isAdmin ? '1=1' : 'idle_reports.user_id=?';
    const params: any[] = isAdmin ? [] : [res.locals.user.id];
    if (date) { try { const b = dayBounds(date, config.timezone); where += ' AND idle_reports.created_at>=? AND idle_reports.created_at<?'; params.push(b.start, b.end); } catch { res.status(400).json({ error: 'التاريخ غير صحيح.' }); return; } }
    if (isAdmin && typeof req.query.repId === 'string') { where += ' AND idle_reports.user_id=?'; params.push(req.query.repId); }
    const rows = store.all(`SELECT idle_reports.*, users.name AS repName FROM idle_reports JOIN users ON users.id=idle_reports.user_id WHERE ${where} ORDER BY idle_reports.created_at DESC LIMIT ?`, ...params, limit);
    res.json({ reports: rows.map(r => ({ id: r.id, userId: r.user_id, repName: r.repName, shiftId: r.shift_id, lat: r.lat, lng: r.lng, accuracy: r.accuracy, reason: r.reason, durationMinutes: r.duration_minutes, deviceId: r.device_id, createdAt: r.created_at })) });
  });
  app.post('/api/reps/:id/reset-device', adminOnly, (req, res) => {
    const user = store.get("SELECT * FROM users WHERE id=? AND role='rep'", String(req.params.id));
    if (!user) { res.status(404).json({ error: 'المهندس غير موجود.' }); return; }
    // A reset means the old phone may be lost. Revoke its sessions and close its shift before
    // clearing the binding; otherwise its still-valid token could reclaim the empty binding or
    // keep uploading locations into a shift the replacement phone just took over.
    store.transaction(() => {
      endShift(user.id);
      store.run('DELETE FROM sessions WHERE user_id=?', user.id);
      store.run('UPDATE users SET device_id=? WHERE id=?', '', user.id);
      store.run('DELETE FROM push_tokens WHERE user_id=?', user.id);
      store.audit(res.locals.user.id, 'rep.reset_device', { repId: user.id });
    });
    io.in(`user:${user.id}`).disconnectSockets(true);
    invalidateKpis(); broadcast();
    res.json({ ok: true });
  });
  /**
   * Replace a representative's password.
   *
   * The manager chooses every first password, and there is no email delivery in this
   * installation — so a forgotten password used to mean editing the database by hand while
   * the sign-in screen told the engineer to "ask the manager", who had no such button.
   * All of that account's sessions are dropped with the change.
   */
  const repPasswordSchema = z.object({ password: z.string().min(10).max(200) }).strict();
  app.post('/api/reps/:id/password', adminOnly, (req, res) => {
    const parsed = repPasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'كلمة المرور الجديدة قصيرة — ١٠ أحرف على الأقل.', code: 'PASSWORD_TOO_SHORT' }); return; }
    const user = store.get("SELECT * FROM users WHERE id=? AND role='rep'", String(req.params.id));
    if (!user) { res.status(404).json({ error: 'المهندس غير موجود.' }); return; }
    store.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(parsed.data.password), user.id);
    // A new password means every device signed in with the old one loses access at once.
    store.run('DELETE FROM sessions WHERE user_id=?', user.id);
    io.in(`user:${user.id}`).disconnectSockets(true);
    store.audit(res.locals.user.id, 'rep.password_reset', { repId: user.id });
    res.json({ ok: true });
  });
  // ---- CSV helpers: standard RFC-4180 CSV (UTF-8 with a BOM) for integrations and scripts.
  // Excel users get the .xlsx endpoints instead — a CSV is interpreted with the machine's
  // locale delimiter and encoding, which is exactly what made the register look broken.
  function csvCell(value: unknown): string {
    let text = String(value ?? '');
    // Excel and Google Sheets treat a leading = + - @ (or tab/CR) as a formula. Customer and
    // engineer names are typed by hand, so an exported register must never execute them.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }
  function csvDocument(header: string[], body: unknown[][]): string {
    return [header.map(csvCell).join(',')].concat(body.map(row => row.map(csvCell).join(','))).join('\r\n');
  }
  function sendCsv(res: { setHeader: (k: string, v: string) => void; send: (b: string) => void }, filename: string, header: string[], body: unknown[][]) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send('\uFEFF' + csvDocument(header, body));
  }
  // A real workbook is the reliable way to open Arabic data in Excel: the CSV delimiter and
  // the text encoding depend on the machine locale, so the same file looks fine on one PC and
  // like mojibake on another. .xlsx carries both inside the file.
  function sendXlsx(
    res: { setHeader: (k: string, v: string) => void; send: (b: Buffer) => void },
    filename: string, sheet: string, header: string[], body: CellValue[][], widths: number[],
  ) {
    const workbook = buildXlsx([header, ...body], { name: sheet, widths, headerRows: 1 });
    res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(workbook.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(workbook);
  }
  // Same order the dashboard shows: busiest engineer first, so the exported file matches
  // the table the manager is looking at.
  function byActivity<T extends { visits: number; dailyReports: number; reports: number; name: string }>(rows: T[]): T[] {
    return [...rows].sort((a, b) =>
      b.visits - a.visits || b.dailyReports - a.dailyReports || b.reports - a.reports || a.name.localeCompare(b.name, 'ar'));
  }
  /**
   * Activity days on the configured calendar, not UTC. A shift that ends after local midnight
   * used to add a phantom day: a 00:30 check-out is still 22:30 of the previous UTC date.
   * Buckets are 15 minutes wide so even half-hour offsets land on the right date.
   */
  const DAY_BUCKET_MS = 15 * 60000;
  function activeLocalDays(userId: string, start: number, end: number): number {
    const buckets = store.all(
      `SELECT MIN(recorded_at) AS at FROM locations WHERE user_id=? AND recorded_at>=? AND recorded_at<?
       GROUP BY recorded_at/${DAY_BUCKET_MS}`, userId, start, end,
    );
    const days = new Set<string>();
    for (const bucket of buckets) days.add(localDate(config.timezone, Number(bucket.at)));
    return days.size;
  }
  function kpiRows(from: string, to: string) {
    const start = dayBounds(from, config.timezone).start;
    const end = dayBounds(to, config.timezone).end;
    return store.all("SELECT * FROM users WHERE role='rep' ORDER BY name").map(rep => {
      const distance = rangeDistance(rep.id, start, end);
      const visits = store.get(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) AS closed,
        AVG(CASE WHEN status='closed' AND auto_closed=0 THEN duration_seconds END) AS avgDuration
        FROM visits WHERE user_id=? AND checked_in_at>=? AND checked_in_at<?`, rep.id, start, end)!;
      const reportsRow = store.get("SELECT COUNT(*) AS c, COALESCE(SUM(CASE WHEN type='collection' THEN amount ELSE 0 END),0) AS collected FROM reports WHERE user_id=? AND created_at>=? AND created_at<?", rep.id, start, end)!;
      // The daily report belongs to the day it *covers* (`report_date`), not the moment it was
      // sent. An engineer who writes Monday's form on Tuesday morning — or whose shift runs past
      // midnight — used to move that report into the next day, and a report sent on the 1st for
      // the 30th landed in the wrong row of the monthly register the company files.
      const dailyRow = store.get('SELECT COUNT(*) AS c FROM daily_reports WHERE user_id=? AND report_date>=? AND report_date<=?', rep.id, from, to)!;
      const daysWithData = activeLocalDays(rep.id, start, end);
      const lastRow = store.get('SELECT MAX(recorded_at) AS at FROM locations WHERE user_id=?', rep.id)!;
      return {
        repId: rep.id, name: rep.name, color: rep.color, region: rep.region, active: !!rep.active,
        distanceMeters: distance.meters, pointCount: distance.points,
        visits: Number(visits.total || 0), visitsCompleted: Number(visits.closed || 0),
        // `0` is a real average (a visit closed in the same second), not "no visits": testing
        // it for truthiness turned it into `null`, and the table printed "—" instead of "أقل من دقيقة".
        avgVisitSeconds: visits.avgDuration == null ? null : Math.round(Number(visits.avgDuration)),
        reports: Number(reportsRow.c || 0), collected: Number(reportsRow.collected || 0),
        dailyReports: Number(dailyRow.c || 0), daysWithData,
        lastFixAt: lastRow.at ? Number(lastRow.at) : null,
      };
    });
  }
  function kpiRowsFor(from: string, to: string) {
    const key = `${from}|${to}`;
    const hit = kpiCache.get(key);
    if (hit && Date.now() - hit.at < KPI_CACHE_MS) return hit.rows;
    const rows = kpiRows(from, to);
    if (kpiCache.size > 24) kpiCache.clear();
    kpiCache.set(key, { at: Date.now(), rows });
    return rows;
  }
  /**
   * With a year of fixes on disk a caller could ask for a decade in one request: the loop walks
   * it day by day and SQLite runs on the request thread, so one such call stalls the whole team.
   * The register only ever needs a month; a year is the ceiling.
   */
  const MAX_RANGE_DAYS = 366;
  function rangeTooLong(from: string, to: string): boolean {
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    return days > MAX_RANGE_DAYS;
  }
  const RANGE_ERROR = { error: `أقصى نطاق للتقارير ${MAX_RANGE_DAYS} يومًا. اختر فترة أقصر.`, code: 'RANGE_TOO_LARGE' };
  app.get('/api/kpis', adminOnly, (req, res) => {
    const today = localDate(config.timezone);
    const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : today;
    const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : from;
    try { dayBounds(from, config.timezone); dayBounds(to, config.timezone); } catch { res.status(400).json({ error: 'نطاق التواريخ غير صحيح.' }); return; }
    if (to < from) { res.status(400).json({ error: 'تاريخ النهاية قبل البداية.' }); return; }
    if (rangeTooLong(from, to)) { res.status(400).json(RANGE_ERROR); return; }
    res.json({ from, to, timezone: config.timezone, rows: kpiRowsFor(from, to) });
  });
  const KPI_HEADER = ['المهندس', 'المنطقة', 'أيام النشاط', 'عدد الزيارات', 'متوسط الزيارة (دقيقة)', 'المسافة (كم)', 'التقارير', 'التحصيل (ج.م)', 'التقارير اليومية'];
  const KPI_WIDTHS = [26, 18, 12, 14, 16, 12, 12, 14, 14];
  function kpiExportRows(from: string, to: string): CellValue[][] {
    return byActivity(kpiRowsFor(from, to)).map(r => [
      r.name, r.region, r.daysWithData, r.visits, r.avgVisitSeconds ? Math.round(r.avgVisitSeconds / 60) : 0,
      Number((r.distanceMeters / 1000).toFixed(1)), r.reports, r.collected, r.dailyReports,
    ]);
  }
  app.get('/api/kpis.csv', adminOnly, (req, res) => {
    const today = localDate(config.timezone);
    const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : today;
    const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : from;
    try { dayBounds(from, config.timezone); dayBounds(to, config.timezone); }
    catch { res.status(400).json({ error: 'نطاق التواريخ غير صحيح.' }); return; }
    if (to < from) { res.status(400).json({ error: 'تاريخ النهاية قبل البداية.' }); return; }
    if (rangeTooLong(from, to)) { res.status(400).json(RANGE_ERROR); return; }
    sendCsv(res, `elhelb-kpis-${from}_${to}.csv`, KPI_HEADER, kpiExportRows(from, to));
  });
  app.get('/api/kpis.xlsx', adminOnly, (req, res) => {
    const today = localDate(config.timezone);
    const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : today;
    const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : from;
    try {
      dayBounds(from, config.timezone); dayBounds(to, config.timezone);
      if (to < from) { res.status(400).json({ error: 'تاريخ النهاية قبل البداية.' }); return; }
      if (rangeTooLong(from, to)) { res.status(400).json(RANGE_ERROR); return; }
      sendXlsx(res, `elhelb-kpis-${from}_${to}.xlsx`, 'مؤشرات الأداء', KPI_HEADER, kpiExportRows(from, to), KPI_WIDTHS);
    } catch { res.status(400).json({ error: 'نطاق التواريخ غير صحيح.' }); }
  });
  /**
   * The two registers the dashboard shows but could not export.
   *
   * A manager who has to justify a month to the owner needs the visits themselves and the
   * justifications for standing still — not a screenshot of a scrolling list.
   */
  const VISIT_HEADER = ['التاريخ', 'المهندس', 'العميل', 'النوع', 'الدخول', 'الخروج', 'المدة (دقيقة)', 'النتيجة', 'ملاحظات', 'من غير شبكة', 'بدون نتيجة'];
  const VISIT_WIDTHS = [12, 22, 26, 12, 18, 18, 14, 40, 30, 12, 12];
  function visitExportRows(from: string, to: string): unknown[][] {
    const start = dayBounds(from, config.timezone).start;
    const end = dayBounds(to, config.timezone).end;
    const rows = store.all(`${VISIT_SELECT} WHERE v.checked_in_at>=? AND v.checked_in_at<? ORDER BY v.checked_in_at`, start, end);
    // Built once, not once per row: a year of visits is tens of thousands of rows, and each
    // `new Intl.DateTimeFormat` in the old loop cost tens of microseconds inside a request that
    // blocked the whole server (single process) for seconds.
    const clock = new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit', timeZone: config.timezone });
    return rows.map((row: any) => [
      localDate(config.timezone, Number(row.checkedInAt)),
      row.repName,
      row.customerName,
      row.purpose,
      clock.format(Number(row.checkedInAt)),
      row.checkedOutAt ? clock.format(Number(row.checkedOutAt)) : '',
      row.durationSeconds === null ? '' : Math.round(Number(row.durationSeconds) / 60),
      row.outcome,
      row.notes,
      Number(row.recordedOffline) ? 'نعم' : '',
      Number(row.pendingResult) ? 'نعم' : '',
    ]);
  }
  function exportRange(req: express.Request, res: express.Response, name: string, build: (from: string, to: string) => { header: string[]; rows: unknown[][]; widths?: number[] }) {
    const today = localDate(config.timezone);
    // A date that is there but unreadable is a mistake in the request, not an invitation to
    // export today's file: the manager would print the wrong register and never notice.
    const badDate = (value: unknown) => value !== undefined && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
    if (badDate(req.query.from) || badDate(req.query.to)) { res.status(400).json({ error: 'التاريخ بصيغة YYYY-MM-DD.' }); return; }
    const from = typeof req.query.from === 'string' ? req.query.from : today;
    const to = typeof req.query.to === 'string' ? req.query.to : from;
    let valid = true;
    try { dayBounds(from, config.timezone); dayBounds(to, config.timezone); } catch { valid = false; }
    if (!valid) { res.status(400).json({ error: 'نطاق التواريخ غير صحيح.' }); return; }
    if (to < from) { res.status(400).json({ error: 'تاريخ النهاية قبل البداية.' }); return; }
    if (rangeTooLong(from, to)) { res.status(400).json(RANGE_ERROR); return; }
    const table = build(from, to);
    if (name.endsWith('.xlsx')) {
      try { sendXlsx(res, `elhelb-${name.replace('.xlsx', '')}-${from}_${to}.xlsx`, 'السجل', table.header, table.rows as CellValue[][], table.widths ?? table.header.map(() => 16)); }
      catch { res.status(400).json({ error: 'نطاق التواريخ غير صحيح.' }); }
      return;
    }
    sendCsv(res, `elhelb-${name.replace('.csv', '')}-${from}_${to}.csv`, table.header, table.rows);
  }
  app.get('/api/visits.csv', adminOnly, (req, res) => {
    exportRange(req, res, 'visits.csv', (from, to) => ({ header: VISIT_HEADER, rows: visitExportRows(from, to), widths: VISIT_WIDTHS }));
  });
  app.get('/api/visits.xlsx', adminOnly, (req, res) => {
    exportRange(req, res, 'visits.xlsx', (from, to) => ({ header: VISIT_HEADER, rows: visitExportRows(from, to), widths: VISIT_WIDTHS }));
  });
  const IDLE_HEADER = ['التاريخ', 'المهندس', 'السبب', 'مدة السكون (دقيقة)'];
  app.get('/api/idle-reports.csv', adminOnly, (req, res) => {
    exportRange(req, res, 'idle-reports.csv', (from, to) => {
      const start = dayBounds(from, config.timezone).start;
      const end = dayBounds(to, config.timezone).end;
      const rows = store.all(`SELECT i.created_at AS createdAt, i.reason, i.duration_minutes AS minutes, u.name AS repName
        FROM idle_reports i JOIN users u ON u.id = i.user_id
        WHERE i.created_at>=? AND i.created_at<? ORDER BY i.created_at`, start, end);
      return {
        header: IDLE_HEADER,
        widths: [12, 22, 60, 16],
        rows: rows.map((row: any) => [
          localDate(config.timezone, Number(row.createdAt)), row.repName, row.reason, Number(row.minutes),
        ]),
      };
    });
  });
  // ---- Monthly register: visits + reports per month (international company requirement) ----
  function monthBounds(month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('الشهر بصيغة YYYY-MM');
    const [y, m] = month.split('-').map(Number);
    if (m < 1 || m > 12) throw new Error('الشهر غير صحيح');
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const from = `${month}-01`;
    const to = `${month}-${String(lastDay).padStart(2, '0')}`;
    const start = dayBounds(from, config.timezone).start;
    const end = dayBounds(to, config.timezone).end;
    return { from, to, start, end };
  }
  app.get('/api/monthly', adminOnly, (req, res) => {
    const month = typeof req.query.month === 'string' ? req.query.month : localDate(config.timezone).slice(0, 7);
    try {
      const { from, to } = monthBounds(month);
      const rows = byActivity(kpiRowsFor(from, to));
      res.json({ month, from, to, timezone: config.timezone, rows });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  const MONTHLY_HEADER = ['المهندس', 'المنطقة', 'الشهر', 'عدد الزيارات', 'مكتملة', 'متوسط الزيارة (دقيقة)', 'المسافة (كم)', 'التقارير الميدانية', 'التقارير اليومية', 'التحصيل (ج.م)'];
  const MONTHLY_WIDTHS = [26, 18, 10, 12, 10, 16, 12, 14, 14, 14];
  function monthlyExportRows(month: string, from: string, to: string): CellValue[][] {
    return byActivity(kpiRowsFor(from, to)).map(r => [
      r.name, r.region, month, r.visits, r.visitsCompleted, r.avgVisitSeconds ? Math.round(r.avgVisitSeconds / 60) : 0,
      Number((r.distanceMeters / 1000).toFixed(1)), r.reports, r.dailyReports, r.collected,
    ]);
  }
  app.get('/api/monthly.csv', adminOnly, (req, res) => {
    const month = typeof req.query.month === 'string' ? req.query.month : localDate(config.timezone).slice(0, 7);
    try {
      const { from, to } = monthBounds(month);
      sendCsv(res, `elhelb-monthly-${month}.csv`, MONTHLY_HEADER, monthlyExportRows(month, from, to));
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.get('/api/monthly.xlsx', adminOnly, (req, res) => {
    const month = typeof req.query.month === 'string' ? req.query.month : localDate(config.timezone).slice(0, 7);
    try {
      const { from, to } = monthBounds(month);
      sendXlsx(res, `elhelb-monthly-${month}.xlsx`, `سجل ${month}`, MONTHLY_HEADER, monthlyExportRows(month, from, to), MONTHLY_WIDTHS);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  // ---- Reports: the second core feature of the rep app ----
  app.post('/api/reports', repOnly, (req, res) => {
    const parsed = newReport.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'راجع بيانات التقرير: النوع والعنوان مطلوبان.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return; }
    const data = parsed.data;
    const shift = store.get('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', res.locals.user.id);
    const now = Date.now();
    const result = store.run(`INSERT OR IGNORE INTO reports(id,user_id,shift_id,type,title,body,customer,amount,lat,lng,accuracy,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'new',?)`, data.id, res.locals.user.id, shift?.id || null, data.type, data.title, data.body, data.customer, data.amount,
      data.location?.lat ?? null, data.location?.lng ?? null, data.location?.accuracy ?? null, now);
    if (result.changes) {
      store.audit(res.locals.user.id, 'report.create', { reportId: data.id, type: data.type });
      const report = reportRow(data.id);
      io.to('admins').emit('report', report);
      invalidateKpis(); broadcast();
    }
    res.status(result.changes ? 201 : 200).json({ report: reportRow(data.id), duplicate: !result.changes });
  });
  app.get('/api/reports', auth, (req, res) => {
    const isAdmin = res.locals.user.role === 'admin';
    const type = typeof req.query.type === 'string' && (REPORT_TYPES as readonly string[]).includes(req.query.type) ? req.query.type : undefined;
    const status = req.query.status === 'new' || req.query.status === 'reviewed' ? req.query.status : undefined;
    const repId = isAdmin && typeof req.query.repId === 'string' ? req.query.repId : undefined;
    const badDate = (value: unknown) => value !== undefined && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
    if (badDate(req.query.from) || badDate(req.query.to)) { res.status(400).json({ error: 'التاريخ بصيغة YYYY-MM-DD.' }); return; }
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    if (from && to && to < from) { res.status(400).json({ error: 'تاريخ النهاية قبل البداية.' }); return; }
    if ((from || to) && rangeTooLong(from ?? to!, to ?? from!)) { res.status(400).json(RANGE_ERROR); return; }
    try { for (const day of [from, to]) if (day) dayBounds(day, config.timezone); }
    catch { res.status(400).json({ error: 'التاريخ غير صحيح.' }); return; }
    const reports = listReports({ userId: isAdmin ? undefined : res.locals.user.id, type, status, repId, from, to });
    res.json({ reports });
  });
  app.get('/api/reports/:id', auth, (req, res) => {
    const report = reportRow(String(req.params.id));
    if (!report) { res.status(404).json({ error: 'التقرير غير موجود.' }); return; }
    if (res.locals.user.role !== 'admin' && report.userId !== res.locals.user.id) { res.status(403).json({ error: 'يمكنك عرض تقاريرك فقط.' }); return; }
    res.json({ report });
  });
  app.patch('/api/reports/:id', adminOnly, (req, res) => {
    const parsed = z.object({ status: z.literal('reviewed') }).strict().safeParse(req.body);
    const report = reportRow(String(req.params.id));
    if (!parsed.success || !report) { res.status(400).json({ error: 'بيانات التحديث غير صحيحة.' }); return; }
    if (report.status !== 'reviewed') {
      store.run("UPDATE reports SET status='reviewed', reviewed_at=? WHERE id=?", Date.now(), report.id);
      store.audit(res.locals.user.id, 'report.review', { reportId: report.id });
      notifyUser(report.userId, 'تمت مراجعة تقريرك', 'مدير المتابعة راجع تقريرك. افتح التطبيق لمراجعة حالته.', { type: 'report_reviewed', reportId: report.id });
      invalidateKpis(); broadcast();
    }
    res.json({ report: reportRow(String(req.params.id)) });
  });
  // ---- Daily engineer reports: one report per day with multiple visit rows ----
  app.post('/api/daily-reports', repOnly, (req, res) => {
    const parsed = newDailyReportSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'راجع بيانات التقرير اليومي: الاسم والتاريخ وزيارة واحدة على الأقل والتوقيع مطلوبة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return; }
    const data = parsed.data;
    try { validateReportDate(data.reportDate, config.timezone, config.retentionDays); }
    catch (e) { res.status(422).json({ error: (e as Error).message }); return; }
    const existing = store.get('SELECT user_id FROM daily_reports WHERE id=?', data.id);
    if (existing && existing.user_id !== res.locals.user.id) { res.status(409).json({ error: 'معرّف التقرير مستخدم بالفعل.' }); return; }
    // One paper form per engineer per day. A second send — a double tap, or a retry after the
    // first one was queued offline under a fresh id — used to create a second row, so the same
    // day counted twice in the monthly register and appeared twice for the manager.
    if (!existing) {
      const sameDay = store.get('SELECT id FROM daily_reports WHERE user_id=? AND report_date=?', res.locals.user.id, data.reportDate);
      if (sameDay) {
        res.status(409).json({ error: 'سبق إرسال تقرير لهذا اليوم. لو محتاج تعديله، كلّم مدير المتابعة.', code: 'DAILY_REPORT_EXISTS', reportId: sameDay.id }); return;
      }
    }
    const shift = store.get('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', res.locals.user.id);
    const now = Date.now();
    const duplicate = !!existing;
    if (!duplicate) insertDailyReport(store, res.locals.user.id, shift?.id || null, data, now, config.timezone);
    const report = dailyReportRow(store, data.id)!;
    if (!duplicate) {
      store.audit(res.locals.user.id, 'daily_report.create', { reportId: data.id, date: data.reportDate, visits: data.visits.length });
      io.to('admins').emit('daily-report', report);
      invalidateKpis(); broadcast();
    }
    res.status(duplicate ? 200 : 201).json({ report, duplicate });
  });
  app.get('/api/daily-reports', auth, (req, res) => {
    const isAdmin = res.locals.user.role === 'admin';
    const status = req.query.status === 'new' || req.query.status === 'reviewed' ? req.query.status : undefined;
    const repId = isAdmin && typeof req.query.repId === 'string' ? req.query.repId : undefined;
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : undefined;
    if (date) { try { validateReportDate(date, config.timezone, 3650); } catch { res.status(400).json({ error: 'التاريخ غير صحيح.' }); return; } }
    res.json({ reports: listDailyReports(store, { userId: isAdmin ? undefined : res.locals.user.id, repId, status, date, from, to }) });
  });
  app.get('/api/daily-reports/:id', auth, (req, res) => {
    const report = dailyReportRow(store, String(req.params.id));
    if (!report) { res.status(404).json({ error: 'التقرير غير موجود.' }); return; }
    if (res.locals.user.role !== 'admin' && report.userId !== res.locals.user.id) { res.status(403).json({ error: 'يمكنك عرض تقاريرك فقط.' }); return; }
    res.json({ report });
  });
  app.patch('/api/daily-reports/:id', adminOnly, (req, res) => {
    const parsed = z.object({ status: z.literal('reviewed') }).strict().safeParse(req.body);
    const report = dailyReportRow(store, String(req.params.id));
    if (!parsed.success || !report) { res.status(400).json({ error: 'بيانات التحديث غير صحيحة.' }); return; }
    if (report.status !== 'reviewed') {
      store.run("UPDATE daily_reports SET status='reviewed', reviewed_at=? WHERE id=?", Date.now(), report.id);
      store.audit(res.locals.user.id, 'daily_report.review', { reportId: report.id });
      notifyUser(report.userId, 'تمت مراجعة تقريرك اليومي', 'مدير المتابعة راجع تقرير اليوم. افتح التطبيق لمراجعة حالته.', { type: 'daily_report_reviewed', reportId: report.id });
      io.to('admins').emit('daily-report', dailyReportRow(store, report.id));
      invalidateKpis(); broadcast();
    }
    res.json({ report: dailyReportRow(store, report.id) });
  });
  app.get('/api/daily-reports/:id/pdf', auth, async (req, res) => {
    const report = dailyReportRow(store, String(req.params.id));
    if (!report) { res.status(404).json({ error: 'التقرير غير موجود.' }); return; }
    if (res.locals.user.role !== 'admin' && report.userId !== res.locals.user.id) { res.status(403).json({ error: 'يمكنك عرض تقاريرك فقط.' }); return; }
    try {
      const pdf = await dailyReportPdf(report, config.timezone);
      store.audit(res.locals.user.id, 'daily_report.pdf', { reportId: report.id });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="elhelb-daily-report-${report.reportDate}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(pdf);
    } catch (e) { console.error(e); res.status(500).json({ error: 'تعذر إنشاء ملف PDF.' }); return; }
  });
  // ---- Local Agent (بدون API خارجي) ----
  const { router: agentRouter } = createAgentRouter(store, config);
  app.use('/api/agent', auth, agentRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'المسار غير موجود.' }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error.type === 'entity.parse.failed') { res.status(400).json({ error: 'JSON غير صالح.' }); return; }
    if (error.type === 'entity.too.large') { res.status(413).json({ error: 'حجم الطلب أكبر من المسموح.' }); return; }
    console.error(error);
    res.status(500).json({ error: 'حدث خطأ في الخادم. حاول مرة أخرى.' });
  });
  store.cleanup(config.retentionDays);
  const cleanupTimer = setInterval(() => {
    const cleaned = runCleanup(store, config.retentionDays);
    dayStatsCache.clear();
    // A successful sweep may have erased old fixes (and their derived totals), so neither cache
    // may serve values computed before the retention boundary was applied.
    if (cleaned) { dayDistanceCache.clear(); invalidateKpis(); }
  }, 3600000);
  cleanupTimer.unref();
  async function close() {
    closing = true;
    clearInterval(cleanupTimer);
    if (broadcastTimer) clearTimeout(broadcastTimer);
    await new Promise<void>(resolve => io.close(() => resolve()));
    if (httpServer.listening) await new Promise<void>(resolve => httpServer.close(() => resolve()));
    store.close();
  }
  return { app, httpServer, io, store, config, close, overview };
}
