import { test, expect, type Page } from '@playwright/test';
import { signInAsManager } from './helpers';

/**
 * الطلبيات, priced the way the desk works it.
 *
 * The whole workflow in one screen: the field sends quantities (the seed did that through the phone's
 * own routes in `global-setup.ts`), the tab badge lights up, and the office opens the order to find the
 * customer's list price already typed into the box — ختم التسعير is the only press, and after it the
 * row locks with the total it stamped. The lock is what this file exists for: a priced number that a
 * stray edit could move is not a book, then the same test reads the closed sheet and the empty queue.
 */
const ordersTab = (page: Page) => page.locator('button.nav-item').filter({ hasText: 'الزيارات والطلبيات' });

test.describe('طابور الطلبيات', () => {
  test('the sent order waits on the badge, prefills from the list, and closes on one press', async ({ page }) => {
    await signInAsManager(page);
    await expect(ordersTab(page).locator('em.badge')).toHaveText('١');
    await ordersTab(page).click();
    await page.getByRole('tab', { name: /الطلبيات/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'الطلبيات', exact: true })).toBeVisible();

    const row = page.locator('.orders-table tbody tr').filter({ hasText: 'عميل اختبار الطلبية' }).first();
    await expect(row).toContainText('مستنية المكتب');
    await expect(row).toContainText('يوريا ٤٦٪');
    await expect(row).toContainText('أحمد حسن');
    await row.getByRole('button', { name: 'افتح للتسعير' }).click();

    const sheet = page.locator('tr.order-lines-row');
    const price = sheet.getByLabel('سعر يوريا ٤٦٪');
    // The number arrives from the customer's own buyer type — nobody typed it, and the office may
    // still override it; the sheet must show what came from the list before that happens.
    await expect(price).toHaveValue('1150');
    await expect(sheet.getByRole('button', { name: /ختم التسعير/ })).toBeEnabled();

    // An empty box is a line nobody priced: the stamp refuses to fall on a half-sheet.
    await price.fill('');
    await expect(sheet.getByRole('button', { name: /ختم التسعير/ })).toBeDisabled();
    await price.fill('1150');

    await sheet.getByRole('button', { name: /ختم التسعير/ }).click();
    await expect(page.getByText(/مفيش طلبية مستنية المكتب/)).toBeVisible();
    await expect(ordersTab(page).locator('em.badge')).toHaveCount(0);
    await page.getByRole('tab', { name: 'متسعّرة' }).click();
    const closedRow = page.locator('.orders-table tbody tr').filter({ hasText: 'عميل اختبار الطلبية' }).first();
    await expect(closedRow).toContainText('متسعّرة');
    await expect(closedRow).toContainText('٢٬٣٠٠ ج.م');
    await closedRow.getByRole('button', { name: 'عرض السطور' }).click();
    // No inputs on a closed sheet — only what was stamped.
    await expect(page.locator('tr.order-lines-row .price-input')).toHaveCount(0);
    await expect(page.locator('tr.order-lines-row')).toContainText(/١٬١٥٠ ج\.م/);
  });
});
