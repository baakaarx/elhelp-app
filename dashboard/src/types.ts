export type Role = 'admin' | 'rep';
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** '' (manager) | 'sales' | 'stock' — which tabs this account may open. The server enforces it. */
  scope?: string;
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
  /** The money columns, present when the window has sales data (every window does). */
  invoices?: number;
  revenue?: number;
  collected2?: number;
  outstanding?: number;
  stockShortInvoices?: number;
  topProduct?: string;
  topProductQty?: number;
  topProductRevenue?: number;
  topProductUnit?: string;
  target?: number;
  targetInvoices?: number;
  targetProgress?: number | null;
  lastFixAt: number | null;
}
export interface KpiResponse {
  from: string;
  to: string;
  timezone: string;
  /** The register for the window: what was sold, what was banked, and the company plan. */
  company?: { sales: { invoices: number; revenue: number; collected: number; outstanding: number; stockShort: number; topProduct: { name: string; qty: number; revenue: number; unit: string } | null }; month: string; target: number };
  rows: KpiRow[];
}
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

/**
 * One customer on an engineer's list (`GET /api/customers`). The visit counters are computed by the
 * server, not by the browser, so the number here and the number in the monthly register cannot
 * disagree while somebody is looking at both.
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
  repName: string;
  repColor: string;
  visitCount: number;
  lastVisitAt: number | null;
  openVisits: number;
}

/* ---- Sales: catalogue, warehouses, stock, invoices ---- */

export interface Warehouse {
  id: string;
  name: string;
  governorate: string;
  district: string;
  notes: string;
  active: boolean;
  productCount: number;
  invoiceCount: number;
}

export interface Product {
  id: string;
  name: string;
  unit: string;
  defaultPrice: number;
  notes: string;
  active: boolean;
  /** Across every warehouse unless the screen asked for one. */
  onHand: number;
  lastMovementAt: number | null;
  soldLines: number;
}

export interface StockRow {
  productId: string;
  productName: string;
  unit: string;
  price: number;
  warehouseId: string;
  warehouseName: string;
  onHand: number;
  lastMovementAt: number | null;
  low: boolean;
}

export interface StockMovement {
  id: string;
  productId: string;
  productName: string;
  unit: string;
  warehouseId: string;
  warehouseName: string;
  qty: number;
  kind: 'opening' | 'receipt' | 'sale' | 'return' | 'count' | 'writeoff';
  note: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  by: string;
  createdAt: number;
}

export interface InvoiceLine {
  id: string;
  productId: string | null;
  productName: string;
  unit: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Invoice {
  id: string;
  number: string | null;
  customerId: string | null;
  customerName: string;
  repId: string | null;
  repName: string;
  repColor: string;
  warehouseId: string;
  warehouseName: string;
  invoiceDate: number;
  date: string;
  subtotal: number;
  discount: number;
  total: number;
  paidAmount: number;
  status: 'unpaid' | 'partial' | 'paid';
  stockShort: boolean;
  note: string;
  voided: boolean;
  voidReason: string;
  voidedAt: number | null;
  createdAt: number;
  lineCount?: number;
  lines?: InvoiceLine[];
  /** 'field' = the engineer typed it on his phone; 'dashboard' = the office typed it. */
  source?: 'field' | 'dashboard';
}

export interface SalesSummary {
  from: number;
  to: number;
  totals: {
    count: number;
    subtotal: number;
    discount: number;
    total: number;
    paid: number;
    outstanding: number;
    averageInvoice: number;
    stockShort: number;
  };
  byRep: { repId: string | null; repName: string; repColor: string; invoices: number; total: number; paid: number; outstanding: number; openInvoices: number }[];
  topProducts: { productId: string | null; productName: string; unit: string; qty: number; revenue: number }[];
  balances: { customerId: string | null; customerName: string; outstanding: number; lastInvoiceAt: number | null; invoices: number }[];
  bySource?: { field: { invoices: number; total: number }; dashboard: { invoices: number; total: number } };
}

export interface StaffAccount {
  id: string;
  name: string;
  email: string;
  scope: 'manager' | 'sales' | 'stock';
  active: boolean;
  createdAt: number;
  lastSeen: number | null;
}

/** The monthly statement of the warehouses: opening → in → out → closing, and the ledger behind it. */
export interface StockReportRow {
  warehouseId: string;
  warehouseName: string;
  productId: string;
  productName: string;
  unit: string;
  opening: number;
  inQty: number;
  outQty: number;
  adjustments: number;
  closing: number;
  movements: number;
  onHand: number;
  price?: number;
  inValue?: number;
  outValue?: number;
  closingValue?: number;
}
export interface StockReport {
  from: number;
  to: number;
  valuesVisible: boolean;
  warehouses: string[];
  rows: StockReportRow[];
  totals: Record<string, number>;
  truncated?: boolean;
  ledger: {
    id: string; warehouseId: string; warehouseName: string; productId: string; productName: string; unit: string;
    qty: number; kind: StockMovement['kind']; note: string; createdAt: number; by: string; invoiceNumber: string | null; value?: number;
  }[];
}

/** التحصيل: the event register, grouped by whose money it is and by who typed it. */
export interface CollectionReport {
  from: number;
  to: number;
  totals: { collected: number; entries: number; customers: number };
  /** All-time: what the invoices claim was paid, against what the register holds. */
  lifetime?: { paidOnInvoices: number; registered: number; difference: number };
  byRep: { repId: string | null; repName: string; repColor: string; collected: number; entries: number; fromField: number; fromOffice: number; outstanding: number; openInvoices: number }[];
  byCustomer: { customerId: string | null; customerName: string; collected: number; entries: number; lastAt: number | null }[];
  entries: {
    id: string; amount: number; source: 'office' | 'field'; note: string; createdAt: number;
    repId: string | null; repName: string; recordedBy: string; customerId: string | null; customerName: string;
    invoiceNumber: string | null; invoiceTotal: number | null; invoicePaid: number | null; invoiceStatus: string | null;
  }[];
}

/** الأهداف الشهرية: one plan per engineer (and one for the company), plus the live progress. */
export interface TargetRow {
  month: string;
  repId: string | null;
  repName: string;
  repColor: string;
  repActive: boolean;
  target: number;
  invoiceTarget: number;
  note: string;
  revenue: number;
  invoices: number;
  collected: number;
  remaining: number;
  progress: number | null;
  updatedBy: string;
  updatedAt: number | null;
}
export interface TargetsResponse {
  month: string;
  from: string;
  to: string;
  isCurrentMonth: boolean;
  company: TargetRow;
  reps: TargetRow[];
  retired: TargetRow[];
}
