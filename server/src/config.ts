import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = resolve(fileURLToPath(new URL('..', import.meta.url)), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * The value shipped in `.env.example`. Starting the server with it means the first
 * administrator was created under a placeholder address that nobody owns, so the warning
 * below spells out what to do instead of failing silently.
 */
export const EXAMPLE_ADMIN_EMAIL = 'admin@your-company.com';
/** Minimum length of an administrator password; enforced at every start, not only in production. */
export const MIN_ADMIN_PASSWORD_LENGTH = 12;
/**
 * One threshold for "we lost the engineer's signal", shared by the manager alerts and the
 * dashboard status text. Three minutes was too trigger-happy (a phone indoors misses a
 * beat), thirty minutes hid a real gap; ten minutes is the compromise.
 */
export const DEFAULT_STALE_GPS_MINUTES = 10;
/**
 * Minutes of stillness before the engineer is asked for a reason and the manager sees the alert.
 *
 * The same number lived in two places (the phone's banner and the server's alert) with a literal
 * 60 in both, so changing it meant shipping a new APK. It is one setting now, sent to the app
 * with the summary.
 */
export const DEFAULT_IDLE_REASON_MINUTES = 60;

/**
 * `TRUST_PROXY` accepts what Express accepts (`loopback`, `1`, `10.0.0.0/8`, `true`, `false`).
 * The default trusts only a loopback proxy, which is exactly Caddy on the same machine, and
 * cannot be abused by a remote client that forges `X-Forwarded-For`.
 */
export function readTrustProxy(raw: string | undefined, production: boolean): string | number | boolean {
  const value = (raw ?? '').trim();
  if (!value) return production ? 'loopback' : false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export interface Config {
  port: number;
  production: boolean;
  dbPath: string;
  retentionDays: number;
  timezone: string;
  adminEmail: string;
  adminPassword: string;
  allowedOrigins: string[];
  /** Minutes without a GPS point before the field is flagged as losing signal. */
  staleGpsMinutes: number;
  /** Minutes of stillness before a reason is required (and the manager is alerted). */
  idleReasonMinutes: number;
  /** Public contact address printed on the privacy policy page the stores link to. */
  privacyContact: string;
  /**
   * Which proxy hops may set `X-Forwarded-For`. Behind Caddy the socket peer is always
   * 127.0.0.1, so without this every request shares one rate-limit bucket: fifteen failed
   * logins anywhere would lock the whole team out for fifteen minutes.
   */
  trustProxy: string | number | boolean;
  /**
   * Client ids whose Google ID tokens this server accepts. One installation usually has three
   * (iOS, Android, web), and each of them shows up as `aud` in the token it produces.
   * Empty means "Google sign-in is off" and the app hides the button.
   */
  oauthGoogleClientIds?: string[];
  /** Same for Apple: the app bundle id for native, the Services ID for the web flow. */
  oauthAppleClientIds?: string[];
  /** Failed sign-ins tolerated for one address before that account is frozen for the window. */
  loginAccountLimit: number;
  /** Sign-in attempts allowed per client address inside one window. */
  loginRateLimit: { windowMs: number; limit: number };
  /** General API budget: per session token when signed in, per address otherwise. */
  apiRateLimit: { windowMs: number; limit: number };
  /**
   * Base32 secret of the manager's authenticator app. Empty means two-factor is off — the default,
   * because a manager locked out of his own installation on the day he enabled it would be a worse
   * failure than the one this protects against. `npm run totp` prints a secret and its QR link.
   */
  adminTotpSecret: string;
}

/** Comma-separated env value → trimmed list, keeping only plausible OAuth client ids. */
function splitList(raw: string | undefined): string[] {
  return String(raw ?? '').split(',').map(value => value.trim()).filter(value => /^[\w.\-:/]{5,200}$/.test(value));
}

export function readConfig(): Config {
  const production = process.env.NODE_ENV === 'production';
  if (production && !process.env.ADMIN_EMAIL) throw new Error('Set ADMIN_EMAIL before production startup.');
  if (production && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < MIN_ADMIN_PASSWORD_LENGTH)) {
    throw new Error(`Set a unique ADMIN_PASSWORD of at least ${MIN_ADMIN_PASSWORD_LENGTH} characters before production startup.`);
  }
  const timezone = process.env.TIMEZONE || 'Africa/Cairo';
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  // A month was too short for the product's own monthly register: the previous month was
  // already gone when the manager went to export it, and the collections it holds are the
  // company's record. A year covers every report the register can ask for; raise it further
  // (up to ten years) when the archive has to be read further back.
  const retentionDays = Number(process.env.RETENTION_DAYS || 365);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error('RETENTION_DAYS must be an integer from 1 to 3650 (days).');
  }
  const staleGpsMinutes = Number(process.env.STALE_GPS_MINUTES || DEFAULT_STALE_GPS_MINUTES);
  if (!Number.isInteger(staleGpsMinutes) || staleGpsMinutes < 3 || staleGpsMinutes > 120) {
    throw new Error('STALE_GPS_MINUTES must be an integer from 3 to 120.');
  }
  const idleReasonMinutes = Number(process.env.IDLE_REASON_MINUTES || DEFAULT_IDLE_REASON_MINUTES);
  if (!Number.isInteger(idleReasonMinutes) || idleReasonMinutes < 15 || idleReasonMinutes > 240) {
    throw new Error('IDLE_REASON_MINUTES must be an integer from 15 to 240 (minutes).');
  }
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (adminEmail === EXAMPLE_ADMIN_EMAIL) {
    // The first administrator is created from this value, so the template address means
    // nobody can sign in with the account they think they created.
    console.warn(
      `[config] ADMIN_EMAIL is still the template value (${EXAMPLE_ADMIN_EMAIL}). ` +
      `Replace it with the manager's real address before the first start.`,
    );
  }
  return {
    port: Number(process.env.PORT || 3000),
    production,
    dbPath: process.env.DB_PATH || fileURLToPath(new URL('../data/mandoub.db', import.meta.url)),
    retentionDays,
    timezone,
    adminEmail,
    adminPassword: process.env.ADMIN_PASSWORD || '',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean),
    staleGpsMinutes,
    idleReasonMinutes,
    // A privacy contact is required by both stores. It defaults to privacy@<domain of the
    // manager address> so an installation never publishes the manager's own login address.
    privacyContact: (process.env.PRIVACY_CONTACT || '').trim() || `privacy@${adminEmail.split('@')[1] || 'example.com'}`,
    trustProxy: readTrustProxy(process.env.TRUST_PROXY, production),
    oauthGoogleClientIds: splitList(process.env.GOOGLE_CLIENT_IDS),
    oauthAppleClientIds: splitList(process.env.APPLE_CLIENT_IDS),
    loginAccountLimit: 10,
    adminTotpSecret: String(process.env.ADMIN_TOTP_SECRET || '').trim(),
    loginRateLimit: { windowMs: 60000, limit: 15 },
    apiRateLimit: { windowMs: 60000, limit: 600 },
  };
}
