import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { E2E_ADMIN, E2E_DB_PATH } from './e2e/fixtures';

// A separate, disposable database: the suite never touches the operator's own data file.
// `scripts/reset-e2e-db.mjs` clears it once per run, before this file is loaded.
const dbPath = resolve(E2E_DB_PATH);
process.env.E2E_DB_PATH = dbPath;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined },
  },
  // A private server on its own ports: the browser suite must not consume the live preview's
  // login quota or write test accounts into real data.
  webServer: {
    // A private test-only API with a larger request budget for the shared test account.
    // The normal development/production servers retain their real rate limits.
    command: 'npx concurrently -k -n API,Dashboard "npx tsx scripts/e2e-server.ts" "npm run dev -w @mandoub/dashboard"',
    url: 'http://127.0.0.1:5174/api/health',
    reuseExistingServer: false,
    timeout: 90000,
    env: {
      NODE_ENV: 'development', DB_PATH: dbPath, PORT: '3100',
      ADMIN_EMAIL: E2E_ADMIN.email, ADMIN_PASSWORD: E2E_ADMIN.password,
      MANDOOB_WEB_PORT: '5174', MANDOOB_API_TARGET: 'http://127.0.0.1:3100',
    },
  },
});
