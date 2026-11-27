import { test, expect, request, type Page } from '@playwright/test';
import { E2E_ADMIN, E2E_API } from './fixtures';

// Session tests sign out the global setup token. One fresh session is shared by this file to
// avoid exhausting the real login rate limit with one login per test.
let token: string;
test.beforeAll(async () => {
  const client = await request.newContext({ baseURL: E2E_API });
  const response = await client.post('/api/auth/login', { data: E2E_ADMIN });
  expect(response.ok()).toBeTruthy();
  token = (await response.json()).token;
  await client.dispose();
});
async function signIn(page: Page) {
  await page.addInitScript(value => window.localStorage.setItem('mandoub.token', value), token);
  await page.context().addCookies([{ name: 'mandoub_admin_session', value: token, url: 'http://127.0.0.1:5174' }]);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'خروج' })).toBeVisible();
}

test('رسالة الحقول المطلوبة والبريد غير الصحيح بالعربي', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: /فريق الميدان/ }).click();
  await page.getByRole('button', { name: 'إنشاء حساب المهندس' }).click();
  const name = page.getByLabel('اسم المهندس');
  await expect.poll(() => name.evaluate((input: HTMLInputElement) => input.validationMessage)).toContain('البيانات المطلوبة');
  await name.fill('مهندس تجربة');
  const email = page.getByLabel('البريد الإلكتروني');
  await email.fill('bad-email');
  await page.getByRole('button', { name: 'إنشاء حساب المهندس' }).click();
  await expect.poll(() => email.evaluate((input: HTMLInputElement) => input.validationMessage)).toContain('بريدًا إلكترونيًا صحيحًا');
  await email.fill('good@example.test');
  await expect.poll(() => email.evaluate((input: HTMLInputElement) => input.validationMessage)).toBe('');
});

test('الأزرار والنماذج مناسبة للشاشات الصغيرة والجداول تتحرك داخلها', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  for (const tab of ['العملاء', 'المبيعات', 'المخازن', 'حسابات المكتب', 'فريق الميدان', 'الزيارات والطلبيات']) {
    await page.getByRole('button', { name: tab, exact: tab !== 'الزيارات والطلبيات' }).first().click();
    await expect(page.locator('main')).toBeVisible();
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(dimensions.scroll, `عرض الشاشة في ${tab}`).toBeLessThanOrEqual(dimensions.width + 1);
  }
});

