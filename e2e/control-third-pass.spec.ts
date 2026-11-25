import {test,expect} from '@playwright/test';
import {signInAsManager} from './helpers';

test('كشف الحساب لا يظهر حساب العميل السابق بعد تغيير الاختيار وتأخر الرد',async({page})=>{
 await signInAsManager(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const create=async(name:string)=>{const r=await page.request.post('/api/customers',{headers,data:{name}});expect(r.ok(),await r.text()).toBeTruthy();return (await r.json()).customer;};
 const a=await create(`حساب أول ${Date.now()}`),b=await create(`حساب تاني ${Date.now()}`);
 await page.getByRole('button',{name:'المبيعات',exact:true}).click();const select=page.getByLabel('العميل لمراجعة الحساب');
 await select.selectOption(a.id);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>started=r);
 await page.route('**/api/sales/statement/**',async route=>{if(route.request().url().includes(a.id)){const response=await route.fetch();started();await gate;await route.fulfill({response});}else await route.continue();});
 await page.getByRole('button',{name:'عرض الحساب'}).click();await waiting;await select.selectOption(b.id);
 await page.getByRole('button',{name:'عرض الحساب'}).click({timeout:3000});await expect(page.getByLabel('حساب العميل')).toContainText(b.name);
 release();await page.waitForTimeout(300);await expect(page.getByLabel('حساب العميل')).toContainText(b.name);await expect(page.getByLabel('حساب العميل')).not.toContainText(a.name);
});

test('فشل تحميل المخزن لا يدعي عدم وجود أصناف ويمنع الحركة حتى تحديث الأرصدة',async({page})=>{
 await signInAsManager(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const create=async(path:string,data:object)=>{const r=await page.request.post(path,{headers,data});expect(r.ok(),await r.text()).toBeTruthy();return r.json();};
 const w=(await create('/api/warehouse/warehouses',{name:`مخزن فشل ${Date.now()}`})).warehouse;
 await page.getByRole('button',{name:'المخازن',exact:true}).click();await page.route('**/api/warehouse/stock?*',route=>route.abort());
 await page.getByRole('combobox',{name:'المخزن',exact:true}).selectOption(w.id);
 await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByRole('button',{name:'حفظ الحركة'})).toBeDisabled();
 await expect(page.getByText('مفيش أصناف لسه.')).toHaveCount(0);await expect(page.getByText('مفيش حركات لسه.')).toHaveCount(0);
 await page.unroute('**/api/warehouse/stock?*');await page.getByRole('button',{name:'إعادة تحميل الأرصدة'}).click();await expect(page.getByRole('button',{name:'حفظ الحركة'})).toBeEnabled();
});

test('رد قديم للمخزن لا يخفي صنفًا أُضيف أثناء تحميل الأرصدة',async({page})=>{
 await signInAsManager(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const wh=await page.request.post('/api/warehouse/warehouses',{headers,data:{name:`مخزن سباق ${Date.now()}`}});expect(wh.ok()).toBeTruthy();const id=(await wh.json()).warehouse.id;
 const other=await page.request.post('/api/warehouse/warehouses',{headers,data:{name:`مخزن آخر ${Date.now()}`}});expect(other.ok()).toBeTruthy();const otherId=(await other.json()).warehouse.id;
 await page.getByRole('button',{name:'المخازن',exact:true}).click();
 const picker=page.getByRole('combobox',{name:'المخزن',exact:true});await expect(picker.locator(`option[value="${otherId}"]`)).toHaveCount(1);await picker.selectOption(otherId);await expect(page.getByRole('button',{name:'حفظ الحركة'})).toBeEnabled();
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>started=r);let first=true;
 await page.route('**/api/warehouse/stock?*',async route=>{if(first&&new URL(route.request().url()).searchParams.get('warehouseId')===id){first=false;const response=await route.fetch();started();await gate;await route.fulfill({response});}else await route.continue();});
 await page.getByRole('combobox',{name:'المخزن',exact:true}).selectOption(id);await waiting;
 const name=`صنف سباق ${Date.now()}`;const form=page.locator('form').filter({has:page.getByRole('button',{name:'إضافة صنف'})});
 await form.getByLabel('اسم الصنف').fill(name);await form.getByLabel('الوحدة').fill('عبوة');await form.getByRole('button',{name:'إضافة صنف'}).click();
 await expect(page.getByRole('status').filter({hasText:'الصنف اتضاف'})).toBeVisible();await expect(page.locator('tr').filter({hasText:name})).toBeVisible();
 release();await page.waitForTimeout(300);await expect(page.locator('tr').filter({hasText:name})).toBeVisible();
});
