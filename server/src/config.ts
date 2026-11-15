import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = resolve(fileURLToPath(new URL('..', import.meta.url)), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * The value shipped in `.env.example`. Copying that template into `server/.env` on a
 * development machine used to create the administrator under this address, so the
 * credentials printed at boot (`admin@mandoub.test`) were rejected. Keep the name in one
 * place and warn loudly instead of failing silently.
 */
export const EXAMPLE_ADMIN_EMAIL = 'admin@your-company.com';
/**
 * One threshold for "we lost the engineer's signal", shared by the manager alerts and the
 * dashboard status text. Three minutes was too trigger-happy (a phone indoors misses a
 * beat), thirty minutes hid a real gap; ten minutes is the compromise.
 */
export const DEFAULT_STALE_GPS_MINUTES = 10;

export interface Config {
  port: number;
  demo: boolean;
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
  const demo = process.env.DEMO_MODE === 'true';
  if (production && demo) throw new Error('DEMO_MODE must be false in production.');
  if (production && !process.env.ADMIN_EMAIL) throw new Error('Set ADMIN_EMAIL before production startup.');
  if (production && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12)) {
    throw new Error('Set a unique ADMIN_PASSWORD of at least 12 characters before production startup.');
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
  const adminEmail = (process.env.ADMIN_EMAIL || (demo ? 'admin@mandoub.test' : 'admin@example.com')).toLowerCase();
  if (adminEmail === EXAMPLE_ADMIN_EMAIL) {
    // The project starts the administrator from this value on first boot, so pointing at the
    // template address means the documented demo login will not work.
    console.warn(
      `[config] ADMIN_EMAIL is still the example value (${EXAMPLE_ADMIN_EMAIL}). ` +
      `The first administrator is created with this address — not admin@mandoub.test. ` +
      `Edit or delete server/.env before starting again.`,
    );
  }
  return {
    port: Number(process.env.PORT || 3000),
    demo,
    production,
    dbPath: process.env.DB_PATH || fileURLToPath(new URL('../data/mandoub.db', import.meta.url)),
    retentionDays,
    timezone,
    adminEmail,
    adminPassword: process.env.ADMIN_PASSWORD || (demo ? 'Demo1234!' : ''),
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean),
    staleGpsMinutes,
  };
}
