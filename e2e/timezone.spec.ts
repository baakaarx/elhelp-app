import { test, expect } from '@playwright/test';
import { E2E_ADMIN } from './fixtures';
import { submitLogin } from './helpers';

test.use({ timezoneId: 'UTC' });

test('report date defaults follow a late server timezone and preserve manual choices', async ({ page }) => {
  // UTC is still January, but Kiritimati is already February at this instant. Cairo (the
  // dashboard fallback) is also January, making the initial-to-server transition observable.
  await page.clock.setFixedTime(new Date('2026-01-31T12:30:00.000Z'));

  // Keep the REST overview as the only source of timezone changes in this test. The data stream
  // would otherwise publish the same value immediately and hide the late-overview race.
  await page.route('**/socket.io/**', route => route.abort());
  await page.routeWebSocket('**/socket.io/**', socket => socket.close({ code: 1000, reason: 'disabled in date test' }));

  let releaseInitialOverview!: () => void;
  let overviewReleased = false;
  const overviewGate = new Promise<void>(resolve => { releaseInitialOverview = resolve; });
  let nextTimezone = 'Pacific/Kiritimati';
  const overview = {
    reps: [],
    serverTime: Date.parse('2026-01-31T12:30:00.000Z'),
    timezone: 'Africa/Cairo',
    retentionDays: 365,
    newReports: 0,
    staleGpsMinutes: 10,
  };
  await page.route('**/api/overview', async route => {
    if (!overviewReleased) await overviewGate;
    // This test only cares about the timezone lifecycle. A deterministic response avoids
    // depending on a second fetch through the Vite proxy while the first response is gated.
    await route.fulfill({ json: { ...overview, timezone: nextTimezone } });
  });

  await page.goto('/');
  await submitLogin(page, E2E_ADMIN.email, E2E_ADMIN.password);
  await expect(page.getByRole('button', { name: 'خروج' })).toBeVisible();

  // Monthly mounts before /api/overview completes. Its provisional Cairo default must not be
  // queried or left selected once the configured timezone arrives.
  await page.getByRole('button', { name: 'السجل الشهري' }).click();
  const monthSelect = page.getByLabel('الشهر');
  await expect(monthSelect).toBeDisabled();
  await expect(monthSelect).toHaveValue('2026-01');
  overviewReleased = true;
  releaseInitialOverview();
  await expect(monthSelect).toBeEnabled();
  await expect(monthSelect).toHaveValue('2026-02');
  await expect(page.locator('.sidebar-foot')).toContainText('Pacific/Kiritimati');

  // The manager's explicit month survives a later overview timezone update.
  await monthSelect.selectOption('2025-12');
  nextTimezone = 'America/Adak';
  await page.locator('.topbar-actions').getByRole('button', { name: 'تحديث' }).click();
  await expect(page.locator('.sidebar-foot')).toContainText('America/Adak');
  await expect(monthSelect).toHaveValue('2025-12');

  // Performance defaults are derived from the latest timezone, and change if it changes before
  // the manager edits either date.
  await page.getByRole('button', { name: /مؤشرات التأثير/ }).click();
  const fromInput = page.getByLabel('من');
  const toInput = page.getByLabel('إلى');
  await expect(fromInput).toHaveValue('2026-01-25');
  await expect(toInput).toHaveValue('2026-01-31');
  nextTimezone = 'Pacific/Kiritimati';
  await page.locator('.topbar-actions').getByRole('button', { name: 'تحديث' }).click();
  await expect(page.locator('.sidebar-foot')).toContainText('Pacific/Kiritimati');
  await expect(fromInput).toHaveValue('2026-01-26');
  await expect(toInput).toHaveValue('2026-02-01');

  // Once the user sets a range, a timezone update must not replace either field.
  await fromInput.fill('2025-12-01');
  await toInput.fill('2025-12-10');
  nextTimezone = 'America/Adak';
  await page.locator('.topbar-actions').getByRole('button', { name: 'تحديث' }).click();
  await expect(page.locator('.sidebar-foot')).toContainText('America/Adak');
  await expect(fromInput).toHaveValue('2025-12-01');
  await expect(toInput).toHaveValue('2025-12-10');


});
