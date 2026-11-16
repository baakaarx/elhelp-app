export type Role = 'admin' | 'rep';
export interface User {
  id: string; name: string; email: string; role: Role; phone: string; region: string;
  color: string; active: boolean;
}
export interface Shift {
  id: string; user_id: string; started_at: number; ended_at: number | null;
  consent_version: string; consent_at: number;
}
export interface Snapshot {
  id: string; name: string; tracking: boolean; distanceMeters: number; pointCount: number;
  lastSeen: number | null; online: boolean; location: { lat: number; lng: number; accuracy: number | null; recordedAt: number } | null;
}
export interface ShiftResponse { shift: Shift | null; snapshot?: Snapshot; consentVersion: string }
export interface GeoPoint {
  id: string; shiftId: string; lat: number; lng: number;
  accuracy: number | null; speed: number | null; heading: number | null; battery: number | null;
  recordedAt: number;
}
export type ReportType = 'visit' | 'order' | 'collection' | 'note' | 'issue' | 'other';
export interface ReportInput {
  id: string; type: ReportType; title: string; body: string; customer: string;
  amount: number | null; location: { lat: number; lng: number; accuracy: number | null } | null;
}
export interface Report extends ReportInput {
  userId: string; status: 'new' | 'reviewed'; createdAt: number; reviewedAt: number | null; repName: string;
}
export interface DailyVisitInput {
  customerName: string; governorate: string; district: string; village: string; phone: string;
  areaFeddan: number | null; crops: string; recommendations: string; outcome: string;
}
export interface DailyVisit extends DailyVisitInput { id?: string; position?: number }
export interface DailyReportInput {
  version: 1; id: string; engineerName: string; reportDate: string;
  leftAt: string; returnedAt: string; circumstances: string; visits: DailyVisitInput[];
  signedName: string; confirmed: true;
  location: { lat: number; lng: number; accuracy: number | null } | null;
}
export interface DailyReport {
  id: string; userId: string; engineerName: string; reportDate: string; dayName: string;
  leftAt: string; returnedAt: string; circumstances: string; status: 'new' | 'reviewed';
  createdAt: number; reviewedAt: number | null; signedName: string; signedAt: number;
  repName: string; repColor: string; visits: DailyVisit[];
}
export type VisitPurpose = 'visit' | 'order' | 'collection' | 'note' | 'issue' | 'other';
export interface VisitInput {
  id: string;
  customerName: string;
  governorate: string;
  district: string;
  village: string;
  phone: string;
  purpose: VisitPurpose;
  notes: string;
  location: { lat: number; lng: number; accuracy: number | null };
  deviceId?: string;
}
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
export interface RepSummary {
  date: string;
  timezone: string;
  retentionDays: number;
  shift: Shift | null;
  distanceMeters: number;
  pointCount: number;
  firstFixAt: number | null;
  lastFixAt: number | null;
  lastFixAccuracy?: number | null;
  visitsTotal: number;
  visitsCompleted: number;
  openVisit: Visit | null;
  avgVisitSeconds: number | null;
  collectionsCount: number;
  collectionAmount: number;
  dailyReport: { id: string; status: 'new' | 'reviewed'; createdAt: number } | null;
}
export interface RouteResponse {
  date: string;
  timezone: string;
  points: Array<{ id: string; lat: number; lng: number; accuracy: number | null; recordedAt: number; source: 'gps' }>;
  truncated: boolean;
  /** Total fixes of the day; `points` may be a thinned sample of it. */
  pointCount?: number;
  sampled?: boolean;
  distanceMeters: number;
}
export const visitPurposeLabels: Record<VisitPurpose, string> = {
  visit: 'زيارة', order: 'طلبية', collection: 'تحصيل', note: 'ملاحظة', issue: 'مشكلة', other: 'أخرى',
};
export type OutboxKind = 'location' | 'report' | 'daily-report';
export interface OutboxItem {
  key: string; kind: OutboxKind; payload: string; createdAt: number; attempts: number;
}
