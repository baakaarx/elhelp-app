const TOKEN_KEY = 'mandoub.token';
export const API_AUTH_REQUIRED_EVENT = 'mandoub:auth-required';

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

async function apiResponse(path: string, init: RequestInit = {}, fallbackMessage = 'فشل الطلب'): Promise<Response> {
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
    const code = typeof body?.code === 'string' ? body.code : undefined;
    const invalidSession = res.status === 401 || code === 'CLIENT_ROLE_MISMATCH';
    if (invalidSession) {
      setToken(null);
      // A bad password/ID token is an ordinary login error, not an expired dashboard session.
      const authEntryPoint = path.startsWith('/api/auth/login') || path.startsWith('/api/auth/oauth');
      if (!authEntryPoint && typeof window !== 'undefined') window.dispatchEvent(new Event(API_AUTH_REQUIRED_EVENT));
    }
    throw new ApiError(body?.error || `${fallbackMessage} (${res.status})`, res.status, code);
  }
  return res;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiResponse(path, init);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  return (isJson ? res.json() : res.text()) as Promise<T>;
}

/** Authenticated file download that shares the same 401/session handling as JSON requests. */
export async function apiBlob(path: string, init: RequestInit = {}, fallbackMessage = 'فشل الطلب'): Promise<Blob> {
  return (await apiResponse(path, init, fallbackMessage)).blob();
}

export const post = <T>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
