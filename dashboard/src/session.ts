import { api, post, setToken, getToken } from './api';
import type { User } from './types';

export async function login(email: string, password: string) {
  const res = await post<{ token: string; expiresAt: number; user: User }>('/api/auth/login', { email, password });
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
  const token = getToken();
  const res = await fetch(`/api/daily-reports/${id}/pdf`, {
    headers: token ? { 'X-Mandoub-Token': token, 'X-Mandoub-Client': 'admin' } : { 'X-Mandoub-Client': 'admin' },
    credentials: 'include',
  });
  if (!res.ok) throw new Error('تعذر تنزيل التقرير. حاول مرة أخرى.');
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
