import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { getToken, setToken, clearTokenIfMatches } from './storage';
import { isConfirmedOrderResponse } from './orderDelivery';
import { confirmedCheckIn, confirmedCheckOut, confirmedDailyReport, confirmedReport } from './actionConfirmation';
import { networkMessage } from './networkMessage';
import type { Customer, DailyReportInput, GeoPoint, OrderInput, OrderView, Product, ReportInput, RepSummary, RouteResponse, Shift, ShiftResponse, User, Visit, VisitInput } from './types';

export class ApiError extends Error {
  status: number;
  /**
   * The server's machine-readable reason when it sends one (`CLOCK_SKEW`,
   * `DAILY_REPORT_EXISTS`, `GPS_REQUIRED`, …). Without it a caller can only guess from the
   * status code, and a batch of GPS fixes rejected for a fast phone clock looked exactly like
   * a batch of corrupt fixes.
   */
  code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; if (code) this.code = code; }
}
function resolveBase(): string {
  const configured = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl || process.env.EXPO_PUBLIC_API_URL || '';
  if (configured) return configured.replace(/\/$/, '');
  if (Platform.OS === 'web') return '';
  // Development: use the same host as the Metro server, on the API port.
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return host ? `http://${host}:3000` : '';
}
export const API_BASE = resolveBase();
/**
 * A build with no server address is a packaging mistake, not a dropped connection. It used to
 * fall back to `http://127.0.0.1:3000`, so a released app silently reported "لا يوجد اتصال"
 * forever; the app now refuses to pretend and says the build is not configured.
 */
export const UNCONFIGURED = API_BASE === '' && Platform.OS !== 'web';

/**
 * A network failure cannot tell us whether the server committed a write. Queueing callers
 * report local persistence only after it succeeds; other callers must verify before repeating.
 */
// Bind this runtime to the session it displayed. Another tab may replace localStorage, but
// it must never silently turn this tab's actions into actions by the other account.
let boundToken: string | null | undefined;
export async function clearCurrentSession(): Promise<void> {
  const expected = boundToken === undefined ? await getToken() : boundToken;
  await clearTokenIfMatches(expected);
  boundToken = null;
}
async function request<T>(path: string, init: RequestInit = {}, expectedToken?: string): Promise<T> {
  const current = await getToken();
  const loginRequest = path === '/api/auth/login' || path === '/api/auth/oauth';
  if (boundToken === undefined && !loginRequest) boundToken = current;
  if (!loginRequest && current !== boundToken) throw new ApiError('الجلسة اتغيرت في تبويب آخر. سجّل الدخول من جديد قبل المتابعة.', 401, 'SESSION_CHANGED');
  if (expectedToken !== undefined && (current !== expectedToken || boundToken !== expectedToken)) throw new ApiError('الجلسة اتغيرت؛ البيانات محفوظة لحسابها ولم تُرسل.', 401, 'SESSION_CHANGED');
  const token = loginRequest ? null : boundToken;
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Mandoub-Client': 'rep', ...(init.headers as Record<string, string> | undefined) };
  if (token) headers['X-Mandoub-Token'] = token;
  if (init.body) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(networkMessage(path, init.method), 0);
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401 && !loginRequest) { await clearTokenIfMatches(token ?? null); boundToken = null; }
    const code = typeof body?.code === 'string' ? body.code : undefined;
    throw new ApiError(body?.error || `فشل الطلب (${res.status})`, res.status, code);
  }
  return body as T;
}
export const post = <T>(path: string, data: unknown, expectedToken?: string) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(data) }, expectedToken);
export const get = <T>(path: string) => request<T>(path, { method: 'GET' });
/**
 * Erases the signed-in account on the server. The email acts as the confirmation step the
 * stores expect, exactly like the dashboard form.
 */
