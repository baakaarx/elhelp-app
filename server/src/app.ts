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
import { classifySilence, LOW_BATTERY_PERCENT, PRESENT_FRESH_MS, stationaryMinutes } from './fieldStatus.js';
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
/**
 * While a visit is open the phone is indoors, where GPS routinely reports 150-400 m accuracy —
 * readings the app deliberately keeps off the trail. Held to the plain `STALE_GPS_MINUTES` that
 * looked like a dead phone, so a normal long meeting in a shop produced a false "انقطاع في إرسال
 * الموقع" for a manager who cannot tell the difference. Inside an open visit the silence is
 * expected for this many minutes before anyone is told to check on the engineer.
 */
const VISIT_STALE_LIMIT_MINUTES = 30;
const credentials = z.object({ email: z.email().max(254).transform(x => x.toLowerCase().trim()), password: z.string().min(1).max(200) });
const oauthLogin = z.object({
  provider: z.enum(['google', 'apple']),
  idToken: z.string().min(40).max(8192),
  /** Apple sends the person's name only on the first authorization, so the app forwards it. */
  name: z.string().trim().max(120).optional(),
});
/**
 * What a dashboard account may see: '' (manager, everything), 'sales' (the sales office) or
 * 'stock' (the warehouses only).
 *
 * This is deliberately a second axis next to users.role rather than two more values inside it.
 * role answers «which client signs in» — 'rep' for the phone, 'admin' for this dashboard — and it is
 * what the session cookie is named after and what X-Mandoub-Client is compared against; widening it
 * would mean rebuilding the users table for one CHECK clause and touching the login path. What a
 * person is allowed to read inside the dashboard is a different question, so it is a different column.
 *
 * Anything that is not one of the three known strings is treated as the manager. A half-applied
 * migration or a hand-edited row must never produce a dashboard that shows nothing.
 */
