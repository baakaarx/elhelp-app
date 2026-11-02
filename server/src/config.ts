import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = resolve(fileURLToPath(new URL('..', import.meta.url)), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

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
  return {
    port: Number(process.env.PORT || 3000),
    demo,
    production,
    dbPath: process.env.DB_PATH || fileURLToPath(new URL('../data/mandoub.db', import.meta.url)),
    retentionDays,
    timezone,
    adminEmail: (process.env.ADMIN_EMAIL || (demo ? 'admin@mandoub.test' : 'admin@example.com')).toLowerCase(),
    adminPassword: process.env.ADMIN_PASSWORD || (demo ? 'Demo1234!' : ''),
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean),
  };
}
