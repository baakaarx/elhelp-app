import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { getShiftToken, getToken, setShiftToken, setToken } from './storage';
import type { DailyReportInput, GeoPoint, ReportInput, RepSummary, RouteResponse, Shift, ShiftResponse, User, Visit, VisitInput } from './types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
function resolveBase(): string {
  const configured = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl || process.env.EXPO_PUBLIC_API_URL || '';
  if (configured) return configured.replace(/\/$/, '');
  if (Platform.OS === 'web') return '';
  // Development: use the same host as the Metro server, on the API port.
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return host ? `http://${host}:3000` : 'http://127.0.0.1:3000';
}
export const API_BASE = resolveBase();

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Mandoub-Client': 'rep', ...(init.headers as Record<string, string> | undefined) };
  if (token) headers['X-Mandoub-Token'] = token;
  // Hosted demo: the signed shift lets a fresh instance keep the same shift instead of
  // answering "you are outside the shift" every time the request lands elsewhere.
  const shiftToken = await getShiftToken();
  if (shiftToken) headers['X-Mandoub-Shift'] = shiftToken;
  if (init.body) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError('لا يوجد اتصال بالإنترنت. سيتم حفظ البيانات وإرسالها تلقائيًا.', 0);
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401) await setToken(null);
    throw new ApiError(body?.error || `فشل الطلب (${res.status})`, res.status);
  }
  return body as T;
}
export const post = <T>(path: string, data: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const get = <T>(path: string) => request<T>(path, { method: 'GET' });

export async function login(email: string, password: string) {
  const res = await post<{ token: string; user: User }>('/api/auth/login', { email: email.trim().toLowerCase(), password });
  await setToken(res.token);
  return res.user;
}
export const me = () => get<{ user: User }>('/api/auth/me').then(r => r.user);
export async function logout() {
  try { await post('/api/auth/logout', {}); } finally { await setToken(null); await setShiftToken(null); }
}
export const shiftState = () => get<ShiftResponse>('/api/me/shift');
export async function startShift(consentVersion: string, location: { lat: number; lng: number; accuracy: number | null }, deviceId: string, deviceName?: string) {
  const res = await post<{ shift: Shift; shiftToken?: string | null }>('/api/shifts/start', { consentVersion, location, deviceId, deviceName });
  await setShiftToken(res.shiftToken || null);
  return res;
}
export async function stopShift() {
  const res = await post<{ ok: true }>('/api/shifts/stop', {});
  await setShiftToken(null);
  return res;
}
export const reportIdle = (reason: string, location: { lat: number; lng: number; accuracy: number | null }, deviceId: string) =>
  post<{ id: string; idleMinutes: number }>('/api/shifts/idle', { reason, location, deviceId });
export const socialLogin = (provider: 'google' | 'apple', idToken: string, deviceId?: string, deviceName?: string) =>
  post<{ token: string; user: User }>('/api/auth/social', { provider, idToken, deviceId, deviceName });
export const pushLocations = (points: GeoPoint[]) => post<{ accepted: number; duplicates: number }>('/api/locations', { points });
export const sendReport = (report: ReportInput) => post<{ report: { id: string } }>('/api/reports', report);
export const sendDailyReport = (report: DailyReportInput) => post<{ report: { id: string } }>('/api/daily-reports', report);
export const myReports = () => get<{ reports: ReportInput[] }>('/api/reports');
export const myDailyReports = () => get<{ reports: unknown[] }>('/api/daily-reports');
export const presence = () => post<{ ok: true }>('/api/presence', {});

export const mySummary = (date?: string) => get<RepSummary>(`/api/me/summary${date ? `?date=${date}` : ''}`);
export const myVisits = (date?: string) => get<{ visits: Visit[] }>(`/api/visits${date ? `?date=${date}` : ''}`);
export const myRoute = (userId: string, date?: string) => get<RouteResponse>(`/api/reps/${userId}/route${date ? `?date=${date}` : ''}`);
export const checkInVisit = (visit: VisitInput) => post<{ visit: Visit; duplicate: boolean }>('/api/visits/check-in', visit);
export const checkOutVisit = (id: string, body: { outcome: string; notes: string; amount: number | null; location: { lat: number; lng: number; accuracy: number | null } | null }) =>
  post<{ visit: Visit; duplicate: boolean }>(`/api/visits/${id}/check-out`, body);
