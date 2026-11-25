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
 * A row of the company's customer book — the only way a visit can name a customer.
 *
 * The list is entered and divided by the sales office; the phone reads its own slice of it. That is
 * why there is no "add a customer" here: a name typed in front of a farm is how one man becomes three
 * customers and three numbers in the manager's report.
 */
export type CustomerStage = 'new' | 'following' | 'active' | 'dormant' | 'lost';
export const customerStageLabels: Record<CustomerStage, string> = {
  new: 'جديد', following: 'تحت المتابعة', active: 'دائم', dormant: 'برّد', lost: 'مرفوض',
};
export interface Customer {
  id: string;
  name: string;
  phone: string;
  governorate: string;
  district: string;
  village: string;
  notes: string;
  stage: CustomerStage;
  active: boolean;
  /** How many visits the book has on him, and when the last one was — the cooling clock, on paper. */
  visitCount: number;
  lastVisitAt: number | null;
  openVisits: number;
  repName: string;
}
export interface VisitInput {
  id: string;
  /** The row in the office's book. The visit's name, phone and area are read from it, not typed. */
  customerId: string;
  purpose: VisitPurpose;
  notes: string;
  location: { lat: number; lng: number; accuracy: number | null };
  deviceId?: string;
  /**
   * Sent only when the phone knows something the book does not — a customer met at his warehouse,
   * a corrected number. Left out, the server copies the address from the customer's row.
   */
  governorate?: string;
  district?: string;
  village?: string;
  phone?: string;
}
export interface Visit {
  id: string;
  userId: string;
  customerName: string;
  /**
   * The row in the office's book this visit was booked against. Null on a visit recorded before the
   * book existed — the typed name stays readable, nothing is merged into a customer by guessing.
   */
  customerId?: string | null;
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
export type OutboxKind = 'location' | 'report' | 'daily-report' | 'visit-checkin' | 'visit-checkout' | 'order';
export interface OutboxItem {
  key: string; kind: OutboxKind; payload: string; createdAt: number; attempts: number;
  /** A permanent server rejection is retained but paused until the engineer manually retries. */
  rejected?: boolean;
}

/* ------------------------------------------------ الطلبيات: الكميات اللي الميدان اتفق عليها */

export interface OrderLineInput {
  productId: string;
  /** مرقومة بوحدة الصنف نفسها (شيكارة/عبوة/جركن) — مش وزن ولا كرتونة. */
  qty: number;
  notes?: string;
}
export interface OrderInput {
  id: string;
  /** سطر من قائمة المكتب — الطلبية ما تتسجلش على اسم مكتوب بالإيد، زي الزيارة بالظبط. */
  customerId: string;
  visitId?: string;
  notes: string;
  lines: OrderLineInput[];
  /** ضغطة الميدان معناها «ابعت»؛ المسودة للطلبية اللي عايز تكملها بعد شوية. */
  send?: boolean;
  /** بتبعتها الطابور اللي من غير شبكة، زي الزيارة المتأخرة. */
  recordedAt?: number;
}
/** اللي بيرجع للتليفون: أصناف وكميات وحالة بس — مفيش سعر ولا إجمالي على شاشة المندوب. */
export interface OrderView {
  id: string;
  sold: boolean;
  status: 'draft' | 'sent' | 'priced';
  notes: string;
  customerName: string;
  createdAt: number;
  sentAt: number | null;
  recordedOffline: boolean;
  lines: Array<{ productId: string; productName: string; unit: string; unitSize: string; qty: number }>;
}

/* --------------------------------------------------------------- ما تبيعه الشركة: الأصناف وعبواتها */

/**
 * The catalogue the office writes. The phone reads it and never prices from it.
 *
 * A rep's `GET /api/products` carries no `prices` key at all — the server attaches prices to an admin
 * session only — so there is no number here for an engineer to misread in front of a farmer, and none to
 * be held to later. `notes` is left off the same way on purpose: it is what the office tells itself about
 * storage and shelf life, and a screen that shows it will be read as a promise to the customer.
 */
export type ProductCategory = 'pesticide' | 'fertilizer' | 'other';
export const productCategoryLabels: Record<ProductCategory, string> = {
  pesticide: 'مبيدات', fertilizer: 'أسمدة', other: 'أخرى',
};
export interface Product {
  id: string;
  name: string;
  category: ProductCategory;
  /** ما بيتباع بيه: «عبوة»، «شيكارة»، «جركن». أي كمية في أي طلبية بتُعدّ بالوحدة دي. */
  unit: string;
  /** «٥٠ كجم»، «٥٠٠ مل» — سطر يتقري، ما بيحسبش: الحجم الحقيقي هو اللي في `unit`. */
  unitSize: string;
  active: boolean;
}
