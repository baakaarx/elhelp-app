import { api, apiBlob, post, setToken, getToken } from './api';
import type { User } from './types';

/** `code` is the six-digit second factor, sent only on the second attempt. */
export async function login(email: string, password: string, code?: string) {
  const res = await post<{ token: string; expiresAt: number; user: User }>('/api/auth/login',
    code ? { email, password, code } : { email, password });
  setToken(res.token);
  return res.user;
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
  const blob = await apiBlob(`/api/daily-reports/${id}/pdf`, {}, 'تعذر تنزيل التقرير. حاول مرة أخرى.');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
export async function downloadKpisExcel(from: string, to: string) {
  const query = new URLSearchParams({ from, to });
  const blob = await apiBlob(`/api/kpis.xlsx?${query}`, {}, 'تعذر تصدير المؤشرات. حاول مرة أخرى.');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `elhelb-kpis-${from}_${to}.xlsx`;
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
/**
 * Which dashboard an account gets, and the only reason the tabs are filtered at all is that a
 * warehouse clerk should not see a field map. The server refuses the same requests independently —
 * see `scopeGate` in the API — so this is about not showing a screen that can only fail.
 *
 * Anything unknown is treated as the manager, so a stale or half-written scope never produces a
 * dashboard with nothing in it.
 */
export type DashScope = 'manager' | 'sales' | 'stock';
export const dashScope = (user: User | null | undefined): DashScope =>
  user?.scope === 'stock' ? 'stock' : user?.scope === 'sales' ? 'sales' : 'manager';
export const isManager = (user: User | null | undefined) => user?.role === 'admin';
