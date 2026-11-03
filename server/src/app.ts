import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { z } from 'zod';
import { Store } from './db.js';
import { readConfig, type Config } from './config.js';
import { createSession, hashPassword, publicUser, requireAuth, sessionUser, verifyPassword, tokenHash, setSessionCookie, clearSessionCookies, SESSION_MS } from './auth.js';
import { dayBounds, distanceMeters, localDate, type GeoPoint } from './geo.js';
import { seedDemo, startDemoSimulator, tickDemo } from './demo.js';
import { newDailyReportSchema, dailyReportRow, listDailyReports, insertDailyReport, validateReportDate } from './dailyReports.js';
import { dailyReportPdf } from './dailyPdf.js';
import { createAgentRouter } from './agent/router.js';

const CONSENT_VERSION = '1.0';
const credentials = z.object({ email: z.email().max(254).transform(x => x.toLowerCase().trim()), password: z.string().min(1).max(200) });
const newRep = z.object({
  name: z.string().trim().min(2).max(80), email: z.email().max(254).transform(x => x.toLowerCase().trim()),
  password: z.string().min(10).max(200), phone: z.string().trim().max(30).default(''), region: z.string().trim().max(80).default(''),
});
const pointSchema = z.object({
  id: z.uuid(), shiftId: z.uuid(), lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().min(0).max(100000).nullable(), speed: z.number().finite().min(0).max(150).nullable(),
  heading: z.number().finite().min(0).lt(360).nullable(), battery: z.number().finite().min(0).max(100).nullable(),
  recordedAt: z.number().int().nonnegative(),
}).strict();
const batchSchema = z.object({ points: z.array(pointSchema).min(1).max(100) }).strict();
export const REPORT_TYPES = ['visit', 'order', 'collection', 'note', 'issue', 'other'] as const;
const reportLocation = z.object({
  lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().min(0).max(100000).nullable(),
}).strict();
const newReport = z.object({
  id: z.uuid(), type: z.enum(REPORT_TYPES),
  title: z.string().trim().min(2).max(120), body: z.string().trim().max(4000).default(''),
  customer: z.string().trim().max(120).default(''),
  amount: z.number().finite().min(0).max(1_000_000_000).nullable().default(null),
  location: reportLocation.nullable().default(null),
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
  location: reportLocation.nullable().default(null),
}).strict();
const closeVisit = z.object({
  outcome: z.string().trim().max(1000).default(''),
  notes: z.string().trim().max(1000).default(''),
  amount: z.number().finite().min(0).max(1_000_000_000).nullable().default(null),
  location: reportLocation.nullable().default(null),
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
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    // The hosted demo is embedded in the Arena preview iframe; production keeps SAMEORIGIN.
    frameguard: config.production ? { action: 'sameorigin' } : false,
    crossOriginResourcePolicy: config.production ? { policy: 'same-origin' } : false,
  }));
  app.use(cors({ origin: originCheck }));
  app.use(express.json({ limit: '128kb' }));
  const apiLimiter = rateLimit({ windowMs: 60000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'طلبات كثيرة جدًا. حاول بعد دقيقة.' } });
  // High-frequency GPS has its own authenticated per-representative budget, so one busy
  // office IP does not throttle the whole team's one-second updates.
  app.use('/api', (req, res, next) => req.path === '/locations' ? next() : apiLimiter(req, res, next));
  if (!store.get("SELECT id FROM users WHERE role='admin'")) {
    if (!config.adminPassword) throw new Error('ADMIN_PASSWORD is required to initialize the first administrator.');
    store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)', randomUUID(), 'متابعة الهلب', config.adminEmail, hashPassword(config.adminPassword), 'admin', Date.now());
  }
  if (config.demo) seedDemo(store, config.timezone);
  const auth = requireAuth(store);
  const adminOnly = requireAuth(store, 'admin');
  const repOnly = requireAuth(store, 'rep');
  const locationLimiter = rateLimit({ windowMs: 60000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: (_req, res) => String(res.locals.user.id), message: { error: 'تحديثات موقع كثيرة جدًا. حاول بعد دقيقة.' } });
  const dayStatsCache = new Map<string, { day: string; computedAt: number; distanceMeters: number; pointCount: number }>();

  function endShift(userId: string) {
    const shift = store.get('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', userId);
    if (shift) {
      store.run('UPDATE shifts SET ended_at=? WHERE id=?', Date.now(), shift.id);
      store.audit(userId, 'shift.stop');
    }
  }
  function repSnapshot(user: Record<string, any>) {
    const location = store.get('SELECT *, received_at AS receivedAt FROM locations WHERE user_id=? ORDER BY recorded_at DESC, received_at DESC LIMIT 1', user.id);
    const shift = store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', user.id);
    const bounds = dayBounds(localDate(config.timezone), config.timezone);
    const day = localDate(config.timezone);
    let stats = dayStatsCache.get(user.id);
    if (!stats || stats.day !== day || Date.now() - stats.computedAt > 5000) {
      const points = store.all('SELECT lat,lng,accuracy,speed,recorded_at AS recordedAt FROM locations WHERE user_id=? AND recorded_at>=? AND recorded_at<? ORDER BY recorded_at, received_at', user.id, bounds.start, bounds.end) as unknown as GeoPoint[];
      stats = { day, computedAt: Date.now(), distanceMeters: Math.round(distanceMeters(points)), pointCount: points.length };
      dayStatsCache.set(user.id, stats);
    }
    const online = io.sockets.adapter.rooms.get(`user:${user.id}`)?.size ? true : !!user.last_seen && Date.now() - user.last_seen < 75000;
    const visitStats = store.get(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open FROM visits WHERE user_id=? AND checked_in_at>=? AND checked_in_at<?`, user.id, bounds.start, bounds.end);
    const openVisit = store.get("SELECT id, customer_name AS customerName, checked_in_at AS checkedInAt FROM visits WHERE user_id=? AND status='open' ORDER BY checked_in_at DESC LIMIT 1", user.id);
    return {
      ...publicUser(user), lastSeen: user.last_seen || null, online, tracking: !!shift,
      shiftStartedAt: shift?.started_at || null,
      location: location ? { lat: location.lat, lng: location.lng, accuracy: location.accuracy, speed: location.speed, heading: location.heading, battery: location.battery, recordedAt: location.recorded_at, receivedAt: location.receivedAt, source: location.source } : null,
      distanceMeters: stats.distanceMeters, pointCount: stats.pointCount,
      visitsToday: Number(visitStats?.total || 0), openVisit: openVisit || null,
    };
  }
  // The hosted demo has no background process, so the map is advanced by demand instead.
  const requestDrivenDemo = config.demo && process.env.DEMO_SIMULATE === 'true';
  function overview() {
    if (requestDrivenDemo) tickDemo(store);
    const reps = store.all("SELECT * FROM users WHERE role='rep' ORDER BY is_demo DESC, created_at, name").map(repSnapshot);
    const newReports = ((store.get("SELECT COUNT(*) AS c FROM reports WHERE status='new'")?.c as number) || 0)
      + ((store.get("SELECT COUNT(*) AS c FROM daily_reports WHERE status='new'")?.c as number) || 0);
    return { reps, serverTime: Date.now(), demo: config.demo, timezone: config.timezone, retentionDays: config.retentionDays, newReports };
  }
  function reportRow(id: string) {
    return store.get(`SELECT r.id, r.user_id AS userId, r.shift_id AS shiftId, r.type, r.title, r.body, r.customer, r.amount,
      r.lat, r.lng, r.accuracy, r.status, r.created_at AS createdAt, r.reviewed_at AS reviewedAt,
      u.name AS repName, u.color AS repColor, u.is_demo AS repIsDemo
      FROM reports r JOIN users u ON u.id=r.user_id WHERE r.id=?`, id);
  }
  const VISIT_SELECT = `SELECT v.id, v.user_id AS userId, v.customer_name AS customerName, v.governorate, v.district,
    v.village, v.phone, v.purpose, v.notes, v.outcome, v.status, v.checked_in_at AS checkedInAt,
    v.checked_out_at AS checkedOutAt, v.duration_seconds AS durationSeconds,
    v.in_lat AS inLat, v.in_lng AS inLng, v.in_accuracy AS inAccuracy,
    v.out_lat AS outLat, v.out_lng AS outLng,
    u.name AS repName, u.color AS repColor, u.is_demo AS repIsDemo
    FROM visits v JOIN users u ON u.id = v.user_id`;
  function visitRow(id: string) { return store.get(`${VISIT_SELECT} WHERE v.id=?`, id); }
  function listVisits(filter: { userId?: string; repId?: string; date?: string; status?: string }) {
    const where: string[] = []; const params: any[] = [];
    if (filter.userId) { where.push('v.user_id=?'); params.push(filter.userId); }
    if (filter.repId) { where.push('v.user_id=?'); params.push(filter.repId); }
    if (filter.status) { where.push('v.status=?'); params.push(filter.status); }
    if (filter.date) {
      const bounds = dayBounds(filter.date, config.timezone);
      where.push('v.checked_in_at>=? AND v.checked_in_at<?'); params.push(bounds.start, bounds.end);
    }
    return store.all(`${VISIT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY v.checked_in_at DESC LIMIT 300`, ...params);
  }
  function dayDistance(userId: string, start: number, end: number) {
    const points = store.all('SELECT lat,lng,accuracy,speed,recorded_at AS recordedAt FROM locations WHERE user_id=? AND recorded_at>=? AND recorded_at<? ORDER BY recorded_at, received_at', userId, start, end) as unknown as GeoPoint[];
    return { meters: Math.round(distanceMeters(points)), points: points.length, first: points[0]?.recordedAt ?? null, last: points[points.length - 1]?.recordedAt ?? null };
  }
  function listReports(filter: { userId?: string; type?: string; status?: string; repId?: string }) {
    const where: string[] = []; const params: any[] = [];
    if (filter.userId) { where.push('r.user_id=?'); params.push(filter.userId); }
    if (filter.repId) { where.push('r.user_id=?'); params.push(filter.repId); }
    if (filter.type) { where.push('r.type=?'); params.push(filter.type); }
    if (filter.status) { where.push('r.status=?'); params.push(filter.status); }
    const sql = `SELECT r.id, r.user_id AS userId, r.shift_id AS shiftId, r.type, r.title, r.body, r.customer, r.amount,
      r.lat, r.lng, r.accuracy, r.status, r.created_at AS createdAt, r.reviewed_at AS reviewedAt,
      u.name AS repName, u.color AS repColor, u.is_demo AS repIsDemo
      FROM reports r JOIN users u ON u.id=r.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.created_at DESC LIMIT 300`;
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
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.expiresAt - Date.now()));
    expiryTimer.unref();
    socket.once('disconnect', () => clearTimeout(expiryTimer));
    socket.join(`user:${user.id}`);
    if (user.role === 'admin') { socket.join('admins'); socket.emit('overview', overview()); }
    else socket.emit('shift', store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', user.id) || null);
    broadcast();
    socket.on('disconnect', broadcast);
  });

  app.get('/api/health', (_req, res) => { res.json({ ok: true, demo: config.demo, timezone: config.timezone, retentionDays: config.retentionDays, consentVersion: CONSENT_VERSION }); });
  app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60000, limit: config.demo ? 60 : 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'محاولات دخول كثيرة. انتظر ١٥ دقيقة.' } }), (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'أدخل بريدًا إلكترونيًا صحيحًا وكلمة مرور.' }); return; }
    const user = store.get('SELECT * FROM users WHERE email=? AND active=1', parsed.data.email);
    // Run scrypt even for unknown accounts to reduce account-enumeration timing differences.
    const dummy = '00000000000000000000000000000000:' + '00'.repeat(64);
    const valid = verifyPassword(parsed.data.password, user?.password_hash || dummy);
    if (!user || !valid) { res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' }); return; }
    const session = createSession(store, user.id);
    setSessionCookie(req, res, user.role as 'admin' | 'rep', session.token, SESSION_MS);
    store.audit(user.id, 'auth.login');
    res.json({ ...session, user: publicUser(user) });
  });
  app.get('/api/auth/me', auth, (_req, res) => { res.json({ user: publicUser(res.locals.user) }); });
  app.post('/api/auth/logout', auth, (req, res) => {
    if (res.locals.user.role === 'rep') endShift(res.locals.user.id);
    store.run('DELETE FROM sessions WHERE token_hash=?', res.locals.tokenHash);
    clearSessionCookies(req, res);
    store.audit(res.locals.user.id, 'auth.logout');
    io.in(`user:${res.locals.user.id}`).disconnectSockets(true);
    broadcast();
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
    store.run('INSERT INTO users(id,name,email,password_hash,role,phone,region,created_at) VALUES (?,?,?,?,?,?,?,?)', id, data.name, data.email, hashPassword(data.password), 'rep', data.phone, data.region, Date.now());
    store.audit(res.locals.user.id, 'rep.create', { repId: id });
    broadcast();
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
    broadcast();
    res.json({ user: publicUser(store.get('SELECT * FROM users WHERE id=?', user.id)!) });
  });
  app.get('/api/reps/:id/route', auth, (req, res) => {
    const id = String(req.params.id);
    if (res.locals.user.role !== 'admin' && res.locals.user.id !== id) { res.status(403).json({ error: 'يمكنك عرض مسارك فقط.' }); return; }
    const date = typeof req.query.date === 'string' ? req.query.date : localDate(config.timezone);
    let bounds;
    try { bounds = dayBounds(date, config.timezone); } catch { res.status(400).json({ error: 'التاريخ غير صحيح.' }); return; }
    if (!store.get("SELECT id FROM users WHERE id=? AND role='rep'", id)) { res.status(404).json({ error: 'المهندس غير موجود.' }); return; }
    const rows = store.all(`SELECT point_id AS id,lat,lng,accuracy,speed,heading,battery,recorded_at AS recordedAt,received_at AS receivedAt,source,shift_id AS shiftId
      FROM locations WHERE user_id=? AND recorded_at>=? AND recorded_at<? ORDER BY recorded_at, received_at LIMIT 20001`, id, bounds.start, bounds.end);
    const truncated = rows.length > 20000;
    const points = (truncated ? rows.slice(0, 20000) : rows) as unknown as GeoPoint[];
    res.json({ date, timezone: config.timezone, points, truncated, distanceMeters: Math.round(distanceMeters(points)) });
  });
  app.get('/api/me/shift', repOnly, (_req, res) => {
    const shift = store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', res.locals.user.id);
    res.json({ shift: shift || null, snapshot: repSnapshot(res.locals.user), consentVersion: CONSENT_VERSION });
  });
  app.post('/api/shifts/start', repOnly, (req, res) => {
    const parsed = z.object({ consentVersion: z.literal(CONSENT_VERSION) }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'موافقتك الصريحة مطلوبة قبل بدء التتبع.' }); return; }
    if (res.locals.user.is_demo) { res.status(403).json({ error: 'هذا حساب عرض تجريبي فقط. استخدم rep@mandoub.test لاختبار GPS الحقيقي.' }); return; }
    let shift = store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', res.locals.user.id);
    if (!shift) {
      const id = randomUUID(), now = Date.now();
      store.run('INSERT INTO shifts(id,user_id,started_at,consent_version,consent_at) VALUES (?,?,?,?,?)', id, res.locals.user.id, now, CONSENT_VERSION, now);
      store.audit(res.locals.user.id, 'shift.start', { consentVersion: CONSENT_VERSION });
      shift = store.get('SELECT * FROM shifts WHERE id=?', id);
    }
    broadcast();
    res.json({ shift });
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
    if (res.locals.user.is_demo) { res.status(403).json({ error: 'حسابات المحاكاة لا تقبل مواقع حقيقية.' }); return; }
    const now = Date.now(), cutoff = now - config.retentionDays * 86400000;
    const shiftCache = new Map<string, Record<string, any> | undefined>();
    for (const point of parsed.data.points) {
      if (!shiftCache.has(point.shiftId)) shiftCache.set(point.shiftId, store.get('SELECT * FROM shifts WHERE id=? AND user_id=?', point.shiftId, res.locals.user.id));
      const shift = shiftCache.get(point.shiftId);
      if (!shift || point.recordedAt < shift.started_at || point.recordedAt > (shift.ended_at ?? now) + 5000 || point.recordedAt > now + 120000 || point.recordedAt < cutoff) {
        res.status(422).json({ error: 'نقطة خارج وردية مصرح بها أو خارج مدة الاحتفاظ. لن يتم قبول الدفعة.' }); return;
      }
    }
    let accepted = 0, duplicates = 0;
    store.transaction(() => {
      for (const p of parsed.data.points) {
        const result = store.run(`INSERT OR IGNORE INTO locations(point_id,user_id,shift_id,lat,lng,accuracy,speed,heading,battery,recorded_at,received_at,source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, p.id, res.locals.user.id, p.shiftId, p.lat, p.lng, p.accuracy, p.speed, p.heading, p.battery, p.recordedAt, now, 'gps');
        if (result.changes) accepted++; else duplicates++;
      }
      store.run('UPDATE users SET last_seen=? WHERE id=?', now, res.locals.user.id);
    });
    broadcast();
    res.json({ accepted, duplicates });
  });
  // ---- Field visits: check in / check out around a customer with GPS proof ----
  app.post('/api/visits/check-in', repOnly, (req, res) => {
    const parsed = newVisit.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'راجع بيانات الزيارة: اسم العميل مطلوب.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return; }
    if (res.locals.user.is_demo) { res.status(403).json({ error: 'حسابات المحاكاة لا تسجل زيارات. استخدم rep@mandoub.test للتجربة.' }); return; }
    const data = parsed.data;
    const existing = visitRow(data.id);
    if (existing) {
      if (existing.userId !== res.locals.user.id) { res.status(409).json({ error: 'معرّف الزيارة مستخدم بالفعل.' }); return; }
      res.status(200).json({ visit: existing, duplicate: true }); return;
    }
    const shift = store.get('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', res.locals.user.id);
    if (!shift) { res.status(409).json({ error: 'ابدأ الوردية أولًا قبل تسجيل الزيارة.' }); return; }
    const open = store.get('SELECT id FROM visits WHERE user_id=? AND status=?', res.locals.user.id, 'open');
    if (open) { res.status(409).json({ error: 'لديك زيارة مفتوحة. أنهِها قبل بدء زيارة جديدة.', openVisitId: open.id }); return; }
    const now = Date.now();
    store.run(`INSERT INTO visits(id,user_id,customer_name,governorate,district,village,phone,purpose,notes,status,checked_in_at,in_lat,in_lng,in_accuracy,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?)`, data.id, res.locals.user.id, data.customerName, data.governorate,
      data.district, data.village, data.phone, data.purpose, data.notes, now,
      data.location?.lat ?? null, data.location?.lng ?? null, data.location?.accuracy ?? null, now);
    store.audit(res.locals.user.id, 'visit.check_in', { visitId: data.id, purpose: data.purpose });
    io.to('admins').emit('visit', visitRow(data.id));
    broadcast();
    res.status(201).json({ visit: visitRow(data.id), duplicate: false });
  });
  app.post('/api/visits/:id/check-out', repOnly, (req, res) => {
    const parsed = closeVisit.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'بيانات إنهاء الزيارة غير صحيحة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return; }
    const visit = visitRow(String(req.params.id));
    if (!visit || visit.userId !== res.locals.user.id) { res.status(404).json({ error: 'الزيارة غير موجودة.' }); return; }
    if (visit.status === 'closed') { res.json({ visit, duplicate: true }); return; }
    const data = parsed.data;
    const now = Date.now();
    const duration = Math.max(0, Math.round((now - Number(visit.checkedInAt)) / 1000));
    store.run(`UPDATE visits SET status='closed', checked_out_at=?, duration_seconds=?, outcome=?, notes=?,
      out_lat=?, out_lng=? WHERE id=?`, now, duration, data.outcome, data.notes || visit.notes,
      data.location?.lat ?? null, data.location?.lng ?? null, visit.id);
    // A collection is also a financial event: mirror it into the reports feed for the manager.
    if (data.amount !== null && data.amount > 0) {
      store.run(`INSERT OR IGNORE INTO reports(id,user_id,shift_id,type,title,body,customer,amount,lat,lng,accuracy,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'new',?)`, `visit:${visit.id}`, res.locals.user.id, null, 'collection',
        `تحصيل - ${visit.customerName}`, data.outcome || visit.notes, visit.customerName, data.amount,
        data.location?.lat ?? visit.inLat ?? null, data.location?.lng ?? visit.inLng ?? null, data.location?.accuracy ?? null, now);
    }
    store.audit(res.locals.user.id, 'visit.check_out', { visitId: visit.id, durationSeconds: duration });
    io.to('admins').emit('visit', visitRow(visit.id));
    broadcast();
    res.json({ visit: visitRow(visit.id), duplicate: false });
  });
  app.get('/api/visits', auth, (req, res) => {
    const isAdmin = res.locals.user.role === 'admin';
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    const status = req.query.status === 'open' || req.query.status === 'closed' ? req.query.status : undefined;
    const repId = isAdmin && typeof req.query.repId === 'string' ? req.query.repId : undefined;
    if (date) { try { dayBounds(date, config.timezone); } catch { res.status(400).json({ error: 'التاريخ غير صحيح.' }); return; } }
    res.json({ visits: listVisits({ userId: isAdmin ? repId : res.locals.user.id, date, status }) });
  });
  app.get('/api/me/summary', repOnly, (req, res) => {
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : localDate(config.timezone);
    let bounds;
    try { bounds = dayBounds(date, config.timezone); } catch { res.status(400).json({ error: 'التاريخ غير صحيح.' }); return; }
    const user = res.locals.user;
    const distance = dayDistance(user.id, bounds.start, bounds.end);
    const visits = listVisits({ userId: user.id, date });
    const completed = visits.filter(v => v.status === 'closed');
    const open = visits.find(v => v.status === 'open') || null;
    const avgVisitSeconds = completed.length ? Math.round(completed.reduce((sum, v) => sum + Number(v.durationSeconds || 0), 0) / completed.length) : null;
    const collections = store.get("SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS total FROM reports WHERE user_id=? AND type='collection' AND created_at>=? AND created_at<?", user.id, bounds.start, bounds.end);
    const daily = store.get('SELECT id, status, created_at AS createdAt FROM daily_reports WHERE user_id=? AND report_date=?', user.id, date);
    const shift = store.get('SELECT * FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', user.id);
    res.json({
      date, timezone: config.timezone, shift: shift || null,
      distanceMeters: distance.meters, pointCount: distance.points, firstFixAt: distance.first, lastFixAt: distance.last,
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
      if (shift && lastAt && now - lastAt > 30 * 60000) {
        alerts.push({ id: `${rep.id}:stale`, level: 'warn', code: 'stale_gps', repId: rep.id, repName: rep.name, title: 'انقطاع في إرسال الموقع', detail: `آخر إشارة ${Math.round((now - lastAt) / 60000)} دقيقة — تأكد من فتح التطبيق والسماح بالموقع.`, at: lastAt });
      }
      if (shift && !lastAt && now - Number(shift.started_at) > 20 * 60000) {
        alerts.push({ id: `${rep.id}:nosignal`, level: 'warn', code: 'no_signal', repId: rep.id, repName: rep.name, title: 'وردية بدون أي إشارة', detail: 'بدأ الوردية ولم تُسجل أي نقطة موقع بعد.', at: Number(shift.started_at) });
      }
      const visitsToday = store.get('SELECT COUNT(*) AS c FROM visits WHERE user_id=? AND checked_in_at>=? AND checked_in_at<?', rep.id, bounds.start, bounds.end)!;
      const hasActivity = !!lastAt && lastAt >= bounds.start;
      if (hasActivity && Number(visitsToday.c) === 0 && now - bounds.start > 2 * 3600000) {
        alerts.push({ id: `${rep.id}:novisit`, level: 'info', code: 'no_visits', repId: rep.id, repName: rep.name, title: 'لا زيارات مسجلة اليوم', detail: 'المهندس في الميدان لكن لم يسجل أي زيارة اليوم.', at: bounds.start });
      }
      const daily = store.get('SELECT id FROM daily_reports WHERE user_id=? AND report_date=?', rep.id, today);
      const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
      if (hasActivity && !daily && localHour >= 16) {
        alerts.push({ id: `${rep.id}:daily`, level: 'warn', code: 'missing_daily_report', repId: rep.id, repName: rep.name, title: 'تقرير يومي غير مُرسل', detail: 'مر وقت العمل ولم يُرسل التقرير اليومي بعد.', at: bounds.start });
      }
    }
    const staleReviews = store.get('SELECT COUNT(*) AS c FROM reports WHERE status=? AND created_at<?', 'new', now - 24 * 3600000)!;
    if (Number(staleReviews.c) > 0) {
      alerts.push({ id: 'reports:stale', level: 'info', code: 'stale_reviews', title: 'تقارير بانتظار المراجعة', detail: `${staleReviews.c} تقرير مضى عليه أكثر من ٢٤ ساعة.`, at: now });
    }
    const order = { warn: 0, info: 1 } as Record<string, number>;
    alerts.sort((a, b) => (order[a.level] - order[b.level]) || (b.at - a.at));
    res.json({ alerts, generatedAt: now, date: today });
  });
  function kpiRows(from: string, to: string) {
    const start = dayBounds(from, config.timezone).start;
    const end = dayBounds(to, config.timezone).end;
    return store.all("SELECT * FROM users WHERE role='rep' ORDER BY is_demo, name").map(rep => {
      const distance = dayDistance(rep.id, start, end);
      const visits = store.get(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) AS closed,
        AVG(CASE WHEN status='closed' THEN duration_seconds END) AS avgDuration
        FROM visits WHERE user_id=? AND checked_in_at>=? AND checked_in_at<?`, rep.id, start, end)!;
      const reportsRow = store.get("SELECT COUNT(*) AS c, COALESCE(SUM(CASE WHEN type='collection' THEN amount ELSE 0 END),0) AS collected FROM reports WHERE user_id=? AND created_at>=? AND created_at<?", rep.id, start, end)!;
      const dailyRow = store.get('SELECT COUNT(*) AS c FROM daily_reports WHERE user_id=? AND created_at>=? AND created_at<?', rep.id, start, end)!;
      const daysRow = store.get("SELECT COUNT(DISTINCT date(recorded_at/1000,'unixepoch')) AS c FROM locations WHERE user_id=? AND recorded_at>=? AND recorded_at<?", rep.id, start, end)!;
      const lastRow = store.get('SELECT MAX(recorded_at) AS at FROM locations WHERE user_id=?', rep.id)!;
      return {
        repId: rep.id, name: rep.name, color: rep.color, region: rep.region, isDemo: !!rep.is_demo, active: !!rep.active,
        distanceMeters: distance.meters, pointCount: distance.points,
        visits: Number(visits.total || 0), visitsCompleted: Number(visits.closed || 0),
        avgVisitSeconds: visits.avgDuration ? Math.round(Number(visits.avgDuration)) : null,
        reports: Number(reportsRow.c || 0), collected: Number(reportsRow.collected || 0),
        dailyReports: Number(dailyRow.c || 0), daysWithData: Number(daysRow.c || 0),
        lastFixAt: lastRow.at ? Number(lastRow.at) : null,
      };
    });
  }
  app.get('/api/kpis', adminOnly, (req, res) => {
    const today = localDate(config.timezone);
    const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : today;
    const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : from;
    try { dayBounds(from, config.timezone); dayBounds(to, config.timezone); } catch { res.status(400).json({ error: 'نطاق التواريخ غير صحيح.' }); return; }
    if (to < from) { res.status(400).json({ error: 'تاريخ النهاية قبل البداية.' }); return; }
    res.json({ from, to, timezone: config.timezone, rows: kpiRows(from, to) });
  });
  app.get('/api/kpis.csv', adminOnly, (req, res) => {
    const today = localDate(config.timezone);
    const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : today;
    const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : from;
    let rows;
    try { dayBounds(from, config.timezone); dayBounds(to, config.timezone); rows = kpiRows(from, to); }
    catch { res.status(400).json({ error: 'نطاق التواريخ غير صحيح.' }); return; }
    const header = ['المهندس', 'المنطقة', 'أيام النشاط', 'عدد الزيارات', 'متوسط الزيارة (دقيقة)', 'المسافة (كم)', 'التقارير', 'التحصيل (ج.م)', 'التقارير اليومية'];
    const csv = [header.join(',')].concat(rows.map(r => [
      r.name, r.region, r.daysWithData, r.visits, r.avgVisitSeconds ? Math.round(r.avgVisitSeconds / 60) : 0,
      (r.distanceMeters / 1000).toFixed(1), r.reports, r.collected, r.dailyReports,
    ].map(value => `"${String(value).replace(/"/g, '""')}"`).join(','))).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="elhelb-kpis-${from}_${to}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send('\uFEFF' + csv);
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
      const rows = kpiRows(from, to);
      res.json({ month, from, to, timezone: config.timezone, rows });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.get('/api/monthly.csv', adminOnly, (req, res) => {
    const month = typeof req.query.month === 'string' ? req.query.month : localDate(config.timezone).slice(0, 7);
    try {
      const { from, to } = monthBounds(month);
      const rows = kpiRows(from, to);
      const header = ['المهندس', 'المنطقة', 'الشهر', 'عدد الزيارات', 'مكتملة', 'متوسط الزيارة (دقيقة)', 'المسافة (كم)', 'التقارير الميدانية', 'التقارير اليومية', 'التحصيل (ج.م)'];
      const csv = [header.join(',')].concat(rows.map(r => [
        r.name, r.region, month, r.visits, r.visitsCompleted, r.avgVisitSeconds ? Math.round(r.avgVisitSeconds / 60) : 0,
        (r.distanceMeters / 1000).toFixed(1), r.reports, r.dailyReports, r.collected,
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))).join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="elhelb-monthly-${month}.csv"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send('\uFEFF' + csv);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  // ---- Reports: the second core feature of the rep app ----
  app.post('/api/reports', repOnly, (req, res) => {
    const parsed = newReport.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'راجع بيانات التقرير: النوع والعنوان مطلوبان.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return; }
    if (res.locals.user.is_demo) { res.status(403).json({ error: 'حسابات المحاكاة لا ترسل تقارير. استخدم rep@mandoub.test للتجربة.' }); return; }
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
      broadcast();
    }
    res.status(result.changes ? 201 : 200).json({ report: reportRow(data.id), duplicate: !result.changes });
  });
  app.get('/api/reports', auth, (req, res) => {
    const isAdmin = res.locals.user.role === 'admin';
    const type = typeof req.query.type === 'string' && (REPORT_TYPES as readonly string[]).includes(req.query.type) ? req.query.type : undefined;
    const status = req.query.status === 'new' || req.query.status === 'reviewed' ? req.query.status : undefined;
    const repId = isAdmin && typeof req.query.repId === 'string' ? req.query.repId : undefined;
    const reports = listReports({ userId: isAdmin ? undefined : res.locals.user.id, type, status, repId });
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
      broadcast();
    }
    res.json({ report: reportRow(String(req.params.id)) });
  });
  // ---- Daily engineer reports: one report per day with multiple visit rows ----
  app.post('/api/daily-reports', repOnly, (req, res) => {
    const parsed = newDailyReportSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'راجع بيانات التقرير اليومي: الاسم والتاريخ وزيارة واحدة على الأقل والتوقيع مطلوبة.', issues: parsed.error.issues.map(x => ({ path: x.path, message: x.message })) }); return; }
    if (res.locals.user.is_demo) { res.status(403).json({ error: 'حسابات المحاكاة لا ترسل تقارير. استخدم rep@mandoub.test للتجربة.' }); return; }
    const data = parsed.data;
    try { validateReportDate(data.reportDate, config.timezone, config.retentionDays); }
    catch (e) { res.status(422).json({ error: (e as Error).message }); return; }
    const existing = store.get('SELECT user_id FROM daily_reports WHERE id=?', data.id);
    if (existing && existing.user_id !== res.locals.user.id) { res.status(409).json({ error: 'معرّف التقرير مستخدم بالفعل.' }); return; }
    const shift = store.get('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', res.locals.user.id);
    const now = Date.now();
    const duplicate = !!existing;
    if (!duplicate) insertDailyReport(store, res.locals.user.id, shift?.id || null, data, now, config.timezone);
    const report = dailyReportRow(store, data.id)!;
    if (!duplicate) {
      store.audit(res.locals.user.id, 'daily_report.create', { reportId: data.id, date: data.reportDate, visits: data.visits.length });
      io.to('admins').emit('daily-report', report);
      broadcast();
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
      io.to('admins').emit('daily-report', dailyReportRow(store, report.id));
      broadcast();
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
  const stopSimulator = config.demo && !requestDrivenDemo ? startDemoSimulator(store, broadcast) : () => {};
  store.cleanup(config.retentionDays);
  const cleanupTimer = setInterval(() => { store.cleanup(config.retentionDays); dayStatsCache.clear(); }, 3600000);
  cleanupTimer.unref();
  async function close() {
    closing = true;
    stopSimulator();
    clearInterval(cleanupTimer);
    if (broadcastTimer) clearTimeout(broadcastTimer);
    await new Promise<void>(resolve => io.close(() => resolve()));
    if (httpServer.listening) await new Promise<void>(resolve => httpServer.close(() => resolve()));
    store.close();
  }
  return { app, httpServer, io, store, config, close, overview };
}
