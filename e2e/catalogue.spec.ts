import { test, expect, type Page, type Locator } from '@playwright/test';
import { signInAsManager } from './helpers';

/**
 * The price list, driven the way the office drives it.
 *
 * Four things are checked here and nowhere else, because they are the ones a unit test cannot see: that a
 * price lands in the column it was typed under and leaves the other columns alone; that a price is
 * understood as the price of one pack (the header says so, and the number that appears is the number that
 * was typed); that the list refuses to hold the same item twice under one pack instead of creating a
 * second row with a second truth; and that the customer book carries the buyer type the office chose —
 * which is a decision made here, never suggested by a region and never shown on a phone.
 *
 * The seed in `global-setup.ts` types «يوريا ٤٦٪ — شيكارة» at ١١٥٠ for جملة only, so «نصف جملة» and
 * «تجزئة» are visible in their unfinished state. Column order is the tiers' own `position`, so the cells
 * below are addressed by index: 3 = جملة, 4 = نصف جملة, 5 = تجزئة, 6 = the actions.
 */
const unique = `صنف اختبار ${Date.now().toString().slice(-6)}`;
const productRow = (page: Page, name: string): Locator =>
  page.locator('.products-table tbody tr').filter({ hasText: name });
/**
 * An exact match on the heading's own text: «جملة» is a substring of «نصف جملة», so a loose filter here
 * would resolve to two rows and every assertion below would be about whichever one Playwright picked.
 */
const tierRow = (page: Page, name: string): Locator =>
  page.locator('.tiers-table tbody tr').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });

/**
 * A price cell prints Arabic digits with a thousands separator («١٬١٥٠»). The claim under test is that
 * the number on screen is the number that was typed, so the separator is normalised away rather than
 * guessed at: hardcoding «١١٥٠» would make this suite fail on the ICU build, not on the product.
 */
const cellNumber = async (cell: Locator) =>
  (await cell.innerText()).replace(/[٬,\s\u066c\u02bc]/g, '').replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
/** Retries while the cell repaints after a save, which is what `toContainText` would have done. */
const expectNumber = (cell: Locator, value: string) => expect.poll(() => cellNumber(cell)).toBe(value);

async function openCatalogue(page: Page) {
  await signInAsManager(page);
  await page.locator('button.nav-item').filter({ hasText: 'الأصناف' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'قائمة الأصناف والأسعار' })).toBeVisible();
}

