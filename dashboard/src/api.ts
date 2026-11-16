const TOKEN_KEY = 'mandoub.token';
export class ApiError extends Error {
  status: number;
  /** The server's machine-readable reason (`TOTP_REQUIRED`, `TOTP_INVALID`, `LAST_ADMIN`, …). */
  code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; if (code) this.code = code; }
}
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token: string | null) => {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
};
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (token) headers.set('X-Mandoub-Token', token);
  headers.set('X-Mandoub-Client', 'admin');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...init, headers, credentials: 'include', cache: 'no-store' });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  if (!res.ok) {
    const body = isJson ? await res.json().catch(() => null) : null;
    if (res.status === 401) setToken(null);
    throw new ApiError(body?.error || `فشل الطلب (${res.status})`, res.status, typeof body?.code === 'string' ? body.code : undefined);
  }
  return (isJson ? res.json() : res.text()) as Promise<T>;
}
export const post = <T>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
