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
/**
 * One customer on this engineer's own list. The server scopes every read and write to the signed-in
 * rep, so a phone can never see a colleague's customers.
 */
export interface Customer {
  id: string;
  repId: string;
  name: string;
  phone: string;
  governorate: string;
  district: string;
  village: string;
  notes: string;
  lat: number | null;
  lng: number | null;
  stage: 'new' | 'following' | 'active' | 'dormant' | 'lost';
  lostReason: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  visitCount: number;
  lastVisitAt: number | null;
  openVisits: number;
}
export interface CustomerInput {
  name: string;
  phone: string;
  governorate: string;
  district: string;
  village: string;
  notes: string;
  stage: Customer['stage'];
  /** Required by the server when `stage` is `lost`. */
  lostReason?: string;
  /** Pinned from the visit that created him, so the route map can find him later. */
  lat?: number | null;
  lng?: number | null;
}
export const customerStageLabels: Record<Customer['stage'], string> = {
  new: 'جديد', following: 'قيد المتابعة', active: 'عميل دائم', dormant: 'برّد', lost: 'مرفوض',
};
export interface VisitInput {
  id: string;
  customerName: string;
  /** Present when the visit was booked from the engineer's own customer list. */
  customerId?: string;
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
  /** True when the shift ended (or the cleanup ran) before a result was recorded. */
  autoClosed?: boolean;
  /** Still shows the automatic text: the engineer has not written what happened yet. */
  pendingResult?: boolean;
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
  /** Server's stillness threshold: the banner that asks for a reason follows it. */
  idleReasonMinutes?: number;
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
/** `visit-checkin` / `visit-checkout` are the two halves of a visit typed without a signal. */
export type OutboxKind = 'location' | 'report' | 'daily-report' | 'visit-checkin' | 'visit-checkout';
export interface OutboxItem {
  key: string; kind: OutboxKind; payload: string; createdAt: number; attempts: number;
  /** A permanent server rejection is retained but paused until the engineer manually retries. */
  rejected?: boolean;
}

/* ---- The engineer's own sales: what the office billed in his name, and what the shelf holds ---- */
export interface MyInvoiceLine {
  productName: string;
  unit: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}
export interface MyInvoice {
  id: string;
  number: string | null;
  customerId: string | null;
  customerName: string;
  warehouseName: string;
  date: string;
  invoiceDate: number;
  total: number;
  paidAmount: number;
  status: 'unpaid' | 'partial' | 'paid';
  stockShort: boolean;
  note: string;
  lines: MyInvoiceLine[];
}
export interface CatalogueProduct {
  id: string;
  name: string;
  unit: string;
  price: number;
  onHand: number;
  warehouses: { name: string; onHand: number }[];
}
export interface SalesTotals {
  total: number;
  paid: number;
  outstanding: number;
  count: number;
}
export const invoiceStatusLabels: Record<MyInvoice['status'], string> = {
  unpaid: 'غير محصّل', partial: 'نص تحصيل', paid: 'محصّل',
};