function dashScope(user: { role?: unknown; scope?: unknown } | undefined): 'manager' | 'sales' | 'stock' {
  const scope = String(user?.scope ?? '');
  if (scope === 'stock') return 'stock';
  if (scope === 'sales') return 'sales';
  return 'manager';
}

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
  /**
   * Set by a build that books the visit from the engineer's customer list. The name stays required
   * (an older app must keep working), but the stored row takes the master data's name and address so
   * one farm is never counted as two.
   */
  customerId: z.uuid().optional(),
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
  const authBase = requireAuth(store);
  const adminOnlyBase = requireAuth(store, 'admin');
  const repOnly = requireAuth(store, 'rep');
  /*
   * The warehouse account sees the warehouses and nothing else — and the guarantee lives here, in one
   * gate, not in an `if (isStock) return` added to each route a dashboard calls. Hiding tabs in the
   * interface would be decoration: the same session, from the browser console, could read
   * /api/overview and get every engineer's name, position and visits. With this shape, a route added
   * next month is closed to the warehouse account by default, and opening it has to be a decision
   * somebody writes down here.
   *
   * The gate wraps `auth` as well as `adminOnly`, and that is the part that matters. The customer
   * list is readable by engineers, so it is mounted on `auth` — and a warehouse account is an
   * administrator for sign-in purposes, so a gate that only wrapped the admin routes would have left
   * every customer name and phone number one fetch away. Test: «the warehouse account sees the
   * warehouses and nothing else».
   */
  // `/api/stock` already covers `/api/stock/report` by the prefix rule below — the monthly statement is
  // quantities, which is the warehouse clerk's own record. The value columns are dropped inside that
  // route for this scope, so a clerk who prints the sheet hands over counts and not a price list.
  const STOCK_ROUTES = ['/api/products', '/api/warehouses', '/api/stock', '/api/auth/me', '/api/auth/logout'];
  const stockAllowed = (path: string) => STOCK_ROUTES.some(route => path === route || path.startsWith(`${route}/`));
  function scopeGate(req: express.Request, res: express.Response, next: express.NextFunction) {
    const user = res.locals.user as { role?: string; scope?: string } | undefined;
    if (user?.role === 'admin' && dashScope(user) === 'stock' && !stockAllowed(req.path)) {
      res.status(403).json({ error: 'حساب المخازن بيشوف الأصناف والمخازن بس.', code: 'SCOPE_DENIED' });
      return;
    }
    next();
  }
  const auth = (req: express.Request, res: express.Response, next: express.NextFunction) => authBase(req, res, () => scopeGate(req, res, next));
  /*
   * The other half of the division the manager asked for: the sales office reads the shelves and
   * writes invoices, but the catalogue — what a product is called and what it costs — and the stock
   * movements are the warehouse's to write. It is enforced here and not by hiding buttons, because a
   * price typed from the wrong desk is the kind of disagreement that only surfaces at the end of the
   * month. The manager account keeps the override: somebody has to be able to fix a typo after the
   * warehouse clerk has gone home.
   */
  const catalogueOwnerOnly = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (dashScope(res.locals.user) === 'sales') {
      res.status(403).json({ error: 'الأسعار والحركات يسجّلها حساب المخازن — الحساب ده بيشوف بس.', code: 'STOCK_WRITE_ONLY' });
      return;
    }
    next();
  };
  const adminOnly = (req: express.Request, res: express.Response, next: express.NextFunction) => adminOnlyBase(req, res, () => scopeGate(req, res, next));
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
  const dayStatsCache = new Map<string, { day: string; computedAt: number; distanceMeters: number; pointCount: number; stationaryMinutes: number }>();
  // A month for the whole team is hundreds of thousands of fixes. The page, the CSV and the
  // workbook ask for the same rows seconds apart, so the result is reused — and any change the
  // manager could be looking for (a visit, a report, an account) clears it immediately.
  const KPI_CACHE_MS = 30000;
  const kpiCache = new Map<string, { at: number; rows: ReturnType<typeof kpiRows> }>();
  function invalidateKpis() { kpiCache.clear(); }
  // A leaked password list is replayed from many addresses, so the per-IP limiter alone is not
  // enough: too many failures on one account also freeze that account for a minute.
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
    const openShift = store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', user.id);
    /*
     * A finished shift used to make the card print «—» where the manager needs a time. The bare
     * dash reads as «مفيش بيانات وصلت», which is the opposite of what happened: the engineer
     * closed his day (or forgot to). The newest shift of the last day is reported with its state,
     * so «انتهت الوردية ٢:١٠ م» and «مفيش وردية النهارده» stay two different sentences.
     */
    const shift = openShift || store.get(
      'SELECT * FROM shifts WHERE user_id=? AND ended_at IS NOT NULL AND ended_at>=? ORDER BY ended_at DESC LIMIT 1',
      user.id, Date.now() - 24 * 3600000);
    const bounds = dayBounds(localDate(config.timezone), config.timezone);
    const day = localDate(config.timezone);
    let stats = dayStatsCache.get(user.id);
    if (!stats || stats.day !== day || Date.now() - stats.computedAt > 15000) {
      const points = store.all('SELECT lat,lng,accuracy,speed,recorded_at AS recordedAt FROM locations WHERE user_id=? AND recorded_at>=? AND recorded_at<? ORDER BY recorded_at, received_at', user.id, bounds.start, bounds.end) as unknown as GeoPoint[];
      stats = {
        day, computedAt: Date.now(), pointCount: points.length,
        distanceMeters: Math.round(distanceMeters(points)),
        // Same array, same walk: how long he has been sitting inside one spot. Cheap to add, and
        // it is the positive half of the story the outage alert only told backwards.
        stationaryMinutes: stationaryMinutes(points),
      };
      // One entry per engineer; the map is cleared hourly, and a hard cap keeps a long-lived
      // process from growing it without bound if accounts are created and removed often.
      if (dayStatsCache.size > 500) dayStatsCache.clear();
      dayStatsCache.set(user.id, stats);
    }
    const online = io.sockets.adapter.rooms.get(`user:${user.id}`)?.size ? true : !!user.last_seen && Date.now() - user.last_seen < 75000;
    const visitStats = store.get(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open FROM visits WHERE user_id=? AND checked_in_at>=? AND checked_in_at<?`, user.id, bounds.start, bounds.end);
    const openVisit = store.get("SELECT id, customer_name AS customerName, checked_in_at AS checkedInAt FROM visits WHERE user_id=? AND status='open' ORDER BY checked_in_at DESC LIMIT 1", user.id);
    /*
     * Every fix is supposed to carry the phone's battery, but two paths send none: the headless
     * background task (`trackingTask.ts` has no battery reading) and the shift-start point. Without
     * a fallback the card printed «—» and the low-battery warning went quiet for an engineer whose
     * phone was at ٦٪ ten minutes ago — so the newest *reading* is what gets reported, with its age.
     */
    const batteryRow = store.get('SELECT battery, recorded_at AS recordedAt FROM locations WHERE user_id=? AND battery IS NOT NULL AND recorded_at>=? ORDER BY recorded_at DESC, received_at DESC LIMIT 1',
      user.id, Date.now() - 24 * 3600000);
    const battery = batteryRow ? { percent: Number(batteryRow.battery), recordedAt: Number(batteryRow.recordedAt) } : null;
    return {
      ...publicUser(user), lastSeen: user.last_seen || null, online, tracking: !!openShift,
      // The team page shows when the engineer joined; without it the page printed "today".
      createdAt: user.created_at || null,
      shiftStartedAt: shift?.started_at || null,
      // `open` = the stopwatch is running; `ended` = the day was closed (recently), and the two
      // timestamps below are the proof; `none` = no shift at all in the last day.
      shiftState: openShift ? 'open' as const : shift ? 'ended' as const : 'none' as const,
      shiftEndedAt: !openShift && shift?.ended_at != null ? Number(shift.ended_at) : null,
      location: location ? { lat: location.lat, lng: location.lng, accuracy: location.accuracy, speed: location.speed, heading: location.heading, battery: location.battery, recordedAt: location.recorded_at, receivedAt: location.receivedAt, source: location.source } : null,
      // The newest battery reading, whatever fix it rode in on — see the note above.
      battery,
      distanceMeters: stats.distanceMeters, pointCount: stats.pointCount,
      visitsToday: Number(visitStats?.total || 0), openVisit: openVisit || null,
      stationaryMinutes: stats.stationaryMinutes,
      // The window the map should call "لا إشارة" for this engineer: a visit in progress widens it,
      // exactly as /api/alerts does. Shipped per rep so the two screens cannot drift apart.
      staleLimitMinutes: openVisit ? Math.max(config.staleGpsMinutes, VISIT_STALE_LIMIT_MINUTES) : config.staleGpsMinutes,
      // Classified here, not in the browser: only the server has both the silence length and the
      // last time this phone reached the API, and the map must not invent its own verdict.
      gap: {
        kind: classifySilence({
          silenceMs: location ? Date.now() - Number(location.recorded_at) : Number.POSITIVE_INFINITY,
          limitMs: (openVisit ? Math.max(config.staleGpsMinutes, VISIT_STALE_LIMIT_MINUTES) : config.staleGpsMinutes) * 60000,
          presenceMs: user.last_seen ? Date.now() - Number(user.last_seen) : Number.POSITIVE_INFINITY,
        }),
        silenceMinutes: location ? Math.max(0, Math.round((Date.now() - Number(location.recorded_at)) / 60000)) : null,
        battery: battery?.percent ?? null,
      },
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
  const VISIT_SELECT = `SELECT v.id, v.user_id AS userId, v.customer_name AS customerName, v.customer_id AS customerId, v.governorate, v.district,
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
    /*
     * The live feed is the whole field — names, positions, visits — so joining it cannot be decided
     * by role alone: the warehouse account is an 'admin' for sign-in purposes and must not receive
     * it. Left as it was, the scope gate on /api would be decoration, because the socket would push
     * the data without ever being asked.
     */
    if (dashScope(user) === 'stock') socket.join('stock');
    else if (user.role === 'admin') { socket.join('admins'); socket.emit('overview', overview()); }
    else socket.emit('shift', store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', user.id) || null);
    invalidateKpis(); broadcast();
    socket.on('disconnect', broadcast);
  });

  app.get('/api/health', (_req, res) => { res.json({ ok: true, timezone: config.timezone, retentionDays: config.retentionDays, consentVersion: CONSENT_VERSION, staleGpsMinutes: config.staleGpsMinutes, idleReasonMinutes: config.idleReasonMinutes }); });
  app.post('/api/auth/login', rateLimit({ ...config.loginRateLimit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'محاولات دخول كثيرة. انتظر دقيقة.' } }), (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'أدخل بريدًا إلكترونيًا صحيحًا وكلمة مرور.' }); return; }
    if (loginIsFrozen(parsed.data.email)) {
      res.status(429).json({ error: 'محاولات دخول كثيرة على هذا الحساب. انتظر دقيقة أو اطلب من مدير المتابعة تغيير كلمة المرور.', code: 'ACCOUNT_THROTTLED' }); return;
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
  app.post('/api/auth/oauth', rateLimit({ ...config.loginRateLimit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'محاولات دخول كثيرة. انتظر دقيقة.' } }), async (req, res) => {
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
  /**
   * What removing an engineer would erase, counted before anyone clicks.
   *
   * A delete button that says «متأكد؟» without saying how much it takes is a button that gets
   * clicked by accident. The register is the company's record of the field, so the manager is
   * shown the shifts, fixes, visits and reports that live under this account first.
   */
  app.get('/api/reps/:id/impact', adminOnly, (req, res) => {
    const user = store.get("SELECT id, name, email, active FROM users WHERE id=? AND role='rep'", String(req.params.id));
    if (!user) { res.status(404).json({ error: 'المهندس غير موجود.' }); return; }
    const count = (sql: string, ...params: any[]) => Number(store.get(sql, ...params)?.c || 0);
    const openShift = store.get('SELECT started_at FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', user.id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      name: user.name, email: user.email,
      shifts: count('SELECT COUNT(*) AS c FROM shifts WHERE user_id=?', user.id),
      locations: count('SELECT COUNT(*) AS c FROM locations WHERE user_id=?', user.id),
      visits: count('SELECT COUNT(*) AS c FROM visits WHERE user_id=?', user.id),
      openVisits: count("SELECT COUNT(*) AS c FROM visits WHERE user_id=? AND status='open'", user.id),
      reports: count('SELECT COUNT(*) AS c FROM reports WHERE user_id=?', user.id),
      dailyReports: count('SELECT COUNT(*) AS c FROM daily_reports WHERE user_id=?', user.id),
      idleReports: count('SELECT COUNT(*) AS c FROM idle_reports WHERE user_id=?', user.id),
      trackingNow: !!openShift,
    });
  });
  /**
   * The manager's erasure button: a test account left over from setup, or an engineer whose data
   * has to leave with the phone he no longer holds.
   *
   * `confirm` is required so a stale page or a replayed request cannot do this on its own. Every
   * table holding his field data references `users(id) ON DELETE CASCADE` (`server/src/db.ts`),
   * so the one row takes shifts, fixes, visits, reports and justifications with it — the same set
   * the phone's own right-to-erasure path removes, which is why there is no half-deleting variant
   * here: «أوقف الحساب» (`active=0`) stays the option that keeps the register.
   *
   * The audit row survives on purpose, and holds the account id and the counts, not his name or
   * address: that a deletion happened is a fact about the installation, not personal data.
   */
  const deleteRepSchema = z.object({ confirm: z.literal(true) }).strict();
  app.delete('/api/reps/:id', adminOnly, (req, res) => {
    const parsed = deleteRepSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'أكّد الحذف قبل تنفيذها.', code: 'CONFIRM_REQUIRED' }); return; }
    const user = store.get("SELECT * FROM users WHERE id=? AND role='rep'", String(req.params.id));
    if (!user) {
      // An address that exists but is not an engineer is a wrong click, not a missing account.
      const other = store.get('SELECT role FROM users WHERE id=?', String(req.params.id));
      res.status(other ? 409 : 404).json({
        error: other ? 'حسابات المديرين لا تُحذف من لوحة الفريق — احذفها من إعداد السيرفر.' : 'المهندس غير موجود.',
        code: other ? 'NOT_A_REP' : 'REP_NOT_FOUND',
      });
      return;
    }
    const removed = {
      shifts: Number(store.get('SELECT COUNT(*) AS c FROM shifts WHERE user_id=?', user.id)?.c || 0),
      visits: Number(store.get('SELECT COUNT(*) AS c FROM visits WHERE user_id=?', user.id)?.c || 0),
      reports: Number(store.get('SELECT COUNT(*) AS c FROM reports WHERE user_id=?', user.id)?.c || 0),
      dailyReports: Number(store.get('SELECT COUNT(*) AS c FROM daily_reports WHERE user_id=?', user.id)?.c || 0),
    };
    store.transaction(() => {
      // Stop the stopwatch before the row goes: a shift left open for a deleted account would keep
      // the cleanup sweeping an id nobody can sign in with any more.
      endShift(user.id);
      store.run('DELETE FROM sessions WHERE user_id=?', user.id);
      store.run('DELETE FROM users WHERE id=?', user.id);
      store.run('INSERT INTO audit_log(user_id,action,created_at,metadata) VALUES (?,?,?,?)',
        String(res.locals.user.id), 'rep.delete', Date.now(), JSON.stringify({ repId: user.id, ...removed }));
    });
    io.in(`user:${user.id}`).disconnectSockets(true);
    invalidateDistanceForUser(String(user.id));
    invalidateKpis(); broadcast();
    res.json({ ok: true, removed });
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
    // The phone polls this every fifteen seconds while the app is open, so the poll is already a
    // liveness ping: it proves the device reached the server even when it could not produce a fix.
    // Read it as presence rather than adding a new endpoint (and a new timer to the app), and stamp
    // at most once per 20 s so a chatty client cannot turn every poll into a write.
    const seenAt = Date.now();
    if (seenAt - Number(res.locals.user.last_seen || 0) > 20000) store.run('UPDATE users SET last_seen=? WHERE id=?', seenAt, res.locals.user.id);
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
  /* ── Customers: the list each engineer owns, and the register every visit hangs on ─────────
     Until now a customer was a free-text field on a visit, so «مزرعة النور» and «النور» were two
     different people to every count and every export, and there was no such thing as «عملاء
     المهندس ده». This table is the master data: the engineer fills his own list, the manager can
     see and move it, and everything sales-shaped (visits today, invoices next) points at it. */
  const CUSTOMER_STAGES = ['new', 'following', 'active', 'dormant', 'lost'] as const;
  type CustomerStage = (typeof CUSTOMER_STAGES)[number];
  const customerFields = z.object({
    name: z.string().trim().min(2, 'اسم العميل / المزرعة مطلوب.').max(120),
    phone: z.string().trim().max(30).default(''),
    governorate: z.string().trim().max(80).default(''),
    district: z.string().trim().max(80).default(''),
    village: z.string().trim().max(120).default(''),
    notes: z.string().trim().max(1000).default(''),
    stage: z.enum(CUSTOMER_STAGES).default('new'),
    lostReason: z.string().trim().max(300).default(''),
    /** The address, when it was pinned on the map. Both halves or neither: a lone latitude is a bug. */
    lat: z.number().finite().min(-90).max(90).nullish(),
    lng: z.number().finite().min(-180).max(180).nullish(),
  });
  // `repId` only means anything on create: an engineer's own POST is signed for one list, a manager
  // has to say which engineer is getting the customer. It is added before `.strict()`, not after —
  // a strict flag frozen on the base object rejects the keys the extension brings with it.
  const newCustomer = customerFields.extend({ repId: z.uuid().optional() }).strict();
  const patchCustomer = customerFields.partial().extend({ active: z.boolean().optional() }).strict();
  const addressError = (data: { lat?: number | null | undefined; lng?: number | null | undefined }) =>
    (data.lat == null) !== (data.lng == null) ? 'لازم خط الطول والعرض مع بعض.' : '';

  const CUSTOMER_SELECT = `SELECT c.*, u.name AS repName, u.color AS repColor,
      (SELECT COUNT(*) FROM visits v WHERE v.customer_id=c.id) AS visitCount,
      (SELECT MAX(v.checked_in_at) FROM visits v WHERE v.customer_id=c.id) AS lastVisitAt,
      (SELECT COUNT(*) FROM visits v WHERE v.customer_id=c.id AND v.status='open') AS openVisits
    FROM customers c JOIN users u ON u.id=c.rep_id`;
  const asCustomer = (row: Record<string, any> | undefined) => row ? ({
    id: row.id, repId: row.rep_id, name: row.name, phone: row.phone,
    governorate: row.governorate, district: row.district, village: row.village, notes: row.notes,
    lat: row.lat ?? null, lng: row.lng ?? null,
    stage: row.stage, lostReason: row.lost_reason, active: !!row.active,
    createdAt: row.created_at, updatedAt: row.updated_at,
    repName: row.repName, repColor: row.repColor,
    visitCount: Number(row.visitCount || 0), lastVisitAt: row.lastVisitAt ?? null, openVisits: Number(row.openVisits || 0),
  }) : undefined;

  app.get('/api/customers', auth, (req, res) => {
    const isAdmin = res.locals.user.role === 'admin';
    const where: string[] = []; const params: any[] = [];
    // An engineer never queries his way into a colleague's list; a manager can look at anyone.
    if (!isAdmin) { where.push('c.rep_id=?'); params.push(res.locals.user.id); }
    else if (typeof req.query.repId === 'string' && req.query.repId) { where.push('c.rep_id=?'); params.push(req.query.repId); }
    if (!isAdmin || req.query.includeInactive !== '1') where.push('c.active=1');
    const stage = CUSTOMER_STAGES.includes(String(req.query.stage) as CustomerStage) ? String(req.query.stage) : '';
    if (stage) { where.push('c.stage=?'); params.push(stage); }
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    if (q) { where.push('(c.name LIKE ? OR c.phone LIKE ? OR c.village LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 300));
    const rows = store.all(`${CUSTOMER_SELECT} WHERE ${where.length ? where.join(' AND ') : '1=1'}
      ORDER BY c.name COLLATE NOCASE LIMIT ?`, ...params, limit) as Array<Record<string, any>>;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ customers: rows.map(row => asCustomer(row)!) });
  });

  app.post('/api/customers', auth, (req, res) => {
    const parsed = newCustomer.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات العميل غير صحيحة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) });
      return;
    }
    if (addressError(parsed.data)) { res.status(400).json({ error: addressError(parsed.data), code: 'ADDRESS_INCOMPLETE' }); return; }
    const isAdmin = res.locals.user.role === 'admin';
    // A manager creating a customer has to say who owns him; an engineer always means himself.
    const repId = isAdmin ? String(parsed.data.repId || '') : String(res.locals.user.id);
    if (isAdmin && !repId) { res.status(400).json({ error: 'اختار المهندس اللي العميل ده بتاعه.', code: 'REP_REQUIRED' }); return; }
    const owner = store.get("SELECT id, name FROM users WHERE id=? AND role='rep' AND active=1", repId);
    if (!owner) { res.status(404).json({ error: 'المهندس غير موجود أو حسابه متوقف.' }); return; }
    const now = Date.now();
    const id = randomUUID();
    try {
      store.run(`INSERT INTO customers(id,rep_id,name,phone,governorate,district,village,notes,lat,lng,stage,lost_reason,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, repId, parsed.data.name, parsed.data.phone, parsed.data.governorate, parsed.data.district, parsed.data.village,
      parsed.data.notes, parsed.data.lat ?? null, parsed.data.lng ?? null, parsed.data.stage, parsed.data.lostReason, now, now);
    } catch (error) {
      // The unique index is the whole point: a duplicated customer is a duplicated sales figure.
      if (String((error as Error).message).includes('UNIQUE')) {
        res.status(409).json({
          error: `«${parsed.data.name}» موجود في قايمتة بالفعل — عدّل السطر الموجود بدل إضافة نسخة.`,
          code: 'CUSTOMER_EXISTS',
        });
        return;
      }
      throw error;
    }
    store.audit(res.locals.user.id, 'customer.create', { customerId: id, repId });
    invalidateKpis(); broadcast();
    res.status(201).json({ customer: asCustomer(store.get(`${CUSTOMER_SELECT} WHERE c.id=?`, id)) });
  });

  /** The engineer owns his list; a manager owns all of them. Nobody edits a colleague's customer. */
  function loadCustomerForWrite(req: express.Request, res: express.Response) {
    const row = store.get(`${CUSTOMER_SELECT} WHERE c.id=?`, String(req.params.id)) as Record<string, any> | undefined;
    if (!row) { res.status(404).json({ error: 'العميل غير موجود.', code: 'CUSTOMER_NOT_FOUND' }); return undefined; }
    if (res.locals.user.role !== 'admin' && String(row.rep_id) !== String(res.locals.user.id)) {
      res.status(403).json({ error: 'تقدر تعدّل عملاءك إنت بس.' }); return undefined;
    }
    return row;
  }

  app.patch('/api/customers/:id', auth, (req, res) => {
    const current = loadCustomerForWrite(req, res);
    if (!current) return;
    const parsed = patchCustomer.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات العميل غير صحيحة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) });
      return;
    }
    const merged = { ...current, ...parsed.data };
    if (addressError(parsed.data)) { res.status(400).json({ error: addressError(parsed.data), code: 'ADDRESS_INCOMPLETE' }); return; }
    // «مرفوض» without a reason is how a lost customer becomes nobody's mistake.
    if (parsed.data.stage === 'lost' && !String(parsed.data.lostReason ?? current.lost_reason ?? '').trim()) {
      res.status(400).json({ error: 'اكتب سبب رفض العميل قبل ما تقفله.', code: 'LOST_REASON_REQUIRED' }); return;
    }
    try {
      store.run(`UPDATE customers SET name=?, phone=?, governorate=?, district=?, village=?, notes=?, lat=?, lng=?, stage=?, lost_reason=?, active=?, updated_at=?
        WHERE id=?`,
      String(merged.name).trim(), merged.phone ?? '', merged.governorate ?? '', merged.district ?? '', merged.village ?? '',
      merged.notes ?? '', merged.lat ?? null, merged.lng ?? null, merged.stage, merged.lostReason ?? '',
      parsed.data.active === undefined ? current.active : (parsed.data.active ? 1 : 0), Date.now(), current.id);
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) {
        res.status(409).json({ error: `«${String(merged.name).trim()}» موجود في قايمتة بالفعل — ادمج العميلين الأول.`, code: 'CUSTOMER_EXISTS' });
        return;
      }
      throw error;
    }
    store.audit(res.locals.user.id, 'customer.update', { customerId: current.id, fields: Object.keys(parsed.data) });
    invalidateKpis(); broadcast();
    res.json({ customer: asCustomer(store.get(`${CUSTOMER_SELECT} WHERE c.id=?`, current.id)) });
  });

  /**
   * Move an engineer's customers to another engineer — the other half of stopping an account.
   *
   * Without this, «the man travelled» means the list and its history are orphaned on a closed
   * login. The visits are left attached to the customer row, so the new owner inherits the whole
   * relationship, and the old owner keeps credit for the visits he made (they stay his rows).
   */
  app.post('/api/customers/:id/assign', adminOnly, (req, res) => {
    const parsed = z.object({ repId: z.uuid() }).strict().safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'اختار المهندس الجديد.' }); return; }
    const customer = store.get('SELECT id, rep_id AS repId, name FROM customers WHERE id=?', String(req.params.id)) as { id: string; repId: string; name: string } | undefined;
    if (!customer) { res.status(404).json({ error: 'العميل غير موجود.' }); return; }
    const owner = store.get("SELECT id, name FROM users WHERE id=? AND role='rep' AND active=1", parsed.data.repId);
    if (!owner) { res.status(409).json({ error: 'المهندس الجديد غير موجود أو حسابه متوقف.' }); return; }
    if (String(customer.repId) === String(owner.id)) { res.json({ ok: true, unchanged: true }); return; }
    // A name collision in the new owner's list is the one case the unique index will refuse, and
    // it has to be said in those words — not as a database error.
    if (store.get('SELECT id FROM customers WHERE rep_id=? AND name COLLATE NOCASE=?', owner.id, customer.name)) {
      res.status(409).json({ error: `«${customer.name}» موجود عند ${owner.name} بالفعل — ادمج العميلين الأول.`, code: 'CUSTOMER_EXISTS' }); return;
    }
    store.run('UPDATE customers SET rep_id=?, updated_at=? WHERE id=?', owner.id, Date.now(), customer.id);
    store.audit(res.locals.user.id, 'customer.assign', { customerId: customer.id, from: customer.repId, to: owner.id });
    invalidateKpis(); broadcast();
    res.json({ ok: true, customer: asCustomer(store.get(`${CUSTOMER_SELECT} WHERE c.id=?`, customer.id)) });
  });

  /**
   * Remove a customer. Only when nothing was ever booked against him: the moment a visit points at
   * the row, deleting it would delete the only record that the customer exists, and the manager's
   * register would quietly shrink. Stop him (`active=0`) instead — he leaves the lists and stays
   * in the history.
   */
  app.delete('/api/customers/:id', adminOnly, (req, res) => {
    const customer = store.get('SELECT id, name, rep_id AS repId FROM customers WHERE id=?', String(req.params.id)) as { id: string; name: string; repId: string } | undefined;
    if (!customer) { res.status(404).json({ error: 'العميل غير موجود.' }); return; }
    const linked = Number(store.get('SELECT COUNT(*) AS c FROM visits WHERE customer_id=?', customer.id)?.c || 0);
    if (linked) {
      res.status(409).json({
        error: `«${customer.name}» عليه ${linked} زيارة مسجلة — وقّفه بدل الحذف، والسجل يفضل.`,
        code: 'CUSTOMER_HAS_VISITS', linked,
      });
      return;
    }
    store.run('DELETE FROM customers WHERE id=?', customer.id);
    store.audit(res.locals.user.id, 'customer.delete', { customerId: customer.id, repId: customer.repId });
    invalidateKpis(); broadcast();
    res.json({ ok: true });
  });

  // ---- Sales: the catalogue, the warehouses, the stock ledger, the invoices ----
  /*
   * The sales office writes invoices from this dashboard; the engineer in the field reads them.
   * Four rules hold the whole thing together, and all four are enforced here rather than in the
   * interface, because the interface is the part a determined or buggy client can edit:
   *
   *   1. Money is never trusted from a client. Line totals, the subtotal and the invoice total are
   *      recomputed from qty × unit_price on the server, so a browser that posts a friendly total
   *      gets the arithmetic, not the message.
   *   2. Stock is the sum of the ledger. Recording an invoice writes the outgoing movements in the
   *      same transaction, so there is no moment where a sale exists and the warehouse never heard
   *      about it — and no half-written invoice if the second statement fails.
   *   3. Selling more than the shelf holds is allowed and flagged (stock_short), because the goods
   *      really left. Refusing the invoice would only make the register disagree with the trucks.
   *   4. An invoice is voided with a reason, never deleted, and the void is itself a ledger row.
   *      A hole in the number series is what makes somebody ask questions five years from now.
   */
  const money = (value: number) => Math.round(Number(value) * 100) / 100;
  const notifyStock = () => io.to('stock').emit('stock:changed', { at: Date.now() });

  const warehouseFields = z.object({
    name: z.string().trim().min(2, 'اسم المخزن مطلوب.').max(80),
    governorate: z.string().trim().max(80).default(''),
    district: z.string().trim().max(80).default(''),
    notes: z.string().trim().max(300).default(''),
  });
  const newWarehouse = warehouseFields;
  const patchWarehouse = warehouseFields.partial().extend({ active: z.boolean().optional() });

  const productFields = z.object({
    name: z.string('اكتب اسم المنتج.').trim().min(2, 'اسم المنتج مطلوب.').max(120),
    // Required, with no fallback: «كرتونة» as a default was a wrong unit waiting to happen, and the
    // unit is what the price means. A pesticide at ٢٤ for the عبوة is not ٢٤٠ for the كرتونة.
    unit: z.string('اكتب الوحدة — السعر لازم يكون لوحدة واحدة واضحة (عبوة، شيكارة، جركن، كرتونة).')
      .trim().min(1, 'اكتب الوحدة — السعر لازم يكون لوحدة واحدة واضحة.').max(20),
    // The price lives on the catalogue, written by the warehouse account. A phone never carries a
    // price list, so there is exactly one number to argue about. Required on create, too: a price that
    // defaults to zero is an invoice that sells the goods for free the first time anybody tries.
    defaultPrice: z.number('اكتب سعر الوحدة — من غير سعر الفاتورة هتتباع ببلاش.').finite().min(0, 'سعر الوحدة لازم يكون رقم صحيح.').max(1e9),
    notes: z.string().trim().max(300).default(''),
  });
  const newProduct = productFields;
  /**
   * A patch is written from scratch rather than `productFields.partial()`: the create schema gives
   * `defaultPrice` and `notes` defaults, and a default that fires on a PATCH request is an overwrite —
   * «just change the price» would blank the note and zero nothing only because the form happened to
   * send every field. Here an absent key stays absent, and the route writes only what arrived.
   */
  const patchProduct = z.object({
    name: z.string().trim().min(2, 'اسم المنتج مطلوب.').max(120),
    unit: productFields.shape.unit,
    defaultPrice: z.number().finite().min(0).max(1e9),
    notes: z.string().trim().max(300),
    active: z.boolean(),
  }).partial().strict();

  const newMovement = z.object({
    productId: z.uuid(), warehouseId: z.uuid(),
    // 'sale' is missing on purpose: a sale is written by an invoice, and a warehouse account that
    // could post one by hand could invent revenue. 'opening' is a receipt with a note.
    kind: z.enum(['receipt', 'return', 'count', 'writeoff']),
    qty: z.number().finite().positive().max(1e6),
    note: z.string().trim().max(300).default(''),
    /** Manager only: «this actually happened on that day». See the route for what it takes to honour that. */
    at: z.number().int().positive().optional(),
  }).strict();

  const newInvoice = z.object({
    customerId: z.uuid(),
    /** Required for the office; an engineer in the field may leave it out and get the warehouse of his customer's area. */
    warehouseId: z.uuid().optional(),
    /** The engineer the sale belongs to. Defaults to whoever owns the customer. */
    repId: z.uuid().optional(),
    invoiceDate: z.number().int().positive().optional(),
    discount: z.number().finite().min(0).max(1e9).default(0),
    paidAmount: z.number().finite().min(0).max(1e12).default(0),
    note: z.string().trim().max(500).default(''),
    lines: z.array(z.object({
      productId: z.uuid(),
      qty: z.number().finite().positive().max(1e6),
      /** Blank means «whatever the catalogue says today»; the number is then copied into the line. */
      unitPrice: z.number().finite().min(0).max(1e9).optional(),
    }).strict()).min(1, 'الفاتورة محتاجة سطر واحد على الأقل.').max(200),
  }).strict();
  const patchInvoice = z.object({
    paidAmount: z.number().finite().min(0).max(1e12).optional(),
    note: z.string().trim().max(500).optional(),
  }).strict();

  /** A customer's balance is what feeds the collection visit, so the three words come from the numbers. */
  function paymentStatus(total: number, paid: number): 'unpaid' | 'partial' | 'paid' {
    if (paid >= money(total) - 0.005) return 'paid';
    return paid > 0 ? 'partial' : 'unpaid';
  }

  function onHand(warehouseId: string, productId: string): number {
    return money(Number(store.get('SELECT COALESCE(SUM(qty),0) AS q FROM stock_movements WHERE warehouse_id=? AND product_id=?', warehouseId, productId)?.q || 0));
  }

  const INVOICE_SELECT = `SELECT i.*, u.name AS repName, u.color AS repColor, c.name AS customerNameFromList, w.name AS warehouseName,
    (SELECT x.role FROM users x WHERE x.id=i.created_by) AS authorRole
    FROM invoices i
    LEFT JOIN users u ON u.id=i.rep_id
    LEFT JOIN customers c ON c.id=i.customer_id
    LEFT JOIN warehouses w ON w.id=i.warehouse_id`;
  const asInvoice = (row: Record<string, any> | undefined) => row ? ({
    id: row.id, number: row.number, customerId: row.customer_id, customerName: row.customer_name,
    repId: row.rep_id, repName: row.repName ?? 'بدون مهندس', repColor: row.repColor ?? '#94a3b8',
    warehouseId: row.warehouse_id, warehouseName: row.warehouseName ?? '',
    invoiceDate: row.invoice_date, date: localDate(config.timezone, Number(row.invoice_date)),
    subtotal: money(row.subtotal), discount: money(row.discount), total: money(row.total),
    paidAmount: money(row.paid_amount), status: row.status, stockShort: !!row.stock_short,
    note: row.note, voided: !!row.voided, voidReason: row.void_reason, voidedAt: row.voided_at ?? null,
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    /**
     * Who typed the invoice: the engineer standing at the farm, or the office. The sale is credited
     * to `repId` either way — this only says where the numbers came from, which is the difference
     * between «he sold it» and «he sold it and he booked it himself», and the one thing the office
     * needs to see when a paper note arrives two days late.
     */
    source: row.authorRole === 'rep' ? 'field' : 'dashboard',
  }) : undefined;

  /**
   * One row per recorded collection. Written wherever a paid amount moves — the office recording what
   * it banked, and the engineer typing what he took at the farm — so the collection report reads a
   * register instead of re-summing invoices, and so a manager can see the two hands that touch the
   * same cash: `repId` is whose money it is, `by` is who typed it.
   */
  function recordCollection(args: { invoiceId: string; customerId?: string | null; repId?: string | null; by: string; amount: number; note: string; source: 'office' | 'field' }) {
    const delta = money(args.amount);
    // Zero is not a collection. Logging it would let a note edit on an invoice add an empty row to the
    // month's total — which is exactly the kind of noise that makes a report stop being trustworthy.
    if (!Number.isFinite(delta) || delta === 0) return;
    store.run(`INSERT INTO collection_events(id,invoice_id,customer_id,rep_id,recorded_by,amount,source,note,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      randomUUID(), args.invoiceId, args.customerId ?? null, args.repId ?? null, args.by, delta, args.source, args.note, Date.now());
  }

  /**
   * The month key a target is filed under, in the installation's own timezone — the same clock the
   * dashboard's dates use, so a target saved on the 31st at 11 p.m. belongs to the month the manager
   * is looking at and not to the one UTC already rolled into.
   */
  function monthKey(at: number = Date.now()): string {
    return localDate(config.timezone, at).slice(0, 7);
  }

  function invoiceLines(invoiceId: string) {
    return store.all(`SELECT l.*, (SELECT COALESCE(SUM(m.qty),0) FROM stock_movements m WHERE m.product_id=l.product_id) AS stockAll
      FROM invoice_lines l WHERE l.invoice_id=? ORDER BY l.position, l.rowid`, invoiceId).map((row: Record<string, any>) => ({
      id: row.id, productId: row.product_id, productName: row.product_name, unit: row.unit,
      qty: Number(row.qty), unitPrice: money(row.unit_price), lineTotal: money(row.line_total),
    }));
  }

  // ---- Warehouses ----
  app.get('/api/warehouses', adminOnly, (req, res) => {
    const includeInactive = req.query.includeInactive === '1';
    const rows = store.all(`SELECT w.*,
        (SELECT COUNT(DISTINCT m.product_id) FROM stock_movements m WHERE m.warehouse_id=w.id) AS productCount,
        (SELECT COUNT(*) FROM invoices i WHERE i.warehouse_id=w.id AND i.voided=0) AS invoiceCount
      FROM warehouses w ${includeInactive ? '' : 'WHERE w.active=1'} ORDER BY w.name COLLATE NOCASE`) as Array<Record<string, any>>;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ warehouses: rows.map((row: Record<string, any>) => ({
      id: row.id, name: row.name, governorate: row.governorate, district: row.district, notes: row.notes,
      active: !!row.active, productCount: Number(row.productCount || 0), invoiceCount: Number(row.invoiceCount || 0),
    })) });
  });

  app.post('/api/warehouses', adminOnly, catalogueOwnerOnly, (req, res) => {
    const parsed = newWarehouse.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات المخزن غير صحيحة.' }); return; }
    const id = randomUUID();
    const now = Date.now();
    try {
      store.run('INSERT INTO warehouses(id,name,governorate,district,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        id, parsed.data.name, parsed.data.governorate, parsed.data.district, parsed.data.notes, now, now);
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) { res.status(409).json({ error: `مخزن «${parsed.data.name}» موجود بالفعل.`, code: 'WAREHOUSE_EXISTS' }); return; }
      throw error;
    }
    store.audit(res.locals.user.id, 'warehouse.create', { warehouseId: id, name: parsed.data.name });
    broadcast(); notifyStock();
    res.status(201).json({ warehouse: { id, ...parsed.data, active: true } });
  });

  /**
   * A warehouse is renamed, not removed, once it has been used: it is referenced by the ledger and
   * by invoices, and an invoice whose warehouse vanished is an invoice nobody can trace.
   */
  app.patch('/api/warehouses/:id', adminOnly, catalogueOwnerOnly, (req, res) => {
    const warehouse = store.get('SELECT id, name FROM warehouses WHERE id=?', String(req.params.id));
    if (!warehouse) { res.status(404).json({ error: 'المخزن غير موجود.' }); return; }
    const parsed = patchWarehouse.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'بيانات المخزن غير صحيحة.' }); return; }
    const merged = { ...warehouse, ...parsed.data };
    try {
      store.run('UPDATE warehouses SET name=?, governorate=?, district=?, notes=?, active=?, updated_at=? WHERE id=?',
        String(merged.name).trim(), merged.governorate ?? '', merged.district ?? '', merged.notes ?? '',
        parsed.data.active === undefined ? 1 : (parsed.data.active ? 1 : 0), Date.now(), warehouse.id);
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) { res.status(409).json({ error: 'في مخزن تاني بنفس الاسم.', code: 'WAREHOUSE_EXISTS' }); return; }
      throw error;
    }
    store.audit(res.locals.user.id, 'warehouse.update', { warehouseId: warehouse.id, fields: Object.keys(parsed.data) });
    broadcast(); notifyStock();
    res.json({ ok: true });
  });

  // ---- Products ----
  app.get('/api/products', adminOnly, (req, res) => {
    const warehouseId = typeof req.query.warehouseId === 'string' && req.query.warehouseId ? req.query.warehouseId : '';
    const includeInactive = req.query.includeInactive === '1';
    const rows = store.all(`SELECT p.*,
        COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.product_id=p.id ${warehouseId ? 'AND m.warehouse_id=?' : ''}), 0) AS onHand,
        (SELECT MAX(m.created_at) FROM stock_movements m WHERE m.product_id=p.id ${warehouseId ? 'AND m.warehouse_id=?' : ''}) AS lastMovementAt,
        (SELECT COUNT(*) FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE l.product_id=p.id AND i.voided=0) AS soldLines
      FROM products p ${includeInactive ? '' : 'WHERE p.active=1'} ORDER BY p.name COLLATE NOCASE`,
    ...(warehouseId ? [warehouseId, warehouseId] : [])) as Array<Record<string, any>>;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      products: rows.map((row: Record<string, any>) => ({
        id: row.id, name: row.name, unit: row.unit, defaultPrice: money(row.default_price), notes: row.notes,
        active: !!row.active, onHand: money(row.onHand || 0), lastMovementAt: row.lastMovementAt ?? null,
        soldLines: Number(row.soldLines || 0),
      })),
    });
  });

  app.post('/api/products', adminOnly, catalogueOwnerOnly, (req, res) => {
    const parsed = newProduct.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات المنتج غير صحيحة.' }); return; }
    const id = randomUUID();
    const now = Date.now();
    try {
      store.run('INSERT INTO products(id,name,unit,default_price,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        id, parsed.data.name, parsed.data.unit, parsed.data.defaultPrice, parsed.data.notes, now, now);
    } catch (error) {
      // Two products with one name is two stock numbers for one physical thing.
      if (String((error as Error).message).includes('UNIQUE')) { res.status(409).json({ error: `«${parsed.data.name}» مسجّل بالفعل في الأصناف.`, code: 'PRODUCT_EXISTS' }); return; }
      throw error;
    }
    store.audit(res.locals.user.id, 'product.create', { productId: id, name: parsed.data.name, price: parsed.data.defaultPrice });
    broadcast(); notifyStock();
    res.status(201).json({ product: { id, ...parsed.data, active: true, onHand: 0 } });
  });

  /**
   * Repricing a product changes tomorrow's invoices only. The lines already written keep their
   * unit_price, which is the whole reason the column is a copy and not a join.
   */
  app.patch('/api/products/:id', adminOnly, catalogueOwnerOnly, (req, res) => {
    const product = store.get('SELECT id, name FROM products WHERE id=?', String(req.params.id));
    if (!product) { res.status(404).json({ error: 'المنتج غير موجود.' }); return; }
    const parsed = patchProduct.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات المنتج غير صحيحة.' }); return; }
    // Only the keys that arrived are written. A partial request is a normal thing to receive — the
    // «عدّل سعر الوحدة» box sends one number, the «إيقاف» button sends one flag — and rewriting the
    // other columns from a row this route never read is how a price edit used to reset the unit to
    // «كرتونة» and a pause used to send the price to zero.
    const data = parsed.data as Record<string, unknown>;
    const sets: string[] = [];
    const params: any[] = [];
    if (data.name !== undefined) { sets.push('name=?'); params.push(String(data.name).trim()); }
    if (data.unit !== undefined) { sets.push('unit=?'); params.push(String(data.unit).trim()); }
    if (data.defaultPrice !== undefined) { sets.push('default_price=?'); params.push(Number(data.defaultPrice)); }
    if (data.notes !== undefined) { sets.push('notes=?'); params.push(String(data.notes)); }
    if (data.active !== undefined) { sets.push('active=?'); params.push(data.active ? 1 : 0); }
    if (!sets.length) { res.status(400).json({ error: 'مافيش حاجة اتغيّرت — اكتب السعر أو الوحدة.', code: 'NO_CHANGE' }); return; }
    sets.push('updated_at=?'); params.push(Date.now()); params.push(product.id);
    try {
      store.run(`UPDATE products SET ${sets.join(', ')} WHERE id=?`, ...params);
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) { res.status(409).json({ error: 'اسم المنتج ده موجود في صنف تاني.', code: 'PRODUCT_EXISTS' }); return; }
      throw error;
    }
    store.audit(res.locals.user.id, 'product.update', { productId: product.id, fields: Object.keys(parsed.data) });
    broadcast(); notifyStock();
    res.json({ ok: true });
  });

  // ---- Stock: the ledger, and what is left on the shelf ----
  /**
   * The one query the warehouse account lives on. onHand is the sum of the movements, so a count
   * that disagrees with the invoices shows up as a movement row rather than as a mystery number.
   */
  app.get('/api/stock', adminOnly, (req, res) => {
    const warehouseId = typeof req.query.warehouseId === 'string' && req.query.warehouseId ? req.query.warehouseId : '';
    const rows = store.all(`SELECT p.id AS productId, p.name AS productName, p.unit AS unit, p.default_price AS price,
        w.id AS warehouseId, w.name AS warehouseName,
        COALESCE(SUM(m.qty), 0) AS onHand, MAX(m.created_at) AS lastMovementAt
      FROM products p
      CROSS JOIN warehouses w
      LEFT JOIN stock_movements m ON m.product_id=p.id AND m.warehouse_id=w.id
      WHERE p.active=1 AND w.active=1 ${warehouseId ? 'AND w.id=?' : ''}
      GROUP BY p.id, w.id
      HAVING onHand <> 0 OR lastMovementAt IS NOT NULL
      ORDER BY w.name COLLATE NOCASE, p.name COLLATE NOCASE`,
    ...(warehouseId ? [warehouseId] : [])) as Array<Record<string, any>>;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      generatedAt: Date.now(),
      rows: rows.map(row => ({
        productId: row.productId, productName: row.productName, unit: row.unit, price: money(row.price),
        warehouseId: row.warehouseId, warehouseName: row.warehouseName,
        onHand: money(row.onHand || 0), lastMovementAt: row.lastMovementAt ?? null,
        low: Number(row.onHand || 0) <= 0,
      })),
    });
  });

  app.get('/api/stock/movements', adminOnly, (req, res) => {
    const where: string[] = []; const params: any[] = [];
    if (typeof req.query.warehouseId === 'string' && req.query.warehouseId) { where.push('m.warehouse_id=?'); params.push(req.query.warehouseId); }
    if (typeof req.query.productId === 'string' && req.query.productId) { where.push('m.product_id=?'); params.push(req.query.productId); }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 150));
    const rows = store.all(`SELECT m.*, p.name AS productName, p.unit AS unit, w.name AS warehouseName, u.name AS userName, i.number AS invoiceNumber
      FROM stock_movements m JOIN products p ON p.id=m.product_id JOIN warehouses w ON w.id=m.warehouse_id
      LEFT JOIN users u ON u.id=m.created_by LEFT JOIN invoices i ON i.id=m.invoice_id
      WHERE ${where.length ? where.join(' AND ') : '1=1'} ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`, ...params, limit) as Array<Record<string, any>>;
    res.json({
      movements: rows.map(row => ({
        id: row.id, productId: row.product_id, productName: row.productName, unit: row.unit,
        warehouseId: row.warehouse_id, warehouseName: row.warehouseName,
        qty: money(row.qty), kind: row.kind, note: row.note, invoiceId: row.invoice_id,
        invoiceNumber: row.invoiceNumber ?? null, by: row.userName ?? '—', createdAt: row.created_at,
      })),
    });
  });

  /**
   * The warehouse account's only write. A count is not an edit of the number: it is a movement that
   * says «the difference between what the ledger claims and what is on the shelf is real», which is
   * what makes a stock correction auditable instead of invisible.
   */
  app.post('/api/stock/movements', adminOnly, catalogueOwnerOnly, (req, res) => {
    const parsed = newMovement.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات الحركة غير صحيحة.' }); return; }
    const { productId, warehouseId, kind, note, at } = parsed.data;
    if (!store.get('SELECT id FROM products WHERE id=?', productId)) { res.status(404).json({ error: 'المنتج غير موجود.' }); return; }
    if (!store.get('SELECT id FROM warehouses WHERE id=?', warehouseId)) { res.status(404).json({ error: 'المخزن غير موجود.' }); return; }
    /*
     * A dated correction. The statement the manager asked for has a real hole without it: a truck that
     * arrived on the 3rd and was typed on the 15th lands in the wrong month, and «الفاتح» and «الرصيده»
     * then stop agreeing with the paper sheet. So a past date is accepted for a receipt or a return, and
     * only by the manager account, because the person who counts the shelf is the last person who should
     * be able to move one backwards.
     *
     * A past-dated count is refused outright: «the level on the 3rd was 140» is a statement about a
     * snapshot nobody kept, and turning it into a delta against today's figure is how a correction
     * creates two wrong numbers instead of one.
     */
    const atMs = at && at > 0 ? Math.min(at, Date.now()) : Date.now();
    const backdated = Date.now() - atMs > 60000;
    if (backdated) {
      if (dashScope(res.locals.user) !== 'manager') {
        res.status(403).json({ error: 'تاريخ الحركة يكون النهاردة — التصحيح بتاريخ قديم للمدير.', code: 'BACKDATE_MANAGER_ONLY' });
        return;
      }
      if (kind === 'count' || kind === 'writeoff') {
        res.status(400).json({ error: 'الجرد والخصم مايرجعش لورا — سجلهم بتاريخ النهاردة.', code: 'BACKDATE_KIND' });
        return;
      }
    }
    const levelAt = (moment: number) => money(Number(store.get(
      'SELECT COALESCE(SUM(qty),0) AS q FROM stock_movements WHERE warehouse_id=? AND product_id=? AND created_at<=?',
      warehouseId, productId, moment)?.q || 0));
    const before = levelAt(Date.now());
    const signed = kind === 'count' ? money(parsed.data.qty - before)
      : kind === 'writeoff' ? -money(parsed.data.qty) : money(parsed.data.qty);
    if (backdated && signed > 0) {
      // A dated receipt is the one place where the same movement can be entered twice and both look
      // legitimate — once on the day, once as a correction. Same sign, same amount, same week is treated
      // as a duplicate and refused; it is rejected before it can make the month wrong in both directions.
      const twin = store.get(`SELECT id FROM stock_movements
        WHERE warehouse_id=? AND product_id=? AND kind=? AND qty=? AND created_at>=?
          AND ABS(created_at - ?) <= ? LIMIT 1`,
      warehouseId, productId, kind, signed, atMs - 7 * 86400000, atMs, 7 * 86400000) as { id: string } | undefined;
      if (twin) {
        res.status(409).json({ error: 'فيه حركة بنفس الكمية والنوع قرب نفس اليوم — دي مسجلة على الأرجح. الغيها وسجّلها صح، أو اكتبها بتاريخ النهاردة لو فعلاً حاجة تانية.', code: 'BACKDATE_CONFLICT' });
        return;
      }
    }
    if (signed === 0) { res.status(400).json({ error: 'الجرد طابق اللي في الدفتر — مفيش حاجة تتسجل.', code: 'NO_CHANGE' }); return; }
    // No «not enough stock» refusal here, and that is deliberate. A count is bounded by what the
    // shelves hold, and a writeoff exists precisely to say «there is less than the ledger claims» —
    // refusing it would keep the books pretty and the warehouse wrong. A negative number is allowed
    // to exist and is shown in red (`low` on /api/stock) until the next count fixes it.
    const id = randomUUID();
    const now = Date.now();
    store.run('INSERT INTO stock_movements(id,product_id,warehouse_id,qty,kind,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, productId, warehouseId, signed, kind, note, res.locals.user.id, atMs);
    store.audit(res.locals.user.id, 'stock.movement', { movementId: id, productId, warehouseId, kind, qty: signed, backdated: backdated ? atMs : undefined });
    broadcast(); notifyStock();
    // `onHand` is today's level, not the level on the day being corrected — the screen showing this row
    // is showing the shelf as it stands now, and inventing an as-of figure here would be the first
    // number in this product that means two different things depending on a date nobody typed.
    res.status(201).json({ movement: { id, qty: signed, kind, onHand: money(before + signed), createdAt: atMs, backdated } });
  });

  /*
   * The monthly statement of a warehouse — «فاضل قد إيه، ودخل قد إيه، وخرج قد إيه، والسجل بتاع
   * كل عملية». One row per product per month, and the ledger under it is every movement that made
   * those numbers, in the order they happened.
   *
   * Two rules make this worth more than a filtered list. The opening figure is the sum of everything
   * before the window rather than a number somebody remembers, so the month closes on the shelf
   * rather than on an argument. And the money columns exist only for a manager or the sales office:
   * the warehouse account keeps the quantities and the movements, because the person who counts the
   * bags is not the person who should be editing what they are worth.
   */
  app.get('/api/stock/report', adminOnly, (req, res) => {
    const day = 86400000;
    const to = Number.isFinite(Number(req.query.to)) && Number(req.query.to) > 0 ? Number(req.query.to) : Date.now();
    const from = Number.isFinite(Number(req.query.from)) && Number(req.query.from) > 0 ? Number(req.query.from) : to - 60 * day;
    if (from > to) { res.status(400).json({ error: 'تاريخ البداية بعد النهاية.' }); return; }
    const warehouseId = typeof req.query.warehouseId === 'string' && req.query.warehouseId ? req.query.warehouseId : '';
    const scope = dashScope(res.locals.user);
    const wantsValues = scope !== 'stock';

    const rows = store.all(`SELECT w.id AS warehouseId, w.name AS warehouseName, w.governorate AS governorate,
        p.id AS productId, p.name AS productName, p.unit AS unit, p.default_price AS price,
        COALESCE((SELECT SUM(m.qty) FROM stock_movements m
          WHERE m.warehouse_id=w.id AND m.product_id=p.id AND m.created_at<?), 0) AS opening,
        COALESCE((SELECT SUM(m.qty) FROM stock_movements m
          WHERE m.warehouse_id=w.id AND m.product_id=p.id), 0) AS onHand
      FROM warehouses w JOIN products p ON p.active=1
      WHERE (w.active=1 OR EXISTS (SELECT 1 FROM stock_movements m2 WHERE m2.warehouse_id=w.id AND m2.created_at>=? AND m2.created_at<=?))
        ${warehouseId ? 'AND w.id=?' : ''}
      ORDER BY w.name COLLATE NOCASE, p.name COLLATE NOCASE`,
      from, from, to, ...(warehouseId ? [warehouseId] : [])) as Array<Record<string, any>>;
    const movements = store.all(`SELECT m.id, m.qty, m.kind, m.note, m.created_at AS createdAt, m.created_by AS createdBy,
        m.warehouse_id AS warehouseId, m.product_id AS productId, u.name AS byName,
        p.name AS productName, p.unit AS unit, p.default_price AS price,
        (SELECT i.number FROM invoices i WHERE i.id=m.invoice_id) AS invoiceNumber
      FROM stock_movements m
      LEFT JOIN products p ON p.id=m.product_id
      LEFT JOIN users u ON u.id=m.created_by
      WHERE m.created_at>=? AND m.created_at<=? ${warehouseId ? 'AND m.warehouse_id=?' : ''}
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 4000`,
      from, to, ...(warehouseId ? [warehouseId] : [])) as Array<Record<string, any>>;

    const grouped = new Map<string, Array<Record<string, any>>>();
    for (const movement of movements) {
      const key = `${movement.warehouseId}:${movement.productId}`;
      const list = grouped.get(key); if (list) list.push(movement); else grouped.set(key, [movement]);
    }
    const perProduct = new Map<string, { in: number; out: number; adjust: number; count: number }>();
    for (const [key, list] of grouped) {
      const acc = { in: 0, out: 0, adjust: 0, count: list.length };
      for (const movement of list) {
        const qty = Number(movement.qty);
        if (movement.kind === 'count' || movement.kind === 'writeoff') acc.adjust += qty;
        else if (qty > 0) acc.in += qty;
        else acc.out += qty;
      }
      perProduct.set(key, acc);
    }
    // A product with movements but no active catalogue row (stopped after it sold) still has to
    // appear in the statement, or the month would not balance against the shelf.
    const seen = new Set(rows.map(row => `${row.warehouseId}:${row.productId}`));
    for (const [key, list] of grouped) {
      if (seen.has(key)) continue;
      const [warehouseId2, productId] = key.split(':');
      const first = list[0];
      rows.push({
        warehouseId: warehouseId2, warehouseName: '', governorate: '',
        productId, productName: first.productName ?? 'صنف محذوف', unit: first.unit ?? '', price: first.price ?? 0, opening: 0, onHand: 0,
      });
    }
    const report = rows.map(row => {
      const key = `${row.warehouseId}:${row.productId}`;
      const acc = perProduct.get(key) ?? { in: 0, out: 0, adjust: 0, count: 0 };
      const opening = money(row.opening);
      const onHand = money(row.onHand);
      const price = money(row.price);
      const outQty = Math.abs(money(acc.out));
      const item: Record<string, any> = {
        warehouseId: row.warehouseId, warehouseName: row.warehouseName, productId: row.productId,
        productName: row.productName, unit: row.unit, opening, inQty: money(acc.in), outQty,
        adjustments: money(acc.adjust), closing: money(opening + acc.in + acc.out + acc.adjust),
        movements: acc.count, onHand,
      };
      if (wantsValues) {
        item.price = price;
        item.inValue = money(acc.in * price);
        item.outValue = money(outQty * price);
        item.closingValue = money(onHand * price);
      }
      return item;
    }).filter(row => row.movements > 0 || row.opening !== 0 || row.onHand !== 0);
    const totals: Record<string, any> = report.reduce((acc, row) => ({
      inQty: money(acc.inQty + row.inQty), outQty: money(acc.outQty + row.outQty),
      closingValue: money(Number(acc.closingValue ?? 0) + Number(row.closingValue ?? 0)),
      inValue: money(Number(acc.inValue ?? 0) + Number(row.inValue ?? 0)),
      outValue: money(Number(acc.outValue ?? 0) + Number(row.outValue ?? 0)),
    }), { inQty: 0, outQty: 0, closingValue: 0, inValue: 0, outValue: 0 });
    if (!wantsValues) delete totals.closingValue; else { delete totals.inQty; delete totals.outQty; }
    const named = new Map(report.map(row => [`${row.warehouseId}:${row.productId}`, row]));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      from, to, valuesVisible: wantsValues,
      warehouses: [...new Set(report.map(row => row.warehouseName).filter(Boolean))],
      rows: report, totals,
      ledger: movements.slice(0, 400).map(movement => {
        const row = named.get(`${movement.warehouseId}:${movement.productId}`);
        return {
          id: movement.id, warehouseId: movement.warehouseId, warehouseName: row?.warehouseName ?? '',
          productId: movement.productId, productName: row?.productName ?? String(movement.productName ?? ''),
          unit: row?.unit ?? String(movement.unit ?? ''),
          qty: money(movement.qty), kind: movement.kind, note: movement.note, createdAt: movement.createdAt,
          by: String(movement.byName ?? ''), invoiceNumber: movement.invoiceNumber ?? null,
          // The movement itself carries no price; the catalogue's current one is used, and the note
          // below says so, because a statement that looks like a historical price list invites a
          // fight over last March.
          ...(wantsValues ? { value: money(Number(movement.qty) * Number(row?.price ?? movement.price ?? 0)) } : {}),
        };
      }),
      truncated: movements.length >= 4000,
    });
  });

  /*
   * The collection report — «مين حصّل كام في الشهر».
   *
   * It reads the event register rather than re-summing invoices, for two reasons. A collection is a
   * visit with cash in it, not a field on a bill: the same invoice can be paid in three parts by two
   * hands, and a report that only shows today's totals cannot say who brought the money. And the
   * difference between the two columns below (who owns the money, who typed it) is the reconciliation
   * the manager actually does at the end of the day — the engineer's list and the office's banked
   * amount are two different records of one pile of cash.
   */
  app.get('/api/collections', adminOnly, (req, res) => {
    const day = 86400000;
    const to = Number.isFinite(Number(req.query.to)) && Number(req.query.to) > 0 ? Number(req.query.to) : Date.now();
    const from = Number.isFinite(Number(req.query.from)) && Number(req.query.from) > 0 ? Number(req.query.from) : to - 30 * day;
    if (from > to) { res.status(400).json({ error: 'تاريخ البداية بعد النهاية.' }); return; }
    const repId = typeof req.query.repId === 'string' && req.query.repId ? req.query.repId : '';
    const params: any[] = [from, to];
    let filter = '';
    if (repId) { filter = ' AND ce.rep_id=?'; params.push(repId); }
    // Named rather than `window`: this is the only bound the register is read with, and `window` reads
    // like a browser global in a file that has none.
    const inWindow = 'ce.created_at>=? AND ce.created_at<=?';
    const byRep = store.all(`SELECT ce.rep_id AS repId, u.name AS repName, u.color AS repColor,
        COALESCE(SUM(ce.amount),0) AS collected, COUNT(*) AS entries,
        COALESCE(SUM(CASE WHEN ce.source='field' THEN ce.amount ELSE 0 END),0) AS fromField,
        COALESCE(SUM(CASE WHEN ce.source='office' THEN ce.amount ELSE 0 END),0) AS fromOffice
      FROM collection_events ce LEFT JOIN users u ON u.id=ce.rep_id
      WHERE ${inWindow}${filter} GROUP BY ce.rep_id, u.name, u.color ORDER BY collected DESC`, ...params) as Array<Record<string, any>>;
    const byCustomer = store.all(`SELECT ce.customer_id AS customerId, COALESCE(c.name, i.customer_name) AS customerName,
        COALESCE(SUM(ce.amount),0) AS collected, COUNT(*) AS entries, MAX(ce.created_at) AS lastAt
      FROM collection_events ce
      LEFT JOIN customers c ON c.id=ce.customer_id
      LEFT JOIN invoices i ON i.id=ce.invoice_id
      WHERE ${inWindow}${filter} GROUP BY ce.customer_id, customerName ORDER BY collected DESC LIMIT 40`, ...params) as Array<Record<string, any>>;
    const entries = store.all(`SELECT ce.id, ce.amount, ce.source, ce.note, ce.created_at AS createdAt,
        ce.rep_id AS repId, ru.name AS repName, bu.name AS recordedByName,
        ce.customer_id AS customerId, COALESCE(c.name, i.customer_name) AS customerName,
        i.number AS invoiceNumber, i.total AS invoiceTotal, i.paid_amount AS invoicePaid, i.status AS invoiceStatus
      FROM collection_events ce
      LEFT JOIN users ru ON ru.id=ce.rep_id
      LEFT JOIN users bu ON bu.id=ce.recorded_by
      LEFT JOIN invoices i ON i.id=ce.invoice_id
      LEFT JOIN customers c ON c.id=ce.customer_id
      WHERE ${inWindow}${filter} ORDER BY ce.created_at DESC LIMIT 200`, ...params) as Array<Record<string, any>>;
    // What is still owed, right now, per engineer — the other half of the report. Collecting with
    // nothing outstanding means an old bill was closed; outstanding without collection is the
    // follow-up list. Showing only one of the two is how a month looks finished when it is not.
    const outstanding = store.all(`SELECT i.rep_id AS repId, COALESCE(SUM(i.total - i.paid_amount),0) AS outstanding,
        COUNT(*) AS openInvoices, MAX(i.invoice_date) AS lastInvoiceAt
      FROM invoices i WHERE i.voided=0 AND i.status<>'paid' ${repId ? 'AND i.rep_id=?' : ''}
      GROUP BY i.rep_id`, ...(repId ? [repId] : [])) as Array<Record<string, any>>;
    const totalsRow = store.get(`SELECT COALESCE(SUM(ce.amount),0) AS collected, COUNT(*) AS entries,
        COUNT(DISTINCT ce.customer_id) AS customers
      FROM collection_events ce WHERE ${inWindow}${filter}`, ...params) as Record<string, any>;
    const owed = (id: any) => outstanding.find(row => String(row.repId ?? '') === String(id ?? ''));
    // One number the office should never have to discover by hand: what the invoices claim was paid,
    // against what the register actually holds. They agree by construction — every write to
    // `paid_amount` writes an event — so any difference is a database that predates the register (or a
    // bug), and saying it out loud is cheaper than a month of quiet under-reporting.
    const lifetime = store.get(`SELECT
        (SELECT COALESCE(SUM(paid_amount),0) FROM invoices WHERE voided=0) AS paidOnInvoices,
        (SELECT COALESCE(SUM(amount),0) FROM collection_events) AS registered`) as { paidOnInvoices: number; registered: number };
    const paidOnInvoices = money(lifetime.paidOnInvoices);
    const registered = money(lifetime.registered);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      from, to,
      totals: { collected: money(totalsRow.collected), entries: Number(totalsRow.entries || 0), customers: Number(totalsRow.customers || 0) },
      lifetime: { paidOnInvoices, registered, difference: money(paidOnInvoices - registered) },
      byRep: byRep.map(row => ({
        repId: row.repId, repName: row.repName ?? 'بدون مهندس', repColor: row.repColor ?? '#94a3b8',
        collected: money(row.collected), entries: Number(row.entries), fromField: money(row.fromField), fromOffice: money(row.fromOffice),
        outstanding: money(owed(row.repId)?.outstanding || 0), openInvoices: Number(owed(row.repId)?.openInvoices || 0),
      })),
      byCustomer: byCustomer.map(row => ({
        customerId: row.customerId, customerName: row.customerName, collected: money(row.collected),
        entries: Number(row.entries), lastAt: row.lastAt ?? null,
      })),
      entries: entries.map(row => ({
        id: row.id, amount: money(row.amount), source: row.source, note: row.note, createdAt: Number(row.createdAt),
        repId: row.repId, repName: row.repName ?? 'بدون مهندس', recordedBy: row.recordedByName ?? '',
        customerId: row.customerId, customerName: row.customerName ?? '', invoiceNumber: row.invoiceNumber ?? null,
        invoiceTotal: row.invoiceTotal === null || row.invoiceTotal === undefined ? null : money(row.invoiceTotal),
        invoicePaid: row.invoicePaid === null || row.invoicePaid === undefined ? null : money(row.invoicePaid),
        invoiceStatus: row.invoiceStatus ?? null,
      })),
    });
  });

  /*
   * Monthly targets: «كل مهندس هدفه كام، والشركة كام». The table holds the plan and nothing else —
   * revenue and progress are computed from the invoices every time. A target copied into a row
   * somewhere is a target that goes stale on the first void.
   */
  app.get('/api/targets', adminOnly, (req, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : monthKey();
    // monthBounds validates the month and throws on 2026-13; the monthly register answers 400 for the
    // same input, so both endpoints agree instead of one of them crashing the request.
    let bounds: ReturnType<typeof monthBounds>;
    try { bounds = monthBounds(month); } catch (e) { res.status(400).json({ error: (e as Error).message }); return; }
    // `<` and not `<=`: `monthBounds().end` is the first instant of the next month, and an invoice is
    // stamped with a wall-clock millisecond, not a midnight — closing the bound here would bill the
    // last day of the month twice whenever an invoice lands exactly on the turn.
    const sold = store.all(`SELECT i.rep_id AS repId, COUNT(*) AS invoices, COALESCE(SUM(i.total),0) AS revenue,
        COALESCE(SUM(i.paid_amount),0) AS collected
      FROM invoices i WHERE i.voided=0 AND i.invoice_date>=? AND i.invoice_date<?
      GROUP BY i.rep_id`, bounds.start, bounds.end) as Array<Record<string, any>>;
    // `t.rep_id AS repId` is spelled out because `shape()` and the two lookups below read `repId`:
    // `t.*` alone hands back `rep_id`, and every row would then have looked like the company row.
    const targets = store.all(`SELECT t.*, t.rep_id AS repId, u.name AS repName, u.color AS repColor, u.active AS repActive, b.name AS updatedByName
      FROM sales_targets t
      LEFT JOIN users u ON u.id=t.rep_id
      LEFT JOIN users b ON b.id=t.updated_by
      WHERE t.month=? ORDER BY (t.rep_id IS NULL), u.name COLLATE NOCASE`, month) as Array<Record<string, any>>;
    const reps = store.all("SELECT id, name, color, region FROM users WHERE role='rep' AND active=1 ORDER BY name COLLATE NOCASE") as Array<Record<string, any>>;
    // The company row is the whole month, not the invoices nobody claimed: `rep_id IS NULL` on an
    // invoice means «no engineer was credited», and summing only those would report a company that
    // sold nothing while every engineer's bar is full.
    const sum = (id: any, field: 'invoices' | 'revenue' | 'collected') => money(
      (id === null || id === undefined ? sold : sold.filter(row => String(row.repId) === String(id)))
        .reduce((acc, row) => acc + Number(row[field] || 0), 0));
    const shape = (row: Record<string, any>) => {
      const revenue = sum(row.repId, 'revenue');
      const invoices = Number(sum(row.repId, 'invoices'));
      const target = money(row.revenue || 0);
      return {
        month, repId: row.repId ?? null, repName: row.repName ?? 'الشركة كلها', repColor: row.repColor ?? '#94a3b8',
        // The company row has no user behind it, so its join is empty by construction — that is not
        // the same as «this engineer left», which is what the dimmed row on the screen means.
        repActive: row.repId === null || row.repId === undefined ? true : (row.repActive === undefined ? true : !!row.repActive),
        target, invoiceTarget: Number(row.invoices || 0), note: row.note ?? '',
        revenue, invoices, collected: sum(row.repId, 'collected'),
        remaining: money(Math.max(0, target - revenue)),
        progress: target > 0 ? Math.round(revenue / target * 100) : null,
        updatedBy: row.updatedByName ?? '', updatedAt: row.updated_at ?? null,
      };
    };
    const companyRow = targets.find(row => row.repId === null) ?? { repId: null, revenue: 0, invoices: 0, note: '', updated_at: null };
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      month, from: bounds.from, to: bounds.to, isCurrentMonth: month === monthKey(),
      company: shape(companyRow),
      // Every active engineer is listed, target or not: a manager has to see who was never given a
      // number. A departed engineer keeps his row so a closed month still reads complete.
      reps: reps.map(rep => shape(targets.find(row => String(row.repId) === String(rep.id)) ?? { repId: rep.id, revenue: 0, invoices: 0, note: '', updated_at: null })),
      retired: targets
        .filter(row => row.repId !== null && !reps.some(rep => String(rep.id) === String(row.repId)))
        .map(shape),
    });
  });

  const targetInput = z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/, 'الشهر يكون بصيغة YYYY-MM.'),
    repId: z.uuid().nullish(),
    revenue: z.number().finite().min(0).max(1e11).default(0),
    invoices: z.number().int().min(0).max(100000).default(0),
    note: z.string().trim().max(300).default(''),
  }).strict();

  /** The manager's only. A number a rep can write for himself is not a target, it is a wish. */
  app.put('/api/targets', adminOnly, (req, res) => {
    if (dashScope(res.locals.user) !== 'manager') { res.status(403).json({ error: 'الأهداف يحددها حساب المدير.', code: 'MANAGER_ONLY' }); return; }
    const parsed = targetInput.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات الهدف غير صحيحة.' }); return; }
    const data = parsed.data;
    // `2026-13` is two digits wide, so the shape check lets it through and only the calendar knows it
    // is a month that never happens. Reading it back answers 400, so writing it has to as well —
    // otherwise a typo files a plan somewhere nobody will ever look.
    try { monthBounds(data.month); } catch (e) { res.status(400).json({ error: (e as Error).message }); return; }
    if (data.repId !== null && data.repId !== undefined && !store.get("SELECT id FROM users WHERE id=? AND role='rep'", data.repId)) {
      res.status(409).json({ error: 'المهندس غير موجود.' }); return;
    }
    store.run(`INSERT INTO sales_targets(id,month,rep_id,revenue,invoices,note,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(month, IFNULL(rep_id, '')) DO UPDATE SET revenue=excluded.revenue, invoices=excluded.invoices,
        note=excluded.note, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      randomUUID(), data.month, data.repId ?? null, money(data.revenue), data.invoices, data.note, res.locals.user.id, Date.now());
    store.audit(res.locals.user.id, 'target.set', { month: data.month, repId: data.repId ?? null, revenue: money(data.revenue), invoices: data.invoices });
    invalidateKpis(); broadcast();
    res.json({ ok: true, month: data.month, repId: data.repId ?? null });
  });

  /** His own month: what he was asked for and where he stands. No list of colleagues. */
  app.get('/api/my/targets', repOnly, (req, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : monthKey();
    // monthBounds validates the month and throws on 2026-13; the monthly register answers 400 for the
    // same input, so both endpoints agree instead of one of them crashing the request.
    let bounds: ReturnType<typeof monthBounds>;
    try { bounds = monthBounds(month); } catch (e) { res.status(400).json({ error: (e as Error).message }); return; }
    const sold = store.get(`SELECT COUNT(*) AS invoices, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(paid_amount),0) AS collected
      FROM invoices WHERE voided=0 AND rep_id=? AND invoice_date>=? AND invoice_date<?`,
      res.locals.user.id, bounds.start, bounds.end) as Record<string, any>;
    const target = store.get('SELECT revenue, invoices, note, updated_at FROM sales_targets WHERE month=? AND rep_id=?',
      month, res.locals.user.id) as { revenue: number; invoices: number; note: string; updated_at: number } | undefined;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      month,
      target: target ? {
        revenue: money(target.revenue), invoices: Number(target.invoices || 0), note: target.note, updatedAt: target.updated_at ?? null,
        revenueProgress: Number(target.revenue) > 0 ? Math.round(Number(sold.revenue) / Number(target.revenue) * 100) : null,
        invoicesProgress: Number(target.invoices) > 0 ? Math.round(Number(sold.invoices) / Number(target.invoices) * 100) : null,
      } : null,
      sold: { invoices: Number(sold.invoices || 0), revenue: money(sold.revenue), collected: money(sold.collected) },
      daysLeft: Math.max(0, Math.ceil((bounds.end - Math.min(Date.now(), bounds.end)) / 86400000)),
    });
  });

  /**
   * The engineer records the cash he took, on his own bill. The office keeps its own record of what it
   * banked; both are stored, because they are two true things about one pile of money.
   */
  app.post('/api/my/invoices/:id/pay', repOnly, (req, res) => {
    const parsed = z.object({ amount: z.number().finite().positive().max(1e9), note: z.string().trim().max(300).default('') }).strict().safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'اكتب مبلغ صحيح.' }); return; }
    const invoice = store.get('SELECT id, number, total, paid_amount AS paidAmount, rep_id AS repId, customer_id AS customerId, voided FROM invoices WHERE id=?',
      String(req.params.id)) as { id: string; number: string; total: number; paidAmount: number; repId: string; customerId: string | null; voided: number } | undefined;
    if (!invoice) { res.status(404).json({ error: 'الفاتورة غير موجودة.' }); return; }
    if (String(invoice.repId) !== String(res.locals.user.id)) { res.status(403).json({ error: 'الفاتورة دي مش ليك.' }); return; }
    if (Number(invoice.voided)) { res.status(409).json({ error: 'الفاتورة ملغاة.' }); return; }
    const next = money(Number(invoice.paidAmount) + parsed.data.amount);
    if (next > money(invoice.total) + 0.005) {
      res.status(400).json({ error: `المبلغ يوصل الإجمالي لأكتر من ${money(invoice.total)} ج.م — سجّل الباقي على فاتورة تانية.`, code: 'OVERPAYMENT' });
      return;
    }
    store.run('UPDATE invoices SET paid_amount=?, status=?, updated_at=? WHERE id=?', next, paymentStatus(Number(invoice.total), next), Date.now(), invoice.id);
    recordCollection({ invoiceId: invoice.id, customerId: invoice.customerId, repId: invoice.repId, by: res.locals.user.id,
      amount: parsed.data.amount, note: parsed.data.note, source: 'field' });
    store.audit(res.locals.user.id, 'invoice.collect', { invoiceId: invoice.id, number: invoice.number, amount: parsed.data.amount });
    invalidateKpis(); broadcast(); notifyStock();
    res.json({ invoice: asInvoice(store.get(`${INVOICE_SELECT} WHERE i.id=?`, invoice.id)), collected: parsed.data.amount });
  });

  // ---- Invoices ----
  app.get('/api/invoices', adminOnly, (req, res) => {
    const where: string[] = []; const params: any[] = [];
    if (req.query.includeVoided !== '1') where.push('i.voided=0');
    const isAdmin = res.locals.user.role === 'admin';
    if (!isAdmin) { where.push('i.rep_id=?'); params.push(res.locals.user.id); }
    else if (typeof req.query.repId === 'string' && req.query.repId) { where.push('i.rep_id=?'); params.push(req.query.repId); }
    if (typeof req.query.customerId === 'string' && req.query.customerId) { where.push('i.customer_id=?'); params.push(req.query.customerId); }
    if (typeof req.query.warehouseId === 'string' && req.query.warehouseId) { where.push('i.warehouse_id=?'); params.push(req.query.warehouseId); }
    if (['unpaid', 'partial', 'paid'].includes(String(req.query.status))) { where.push('i.status=?'); params.push(String(req.query.status)); }
    // `open=1` is the reconciliation filter: everything that still owes money, whether or not a part
    // of it was banked. The collection screen needs the partials — that is where the follow-up lives.
    if (req.query.open === '1') where.push("i.status IN ('unpaid','partial')");
    if (req.query.stockShort === '1') where.push('i.stock_short=1');
    // «field» = the engineer typed it on his phone, «dashboard» = the office typed it. The manager
    // asks this when a paper note turns up two days after the phone was right there.
    if (req.query.enteredBy === 'field') where.push("EXISTS (SELECT 1 FROM users x WHERE x.id=i.created_by AND x.role='rep')");
    if (req.query.enteredBy === 'dashboard') where.push("NOT EXISTS (SELECT 1 FROM users x WHERE x.id=i.created_by AND x.role='rep')");
    const from = Number(req.query.from); if (Number.isFinite(from) && from > 0) { where.push('i.invoice_date>=?'); params.push(from); }
    const to = Number(req.query.to); if (Number.isFinite(to) && to > 0) { where.push('i.invoice_date<=?'); params.push(to); }
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    if (q) { where.push('(i.customer_name LIKE ? OR i.number LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const rows = store.all(`${INVOICE_SELECT}
      WHERE ${where.length ? where.join(' AND ') : '1=1'}
      ORDER BY i.invoice_date DESC, i.created_at DESC LIMIT ?`, ...params, limit) as Array<Record<string, any>>;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      invoices: rows.map(row => ({ ...asInvoice(row)!, lineCount: Number(store.get('SELECT COUNT(*) AS c FROM invoice_lines WHERE invoice_id=?', row.id)?.c || 0) })),
    });
  });

  app.get('/api/invoices/:id', adminOnly, (req, res) => {
    const row = store.get(`${INVOICE_SELECT} WHERE i.id=?`, String(req.params.id)) as Record<string, any> | undefined;
    if (!row) { res.status(404).json({ error: 'الفاتورة غير موجودة.' }); return; }
    if (res.locals.user.role !== 'admin' && String(row.rep_id) !== String(res.locals.user.id)) { res.status(403).json({ error: 'الفاتورة دي مش ليك.' }); return; }
    res.json({ invoice: asInvoice(row), lines: invoiceLines(row.id) });
  });

  /**
   * Write an invoice — from the office dashboard and from the engineer's phone.
   *
   * The engineer used to write the sale on paper and the office typed it in hours later; now the
   * line is written where the truck was unloaded. That is not a looser server: the same code runs
   * for both, the customer's owner is still the one the sale is credited to, the prices come from
   * the catalogue, the totals are computed here, and the invoice lands on the customer's name in the
   * dashboard the second it is accepted. What an engineer cannot do is point his sale at somebody
   * else (`canChooseRep`) or pick a warehouse in another governorate.
   *
   * Mounted on `auth` rather than `adminOnly` on purpose: the warehouse account is an administrator
   * for sign-in, and it is kept out by the scope gate, which is where that rule is written down.
   */
  app.post('/api/invoices', auth, (req, res) => {
    const parsed = newInvoice.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات الفاتورة غير صحيحة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) });
      return;
    }
    const data = parsed.data;
    const isAdmin = res.locals.user.role === 'admin';
    const customer = store.get('SELECT id, name, rep_id AS repId, governorate FROM customers WHERE id=?', data.customerId) as { id: string; name: string; repId: string; governorate: string } | undefined;
    if (!customer) { res.status(404).json({ error: 'اختار العميل من قائمة المهندس الأول.' }); return; }
    if (!isAdmin && String(customer.repId) !== String(res.locals.user.id)) { res.status(403).json({ error: 'تقدر تسجّل فواتير عملاءك إنت بس.' }); return; }
    /*
     * Which warehouse the goods leave from. The office picks it. The engineer gets it from his
     * customer's area, and when that is ambiguous he is asked rather than guessed for: a warehouse
     * chosen by guess work moves stock between two stores and turns into a shortage nobody can
     * explain at the end of the month.
     */
    let warehouse: { id: string; name: string; governorate?: string } | undefined;
    if (data.warehouseId) {
      warehouse = store.get('SELECT id, name, governorate FROM warehouses WHERE id=? AND active=1', data.warehouseId) as { id: string; name: string; governorate: string } | undefined;
      if (!warehouse) { res.status(404).json({ error: 'المخزن غير موجود أو متوقف.' }); return; }
      if (!isAdmin) {
        const mine = store.get('SELECT governorate FROM users WHERE id=?', res.locals.user.id) as { governorate: string } | undefined;
        const area = String(warehouse.governorate || '');
        if (area && String(mine?.governorate || '') && area !== String(mine?.governorate || '')) {
          res.status(403).json({ error: 'المخزن ده في محافظة تانية — كلّم المكتب يسجّل الفاتورة دي.', code: 'WAREHOUSE_NOT_YOURS' });
          return;
        }
      }
    } else {
      if (isAdmin) { res.status(400).json({ error: 'اختار المخزن اللي هيصرف.', code: 'WAREHOUSE_REQUIRED' }); return; }
      // Two rows is the most either query needs to read: one means «this is it», two means
      // «somebody has to choose», and that is decided from the count rather than a guess.
      const areaRows = store.all('SELECT id, name, governorate FROM warehouses WHERE active=1 AND governorate<>\'\' AND governorate=? LIMIT 2',
        String(customer.governorate || '')) as { id: string; name: string; governorate: string }[];
      const candidates = areaRows.length > 0 ? areaRows : store.all('SELECT id, name, governorate FROM warehouses WHERE active=1 LIMIT 2') as { id: string; name: string; governorate: string }[];
      if (candidates.length === 0) { res.status(409).json({ error: 'مافيش مخزن شغال — كلّم المكتب يفتتح مخزن الأول.', code: 'NO_WAREHOUSE' }); return; }
      if (candidates.length > 1) { res.status(409).json({ error: 'عندك أكتر من مخزن — اختار المخزن اللي البضاعة خرجت منه.', code: 'WAREHOUSE_AMBIGUOUS' }); return; }
      warehouse = candidates[0];
    }
    /*
     * The sale belongs to the engineer who owns the customer, and only the manager account can say
     * otherwise. Note `dashScope(...) === 'manager'` rather than the role check the rest of the file
     * uses: the sales office writes invoices all day, and an office account that could re-point a
     * sale at another engineer is a way to move revenue between people without the manager noticing.
     */
    const canChooseRep = dashScope(res.locals.user) === 'manager';
    const repId = canChooseRep && data.repId ? String(data.repId) : String(customer.repId);
    if (!store.get("SELECT id FROM users WHERE id=? AND role='rep'", repId)) { res.status(409).json({ error: 'المهندس المرتبط بالفاتورة غير موجود.' }); return; }

    // Resolve the lines against the catalogue before anything is written, so a bad product id cannot
    // leave a half invoice behind.
    const lines: Array<{ productId: string; productName: string; unit: string; qty: number; unitPrice: number; lineTotal: number }> = [];
    for (const line of data.lines) {
      const product = store.get('SELECT id, name, unit, default_price AS defaultPrice, active FROM products WHERE id=?', line.productId) as Record<string, any> | undefined;
      if (!product) { res.status(409).json({ error: 'في منتج في الفاتورة مش موجود في الأصناف.', code: 'PRODUCT_NOT_FOUND' }); return; }
      if (!Number(product.active) && line.qty > 0) { res.status(409).json({ error: `«${product.name}» متوقف — نشّطه لو لسه بيتباع.`, code: 'PRODUCT_INACTIVE' }); return; }
      const unitPrice = money(line.unitPrice ?? Number(product.defaultPrice || 0));
      const qty = Number(line.qty);
      lines.push({ productId: String(product.id), productName: String(product.name), unit: String(product.unit), qty, unitPrice, lineTotal: money(qty * unitPrice) });
    }
    const subtotal = money(lines.reduce((sum, line) => sum + line.lineTotal, 0));
    const discount = money(Math.min(data.discount, subtotal));
    const total = money(Math.max(0, subtotal - discount));
    const paidAmount = money(Math.min(data.paidAmount, total));
    // A zero-total invoice is always a mistake — a product left at price 0 in the catalogue, or a
    // discount typed as the whole amount — and letting it in would pull down the average invoice
    // value that the sales office is judged on.
    if (total <= 0) { res.status(400).json({ error: 'إجمالي الفاتورة صفر — سجّل سعر المنتج الأول أو راجع الخصم.', code: 'EMPTY_INVOICE' }); return; }
    const invoiceDate = data.invoiceDate ?? Date.now();

    const id = randomUUID();
    const now = Date.now();
    let number = '';
    let stockShort = 0;
    store.transaction(() => {
      const year = Number(localDate(config.timezone, invoiceDate).slice(0, 4));
      const series = store.get(`INSERT INTO invoice_series(year,last_number) VALUES(?,1)
        ON CONFLICT(year) DO UPDATE SET last_number=last_number+1 RETURNING last_number AS n`, year) as { n: number } | undefined;
      number = `INV-${year}-${String(Number(series?.n || 1)).padStart(4, '0')}`;
      store.run(`INSERT INTO invoices(id,number,customer_id,customer_name,rep_id,warehouse_id,invoice_date,subtotal,discount,total,paid_amount,status,stock_short,note,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, number, customer.id, customer.name, repId, warehouse.id, invoiceDate, subtotal, discount, total, paidAmount,
      paymentStatus(total, paidAmount), 0, data.note, res.locals.user.id, now, now);
      lines.forEach((line, index) => {
        store.run('INSERT INTO invoice_lines(id,invoice_id,product_id,product_name,unit,qty,unit_price,line_total,position) VALUES (?,?,?,?,?,?,?,?,?)',
          randomUUID(), id, line.productId, line.productName, line.unit, line.qty, line.unitPrice, line.lineTotal, index);
        const before = onHand(warehouse.id, line.productId);
        if (before - line.qty < -0.001) stockShort = 1;
        store.run('INSERT INTO stock_movements(id,product_id,warehouse_id,qty,kind,invoice_id,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          randomUUID(), line.productId, warehouse.id, -line.qty, 'sale', id, `فاتورة ${number}`, res.locals.user.id, now);
      });
      if (stockShort) store.run('UPDATE invoices SET stock_short=1 WHERE id=?', id);
    });
    if (paidAmount > 0) recordCollection({ invoiceId: id, customerId: customer.id, repId, by: res.locals.user.id, amount: paidAmount, note: data.note, source: isAdmin ? 'office' : 'field' });
    store.audit(res.locals.user.id, 'invoice.create', { invoiceId: id, number, repId, warehouseId: warehouse.id, total, lines: lines.length, stockShort });
    invalidateKpis(); broadcast(); notifyStock();
    res.status(201).json({ invoice: asInvoice(store.get(`${INVOICE_SELECT} WHERE i.id=?`, id)), lines: invoiceLines(id), stockShort: !!stockShort });
  });

  /**
   * Only the money and the note can be edited afterwards. Lines are immutable: changing what was
   * handed to a customer is what the void-and-rewrite path is for, because it leaves both numbers.
   */
  app.patch('/api/invoices/:id', adminOnly, (req, res) => {
    const invoice = store.get('SELECT id, number, total, paid_amount AS paidAmount, voided FROM invoices WHERE id=?', String(req.params.id)) as Record<string, any> | undefined;
    if (!invoice) { res.status(404).json({ error: 'الفاتورة غير موجودة.' }); return; }
    if (Number(invoice.voided)) { res.status(409).json({ error: 'الفاتورة ملغاة — سجلها من جديد.', code: 'INVOICE_VOIDED' }); return; }
    const parsed = patchInvoice.safeParse(req.body ?? {});
    if (!parsed.success || (parsed.data.paidAmount === undefined && parsed.data.note === undefined)) {
      res.status(400).json({ error: 'محتاج amount مسدد أو ملاحظة.' }); return;
    }
    const paidAmount = parsed.data.paidAmount === undefined ? money(invoice.paidAmount) : money(parsed.data.paidAmount);
    // Clamping a number that is too big would hide a typing mistake — and in this field a payment of
    // 5000 on an invoice of 3800 usually means a second invoice was meant to be written.
    if (paidAmount > money(invoice.total) + 0.005) {
      res.status(400).json({ error: `المسدد أكبر من إجمالي الفاتورة (${money(invoice.total)} ج.م) — سجّل الفاتورة التانية لوحدها.`, code: 'OVERPAYMENT' });
      return;
    }
    if (paidAmount < money(invoice.paidAmount) - 0.005) {
      res.status(409).json({ error: 'المسدد ما بيرجعش لورا — لو فيه خطأ في التحصيل، الغي الفاتورة وسجّلها صح.', code: 'PAYMENT_ROLLBACK' });
      return;
    }
    const full = store.get('SELECT id, customer_id AS customerId, rep_id AS repId FROM invoices WHERE id=?', invoice.id) as { customerId: string | null; repId: string | null } | undefined;
    store.run('UPDATE invoices SET paid_amount=?, status=?, note=COALESCE(?, note), updated_at=? WHERE id=?',
      paidAmount, paymentStatus(Number(invoice.total), paidAmount), parsed.data.note ?? null, Date.now(), invoice.id);
    // The delta, not the new total: two edits in one day are one collection, not two.
    recordCollection({ invoiceId: String(invoice.id), customerId: full?.customerId ?? null, repId: full?.repId ?? null,
      by: res.locals.user.id, amount: money(paidAmount - money(invoice.paidAmount)), note: parsed.data.note ?? '', source: 'office' });
    store.audit(res.locals.user.id, 'invoice.update', { invoiceId: invoice.id, number: invoice.number, paidAmount });
    invalidateKpis(); broadcast(); notifyStock();
    res.json({ invoice: asInvoice(store.get(`${INVOICE_SELECT} WHERE i.id=?`, invoice.id)) });
  });

  /** Cancel an invoice: the number stays, the rows stay, and the warehouse is given the goods back. */
  app.post('/api/invoices/:id/void', adminOnly, (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
    if (reason.length < 2) { res.status(400).json({ error: 'اكتب سبب إلغاء الفاتورة.', code: 'REASON_REQUIRED' }); return; }
    const invoice = store.get('SELECT id, number, voided FROM invoices WHERE id=?', String(req.params.id)) as { id: string; number: string; voided: number } | undefined;
    if (!invoice) { res.status(404).json({ error: 'الفاتورة غير موجودة.' }); return; }
    if (Number(invoice.voided)) { res.status(409).json({ error: 'الفاتورة ملغاة بالفعل.' }); return; }
    const lines = store.all('SELECT product_id AS productId, qty FROM invoice_lines WHERE invoice_id=?', invoice.id) as Array<{ productId: string; qty: number }>;
    const now = Date.now();
    store.transaction(() => {
      store.run('UPDATE invoices SET voided=1, void_reason=?, voided_at=?, updated_at=? WHERE id=?', reason, now, now, invoice.id);
      const warehouseId = String(store.get('SELECT warehouse_id AS w FROM invoices WHERE id=?', invoice.id)!.w);
      for (const line of lines) {
        store.run('INSERT INTO stock_movements(id,product_id,warehouse_id,qty,kind,invoice_id,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          randomUUID(), line.productId, warehouseId, Number(line.qty), 'return', invoice.id, `إلغاء الفاتورة ${invoice.number}`, res.locals.user.id, now);
      }
    });
    // Cancelling a bill money was banked against moves the cash back out, and the register has to say
    // so: without this row the collections report keeps counting money that no longer belongs to a
    // sale, and the drawer of whoever typed it never settles.
    const paidRow = store.get('SELECT paid_amount AS paidAmount, customer_id AS customerId, rep_id AS repId FROM invoices WHERE id=?',
      invoice.id) as { paidAmount: number; customerId: string | null; repId: string | null } | undefined;
    const paid = money(Number(paidRow?.paidAmount || 0));
    if (paid !== 0) {
      recordCollection({ invoiceId: invoice.id, customerId: paidRow?.customerId ?? null, repId: paidRow?.repId ?? null,
        by: res.locals.user.id, amount: -paid, note: `إلغاء الفاتورة — ${reason}`, source: 'office' });
    }
    store.audit(res.locals.user.id, 'invoice.void', { invoiceId: invoice.id, number: invoice.number, reason, lines: lines.length });
    invalidateKpis(); broadcast(); notifyStock();
    res.json({ ok: true, restored: lines.length });
  });

  /*
   * The engineer's own view. He writes the invoice here instead of on paper, and he reads back the
   * ones already booked in his name plus the prices and stock he is quoting from — nothing else.
   * These routes exist because /api/invoices and /api/sales/summary are dashboard routes: a rep
   * calling them would be reading the whole company's numbers, and the phone must not be able to do
   * that even by accident.
   */
  app.post('/api/my/invoices', repOnly, (req, res) => {
    const parsed = newInvoice.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'راجع العميل والكميات — ' + (parsed.error.issues[0]?.message || 'البيانات غير صحيحة.'), issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) });
      return;
    }
    const data = parsed.data;
    // He may name himself on the invoice — a phone that re-sends its own id must not be punished for
    // it — but never a colleague. Moving revenue between engineers stays the manager's decision.
    if (data.repId && String(data.repId) !== String(res.locals.user.id)) {
      res.status(400).json({ error: 'الفاتورة تتسجل باسمك إنت — مفيش نسبة لمهندس تاني من الموبايل.', code: 'REP_NOT_ALLOWED' });
      return;
    }
    const customer = store.get('SELECT id, name, rep_id AS repId, governorate FROM customers WHERE id=?', data.customerId) as { id: string; name: string; repId: string; governorate: string } | undefined;
    if (!customer) { res.status(404).json({ error: 'اختار العميل من قايمتك الأول — الفاتورة ما تتكتبش لعميل مش مسجل.' }); return; }
    if (String(customer.repId) !== String(res.locals.user.id)) { res.status(403).json({ error: 'العميل ده مش في قايمتك — لو عميل لمهندس تاني، سيّب مكتب المبيعات يسجّلها.', code: 'CUSTOMER_NOT_OWNED' }); return; }
    let warehouse: { id: string; name: string } | undefined;
    if (data.warehouseId) {
      warehouse = store.get('SELECT id, name FROM warehouses WHERE id=? AND active=1', data.warehouseId) as { id: string; name: string } | undefined;
      if (!warehouse) { res.status(404).json({ error: 'المخزن غير موجود أو متوقف.' }); return; }
    } else {
      const areaRows = store.all("SELECT id, name FROM warehouses WHERE active=1 AND governorate<>'' AND governorate=? LIMIT 2", String(customer.governorate || '')) as { id: string; name: string }[];
      const candidates = areaRows.length > 0 ? areaRows : store.all('SELECT id, name FROM warehouses WHERE active=1 LIMIT 2') as { id: string; name: string }[];
      if (candidates.length === 0) { res.status(409).json({ error: 'مافيش مخزن شغال — كلّم المكتب يفتتح مخزن الأول.', code: 'NO_WAREHOUSE' }); return; }
      if (candidates.length > 1) { res.status(409).json({ error: 'عندك أكتر من مخزن — اختار المخزن اللي البضاعة خرجت منه.', code: 'WAREHOUSE_AMBIGUOUS' }); return; }
      warehouse = candidates[0];
    }
    const lines: Array<{ productId: string; productName: string; unit: string; qty: number; unitPrice: number; lineTotal: number }> = [];
    for (const line of data.lines) {
      const product = store.get('SELECT id, name, unit, default_price AS defaultPrice, active FROM products WHERE id=?', line.productId) as Record<string, any> | undefined;
      if (!product) { res.status(409).json({ error: 'في منتج مش موجود في الأصناف.', code: 'PRODUCT_NOT_FOUND' }); return; }
      if (!Number(product.active) && line.qty > 0) { res.status(409).json({ error: `«${product.name}» متوقف — كلّم المكتب ينشّطه.`, code: 'PRODUCT_INACTIVE' }); return; }
      // The price is the catalogue's. An engineer quoting a number he agreed with a farmer is a
      // discount negotiation, and that belongs on the office's desk where someone can be asked about
      // it — `unitPrice` is accepted for the office only, and here it is deliberately ignored.
      const unitPrice = money(Number(product.defaultPrice || 0));
      const qty = Number(line.qty);
      lines.push({ productId: String(product.id), productName: String(product.name), unit: String(product.unit), qty, unitPrice, lineTotal: money(qty * unitPrice) });
    }
    const subtotal = money(lines.reduce((sum, line) => sum + line.lineTotal, 0));
    // A discount is not the engineer's to grant either; the office applies it when it reviews the bill.
    const total = money(subtotal);
    if (total <= 0) { res.status(400).json({ error: 'إجمالي الفاتورة صفر — الأصناف دي ملهاش سعر في المخزن لسه.', code: 'EMPTY_INVOICE' }); return; }

    const id = randomUUID();
    const now = Date.now();
    let number = '';
    let stockShort = 0;
    store.transaction(() => {
      const year = Number(localDate(config.timezone, now).slice(0, 4));
      const series = store.get(`INSERT INTO invoice_series(year,last_number) VALUES(?,1)
        ON CONFLICT(year) DO UPDATE SET last_number=last_number+1 RETURNING last_number AS n`, year) as { n: number } | undefined;
      number = `INV-${year}-${String(Number(series?.n || 1)).padStart(4, '0')}`;
      store.run(`INSERT INTO invoices(id,number,customer_id,customer_name,rep_id,warehouse_id,invoice_date,subtotal,discount,total,paid_amount,status,stock_short,note,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, number, customer.id, customer.name, res.locals.user.id, warehouse!.id, now, subtotal, 0, total,
      money(data.paidAmount), paymentStatus(total, money(data.paidAmount)), 0, data.note, res.locals.user.id, now, now);
      lines.forEach((line, index) => {
        store.run('INSERT INTO invoice_lines(id,invoice_id,product_id,product_name,unit,qty,unit_price,line_total,position) VALUES (?,?,?,?,?,?,?,?,?)',
          randomUUID(), id, line.productId, line.productName, line.unit, line.qty, line.unitPrice, line.lineTotal, index);
        const before = onHand(warehouse!.id, line.productId);
        if (before - line.qty < -0.001) stockShort = 1;
        store.run('INSERT INTO stock_movements(id,product_id,warehouse_id,qty,kind,invoice_id,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          randomUUID(), line.productId, warehouse!.id, -line.qty, 'sale', id, `فاتورة ${number}`, res.locals.user.id, now);
      });
      if (stockShort) store.run('UPDATE invoices SET stock_short=1 WHERE id=?', id);
    });
    if (data.paidAmount > 0) recordCollection({ invoiceId: id, customerId: customer.id, repId: res.locals.user.id, by: res.locals.user.id, amount: money(data.paidAmount), note: data.note, source: 'field' });
    store.audit(res.locals.user.id, 'invoice.create', { invoiceId: id, number, customerId: customer.id, warehouseId: warehouse!.id, total, lines: lines.length, stockShort, source: 'field' });
    invalidateKpis(); broadcast(); notifyStock();
    res.status(201).json({
      invoice: asInvoice(store.get(`${INVOICE_SELECT} WHERE i.id=?`, id)), lines: invoiceLines(id), stockShort: !!stockShort,
    });
  });

  /*
   * His shelves, in his own units: what he took out, what came back, and what is left — quantities
   * only, and only movements his own invoices caused. The manager's monthly statement carries the
   * money; this carries enough for a man in a farm to say «I can bring you four, not ten» without
   * calling the office. A sale somebody else made on the same pallet is not his to see.
   */
  app.get('/api/my/stock/report', repOnly, (req, res) => {
    const day = 86400000;
    const to = Number.isFinite(Number(req.query.to)) && Number(req.query.to) > 0 ? Number(req.query.to) : Date.now();
    const from = Number.isFinite(Number(req.query.from)) && Number(req.query.from) > 0 ? Number(req.query.from) : to - 30 * day;
    const repId = String(res.locals.user.id);
    const own = 'EXISTS (SELECT 1 FROM invoices i WHERE i.id=m.invoice_id AND i.rep_id=?)';
    /*
     * The pairs he has moved at all, then one read per pair for the three figures the sheet needs:
     * the shelf when the window opened, the level now, and what his own invoices drew in between.
     * Written as separate small queries rather than one clever statement on purpose — «الفاتح» must be
     * the shelf as it stood at the start of the month whatever happened since (the receipt that filled
     * it is usually older than the window), and a person checking a number on paper should be able to
     * find the same single query behind it.
     */
    const pairs = store.all(`SELECT DISTINCT m0.warehouse_id AS warehouseId, w.name AS warehouseName,
        m0.product_id AS productId, p.name AS productName, p.unit AS unit
      FROM stock_movements m0
      JOIN warehouses w ON w.id=m0.warehouse_id
      JOIN products p ON p.id=m0.product_id
      WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.id=m0.invoice_id AND i.rep_id=?)
      LIMIT 200`, repId) as Array<Record<string, any>>;
    const rows: Array<Record<string, any>> = [];
    for (const pair of pairs) {
      const opening = Number(store.get('SELECT COALESCE(SUM(qty),0) AS q FROM stock_movements WHERE warehouse_id=? AND product_id=? AND created_at<?',
        pair.warehouseId, pair.productId, from)?.q || 0);
      const onHand = Number(store.get('SELECT COALESCE(SUM(qty),0) AS q FROM stock_movements WHERE warehouse_id=? AND product_id=?',
        pair.warehouseId, pair.productId)?.q || 0);
      // `drawn`/`returned`/`lines` rather than `out`/`in`/`rows`: two of those are keywords in SQLite
      // and the failure is a bare 500 from the driver, which is not worth the shorter names.
      const own = store.get(`SELECT COALESCE(SUM(CASE WHEN m.qty<0 THEN -m.qty ELSE 0 END),0) AS drawn,
          COALESCE(SUM(CASE WHEN m.qty>0 THEN m.qty ELSE 0 END),0) AS returned, COUNT(*) AS lines
        FROM stock_movements m WHERE m.warehouse_id=? AND m.product_id=? AND m.created_at>=? AND m.created_at<=?
          AND EXISTS (SELECT 1 FROM invoices i WHERE i.id=m.invoice_id AND i.rep_id=?)`,
      pair.warehouseId, pair.productId, from, to, repId) as { drawn: number; returned: number; lines: number };
      const drawn = money(own?.drawn || 0);
      const back = money(own?.returned || 0);
      // `closing` is the warehouse's level now, not «opening + his own draws»: he is not the keeper of
      // the stock, so a figure derived only from his rows would read as −17 and be useless to him. What
      // he drew is shown beside it, which is the number he actually came for.
      rows.push({
        warehouseId: pair.warehouseId, warehouseName: pair.warehouseName, productId: pair.productId,
        productName: pair.productName, unit: pair.unit,
        opening: money(opening), inQty: back, outQty: drawn, adjustments: 0,
        closing: money(onHand), movements: Number(own?.lines || 0), onHand: money(onHand),
      });
    }
    rows.sort((a, b) => String(a.warehouseName).localeCompare(String(b.warehouseName)) || String(a.productName).localeCompare(String(b.productName)));
    const movements = store.all(`SELECT m.id, m.qty, m.kind, m.note, m.created_at AS createdAt, m.product_id AS productId,
        m.warehouse_id AS warehouseId, p.name AS productName, p.unit AS unit, w.name AS warehouseName,
        (SELECT i.number FROM invoices i WHERE i.id=m.invoice_id) AS invoiceNumber
      FROM stock_movements m
      JOIN products p ON p.id=m.product_id
      JOIN warehouses w ON w.id=m.warehouse_id
      WHERE m.created_at>=? AND m.created_at<=? AND ${own}
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 200`, from, to, repId) as Array<Record<string, any>>;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      from, to, valuesVisible: false,
      rows,
      totals: {},
      ledger: movements.map(movement => ({
        createdAt: Number(movement.createdAt), productName: movement.productName, unit: movement.unit,
        warehouseName: movement.warehouseName, qty: money(movement.qty), kind: movement.kind,
        note: movement.note, by: '', invoiceNumber: movement.invoiceNumber ?? null,
      })),
    });
  });

  /** The stores the engineer can name on an invoice: ids and names, no stock figures. */
  app.get('/api/my/warehouses', repOnly, (_req, res) => {
    const rows = store.all('SELECT id, name, governorate, district FROM warehouses WHERE active=1 ORDER BY name COLLATE NOCASE') as Array<Record<string, any>>;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ warehouses: rows.map(row => ({ id: row.id, name: row.name, governorate: row.governorate, district: row.district })) });
  });

  /**
   * The engineer may cancel a sale he typed wrongly, while it is still only his and still nothing was
   * collected on it. Once a coin is recorded against it, only the office can undo it: undoing a
   * payment from the field is how a collection goes missing from the books without anyone noticing.
   */
  app.post('/api/my/invoices/:id/void', repOnly, (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
    if (reason.length < 2) { res.status(400).json({ error: 'اكتب سبب إلغاء الفاتورة.', code: 'REASON_REQUIRED' }); return; }
    const invoice = store.get('SELECT id, number, voided, rep_id AS repId, paid_amount AS paidAmount, created_by AS createdBy FROM invoices WHERE id=?', String(req.params.id)) as { id: string; number: string; voided: number; repId: string; paidAmount: number; createdBy: string } | undefined;
    if (!invoice) { res.status(404).json({ error: 'الفاتورة غير موجودة.' }); return; }
    if (String(invoice.repId) !== String(res.locals.user.id)) { res.status(403).json({ error: 'الفاتورة دي مش ليك.' }); return; }
    if (Number(invoice.voided)) { res.status(409).json({ error: 'الفاتورة ملغاة بالفعل.' }); return; }
    if (String(invoice.createdBy) !== String(res.locals.user.id)) { res.status(403).json({ error: 'المكتب هو اللي كتب الفاتورة دي، وهو اللي يلغيها.', code: 'NOT_YOUR_ENTRY' }); return; }
    if (money(invoice.paidAmount) > 0) { res.status(409).json({ error: 'في تحصيل مسجل على الفاتورة — الإلغاء يبقى لمكتب المبيعات.', code: 'HAS_PAYMENT' }); return; }
    const lines = store.all('SELECT product_id AS productId, qty FROM invoice_lines WHERE invoice_id=?', invoice.id) as Array<{ productId: string; qty: number }>;
    const now = Date.now();
    store.transaction(() => {
      store.run('UPDATE invoices SET voided=1, void_reason=?, voided_at=?, updated_at=? WHERE id=?', reason, now, now, invoice.id);
      const warehouseId = String(store.get('SELECT warehouse_id AS w FROM invoices WHERE id=?', invoice.id)!.w);
      for (const line of lines) {
        store.run('INSERT INTO stock_movements(id,product_id,warehouse_id,qty,kind,invoice_id,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          randomUUID(), line.productId, warehouseId, Number(line.qty), 'return', invoice.id, `إلغاء من الموبايل ${invoice.number}`, res.locals.user.id, now);
      }
    });
    store.audit(res.locals.user.id, 'invoice.void', { invoiceId: invoice.id, number: invoice.number, reason, lines: lines.length, source: 'field' });
    invalidateKpis(); broadcast(); notifyStock();
    res.json({ ok: true, restored: lines.length });
  });

  /*
   * The engineer's read-only view. The sales office writes invoices, and the man in the field sees
   * the ones that are his and the prices and stock he is quoting from — nothing else. These routes
   * exist because /api/invoices and /api/sales/summary are dashboard routes: a rep calling them would
   * be reading the whole company's numbers, and the phone must not be able to do that even by accident.
   */
  app.get('/api/my/invoices', repOnly, (req, res) => {
    const day = 86400000;
    const to = Number.isFinite(Number(req.query.to)) && Number(req.query.to) > 0 ? Number(req.query.to) : Date.now();
    const from = Number.isFinite(Number(req.query.from)) && Number(req.query.from) > 0 ? Number(req.query.from) : to - 60 * day;
    // One customer is the question this screen gets asked most — «what does he owe me?» — asked from
    // the customer sheet. It narrows the same read; the engineer's own rows are the only ones in
    // scope either way, so `customerId` cannot widen what he sees, only shrink it.
    const customerId = typeof req.query.customerId === 'string' && req.query.customerId ? req.query.customerId : '';
    const clause = customerId ? ' AND i.customer_id=?' : '';
    const params = customerId ? [res.locals.user.id, from, to, customerId] : [res.locals.user.id, from, to];
    const rows = store.all(`${INVOICE_SELECT}
      WHERE i.rep_id=? AND i.voided=0 AND i.invoice_date>=? AND i.invoice_date<=?${clause}
      ORDER BY i.invoice_date DESC LIMIT 100`, ...params) as Array<Record<string, any>>;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      invoices: rows.map(row => ({ ...asInvoice(row)!, lines: invoiceLines(row.id) })),
      outstanding: money(rows.reduce((sum, row) => sum + Math.max(0, Number(row.total) - Number(row.paid_amount)), 0)),
    });
  });

  /** Prices and what is on the shelf, so a promise made in a farm matches what the truck can carry. */
  app.get('/api/my/catalogue', repOnly, (_req, res) => {
    const products = store.all(`SELECT p.id, p.name, p.unit, p.default_price AS price,
        COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.product_id=p.id), 0) AS onHand
      FROM products p WHERE p.active=1 ORDER BY p.name COLLATE NOCASE`) as Array<Record<string, any>>;
    const perWarehouse = store.all(`SELECT m.product_id AS productId, w.name AS warehouseName, SUM(m.qty) AS qty
      FROM stock_movements m JOIN warehouses w ON w.id=m.warehouse_id WHERE w.active=1
      GROUP BY m.product_id, m.warehouse_id`) as Array<Record<string, any>>;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      products: products.map(row => ({
        id: row.id, name: row.name, unit: row.unit, price: money(row.price), onHand: money(row.onHand || 0),
        warehouses: perWarehouse.filter(line => String(line.productId) === String(row.id))
          .map(line => ({ name: line.warehouseName, onHand: money(line.qty) })),
      })),
    });
  });

  /**
   * What each engineer sold, what sold best, and what is still owed — for a period, optionally for
   * one engineer or one warehouse. Read-only aggregates; nothing here can change a record.
   */
  app.get('/api/sales/summary', adminOnly, (req, res) => {
    const day = 86400000;
    const to = Number.isFinite(Number(req.query.to)) && Number(req.query.to) > 0 ? Number(req.query.to) : Date.now();
    const from = Number.isFinite(Number(req.query.from)) && Number(req.query.from) > 0 ? Number(req.query.from) : to - 30 * day;
    const where: string[] = ['i.voided=0', 'i.invoice_date>=?', 'i.invoice_date<=?'];
    const params: any[] = [from, to];
    if (typeof req.query.repId === 'string' && req.query.repId) { where.push('i.rep_id=?'); params.push(req.query.repId); }
    if (typeof req.query.warehouseId === 'string' && req.query.warehouseId) { where.push('i.warehouse_id=?'); params.push(req.query.warehouseId); }
    const clause = where.join(' AND ');
    const totalsRow = store.get(`SELECT COUNT(*) AS count, COALESCE(SUM(i.subtotal),0) AS subtotal, COALESCE(SUM(i.discount),0) AS discount,
        COALESCE(SUM(i.total),0) AS total, COALESCE(SUM(i.paid_amount),0) AS paid, SUM(CASE WHEN i.stock_short=1 THEN 1 ELSE 0 END) AS short
      FROM invoices i WHERE ${clause}`, ...params) as Record<string, any>;
    // No correlated subquery here, and that is a correctness choice rather than taste: a `?` inside
    // the SELECT list is bound BEFORE the ones in WHERE, so mixing the two silently fed the warehouse
    // id into the date comparison and the answer was an empty list that looked like a quiet month.
    const byRep = store.all(`SELECT i.rep_id AS repId, u.name AS repName, u.color AS repColor, COUNT(*) AS invoices,
        COALESCE(SUM(i.total),0) AS total, COALESCE(SUM(i.paid_amount),0) AS paid,
        SUM(CASE WHEN i.status<>'paid' THEN 1 ELSE 0 END) AS openInvoices
      FROM invoices i LEFT JOIN users u ON u.id=i.rep_id WHERE ${clause}
      GROUP BY i.rep_id, u.name, u.color ORDER BY total DESC`, ...params) as Array<Record<string, any>>;
    const topProducts = store.all(`SELECT l.product_id AS productId, l.product_name AS productName, l.unit AS unit,
        COALESCE(SUM(l.qty),0) AS qty, COALESCE(SUM(l.line_total),0) AS revenue
      FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE ${clause}
      GROUP BY l.product_id, l.product_name ORDER BY revenue DESC LIMIT 15`, ...params) as Array<Record<string, any>>;
    const balances = store.all(`SELECT i.customer_id AS customerId, i.customer_name AS customerName,
        COALESCE(SUM(i.total - i.paid_amount),0) AS outstanding, MAX(i.invoice_date) AS lastInvoiceAt, COUNT(*) AS invoices
      FROM invoices i WHERE ${clause} AND i.status<>'paid'
      GROUP BY i.customer_id, i.customer_name ORDER BY outstanding DESC LIMIT 25`, ...params) as Array<Record<string, any>>;
    const count = Number(totalsRow.count || 0);
    // Who typed the sale. The manager asked for the engineer to book his own invoice instead of
    // writing it on paper, and this is the number that says whether it actually happened: a month of
    // «dashboard» rows with a phone in every bag means the paper won anyway.
    const bySource = store.all(`SELECT CASE WHEN EXISTS (SELECT 1 FROM users x WHERE x.id=i.created_by AND x.role='rep')
        THEN 'field' ELSE 'dashboard' END AS enteredBy, COUNT(*) AS invoices, COALESCE(SUM(i.total),0) AS total
      FROM invoices i WHERE ${clause} GROUP BY enteredBy`, ...params) as Array<Record<string, any>>;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      from, to,
      totals: {
        count, subtotal: money(totalsRow.subtotal), discount: money(totalsRow.discount), total: money(totalsRow.total),
        paid: money(totalsRow.paid), outstanding: money(Number(totalsRow.total) - Number(totalsRow.paid)),
        averageInvoice: count ? money(Number(totalsRow.total) / count) : 0, stockShort: Number(totalsRow.short || 0),
      },
      byRep: byRep.map(row => ({
        repId: row.repId, repName: row.repName ?? 'بدون مهندس', repColor: row.repColor ?? '#94a3b8',
        invoices: Number(row.invoices), total: money(row.total), paid: money(row.paid),
        outstanding: money(Number(row.total) - Number(row.paid)), openInvoices: Number(row.openInvoices || 0),
      })),
      topProducts: topProducts.map(row => ({ productId: row.productId, productName: row.productName, unit: row.unit, qty: money(row.qty), revenue: money(row.revenue) })),
      balances: balances.map(row => ({ customerId: row.customerId, customerName: row.customerName, outstanding: money(row.outstanding), lastInvoiceAt: row.lastInvoiceAt ?? null, invoices: Number(row.invoices) })),
      bySource: {
        field: bySource.find(row => row.enteredBy === 'field') ? { invoices: Number(bySource.find(row => row.enteredBy === 'field')!.invoices), total: money(bySource.find(row => row.enteredBy === 'field')!.total) } : { invoices: 0, total: 0 },
        dashboard: bySource.find(row => row.enteredBy === 'dashboard') ? { invoices: Number(bySource.find(row => row.enteredBy === 'dashboard')!.invoices), total: money(bySource.find(row => row.enteredBy === 'dashboard')!.total) } : { invoices: 0, total: 0 },
      },
    });
  });

  // ---- Dashboard accounts: the sales office and the warehouse ----
  /*
   * These are created here and nowhere else, and only by the manager account (scope ''). The reason
   * is blunt: an account that can mint dashboard accounts can mint a manager, so the ability to set
   * a scope has to sit with the one account that already sees everything — not with the sales office,
   * however senior it is. There is no self-signup for this product, so this is the only door.
   */
  const staffInput = z.object({
    name: z.string().trim().min(2).max(80),
    email: z.email().max(254).transform(x => x.toLowerCase().trim()),
    password: z.string().min(10).max(200),
    scope: z.enum(['sales', 'stock']),
  }).strict();
  const managerOnly = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (dashScope(res.locals.user) !== 'manager') {
      res.status(403).json({ error: 'إنشاء حسابات اللوحة وتغيير الصلاحيات للمدير وحده.', code: 'MANAGER_ONLY' });
      return;
    }
    next();
  };

  app.get('/api/staff', adminOnly, managerOnly, (_req, res) => {
    const rows = store.all("SELECT id, name, email, scope, active, created_at AS createdAt, last_seen AS lastSeen FROM users WHERE role='admin' ORDER BY scope, name COLLATE NOCASE") as Array<Record<string, any>>;
    res.json({
      staff: rows.map(row => ({
        id: row.id, name: row.name, email: row.email, scope: String(row.scope || '') === '' ? 'manager' : String(row.scope),
        active: !!row.active, createdAt: row.createdAt, lastSeen: row.lastSeen ?? null,
      })),
    });
  });

  app.post('/api/staff', adminOnly, managerOnly, (req, res) => {
    const parsed = staffInput.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'راجع الاسم والبريد وكلمة المرور (١٠ أحرف على الأقل).' }); return; }
    if (parsed.data.password.length < MIN_ADMIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `كلمة مرور حسابات اللوحة ${MIN_ADMIN_PASSWORD_LENGTH} حرفًا على الأقل.`, code: 'PASSWORD_TOO_SHORT' }); return;
    }
    if (store.get('SELECT id FROM users WHERE email=?', parsed.data.email)) { res.status(409).json({ error: 'البريد الإلكتروني مستخدم بالفعل.' }); return; }
    const id = randomUUID();
    store.run("INSERT INTO users(id,name,email,password_hash,role,scope,created_at) VALUES (?,?,?,?,?,?,?)",
      id, parsed.data.name, parsed.data.email, hashPassword(parsed.data.password), 'admin', parsed.data.scope, Date.now());
    store.audit(res.locals.user.id, 'staff.create', { staffId: id, scope: parsed.data.scope });
    res.status(201).json({ user: publicUser(store.get('SELECT * FROM users WHERE id=?', id)!) });
  });

  /** Stop an account, or move it between the sales office and the warehouses. */
  app.patch('/api/staff/:id', adminOnly, managerOnly, (req, res) => {
    const parsed = z.object({ scope: z.enum(['sales', 'stock', '']).optional(), active: z.boolean().optional(), name: z.string().trim().min(2).max(80).optional() }).strict().safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'بيانات الحساب غير صحيحة.' }); return; }
    const staff = store.get("SELECT id, name, role, scope, active FROM users WHERE id=? AND role='admin'", String(req.params.id)) as Record<string, any> | undefined;
    if (!staff) { res.status(404).json({ error: 'حساب اللوحة غير موجود.' }); return; }
    if (String(staff.scope || '') === '' && parsed.data.scope !== undefined && parsed.data.scope !== '') {
      const managers = Number(store.get("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND scope='' AND active=1")?.c || 0);
      if (managers <= 1) { res.status(409).json({ error: 'ده حساب المدير الوحيد — اللوحة هتفضل مقفولة من غير حساب صلاحية كاملة.', code: 'LAST_MANAGER' }); return; }
    }
    if (parsed.data.active === false && String(staff.id) === String(res.locals.user.id)) { res.status(409).json({ error: 'ما ينفعش توقف حسابك إنت من اللوحة.' }); return; }
    store.run('UPDATE users SET name=COALESCE(?, name), scope=COALESCE(?, scope), active=? WHERE id=?',
      parsed.data.name ?? null, parsed.data.scope ?? null, parsed.data.active === undefined ? Number(staff.active) : (parsed.data.active ? 1 : 0), staff.id);
    if (parsed.data.active === false) {
      store.run('DELETE FROM sessions WHERE user_id=?', staff.id);
      io.in(`user:${staff.id}`).disconnectSockets(true);
    }
    store.audit(res.locals.user.id, 'staff.update', { staffId: staff.id, fields: Object.keys(parsed.data) });
    res.json({ ok: true });
  });

  const staffPasswordSchema = z.object({ password: z.string().min(10).max(200) }).strict();
  app.post('/api/staff/:id/password', adminOnly, managerOnly, (req, res) => {
    const parsed = staffPasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'كلمة المرور الجديدة قصيرة — ١٠ أحرف على الأقل.', code: 'PASSWORD_TOO_SHORT' }); return; }
    const staff = store.get("SELECT id FROM users WHERE id=? AND role='admin'", String(req.params.id));
    if (!staff) { res.status(404).json({ error: 'حساب اللوحة غير موجود.' }); return; }
    if (parsed.data.password.length < MIN_ADMIN_PASSWORD_LENGTH) { res.status(400).json({ error: `كلمة مرور حسابات اللوحة ${MIN_ADMIN_PASSWORD_LENGTH} حرفًا على الأقل.`, code: 'PASSWORD_TOO_SHORT' }); return; }
    store.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(parsed.data.password), staff.id);
    store.run('DELETE FROM sessions WHERE user_id=?', staff.id);
    io.in(`user:${staff.id}`).disconnectSockets(true);
    store.audit(res.locals.user.id, 'staff.password_reset', { staffId: staff.id });
    res.json({ ok: true });
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
    // A customer id is only honoured when the row belongs to this engineer: a visit booked against
    // somebody else's customer would move another man's sales figure, so it is refused outright.
    let customerId: string | null = null;
    if (data.customerId) {
      const owned = store.get('SELECT id, name FROM customers WHERE id=? AND rep_id=?', data.customerId, res.locals.user.id);
      if (owned) { customerId = String(owned.id); data.customerName = String(owned.name); }
      // A live attempt to book against somebody else's customer is refused outright: it would move
      // another man's sales figure. A visit recorded in a field with no signal is different — it was
      // lawful when it happened, and the customer may have moved since. Losing the link beats losing
      // the visit, so it is stored unlinked and the name the engineer typed stands.
      else if (!offline) { res.status(409).json({ error: 'العميل ده مش في قايمتك — اختاره من قايمتك إنت.', code: 'CUSTOMER_NOT_OWNED' }); return; }
    }
    store.run(`INSERT INTO visits(id,user_id,customer_name,customer_id,customer_linked_at,governorate,district,village,phone,purpose,notes,status,checked_in_at,checked_out_at,duration_seconds,auto_closed,recorded_offline,outcome,in_lat,in_lng,in_accuracy,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, data.id, res.locals.user.id, data.customerName, customerId, customerId ? now : null, data.governorate,
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
  /**
   * Remove one visit row.
   *
   * The reasons are mundane and real: a check-in typed for the wrong customer, and a visit left
   * open by a phone that died, which blocks the next check-in with «لديك زيارة مفتوحة» while the
   * engineer is standing at the next door. Managers only: an engineer deleting his own field
   * record would be deleting the evidence, not fixing the mistake.
   */
  app.delete('/api/visits/:id', adminOnly, (req, res) => {
    const visit = visitRow(String(req.params.id));
    if (!visit) { res.status(404).json({ error: 'الزيارة غير موجودة.' }); return; }
    store.run('DELETE FROM visits WHERE id=?', visit.id);
    store.audit(res.locals.user.id, 'visit.delete', { visitId: visit.id, repId: visit.userId, status: visit.status });
    invalidateKpis(); broadcast();
    res.json({ ok: true, visit: { id: visit.id, userId: visit.userId, customerName: visit.customerName } });
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
      const lastFix = store.get('SELECT recorded_at AS at, received_at AS receivedAt, battery FROM locations WHERE user_id=? ORDER BY recorded_at DESC, received_at DESC LIMIT 1', rep.id);
      const lastAt = lastFix?.at ? Number(lastFix.at) : null;
      // One threshold for the whole product (`STALE_GPS_MINUTES`, default 10): the map says
      // "لا إشارة" at exactly the moment this alert fires. `repSnapshot` publishes the same
      // per-engineer value, so a visit that widens the window here never leaves the map disagreeing.
      const openVisitRow = store.get("SELECT id FROM visits WHERE user_id=? AND status='open' ORDER BY checked_in_at DESC LIMIT 1", rep.id);
      const staleLimitMinutes = openVisitRow ? Math.max(config.staleGpsMinutes, VISIT_STALE_LIMIT_MINUTES) : config.staleGpsMinutes;
      const staleMs = staleLimitMinutes * 60000;
      // The excuse check. `last_seen` moves on any request from the phone, so a phone that reached
      // the API while its fixes stopped has a working network — the position is what broke. Without
      // this the manager had one word for a dead phone, a frozen app and a coverage hole, and every
      // one of them could be argued about after the fact.
      const silenceMs = lastAt ? now - lastAt : Number.POSITIVE_INFINITY;
      const presenceMs = rep.last_seen ? now - Number(rep.last_seen) : Number.POSITIVE_INFINITY;
      const gapKind = classifySilence({ silenceMs, limitMs: staleMs, presenceMs });
      if (shift && lastAt && gapKind !== 'ok') {
        const staleMinutes = Math.round(silenceMs / 60000);
        const seenMinutes = Number.isFinite(presenceMs) ? Math.max(1, Math.round(presenceMs / 60000)) : null;
        const battery = lastFix?.battery == null ? null : Number(lastFix.battery);
        const dying = battery !== null && battery <= LOW_BATTERY_PERCENT;
        alerts.push({
          id: `${rep.id}:stale`, level: 'warn', code: 'stale_gps', repId: rep.id, repName: rep.name,
          title: gapKind === 'gps_blocked' ? 'التطبيق بعت بس من غير نقاط موقع'
            : openVisitRow ? 'انقطاع في إرسال الموقع أثناء زيارة' : 'انقطاع في إرسال الموقع',
          detail: gapKind === 'gps_blocked'
            ? `التليفون واصِل للسيرفر${seenMinutes !== null ? ` (آخر طلب منه من ${seenMinutes} دقيقة)` : ''} بس آخر نقطة موقع قبل ${staleMinutes} دقيقة — الشبكة شغالة والموقع هو المقطوع: اطلب من المهندس يفتح التطبيق ويسمح بالموقع.`
            : `آخر إشارة قبل ${staleMinutes} دقيقة${dying ? ` والبطارية وقتها ${battery}٪` : ''}${openVisitRow ? ` (زيارة مفتوحة، الحد ${staleLimitMinutes} دقيقة)` : ` (حد التنبيه ${staleLimitMinutes} دقيقة)`} — مفيش أي طلب من التليفون في الفترة دي، فمقفول أو مكان بلا شبكة.${dying ? ' الأرجح إنه فصل.' : ''}`,
          at: lastAt,
        });
      }
      // A phone that dies mid-shift loses the trail with it, and it announces that in advance:
      // every fix carries its battery level. Warn while there is still time to charge or close up.
      if (shift && lastAt && gapKind === 'ok' && lastFix?.battery != null && Number(lastFix.battery) <= LOW_BATTERY_PERCENT) {
        alerts.push({
          id: `${rep.id}:battery`, level: 'warn', code: 'low_battery', repId: rep.id, repName: rep.name,
          title: `بطارية الموبايل ${Math.round(Number(lastFix.battery))}٪`,
          detail: 'التليفون هيفصل والوردية لسه مفتوحة — اطلب الشحن أو ختم الوردية دلوقتي.',
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
        // Same distinction as above: an app that reached the API but produced no fix never had a
        // position to send, which is a permissions/GPS problem, not a coverage complaint.
        const talking = rep.last_seen && now - Number(rep.last_seen) <= PRESENT_FRESH_MS;
        alerts.push({
          id: `${rep.id}:nosignal`, level: 'warn', code: 'no_signal', repId: rep.id, repName: rep.name,
          title: talking ? 'وردية بدون أي إشارة رغم اتصال التطبيق' : 'وردية بدون أي إشارة',
          detail: talking
            ? 'بدأ الوردية ولم تُسجل أي نقطة موقع بعد، مع إن التليفون واصِل للسيرفر — صلاحية الموقع أو الـGPS هو المقطوع.'
            : 'بدأ الوردية ولم تُسجل أي نقطة موقع بعد.',
          at: Number(shift.started_at),
        });
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
  /**
   * The money half of the performance table: what each engineer sold in the window, what was collected
   * on it, what is still owed, and what his product of the month was. Kept next to the visit and
   * distance columns on purpose — «بيع بكام» and «لف قد إيه» are read together by the same manager in
   * the same meeting, and two screens are how those two numbers stop agreeing.
   */
  function kpiSalesFor(from: string, to: string) {
    const bounds = dayBounds(from, config.timezone);
    const upto = dayBounds(to, config.timezone);
    const perRep = store.all(`SELECT i.rep_id AS repId, COUNT(*) AS invoices, COALESCE(SUM(i.total),0) AS revenue,
        COALESCE(SUM(i.paid_amount),0) AS collected, COALESCE(SUM(i.total - i.paid_amount),0) AS outstanding,
        SUM(CASE WHEN i.stock_short=1 THEN 1 ELSE 0 END) AS stockShort
      FROM invoices i WHERE i.voided=0 AND i.invoice_date>=? AND i.invoice_date<?
      GROUP BY i.rep_id`, bounds.start, upto.end) as Array<Record<string, any>>;
    const top = store.all(`SELECT i.rep_id AS repId, l.product_name AS productName, l.unit AS unit,
        COALESCE(SUM(l.qty),0) AS qty, COALESCE(SUM(l.line_total),0) AS revenue
      FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id
      WHERE i.voided=0 AND i.invoice_date>=? AND i.invoice_date<?
      GROUP BY i.rep_id, l.product_id, l.product_name, l.unit
      ORDER BY revenue DESC`, bounds.start, upto.end) as Array<Record<string, any>>;
    const best = new Map<string, { qty: number; revenue: number; unit: string; topProduct: string }>();
    for (const row of top) {
      const key = String(row.repId ?? '');
      if (best.has(key)) continue;
      best.set(key, { qty: money(row.qty), revenue: money(row.revenue), unit: String(row.unit ?? ''), topProduct: String(row.productName ?? '') });
    }
    // The company's best seller is grouped on its own: summing the per-engineer leaderboard would
    // report the biggest single-rep line, so a product two engineers sold 50 each loses to one
    // engineer who sold 80 — and «الأكثر مبيعًا في الشركة» is a question about the product.
    const companyTop = store.get(`SELECT l.product_name AS productName, l.unit AS unit,
        COALESCE(SUM(l.qty),0) AS qty, COALESCE(SUM(l.line_total),0) AS revenue
      FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id
      WHERE i.voided=0 AND i.invoice_date>=? AND i.invoice_date<?
      GROUP BY l.product_id, l.product_name, l.unit ORDER BY revenue DESC LIMIT 1`,
      bounds.start, upto.end) as Record<string, any> | undefined;
    const company = {
      invoices: money(perRep.reduce((acc, row) => acc + Number(row.invoices), 0)),
      revenue: money(perRep.reduce((acc, row) => acc + Number(row.revenue), 0)),
      collected: money(perRep.reduce((acc, row) => acc + Number(row.collected), 0)),
      outstanding: money(perRep.reduce((acc, row) => acc + Number(row.outstanding), 0)),
      stockShort: perRep.reduce((acc, row) => acc + Number(row.stockShort || 0), 0),
      topProduct: companyTop ? { name: String(companyTop.productName ?? ''), qty: money(companyTop.qty), revenue: money(companyTop.revenue), unit: String(companyTop.unit ?? '') } : null,
    };
    return { perRep, best, company };
  }

  /**
   * Which month's plan the sales figures are measured against: the window's own month when it sits
   * inside one, otherwise the month it ends in — someone looking at «the last 30 days» wants the
   * running month, not the one that closed. Both the screen and the export call this, so the
   * percentage in the Excel file is the percentage on the monitor.
   */
  function kpiTargetMonth(from: string, to: string): string {
    const candidate = from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : to.slice(0, 7);
    return /^\d{4}-\d{2}$/.test(candidate) ? candidate : monthKey();
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
    const sales = kpiSalesFor(from, to);
    const month = kpiTargetMonth(from, to);
    const targets = store.all('SELECT rep_id, revenue, invoices FROM sales_targets WHERE month=?', month) as Array<Record<string, any>>;
    const targetFor = (id: any) => targets.find(row => String(row.rep_id ?? '') === String(id ?? ''));
    res.json({
      from, to, timezone: config.timezone,
      company: { sales: sales.company, month, target: money(targetFor(null)?.revenue || 0) },
      rows: kpiRowsFor(from, to).map(row => {
        const sold = sales.perRep.find(entry => String(entry.repId ?? '') === String(row.repId));
        const best = sales.best.get(String(row.repId));
        const target = targetFor(row.repId);
        const revenue = money(sold?.revenue || 0);
        const goal = Number(target?.revenue || 0);
        return {
          ...row,
          invoices: Number(sold?.invoices || 0), revenue, collected2: money(sold?.collected || 0),
          outstanding: money(sold?.outstanding || 0), stockShortInvoices: Number(sold?.stockShort || 0),
          topProduct: best?.topProduct ?? '', topProductQty: best?.qty ?? 0, topProductRevenue: best?.revenue ?? 0, topProductUnit: best?.unit ?? '',
          target: money(target?.revenue || 0), targetInvoices: Number(target?.invoices || 0),
          targetProgress: goal > 0 ? Math.round(revenue / goal * 100) : null,
        };
      }),
    });
  });
  const KPI_HEADER = ['المهندس', 'المنطقة', 'أيام النشاط', 'عدد الزيارات', 'متوسط الزيارة (دقيقة)', 'المسافة (كم)', 'التقارير', 'التحصيل (ج.م)', 'التقارير اليومية',
    'فواتير', 'المبيعات (ج.م)', 'المسدد على الفواتير (ج.م)', 'لسه عليه (ج.م)', 'نقص من المخزن', 'الأكثر مبيعًا', 'الهدف الشهري (ج.م)', 'نسبة الهدف %'];
  const KPI_WIDTHS = [26, 18, 12, 14, 16, 12, 12, 14, 14, 10, 16, 16, 16, 12, 22, 18, 14];
  function kpiExportRows(from: string, to: string): CellValue[][] {
    const sales = kpiSalesFor(from, to);
    const month = kpiTargetMonth(from, to);
    const targets = store.all('SELECT rep_id, revenue FROM sales_targets WHERE month=?', month) as Array<Record<string, any>>;
    return byActivity(kpiRowsFor(from, to)).map(r => {
      const sold = sales.perRep.find(entry => String(entry.repId ?? '') === String(r.repId));
      const best = sales.best.get(String(r.repId));
      const target = Number(targets.find(row => String(row.rep_id ?? '') === String(r.repId))?.revenue || 0);
      return [
        r.name, r.region, r.daysWithData, r.visits, r.avgVisitSeconds ? Math.round(r.avgVisitSeconds / 60) : 0,
        Number((r.distanceMeters / 1000).toFixed(1)), r.reports, r.collected, r.dailyReports,
        Number(sold?.invoices || 0), money(sold?.revenue || 0), money(sold?.collected || 0), money(sold?.outstanding || 0),
        Number(sold?.stockShort || 0), best ? `${best.topProduct} (${best.qty} ${best.unit})` : '', target,
        target > 0 ? Math.round(Number(sold?.revenue || 0) / target * 100) : '',
      ];
    });
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
    const ownerId = res.locals.user.id;
    const existing = store.get('SELECT user_id AS userId FROM reports WHERE id=?', data.id);
    if (existing && existing.userId !== ownerId) {
      res.status(409).json({ error: 'معرّف التقرير مستخدم بالفعل.', code: 'REPORT_ID_IN_USE' });
      return;
    }
    const shift = store.get('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', ownerId);
    const now = Date.now();
    const result = store.run(`INSERT OR IGNORE INTO reports(id,user_id,shift_id,type,title,body,customer,amount,lat,lng,accuracy,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'new',?)`, data.id, ownerId, shift?.id || null, data.type, data.title, data.body, data.customer, data.amount,
      data.location?.lat ?? null, data.location?.lng ?? null, data.location?.accuracy ?? null, now);
    const report = reportRow(data.id);
    // Re-check the row returned by INSERT OR IGNORE as well: another writer may have claimed
    // the same id after the first lookup. An idempotent replay is only valid for its owner.
    if (!report || report.userId !== ownerId) {
      res.status(409).json({ error: 'معرّف التقرير مستخدم بالفعل.', code: 'REPORT_ID_IN_USE' });
      return;
    }
    if (result.changes) {
      store.audit(ownerId, 'report.create', { reportId: data.id, type: data.type });
      io.to('admins').emit('report', report);
      invalidateKpis(); broadcast();
    }
    res.status(result.changes ? 201 : 200).json({ report, duplicate: !result.changes });
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
      // Keep every manager's open report list in sync, not only the page that clicked review.
      io.to('admins').emit('report', reportRow(report.id));
      invalidateKpis(); broadcast();
    }
    res.json({ report: reportRow(String(req.params.id)) });
  });
  /** The same rule as a visit: the author never removes his own submitted report. */
  app.delete('/api/reports/:id', adminOnly, (req, res) => {
    const report = reportRow(String(req.params.id));
    if (!report) { res.status(404).json({ error: 'التقرير غير موجود.' }); return; }
    store.run('DELETE FROM reports WHERE id=?', report.id);
    store.audit(res.locals.user.id, 'report.delete', { reportId: report.id, repId: report.userId, type: report.type });
    invalidateKpis(); broadcast();
    res.json({ ok: true, report: { id: report.id, userId: report.userId } });
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
  /**
   * Deleting a signed daily report also drops its visit rows (`daily_report_visits` cascades from
   * the report). This is the paper register, so the button exists for a duplicate day — a report
   * sent twice, or sent with yesterday's date — and nothing else.
   */
  app.delete('/api/daily-reports/:id', adminOnly, (req, res) => {
    const report = dailyReportRow(store, String(req.params.id));
    if (!report) { res.status(404).json({ error: 'التقرير غير موجود.' }); return; }
    store.run('DELETE FROM daily_reports WHERE id=?', report.id);
    store.audit(res.locals.user.id, 'daily_report.delete', { reportId: report.id, repId: report.userId, reportDate: report.reportDate });
    invalidateKpis(); broadcast();
    res.json({ ok: true, report: { id: report.id, userId: report.userId, reportDate: report.reportDate } });
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