test('تعذر الاتصال ما يكررش حركة مخزون اتحفظت قبل انقطاع الرد', async ({ page }) => {
  await signIn(page);
  const token = await page.evaluate(() => localStorage.getItem('mandoub.token'));
  const headers = { 'X-Mandoub-Token': token!, 'X-Mandoub-Client': 'admin' };
  const wh = await (await page.request.post('/api/warehouse/warehouses', { headers, data: { name: `مخزن شبكة ${Date.now()}` } })).json();
  const product = await (await page.request.post('/api/warehouse/products', { headers, data: { name: `صنف شبكة ${Date.now()}`, category: 'other', unit: 'عبوة' } })).json();
  await page.getByRole('button', {name:'المخازن',exact:true}).click();
  await page.getByRole('combobox', {name:'المخزن',exact:true}).selectOption(wh.warehouse.id);
  await page.getByRole('combobox', {name:'الصنف',exact:true}).selectOption(product.product.id);
  await page.getByLabel('الكمية').fill('   ');
  await page.getByRole('button', {name:'حفظ الحركة'}).click();
  await expect(page.getByRole('alert')).toContainText('اكتب كمية صحيحة');
  await page.getByLabel('الكمية').fill('5');
  const second=await page.context().newPage();
  await second.goto('/');
  await second.getByRole('button', {name:'المخازن',exact:true}).click();
  let dropped = false;
  const ids: string[] = [];
  await page.route('**/api/warehouse/movements', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    ids.push(route.request().postDataJSON().id);
    if (!dropped) { dropped = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByRole('button', {name:'حفظ الحركة'}).click();
  await expect(page.getByRole('alert').filter({hasText:'تعذر الاتصال بالسيرفر'})).toBeVisible();
  await expect(page.getByText('في حركة مخزون لم نتأكد من نتيجتها.')).toBeVisible();
  await expect(second.getByText('في حركة مخزون لم نتأكد من نتيجتها.')).toBeVisible();
  await second.getByRole('combobox',{name:'المخزن',exact:true}).selectOption(wh.warehouse.id);
  await expect(second.getByRole('button', {name:'حفظ الحركة'})).toBeDisabled();
  await page.reload();
  await page.getByRole('button', {name:'المخازن',exact:true}).click();
  await page.getByRole('combobox',{name:'المخزن',exact:true}).selectOption(wh.warehouse.id);
  await expect(page.getByRole('button', {name:'حفظ الحركة'})).toBeDisabled();
  await page.getByRole('button', {name:'التأكد من الحركة المعلقة'}).click();
  await expect(page.locator('.ok-text[role=status]')).toContainText('الحركة اتحفظت');
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  await expect(second.getByText('لازم تعيد تحميل الأرصدة وتتأكد منها قبل تسجيل حركة جديدة.')).toBeVisible();
  await second.close();
  const stock = await (await page.request.get(`/api/warehouse/stock?warehouseId=${wh.warehouse.id}`, {headers})).json();
  expect(stock.stock.find((row: {id: string}) => row.id === product.product.id).qty).toBe(5);
});

test('حفظ حركة نجح لكن تحديث الرصيد فشل يوضح النتيجة الحقيقية', async ({ page }) => {
  await signIn(page);
  const token = await page.evaluate(() => localStorage.getItem('mandoub.token'));
  const headers = { 'X-Mandoub-Token': token!, 'X-Mandoub-Client': 'admin' };
  const wh = await (await page.request.post('/api/warehouse/warehouses', { headers, data: { name: `مخزن تحديث ${Date.now()}` } })).json();
  const product = await (await page.request.post('/api/warehouse/products', { headers, data: { name: `صنف تحديث ${Date.now()}`, category: 'other', unit: 'عبوة' } })).json();
  await page.getByRole('button', {name:'المخازن',exact:true}).click();
  await page.getByRole('combobox', {name:'المخزن',exact:true}).selectOption(wh.warehouse.id);
  await page.getByRole('combobox', {name:'الصنف',exact:true}).selectOption(product.product.id);
  await page.getByLabel('الكمية').fill('7');
  await page.route('**/api/warehouse/stock?*', route => route.abort('failed'));
  await page.getByRole('button', {name:'حفظ الحركة'}).click();
  await expect(page.locator('.ok-text[role=status]')).toContainText('الحركة اتحفظت');
  await expect(page.getByRole('alert')).toContainText('الحركة اتحفظت، لكن الأرصدة ما اتحدّثتش');
  await expect(page.getByLabel('الكمية')).toHaveValue('');
  await page.unroute('**/api/warehouse/stock?*');
  await page.getByRole('button',{name:'إعادة تحميل الأرصدة'}).click();
  await expect(page.getByLabel('الكمية')).toBeEnabled();
  await expect(page.getByText('لازم تعيد تحميل الأرصدة')).toHaveCount(0);
  const stock = await (await page.request.get(`/api/warehouse/stock?warehouseId=${wh.warehouse.id}`, {headers})).json();
  expect(stock.stock.find((row: {id: string}) => row.id === product.product.id).qty).toBe(7);
});

test('أرصدة وحركات المخزن تعرض الكمية والوقت على توقيت النظام لا الجهاز', async ({ browser }) => {
  const context=await browser.newContext({timezoneId:'America/Los_Angeles'});
  const page=await context.newPage();
  await signIn(page);
  const headers={'X-Mandoub-Token':token,'X-Mandoub-Client':'admin'};
  const send=async(path:string,data:object)=>{const r=await page.request.post(path,{headers,data});expect(r.ok(),await r.text()).toBeTruthy();return r.json();};
  const wh=(await send('/api/warehouse/warehouses',{name:`مخزن توقيت ${Date.now()}`})).warehouse;
  const product=(await send('/api/warehouse/products',{name:`صنف توقيت ${Date.now()}`,category:'other',unit:'عبوة'})).product;
  await send('/api/warehouse/movements',{id:crypto.randomUUID(),kind:'opening',productId:product.id,toWarehouseId:wh.id,qty:1234.125});
  const data=await (await page.request.get(`/api/warehouse/movements?warehouseId=${wh.id}`,{headers})).json();
  const expected=await page.evaluate(at=>new Date(at).toLocaleString('ar-EG',{dateStyle:'full',timeStyle:'short',timeZone:'Africa/Cairo'}),data.movements[0].createdAt);
  await page.getByRole('button',{name:'المخازن',exact:true}).click();
  await page.getByRole('combobox',{name:'المخزن',exact:true}).selectOption(wh.id);
  const rows=page.locator('tr').filter({hasText:product.name});
  await expect(rows.first()).toContainText('١٬٢٣٤٫١٢٥');
  await expect(rows.last()).toContainText('١٬٢٣٤٫١٢٥');
  await expect(rows.last()).toContainText(expected);
  await context.close();
});

test('التصميم الجديد يحافظ على تنقل الموبايل وإظهار الصفحة النشطة', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await signIn(page);
  const nav=page.getByRole('navigation',{name:'التنقل الرئيسي'});
  await expect(page.getByText('اسحب القائمة للتنقل بين الصفحات')).toBeVisible();
  expect(await nav.evaluate(el=>el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(nav.getByRole('button',{name:'مركز العمليات'})).toHaveAttribute('aria-current','page');
  await nav.getByRole('button',{name:'المبيعات',exact:true}).click();
  await expect(page.getByRole('heading',{name:'المبيعات والمخزون'})).toBeVisible();
  await expect(nav.getByRole('button',{name:'المبيعات',exact:true})).toHaveAttribute('aria-current','page');
  await nav.getByRole('button',{name:'هويتي',exact:true}).click();
  await expect(nav.getByRole('button',{name:'هويتي',exact:true})).toHaveAttribute('aria-current','page');
  const dimensions=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width+1);
});

test('أزرار التعديل وكلمة المرور تفتح النماذج في الشاشة على الموبايل', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await signIn(page);
  const headers={'X-Mandoub-Token':token,'X-Mandoub-Client':'admin'};
  const send=async(path:string,data:object)=>{const r=await page.request.post(path,{headers,data});expect(r.ok(),await r.text()).toBeTruthy();return r.json();};
  const customer=(await send('/api/customers',{name:`عميل فتح نموذج ${Date.now()}`})).customer;
  const warehouse=(await send('/api/warehouse/warehouses',{name:`مخزن فتح نموذج ${Date.now()}`})).warehouse;
  const product=(await send('/api/warehouse/products',{name:`صنف فتح نموذج ${Date.now()}`,category:'other',unit:'عبوة'})).product;
  await send('/api/warehouse/movements',{id:crypto.randomUUID(),kind:'opening',productId:product.id,toWarehouseId:warehouse.id,qty:10});
  const staff=(await send('/api/staff',{name:'حساب فتح نموذج',email:`staff-open-${Date.now()}@test.example`,password:'WarehousePassword123!',accessScope:'warehouse'})).user;

  await page.getByRole('button',{name:'العملاء',exact:true}).click();
  const customerRow=page.locator('.customers-table tr').filter({hasText:customer.name});
  await customerRow.getByRole('button',{name:'تعديل'}).click();
  const customerForm=page.locator('form.panel').filter({has:page.getByRole('heading',{name:`تعديل: ${customer.name}`})});
  await expect(customerForm).toBeInViewport();await expect(customerForm).toBeFocused();
  await customerRow.getByRole('button',{name:'تعديل'}).click();
  await expect(customerForm).toBeInViewport();await expect(customerForm).toBeFocused();
  await customerForm.getByRole('button',{name:'إلغاء'}).click();

  await page.getByRole('button',{name:'المخازن',exact:true}).click();
  await page.getByRole('combobox',{name:'المخزن',exact:true}).selectOption(warehouse.id);
  const stockRow=page.locator('tr').filter({hasText:product.name}).first();
  await stockRow.getByRole('button',{name:'تعديل'}).click();
  const stockForm=page.locator('form.panel').filter({has:page.getByRole('heading',{name:'تعديل الصنف'})});
  await expect(stockForm).toBeInViewport();await expect(stockForm).toBeFocused();
  await expect(stockForm.getByLabel('اسم الصنف')).toHaveValue(product.name);
  await stockForm.getByRole('button',{name:'إلغاء'}).click();

  await page.getByRole('button',{name:'حسابات المكتب',exact:true}).click();
  await page.locator('.staff-row').filter({hasText:staff.email}).getByRole('button',{name:'كلمة مرور جديدة'}).click();
  const staffForm=page.locator('form.panel').filter({has:page.getByRole('heading',{name:`كلمة مرور جديدة لـ ${staff.name}`})});
  await expect(staffForm).toBeInViewport();await expect(staffForm).toBeFocused();
  await staffForm.getByRole('button',{name:'إلغاء'}).click();

  await page.getByRole('button',{name:'فريق الميدان',exact:true}).click();
  const engineer=page.locator('.team-row').filter({hasText:'أحمد حسن'}).first();
  await engineer.getByRole('button',{name:'تعديل المنطقة'}).click();
  const region=page.locator('form.panel').filter({has:page.getByRole('heading',{name:'منطقة أحمد حسن'})});
  await expect(region).toBeInViewport();await expect(region).toBeFocused();
  await region.getByRole('button',{name:'إلغاء'}).click();
  await engineer.getByRole('button',{name:'كلمة المرور'}).click();
  const password=page.locator('.reveal-target').filter({has:page.getByRole('heading',{name:'كلمة مرور جديدة لـ أحمد حسن'})});
  await expect(password).toBeInViewport();await expect(password).toBeFocused();
  await password.getByLabel('كلمة المرور').fill('short');
  await password.getByRole('button',{name:'حفظ',exact:true}).click();
  await expect(password.getByRole('alert')).toContainText('١٠ أحرف على الأقل');
  await password.getByRole('button',{name:'إلغاء'}).click();

  await page.getByRole('button',{name:'المبيعات',exact:true}).click();
  await page.getByRole('button',{name:'تعديل الأسعار'}).click();
  await page.getByRole('button',{name:'إدارة الأصناف وأنواع الأسعار'}).click();
  const productRow=page.locator('tr').filter({hasText:product.name}).first();
  await productRow.getByRole('button',{name:'تعديل',exact:true}).click();
  const productForm=page.locator('form.panel').filter({has:page.getByRole('heading',{name:`تعديل: ${product.name}`})});
  await expect(productForm).toBeInViewport();await expect(productForm).toBeFocused();
  await productForm.getByRole('button',{name:'إلغاء'}).click();
});

test('نجاح إضافة المخزن أو الصنف يظل واضحًا لو تحديث القائمة فشل', async ({page}) => {
  await signIn(page);
  const headers={'X-Mandoub-Token':token,'X-Mandoub-Client':'admin'};
  const warehouseName=`مخزن قائمة ${Date.now()}`;
  await page.getByRole('button',{name:'المخازن',exact:true}).click();
  await page.getByLabel('اسم مخزن جديد').fill(warehouseName);
  await page.route('**/api/warehouse/warehouses',route=>route.request().method()==='GET'?route.abort('failed'):route.continue());
  await page.getByRole('button',{name:'إضافة مخزن'}).click();
  await expect(page.locator('.ok-text[role=status]')).toContainText('المخزن اتضاف');
  await expect(page.getByRole('alert')).toContainText('المخزن اتضاف، لكن القائمة ما اتحدّثتش');
  await page.unroute('**/api/warehouse/warehouses');
  const warehouses=await (await page.request.get('/api/warehouse/warehouses',{headers})).json();
  const warehouse=warehouses.warehouses.find((w:{name:string})=>w.name===warehouseName);expect(warehouse).toBeTruthy();
  await page.reload();await page.getByRole('button',{name:'المخازن',exact:true}).click();
  await page.getByRole('combobox',{name:'المخزن',exact:true}).selectOption(warehouse.id);
  const productName=`صنف قائمة ${Date.now()}`;
  await page.getByLabel('اسم الصنف').fill(productName);await page.getByLabel('الوحدة',{exact:true}).fill('عبوة');await page.getByLabel('الرصيد الافتتاحي للمخزن المحدد').fill('10');
  await page.route('**/api/warehouse/stock?*',route=>route.abort('failed'));
  await page.getByRole('button',{name:'إضافة صنف'}).click();
  await expect(page.locator('.ok-text[role=status]')).toContainText('الصنف اتضاف');
  await expect(page.getByRole('alert')).toContainText('الحركة اتحفظت، لكن الأرصدة ما اتحدّثتش');
  await page.unroute('**/api/warehouse/stock?*');
  const products=await (await page.request.get('/api/warehouse/products',{headers})).json();
  expect(products.products.filter((p:{name:string})=>p.name===productName)).toHaveLength(1);
});


test('نجاح إنشاء حساب مكتب يظهر بوضوح لو فشل تحديث القائمة', async ({page}) => {
  await signIn(page);
  const headers={'X-Mandoub-Token':token,'X-Mandoub-Client':'admin'};
  const email=`staff-refresh-${Date.now()}@test.example`;
  await page.getByRole('button',{name:'حسابات المكتب',exact:true}).click();
  await expect(page.getByRole('heading',{name:'الحسابات'})).toBeVisible();
  await page.getByLabel('الاسم',{exact:true}).fill('حساب اختبار التحديث');
  await page.getByLabel('البريد الإلكتروني').fill(email);
  await page.getByLabel('كلمة المرور',{exact:true}).fill('PasswordForStaff123!');
  await page.route('**/api/staff',route=>route.request().method()==='GET'?route.abort('failed'):route.continue());
  await page.getByRole('button',{name:'إنشاء الحساب'}).click();
  await expect(page.locator('.ok-text[role=status]')).toContainText('اتعمل حساب');
  await expect(page.getByRole('alert')).toContainText('الحساب اتعمل، لكن القائمة ما اتحدّثتش');
  await page.unroute('**/api/staff');
  const data=await (await page.request.get('/api/staff',{headers})).json();
  expect(data.staff.filter((user:{email:string})=>user.email===email)).toHaveLength(1);
});

test('الانتقال من أولويات العمل يفتح الصفحة من بدايتها', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await signIn(page);
  await page.getByRole('button',{name:'المساعد الذكي',exact:true}).click();
  await page.getByText('أولويات الشغل الحالية').click();
  await page.getByRole('button',{name:'افتح العملاء'}).click();
  await expect(page.getByRole('heading',{level:1,name:'العملاء'})).toBeInViewport();
  await expect(page.locator('header.topbar')).toBeFocused();
});

