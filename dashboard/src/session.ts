import { api, post, setToken, getToken } from './api';
import type { User } from './types';

/** The Expo web build is served by the same API under /app. */
export const ENGINEER_APP_PATH = '/app';

/**
 * Surface the reason the server actually gave instead of a blanket "try again" message.
 * A 404 on a hosted demo almost always means the request landed on another serverless
 * instance, and the status code is the only clue the operator can act on.
 */
async function failureText(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.clone().json() as { error?: unknown };
    const message = typeof body?.error === 'string' ? body.error.trim() : '';
    if (message) return message;
  } catch { /* proxies can answer with HTML; fall back to the status code below */ }
  return `${fallback} (${res.status})`;
}

export async function login(email: string, password: string) {
  const res = await post<{ token: string; expiresAt: number; user: User }>('/api/auth/login', { email, password });
  setToken(res.token);
  return res.user;
}
export async function loginWithSocial(provider: 'google' | 'apple', idToken: string, deviceId?: string, deviceName?: string) {
  const res = await post<{ token: string; expiresAt: number; user: User } & { error?: string; code?: string }>('/api/auth/social', { provider, idToken, deviceId, deviceName });
  // server returns 202 pending with error message but no token — caller handles it as exception
  if ((res as any).token) setToken((res as any).token);
  return (res as any).user as User;
}
export async function me(): Promise<User | null> {
  if (!getToken()) return null;
  try { return (await api<{ user: User }>('/api/auth/me')).user; }
  catch { return null; }
}
export async function logout() {
  try { await post('/api/auth/logout', {}); } finally { setToken(null); }
}
export async function downloadDailyReportPdf(id: string, fileName: string) {
  const token = getToken();
  const res = await fetch(`/api/daily-reports/${id}/pdf`, {
    headers: token ? { 'X-Mandoub-Token': token, 'X-Mandoub-Client': 'admin' } : { 'X-Mandoub-Client': 'admin' },
    credentials: 'include',
  });
  if (!res.ok) throw new Error(await failureText(res, 'تعذر تنزيل التقرير. حاول مرة أخرى.'));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
export const downloadKpisCsv = (from: string, to: string) => downloadKpis('csv', from, to);
export const downloadKpisExcel = (from: string, to: string) => downloadKpis('xlsx', from, to);
async function downloadKpis(format: 'xlsx' | 'csv', from: string, to: string) {
  const token = getToken();
  const res = await fetch(`/api/kpis.${format}?from=${from}&to=${to}`, {
    headers: token ? { 'X-Mandoub-Token': token, 'X-Mandoub-Client': 'admin' } : { 'X-Mandoub-Client': 'admin' },
    credentials: 'include',
  });
  if (!res.ok) throw new Error(await failureText(res, 'تعذر تصدير المؤشرات. حاول مرة أخرى.'));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `elhelb-kpis-${from}_${to}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
export const durationText = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'أقل من دقيقة';
  if (minutes < 60) return `${formatNumber(minutes)} دقيقة`;
  return `${formatNumber(Math.floor(minutes / 60))} س ${formatNumber(minutes % 60)} د`;
};
export const formatNumber = (value: number) => new Intl.NumberFormat('ar-EG').format(Math.round(value));
export function ago(ts: number | null, now = Date.now()) {
  if (!ts) return 'لم يظهر بعد';
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 45) return 'الآن';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `منذ ${formatNumber(minutes)} دقيقة`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `منذ ${formatNumber(hours)} ساعة`;
  return `منذ ${formatNumber(Math.round(hours / 24))} يوم`;
}

/** Representatives belong in the mobile app; the manager dashboard must never impersonate them. */
export const isManager = (user: User | null | undefined) => user?.role === 'admin';
