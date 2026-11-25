import { createInsightsRouter } from './insights.js';
import { createSalesRouter } from './sales.js';
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
import { elapsedMinutesText } from './elapsedTime.js';
import { newDailyReportSchema, dailyReportRow, listDailyReports, insertDailyReport, validateReportDate } from './dailyReports.js';
import { dailyReportPdf } from './dailyPdf.js';
import { deleteAccountPage, privacyPage } from './privacy.js';
import { OauthError, verifyIdToken } from './oauth.js';
import { verifyTotp } from './totp.js';
import { createAgentRouter } from './agent/router.js';
import { createWarehouseRouter, createStaffRouter } from './warehouse.js';
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
const newRep = z.object({
  name: z.string().trim().min(2).max(80), email: z.email().max(254).transform(x => x.toLowerCase().trim()),
  password: z.string().min(10).max(200), phone: z.string().trim().max(30).default(''), region: z.string().trim().min(1).max(80),
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
/**
 * The company's customer book. The office (manager and his sales team) enters it and decides who serves
 * whom; an engineer's phone reads its own slice and cannot add to it. That asymmetry is the design:
 * a name typed in the field is how one farm ends up as three customers and three numbers.
 */
const CUSTOMER_STAGES = ['new', 'following', 'active', 'dormant', 'lost'] as const;
type CustomerStage = typeof CUSTOMER_STAGES[number];
const customerFields = z.object({
  name: z.string().trim().min(2, 'اسم العميل / المزرعة مطلوب.').max(120),
  phone: z.string().trim().max(30).default(''),
  // The two halves of «where he is» are what the list is divided by. Free text on purpose: the office
  // types طنطا the same way it types المحلة, and the area workbench matches on it.
  governorate: z.string().trim().max(80).default(''),
  district: z.string().trim().max(80).default(''),
  village: z.string().trim().max(120).default(''),
  notes: z.string().trim().max(1000).default(''),
  stage: z.enum(CUSTOMER_STAGES).default('new'),
  lostReason: z.string().trim().max(300).default(''),
});
// repId is only meaningful on create. Null is a real answer — «the company's customer, not handed to
// anybody yet» — and a wrong id is refused rather than quietly read as «nobody».
const newCustomer = customerFields.extend({
  repId: z.uuid('اختار المهندس من القائمة، أو سيبه من غير مهندس يفضل عميل شركة.').nullable().optional(),
  // Which column of the price list he buys at. Null is «nobody decided», which is not the same as a
  // default rate: an order for such a customer is priced by hand, and the invoice keeps what was chosen.
  priceTierId: z.uuid('اختار نوع السعر من القائمة، أو سيبه من غير تحديد يتسعّر باليد.').nullable().optional(),
}).strict();
/**
 * The edit body of the customer book, spelled out field by field instead of `.partial()` — and the
 * difference is how this file used to destroy records.
 *
 * `.partial()` makes every key optional but leaves the create-time defaults attached, so a body of
 * `{ active: false }` parsed into `phone: ''`, `governorate: ''`, `stage: 'new'`, and the route — which
 * writes what the parse produced — stamped those empties over a real customer. Pressing «وقف» on a man in
 * the dashboard erased his phone number and his area. A key the caller did not send has to stay absent,
 * so each default is taken off (`unwrap`) here rather than inherited into the patch.
 */
const patchCustomer = z.object({
  name: customerFields.shape.name.optional(),
  phone: customerFields.shape.phone.unwrap().optional(),
  governorate: customerFields.shape.governorate.unwrap().optional(),
  district: customerFields.shape.district.unwrap().optional(),
  village: customerFields.shape.village.unwrap().optional(),
  notes: customerFields.shape.notes.unwrap().optional(),
  stage: customerFields.shape.stage.unwrap().optional(),
  lostReason: customerFields.shape.lostReason.unwrap().optional(),
  active: z.boolean().optional(),
  // Null is a decision here («من غير تحديد» — price his orders by hand); an absent key is not a decision.
  priceTierId: z.uuid('اختار نوع السعر من القائمة، أو «من غير تحديد» يتسعّر باليد.').nullable().optional(),
}).strict();
/**
 * A visit is booked against a row of the book, not a string. customerName stays accepted and is
 * ignored: a phone that cached an old payload must not be refused for a cosmetic key, and the name on
 * the row comes from the customer, so it cannot drift.
 */
const newVisit = z.object({
  id: z.uuid(),
  customerId: z.uuid('لازم تختار العميل من قائمتك — الزيارة تتسجل على عميل من قائمة الشركة.'),
  customerName: z.string().trim().max(120).optional().default(''),
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

/**
 * The order the field agrees, priced by the office.
 *
 * Two facts ride on one row of this table, and they have two different authors: which farm promised
 * what quantities (the engineer, from the office's own customer book and the office's own catalogue —
 * no hand-typed customer name anywhere, the same rule a visit obeys), and what that came to in money
 * (the office, after the fact). The schemas keep the authors apart: the phone cannot send a price and
 * the office cannot send a line.
 */
const orderLineInput = z.object({
  productId: z.uuid('اختار الصنف من قائمة الأصناف.'),
  // The same bounds the `qty` column enforces (server/src/db.ts): a schema looser than the database
  // turns a typo into a 500 instead of the sentence that names the field.
  qty: z.number().positive('الكمية لازم تكون رقم أكبر من صفر.').lte(100000, 'الكمية دي أكبر من طلبيتين — اقسمها.'),
  notes: z.string().trim().max(300).default(''),
}).strict();
const newOrder = z.object({
  id: z.uuid(),
  customerId: z.uuid('الطلبية تتسجل على عميل من قائمتك — اختاره من القائمة.'),
  visitId: z.uuid().optional(),
  notes: z.string().trim().max(2000).default(''),
  lines: z.array(orderLineInput).min(1, 'الطلبية محتاجة صنف واحد على الأقل.').max(100),
  // A press in the field means «send this»: the draft state exists for a phone that saves its work
  // to keep editing, and the office queue never sees an order that stayed one.
  send: z.boolean().default(true),
  /** The moment the order was actually written, sent by the offline queue like a check-in. */
  recordedAt: z.number().int().nonnegative().optional(),
}).strict();
const patchOrder = z.object({
  notes: z.string().trim().max(2000).optional(),
  // A whole replacement, not a diff: the sheet holds the order, and «replace line 3 only» is a client
  // that thinks it knows a line the server has never seen.
  lines: z.array(orderLineInput).min(1, 'الطلبية محتاجة صنف واحد على الأقل.').max(100).optional(),
}).strict();
const priceOrder = z.object({
  lines: z.array(z.object({
    productId: z.uuid(),
    price: z.number().nonnegative('السعر ما يقلش عن صفر.').lte(1_000_000_000, 'الرقم ده مش سعر وحدة.'),
    // Which price-list column the office used, when they used one: stored, never trusted — the route
    // re-reads the list and refuses a number that disagrees with the type it claims.
    tierId: z.uuid().optional(),
  }).strict()).min(1).max(100),
}).strict();
const sendOrder = z.object({
  /** Same offline window as creating: a replayed send carries the minute the press happened. */
  recordedAt: z.number().int().nonnegative().optional(),
}).strict();

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
  app.use('/api/warehouse', auth, createWarehouseRouter(store));
  app.use('/api/staff', adminOnly, createStaffRouter(store, id => io.in(`user:${id}`).disconnectSockets(true)));
  app.use('/api/sales', adminOnly, createSalesRouter(store,config.timezone,orderId=>{io.to('admins').emit('order',{id:orderId,sold:true});invalidateKpis();broadcast();}));
  app.use('/api/sales-insights', adminOnly, createInsightsRouter(store,config.timezone));
  app.get('/api/work-priorities', adminOnly, (_req, res) => {
    const waitingOrders = store.all(`SELECT o.id,c.name AS customerName,u.name AS repName,o.sent_at AS sentAt
      FROM orders o JOIN customers c ON c.id=o.customer_id JOIN users u ON u.id=o.user_id
      WHERE o.status='sent' AND NOT EXISTS(SELECT 1 FROM office_sales_v1 s WHERE s.order_id=o.id) ORDER BY o.sent_at,o.id LIMIT 10`);
    const orderCount = Number(store.get("SELECT COUNT(*) AS c FROM orders o WHERE o.status='sent' AND NOT EXISTS(SELECT 1 FROM office_sales_v1 s WHERE s.order_id=o.id)")?.c || 0);
    const unassignedCustomers = Number(store.get('SELECT COUNT(*) AS c FROM customers WHERE active=1 AND rep_id IS NULL')?.c || 0);
    const openVisits = store.all(`SELECT v.id,v.customer_name AS customerName,u.name AS repName,v.checked_in_at AS checkedInAt
      FROM visits v JOIN users u ON u.id=v.user_id WHERE v.status='open' ORDER BY v.checked_in_at LIMIT 10`);
    const openVisitCount = Number(store.get("SELECT COUNT(*) AS c FROM visits WHERE status='open'")?.c || 0);
    const emptyStock = store.all(`SELECT w.name AS warehouseName,p.name AS productName,p.unit,p.unit_size AS unitSize
      FROM warehouse_stock s JOIN products p ON p.id=s.product_id JOIN warehouses w ON w.id=s.warehouse_id
      WHERE p.active=1 AND s.milli_qty=0 ORDER BY w.name,p.name LIMIT 20`);
    const emptyStockCount = Number(store.get('SELECT COUNT(*) AS c FROM warehouse_stock s JOIN products p ON p.id=s.product_id WHERE p.active=1 AND s.milli_qty=0')?.c || 0);
    const warehouses = Number(store.get('SELECT COUNT(*) AS c FROM warehouses')?.c || 0);
    const uninitialized = Number(store.get(`SELECT COUNT(*) AS c FROM warehouses w CROSS JOIN products p
      LEFT JOIN warehouse_stock s ON s.warehouse_id=w.id AND s.product_id=p.id WHERE p.active=1 AND s.product_id IS NULL`)?.c || 0);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ waitingOrders,orderCount,unassignedCustomers,openVisits,openVisitCount,emptyStock,emptyStockCount,warehouses,uninitialized });
  });
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
    // The orders tab's badge: what the field sent and the office has not opened yet.
    const sentOrders = (store.get("SELECT COUNT(*) AS c FROM orders o WHERE o.status='sent' AND NOT EXISTS(SELECT 1 FROM office_sales_v1 s WHERE s.order_id=o.id)")?.c as number) || 0;
    const newReports = ((store.get("SELECT COUNT(*) AS c FROM reports WHERE status='new'")?.c as number) || 0)
      + ((store.get("SELECT COUNT(*) AS c FROM daily_reports WHERE status='new'")?.c as number) || 0);
    // The dashboard needs the same staleness threshold the alerts use, otherwise the map and
    // the alert list disagree about who lost their signal.
    return { reps, serverTime: Date.now(), timezone: config.timezone, retentionDays: config.retentionDays, newReports, sentOrders, staleGpsMinutes: config.staleGpsMinutes };
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
    if (!user || user.access_scope === 'warehouse') return next(new Error('Unauthorized'));
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
      const admins = Number(store.get("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1 AND access_scope='full'")?.c || 0);
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
    if (!parsed.success) { res.status(400).json({ error: 'راجع الاسم والبريد وكلمة المرور (١٠ أحرف على الأقل)، واكتب منطقة المهندس.' }); return; }
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
    // name and region join active: the customer book is divided by place, and «ده مهندس طنطا» is only a
    // fact once somebody writes طنطا under his name. Being able to correct that without deleting the
    // account is what makes the area workbench usable. Only the keys that were sent are written.
    const parsed = z.object({
      active: z.boolean().optional(),
      name: z.string().trim().min(2, 'الاسم قصير.').max(80).optional(),
      region: z.string().trim().min(1).max(80).optional(),
    }).strict().refine(value => Object.keys(value).length > 0, { message: 'مفيش حاجة تتغير.' }).safeParse(req.body ?? {});
    const user = store.get("SELECT * FROM users WHERE id=? AND role='rep'", String(req.params.id));
    if (!parsed.success || !user) { res.status(400).json({ error: 'بيانات المهندس أو الحالة غير صحيحة.' }); return; }
    const sets: string[] = []; const params: Array<string | number> = [];
    for (const key of ['name', 'region'] as const) {
      const value = parsed.data[key];
      if (value === undefined) continue;
      sets.push(key + '=?'); params.push(value);
    }
    if (parsed.data.active !== undefined) { sets.push('active=?'); params.push(Number(parsed.data.active)); }
    store.run('UPDATE users SET ' + sets.join(', ') + ' WHERE id=?', ...params, user.id);
    if (parsed.data.active === false) {
      endShift(user.id);
      store.run('DELETE FROM sessions WHERE user_id=?', user.id);
      io.in(`user:${user.id}`).disconnectSockets(true);
    }
    store.audit(res.locals.user.id, parsed.data.active === undefined ? 'rep.update' : (parsed.data.active ? 'rep.enable' : 'rep.disable'),
      { repId: user.id, fields: Object.keys(parsed.data) });
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
      orders: count('SELECT COUNT(*) AS c FROM orders WHERE user_id=?', user.id),
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
      orders: Number(store.get('SELECT COUNT(*) AS c FROM orders WHERE user_id=?', user.id)?.c || 0),
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
  // ---- Field visits: check in / check out around a customer with GPS proof ----
  /* ----------------------------------------------------------------------------- العملاء: قائمة الشركة
   *
   * The book belongs to the office: the manager and his sales team enter it, and they are also the
   * ones who decide which engineer serves which customer. The engineer's phone reads its own slice of
   * it and records visits against it — it cannot add to it, because a name typed in the street is how
   * one farm becomes three customers and three numbers.
   *
   * Nothing here moves a customer on its own. `users.region` matching an area is a text comparison and
   * text is not a map, so it produces a proposal sitting next to a button, and a bulk move answers
   * with a preview before it writes anything.
   */
  const CUSTOMER_SELECT = `SELECT c.*, u.name AS repName, u.color AS repColor, t.name AS priceTierName,
      (SELECT COUNT(*) FROM visits v WHERE v.customer_id=c.id) AS visitCount,
      (SELECT MAX(v.checked_in_at) FROM visits v WHERE v.customer_id=c.id) AS lastVisitAt,
      (SELECT COUNT(*) FROM visits v WHERE v.customer_id=c.id AND v.status='open') AS openVisits
    FROM customers c LEFT JOIN users u ON u.id=c.rep_id
    LEFT JOIN price_tiers t ON t.id=c.price_tier_id`;
  /** A row with no engineer is kept, not dropped: «من غير مهندس» is a state of the list, not an error. */
  const asCustomer = (row: Record<string, any> | undefined) => (row ? {
    id: row.id, repId: row.rep_id ?? null, name: row.name, phone: row.phone,
    governorate: row.governorate, district: row.district, village: row.village, notes: row.notes,
    stage: row.stage, lostReason: row.lost_reason, active: !!row.active,
    priceTierId: row.price_tier_id ?? null, priceTierName: row.priceTierName ?? '',
    createdAt: row.created_at, updatedAt: row.updated_at,
    repName: row.repName ?? 'من غير مهندس', repColor: row.repColor ?? '#94a3b8',
    visitCount: Number(row.visitCount || 0), lastVisitAt: row.lastVisitAt ?? null, openVisits: Number(row.openVisits || 0),
  } : undefined);
  const loadCustomer = (id: unknown) => store.get('SELECT * FROM customers WHERE id=?', String(id)) as Record<string, any> | undefined;
  /** A stopped type cannot be chosen for a new customer — it is a heading the office put away on purpose. */
  const loadActiveTier = (id: unknown) => store.get('SELECT id, name FROM price_tiers WHERE id=? AND active=1', String(id)) as { id: string; name: string } | undefined;
  const findActiveRep = (id: unknown) => store.get("SELECT id, name FROM users WHERE id=? AND role='rep' AND active=1", String(id)) as { id: string; name: string } | undefined;

  app.get('/api/customers', auth, (req, res) => {
    const isAdmin = res.locals.user.role === 'admin';
    const where: string[] = []; const params: any[] = [];
    // An engineer never queries his way into a colleague's list; the office sees everyone's.
    if (!isAdmin) { where.push('c.rep_id=?'); params.push(res.locals.user.id); }
    else if (typeof req.query.repId === 'string' && req.query.repId) { where.push('c.rep_id=?'); params.push(req.query.repId); }
    if (!isAdmin || req.query.includeInactive !== '1') where.push('c.active=1');
    if (isAdmin && req.query.unassigned === '1') where.push('c.rep_id IS NULL');
    for (const key of ['governorate', 'district'] as const) {
      const value = typeof req.query[key] === 'string' ? String(req.query[key]).trim() : '';
      if (isAdmin && value) { where.push(`c.${key}=?`); params.push(value); }
    }
    const stage = (CUSTOMER_STAGES as readonly string[]).includes(String(req.query.stage)) ? String(req.query.stage) : '';
    if (stage) { where.push('c.stage=?'); params.push(stage); }
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    if (q) { where.push('(c.name LIKE ? OR c.phone LIKE ? OR c.village LIKE ? OR c.district LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    const limit = Math.min(500, Math.max(1, Math.floor(Number(req.query.limit) || 300)));
    const offset = Math.max(0, Math.min(1_000_000, Math.floor(Number(req.query.offset) || 0)));
    const rows = store.all(`${CUSTOMER_SELECT} WHERE ${where.length ? where.join(' AND ') : '1=1'}
      ORDER BY c.name COLLATE NOCASE, c.id LIMIT ? OFFSET ?`, ...params, limit + 1, offset) as Array<Record<string, any>>;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ customers: rows.slice(0, limit).map(row => asCustomer(row)!), hasMore: rows.length > limit });
  });

  app.post('/api/customers', adminOnly, (req, res) => {
    const parsed = newCustomer.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات العميل غير صحيحة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) });
      return;
    }
    let owner: { id: string; name: string } | undefined;
    if (parsed.data.repId) {
      owner = findActiveRep(parsed.data.repId);
      if (!owner) { res.status(404).json({ error: 'المهندس غير موجود أو حسابه متوقف.' }); return; }
    }
    let tier: { id: string; name: string } | undefined;
    if (parsed.data.priceTierId) {
      tier = loadActiveTier(parsed.data.priceTierId);
      if (!tier) { res.status(404).json({ error: 'نوع السعر ده مش موجود أو موقوف.', code: 'TIER_NOT_FOUND' }); return; }
    }
    const name = String(parsed.data.name).trim();
    // The office list has no UNIQUE index behind it on purpose (see customers_unassigned_name in
    // db.ts: a unique one would make deleting an engineer fail), so its no-duplicate rule is asked
    // here instead — this route is the only place a company customer is ever created.
    if (!owner && store.get('SELECT id FROM customers WHERE rep_id IS NULL AND name COLLATE NOCASE=?', name)) {
      res.status(409).json({ error: `«${name}» موجود في قائمة الشركة بالفعل — عدّل السطر الموجود بدل إضافة نسخة.`, code: 'CUSTOMER_EXISTS' }); return;
    }
    const now = Date.now();
    const id = randomUUID();
    try {
      store.run(`INSERT INTO customers(id,rep_id,name,phone,governorate,district,village,notes,stage,lost_reason,price_tier_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, owner?.id ?? null, name, parsed.data.phone, parsed.data.governorate, parsed.data.district, parsed.data.village,
        parsed.data.notes, parsed.data.stage, parsed.data.lostReason, tier?.id ?? null, now, now);
    } catch (error) {
      // The index is the last word for a row that does have an owner, and a duplicated customer is a
      // duplicated sales figure — so the answer says which list the name is already in.
      if (String((error as Error).message).includes('UNIQUE')) {
        res.status(409).json({ error: `«${name}» موجود في قائمة ${owner ? owner.name : 'الشركة'} بالفعل — عدّل السطر الموجود بدل إضافة نسخة.`, code: 'CUSTOMER_EXISTS' });
        return;
      }
      throw error;
    }
    store.audit(res.locals.user.id, 'customer.create', { customerId: id, repId: owner?.id ?? null, name, priceTierId: tier?.id ?? null });
    res.status(201).json({ customer: asCustomer(store.get(`${CUSTOMER_SELECT} WHERE c.id=?`, id)) });
  });

  /** The office edits the book; an engineer reads his slice of it and records visits on it. */
  app.patch('/api/customers/:id', adminOnly, (req, res) => {
    const current = loadCustomer(req.params.id);
    if (!current) { res.status(404).json({ error: 'العميل غير موجود.' }); return; }
    const parsed = patchCustomer.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات العميل غير صحيحة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) });
      return;
    }
    // «مرفوض» without a reason is how a lost customer becomes nobody's mistake.
    if (parsed.data.stage === 'lost' && !String(parsed.data.lostReason ?? current.lost_reason ?? '').trim()) {
      res.status(400).json({ error: 'اكتب سبب رفض العميل قبل ما تقفله.', code: 'LOST_REASON_REQUIRED' }); return;
    }
    /**
     * The row is stored in snake_case and the body arrives in camelCase, so every column is taken from one
     * of the two by name — never from a spread of both. A spread reads `lostReason` off a row whose column
     * is `lost_reason`, comes back undefined, and `?? ''` turns that into a blank: an edit of a customer's
     * phone number used to erase the reason he was refused, and `unit_size` did the same to an item's pack.
     */
    const keep = (sent: string | undefined, column: unknown) => (sent === undefined ? String(column ?? '') : sent);
    const name = String(parsed.data.name ?? current.name).trim();
    const phone = keep(parsed.data.phone, current.phone);
    const governorate = keep(parsed.data.governorate, current.governorate);
    const district = keep(parsed.data.district, current.district);
    const village = keep(parsed.data.village, current.village);
    const notes = keep(parsed.data.notes, current.notes);
    const stage = parsed.data.stage ?? current.stage;
    const lostReason = keep(parsed.data.lostReason, current.lost_reason);
    if (current.rep_id === null && name !== String(current.name).trim()
      && store.get('SELECT id FROM customers WHERE rep_id IS NULL AND name COLLATE NOCASE=? AND id<>?', name, current.id)) {
      res.status(409).json({ error: `«${name}» موجود في قائمة الشركة بالفعل — ادمج العميلين الأول.`, code: 'CUSTOMER_EXISTS' }); return;
    }
    // Sending the same type back is not a change, and clearing it (null) is: «من غير تحديد» is an answer
    // the office gives on purpose when a man's rate is being argued about.
    let tierId = current.price_tier_id ?? null;
    if (parsed.data.priceTierId !== undefined) {
      if (parsed.data.priceTierId === null) tierId = null;
      else {
        const chosen = loadActiveTier(parsed.data.priceTierId);
        if (!chosen) { res.status(404).json({ error: 'نوع السعر ده مش موجود أو موقوف.', code: 'TIER_NOT_FOUND' }); return; }
        tierId = chosen.id;
      }
    }
    try {
      store.run(`UPDATE customers SET name=?, phone=?, governorate=?, district=?, village=?, notes=?, stage=?, lost_reason=?, price_tier_id=?, active=?, updated_at=?
        WHERE id=?`,
      name, phone, governorate, district, village, notes, stage, lostReason,
        tierId, parsed.data.active === undefined ? current.active : (parsed.data.active ? 1 : 0),
        Date.now(), current.id);
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) {
        res.status(409).json({ error: `«${name}» موجود في قائمة ${current.rep_id ? 'المهندس ده' : 'الشركة'} بالفعل — ادمج العميلين الأول.`, code: 'CUSTOMER_EXISTS' });
        return;
      }
      throw error;
    }
    store.audit(res.locals.user.id, 'customer.update', { customerId: current.id, fields: Object.keys(parsed.data) });
    invalidateKpis(); broadcast();
    res.json({ customer: asCustomer(store.get(`${CUSTOMER_SELECT} WHERE c.id=?`, current.id)) });
  });

  /**
   * Delete only while nothing was ever recorded on him. The moment a visit points at the row, deleting
   * the customer takes his history with him — stopping him keeps both.
   */
  app.delete('/api/customers/:id', adminOnly, (req, res) => {
    const current = loadCustomer(req.params.id);
    if (!current) { res.status(404).json({ error: 'العميل غير موجود.' }); return; }
    const visits = Number(store.get('SELECT COUNT(*) AS c FROM visits WHERE customer_id=?', current.id)?.c || 0);
    if (visits) {
      res.status(409).json({ error: `العميل عليه ${visits} زيارة — وقّفه بدل الحذف عشان تاريخه يفضل مرتبط بيه.`, code: 'CUSTOMER_HAS_VISITS' });
      return;
    }
    // An order is the same kind of history as a visit: the office priced it, the total is in the book,
    // and deleting the customer underneath would leave the row pointing at nobody. Stop the customer
    // instead — the order keeps its name and its lines.
    const orders = Number(store.get('SELECT COUNT(*) AS c FROM orders WHERE customer_id=?', current.id)?.c || 0);
    if (orders) {
      res.status(409).json({ error: `العميل عليه ${orders} طلبية — وقّفه بدل الحذف عشان تاريخه يفضل مرتبط بيه.`, code: 'CUSTOMER_HAS_ORDERS' });
      return;
    }
    if (store.get('SELECT 1 FROM office_sales_v1 WHERE customer_id=? LIMIT 1', current.id)
      || store.get('SELECT 1 FROM office_debts_v1 WHERE customer_id=? LIMIT 1', current.id)
      || store.get('SELECT 1 FROM office_receipts_v1 WHERE customer_id=? LIMIT 1', current.id)) {
      res.status(409).json({ error: 'العميل عليه سجل مبيعات أو مديونية — وقّفه بدل الحذف للحفاظ على الحساب.', code: 'CUSTOMER_HAS_SALES' }); return;
    }
    store.run('DELETE FROM customers WHERE id=?', current.id);
    store.audit(res.locals.user.id, 'customer.delete', { name: current.name, repId: current.rep_id ?? null });
    res.json({ ok: true });
  });

  /**
   * One customer at a time — including back to the office list. Taking a customer off a man who left or
   * who travels is the same move as handing him to a new one, and the office owns both directions.
   */
  app.post('/api/customers/:id/assign', adminOnly, (req, res) => {
    const parsed = z.object({ repId: z.uuid('اختار المهندس، أو «من غير مهندس» لو العميل هيرجع قائمة الشركة.').nullable() }).strict().safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'اختار المهندس.' }); return; }
    const current = loadCustomer(req.params.id);
    if (!current) { res.status(404).json({ error: 'العميل غير موجود.' }); return; }
    const from = current.rep_id ?? null;
    if (parsed.data.repId === null) {
      if (from === null) { res.json({ ok: true, unchanged: true, customer: asCustomer(current) }); return; }
      if (store.get('SELECT id FROM customers WHERE rep_id IS NULL AND name COLLATE NOCASE=? AND id<>?', current.name, current.id)) {
        res.status(409).json({ error: `«${current.name}» موجود بالفعل في قائمة الشركة — ادمج العميلين الأول.`, code: 'CUSTOMER_EXISTS' }); return;
      }
      store.run('UPDATE customers SET rep_id=NULL, updated_at=? WHERE id=?', Date.now(), current.id);
      store.audit(res.locals.user.id, 'customer.assign', { customerId: current.id, from, to: null });
      res.json({ ok: true, customer: asCustomer(store.get(`${CUSTOMER_SELECT} WHERE c.id=?`, current.id)) });
      return;
    }
    const owner = findActiveRep(parsed.data.repId);
    if (!owner) { res.status(404).json({ error: 'المهندس غير موجود أو حسابه متوقف.' }); return; }
    if (from === owner.id) { res.json({ ok: true, unchanged: true, customer: asCustomer(store.get(`${CUSTOMER_SELECT} WHERE c.id=?`, current.id)) }); return; }
    // The receiving list is the one that has to be free of the name; saying «merge them first» is the
    // only useful answer, because silently keeping two rows for one farm is what broke the numbers.
    if (store.get('SELECT id FROM customers WHERE rep_id=? AND name COLLATE NOCASE=? AND id<>?', owner.id, current.name, current.id)) {
      res.status(409).json({ error: `«${current.name}» موجود عند ${owner.name} بالفعل — ادمج العميلين قبل النقل.`, code: 'CUSTOMER_EXISTS' }); return;
    }
    store.run('UPDATE customers SET rep_id=?, updated_at=? WHERE id=?', owner.id, Date.now(), current.id);
    store.audit(res.locals.user.id, 'customer.assign', { customerId: current.id, from, to: owner.id });
    invalidateKpis(); broadcast();
    res.json({ ok: true, customer: asCustomer(store.get(`${CUSTOMER_SELECT} WHERE c.id=?`, current.id)) });
  });

  /* ------------------------------------------------------------------ المناطق: مين بيشيل فين
   *
   * The same list read by place instead of by person. This is the screen that answers «كل عملاء طنطا
   * لمهندس طنطا» in one press, and the press is a review: the areas and the suggested engineer come
   * from what the office typed, and a move has to be previewed before it happens.
   */
  /** طنطا = «مركز طنطا» = «الغربية / طنطا »: spaces, the article, and the prefix word are noise. */
  const areaWord = (value: unknown) => {
    let out = String(value ?? '').trim().replace(/\s+/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه');
    // Peel «ال» twice: a doubled «الال» is a real typo in an autocomplete list, and one pass would
    // leave «الغربية» and «غربية» as two different areas of one country.
    for (let i = 0; i < 2; i += 1) out = out.replace(/^ال(?=[\p{L}]{2,})/u, '');
    return out.toLowerCase();
  };
  const areaMatch = (left: unknown, right: unknown) => {
    const a = areaWord(left); const b = areaWord(right);
    if (a.length < 2 || b.length < 2) return false;
    return a === b || a.includes(b) || b.includes(a);
  };

  app.get('/api/customers/areas', adminOnly, (_req, res) => {
    const rows = store.all(`SELECT c.governorate AS governorate, c.district AS district,
        COUNT(*) AS total,
        SUM(CASE WHEN c.rep_id IS NULL THEN 1 ELSE 0 END) AS unassigned,
        SUM(CASE WHEN c.active=0 THEN 1 ELSE 0 END) AS inactive,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM visits v WHERE v.customer_id=c.id) THEN 1 ELSE 0 END) AS visited
      FROM customers c
      GROUP BY c.governorate, c.district
      ORDER BY unassigned DESC, total DESC`) as Array<Record<string, any>>;
    const ownerRows = store.all(`SELECT c.governorate AS governorate, c.district AS district, c.rep_id AS repId,
        u.name AS repName, u.active AS repActive, COUNT(*) AS customers
      FROM customers c JOIN users u ON u.id=c.rep_id
      GROUP BY c.governorate, c.district, c.rep_id`) as Array<Record<string, any>>;
    const engineers = store.all("SELECT id, name, region, color, active FROM users WHERE role='rep' ORDER BY active DESC, name COLLATE NOCASE") as Array<Record<string, any>>;
    const sameArea = (row: Record<string, any>, area: { governorate: string; district: string }) =>
      areaWord(row.governorate) === areaWord(area.governorate)
      && areaWord(row.district) === areaWord(area.district);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      areas: rows.map(row => {
        const area = { governorate: String(row.governorate ?? ''), district: String(row.district ?? '') };
        const owners = ownerRows.filter(item => sameArea(item, area))
          .map(item => ({ repId: String(item.repId), repName: String(item.repName ?? ''), repActive: !!item.repActive, customers: Number(item.customers) }));
        const suggested = engineers.find(item => Number(item.active) && (areaMatch(item.region, area.district) || areaMatch(item.region, area.governorate)));
        return {
          governorate: area.governorate || 'من غير محافظة',
          district: area.district || 'من غير مركز',
          // The move is sent with these, not with the display labels: an area row with no district
          // typed is «district = » in the table, not «district = من غير مركز».
          bareGovernorate: area.governorate, bareDistrict: area.district,
          total: Number(row.total), unassigned: Number(row.unassigned), inactive: Number(row.inactive),
          visited: Number(row.visited),
          // One engineer holding every row here is an area that is done; split between two is the row
          // the manager actually has to look at.
          settled: owners.length > 0 && owners.every(item => item.repId === owners[0].repId),
          owners,
          suggestedRepId: suggested ? String(suggested.id) : null,
          suggestedRepName: suggested ? String(suggested.name) : '',
        };
      }),
      engineers: engineers.map(item => ({ id: String(item.id), name: String(item.name), region: String(item.region ?? ''), color: String(item.color ?? '#94a3b8'), active: !!item.active })),
      totals: {
        customers: Number(store.get('SELECT COUNT(*) AS c FROM customers')?.c || 0),
        unassigned: Number(store.get('SELECT COUNT(*) AS c FROM customers WHERE rep_id IS NULL')?.c || 0),
        areas: rows.length,
      },
    });
  });

  const assignArea = z.object({
    governorate: z.string().trim().max(80).default(''),
    district: z.string().trim().max(80).default(''),
    repId: z.uuid('اختار المهندس، أو «قائمة الشركة» لو عايز ترجّع المنطقة دي لها.').nullable(),
    // The safe half by default: hand out the ones nobody owns, and leave a colleague's customer alone
    // unless the manager said otherwise on purpose.
    onlyUnassigned: z.boolean().default(true),
    dryRun: z.boolean().default(false),
    exactArea: z.boolean().default(false),
  }).strict();

  /** Hand a whole area to an engineer — or take it back to the company's list. */
  app.post('/api/customers/assign-area', adminOnly, (req, res) => {
    const parsed = assignArea.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات المنطقة غير صحيحة.' }); return; }
    const { governorate, district, repId, onlyUnassigned, dryRun, exactArea } = parsed.data;
    if (!governorate && !district) {
      res.status(400).json({ error: 'اختار المنطقة الأول — نقل قائمة الشركة كلها مرة واحدة مش حاجة تتعمل بالغلط.', code: 'AREA_REQUIRED' });
      return;
    }
    let owner: { id: string; name: string } | undefined;
    if (repId) {
      owner = findActiveRep(repId);
      if (!owner) { res.status(404).json({ error: 'المهندس غير موجود أو حسابه متوقف.' }); return; }
    }
    // Back to the pool with «unassigned only» on is the same set on both sides of the move: it would
    // report a change that changed nothing, so the switch to flip is named instead.
    if (!repId && onlyUnassigned) {
      res.status(409).json({ error: 'ترجعهم قائمة الشركة وهم أصلًا من غير مهندس؟ اقفل «اللي من غير مهندس بس» لو عايز ترجّع عملاء مهندس.', code: 'NO_CHANGE' });
      return;
    }
    const where: string[] = []; const params: any[] = [];
    if (governorate || exactArea) { where.push('governorate=?'); params.push(governorate); }
    if (district || exactArea) { where.push('district=?'); params.push(district); }
    if (onlyUnassigned) where.push('rep_id IS NULL');
    else if (repId) { where.push('(rep_id IS NULL OR rep_id<>?)'); params.push(repId); }
    else where.push('rep_id IS NOT NULL');
    // Rows already at the destination do not count as a move or consume the cap.
    // The cap is there so a stray empty filter cannot rewrite the whole customer table in one press,
    // and the answer says when it bit.
    const AREA_LIMIT = 1000;
    const targets = store.all(`SELECT id, name, rep_id AS repId FROM customers
      WHERE ${where.join(' AND ')} ORDER BY name COLLATE NOCASE LIMIT ?`, ...params, AREA_LIMIT) as Array<{ id: string; name: string; repId: string | null }>;
    if (!targets.length) {
      res.status(409).json({ error: 'مافيش عملاء في المنطقة دي يطبّق عليهم النقل.', code: 'NO_CHANGE' });
      return;
    }
    const pool = owner
      ? store.all('SELECT id, name FROM customers WHERE rep_id=?', owner.id) as Array<{ id: string; name: string }>
      : store.all('SELECT id, name FROM customers WHERE rep_id IS NULL') as Array<{ id: string; name: string }>;
    const taken = new Map(pool.map(row => [String(row.name).trim().toLowerCase(), row.id]));
    const conflicts: Array<{ id: string; name: string }> = [];
    const moving: Array<{ id: string; name: string; fromRepId: string | null }> = [];
    const queued = new Set<string>();
    for (const row of targets) {
      const key = String(row.name).trim().toLowerCase();
      const holder = taken.get(key);
      // Either the name already belongs to that owner, or two rows in this area carry one name and only
      // one of them can land there. Either way the rest move, and the reason is in the answer.
      if ((holder !== undefined && holder !== row.id) || queued.has(key)) { conflicts.push({ id: row.id, name: row.name }); continue; }
      queued.add(key);
      moving.push({ id: row.id, name: row.name, fromRepId: row.repId ?? null });
    }
    if (!dryRun && !moving.length && conflicts.length) {
      // Everything matched but nothing can move is not a success, and it is not «nothing to do» either:
      // the fix (merge the two rows) is a different job.
      res.status(409).json({
        error: `كل عملاء المنطقة دي مرفوضين بسبب تعارض اسم عند ${owner?.name || 'قائمة الشركة'} — ادمج العميلين المتعارضين الأول.`,
        code: 'CUSTOMER_EXISTS', conflicts,
      });
      return;
    }
    if (dryRun) {
      res.json({ dryRun: true, governorate, district, repId: owner?.id ?? null, onlyUnassigned, matched: targets.length, wouldMove: moving.length, capped: targets.length === AREA_LIMIT, customers: moving, conflicts });
      return;
    }
    const now = Date.now();
    try {
      store.transaction(() => {
        for (const row of moving) store.run('UPDATE customers SET rep_id=?, updated_at=? WHERE id=?', owner?.id ?? null, now, row.id);
      });
    } catch (error) {
      // The index has the last word, and the move is one transaction: whatever half of it was written
      // is rolled back, and the name in the way is named instead of a stack trace.
      if (String((error as Error).message).includes('UNIQUE')) {
        res.status(409).json({ error: `«${moving[0]?.name || ''}» الاسم ده موجود عند ${owner?.name || 'قائمة الشركة'} بالفعل — ادمج العميلين الأول.`, code: 'CUSTOMER_EXISTS' });
        return;
      }
      throw error;
    }
    store.audit(res.locals.user.id, 'customer.assignArea', { governorate, district, repId: owner?.id ?? null, onlyUnassigned, moved: moving.length, conflicts: conflicts.length });
    invalidateKpis(); broadcast();
    res.json({
      ok: true, governorate, district, repId: owner?.id ?? null, repName: owner?.name ?? '',
      matched: targets.length, moved: moving.length, skipped: conflicts.length, capped: targets.length === AREA_LIMIT,
      conflicts, customers: moving,
    });
  });

  /* ------------------------------------------------------------------ الأصناف: قائمة المكتب
   *
   * The office names the items, the pack they are sold in, and the price per buyer type. The
   * engineer's phone reads the list to build an order and never edits it — and it is not shown the
   * prices at all, because an order is items and quantities, and a number the man in the field quotes
   * from a screen becomes a promise the warehouse did not make.
   *
   * Two rules carry the rest of the design. A unit is never guessed (an item cannot be entered without
   * saying what one pack of it is), and nothing here is deleted once another record points at it:
   * stopping an item keeps every order line that named it readable.
   */
  const asProduct = (row: Record<string, any>, prices?: Array<{ tierId: string; price: number }>) => ({
    id: row.id, name: row.name, category: row.category, unit: row.unit, unitSize: row.unit_size,
    notes: row.notes, active: !!row.active, createdAt: row.created_at, updatedAt: row.updated_at,
    // Prices are added by the caller, and only for the office: an absent key is what a phone gets.
    ...(prices ? { prices } : {}),
  });

  /**
   * Every table whose schema points at `parent`, read from the schema itself.
   *
   * This is how «stop it instead of deleting it» stays true without anyone remembering to update a
   * list: the day an order line or an invoice references `products`, the guard covers it on its own, and
   * the names come from SQLite rather than from a request.
   */
  const referencingTables = (parent: string) => {
    const tables = store.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'") as Array<{ name: string }>;
    const found: Array<{ table: string; column: string }> = [];
    for (const row of tables) {
      if (row.name === parent) continue;
      for (const fk of store.all(`PRAGMA foreign_key_list(${row.name})`) as Array<Record<string, any>>) {
        if (String(fk.table) === parent) found.push({ table: row.name, column: String(fk.from) });
      }
    }
    return found;
  };
  /** Which records hold this row: `[{ table: 'product_prices', rows: 3 }]`. Non-empty means: do not delete. */
  const rowsHolding = (parent: string, id: string) => referencingTables(parent)
    .map(entry => ({ table: entry.table, rows: Number(store.get(`SELECT COUNT(*) AS c FROM ${entry.table} WHERE ${entry.column}=?`, id)?.c || 0) }))
    .filter(entry => entry.rows > 0);

  app.get('/api/products', auth, (req, res) => {
    const isAdmin = res.locals.user.role === 'admin';
    const where: string[] = []; const params: any[] = [];
    if (!isAdmin || req.query.includeInactive !== '1') where.push('p.active=1');
    const category = ['pesticide', 'fertilizer', 'other'].includes(String(req.query.category)) ? String(req.query.category) : '';
    if (category) { where.push('p.category=?'); params.push(category); }
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    if (q) { where.push('(p.name LIKE ? OR p.unit LIKE ? OR p.unit_size LIKE ? OR p.notes LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    // «every item that has no price for this buyer type» is the list the office still has to finish,
    // so it is a filter and not a scroll.
    const unpricedFor = typeof req.query.unpricedFor === 'string' && req.query.unpricedFor ? req.query.unpricedFor : '';
    if (isAdmin && unpricedFor) {
      where.push('p.id NOT IN (SELECT product_id FROM product_prices WHERE tier_id=?)');
      params.push(unpricedFor);
    }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 300));
    const rows = store.all(`SELECT p.* FROM products p
      WHERE ${where.length ? where.join(' AND ') : '1=1'} ORDER BY p.name COLLATE NOCASE LIMIT ?`, ...params, limit) as Array<Record<string, any>>;
    const ids = rows.map(row => String(row.id));
    const prices = isAdmin && ids.length
      ? store.all(`SELECT pp.product_id AS productId, pp.tier_id AS tierId, pp.price AS price
          FROM product_prices pp WHERE pp.product_id IN (${ids.map(() => '?').join(',')})`, ...ids) as Array<Record<string, any>>
      : [];
    const byProduct = new Map<string, Array<{ tierId: string; price: number }>>();
    for (const price of prices) {
      const list = byProduct.get(String(price.productId)) || [];
      list.push({ tierId: String(price.tierId), price: Number(price.price) });
      byProduct.set(String(price.productId), list);
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      // Prices travel to the office only. A phone that never quotes a price cannot be blamed for one.
      // What the field gets is an allow-list, not «the row minus a few keys»: the day a cost or a margin
      // column lands on `products`, it must not reach a phone just because somebody forgot to delete it.
      // `notes` is dropped on purpose too — it is the office telling itself how to store the thing, and
      // nothing on the rep's screen reads it, so nothing in his pocket should carry it.
      products: rows.map(row => {
        const shaped = asProduct(row, isAdmin ? byProduct.get(String(row.id)) ?? [] : undefined);
        return isAdmin ? shaped : { id: shaped.id, name: shaped.name, category: shaped.category, unit: shaped.unit, unitSize: shaped.unitSize, active: shaped.active };
      }),
    });
  });

  const UNIT_HINT = 'قولي الصنف ده بيتبيع إيه: عبوة / شيكارة / جركن — السعر ده للوحدة دي.';
  const productFields = z.object({
    name: z.string().trim().min(2, 'اسم الصنف مطلوب.').max(120),
    category: z.enum(['pesticide', 'fertilizer', 'other']).default('other'),
    // No default, and a required field: «كرتونة» guessed for a bottle is a price read as twelve times
    // its value, and the invoice looks finished while the number is wrong. The emptiness is checked in
    // the route rather than only by zod, because a *missing* key reports «expected string» and this is
    // the one field whose name is the whole point of the field.
    unit: z.string().trim().min(1, UNIT_HINT).max(40).optional(),
    unitSize: z.string().trim().max(60).default(''),
    notes: z.string().trim().max(500).default(''),
  });
  const priceEdits = z.array(z.object({
    tierId: z.uuid(),
    // null clears the price: «no price for this type yet» stays true rather than becoming zero, and a
    // zero price is a free item in every report that adds up later.
    price: z.number().nonnegative('السعر ما يقلش عن صفر.').nullable(),
  }).strict()).max(40).default([]);
  const newProduct = productFields.extend({ prices: priceEdits }).strict();
  // Same rule as the customer book: the row keeps its category, its pack text and its notes unless the
  // call says otherwise — otherwise «وقف الصنف» would quietly reset them.
  // The same trap, the same way out: `category`, `unitSize` and `notes` all carry create-time defaults, so
  // a patch of `{ active: false }` would have reset an item's pack text and moved it under «أخرى» while
  // «وقّف الصنف» was the only thing anybody asked for.
  const patchProduct = z.object({
    name: productFields.shape.name.optional(),
    category: productFields.shape.category.unwrap().optional(),
    // An absent unit keeps the stored one; a blank one is still refused, by min(1) on the shared field.
    unit: productFields.shape.unit.optional(),
    unitSize: productFields.shape.unitSize.unwrap().optional(),
    notes: productFields.shape.notes.unwrap().optional(),
    active: z.boolean().optional(),
  }).strict();

  app.post('/api/products', adminOnly, (req, res) => {
    const parsed = newProduct.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات الصنف غير صحيحة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) });
      return;
    }
    const { prices, ...fields } = parsed.data;
    const tiers = store.all('SELECT id FROM price_tiers') as Array<{ id: string }>;
    const known = new Set(tiers.map(tier => String(tier.id)));
    for (const price of prices) {
      if (!known.has(price.tierId)) { res.status(404).json({ error: 'نوع السعر ده مش في القائمة.', code: 'TIER_NOT_FOUND' }); return; }
    }
    if (new Set(prices.map(price => price.tierId)).size !== prices.length) {
      res.status(400).json({ error: 'نوع سعر متكرر في الطلب — نوع واحد = سعر واحد.' }); return;
    }
    const name = fields.name.trim();
    const unit = (fields.unit ?? '').trim();
    if (!unit) { res.status(400).json({ error: UNIT_HINT, issues: [{ path: ['unit'], message: UNIT_HINT }] }); return; }
    // Same name, same pack = the same item twice, and two rows for one item is two prices for one
    // customer. A different pack is a different item and is allowed.
    if (store.get('SELECT id FROM products WHERE name COLLATE NOCASE=? AND unit COLLATE NOCASE=?', name, unit)) {
      res.status(409).json({ error: `«${name} — ${unit}» موجود في قائمة الأصناف بالفعل.`, code: 'PRODUCT_EXISTS' }); return;
    }
    const now = Date.now();
    const id = randomUUID();
    try {
      store.transaction(() => {
        store.run(`INSERT INTO products(id,name,category,unit,unit_size,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
          id, name, fields.category, unit, fields.unitSize, fields.notes, now, now);
        for (const price of prices) {
          if (price.price === null) continue;
          store.run('INSERT INTO product_prices(product_id,tier_id,price,updated_at) VALUES (?,?,?,?)', id, price.tierId, price.price, now);
        }
      });
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) {
        res.status(409).json({ error: `«${name} — ${unit}» موجود في قائمة الأصناف بالفعل.`, code: 'PRODUCT_EXISTS' }); return;
      }
      throw error;
    }
    store.audit(res.locals.user.id, 'product.create', { productId: id, name, unit, priced: prices.filter((p: { price: number | null }) => p.price !== null).length });
    res.status(201).json({
      product: asProduct(store.get('SELECT * FROM products WHERE id=?', id)!,
        store.all('SELECT tier_id AS tierId, price FROM product_prices WHERE product_id=?', id) as Array<{ tierId: string; price: number }>),
    });
  });

  app.patch('/api/products/:id', adminOnly, (req, res) => {
    const current = store.get('SELECT * FROM products WHERE id=?', String(req.params.id)) as Record<string, any> | undefined;
    if (!current) { res.status(404).json({ error: 'الصنف غير موجود.' }); return; }
    const parsed = patchProduct.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات الصنف غير صحيحة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) });
      return;
    }
    // Column by column, like the customer book: `merged.unitSize` off a row that stores `unit_size` is
    // undefined, and an unrelated edit — stopping an item — would blank the pack text every price depends on.
    const keep = (sent: string | undefined, column: unknown) => (sent === undefined ? String(column ?? '') : sent);
    const name = String(parsed.data.name ?? current.name).trim();
    // An edit that sends no unit keeps the one on the row; one that sends an empty string is refused by
    // min(1) above, because «we never said what this is sold in» is not a thing a price can survive.
    const unit = keep(parsed.data.unit, current.unit).trim();
    if ((unit !== current.unit || (parsed.data.unitSize !== undefined && parsed.data.unitSize !== current.unit_size))
      && store.get('SELECT 1 AS x FROM warehouse_stock WHERE product_id=? LIMIT 1', current.id)) {
      res.status(409).json({ error: 'الصنف له رصيد مسجّل؛ تغيير الوحدة أو العبوة يغيّر معنى الرصيد. أضف صنفًا جديدًا بدلًا من ذلك.' }); return;
    }
    if (!unit) { res.status(400).json({ error: UNIT_HINT, issues: [{ path: ['unit'], message: UNIT_HINT }] }); return; }
    // Renaming into another item's slot is the same duplicate, so it is refused the same way — and the
    // message says which one is in the way.
    const clash = store.get('SELECT id, name FROM products WHERE name COLLATE NOCASE=? AND unit COLLATE NOCASE=? AND id<>?', name, unit, current.id) as { id: string; name: string } | undefined;
    if (clash) {
      res.status(409).json({ error: `«${name} — ${unit}» هو «${clash.name}» الموجود بالفعل. عدّل السطر اللي موجود بدل ما تعمل صنفين.`, code: 'PRODUCT_EXISTS' });
      return;
    }
    store.run(`UPDATE products SET name=?, category=?, unit=?, unit_size=?, notes=?, active=?, updated_at=? WHERE id=?`,
      name, parsed.data.category ?? current.category, unit,
      keep(parsed.data.unitSize, current.unit_size), keep(parsed.data.notes, current.notes),
      parsed.data.active === undefined ? current.active : (parsed.data.active ? 1 : 0), Date.now(), current.id);
    store.audit(res.locals.user.id, 'product.update', { productId: current.id, fields: Object.keys(parsed.data) });
    res.json({
      product: asProduct(store.get('SELECT * FROM products WHERE id=?', current.id)!,
        store.all('SELECT tier_id AS tierId, price FROM product_prices WHERE product_id=?', current.id) as Array<{ tierId: string; price: number }>),
    });
  });

  /**
   * Every price of one item, in one call — that is how a price list actually gets edited: the whole
   * row is written at once, so «جملة اتزودت ونصف جملة لأ» cannot arrive as two half-finished requests.
   */
  app.put('/api/products/:id/prices', adminOnly, (req, res) => {
    const current = store.get('SELECT * FROM products WHERE id=?', String(req.params.id)) as Record<string, any> | undefined;
    if (!current) { res.status(404).json({ error: 'الصنف غير موجود.' }); return; }
    const parsed = z.object({ prices: priceEdits }).strict().safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'الأسعار غير صحيحة.' }); return; }
    const { prices } = parsed.data;
    const known = new Set((store.all('SELECT id FROM price_tiers') as Array<{ id: string }>).map(tier => String(tier.id)));
    const missing = prices.filter(price => !known.has(price.tierId)).map(price => price.tierId);
    if (missing.length) { res.status(404).json({ error: 'في نوع سعر مش موجود في القائمة.', code: 'TIER_NOT_FOUND', missing }); return; }
    if (new Set(prices.map(price => price.tierId)).size !== prices.length) {
      res.status(400).json({ error: 'نوع سعر متكرر في الطلب — نوع واحد = سعر واحد.' }); return;
    }
    const now = Date.now();
    // Types not mentioned in the call are left alone: the screen that edits «جملة» only must not wipe the
    // rest of the row by omission.
    store.transaction(() => {
      for (const price of prices) {
        if (price.price === null) store.run('DELETE FROM product_prices WHERE product_id=? AND tier_id=?', current.id, price.tierId);
        else store.run(`INSERT INTO product_prices(product_id,tier_id,price,updated_at) VALUES (?,?,?,?)
          ON CONFLICT(product_id,tier_id) DO UPDATE SET price=excluded.price, updated_at=excluded.updated_at`,
        current.id, price.tierId, price.price, now);
      }
    });
    store.audit(res.locals.user.id, 'product.prices', {
      productId: current.id,
      set: prices.filter(price => price.price !== null).map(price => ({ tierId: price.tierId, price: price.price })),
      cleared: prices.filter(price => price.price === null).map(price => price.tierId),
    });
    res.json({
      product: asProduct(current,
        store.all('SELECT tier_id AS tierId, price FROM product_prices WHERE product_id=?', current.id) as Array<{ tierId: string; price: number }>),
    });
  });

  /** Deleting is only possible while nothing points at the item; otherwise it is stopped. */
  app.delete('/api/products/:id', adminOnly, (req, res) => {
    if (store.get('SELECT 1 AS x FROM inventory_movements WHERE product_id=? LIMIT 1', String(req.params.id)) || store.get('SELECT 1 AS x FROM warehouse_stock WHERE product_id=? LIMIT 1', String(req.params.id))) { res.status(409).json({ error: 'الصنف له سجل مخزون — وقّفه بدل الحذف للحفاظ على الحركات.', code: 'PRODUCT_HAS_STOCK' }); return; }
    const current = store.get('SELECT * FROM products WHERE id=?', String(req.params.id)) as Record<string, any> | undefined;
    if (!current) { res.status(404).json({ error: 'الصنف غير موجود.' }); return; }
    const holders = rowsHolding('products', current.id).filter(entry => entry.table !== 'product_prices');
    if (holders.length) {
      const summary = holders.map(entry => `${entry.rows} سطر في ${entry.table}`).join('، ');
      res.status(409).json({ error: `الصنف ده مستخدم: ${summary}. وقّفه بدل الحذف عشان السجلات اللي اسمه فيها تفضل مقروءة.`, code: 'PRODUCT_IN_USE' });
      return;
    }
    store.run('DELETE FROM products WHERE id=?', current.id);
    store.audit(res.locals.user.id, 'product.delete', { name: current.name, unit: current.unit });
    // Its own prices go with it — a price for an item nobody sells is noise, which is the opposite of
    // the customer case above, where the history is the point.
    res.json({ ok: true });
  });

  /* -------------------------------------------------------- أنواع المشترى: راس قائمة الأسعار
   *
   * The office names these; the columns of the price list are exactly this list. Deleting a type that
   * still holds prices is refused, because cascade would take twenty prices with it to remove one
   * heading — stopping it keeps the numbers for the day the type comes back.
   */
  const tierSelect = `SELECT t.*,
      (SELECT COUNT(*) FROM product_prices pp WHERE pp.tier_id=t.id) AS priced,
      (SELECT COUNT(*) FROM customers c WHERE c.price_tier_id=t.id) AS customers
    FROM price_tiers t`;
  const asTier = (row: Record<string, any>) => ({
    id: row.id, name: row.name, position: Number(row.position), active: !!row.active,
    priced: Number(row.priced || 0), customers: Number(row.customers || 0),
  });
  const tierFields = z.object({
    name: z.string().trim().min(2, 'اكتب اسم نوع السعر — «جملة»، «نصف جملة»، «تجزئة»…').max(60),
    position: z.number().int().min(0).max(99).optional(),
  });

  app.get('/api/price-tiers', adminOnly, (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ tiers: (store.all(`${tierSelect} ORDER BY t.active DESC, t.position, t.name COLLATE NOCASE`) as Array<Record<string, any>>).map(row => asTier(row)) });
  });

  app.post('/api/price-tiers', adminOnly, (req, res) => {
    const parsed = tierFields.extend({ position: z.number().int().min(0).max(99).optional() }).strict().safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'اسم نوع السعر مطلوب.' }); return; }
    const name = parsed.data.name.trim();
    if (store.get('SELECT id, active FROM price_tiers WHERE name COLLATE NOCASE=?', name)) {
      res.status(409).json({ error: `«${name}» موجود في قائمة الأنواع بالفعل.`, code: 'TIER_EXISTS' }); return;
    }
    const top = Number(store.get('SELECT COALESCE(MAX(position), -1) AS m FROM price_tiers')?.m ?? -1);
    const id = randomUUID();
    store.run('INSERT INTO price_tiers(id,name,position,created_at,updated_at) VALUES (?,?,?,?,?)',
      id, name, parsed.data.position ?? top + 1, Date.now(), Date.now());
    store.audit(res.locals.user.id, 'tier.create', { tierId: id, name });
    res.status(201).json({ tier: asTier(store.get(`${tierSelect} WHERE t.id=?`, id)!) });
  });

  app.patch('/api/price-tiers/:id', adminOnly, (req, res) => {
    const current = store.get('SELECT * FROM price_tiers WHERE id=?', String(req.params.id)) as Record<string, any> | undefined;
    if (!current) { res.status(404).json({ error: 'نوع السعر غير موجود.' }); return; }
    const parsed = tierFields.partial().extend({ active: z.boolean().optional() }).strict().safeParse(req.body ?? {});
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: parsed.success ? 'مفيش حاجة تتغير.' : parsed.error.issues[0]?.message || 'بيانات غير صحيحة.' });
      return;
    }
    const name = parsed.data.name === undefined ? current.name : parsed.data.name.trim();
    if (name !== current.name && store.get('SELECT id FROM price_tiers WHERE name COLLATE NOCASE=? AND id<>?', name, current.id)) {
      res.status(409).json({ error: `«${name}» موجود بالفعل كنوع تاني في القائمة.`, code: 'TIER_EXISTS' }); return;
    }
    // Stopping the only active type would leave the price list with no column to price anything under.
    if (parsed.data.active === false) {
      const activeOthers = Number(store.get('SELECT COUNT(*) AS c FROM price_tiers WHERE active=1 AND id<>?', current.id)?.c || 0);
      if (!activeOthers) {
        res.status(409).json({ error: 'ده نوع السعر الوحيد الشغال — الوقف بيسيب القائمة من غير عمود. اعمل واحد تاني الأول.', code: 'LAST_TIER' });
        return;
      }
    }
    store.run('UPDATE price_tiers SET name=?, position=?, active=?, updated_at=? WHERE id=?',
      name, parsed.data.position ?? current.position, parsed.data.active === undefined ? current.active : (parsed.data.active ? 1 : 0),
      Date.now(), current.id);
    store.audit(res.locals.user.id, 'tier.update', { tierId: current.id, fields: Object.keys(parsed.data) });
    res.json({ tier: asTier(store.get(`${tierSelect} WHERE t.id=?`, current.id)!) });
  });

  app.delete('/api/price-tiers/:id', adminOnly, (req, res) => {
    const current = store.get('SELECT * FROM price_tiers WHERE id=?', String(req.params.id)) as Record<string, any> | undefined;
    if (!current) { res.status(404).json({ error: 'نوع السعر غير موجود.' }); return; }
    const priced = Number(store.get('SELECT COUNT(*) AS c FROM product_prices WHERE tier_id=?', current.id)?.c || 0);
    if (priced) {
      res.status(409).json({ error: `${priced} صنف ليه سعر تحت «${current.name}» — الحذف يمسح الأسعار دي. وقّف النوع بدل الحذف.`, code: 'TIER_HAS_PRICES' });
      return;
    }
    // Customers keep being quoted at a rate that no longer exists, so the link clears and the answer
    // says how many men the office now has to price by hand.
    const unquoted = Number(store.get('SELECT COUNT(*) AS c FROM customers WHERE price_tier_id=?', current.id)?.c || 0);
    store.run('DELETE FROM price_tiers WHERE id=?', current.id);
    store.audit(res.locals.user.id, 'tier.delete', { name: current.name, unquoted });
    res.json({ ok: true, unquoted });
  });

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
      // The name is no longer something the phone types, so the message that used to ask for it has to
      // say what is actually missing — otherwise an older build reading this text fixes the wrong field.
      res.status(400).json({ error: 'اختار العميل من قائمتك الأول — الزيارة ما تتسجلش على اسم مكتوب بإيدك.', code: 'CUSTOMER_REQUIRED', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return;
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
    // The book is the only source of a customer's name: the visit is written with the name the office
    // typed, so «محمود» on a phone and «مزرعة محمود» in the dashboard cannot become two ledgers for one
    // farm. A replay of a visit that is already stored short-circuited above, so a queued visit is
    // never refused because the office moved its customer in the meantime.
    const customer = store.get('SELECT id, name, phone, governorate, district, village, active, rep_id AS repId FROM customers WHERE id=?', data.customerId) as Record<string, any> | undefined;
    if (!customer) {
      res.status(400).json({ error: 'العميل ده مش في قائمة الشركة. اختار واحد موجود، أو اطلب من المكتب يضيفه.', code: 'CUSTOMER_NOT_FOUND' });
      return;
    }
    if (customer.repId !== res.locals.user.id) {
      // The engineer does not choose who he serves, and the phone is not asked to enforce that — the
      // list it was given is already his, and this is where a hand-crafted request stops.
      res.status(403).json({ error: 'العميل ده مش من قائمتك — المكتب هو اللي بيحدد مين يخدم كل عميل.', code: 'CUSTOMER_NOT_YOURS' });
      return;
    }
    if (!customer.active) {
      res.status(409).json({ error: 'العميل متوقف. لو لازم يتزار، خلّي المكتب يرجّعه من شاشة العملاء.', code: 'CUSTOMER_INACTIVE' });
      return;
    }

    const closedOnArrival = Boolean(open);
    store.run(`INSERT INTO visits(id,user_id,customer_name,customer_id,governorate,district,village,phone,purpose,notes,status,checked_in_at,checked_out_at,duration_seconds,auto_closed,recorded_offline,outcome,in_lat,in_lng,in_accuracy,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, data.id, res.locals.user.id, String(customer.name), customer.id,
      // The address halves fall back to the row: the phone sends what its GPS resolved, and what it did
      // not, the office already knows.
      data.governorate || String(customer.governorate || ''), data.district || String(customer.district || ''),
      data.village || String(customer.village || ''), data.phone || String(customer.phone || ''), data.purpose, data.notes,
      closedOnArrival ? 'closed' : 'open', checkedInAt, closedOnArrival ? checkedInAt : null,
      closedOnArrival ? 0 : null, closedOnArrival ? 1 : 0, offline ? 1 : 0,
      closedOnArrival ? AUTO_CLOSED_OUTCOME : '',
      data.location.lat, data.location.lng, data.location.accuracy ?? null, now);
    store.audit(res.locals.user.id, offline ? 'visit.check_in_offline' : 'visit.check_in',
      { visitId: data.id, purpose: data.purpose, customerId: customer.id, ...(offline ? { recordedAt: checkedInAt } : {}) });
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
  /* ----------------------------------------------------------------- الطلبيات: الميدان يسجلها، المكتب يسعّرها
   *
   * The workflow is two moves and nothing else: the engineer writes «what the farm took» against one
   * of his own customers and presses send, the office's queue lights up, and somebody at a desk puts
   * the prices on it. Each side can only write its half — the phone has no price field to fill, and
   * the office cannot move a line — and each side never sees the other's private part: no price
   * travels back to a device that stands in front of the farmer.
   */
  const ORDER_SELECT = `SELECT o.id, o.customer_id AS customerId, o.visit_id AS visitId, o.user_id AS userId,
      c.name AS customerName, c.phone AS customerPhone, c.price_tier_id AS customerTierId, t.name AS customerTierName,
      u.name AS repName, u.color AS repColor,
      o.status, o.notes, o.total, o.recorded_offline AS recordedOffline,
      EXISTS(SELECT 1 FROM office_sales_v1 s WHERE s.order_id=o.id) AS sold,
      o.created_at AS createdAt, o.updated_at AS updatedAt, o.sent_at AS sentAt,
      o.priced_at AS pricedAt, pb.name AS pricedByName
    FROM orders o
    JOIN customers c ON c.id=o.customer_id
    LEFT JOIN price_tiers t ON t.id=c.price_tier_id
    JOIN users u ON u.id=o.user_id
    LEFT JOIN users pb ON pb.id=o.priced_by`;
  function orderLineRows(orderId: string, withPrices: boolean) {
    return store.all(`SELECT id, position, product_id AS productId, product_name AS productName,
        unit, unit_size AS unitSize, qty, notes${withPrices ? ', tier_id AS tierId, price' : ''}
      FROM order_lines WHERE order_id=? ORDER BY position`, orderId) as Array<Record<string, any>>;
  }
  function orderRow(id: string, audience: 'rep' | 'office') {
    const row = store.get(`${ORDER_SELECT} WHERE o.id=?`, id) as Record<string, any> | undefined;
    if (!row) return undefined;
    const withPrices = audience === 'office';
    const shaped: Record<string, any> = {
      id: row.id, customerId: row.customerId, status: row.status, sold:Boolean(row.sold), notes: row.notes,
      customerName: row.customerName, recordedOffline: Boolean(row.recordedOffline),
      createdAt: row.createdAt, sentAt: row.sentAt ?? null,
      lines: orderLineRows(id, withPrices),
    };
    if (withPrices) {
      shaped.visitId = row.visitId ?? null;
      shaped.customerPhone = row.customerPhone;
      shaped.customerTierId = row.customerTierId ?? null;
      shaped.customerTierName = row.customerTierName ?? '';
      shaped.repName = row.repName; shaped.repColor = row.repColor;
      shaped.total = row.total ?? null;
      shaped.pricedAt = row.pricedAt ?? null;
      shaped.pricedByName = row.pricedByName ?? null;
    }
    return shaped;
  }
  /**
   * Resolve every line against the catalogue and freeze what the office will read: a line is stored
   * with the name and the pack as they were that day, so renaming «شيكارة» to «جوال» next month does
   * not rewrite a promise the yard already heard. Returns the reason in words — the phone shows this
   * sentence verbatim, and it is the difference between «حدّث القائمة» and a stack trace.
   */
  function resolveOrderLines(lines: Array<{ productId: string; qty: number; notes: string }>) {
    const ids = lines.map(line => line.productId);
    if (new Set(ids).size !== ids.length) return { error: 'في صنف متكرر في الطلبية — زوّد عدده بدل ما تضيف سطر تاني.' } as const;
    const rows = store.all(`SELECT id, name, unit, unit_size AS unitSize, active FROM products WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) as Array<Record<string, any>>;
    const byId = new Map(rows.map(row => [String(row.id), row]));
    if (ids.some(id => !byId.get(id))) return { error: 'في صنف مش موجود في قائمة الأصناف — حدّث القائمة من التطبيق وابعث تاني.' } as const;
    const stopped = ids.filter(id => !byId.get(id)!.active);
    if (stopped.length) {
      const names = stopped.map(id => `«${byId.get(id)!.name}»`).join('، ');
      return { error: `${names} موقوف من القائمة — ما يتسجلش في طلبية جديدة. لو لازم يترجعلها سطر، المكتب يفكّ إيقافه.` } as const;
    }
    return {
      resolved: lines.map(line => {
        const product = byId.get(line.productId)!;
        return {
          productId: String(product.id), name: String(product.name), unit: String(product.unit),
          unitSize: String(product.unitSize ?? ''), qty: line.qty, notes: line.notes,
        };
      }),
    } as const;
  }
  /** The customer gate a visit already obeys — an order is booked the same way and refuses the same three ways. */
  function orderCustomerGate(repId: string, customerId: string) {
    const customer = store.get('SELECT id, name, active, rep_id AS repId FROM customers WHERE id=?', customerId) as Record<string, any> | undefined;
    if (!customer) return { error: 'العميل ده مش في قائمة الشركة. اختار واحد موجود، أو اطلب من المكتب يضيفه.', code: 'CUSTOMER_NOT_FOUND', status: 400 } as const;
    if (customer.repId !== repId) return { error: 'العميل ده مش من قائمتك — المكتب هو اللي بيحدد مين يخدم كل عميل.', code: 'CUSTOMER_NOT_YOURS', status: 403 } as const;
    if (!customer.active) return { error: 'العميل متوقف. لو الطلبية دي لازم تمشي، خلّي المكتب يرجّعه من شاشة العملاء.', code: 'CUSTOMER_INACTIVE', status: 409 } as const;
    return { customer } as const;
  }

  app.post('/api/orders', repOnly, (req, res) => {
    const parsed = newOrder.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات الطلبية غير صحيحة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return; }
    const data = parsed.data;
    // The phone generates the id and the offline queue replays the same body — so a replay answers
    // with the row that already exists, it does not double an agreement the office has already priced.
    const existing = store.get('SELECT id, user_id AS userId FROM orders WHERE id=?', data.id) as { id: string; userId: string } | undefined;
    if (existing) {
      if (existing.userId !== res.locals.user.id) { res.status(409).json({ error: 'معرّف الطلبية مستخدم بالفعل.' }); return; }
      res.status(200).json({ order: orderRow(data.id, 'rep'), duplicate: true }); return;
    }
    const gate = orderCustomerGate(res.locals.user.id, data.customerId);
    if ('error' in gate) { res.status(gate.status ?? 400).json({ error: gate.error, code: gate.code }); return; }
    if (data.visitId !== undefined) {
      const visit = store.get('SELECT id FROM visits WHERE id=? AND user_id=? AND customer_id=?', data.visitId, res.locals.user.id, data.customerId);
      if (!visit) { res.status(400).json({ error: 'الزيارة المرتبطة مش لنفس العميل في سجلّك — اختار زيارته، أو ابعت الطلبية من غير ربط.', code: 'VISIT_NOT_YOURS' }); return; }
    }
    const lines = resolveOrderLines(data.lines);
    if ('error' in lines) { res.status(400).json({ error: lines.error, code: 'ORDER_LINES' }); return; }
    const now = Date.now();
    let sentAt: number | null = null;
    let offline = false;
    if (data.send) {
      if (data.recordedAt !== undefined) {
        const at = Number(data.recordedAt);
        // No shift check here, on purpose: an order agreed by phone from the road never opened a
        // visit and must not need one — only the «he is inventing last week» guard applies.
        const reason = at > now + 60000 ? 'الوقت المرسل في المستقبل.'
          : at < now - OFFLINE_WINDOW_MS ? 'الطلبية أقدم من ٢٤ ساعة، مش ممكن تتبعت بأثر رجعي.' : '';
        if (reason) { res.status(422).json({ error: `الطلبية المتأخرة مرفوضة: ${reason}`, code: 'OFFLINE_ORDER_REJECTED' }); return; }
        sentAt = at; offline = true;
      } else sentAt = now;
    }
    try {
      store.transaction(() => {
        store.run(`INSERT INTO orders(id,user_id,customer_id,visit_id,status,notes,recorded_offline,created_at,updated_at,sent_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, data.id, res.locals.user.id, data.customerId, data.visitId ?? null,
          data.send ? 'sent' : 'draft', data.notes, offline ? 1 : 0, now, now, sentAt);
        lines.resolved.forEach((line, index) => store.run(`INSERT INTO order_lines(id,order_id,position,product_id,product_name,unit,unit_size,qty,notes,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, randomUUID(), data.id, index, line.productId, line.name, line.unit, line.unitSize, line.qty, line.notes, now));
      });
    } catch (error) {
      // The unique indexes have the last word (one line per item, one id per order); a race against
      // itself arrives as a duplicate the office can price, not as a crash.
      if (String((error as Error).message).includes('UNIQUE')) {
        const saved = store.get('SELECT user_id AS userId FROM orders WHERE id=?', data.id) as { userId: string } | undefined;
        if (saved?.userId === res.locals.user.id) {
          res.status(200).json({ order: orderRow(data.id, 'rep'), duplicate: true }); return;
        }
      }
      throw error;
    }
    store.audit(res.locals.user.id, offline ? 'order.create_offline' : 'order.create',
      { orderId: data.id, customerId: data.customerId, ...(data.visitId ? { visitId: data.visitId } : {}), lines: lines.resolved.length, send: data.send });
    if (data.send) io.to('admins').emit('order', orderRow(data.id, 'office'));
    invalidateKpis(); broadcast();
    res.status(201).json({ order: orderRow(data.id, 'rep'), duplicate: false, ...(offline ? { recordedOffline: true } : {}) });
  });

  app.patch('/api/orders/:id', repOnly, (req, res) => {
    const parsed = patchOrder.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات التعديل غير صحيحة.' }); return; }
    if (parsed.data.notes === undefined && parsed.data.lines === undefined) { res.status(400).json({ error: 'مفيش حاجة تتعدّل — ابعث ملاحظات أو سطور.' }); return; }
    const order = store.get('SELECT id, user_id AS userId, status FROM orders WHERE id=?', String(req.params.id)) as { id: string; userId: string; status: string } | undefined;
    if (!order || order.userId !== res.locals.user.id) { res.status(404).json({ error: 'الطلبية غير موجودة.' }); return; }
    // Once it is in the office's queue the sheet cannot change it: a priced number standing under a
    // rewritten line is worse than no pricing at all. Anything else that must change is a new order.
    if (order.status !== 'draft') { res.status(409).json({ error: 'الطلبية اتبعتت بالفعل — اللي اتبعت ما بيتعدلش. لو فيها غلط اكتب طلبية جديدة، وبلّغ المكتب.', code: 'ORDER_SENT' }); return; }
    const now = Date.now();
    try {
      store.transaction(() => {
        if (parsed.data.notes !== undefined) store.run('UPDATE orders SET notes=?, updated_at=? WHERE id=?', parsed.data.notes, now, order.id);
        else store.run('UPDATE orders SET updated_at=? WHERE id=?', now, order.id);
        if (parsed.data.lines !== undefined) {
          const lines = resolveOrderLines(parsed.data.lines);
          if ('error' in lines) throw Object.assign(new Error(lines.error), { statusCode: 400, orderLines: true });
          store.run('DELETE FROM order_lines WHERE order_id=?', order.id);
          lines.resolved.forEach((line, index) => store.run(`INSERT INTO order_lines(id,order_id,position,product_id,product_name,unit,unit_size,qty,notes,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`, randomUUID(), order.id, index, line.productId, line.name, line.unit, line.unitSize, line.qty, line.notes, now));
        }
      });
    } catch (error) {
      if ((error as any)?.orderLines) { res.status(400).json({ error: (error as Error).message, code: 'ORDER_LINES' }); return; }
      throw error;
    }
    store.audit(res.locals.user.id, 'order.edit', { orderId: order.id, fields: Object.keys(parsed.data) });
    res.json({ order: orderRow(order.id, 'rep') });
  });

  app.post('/api/orders/:id/send', repOnly, (req, res) => {
    const parsed = sendOrder.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات الإرسال غير صحيحة.' }); return; }
    const order = store.get('SELECT id, user_id AS userId, status FROM orders WHERE id=?', String(req.params.id)) as { id: string; userId: string; status: string } | undefined;
    if (!order || order.userId !== res.locals.user.id) { res.status(404).json({ error: 'الطلبية غير موجودة.' }); return; }
    // A replayed send of an order that is already in the queue did its job the first time.
    if (order.status !== 'draft') { res.json({ order: orderRow(order.id, 'rep'), duplicate: true }); return; }
    // A draft may have waited while the office moved its customer or stopped an item.
    // Apply the same rules as a new sent order before it becomes the office's work.
    const draft = store.get('SELECT customer_id AS customerId FROM orders WHERE id=?', order.id) as { customerId: string };
    const gate = orderCustomerGate(res.locals.user.id, draft.customerId);
    if ('error' in gate) { res.status(gate.status ?? 400).json({ error: gate.error, code: gate.code }); return; }
    const draftLines = orderLineRows(order.id, false) as Array<{ productId: string; qty: number; notes: string }>;
    const validLines = resolveOrderLines(draftLines);
    if ('error' in validLines) { res.status(400).json({ error: validLines.error, code: 'ORDER_LINES' }); return; }
    const now = Date.now();
    let sentAt = now;
    let offline = false;
    if (parsed.data.recordedAt !== undefined) {
      const at = Number(parsed.data.recordedAt);
      const reason = at > now + 60000 ? 'الوقت المرسل في المستقبل.'
        : at < now - OFFLINE_WINDOW_MS ? 'الطلبية أقدم من ٢٤ ساعة، مش ممكن تتبعت بأثر رجعي.' : '';
      if (reason) { res.status(422).json({ error: `الطلبية المتأخرة مرفوضة: ${reason}`, code: 'OFFLINE_ORDER_REJECTED' }); return; }
      sentAt = at; offline = true;
    }
    // The status rides in the WHERE: two devices pressing send at once produce one queue entry, not two.
    const moved = store.run(`UPDATE orders SET status='sent', sent_at=?, recorded_offline=MAX(recorded_offline, ?), updated_at=? WHERE id=? AND status='draft'`,
      sentAt, offline ? 1 : 0, now, order.id);
    if (!Number(moved.changes || 0)) { res.json({ order: orderRow(order.id, 'rep'), duplicate: true }); return; }
    store.audit(res.locals.user.id, offline ? 'order.send_offline' : 'order.send', { orderId: order.id });
    io.to('admins').emit('order', orderRow(order.id, 'office'));
    invalidateKpis(); broadcast();
    res.json({ order: orderRow(order.id, 'rep'), duplicate: false });
  });

  app.get('/api/orders', auth, (req, res) => {
    const isAdmin = res.locals.user.role === 'admin';
    const where: string[] = []; const params: any[] = [];
    if (!isAdmin) { where.push('o.user_id=?'); params.push(res.locals.user.id); }
    // Drafts belong to the engineer until he sends them; the office never sees unfinished work.
    if (isAdmin) where.push("o.status<>'draft'");
    const status = req.query.status === undefined ? '' : String(req.query.status);
    if (status && !['draft', 'sent', 'priced'].includes(status)) { res.status(400).json({ error: 'حالة الطلبية غير صحيحة.' }); return; }
    if (status) { where.push('o.status=?'); params.push(status); }
    if (isAdmin && status==='sent') where.push('NOT EXISTS(SELECT 1 FROM office_sales_v1 s WHERE s.order_id=o.id)');
    if (isAdmin && typeof req.query.repId === 'string' && req.query.repId) { where.push('o.user_id=?'); params.push(String(req.query.repId)); }
    const rawLimit = req.query.limit === undefined ? '100' : String(req.query.limit);
    const rawOffset = req.query.offset === undefined ? '0' : String(req.query.offset);
    if (!/^\d{1,6}$/.test(rawLimit) || Number(rawLimit) < 1 || !/^\d{1,9}$/.test(rawOffset)) {
      res.status(400).json({ error: 'عدد الطلبيات أو رقم الصفحة غير صحيح.' }); return;
    }
    const limit = Math.min(300, Number(rawLimit));
    const offset = Number(rawOffset);
    // Oldest sent orders first so a busy office never starves the oldest request.
    const sort = isAdmin && status === 'sent' ? 'o.sent_at ASC, o.id ASC' : 'o.created_at DESC, o.id DESC';
    const rows = store.all(`${ORDER_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...params, limit + 1, offset) as Array<Record<string, any>>;
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    res.setHeader('Cache-Control', 'private, no-store');
    const orders = rows.map(row => {
      const shaped = orderRow(String(row.id), isAdmin ? 'office' : 'rep')!;
      if (isAdmin) {
        // The queue prefills itself: the office sees the list price for this customer's type next to
        // an empty box, and typing over it is the deliberate «باليد» that leaves no tier behind.
        const prices = shaped.lines.length && row.customerTierId
          ? store.all('SELECT product_id AS productId, price FROM product_prices WHERE tier_id=?', String(row.customerTierId)) as Array<Record<string, any>>
          : [];
        const suggested = new Map(prices.map(price => [String(price.productId), Number(price.price)]));
        for (const line of shaped.lines) line.suggestedPrice = suggested.get(String(line.productId)) ?? null;
      }
      return shaped;
    });
    res.json({ orders, hasMore });
  });

  /**
   * The office puts the numbers on an order. This is the only door to a price, it is closed twice on
   * purpose (the order must be sent, and after it is priced nothing touches it again), and it prices
   * the whole order in one press: half a priced order is how a total stops meaning anything.
   */
  app.post('/api/orders/:id/price', adminOnly, (req, res) => {
    const parsed = priceOrder.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'أسعار الطلبية غير صحيحة.' }); return; }
    const order = store.get(`SELECT o.id, o.status, o.customer_id AS customerId, c.price_tier_id AS customerTierId, c.name AS customerName
      FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?`, String(req.params.id)) as Record<string, any> | undefined;
    if (!order) { res.status(404).json({ error: 'الطلبية غير موجودة.' }); return; }
    if(store.get('SELECT 1 FROM office_sales_v1 WHERE order_id=?',order.id)){res.status(409).json({error:'الطلبية اتسجّلت كبيعة قبل كده؛ راجع حساب العميل.',code:'ORDER_SOLD'});return;}
    if (order.status === 'priced') { res.status(409).json({ error: 'الطلبية متسعّرة ومقفولة — الرقم اتكتب في الدفتر مرة واحدة. لو فيها غلط، بلّغ المسؤول.', code: 'ORDER_PRICED' }); return; }
    if (order.status !== 'sent') { res.status(409).json({ error: 'الطلبية لسه ما اتبعتتش من الميدان.', code: 'ORDER_NOT_SENT' }); return; }
    const stored = orderLineRows(order.id, false);
    const byProduct = new Map(parsed.data.lines.map(line => [line.productId, line]));
    if (byProduct.size !== parsed.data.lines.length) { res.status(400).json({ error: 'صنف متكرر في التسعير — صنف واحد = سطر واحد.' }); return; }
    const unknown = [...byProduct.keys()].filter(id => !stored.some(line => String(line.productId) === id));
    if (unknown.length) { res.status(400).json({ error: 'في صنف في التسعير مش موجود في الطلبية دي.', code: 'ORDER_LINE_MISMATCH' }); return; }
    const missing = stored.filter(line => !byProduct.has(String(line.productId)));
    if (missing.length) {
      const names = missing.map(line => `«${line.productName}»`).join('، ');
      res.status(400).json({ error: `لازم كل سطر ياخد سعره — ${names} لسه من غير سعر.`, code: 'PRICE_REQUIRED' }); return;
    }
    let total = 0;
    for (const line of stored) {
      const edit = byProduct.get(String(line.productId))!;
      if (edit.tierId !== undefined) {
        const tier = store.get('SELECT id, name FROM price_tiers WHERE id=?', edit.tierId) as { id: string; name: string } | undefined;
        if (!tier) { res.status(404).json({ error: 'نوع السعر ده مش في القائمة.', code: 'TIER_NOT_FOUND' }); return; }
        const listed = store.get('SELECT price FROM product_prices WHERE product_id=? AND tier_id=?', line.productId, edit.tierId) as { price: number } | undefined;
        if (!listed) { res.status(400).json({ error: `«${line.productName}» من غير سعر مسجّل لـ «${tier.name}» — كمّل اللوحة، أو ختم السعر باليد من غير اختيار نوع.`, code: 'TIER_PRICE_MISSING' }); return; }
        // A number that contradicts the type it claims is either a stale sheet or a re-typed price
        // with the wrong label; both are answered by naming the list, not by guessing.
        if (Number(listed.price) !== edit.price) { res.status(400).json({ error: `السعر في اللوحة لـ «${line.productName} / ${tier.name}» هو ${listed.price} — لو ده الفعلي، عدّل اللوحة الأول أو امسح اختيار النوع وخليه باليد.`, code: 'TIER_PRICE_MISMATCH' }); return; }
      }
      total += Number(line.qty) * edit.price;
    }
    total = Math.round(total * 100) / 100;
    const now = Date.now();
    try { store.transaction(() => {
      // A sale and a price stamp can race from different office screens. The check
      // belongs inside the same transaction as the price writes.
      if(store.get('SELECT 1 FROM office_sales_v1 WHERE order_id=?',order.id)) throw Error('ORDER_SOLD');
      for (const line of stored) {
        const edit = byProduct.get(String(line.productId))!;
        store.run('UPDATE order_lines SET price=?, tier_id=? WHERE id=?', edit.price, edit.tierId ?? null, line.id);
      }
      const closed = store.run(`UPDATE orders SET status='priced', total=?, priced_at=?, priced_by=?, updated_at=? WHERE id=? AND status='sent'`,
        total, now, res.locals.user.id, now, order.id);
      if (!Number(closed.changes || 0)) throw Error('DOUBLE_CLOSE');
    }); } catch(e) {
      const code=(e as Error).message;
      if(code==='ORDER_SOLD'||code==='DOUBLE_CLOSE'){res.status(409).json({error:code==='ORDER_SOLD'?'الطلبية اتسجّلت كبيعة قبل كده؛ راجع حساب العميل.':'الطلبية اتسعّرت قبل كده؛ حدّث البيانات.',code});return;}
      throw e;
    }
    store.audit(res.locals.user.id, 'order.price', { orderId: order.id, customerName: order.customerName, lines: stored.length, total });
    io.to('admins').emit('order', orderRow(order.id, 'office'));
    invalidateKpis(); broadcast();
    res.json({ order: orderRow(order.id, 'office') });
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
    io.to('admins').emit('visit', { id: visit.id, deleted: true });
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
            ? `التليفون واصِل للسيرفر${seenMinutes !== null ? ` (آخر طلب منه من ${elapsedMinutesText(seenMinutes)})` : ''} بس آخر نقطة موقع قبل ${elapsedMinutesText(staleMinutes)} — الشبكة شغالة والموقع هو المقطوع: اطلب من المهندس يفتح التطبيق ويسمح بالموقع.`
            : `آخر إشارة قبل ${elapsedMinutesText(staleMinutes)}${dying ? ` والبطارية وقتها ${battery}٪` : ''}${openVisitRow ? ` (زيارة مفتوحة، الحد ${staleLimitMinutes} دقيقة)` : ` (حد التنبيه ${staleLimitMinutes} دقيقة)`} — مفيش أي طلب من التليفون في الفترة دي، فمقفول أو مكان بلا شبكة.${dying ? ' الأرجح إنه فصل.' : ''}`,
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
    // An order that waits is an agreement nobody wrote up: warn level, because a day of these is a
    // week of invoices the accounting team will chase by phone.
    const orderQueue = store.get("SELECT COUNT(*) AS c, MIN(o.sent_at) AS oldest FROM orders o WHERE o.status='sent' AND NOT EXISTS(SELECT 1 FROM office_sales_v1 s WHERE s.order_id=o.id)") as { c: number; oldest: number | null } | undefined;
    if (Number(orderQueue?.c || 0) > 0) {
      alerts.push({ id: 'orders:queue', level: 'warn', code: 'orders_awaiting_pricing',
        title: 'طلبيات مستنية المكتب', detail: `${Number(orderQueue!.c)} طلبية اتبعتت من الميدان ولسه ما اتسعّرتش ولا اتسجلت كبيعة.`, at: Number(orderQueue!.oldest ?? now) });
    }
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
