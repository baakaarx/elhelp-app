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
/**
 * The company's customer book, as the office screen reads it.
 *
 * `repId` is null for a customer the manager entered and has not handed to anybody yet — that is a
 * state of the list, not a missing value, and the screen shows him as «من غير مهندس» rather than
 * hiding him. The visit counters come from the server because the row the manager is looking at has
 * to agree with the numbers the reports screen shows.
 */
export type CustomerStage = 'new' | 'following' | 'active' | 'dormant' | 'lost';
export const customerStageLabels: Record<CustomerStage, string> = {
  new: 'جديد', following: 'تحت المتابعة', active: 'دائم', dormant: 'برّد', lost: 'مرفوض',
};
export interface Customer {
  id: string;
  repId: string | null;
  name: string;
  phone: string;
  governorate: string;
  district: string;
  village: string;
  notes: string;
  stage: CustomerStage;
  lostReason: string;
  active: boolean;
  /** النوع اللي بيتسعّر بيه. null = المكتب ما حددش، والطلبية يتسعّر باليد. */
  priceTierId: string | null;
  priceTierName: string;
  createdAt: number;
  updatedAt: number;
  repName: string;
  repColor: string;
  visitCount: number;
  lastVisitAt: number | null;
  openVisits: number;
}
/** One area (محافظة / مركز) as the workbench groups the list by place instead of by person. */
export interface AreaRow {
  governorate: string;
  district: string;
  /** What the table really holds. The labels above are for the screen, these are what gets sent. */
  bareGovernorate: string;
  bareDistrict: string;
  total: number;
  unassigned: number;
  inactive: number;
  visited: number;
  settled: boolean;
  owners: Array<{ repId: string; repName: string; repActive: boolean; customers: number }>;
  suggestedRepId: string | null;
  suggestedRepName: string;
}
export interface AreaBook {
  areas: AreaRow[];
  engineers: Array<{ id: string; name: string; region: string; color: string; active: boolean }>;
  totals: { customers: number; unassigned: number; areas: number };
}
/** What a bulk move is about to do, answered before any of it is written. */
export interface AreaPreview {
  dryRun: boolean;
  matched: number;
  wouldMove: number;
  capped: boolean;
  customers: Array<{ id: string; name: string }>;
  conflicts: Array<{ id: string; name: string }>;
}
export interface MoveResult {
  ok: boolean;
  repName: string;
  matched: number;
  moved: number;
  skipped: number;
  capped: boolean;
  conflicts: Array<{ id: string; name: string }>;
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
  /**
   * Whether the engineer is inside a shift right now. `ended` carries the day he just closed, so
   * a finished shift never prints as a missing value again.
   */
  shiftState?: 'open' | 'ended' | 'none';
  /** When that shift was stopped — only set when `shiftState` is `ended`. */
  shiftEndedAt?: number | null;
  lastSeen: number | null;
  location: LocationPoint | null;
  /** Newest battery reading the phone sent with a fix, plus when it was taken. */
  battery?: { percent: number; recordedAt: number } | null;
  distanceMeters: number;
  pointCount: number;
  visitsToday: number;
  openVisit: { id: string; customerName: string; checkedInAt: number } | null;
  /**
   * The minutes of silence after which THIS engineer counts as "لا إشارة". Wider than
   * `staleGpsMinutes` while a visit is open, because a phone inside a building cannot deliver a
   * usable fix — the server ships it so the map and the alert list agree.
   */
  staleLimitMinutes?: number;
  /** Minutes the newest fixes have all sat inside one 60 m spot — standing still, not lost. */
  stationaryMinutes?: number;
  /**
   * The server's verdict on a silent phone: `gps_blocked` means the app kept reaching the API (so
   * the network is not the story), `gone` means nothing arrived at all, `ok` means he is reporting.
   */
  gap?: { kind: 'ok' | 'gps_blocked' | 'gone'; silenceMinutes: number | null; battery: number | null };
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
  /** Typed on the phone while it had no signal, then sent when the bars came back. */
  recordedOffline: boolean;
  /** Closed by the system (killed app, phone died) before a result was typed. */
  pendingResult: boolean;
  autoClosed: boolean;
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

/**
 * What removing an engineer account would erase, counted by the server (`GET /api/reps/:id/impact`).
 * The dashboard shows these numbers inside the confirm step, so the decision is made on facts.
 */
export interface RepImpact {
  name: string;
  email: string;
  shifts: number;
  locations: number;
  visits: number;
  openVisits: number;
  reports: number;
  dailyReports: number;
  idleReports: number;
  /** True while he has an open shift on a phone — deleting closes it. */
  trackingNow: boolean;
}

/* --------------------------------------------------------------------------- الأصناف والأسعار */

/** ما تبيعه الشركة: مبيدات وأسمدة، وحاجة تانية نادرة. غير ده مرفوض في الراوت نفسه. */
export type ProductCategory = 'pesticide' | 'fertilizer' | 'other';
export const productCategoryLabels: Record<ProductCategory, string> = {
  pesticide: 'مبيدات', fertilizer: 'أسمدة', other: 'أخرى',
};

/** سعر صنف واحد تحت نوع مشترٍ واحد. الغياب حالة عادية: «لسه ما اتسعّرش». */
export interface ProductPrice {
  tierId: string;
  price: number;
}

/**
 * الصنف = اسم + عبوة. `unitSize` سطر يشرح جوّا العبوة إيه («٥٠٠ مل»، «٥٠ كجم») — بيتقرا ومش
 * بيحسب: اللي بيحدد الرقم هو عمود «العبوة»، مش رقم مخفي في نص.
 */
export interface Product {
  id: string;
  name: string;
  category: ProductCategory;
  unit: string;
  unitSize: string;
  notes: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  /** الأعمدة دي للمكتب وحده — قائمة المهندس بتجي من غير `prices` أصلًا. */
  prices?: ProductPrice[];
}

/** رأس قائمة الأسعار: أنواع المشترى اللي المكتب يسمّيها. */
export interface PriceTier {
  id: string;
  name: string;
  position: number;
  active: boolean;
  /** كام صنف عليه سعر تحت النوع ده، وكام عميل بيتسعّر بيه. */
  priced: number;
  customers: number;
}
