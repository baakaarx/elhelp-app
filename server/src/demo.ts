import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './db.js';
import { hashPassword } from './auth.js';
import { insertDailyReport, type NewDailyReport } from './dailyReports.js';
import { localDate } from './geo.js';

/**
 * Deterministic ids for every seeded demo row.
 *
 * On a serverless host (Vercel) each instance seeds its own /tmp database, so the demo rows
 * have to be byte-identical everywhere: a daily report listed by one instance must stay
 * downloadable when the next request lands on another instance. Random ids broke exactly
 * that (the PDF endpoint answered 404 for a report the dashboard had just listed).
 */
function demoId(scope: string, key: string | number): string {
  const hex = createHash('sha1').update(`mandoub-demo:${scope}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const people = [
  { name: 'أحمد حسن', region: 'مدينة نصر', color: '#27745a', email: 'ahmed@mandoub.test', route: [[30.0566,31.3300],[30.0592,31.3375],[30.0638,31.3450],[30.0690,31.3510],[30.0745,31.3570],[30.0788,31.3650],[30.0740,31.3720],[30.0670,31.3650],[30.0600,31.3530],[30.0530,31.3420]] },
  { name: 'محمد علي', region: 'المعادي', color: '#5684b5', email: 'mohamed@mandoub.test', route: [[29.9602,31.2569],[29.9660,31.2620],[29.9720,31.2690],[29.9780,31.2760],[29.9840,31.2820],[29.9890,31.2870],[29.9820,31.2910],[29.9740,31.2800],[29.9660,31.2700]] },
  { name: 'سارة إبراهيم', region: 'مصر الجديدة', color: '#a57542', email: 'sara@mandoub.test', route: [[30.0870,31.3210],[30.0910,31.3280],[30.0960,31.3350],[30.1020,31.3420],[30.1080,31.3480],[30.1120,31.3540],[30.1050,31.3590],[30.0980,31.3450],[30.0910,31.3330]] },
  { name: 'خالد محمود', region: 'التجمع الخامس', color: '#8a72ad', email: 'khaled@mandoub.test', route: [[30.0130,31.4250],[30.0170,31.4330],[30.0210,31.4410],[30.0250,31.4490],[30.0290,31.4570],[30.0250,31.4650],[30.0180,31.4530],[30.0120,31.4400]] },
  { name: 'مصطفى أحمد', region: 'المهندسين', color: '#63866d', email: 'mostafa@mandoub.test', route: [[30.0530,31.2000],[30.0560,31.2050],[30.0590,31.2110],[30.0620,31.2170],[30.0580,31.2210],[30.0520,31.2150],[30.0480,31.2070]] },
];

export function seedDemo(store: Store, timezone = 'Africa/Cairo') {
  const now = Date.now();
  if (!store.get("SELECT id FROM users WHERE email='ahmed@mandoub.test'")) {
    store.transaction(() => {
      people.forEach((p, index) => {
        const userId = demoId('user', p.email), shiftId = demoId('shift', p.email);
        store.run('INSERT INTO users(id,name,email,password_hash,role,phone,region,color,is_demo,created_at,last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          userId, p.name, p.email, hashPassword('Demo1234!'), 'rep', `0100000000${index + 1}`, p.region, p.color, 1, now, index === 4 ? now - 3600000 : now);
        store.run('INSERT INTO shifts(id,user_id,started_at,consent_version,consent_at) VALUES (?,?,?,?,?)', shiftId, userId, now - 7200000, 'demo-1', now - 7200000);
        for (let j = 0; j < 65; j++) {
          const pos = routePosition(p.route, (j / 64) * (index === 4 ? 1.4 : 2.3));
          store.run(`INSERT INTO locations(point_id,user_id,shift_id,lat,lng,accuracy,speed,heading,battery,recorded_at,received_at,source)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, demoId('location', `${p.email}:${j}`), userId, shiftId, pos[0], pos[1], 8 + index * 2, index === 4 ? 0 : 4.2 + index, 45, 86 - index * 7, now - (65 - j) * 90000, now, 'demo');
        }
      });
      const userId = demoId('user', 'rep@mandoub.test');
      store.run('INSERT INTO users(id,name,email,password_hash,role,region,color,is_demo,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        userId, 'مهندس الاختبار', 'rep@mandoub.test', hashPassword('Demo1234!'), 'rep', 'موقعك الحقيقي', '#27745a', 0, now);
    });
  }
  seedDemoReports(store, now);
  seedDemoDailyReports(store, now, timezone);
  seedDemoVisits(store, now);
}
const demoReports: Array<{ type: string; title: string; body: string; customer: string; amount: number | null }> = [
  { type: 'visit', title: 'زيارة صيدلية النهدي', body: 'تم عرض المنتجات الجديدة، العميل مهتم بخط المكافحة.', customer: 'صيدلية النهدي', amount: null },
  { type: 'order', title: 'طلبية توريد شهري', body: 'طلبية مبدئية بانتظار اعتماد المتابعة.', customer: 'سوق المدينة', amount: 18500 },
  { type: 'collection', title: 'تحصيل دفعة', body: 'تم تحصيل دفعة من الرصيد المستحق.', customer: 'مؤسسة الوفاء', amount: 7200 },
  { type: 'issue', title: 'تأخر توريد', body: 'العميل أبلغ عن تأخر شحنة الأسبوع الماضي.', customer: 'مزارع الخير', amount: null },
  { type: 'note', title: 'ملاحظة سوق', body: 'منافس يعرض خصم ١٠٪ في المنطقة.', customer: '', amount: null },
];
// Backfill sample reports once (also covers databases created before reports existed).
export function seedDemoReports(store: Store, now = Date.now()) {
  if (store.get('SELECT id FROM reports LIMIT 1')) return;
  const demoUsers = store.all("SELECT id FROM users WHERE is_demo=1 ORDER BY email");
  if (!demoUsers.length) return;
  store.transaction(() => {
    demoUsers.forEach((u, index) => {
      const sample = demoReports[index % demoReports.length];
      const shift = store.get('SELECT id FROM shifts WHERE user_id=? ORDER BY started_at DESC LIMIT 1', u.id);
      const loc = store.get('SELECT lat,lng FROM locations WHERE user_id=? ORDER BY recorded_at DESC LIMIT 1', u.id);
      store.run(`INSERT INTO reports(id,user_id,shift_id,type,title,body,customer,amount,lat,lng,accuracy,status,created_at,reviewed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, demoId('report', u.id), u.id, shift?.id || null, sample.type, sample.title, sample.body, sample.customer, sample.amount,
        loc?.lat ?? 30.05, loc?.lng ?? 31.33, 9, index < 3 ? 'new' : 'reviewed', now - (index + 1) * 1500000, index < 3 ? null : now - 600000);
    });
  });
}
// Sample daily engineer reports use fictional customer names only.
export function seedDemoDailyReports(store: Store, now = Date.now(), timezone = 'Africa/Cairo') {
  if (store.get('SELECT id FROM daily_reports LIMIT 1')) return;
  const demoUsers = store.all("SELECT id, name FROM users WHERE is_demo=1 ORDER BY email LIMIT 3");
  if (!demoUsers.length) return;
  const samples: Array<{ customerName: string; governorate: string; district: string; village: string; phone: string; areaFeddan: number | null; crops: string; recommendations: string; outcome: string }> = [
    { customerName: 'مزرعة النور التجريبية', governorate: 'القاهرة', district: 'مدينة نصر', village: 'المنطقة التجريبية', phone: '01000000001', areaFeddan: 12, crops: 'قمح، برسيم', recommendations: 'متابعة الري وضبط جرعة التسميد.', outcome: 'تم الاتفاق على زيارة متابعة الأسبوع القادم.' },
    { customerName: 'عميل الاختبار أحمد', governorate: 'الجيزة', district: 'الدقي', village: 'شارع التجربة', phone: '01000000002', areaFeddan: null, crops: '', recommendations: '', outcome: 'تم عرض المنتجات وطلب عينة.' },
    { customerName: 'مزرعة السلام التجريبية', governorate: 'الشرقية', district: 'بلبيس', village: 'قرية الاختبار', phone: '01000000003', areaFeddan: 25, crops: 'ذرة، خضروات', recommendations: 'فحص الأوراق وإرسال تقرير فني.', outcome: 'تم تحديد موعد للفحص.' },
  ];
  demoUsers.forEach((u, index) => {
      const date = localDate(timezone, now - index * 86400000);
      const shift = store.get('SELECT id FROM shifts WHERE user_id=? ORDER BY started_at DESC LIMIT 1', u.id);
      const loc = store.get('SELECT lat,lng FROM locations WHERE user_id=? ORDER BY recorded_at DESC LIMIT 1', u.id);
      const data: NewDailyReport = {
        version: 1, id: demoId('daily-report', u.id), engineerName: String(u.name), reportDate: date,
        leftAt: '08:00', returnedAt: '17:00', circumstances: index === 2 ? 'ظرف طارئ تجريبي: تأخر الطريق.' : '',
        visits: samples.slice(0, index === 0 ? 3 : 2), signedName: String(u.name), confirmed: true,
        location: loc ? { lat: Number(loc.lat), lng: Number(loc.lng), accuracy: 9 } : null,
      };
      insertDailyReport(store, String(u.id), shift?.id ? String(shift.id) : null, data, now - (index + 1) * 1800000, timezone);
      if (index === 2) store.run("UPDATE daily_reports SET status='reviewed', reviewed_at=? WHERE id=?", now - 600000, data.id);
  });
}
// Closed visits for a couple of demo representatives so the manager view has a realistic
// day to look at (feed, KPIs, alerts). Times are anchored to "now", so they never look
// like they happened in the future, and never use real customer data.
export function seedDemoVisits(store: Store, now = Date.now()) {
  if (store.get('SELECT id FROM visits LIMIT 1')) return;
  const reps = store.all("SELECT id, name, email FROM users WHERE is_demo=1 ORDER BY email LIMIT 2");
  if (!reps.length) return;
  const plan = [
    { customer: 'مزرعة النور التجريبية', governorate: 'القاهرة', district: 'مدينة نصر', village: 'المنطقة التجريبية', purpose: 'visit', minutes: 35, outcome: 'عرض برنامج التسميد واتفقنا على زيارة متابعة.', amount: null as number | null, back: 75 },
    { customer: 'مؤسسة الوفاء التجريبية', governorate: 'القاهرة', district: 'مدينة نصر', village: 'شارع التجربة', purpose: 'collection', minutes: 20, outcome: 'تم تحصيل دفعة نقدية وإصدار إيصال.', amount: 4200, back: 150 },
    { customer: 'مزرعة السلام التجريبية', governorate: 'الجيزة', district: 'الدقي', village: 'قرية الاختبار', purpose: 'order', minutes: 28, outcome: 'طلبية ٣٠ كرتونة تسليم الأسبوع القادم.', amount: null as number | null, back: 260 },
  ];
  store.transaction(() => {
    reps.forEach((rep, repIndex) => {
      const route = people.find(person => person.email === rep.email)?.route ?? people[0].route;
      plan.slice(0, repIndex === 0 ? 3 : 2).forEach((item, index) => {
        const end = now - (item.back - item.minutes) * 60000;
        const start = end - item.minutes * 60000;
        const position = routePosition(route, 0.6 + index * 0.7);
        const [lat, lng] = routePosition(route, 0.9 + index * 0.7);
        const id = demoId('visit', `${rep.id}:${index}`);
        store.run(`INSERT INTO visits(id,user_id,customer_name,governorate,district,village,phone,purpose,notes,outcome,status,checked_in_at,checked_out_at,duration_seconds,in_lat,in_lng,in_accuracy,out_lat,out_lng,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'closed',?,?,?,?,?,?,?,?,?)`, id, rep.id, item.customer, item.governorate, item.district, item.village,
          `0100000000${repIndex + 1}`, item.purpose, '', item.outcome, start, end, item.minutes * 60, position[0], position[1], 8, lat, lng, start);
        if (item.amount) {
          store.run(`INSERT OR IGNORE INTO reports(id,user_id,shift_id,type,title,body,customer,amount,lat,lng,accuracy,status,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,'reviewed',?)`, `visit:${id}`, rep.id, null, 'collection', `تحصيل - ${item.customer}`,
            item.outcome, item.customer, item.amount, position[0], position[1], 8, end);
        }
      });
    });
  });
}

function routePosition(route: number[][], position: number): number[] {
  const i = Math.floor(position) % route.length;
  const t = position % 1;
  return route[i].map((v, axis) => v + (route[(i + 1) % route.length][axis] - v) * t);
}
/**
 * Request-driven demo movement.
 *
 * The hosted demo runs on serverless functions: no long-lived process, so the interval
 * simulator above never runs and the map would stand still. This variant advances the demo
 * representatives to the position they "should" be at right now, and is called from the
 * overview endpoint (throttled). Movement is derived from wall-clock time, so a client that
 * polls every few seconds sees the markers travel the same route as the real product.
 */
let lastDemoTick = 0;
let lastDemoPrune = 0;
export function tickDemo(store: Store, minIntervalMs = 1200) {
  const now = Date.now();
  if (now - lastDemoTick < minIntervalMs) return false;
  lastDemoTick = now;
  const users = store.all("SELECT id,email FROM users WHERE is_demo=1 AND active=1 ORDER BY email");
  if (!users.length) return false;
  const prune = now - lastDemoPrune > 60000;
  if (prune) lastDemoPrune = now;
  store.transaction(() => {
    users.forEach((u, index) => {
      if (index === 4) return; // this demo representative is intentionally stationary
      const person = people.find(p => p.email === String(u.email));
      if (!person) return;
      const shift = store.get('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', u.id);
      if (!shift) return;
      const progress = 2.3 + ((now / 1000) * 0.02 + index * 0.35) % 3.2;
      const [lat, lng] = routePosition(person.route, progress);
      store.run(`INSERT INTO locations(point_id,user_id,shift_id,lat,lng,accuracy,speed,heading,battery,recorded_at,received_at,source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, randomUUID(), u.id, shift.id, lat, lng, 7 + index, 7.5 + index, 45, 86 - index * 7, now, now, 'demo');
      store.run('UPDATE users SET last_seen=? WHERE id=?', now, u.id);
      if (prune) {
        // Keep the hosted demo database bounded no matter how long it stays warm.
        store.run(`DELETE FROM locations WHERE user_id=? AND point_id NOT IN
          (SELECT point_id FROM locations WHERE user_id=? ORDER BY recorded_at DESC LIMIT 900)`, u.id, u.id);
      }
    });
  });
  return true;
}
export function startDemoSimulator(store: Store, onChange: () => void) {
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const now = Date.now();
    const users = store.all('SELECT id FROM users WHERE is_demo=1 AND active=1 ORDER BY email');
    store.transaction(() => {
      users.forEach((u, index) => {
        if (index === 4) return;
        const shift = store.get('SELECT id FROM shifts WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', u.id);
        if (!shift) return;
        const email = store.get('SELECT email FROM users WHERE id=?', u.id)!.email;
        const p = people.find(person => person.email === email);
        if (!p) return;
        const [lat, lng] = routePosition(p.route, 2.3 + tick * 0.018);
        store.run(`INSERT INTO locations(point_id,user_id,shift_id,lat,lng,accuracy,speed,heading,battery,recorded_at,received_at,source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, randomUUID(), u.id, shift.id, lat, lng, 8 + index * 2, 4.2 + index, 45, 86 - index * 7, now, now, 'demo');
        store.run('UPDATE users SET last_seen=? WHERE id=?', now, u.id);
      });
    });
    onChange();
  }, 2000);
  timer.unref();
  return () => clearInterval(timer);
}
