import { test, expect } from '@playwright/test';
import { signInAsManager } from './helpers';

test.use({ timezoneId: 'UTC' });

test('report date defaults follow a late server timezone and preserve manual choices', async ({ page }) => {
  // UTC is still January, but Kiritimati is already February at this instant. Cairo (the
  // dashboard fallback) is also January, making the initial-to-server transition observable.
  await page.clock.install({ time: new Date('2026-01-31T12:30:00.000Z') });

  // Keep the REST overview as the only source of timezone changes in this test. The data stream
  // would otherwise publish the same value immediately and hide the late-overview race.
  await page.route('**/socket.io/**', route => route.abort());
  await page.routeWebSocket('**/socket.io/**', socket => socket.close({ code: 1000, reason: 'disabled in date test' }));

  let releaseInitialOverview!: () => void;
  let overviewReleased = false;
  const overviewGate = new Promise<void>(resolve => { releaseInitialOverview = resolve; });
  let nextTimezone = 'Pacific/Kiritimati';
  await page.route('**/api/overview', async route => {
    if (!overviewReleased) await overviewGate;
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, timezone: nextTimezone } });
  });

  await signInAsManager(page);

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

  // The agent date follows timezone changes until manually chosen, then remains user-owned.
  await page.getByRole('button', { name: /المساعد الذكي/ }).click();
  await page.getByLabel('المهمة').selectOption('summarize-day');
  const agentDate = page.getByLabel('التاريخ');
  await expect(agentDate).toHaveValue('2026-01-31');
  nextTimezone = 'Pacific/Kiritimati';
  await page.locator('.topbar-actions').getByRole('button', { name: 'تحديث' }).click();
  await expect(page.locator('.sidebar-foot')).toContainText('Pacific/Kiritimati');
  await expect(agentDate).toHaveValue('2026-02-01');

  await agentDate.fill('2025-12-15');
  nextTimezone = 'America/Adak';
  await page.locator('.topbar-actions').getByRole('button', { name: 'تحديث' }).click();
  await expect(page.locator('.sidebar-foot')).toContainText('America/Adak');
  await expect(agentDate).toHaveValue('2025-12-15');
});
