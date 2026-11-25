import {test,expect,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {signInAsManager} from './helpers';

async function catalogue(page:Page){await page.getByRole('button',{name:'المبيعات',exact:true}).click();await page.getByRole('button',{name:'تعديل الأسعار'}).click();await page.getByRole('button',{name:'إدارة الأصناف وأنواع الأسعار'}).click();await expect(page.locator('.products-table')).toBeVisible();}

test('رفض حذف صنف مستخدم يظل ظاهرًا بعد تحديث القائمة',async({page})=>{
 await signInAsManager(page);await catalogue(page);const row=page.locator('.products-table tbody tr').filter({hasText:'يوريا ٤٦٪'});
 await row.getByRole('button',{name:'حذف',exact:true}).click();await row.getByRole('button',{name:'امسحه نهائيًا'}).click();
 await expect(page.getByRole('alert')).toContainText('الصنف ده مستخدم');await expect(row).toBeVisible();
});

test('تعديل السعر يؤكد حفظه لو فشل تحديث القائمة بعده',async({page})=>{
 await signInAsManager(page);await catalogue(page);const row=page.locator('.products-table tbody tr').filter({hasText:'يوريا ٤٦٪'});
 await row.locator('td').nth(4).getByRole('button').click();await row.getByLabel('سعر يوريا ٤٦٪ — نصف جملة').fill('1234.50');
 await page.route('**/api/products?*',route=>route.abort());await row.getByRole('button',{name:'حفظ'}).click();
 await expect(page.getByRole('status').filter({hasText:'السعر اتحفظ'})).toBeVisible();await expect(page.getByRole('alert')).toBeVisible();
 await page.unroute('**/api/products?*');const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const products=await (await page.request.get('/api/products?q=يوريا',{headers})).json(),tiers=await (await page.request.get('/api/price-tiers',{headers})).json();
 expect(products.products.find((p:{name:string})=>p.name==='يوريا ٤٦٪').prices.find((p:{tierId:string})=>p.tierId===tiers.tiers.find((t:{name:string})=>t.name==='نصف جملة').id).price).toBe(1234.5);
});

test('فقد رد نقل العميل لا يدعي أن النقل اترفض بعد احتمال نجاحه',async({page})=>{
 await signInAsManager(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const created=await page.request.post('/api/customers',{headers,data:{name:`عميل نقل ${Date.now()}`}});expect(created.ok()).toBeTruthy();const customer=(await created.json()).customer;
 const reps=await (await page.request.get('/api/reps',{headers})).json();const rep=reps.reps.find((r:{name:string})=>r.name==='مصطفى كامل');
 await page.getByRole('button',{name:'العملاء',exact:true}).click();const row=page.locator('.customers-table tr').filter({hasText:customer.name});await row.getByRole('button',{name:'تعديل'}).click();
 const form=page.locator('form.panel');await form.getByLabel('المحافظة').fill('المنوفية');await form.getByLabel('نقل إلى مهندس').selectOption(rep.id);
 await page.route(`**/api/customers/${customer.id}/assign`,async route=>{await route.fetch();await route.abort();});
 await form.getByRole('button',{name:'حفظ',exact:true}).click();await expect(form.getByRole('alert')).toContainText('تعذر التأكد');await expect(form.getByRole('alert')).not.toContainText('النقل اترفض');
 const list=await (await page.request.get(`/api/customers?q=${encodeURIComponent(customer.name)}`,{headers})).json();expect(list.customers[0].repId).toBe(rep.id);expect(list.customers[0].governorate).toBe('المنوفية');
});

test('خطأ مبلغ الدفعة يظهر في الشاشة عند استخدام الموبايل',async({page})=>{
 await page.setViewportSize({width:390,height:844});await signInAsManager(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const customer=(await (await page.request.post('/api/customers',{headers,data:{name:`عميل تنبيه ${Date.now()}`}})).json()).customer;
 const init=await page.request.post('/api/sales/opening',{headers,data:{id:randomUUID(),customerId:customer.id,amount:30}});expect(init.ok()).toBeTruthy();
 await page.getByRole('button',{name:'المبيعات',exact:true}).click();const debtor=page.locator('tr').filter({hasText:customer.name}).filter({has:page.getByRole('button',{name:'تسجيل دفعة'})});await debtor.getByRole('button',{name:'تسجيل دفعة'}).click();
 await page.getByRole('textbox',{name:'المبلغ (ج.م)',exact:true}).fill('40');await page.getByRole('button',{name:'مراجعة الدفعة'}).click();
 await expect(page.getByRole('alert')).toContainText('الدفعة أكبر');await expect(page.getByRole('alert')).toBeInViewport();
});
