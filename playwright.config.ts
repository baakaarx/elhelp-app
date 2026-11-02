import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined },
  },
  // A separate, disposable in-memory server: never consume the live preview's login quota or persist test accounts.
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5174/api/health',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      NODE_ENV: 'development', DEMO_MODE: 'true', DB_PATH: ':memory:', PORT: '3100',
      MANDOOB_WEB_PORT: '5174', MANDOOB_API_TARGET: 'http://127.0.0.1:3100',
    },
  },
});
