import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { getServerOverride, getToken, setServerOverride, setToken } from './storage';
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
/** The address baked into the APK at build time (`EXPO_PUBLIC_API_URL`). */
function resolveBuildBase(): string {
  const configured = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl || process.env.EXPO_PUBLIC_API_URL || '';
  if (configured) return configured.replace(/\/$/, '');
  if (Platform.OS === 'web') return '';
  // Development: use the same host as the Metro server, on the API port.
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return host ? `http://${host}:3000` : '';
}

/**
 * A phone left on a dead LAN address is the single most common reason a released build "shows the
 * wrong password": the request never reaches the company server, it reaches whatever else answers
 * on that address. Rebuilding the APK every time a router hands out a new IP was not workable, so
 * the address can now be retyped on the phone and is kept next to the session token.
 *
 * `null` means "no override" — the baked-in address stays in force, so a normal engineer who never
 * opens this field behaves exactly like every previous build.
 */
const BUILD_API_BASE = resolveBuildBase();
let serverOverride: string | null = null;
let overrideLoaded: Promise<void> | null = null;

/**
 * Accepts `192.168.1.5:3000`, `localhost:3000` or a full `http(s)://…` URL and returns a base with
 * no trailing slash. Deliberately regex-only: `new URL()` is not dependable under Hermes, and a
 * typo here would look like a server outage.
 */
export function normalizeServerUrl(raw: string): string | null {
  let value = (raw || '').trim().replace(/\s+/g, '');
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  if (!/^https?:\/\/[^/\s]+(\/[^\s]*)?$/i.test(value)) return null;
  const host = value.slice(value.indexOf('://') + 3).split('/')[0];
  // IPv4 or a hostname (dots/hyphens/underscore), optional port. No scheme, no spaces, no path.
  if (!/^[a-z0-9._-]+(?::\d{2,5})?$/i.test(host)) return null;
  return value.replace(/\/+$/, '');
}

/** The address every request goes to right now: the phone's override, else the build's. */
export function apiBase(): string {
  return (serverOverride ?? BUILD_API_BASE).replace(/\/+$/, '');
}
/** True on a native build whose baked-in address was replaced on the phone. */
export const usingCustomServer = () => serverOverride !== null;
/** Hidden on the web: the browser already talks to whatever origin served the page. */
export const SERVER_EDITABLE = Platform.OS !== 'web';
/**
 * A build with no server address is a packaging mistake, not a dropped connection. It used to
 * fall back to `http://127.0.0.1:3000`, so a released app silently reported "لا يوجد اتصال"
 * forever; the login screen now says the build is unconfigured and offers the address field.
 */
export function unconfigured(): boolean { return apiBase() === '' && Platform.OS !== 'web'; }

async function readServerOverride(): Promise<void> {
  const stored = await getServerOverride().catch(() => null);
  const valid = stored ? normalizeServerUrl(stored) : null;
  if (valid) serverOverride = valid;
  else if (stored) await setServerOverride(null).catch(() => undefined);
}
/** Reads the stored address once per process — background tasks share this module too. */
export function ensureApiBase(): Promise<void> {
  if (!overrideLoaded) overrideLoaded = readServerOverride();
  return overrideLoaded;
}
/** Saves a typed address after validating it, and switches every later request to it. */
export async function saveServerAddress(raw: string): Promise<string> {
  const value = normalizeServerUrl(raw);
  if (!value) throw new ApiError('العنوان مش صحيح. اكتبه هكذا: 192.168.1.5:3000 أو https://server.com', 0);
  await setServerOverride(value);
  serverOverride = value;
  return value;
}
/** Puts the build back on the address it shipped with. */
export async function resetServerAddress(): Promise<void> {
  await setServerOverride(null);
  serverOverride = null;
}
/**
 * `/api/health` needs no token, so it answers "is this the right machine?" before the engineer
 * wastes tries on a password. Resolves with the server's own payload, never throws.
 */
export async function pingServer(address: string): Promise<{ ok: boolean; error?: string }> {
  const base = normalizeServerUrl(address);
  if (!base) return { ok: false, error: 'العنوان مكتوب غلط.' };
  try {
    const res = await fetch(`${base}/api/health`, { headers: { Accept: 'application/json' } });
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (res.ok && body?.ok === true) return { ok: true };
    return { ok: false, error: `السيرفر ردّ بكود ${res.status} — ده مش سيرفر الشركة.` };
  } catch {
    return { ok: false, error: 'مفيش رد من العنوان ده. اتأكد إن السيرفر شغال والتليفون على نفس الشبكة.' };
  }
}

/**
 * `queued` marks the endpoints whose caller stores the payload on the phone and retries it: only
 * for those is "saved and will be sent" true. A visit, a shift or a password change is not
 * queued, and telling an engineer in the field that his visit was saved when it was not is the
 * worst message this app can print.
 */
async function request<T>(path: string, init: RequestInit = {}, options: { queued?: boolean } = {}): Promise<T> {
  await ensureApiBase();
  const token = await getToken();
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Mandoub-Client': 'rep', ...(init.headers as Record<string, string> | undefined) };
  if (token) headers['X-Mandoub-Token'] = token;
  if (init.body) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, { ...init, headers });
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
