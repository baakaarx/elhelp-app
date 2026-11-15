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
}

export function readConfig(): Config {
  const production = process.env.NODE_ENV === 'production';
  if (production && !process.env.ADMIN_EMAIL) throw new Error('Set ADMIN_EMAIL before production startup.');
  if (production && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < MIN_ADMIN_PASSWORD_LENGTH)) {
    throw new Error(`Set a unique ADMIN_PASSWORD of at least ${MIN_ADMIN_PASSWORD_LENGTH} characters before production startup.`);
  }
  const timezone = process.env.TIMEZONE || 'Africa/Cairo';
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  const retentionDays = Number(process.env.RETENTION_DAYS || 30);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error('RETENTION_DAYS must be an integer from 1 to 365.');
  }
  const staleGpsMinutes = Number(process.env.STALE_GPS_MINUTES || DEFAULT_STALE_GPS_MINUTES);
  if (!Number.isInteger(staleGpsMinutes) || staleGpsMinutes < 3 || staleGpsMinutes > 120) {
    throw new Error('STALE_GPS_MINUTES must be an integer from 3 to 120.');
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
  };
}
