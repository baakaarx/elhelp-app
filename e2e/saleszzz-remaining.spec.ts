import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {signInAsManager} from './helpers';

test('يبقى جدول الأسعار في مكانه وغير قابل للتعديل أثناء التحديث أو فشله',async({page})=>{
 await signInAsManager(page);await page.getByRole('button',{name:'المبيعات',exact:true}).click();await page.getByRole('button',{name:'تعديل الأسعار'}).click();await page.getByRole('button',{name:'إدارة الأصناف وأنواع الأسعار'}).click();
 const row=page.locator('.products-table tbody tr').filter({hasText:'يوريا ٤٦٪'});await expect(row).toBeVisible();await row.locator('td').nth(4).getByRole('button').click();await row.getByLabel('سعر يوريا ٤٦٪ — نصف جملة').fill('1,250.50');
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>started=r);
 await page.route('**/api/products?*',async route=>{const response=await route.fetch();started();await gate;await route.fulfill({response});});
 await row.getByRole('button',{name:'حفظ'}).click();await waiting;await expect(row).toBeVisible();await expect(page.getByText('جارٍ تحديث الأصناف والأسعار',{exact:false})).toBeVisible();await expect(row.getByRole('button',{name:'تعديل'})).toBeDisabled();
 release();await expect(page.getByText('جارٍ تحديث الأصناف والأسعار',{exact:false})).toHaveCount(0);await expect(row.getByRole('button',{name:'تعديل'})).toBeEnabled();
 await page.unroute('**/api/products?*');await page.route('**/api/products?*',route=>route.abort());await page.locator('.filters').filter({has:page.getByLabel('الموقوفين')}).getByRole('button',{name:'تحديث',exact:true}).click();await expect(page.getByText('المعروض قديم ولا يمكن تعديله',{exact:false})).toBeVisible();await expect(row).toBeVisible();await expect(row.getByRole('button',{name:'تعديل'})).toBeDisabled();
 await page.unroute('**/api/products?*');await page.locator('.filters').filter({has:page.getByLabel('الموقوفين')}).getByRole('button',{name:'تحديث',exact:true}).click();await expect(row.getByRole('button',{name:'تعديل'})).toBeEnabled();
});

