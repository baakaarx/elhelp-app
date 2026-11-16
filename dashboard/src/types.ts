export type Role = 'admin' | 'rep';
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  phone: string;
  region: string;
  color: string;
  active: boolean;
  approvalStatus?: string;
  deviceId?: string;
  oauthProvider?: string;
}
export interface LocationPoint {
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  battery: number | null;
  recordedAt: number;
  receivedAt: number;
  source: 'gps';
}
export interface Rep extends User {
  online: boolean;
  createdAt: number | null;
  tracking: boolean;
  shiftStartedAt: number | null;
  lastSeen: number | null;
  location: LocationPoint | null;
  distanceMeters: number;
  pointCount: number;
  visitsToday: number;
  openVisit: { id: string; customerName: string; checkedInAt: number } | null;
}
export interface Overview {
  reps: Rep[];
  serverTime: number;
  timezone: string;
  retentionDays: number;
  newReports: number;
  /** Server-side staleness threshold (STALE_GPS_MINUTES), so both sides agree. */
  staleGpsMinutes?: number;
}
/**
 * A stillness justification the engineer sends from the phone after an hour without
 * movement. Without it the manager only saw the alert disappear, never the reason.
 */
export interface IdleReport {
  id: string;
  userId: string;
  repName: string;
  shiftId: string | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  reason: string;
  durationMinutes: number;
  deviceId: string;
  createdAt: number;
}
export const REPORT_TYPES = ['visit', 'order', 'collection', 'note', 'issue', 'other'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export interface Report {
  id: string;
  userId: string;
  shiftId: string | null;
  type: ReportType;
  title: string;
  body: string;
  customer: string;
  amount: number | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  status: 'new' | 'reviewed';
  createdAt: number;
  reviewedAt: number | null;
  repName: string;
  repColor: string;
}
export interface DailyVisit {
  id?: string;
  position?: number;
  customerName: string;
  governorate: string;
  district: string;
  village: string;
  phone: string;
  areaFeddan: number | null;
  crops: string;
  recommendations: string;
  outcome: string;
}
export interface DailyReport {
  id: string;
  userId: string;
  shiftId: string | null;
  engineerName: string;
  reportDate: string;
  dayName: string;
  leftAt: string;
  returnedAt: string;
  circumstances: string;
  status: 'new' | 'reviewed';
  createdAt: number;
  reviewedAt: number | null;
  signedName: string;
  signedAt: number;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  repName: string;
  repColor: string;
  visits: DailyVisit[];
}
export interface RouteResponse {
  date: string;
  timezone: string;
  points: (LocationPoint & { id: string; shiftId: string })[];
  truncated: boolean;
  /** Total fixes of the day; `points` may be a thinned sample of it. */
  pointCount?: number;
  sampled?: boolean;
  distanceMeters: number;
}
export const reportTypeLabels: Record<ReportType, string> = {
  visit: 'زيارة', order: 'طلبية', collection: 'تحصيل', note: 'ملاحظة', issue: 'مشكلة', other: 'أخرى',
};

export type VisitPurpose = 'visit' | 'order' | 'collection' | 'note' | 'issue' | 'other';
export interface Visit {
  id: string;
  userId: string;
  customerName: string;
  governorate: string;
  district: string;
  village: string;
  phone: string;
  purpose: VisitPurpose;
  notes: string;
  outcome: string;
  status: 'open' | 'closed';
  checkedInAt: number;
  checkedOutAt: number | null;
  durationSeconds: number | null;
  inLat: number | null;
  inLng: number | null;
  inAccuracy: number | null;
  outLat: number | null;
  outLng: number | null;
  repName: string;
  repColor: string;
}
export interface ManagerAlert {
  id: string;
  level: 'warn' | 'info';
  code: 'stale_gps' | 'no_signal' | 'no_visits' | 'missing_daily_report' | 'stale_reviews' | string;
  title: string;
  detail: string;
  repId?: string;
  repName?: string;
  at: number;
}
export interface KpiRow {
  repId: string;
  name: string;
  color: string;
  region: string;
  active: boolean;
  distanceMeters: number;
  pointCount: number;
  visits: number;
  visitsCompleted: number;
  avgVisitSeconds: number | null;
  reports: number;
  collected: number;
  dailyReports: number;
  daysWithData: number;
  lastFixAt: number | null;
}
export interface KpiResponse { from: string; to: string; timezone: string; rows: KpiRow[] }
export interface RepSummary {
  date: string;
  timezone: string;
  shift: { id: string; started_at: number } | null;
  distanceMeters: number;
  pointCount: number;
  firstFixAt: number | null;
  lastFixAt: number | null;
  visitsTotal: number;
  visitsCompleted: number;
  openVisit: Visit | null;
  avgVisitSeconds: number | null;
  collectionsCount: number;
  collectionAmount: number;
  dailyReport: { id: string; status: 'new' | 'reviewed'; createdAt: number } | null;
}
export const visitPurposeLabels: Record<VisitPurpose, string> = {
  visit: 'زيارة', order: 'طلبية', collection: 'تحصيل', note: 'ملاحظة', issue: 'مشكلة', other: 'أخرى',
};