test.describe('قائمة الأصناف والأسعار', () => {
  test('an item shows its pack, and the price is the price of that pack', async ({ page }) => {
    await openCatalogue(page);
    const row = productRow(page, 'يوريا ٤٦٪');
    await expect(row).toContainText('شيكارة · ٥٠ كجم');
    // The exact number that was typed: a price that quietly rounds is a price that cannot be trusted
    // against an invoice.
    await expectNumber(row.locator('td').nth(3), '1150');
    // A type with no number is unfinished, not free — so the cell says so instead of showing ٠.
    await expect(row.locator('td').nth(4)).toContainText('بلا سعر');
    await expect(row.locator('td').nth(5)).toContainText('بلا سعر');
    // The header of every price column says what the number is the price of.
    await expect(page.locator('.products-table thead th').nth(3)).toContainText('سعر الوحدة');
    await expect(page.getByText('مش الكرتونة ولا الطرد')).toBeVisible();
    // And the buyer types are listed below with the counts the office works from: one item priced under
    // جملة, and one customer quoted at it.
    await expectNumber(tierRow(page, 'جملة').locator('td').nth(2), '1');
    await expectNumber(tierRow(page, 'جملة').locator('td').nth(3), '1');
  });

  test('one cell is written without touching the rest of the row', async ({ page }) => {
    await openCatalogue(page);
    const row = productRow(page, 'يوريا ٤٦٪');
    await row.locator('td').nth(4).getByRole('button').click();
    await row.getByLabel('سعر يوريا ٤٦٪ — نصف جملة').fill('1220');
    await row.getByRole('button', { name: 'حفظ' }).click();
    await expectNumber(row.locator('td').nth(4), '1220');

    // Reading the row back from the server, not from the screen: the column that was not edited has to
    // still hold its number, which is the whole reason prices are written one cell at a time.
    const tiers = await page.request.get('/api/price-tiers');
    expect(tiers.ok()).toBeTruthy();
    const { tiers: kinds } = await tiers.json() as { tiers: Array<{ id: string; name: string }> };
    const listed = await page.request.get('/api/products?q=يوريا');
    const { products } = await listed.json() as { products: Array<{ name: string; prices?: Array<{ tierId: string; price: number }> }> };
    const urea = products.find(item => item.name === 'يوريا ٤٦٪')!;
    const priceFor = (name: string) => urea.prices?.find(entry => entry.tierId === kinds.find(tier => tier.name === name)!.id)?.price;
    expect(priceFor('جملة')).toBe(1150);
    expect(priceFor('نصف جملة')).toBe(1220);
    // Types the office did not mention stay missing rather than becoming zero.
    expect(priceFor('تجزئة')).toBeUndefined();
  });

  test('the pack is required, and the same item twice under one pack is refused', async ({ page }) => {
    await openCatalogue(page);
    await page.getByRole('button', { name: 'صنف جديد' }).click();
    const form = page.locator('form.panel');
    await form.getByLabel('اسم الصنف').fill(unique);
    // The field the office used to skip is marked required in the form itself — the screen does not let
    // the question be deferred to the server.
    await expect(form.getByLabel('العبوة اللي بيتبيعها')).toHaveJSProperty('required', true);
    await form.getByRole('button', { name: 'حفظ' }).click();
    await expect(productRow(page, unique)).toHaveCount(0);

    await form.getByLabel('العبوة اللي بيتبيعها').fill('شيكارة');
    await form.getByRole('button', { name: 'حفظ' }).click();
    await expect(productRow(page, unique)).toBeVisible();

    // Same name, same pack: one row, and the answer says which row to edit.
    await page.getByRole('button', { name: 'صنف جديد' }).click();
    const again = page.locator('form.panel');
    await again.getByLabel('اسم الصنف').fill(` ${unique} `);
    await again.getByLabel('العبوة اللي بيتبيعها').fill(' شيكارة ');
    await again.getByRole('button', { name: 'حفظ' }).click();
    await expect(again.getByRole('alert')).toContainText('قائمة الأصناف');
    await expect(productRow(page, unique)).toHaveCount(1);
    // …while the same poison in another pack is a different item and is allowed.
    await again.getByLabel('العبوة اللي بيتبيعها').fill('جركن');
    await again.getByRole('button', { name: 'حفظ' }).click();
    // A different pack is a different item, so the name now appears twice on purpose — once per pack.
    await expect(productRow(page, unique)).toHaveCount(2);
    await expect(productRow(page, unique).filter({ hasText: 'جركن' })).toContainText('جركن');
    await expect(productRow(page, unique).filter({ hasText: 'شيكارة' }).locator('td').nth(1)).toContainText('شيكارة');
  });

  test('a type the office still owes prices on is stopped, not deleted', async ({ page }) => {
    await openCatalogue(page);
    await tierRow(page, 'جملة').getByRole('button', { name: 'حذف' }).click();
    await tierRow(page, 'جملة').getByRole('button', { name: 'امسحه نهائيًا' }).click();
    // The refusal is the server's sentence, shown as written: how many items hang off this heading, and
    // what to press instead.
    await expect(page.locator('.panel').filter({ hasText: 'أنواع المشترين' }).locator('.error')).toContainText('وقّف النوع');
    await expect(tierRow(page, 'جملة')).toBeVisible();
    // And the price itself is still there — stopping a heading is not deleting the numbers under it.
    await expectNumber(productRow(page, 'يوريا ٤٦٪').locator('td').nth(3), '1150');
  });

  test('the buyer type is chosen in the customer book, and reads back there', async ({ page }) => {
    await signInAsManager(page);
    await page.locator('button.nav-item').filter({ hasText: 'العملاء' }).click();
    const row = page.locator('.customers-table tbody tr').filter({ hasText: 'مزرعة النور' });
    // The seed set it, so the book has to read it back.
    await expect(row).toContainText('جملة');
    // The other seeded customer was never given one: «باليد» is a state of the book, not an error.
    await expect(page.locator('.customers-table tbody tr').filter({ hasText: 'مزرعة الدلتا' })).toContainText('باليد');

    await row.getByRole('button', { name: 'تعديل' }).click();
    const form = page.locator('form.panel');
    await form.getByLabel('نوع السعر').selectOption({ label: 'تجزئة' });
    await form.getByRole('button', { name: 'حفظ' }).click();
    await expect(row).toContainText('تجزئة');
    await expect(row).not.toContainText('جملة');
    // The unit column of the row is untouched by an edit that only moved the buyer type.
    await expect(row).toContainText('01000000000');
  });
});
