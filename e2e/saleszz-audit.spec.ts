import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { signInAsManager } from './helpers';

test('رد قديم لملخص المبيعات لا يستبدل الأرقام الأحدث بعد حفظ السعر', async ({page}) => {
 await signInAsManager(page);
 const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const customer=(await (await page.request.post('/api/customers',{headers,data:{name:`عميل سباق مبيعات ${Date.now()}`}})).json()).customer;
 const before=await (await page.request.get('/api/sales/overview',{headers})).json();
 await page.getByRole('button',{name:'المبيعات',exact:true}).click();await page.getByRole('button',{name:'تعديل الأسعار'}).click();await page.getByRole('button',{name:'إدارة الأصناف وأنواع الأسعار'}).click();
 let release!:()=>void, started!:()=>void;const gate=new Promise<void>(r=>release=r), waiting=new Promise<void>(r=>started=r);let first=true;
 await page.route('**/api/sales/overview',async route=>{if(first){first=false;const response=await route.fetch();started();await gate;await route.fulfill({response});}else await route.continue();});
 await page.getByRole('button',{name:'رجوع للتسعير'}).click();await waiting;
 const opening=await page.request.post('/api/sales/opening',{headers,data:{id:randomUUID(),customerId:customer.id,amount:103}});expect(opening.ok(),await opening.text()).toBeTruthy();
 const form=page.locator('.sales-page');
 await form.getByRole('combobox',{name:'الصنف',exact:true}).selectOption({label:'يوريا ٤٦٪ · شيكارة ٥٠ كجم'});
 await form.getByRole('combobox',{name:'نوع السعر'}).selectOption({label:'جملة'});await form.getByLabel('سعر العبوة (ج.م)').fill('120');await form.getByRole('button',{name:'حفظ السعر'}).click();
 await expect(page.getByRole('status').filter({hasText:'السعر اتحفظ'})).toBeVisible();
 await page.getByRole('button',{name:'رجوع للملخص'}).click();
 const due=page.locator('.stat').filter({hasText:'الباقي المسجّل على العملاء'}).locator('strong');
 const expected=(before.due+103).toLocaleString('ar-EG',{maximumFractionDigits:2});await expect(due).toContainText(expected);
 release();await page.waitForTimeout(300);await expect(due).toContainText(expected);
});

