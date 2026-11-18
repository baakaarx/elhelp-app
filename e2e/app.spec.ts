import { test, expect } from '@playwright/test';
import { E2E_REPS } from './fixtures';
import { signInAsManager } from './helpers';

test.describe('المتابعة الحية والفريق', () => {
  test('the overview lists the real team created for the browser suite', async ({ page }) => {
    await signInAsManager(page);
    await expect(page.getByText('مهندسون بإشارة حديثة')).toBeVisible();
    await expect(page.getByText('إجمالي مسافة اليوم')).toBeVisible();
    // E2E setup leaves one engineer with a fresh point and two with stale points; all three
    // shifts are open, so the first card must not count yesterday's/old signals as current.
    const freshSignal = page.locator('.stat').filter({ hasText: 'مهندسون بإشارة حديثة' });
    await expect(freshSignal.locator('strong')).toHaveText('١');
    const openShifts = page.locator('.stat').filter({ hasText: 'ورديات مفتوحة' });
    await expect(openShifts.locator('strong')).toHaveText('٣');
    const rows = page.locator('.rep-list .rep');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(E2E_REPS.length);
  });

  test('selecting a representative shows their summary and route', async ({ page }) => {
    await signInAsManager(page);
    await page.locator('.rep-list .rep').first().click();
    await expect(page.locator('.selected-summary')).toBeVisible();
    await expect(page.locator('.selected-summary dd').first()).toBeVisible();
    await expect(page.getByText(/نقطة/).first()).toBeVisible();
  });

  test('the map renders without a JavaScript error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await signInAsManager(page);
    await expect(page.locator('.leaflet-container')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('navigation switches between team, reports, and privacy pages', async ({ page }) => {
    await signInAsManager(page);
    await page.getByRole('button', { name: /فريق الميدان/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'فريق الميدان' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'الفريق' })).toBeVisible();
    await page.getByRole('button', { name: /إنجازات وتقارير/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'إنجازات وتقارير' })).toBeVisible();
    await page.getByRole('button', { name: /هويتي/ }).click();
    await expect(page.getByRole('heading', { name: 'الخصوصية والاحتفاظ' })).toBeVisible();
    await expect(page.getByText(/لا يبدأ التتبع إلا بعد موافقة/)).toBeVisible();
  });

  test('a manager creates an engineer account from the team page', async ({ page }) => {
    await signInAsManager(page);
    await page.getByRole('button', { name: /فريق الميدان/ }).click();

    const email = `new-rep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
    await page.getByLabel('اسم المهندس').fill('مهندس حساب جديد');
    await page.getByLabel('البريد الإلكتروني').fill(email);
    await page.getByLabel('كلمة المرور الأولية').fill('NewRepPassword123!');
    await page.getByLabel('الهاتف').fill('01012345678');
    await page.getByLabel('المنطقة').fill('الإسكندرية');
    await page.getByRole('button', { name: 'إنشاء حساب المهندس' }).click();

    await expect(page.getByRole('status')).toContainText(email);
    const listedReps = await page.evaluate(async () => {
      const token = window.localStorage.getItem('mandoub.token');
      const response = await fetch('/api/reps', { headers: token ? { 'X-Mandoub-Token': token } : {} });
      const body = await response.json() as { reps?: { email: string }[] };
      return { status: response.status, emails: (body.reps ?? []).map(rep => rep.email) };
    });
    expect(listedReps.status).toBe(200);
    expect(listedReps.emails).toContain(email);

    const refreshedOverview = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/overview' && response.request().method() === 'GET');
    await page.reload();
    const overviewResponse = await refreshedOverview;
    const overview = await overviewResponse.json() as { reps: { email: string }[] };
    expect(overview.reps.map(rep => rep.email)).toContain(email);
    await expect(page.getByRole('heading', { level: 1, name: 'مركز العمليات' })).toBeVisible();
    await page.getByRole('button', { name: /فريق الميدان/ }).click();
    await expect(page.locator('.rep-list').filter({ hasText: email })).toBeVisible();
  });

  test('the field alerts panel lists exceptions with a jump-to-rep action', async ({ page }) => {
    await signInAsManager(page);
    const panel = page.getByRole('region', { name: 'تنبيهات الميدان' });
    await expect(panel).toBeVisible();
    await expect(panel.locator('.alert').first()).toBeVisible();
    await expect(panel).toContainText(/زيارة مفتوحة|انقطاع/);
    await panel.getByRole('button', { name: 'فتح' }).first().click();
    await expect(page.locator('.selected-summary')).toBeVisible();
  });

  test('expanding alerts and idle justifications shows every item returned by the API', async ({ page }) => {
    await signInAsManager(page);
    const alerts = Array.from({ length: 12 }, (_, index) => ({
      id: `test-alert-${index}`, level: 'info', code: 'no_visits', title: `تنبيه اختبار ${index}`,
      detail: 'تفصيل اختبار', at: Date.now(),
    }));
    const justifications = Array.from({ length: 12 }, (_, index) => ({
      id: `test-idle-${index}`, userId: 'rep-test', repName: `مهندس اختبار ${index}`, shiftId: null,
      lat: null, lng: null, accuracy: null, reason: 'توقف موضح للاختبار', durationMinutes: 60,
      deviceId: 'test-device', createdAt: Date.now() - index,
    }));
    await page.route('**/api/alerts', route => route.fulfill({ json: { alerts, generatedAt: Date.now(), date: '2026-11-02' } }));
    await page.route('**/api/idle-reports?limit=20', route => route.fulfill({ json: { reports: justifications } }));
    await page.getByRole('button', { name: 'تحديث' }).click();

    const alertPanel = page.getByRole('region', { name: 'تنبيهات الميدان' });
    const alertRows = alertPanel.locator('.alert');
    await expect(alertRows).toHaveCount(12);
    await alertPanel.getByRole('button', { name: 'طي' }).click();
    await expect(alertRows).toHaveCount(2);
    await alertPanel.getByRole('button', { name: 'عرض الكل' }).click();
    await expect(alertRows).toHaveCount(12);

    const idlePanel = page.getByRole('region', { name: 'تبريرات الوقوف' });
    const idleRows = idlePanel.locator('.alert');
    await expect(idleRows).toHaveCount(3);
    await idlePanel.getByRole('button', { name: 'عرض الكل' }).click();
    await expect(idleRows).toHaveCount(12);
  });

  test('an expired manager session returns the dashboard to login', async ({ page }) => {
    await signInAsManager(page);
    await page.route('**/api/overview', route => route.fulfill({ status: 401, json: { error: 'انتهت الجلسة' } }));
    await page.getByRole('button', { name: 'تحديث' }).click();
    await expect(page.locator('.login-wrap')).toBeVisible();
  });

  test('an expired session during an Excel export returns the dashboard to login', async ({ page }) => {
    await signInAsManager(page);
    await page.getByRole('button', { name: /مؤشرات التأثير/ }).click();
    await expect(page.locator('.kpi-table')).toBeVisible();
    const exportButton = page.getByRole('button', { name: /تصدير Excel/ });
    await expect(exportButton).toBeEnabled();
    await page.route('**/api/kpis.xlsx*', route => route.fulfill({ status: 401, json: { error: 'انتهت الجلسة' } }));

    await exportButton.click();
    await expect(page.locator('.login-wrap')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('mandoub.token'))).toBeNull();
  });

  test('the route replay scrubs the day of the selected representative', async ({ page }) => {
    await signInAsManager(page);
    await page.locator('.rep-list .rep').first().click();
    await expect(page.locator('.selected-summary')).toBeVisible();
    const replay = page.locator('.replay');
    await expect(replay).toBeVisible();
    await replay.getByRole('button', { name: 'تشغيل المسار' }).click();
    await expect(replay.getByLabel('تقدم المسار')).toBeVisible();
    await replay.getByLabel('تقدم المسار').fill('500');
    await expect(replay.locator('.replay-time')).not.toHaveText('—');
  });

  test('changing the selected route day refits the map to the new route', async ({ page }) => {
    await signInAsManager(page);
    await page.locator('.rep-list .rep').first().click();
    await expect(page.locator('.replay')).toBeVisible();
    const otherRep = page.locator('.pin-rep:not(.is-selected)').first();
    await page.waitForTimeout(500);
    const routeMarker = await otherRep.boundingBox();
    expect(routeMarker).not.toBeNull();

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
    const [year, month, day] = today.split('-').map(Number);
    const yesterday = new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
    await page.getByLabel('يوم المسار').fill(yesterday);
    await expect(page.locator('.replay')).toHaveCount(0);
    await page.waitForTimeout(500);
    const newRouteMarker = await otherRep.boundingBox();
    expect(newRouteMarker).not.toBeNull();
    expect(Math.abs(newRouteMarker!.x - routeMarker!.x) + Math.abs(newRouteMarker!.y - routeMarker!.y)).toBeGreaterThan(1);
  });

  test('the performance page compares the team and exports an Excel workbook', async ({ page }) => {
    await signInAsManager(page);
    await page.getByRole('button', { name: /مؤشرات التأثير/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'مؤشرات التأثير' })).toBeVisible();
    await expect(page.locator('.kpi-table')).toBeVisible();
    await expect(page.locator('.kpi-table tbody tr').first()).toBeVisible();
    // Excel only: the CSV buttons were removed from the interface on request.
    await expect(page.getByRole('button', { name: /CSV/ })).toHaveCount(0);
    const exportButton = page.getByRole('button', { name: /تصدير Excel/ });
    await expect(exportButton).toBeEnabled();
    const download = page.waitForEvent('download');
    await exportButton.click();
    expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
  });

  test('the monthly register downloads an Excel workbook', async ({ page }) => {
    await signInAsManager(page);
    await page.getByRole('button', { name: 'السجل الشهري' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'السجل الشهري' })).toBeVisible();
    await expect(page.locator('.kpi-table')).toBeVisible();
    const exportButton = page.getByRole('button', { name: /تصدير الشهر \(Excel\)/ });
    await expect(exportButton).toBeEnabled();
    const download = page.waitForEvent('download');
    await exportButton.click();
    expect((await download).suggestedFilename()).toMatch(/^elhelb-monthly-\d{4}-\d{2}\.xlsx$/);
  });
});
