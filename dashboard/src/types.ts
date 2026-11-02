export type Role = 'admin' | 'rep';
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  phone: string;
  region: string;
  color: string;
  isDemo: boolean;
  active: boolean;
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
  source: 'gps' | 'demo';
}
export interface Rep extends User {
  online: boolean;
  tracking: boolean;
  shiftStartedAt: number | null;
  lastSeen: number | null;
  location: LocationPoint | null;
  distanceMeters: number;
  pointCount: number;
}
export interface Overview {
  reps: Rep[];
  serverTime: number;
  demo: boolean;
  timezone: string;
  retentionDays: number;
  newReports: number;
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
  repIsDemo: number;
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
  repIsDemo: number;
  visits: DailyVisit[];
}
export interface RouteResponse {
  date: string;
  timezone: string;
  points: (LocationPoint & { id: string; shiftId: string })[];
  truncated: boolean;
  distanceMeters: number;
}
export const reportTypeLabels: Record<ReportType, string> = {
  visit: 'زيارة', order: 'طلبية', collection: 'تحصيل', note: 'ملاحظة', issue: 'مشكلة', other: 'أخرى',
};