test('تبويب المخزن يطلب تحديثًا بعد انتهاء حركة في تبويب آخر ولا يقبل ردًا أقدم',async({page,context})=>{
 await signIn(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const wh=await (await page.request.post('/api/warehouse/warehouses',{headers,data:{name:`مخزن تبويبين ${Date.now()}`}})).json();
 await page.getByRole('button',{name:'المخازن',exact:true}).click();await page.getByRole('combobox',{name:'المخزن',exact:true}).selectOption(wh.warehouse.id);await expect(page.getByLabel('الكمية')).toBeEnabled();
 const other=await context.newPage();await other.goto('/');const key=await page.evaluate(()=>Object.keys(localStorage).find(k=>k.startsWith('mandoub.warehouse.pending.'))||'');
 const userId=await page.evaluate(async()=>{const token=localStorage.getItem('mandoub.token');const r=await fetch('/api/auth/me',{headers:{'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'}});return (await r.json()).user.id;});const pendingKey=key||`mandoub.warehouse.pending.${userId}`;
 await other.evaluate(k=>localStorage.setItem(k,'{"body":{"id":"test"},"description":"اختبار"}'),pendingKey);await expect(page.getByLabel('الكمية')).toBeDisabled();
 await other.evaluate(k=>localStorage.removeItem(k),pendingKey);await expect(page.getByText('لازم تعيد تحميل الأرصدة')).toBeVisible();
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>started=r);
 await page.route('**/api/warehouse/stock?*',async route=>{const response=await route.fetch();started();await gate;await route.fulfill({response});});
 await page.getByRole('button',{name:'إعادة تحميل الأرصدة'}).click();await waiting;
 await other.evaluate(k=>localStorage.setItem(k,'{"body":{"id":"test2"},"description":"اختبار"}'),pendingKey);await expect(page.getByText('في حركة مخزون لم نتأكد من نتيجتها.')).toBeVisible();
 await other.evaluate(k=>localStorage.removeItem(k),pendingKey);await expect(page.getByText('لازم تعيد تحميل الأرصدة')).toBeVisible();release();
 await expect(page.getByRole('button',{name:'إعادة تحميل الأرصدة'})).toBeVisible();await expect(page.getByLabel('الكمية')).toBeDisabled();
 await page.unroute('**/api/warehouse/stock?*');await page.getByRole('button',{name:'إعادة تحميل الأرصدة'}).click();await expect(page.getByLabel('الكمية')).toBeEnabled();await other.close();
});
