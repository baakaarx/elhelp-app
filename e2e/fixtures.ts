/**
 * Test-only fixtures.
 *
 * The product ships with no sample engineers, so the browser suite creates its own accounts
 * and activity through the public API in `global-setup.ts`. Nothing here is imported by the
 * server or the dashboard.
 */
export const E2E_ADMIN = { email: 'manager@elhelp.test', password: 'Manager1234!' };
export const E2E_REP_PASSWORD = 'RepPassword123!';
export const E2E_REPS = [
  { name: 'أحمد حسن', email: 'ahmed.rep@elhelp.test', region: 'الإسكندرية' },
  { name: 'سارة منصور', email: 'sara.rep@elhelp.test', region: 'البحيرة' },
  { name: 'مصطفى كامل', email: 'mostafa.rep@elhelp.test', region: 'الدقهلية' },
];
export const E2E_DB_PATH = process.env.E2E_DB_PATH || 'server/data/e2e.db';
export const E2E_API = 'http://127.0.0.1:3100';
