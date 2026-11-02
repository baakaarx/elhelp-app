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
import { seedDemo, startDemoSimulator } from './demo.js';
import { newDailyReportSchema, dailyReportRow, listDailyReports, insertDailyReport, validateReportDate } from './dailyReports.js';
import { dailyReportPdf } from './dailyPdf.js';

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
    return {
      ...publicUser(user), lastSeen: user.last_seen || null, online, tracking: !!shift,
      shiftStartedAt: shift?.started_at || null,
      location: location ? { lat: location.lat, lng: location.lng, accuracy: location.accuracy, speed: location.speed, heading: location.heading, battery: location.battery, recordedAt: location.recorded_at, receivedAt: location.receivedAt, source: location.source } : null,
      distanceMeters: stats.distanceMeters, pointCount: stats.pointCount,
    };
  }
  function overview() {
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
  app.use('/api', (_req, res) => res.status(404).json({ error: 'المسار غير موجود.' }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error.type === 'entity.parse.failed') { res.status(400).json({ error: 'JSON غير صالح.' }); return; }
    if (error.type === 'entity.too.large') { res.status(413).json({ error: 'حجم الطلب أكبر من المسموح.' }); return; }
    console.error(error);
    res.status(500).json({ error: 'حدث خطأ في الخادم. حاول مرة أخرى.' });
  });
  const stopSimulator = config.demo ? startDemoSimulator(store, broadcast) : () => {};
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