test('بيانات عملية مبيعات غير مقروءة تمنع العمل وتظهر تحذيرًا قبل محاولة التسجيل',async({page})=>{
 await signInAsManager(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const me=await (await page.request.get('/api/auth/me',{headers:{'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'}})).json();
 await page.evaluate(id=>localStorage.setItem(`mandoub.sales.pending.${id}`,'{bad json'),me.user.id);
 await page.getByRole('button',{name:'المبيعات',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('تعذر قراءة العملية');await expect(page.getByRole('button',{name:'تسجيل فاتورة'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'مراجعة الدفعة'})).toHaveCount(0);
 await page.evaluate(id=>localStorage.setItem(`mandoub.sales.pending.${id}`,''),me.user.id);await page.reload();
 await page.getByRole('button',{name:'المبيعات',exact:true}).click();await expect(page.getByRole('alert')).toContainText('تعذر قراءة العملية');
});

test('تلف عملية معلقة في تبويب آخر يوقف المبيعات قبل تسجيل عملية جديدة',async({page,context})=>{
 await signInAsManager(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const me=await (await page.request.get('/api/auth/me',{headers:{'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'}})).json();
 await page.getByRole('button',{name:'المبيعات',exact:true}).click();await expect(page.getByRole('button',{name:'مراجعة الدفعة'})).toBeVisible();
 const other=await context.newPage();await other.goto('/');await other.evaluate(id=>localStorage.setItem(`mandoub.sales.pending.${id}`,JSON.stringify({kind:'sale',path:'/api/sales',body:{}})),me.user.id);
 await expect(page.getByRole('alert')).toContainText('تعذر قراءة العملية');await expect(page.getByRole('button',{name:'مراجعة الدفعة'})).toHaveCount(0);
 await other.evaluate(id=>localStorage.removeItem(`mandoub.sales.pending.${id}`),me.user.id);
 await expect(page.getByRole('heading',{name:'لازم نحدّث الأرقام الأول'})).toBeVisible();await page.getByRole('button',{name:'تحديث الأرقام'}).click();await expect(page.getByRole('button',{name:'مراجعة الدفعة'})).toBeVisible();await other.close();
});

test('فشل تحديث بيانات المبيعات يمنع استخدام الملخص القديم حتى إعادة التحميل',async({page})=>{
 await signInAsManager(page);await page.getByRole('button',{name:'المبيعات',exact:true}).click();await page.getByRole('button',{name:'تعديل الأسعار'}).click();await page.getByRole('button',{name:'إدارة الأصناف وأنواع الأسعار'}).click();
 await expect(page.locator('.products-table')).toBeVisible();await page.route('**/api/sales/overview',route=>route.abort());await page.getByRole('button',{name:'رجوع للتسعير'}).click();
 await expect(page.getByRole('heading',{name:'لازم نحدّث الأرقام الأول'})).toBeVisible();await expect(page.getByRole('button',{name:'حفظ السعر'})).toHaveCount(0);await expect(page.getByRole('button',{name:'تسجيل فاتورة'})).toHaveCount(0);
 await page.unroute('**/api/sales/overview');await page.getByRole('button',{name:'تحديث الأرقام'}).click();await expect(page.getByRole('button',{name:'حفظ السعر'})).toBeVisible();
});

test('تغيّر حساب العميل أثناء مراجعة التصحيح يمنع تأكيد أرقام قديمة',async({page})=>{
 await signInAsManager(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const send=async(path:string,data:object)=>{const r=await page.request.post(path,{headers,data});expect(r.ok(),await r.text()).toBeTruthy();return r.json();};
 const c=(await send('/api/customers',{name:`عميل سباق تصحيح ${Date.now()}`})).customer;
 const w=(await send('/api/warehouse/warehouses',{name:`مخزن سباق تصحيح ${Date.now()}`})).warehouse;
 const p=(await send('/api/warehouse/products',{name:`صنف سباق تصحيح ${Date.now()}`,category:'other',unit:'عبوة'})).product;
 const {randomUUID}=await import('node:crypto');await send('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:p.id,toWarehouseId:w.id,qty:10});
 const sale=randomUUID();await send('/api/sales',{id:sale,customerId:c.id,warehouseId:w.id,paid:30,lines:[{productId:p.id,qty:2,price:50}]});
 await page.getByRole('button',{name:'المبيعات',exact:true}).click();await page.getByRole('combobox',{name:'العميل لمراجعة الحساب'}).selectOption(c.id);await page.getByRole('button',{name:'عرض الحساب'}).click();
 const statement=page.getByLabel('حساب العميل');await statement.locator('summary').first().click();await statement.getByRole('button',{name:'تصحيح أو تسجيل مرتجع'}).click();
 await page.getByRole('textbox',{name:`كمية إضافية لتصحيح البيع - ${p.name}`}).fill('1');await page.getByRole('textbox',{name:'سبب التصحيح'}).fill('تصحيح بيانات مسجلة بالخطأ');await page.getByRole('button',{name:'مراجعة التصحيح'}).click();
 await send('/api/sales/receipts',{id:randomUUID(),customerId:c.id,amount:5});
 await page.getByRole('button',{name:'تأكيد التصحيح'}).click();await expect(page.getByRole('alert')).toContainText('التصحيح لم يُحفظ');await expect(page.getByLabel('مراجعة التصحيح')).toHaveCount(0);
 await page.getByRole('button',{name:'تحديث الأرقام'}).click();await expect(page.getByRole('combobox',{name:'العميل لمراجعة الحساب'})).toBeVisible();
 const detail=await (await page.request.get(`/api/sales/corrections/sale/${sale}`,{headers})).json();expect(detail.revision).toBe(0);expect(detail.lines[0].corrected).toBe(0);
});
