import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { getToken, setToken } from './storage';
import type { DailyReportInput, GeoPoint, ReportInput, RepSummary, RouteResponse, Shift, ShiftResponse, User, Visit, VisitInput } from './types';

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
 * `queued` marks the endpoints whose caller stores the payload on the phone and retries it: only
 * for those is "saved and will be sent" true. A visit, a shift or a password change is not
 * queued, and telling an engineer in the field that his visit was saved when it was not is the
 * worst message this app can print.
 */
async function request<T>(path: string, init: RequestInit = {}, options: { queued?: boolean } = {}): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Mandoub-Client': 'rep', ...(init.headers as Record<string, string> | undefined) };
  if (token) headers['X-Mandoub-Token'] = token;
  if (init.body) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(options.queued
      ? 'لا يوجد اتصال بالإنترنت. سيتم حفظ البيانات وإرسالها تلقائيًا.'
      : 'لا يوجد اتصال بالإنترنت — لم يُحفظ أي شيء. أعد المحاولة عندما تعود الشبكة.', 0);
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401) await setToken(null);
    const code = typeof body?.code === 'string' ? body.code : undefined;
    throw new ApiError(body?.error || `فشل الطلب (${res.status})`, res.status, code);
  }
  return body as T;
}
export const post = <T>(path: string, data: unknown, options: { queued?: boolean } = {}) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(data) }, options);
export const get = <T>(path: string) => request<T>(path, { method: 'GET' });
/**
 * Erases the signed-in account on the server. The email acts as the confirmation step the
 * stores expect, exactly like the dashboard form.
 */
export const changeMyPassword = (currentPassword: string, newPassword: string) =>
  request<{ ok: true }>('/api/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });

export const deleteMyAccount = (email: string) =>
  request<{ ok: true }>('/api/me', { method: 'DELETE', body: JSON.stringify({ confirm: true, email }) });

export async function login(email: string, password: string) {
  const res = await post<{ token: string; user: User }>('/api/auth/login', { email: email.trim().toLowerCase(), password });
  await setToken(res.token);
  return res.user;
}
export const me = () => get<{ user: User }>('/api/auth/me').then(r => r.user);
export async function logout() {
  try { await post('/api/auth/logout', {}); } finally { await setToken(null); }
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
  return res.user;
}
export const pushLocations = (points: GeoPoint[]) => post<{ accepted: number; duplicates: number }>('/api/locations', { points }, { queued: true });
export const sendReport = (report: ReportInput) => post<{ report: { id: string } }>('/api/reports', report, { queued: true });
export const sendDailyReport = (report: DailyReportInput) => post<{ report: { id: string } }>('/api/daily-reports', report, { queued: true });
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
export const myRoute = (userId: string, date?: string) => get<RouteResponse>(`/api/reps/${userId}/route${date ? `?date=${date}` : ''}`);
/**
 * `recordedAt` is the instant the visit was recorded. It is only sent when the phone had no
 * signal and kept the visit: a live request lets the server stamp its own clock.
 */
export const checkInVisit = (visit: VisitInput & { recordedAt?: number }) =>
  post<{ visit: Visit; duplicate: boolean; recordedOffline?: boolean }>('/api/visits/check-in', visit);
export interface CheckOutBody {
  outcome: string; notes: string; amount: number | null;
  location: { lat: number; lng: number; accuracy: number | null } | null;
  recordedAt?: number;
}
export const checkOutVisit = (id: string, body: CheckOutBody) =>
  post<{ visit: Visit; duplicate: boolean; recordedLate?: boolean }>(`/api/visits/${id}/check-out`, body);