test('فواصل التجميع في سعر المبيعات تُقرأ مثل قائمة الأصناف ولا تُخمن الكسور',async({page})=>{
 await signInAsManager(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const send=async(path:string,data:object)=>{const r=await page.request.post(path,{headers,data});expect(r.ok(),await r.text()).toBeTruthy();return r.json();};
 const customer=(await send('/api/customers',{name:`عميل فواصل ${Date.now()}`})).customer;const w=(await send('/api/warehouse/warehouses',{name:`مخزن فواصل ${Date.now()}`})).warehouse;const p=(await send('/api/warehouse/products',{name:`صنف فواصل ${Date.now()}`,category:'other',unit:'عبوة'})).product;
 await send('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:p.id,toWarehouseId:w.id,qty:10});
 await page.getByRole('button',{name:'المبيعات',exact:true}).click();await page.getByRole('button',{name:'تعديل الأسعار'}).click();await page.getByRole('combobox',{name:'الصنف',exact:true}).selectOption(p.id);await page.getByRole('combobox',{name:'نوع السعر'}).selectOption({label:'جملة'});
 await page.getByLabel('سعر العبوة (ج.م)').fill('1,5');await page.getByRole('button',{name:'حفظ السعر'}).click();await expect(page.getByRole('alert')).toContainText('اكتب سعر صحيح');
 await page.getByLabel('سعر العبوة (ج.م)').fill('1,250.50');await page.getByRole('button',{name:'حفظ السعر'}).click();await expect(page.getByRole('status').filter({hasText:'السعر اتحفظ'})).toBeVisible();
 await page.getByRole('button',{name:'رجوع للملخص'}).click();await page.getByRole('button',{name:'تسجيل فاتورة',exact:true}).click();
 const form=page.locator('form').filter({has:page.getByRole('heading',{name:'تسجيل فاتورة'})});
 await form.getByRole('combobox',{name:'العميل',exact:true}).selectOption(customer.id);await form.getByRole('combobox',{name:'المخزن',exact:true}).selectOption(w.id);await form.getByRole('combobox',{name:'المهندس المسؤول'}).selectOption('none');await form.getByRole('combobox',{name:'الصنف ١'}).selectOption(p.id);
 await form.getByRole('textbox',{name:'الكمية',exact:true}).fill('2');await form.getByRole('textbox',{name:'سعر الوحدة (ج.م)'}).fill('1,250.50');await form.getByRole('textbox',{name:'المدفوع دلوقتي (ج.م)'}).fill('0');
 await page.getByRole('button',{name:'مراجعة الفاتورة'}).click();await expect(page.getByLabel('مراجعة العملية')).toContainText('٢٬٥٠١');await page.getByRole('button',{name:'تأكيد وحفظ'}).click();await expect(page.getByRole('status').filter({hasText:'الفاتورة اتسجلت'})).toBeVisible();
 const statement=await (await page.request.get(`/api/sales/statement/${customer.id}`,{headers})).json();expect(statement.sales[0].total).toBe(2501);expect(statement.sales[0].lines[0].price).toBe(1250.5);
});

test('العبوتان المتشابهتان واضحتان في طلبية المهندس وفاتورة المكتب والمخزون',async({page,browser})=>{
 await signInAsManager(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const send=async(path:string,data:object)=>{const r=await page.request.post(path,{headers,data});expect(r.ok(),await r.text()).toBeTruthy();return r.json();};
 const suffix=Date.now(),name=`صنف عبوتين ${suffix}`,email=`packs-${suffix}@test.example`,password='RepPassword123!';
 const rep=(await send('/api/reps',{name:'مهندس عبوات اختبار',email,password,region:'الإسكندرية'})).user;
 const c=(await send('/api/customers',{name:`عميل عبوتين ${suffix}`,repId:rep.id})).customer;
 const a=(await send('/api/warehouse/products',{name,category:'other',unit:'عبوة',unitSize:'١٠٠ جم'})).product;
 const b=(await send('/api/warehouse/products',{name,category:'other',unit:'عبوة',unitSize:'٢٥٠ جم'})).product;
 const w=(await send('/api/warehouse/warehouses',{name:`مخزن عبوتين ${suffix}`})).warehouse;
 await send('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:a.id,toWarehouseId:w.id,qty:10});await send('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:b.id,toWarehouseId:w.id,qty:20});
 const context=await browser.newContext({viewport:{width:420,height:850}});const phone=await context.newPage();await phone.goto('http://127.0.0.1:3100/app/');
 await phone.getByPlaceholder('rep@company.com').fill(email);await phone.getByPlaceholder('••••••••').fill(password);await phone.getByRole('button',{name:'دخول',exact:true}).click();
 await phone.getByRole('button',{name:'تسجيل طلبية'}).click();await phone.getByText(c.name,{exact:true}).last().click();await expect(phone.getByRole('button',{name:'اختار واحد تاني'})).toBeVisible();await phone.getByPlaceholder('مثال: يوريا أو شيكارة').fill(name);
 await phone.getByRole('button',{name:`ضيف ${name} · عبوة · ١٠٠ جم`}).click();await phone.getByRole('button',{name:`ضيف ${name} · عبوة · ٢٥٠ جم`}).click();
 await phone.getByLabel(`كمية ${name} · عبوة · ١٠٠ جم`).fill('2');await phone.getByLabel(`كمية ${name} · عبوة · ٢٥٠ جم`).fill('3');
 const response=phone.waitForResponse(r=>r.url().endsWith('/api/orders')&&r.request().method()==='POST');await phone.getByRole('button',{name:/ابعت الطلبية للمكتب/}).click();const data=await (await response).json();expect(data.order.lines.map((l:{qty:number})=>l.qty)).toEqual([2,3]);
 await page.getByRole('button',{name:'المبيعات',exact:true}).click();await page.getByRole('button',{name:'تسجيل فاتورة',exact:true}).click();await page.getByRole('combobox',{name:'نوع الفاتورة'}).selectOption('order');await page.getByRole('combobox',{name:'الطلبية'}).selectOption(data.order.id);
 await expect(page.getByRole('checkbox',{name:`بيع ${name} · عبوة ١٠٠ جم`})).toBeChecked();await expect(page.getByRole('checkbox',{name:`بيع ${name} · عبوة ٢٥٠ جم`})).toBeChecked();
 await page.getByLabel(`سعر الوحدة · ${name} · عبوة ١٠٠ جم (ج.م)`).fill('5');await page.getByLabel(`سعر الوحدة · ${name} · عبوة ٢٥٠ جم (ج.م)`).fill('10');
 const form=page.locator('form').filter({has:page.getByRole('heading',{name:'تسجيل فاتورة'})});await form.getByRole('combobox',{name:'المخزن',exact:true}).selectOption(w.id);await form.getByLabel('المدفوع دلوقتي (ج.م)').fill('0');await form.getByRole('button',{name:'مراجعة الفاتورة'}).click();
 const review=page.getByLabel('مراجعة العملية');await expect(review).toContainText('١٠٠ جم');await expect(review).toContainText('٢٥٠ جم');await expect(review).toContainText('٤٠');await page.getByRole('button',{name:'تأكيد وحفظ'}).click();await expect(page.getByRole('status').filter({hasText:'الفاتورة اتسجلت'})).toBeVisible();
 const statement=await (await page.request.get(`/api/sales/statement/${c.id}`,{headers})).json();expect(statement.sales[0].lines.map((l:{qty:number;price:number})=>[l.qty,l.price])).toEqual([[2,5],[3,10]]);
 const stock=await (await page.request.get(`/api/warehouse/stock?warehouseId=${w.id}`,{headers})).json();expect(stock.stock.find((x:{id:string})=>x.id===a.id).qty).toBe(8);expect(stock.stock.find((x:{id:string})=>x.id===b.id).qty).toBe(17);await context.close();
});

test('قائمة العملاء تبقى في مكانها وتمنع التعديل حتى ينجح التحديث',async({page})=>{
 await signInAsManager(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};const name=`عميل ثبات الجدول ${Date.now()}`;const created=await page.request.post('/api/customers',{headers,data:{name}});expect(created.ok(),await created.text()).toBeTruthy();
 await page.getByRole('button',{name:'العملاء',exact:true}).click();const row=page.locator('.customers-table tbody tr').filter({hasText:name});await expect(row).toBeVisible();
 await row.getByRole('button',{name:'تعديل'}).click();const form=page.locator('form.panel');await form.getByLabel('ملاحظات').fill('مراجعة التحديث');
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>started=r);await page.route('**/api/customers?*',async route=>{const response=await route.fetch();started();await gate;await route.fulfill({response});});
 await form.getByRole('button',{name:'حفظ',exact:true}).click();await waiting;await expect(row).toBeVisible();await expect(row.getByRole('button',{name:'تعديل'})).toBeDisabled();release();await expect(row).toContainText('مراجعة التحديث');await expect(row.getByRole('button',{name:'تعديل'})).toBeEnabled();
 await page.unroute('**/api/customers?*');await page.route('**/api/customers?*',route=>route.abort());await row.getByRole('button',{name:'وقف',exact:true}).click();await expect(page.getByText('العملاء المعروضون قدام',{exact:false})).toBeVisible();await expect(row.getByRole('button',{name:'تعديل'})).toBeDisabled();
 await page.unroute('**/api/customers?*');await page.getByRole('button',{name:'إعادة تحميل العملاء'}).click();await expect(row).toHaveCount(0);
});
