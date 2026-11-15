import { z } from 'zod';
import type { Store } from './db.js';
import { dayBounds, localDate } from './geo.js';

export const DAILY_REPORT_VERSION = 1;
const text = (max: number) => z.string().trim().max(max);
const clock = z.string().trim().max(30);
export const dailyVisitSchema = z.object({
  customerName: text(120).min(2, 'اسم العميل / المزرعة مطلوب.'),
  governorate: text(80).default(''),
  district: text(80).default(''),
  village: text(120).default(''),
  phone: text(30).default(''),
  areaFeddan: z.number().finite().min(0).max(1_000_000).nullable().default(null),
  crops: text(300).default(''),
  recommendations: text(1000).default(''),
  outcome: text(1000).default(''),
}).strict();
export const newDailyReportSchema = z.object({
  version: z.literal(DAILY_REPORT_VERSION),
  id: z.uuid(),
  engineerName: text(120).min(2, 'اسم المهندس مطلوب.'),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD.'),
  leftAt: z.union([clock, z.literal('')]).default(''),
  returnedAt: z.union([clock, z.literal('')]).default(''),
  circumstances: text(1000).default(''),
  visits: z.array(dailyVisitSchema).min(1, 'أضف زيارة واحدة على الأقل.').max(30, 'الحد الأقصى ٣٠ زيارة في التقرير اليومي.'),
  signedName: text(120).min(2, 'اكتب اسمك للتوقيع الإلكتروني.'),
  confirmed: z.literal(true, { error: 'أكد صحة البيانات ووقّع إلكترونيًا قبل الإرسال.' }),
  location: z.object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    accuracy: z.number().finite().min(0).max(100000).nullable(),
  }).strict().nullable().default(null),
}).strict();
export type NewDailyReport = z.infer<typeof newDailyReportSchema>;
export type DailyVisit = z.infer<typeof dailyVisitSchema> & { id: string; position: number };
export interface DailyReport {
  id: string; version: number; userId: string; shiftId: string | null;
  engineerName: string; reportDate: string; dayName: string; leftAt: string; returnedAt: string; circumstances: string;
  status: 'new' | 'reviewed'; createdAt: number; reviewedAt: number | null;
  signedName: string; signedAt: number; lat: number | null; lng: number | null; accuracy: number | null;
  repName: string; repColor: string; visits: DailyVisit[];
}
export function weekdayName(date: string, timezone: string) {
  const { start } = dayBounds(date, timezone);
  return new Intl.DateTimeFormat('ar-EG', { weekday: 'long', timeZone: timezone }).format(start + 43200000);
}
const SELECT = `SELECT d.id, d.user_id AS userId, d.shift_id AS shiftId, d.engineer_name AS engineerName,
  d.report_date AS reportDate, d.day_name AS dayName, d.left_at AS leftAt, d.returned_at AS returnedAt,
  d.circumstances, d.status, d.created_at AS createdAt, d.reviewed_at AS reviewedAt,
  d.signed_name AS signedName, d.signed_at AS signedAt, d.lat, d.lng, d.accuracy,
  u.name AS repName, u.color AS repColor
  FROM daily_reports d JOIN users u ON u.id=d.user_id`;
function visits(store: Store, reportId: string): DailyVisit[] {
  return store.all(`SELECT id, position, customer_name AS customerName, governorate, district, village, phone,
    area_feddan AS areaFeddan, crops, recommendations, outcome FROM daily_report_visits WHERE report_id=? ORDER BY position`, reportId) as unknown as DailyVisit[];
}
export function dailyReportRow(store: Store, id: string): DailyReport | undefined {
  const row = store.get(`${SELECT} WHERE d.id=?`, id);
  if (!row) return undefined;
  return { ...row, version: DAILY_REPORT_VERSION, visits: visits(store, id) } as DailyReport;
}
export function listDailyReports(store: Store, filter: { userId?: string; repId?: string; status?: string; date?: string; from?: string; to?: string }) {
  const where: string[] = []; const params: any[] = [];
  if (filter.userId) { where.push('d.user_id=?'); params.push(filter.userId); }
  if (filter.repId) { where.push('d.user_id=?'); params.push(filter.repId); }
  if (filter.status) { where.push('d.status=?'); params.push(filter.status); }
  if (filter.date) { where.push('d.report_date=?'); params.push(filter.date); }
  if (filter.from) { where.push('d.report_date>=?'); params.push(filter.from); }
  if (filter.to) { where.push('d.report_date<=?'); params.push(filter.to); }
  const rows = store.all(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.report_date DESC, d.created_at DESC LIMIT 300`, ...params);
  return rows.map(row => ({ ...row, version: DAILY_REPORT_VERSION, visits: visits(store, String(row.id)) })) as DailyReport[];
}
export function insertDailyReport(store: Store, userId: string, shiftId: string | null, data: NewDailyReport, now: number, timezone: string) {
  const dayName = weekdayName(data.reportDate, timezone);
  store.transaction(() => {
    const result = store.run(`INSERT OR IGNORE INTO daily_reports(id,user_id,shift_id,engineer_name,report_date,day_name,left_at,returned_at,circumstances,status,created_at,signed_name,signed_at,lat,lng,accuracy)
      VALUES (?,?,?,?,?,?,?,?,?,'new',?,?,?,?,?,?)`, data.id, userId, shiftId, data.engineerName, data.reportDate, dayName, data.leftAt, data.returnedAt,
      data.circumstances, now, data.signedName, now, data.location?.lat ?? null, data.location?.lng ?? null, data.location?.accuracy ?? null);
    if (!result.changes) return;
    data.visits.forEach((visit, index) => {
      store.run(`INSERT INTO daily_report_visits(id,report_id,position,customer_name,governorate,district,village,phone,area_feddan,crops,recommendations,outcome)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, `${data.id}:${index + 1}`, data.id, index + 1, visit.customerName, visit.governorate, visit.district, visit.village,
        visit.phone, visit.areaFeddan, visit.crops, visit.recommendations, visit.outcome);
    });
  });
}
export function validateReportDate(date: string, timezone: string, retentionDays: number) {
  dayBounds(date, timezone);
  const today = localDate(timezone);
  if (date > today) throw new Error('لا يمكن إرسال تقرير بتاريخ مستقبلي.');
  const oldest = localDate(timezone, Date.now() - retentionDays * 86400000);
  if (date < oldest) throw new Error('التاريخ أقدم من مدة الاحتفاظ بالبيانات.');
}
