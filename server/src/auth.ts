import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
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
  return { id: row.id, name: row.name, email: row.email, role: row.role, phone: row.phone, region: row.region, color: row.color, isDemo: !!row.is_demo, active: !!row.active, approvalStatus: String(row.approval_status || 'approved'), deviceId: String(row.device_id || ''), oauthProvider: String(row.oauth_provider || '') };
}
/**
 * Stateless sessions.
 *
 * The product normally runs as one process with one SQLite file, so a session is a row.
 * Hosted demos on serverless platforms have no shared disk: every instance gets its own
 * empty database, and a session created on one instance is unknown to the next one — the
 * user is logged out mid-session. When `SESSION_SECRET` is set (hosted demo only) the
 * session token carries its own HMAC-signed claims, so any instance can verify it and
 * resolve the account by email. Production keeps the database-backed tokens.
 */
// Read lazily: tests start separate app instances with their own environment values.
const secret = () => process.env.SESSION_SECRET || '';
export const statelessSessions = () => secret().length >= 16;
const signClaims = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');
const signatureValid = (payload: string, signature: string) => {
  const expected = signClaims(payload);
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
};
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
const unb64 = (value: string) => Buffer.from(value, 'base64url').toString('utf8');
function statelessToken(email: string, role: string, name: string, expiresAt: number) {
  const payload = `${role}|${expiresAt}|${b64(name)}|${email}`;
  return `s2.${b64(payload)}.${signClaims(payload)}`;
}
function statelessClaims(token: string): { email: string; role: string; name: string } | null {
  const [version, body, signature] = token.split('.');
  if (!body || !signature) return null;
  const payload = unb64(body);
  if (!signatureValid(payload, signature)) return null;
  if (version === 's1') {
    // Tokens issued before the display name became part of the signature stay valid.
    const [role, expiresAtRaw, ...rest] = payload.split('|');
    const email = rest.join('|');
    const expiresAt = Number(expiresAtRaw);
    if (!email || !role || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return { email, role, name: email.split('@')[0] };
  }
  if (version !== 's2') return null;
  const [role, expiresAtRaw, nameRaw, email] = payload.split('|');
  const expiresAt = Number(expiresAtRaw);
  if (!email || !role || !nameRaw || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return { email, role, name: unb64(nameRaw) };
}
/**
 * Mirror an account onto an instance that has never seen it.
 *
 * The hosted demo keeps one SQLite file per serverless instance. A representative created
 * from the dashboard exists only on the instance that handled the creation, so every later
 * request that lands elsewhere answered 401 and the app dropped back to the login screen
 * (and the shift vanished with it). A signed session carries the account's email, role and
 * name, so any instance can recreate a stable stand-in row with an id derived from the email.
 * The stand-in only ever exists when stateless sessions are enabled (hosted demo).
 */
function mirrorUser(store: Store, claims: { email: string; role: string; name: string }): Row | undefined {
  const hex = createHash('sha1').update(`mandoub-mirror:${claims.email}`).digest('hex');
  // Same rule as the demo rows: deterministic, but a valid RFC 4122 UUID so API validation
  // and every "rep id" field accept it.
  const uuid = `${hex.slice(0, 12)}4${hex.slice(13, 16)}8${hex.slice(17, 32)}`;
  const id = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20, 32)}`;
  const role = claims.role === 'admin' ? 'admin' : 'rep';
  const name = (claims.name || claims.email.split('@')[0]).slice(0, 80) || claims.email;
  store.run(`INSERT OR IGNORE INTO users(id,name,email,password_hash,role,color,is_demo,active,approval_status,created_at)
    VALUES (?,?,?,'',?,?,0,1,'approved',?)`, id, name, claims.email, role, role === 'admin' ? '#28745b' : '#27745a', Date.now());
  return store.get('SELECT * FROM users WHERE email=? AND active=1', claims.email);
}
export function sessionUser(store: Store, token: unknown): Row | undefined {
  if (typeof token !== 'string' || token.length < 20 || token.length > 300) return undefined;
  const row = store.get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`, tokenHash(token), Date.now());
  if (row || !statelessSessions()) return row;
  const claims = statelessClaims(token);
  if (!claims) return undefined;
  const found = store.get('SELECT * FROM users WHERE email=? AND active=1', claims.email);
  return found ?? mirrorUser(store, claims);
}
/**
 * The shift also has to survive an instance switch, otherwise the app looks like it ended
 * the shift every 15 seconds (the poll hits a fresh instance with an empty database) and the
 * engineer cannot check in a visit. The token below is signed by the server and carries the
 * shift id, its start time and the owning account's email, so any instance can rebuild the
 * same shift row on demand instead of inventing a new one.
 */
const SHIFT_TTL_MS = 20 * 3600000;
export function statelessShiftToken(email: string, shiftId: string, startedAt: number): string | null {
  if (!statelessSessions()) return null;
  const payload = `${email}|${shiftId}|${startedAt}`;
  return `sh1.${b64(payload)}.${signClaims(payload)}`;
}
export function statelessShiftClaims(token: unknown): { email: string; shiftId: string; startedAt: number } | null {
  if (!statelessSessions() || typeof token !== 'string') return null;
  const [version, body, signature] = token.split('.');
  if (version !== 'sh1' || !body || !signature) return null;
  const payload = unb64(body);
  if (!signatureValid(payload, signature)) return null;
  const [email, shiftId, startedAtRaw] = payload.split('|');
  const startedAt = Number(startedAtRaw);
  if (!email || !shiftId || !Number.isFinite(startedAt)) return null;
  if (startedAt > Date.now() + 60000 || Date.now() - startedAt > SHIFT_TTL_MS) return null;
  return { email, shiftId, startedAt };
}
export function createSession(store: Store, userId: string) {
  const now = Date.now();
  const expiresAt = now + SESSION_MS;
  if (statelessSessions()) {
    const user = store.get('SELECT email, role, name FROM users WHERE id=?', userId);
    if (user) {
      const token = statelessToken(String(user.email), String(user.role), String(user.name || ''), expiresAt);
      // Keep the audit row locally; other instances rely on the signature instead.
      store.run('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)', tokenHash(token), userId, expiresAt, now);
      return { token, expiresAt };
    }
  }
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
function cookieSameSite(req: Request): 'none' | 'lax' { return cookieSecure(req) ? 'none' : 'lax'; }
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
    next();
  };
}