export const changeMyPassword = (currentPassword: string, newPassword: string) =>
  request<{ ok: true }>('/api/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });

export const deleteMyAccount = (email: string) =>
  request<{ ok: true }>('/api/me', { method: 'DELETE', body: JSON.stringify({ confirm: true, email }) });

/**
 * الطلبية بتتبعت من غير GPS ومن غير وردية: هي وعد بالكميات مش بحركة — والضغط نفسه معناه «ابعت»،
 * فالطابور هنا بيستقبل نفس الجسم لو الشبكة قطعت، والسيرفر بيقبل إعادة الإرسال من غير ما يضاعف.
 */
export async function createOrder(order: OrderInput, expectedToken?: string) {
  const result = await post<{ order: OrderView; duplicate: boolean }>('/api/orders', order, expectedToken);
  if (!isConfirmedOrderResponse(order, result)) {
    throw new ApiError('تعذر التأكد من بيانات الطلبية عند المكتب. راجع المكتب قبل إعادة إرسالها.', 503, 'ORDER_CONFIRMATION_UNCERTAIN');
  }
  return result;
}
export const myOrders = () => get<{ orders: OrderView[] }>('/api/orders?limit=50');
export type OrderInvoiceNotice = { orderId: string; customerName: string; createdAt: number };
export const orderInvoiceNotices = () => get<{ notices: OrderInvoiceNotice[] }>('/api/me/order-invoice-notices');
export const readOrderInvoiceNotice = (orderId:string) => post<{ok:true}>(`/api/me/order-invoice-notices/${encodeURIComponent(orderId)}/read`, {});

export async function login(email: string, password: string) {
  const res = await post<{ token: string; user: User }>('/api/auth/login', { email: email.trim().toLowerCase(), password });
  await setToken(res.token);
  boundToken = res.token;
  return res.user;
}
export const me = () => get<{ user: User }>('/api/auth/me').then(r => r.user);
/** A queued action may only travel with a token verified for its saved owner. */
export async function verifiedOwnerToken(owner: string): Promise<string> {
  const token = await getToken();
  if (!token) throw new ApiError('سجّل الدخول بالحساب صاحب البيانات لمزامنتها.', 401);
  const result = await request<{user:User}>('/api/auth/me', {}, token);
  if (result?.user?.id !== owner) throw new ApiError('البيانات المحفوظة تخص حسابًا آخر؛ لم تُرسل.', 401, 'SESSION_CHANGED');
  return token;
}
export async function logout() {
  try { await post('/api/auth/logout', {}); } finally { await clearCurrentSession(); }
}
export const shiftState = () => get<ShiftResponse>('/api/me/shift?snapshot=0');
export async function startShift(consentVersion: string, location: { lat: number; lng: number; accuracy: number | null }, deviceId: string, deviceName?: string) {
  return post<{ shift: Shift }>('/api/shifts/start', { consentVersion, location, deviceId, deviceName });
}
export async function stopShift() {
  return post<{ ok: true }>('/api/shifts/stop', {});
}
export const reportIdle = (reason: string, location: { lat: number; lng: number; accuracy: number | null }, deviceId: string) =>
  post<{ id: string; idleMinutes: number }>('/api/shifts/idle', { reason, location, deviceId });
/** Which social sign-ins this server can actually verify (it owns the client ids, not the app). */
export const authProviders = () =>
  get<{ google: boolean; apple: boolean }>('/api/auth/providers').catch(() => ({ google: false, apple: false }));

/**
 * Exchanges a Google/Apple ID token for a session. The token is the proof; the account must
 * already exist on the server, so a personal Google account cannot create itself access.
 */
export async function oauthLogin(provider: 'google' | 'apple', idToken: string, name?: string) {
  const res = await post<{ token: string; user: User }>('/api/auth/oauth', { provider, idToken, name });
  await setToken(res.token);
  boundToken = res.token;
  return res.user;
}
export const pushLocations = (points: GeoPoint[], expectedToken?: string) => post<{ accepted: number; duplicates: number }>('/api/locations', { points }, expectedToken);
export async function sendReport(report: ReportInput, expectedToken?: string) {
  const result = await post<{ report: { id: string }; duplicate: boolean }>('/api/reports', report, expectedToken);
  if (!confirmedReport(report, result)) throw new ApiError('تعذر التأكد من التقرير المحفوظ. لا تكرره، وراجع المكتب.', 503, 'ACTION_CONFIRMATION_UNCERTAIN');
  return result;
}
export async function sendDailyReport(report: DailyReportInput, expectedToken?: string) {
  const result = await post<{ report: { id: string }; duplicate: boolean }>('/api/daily-reports', report, expectedToken);
  if (!confirmedDailyReport(report, result)) throw new ApiError('تعذر التأكد من التقرير اليومي المحفوظ. لا تكرره، وراجع المكتب.', 503, 'ACTION_CONFIRMATION_UNCERTAIN');
  return result;
}
export const myReports = () => get<{ reports: ReportInput[] }>('/api/reports');
export const myDailyReports = () => get<{ reports: unknown[] }>('/api/daily-reports');
export const presence = () => post<{ ok: true }>('/api/presence', {});
export const registerPushToken = (data: { token: string; platform: 'ios' | 'android'; deviceId: string }) =>
  post<{ ok: true }>('/api/push/token', data);
export const pushStatus = () => get<{ enabled: boolean }>('/api/push/status');
export const disablePush = (deviceId: string) =>
  request<{ ok: true }>('/api/push/token', { method: 'DELETE', body: JSON.stringify({ deviceId }) });
export const reportMockLocation = (shiftId: string, deviceId: string) =>
  post<{ ok: true; duplicate?: boolean }>('/api/security/mock-location', { shiftId, deviceId });

export const mySummary = (date?: string) => get<RepSummary>(`/api/me/summary${date ? `?date=${date}` : ''}`);
export const myVisits = (date?: string) => get<{ visits: Visit[] }>(`/api/visits${date ? `?date=${date}` : ''}`);
/**
 * The engineers's own slice of the company's customer book — the list a visit is booked from. The
 * server scopes it by session (this endpoint never returns another man's customers) and leaves out
 * the customers the office stopped. Read-only on purpose: adding and moving customers is the office's
 * job, on the dashboard.
 */
export async function myCustomers(): Promise<{ customers: Customer[] }> {
  const customers: Customer[] = [];
  const limit = 500;
  for (let offset = 0; offset <= 1_000_000; offset += limit) {
    const page = await get<{ customers: Customer[]; hasMore?: boolean }>(`/api/customers?limit=${limit}&offset=${offset}`);
    if (!Array.isArray(page?.customers)) throw new Error('تعذر قراءة قائمة العملاء كاملة.');
    customers.push(...page.customers);
    if (!page.hasMore) return { customers };
    if (page.customers.length === 0) throw new Error('تعذر إكمال تحميل قائمة العملاء.');
  }
  throw new Error('قائمة العملاء أكبر من الحد المتاح للتحميل.');
}
/**
 * قائمة الأصناف — للقراءة في الميدان.
 *
 * No prices arrive on a phone session, and that is the whole design: «بقدّم إيه» question is answered
 * here, «بكام» is answered by the office. Cached the way the customer book is, because the question gets
 * asked in a farm with two bars of signal.
 */
export const myProducts = () => get<{ products: Product[] }>('/api/products');
export const myRoute = (userId: string, date?: string) => get<RouteResponse>(`/api/reps/${userId}/route${date ? `?date=${date}` : ''}`);
/**
 * `recordedAt` is the instant the visit was recorded. It is only sent when the phone had no
 * signal and kept the visit: a live request lets the server stamp its own clock.
 */
export async function checkInVisit(visit: VisitInput & { recordedAt?: number }, expectedToken?: string) {
  const result = await post<{ visit: Visit; duplicate: boolean; recordedOffline?: boolean }>('/api/visits/check-in', visit, expectedToken);
  if (!confirmedCheckIn(visit, result)) throw new ApiError('تعذر التأكد من تسجيل الزيارة. لا تكررها، وراجع المكتب.', 503, 'ACTION_CONFIRMATION_UNCERTAIN');
  return result;
}
export interface CheckOutBody {
  outcome: string; notes: string; amount: number | null;
  location: { lat: number; lng: number; accuracy: number | null } | null;
  recordedAt?: number;
}
export async function checkOutVisit(id: string, body: CheckOutBody, expectedToken?: string) {
  const result = await post<{ visit: Visit; duplicate: boolean; recordedLate?: boolean }>(`/api/visits/${id}/check-out`, body, expectedToken);
  if (!confirmedCheckOut(id, body, result)) throw new ApiError('تعذر التأكد من حفظ نتيجة الزيارة. لا تكررها، وراجع المكتب.', 503, 'ACTION_CONFIRMATION_UNCERTAIN');
  return result;
}
