import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Store, Row } from './db.js';

export const SESSION_MS = 12 * 3600000;
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function publicUser(row: Row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, phone: row.phone, region: row.region, color: row.color, active: !!row.active, approvalStatus: String(row.approval_status || 'approved'), deviceId: String(row.device_id || ''), oauthProvider: String(row.oauth_provider || '') };
}
/**
 * Sessions are database rows.
 *
 * The product runs as one process on one server with one SQLite file, so a token is looked
 * up in `sessions` and nothing else. Stateless tokens were only ever needed by the removed
 * serverless deployment, where every instance had its own database.
 */
export function sessionUser(store: Store, token: unknown): Row | undefined {
  if (typeof token !== 'string' || token.length < 20 || token.length > 300) return undefined;
  return store.get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`, tokenHash(token), Date.now());
}
/**
 * A session in use never dies mid-shift.
 *
 * The expiry was fixed at twelve hours from the login, so an engineer who signed in at eight in
 * the morning was signed out at eight in the evening — in the middle of his day, on a phone that
 * then stopped reporting his position. A used session now slides forward; the write is skipped
 * unless the row is at least a minute old, so this costs at most one UPDATE per minute per
 * session, not one per request.
 */
export function touchSession(store: Store, token: string): boolean {
  const now = Date.now();
  const result = store.run('UPDATE sessions SET expires_at=? WHERE token_hash=? AND expires_at>? AND expires_at<=?',
    now + SESSION_MS, tokenHash(token), now, now + SESSION_MS - 60000);
  return Number(result.changes) > 0;
}
export function createSession(store: Store, userId: string) {
  const now = Date.now();
  const expiresAt = now + SESSION_MS;
  const token = randomBytes(32).toString('base64url');
  store.run('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)', tokenHash(token), userId, expiresAt, now);
  return { token, expiresAt };
}

export type ClientRole = 'admin' | 'rep';
export const SESSION_COOKIES: Record<ClientRole, string> = { admin: 'mandoub_admin_session', rep: 'mandoub_rep_session' };
const LEGACY_COOKIE = 'mandoub_session';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function cookieSecure(req: Request): boolean {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
/**
 * `Lax` in every environment. The dashboard and the engineer web build are served by the same
 * origin as the API, so a cross-site cookie buys nothing — while `SameSite=None` would let any
 * sibling subdomain drive the session for state-changing requests.
 */
function cookieSameSite(_req: Request): 'lax' { return 'lax'; }
function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}
function clientHint(req: Request): ClientRole | undefined {
  const hint = req.headers['x-mandoub-client'] ?? req.query.client;
  return hint === 'admin' || hint === 'rep' ? hint : undefined;
}
/** Cookie credentials are a fallback only. They must never enable cross-site writes. */
export function cookieRequestAllowed(req: Request): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') {
    if (!['same-origin', 'same-site', 'none'].includes(site)) return false;
    if (UNSAFE_METHODS.has(req.method) && site === 'none') return false;
    return true;
  }
  if (!UNSAFE_METHODS.has(req.method)) return true;
  // Non-browser clients that rely on cookies must still prove same-origin intent.
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      const url = new URL(origin);
      const proto = cookieSecure(req) ? 'https:' : 'http:';
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      return url.protocol === proto && url.host === host;
    } catch { return false; }
  }
  return false;
}
export function cookieToken(req: Request, role?: ClientRole): string | undefined {
  if (!cookieRequestAllowed(req)) return undefined;
  const hint = clientHint(req);
  // A rep page must not borrow the manager cookie on admin routes (and vice versa).
  if (role && hint && hint !== role) return undefined;
  const wanted = role ?? hint;
  if (wanted) return readCookie(req, SESSION_COOKIES[wanted]);
  // /auth/me without a client hint: prefer the manager cookie, then the rep cookie.
  return readCookie(req, SESSION_COOKIES.admin) ?? readCookie(req, SESSION_COOKIES.rep) ?? readCookie(req, LEGACY_COOKIE);
}
/**
 * Credential precedence:
 * 1. X-Mandoub-Token (application-controlled; survives proxies that rewrite Authorization)
 * 2. Authorization: Bearer
 * 3. role-scoped HttpOnly cookie
 * If the app sent an explicit custom token, a rejected token is NOT masked by a cookie.
 */
export function credentialCandidates(req: Request, role?: ClientRole): string[] {
  const custom = req.headers['x-mandoub-token'];
  if (typeof custom === 'string' && custom) return [custom];
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  const cookie = cookieToken(req, role);
  return [...(bearer ? [bearer] : []), ...(cookie ? [cookie] : [])];
}
export function requestToken(req: Request, role?: ClientRole): string | undefined {
  return credentialCandidates(req, role)[0];
}
export function setSessionCookie(req: Request, res: Response, role: ClientRole, token: string, maxAgeMs: number) {
  res.cookie(SESSION_COOKIES[role], token, { httpOnly: true, sameSite: cookieSameSite(req), path: '/', maxAge: maxAgeMs, secure: cookieSecure(req) });
}
export function clearSessionCookies(req: Request, res: Response) {
  const options = { httpOnly: true, sameSite: cookieSameSite(req), path: '/', secure: cookieSecure(req) };
  res.clearCookie(SESSION_COOKIES.admin, options);
  res.clearCookie(SESSION_COOKIES.rep, options);
  res.clearCookie(LEGACY_COOKIE, options);
}
export function requireAuth(store: Store, role?: ClientRole) {
  return (req: Request, res: Response, next: NextFunction) => {
    const candidates = credentialCandidates(req, role);
    let user: Row | undefined;
    let matched: string | undefined;
    for (const token of candidates) {
      user = sessionUser(store, token);
      if (user) { matched = token; break; }
    }
    if (!user || !matched) {
      console.warn('[auth] 401', req.method, req.path, JSON.stringify({
        reason: candidates.length ? 'rejected' : 'missing',
        bearer: !!req.headers.authorization, customHeader: !!req.headers['x-mandoub-token'],
        cookie: !!req.headers.cookie, fetchSite: req.headers['sec-fetch-site'] ?? null,
        ua: String(req.headers['user-agent'] ?? '').slice(0, 80),
      }));
      res.status(401).json({ error: 'انتهت الجلسة أو بيانات الدخول غير صحيحة.' }); return;
    }
    if (role && user.role !== role) { res.status(403).json({ error: 'ليست لديك صلاحية لهذا الإجراء.' }); return; }
    res.locals.user = user;
    res.locals.tokenHash = tokenHash(matched);
    // Slide the session forward, and keep the browser cookie alive with it: the row and the
    // cookie must expire together or the dashboard locks itself out while the row is still good.
    if (touchSession(store, matched) && req.headers.cookie) {
      setSessionCookie(req, res, user.role as ClientRole, matched, SESSION_MS);
    }
    next();
  };
}
