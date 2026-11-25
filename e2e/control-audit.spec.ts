import {test,expect,request} from '@playwright/test';
import {signInAsManager} from './helpers';
import {E2E_API} from './fixtures';
import {randomUUID} from 'node:crypto';

test('خانات وحركات المخزن تعمل من الواجهة وتحافظ على أرصدة مستقلة',async({page})=>{
 await signInAsManager(page);
 const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const send=async(path:string,data:object)=>{const r=await page.request.post(path,{headers,data});expect(r.ok(),await r.text()).toBeTruthy();return r.json();};
 const one=(await send('/api/warehouse/warehouses',{name:`مخزن فحص أول ${Date.now()}`})).warehouse;
 const two=(await send('/api/warehouse/warehouses',{name:`مخزن فحص تاني ${Date.now()}`})).warehouse;
 const product=(await send('/api/warehouse/products',{name:`صنف فحص أزرار ${Date.now()}`,category:'other',unit:'عبوة'})).product;
 await send('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:product.id,toWarehouseId:two.id,qty:0});
 await page.getByRole('button',{name:'المخازن',exact:true}).click();
 await page.getByRole('combobox',{name:'المخزن',exact:true}).selectOption(one.id);
 await page.getByRole('combobox',{name:'الصنف',exact:true}).selectOption(product.id);
 await page.getByLabel('الكمية').fill('٠');await page.getByRole('button',{name:'حفظ الحركة'}).click();
 await expect(page.locator('.ok-text[role=status]')).toContainText('الحركة اتحفظت');
 await page.getByLabel('نوع الحركة').selectOption('in');await page.getByLabel('الكمية').fill('٥٫١٢٥');
 await page.getByLabel('ملاحظة').fill('إضافة اختبار');await page.getByRole('button',{name:'حفظ الحركة'}).click();
 await expect(page.locator('.ok-text[role=status]')).toContainText('الحركة اتحفظت');
 await page.getByLabel('نوع الحركة').selectOption('out');await page.getByLabel('الكمية').fill('١٫١٢٥');
 await page.getByRole('button',{name:'حفظ الحركة'}).click();await expect(page.locator('.ok-text[role=status]')).toContainText('الحركة اتحفظت');
 await page.getByLabel('نوع الحركة').selectOption('transfer');await page.getByLabel('إلى مخزن').selectOption(two.id);
 await page.getByLabel('الكمية').fill('١');await page.getByRole('button',{name:'حفظ الحركة'}).click();
 await expect(page.locator('.ok-text[role=status]')).toContainText('الحركة اتحفظت');
 const balance=async(id:string)=>(await (await page.request.get(`/api/warehouse/stock?warehouseId=${id}`,{headers})).json()).stock.find((p:{id:string})=>p.id===product.id).qty;
 expect(await balance(one.id)).toBe(3);expect(await balance(two.id)).toBe(1);
 const row=page.locator('tr').filter({hasText:product.name}).first();await row.getByRole('button',{name:'تعديل'}).click();
 const form=page.locator('form.panel').filter({has:page.getByRole('heading',{name:'تعديل الصنف'})});
 await form.getByLabel('اسم الصنف').fill(`${product.name} معدل`);await form.getByRole('button',{name:'حفظ التعديل'}).click();
 await expect(page.locator('.ok-text[role=status]')).toContainText('الصنف اتعدل');
 const updated=page.locator('tr').filter({hasText:`${product.name} معدل`}).first();
 await updated.getByRole('button',{name:'وقف',exact:true}).click();await expect(updated).toContainText('موقوف');
 await updated.getByRole('button',{name:'تفعيل',exact:true}).click();await expect(updated).toContainText('شغال');
});

test('تغيير كلمة مرور حساب المخازن وإيقافه وإعادة تفعيله من الواجهة',async({page})=>{
 await signInAsManager(page);
 const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const email=`staff-controls-${Date.now()}@test.example`,oldPassword='WarehousePassword123!',newPassword='NewWarehousePassword123!';
 const created=await page.request.post('/api/staff',{headers,data:{name:'حساب أزرار اختبار',email,password:oldPassword,accessScope:'warehouse'}});
 expect(created.status(),await created.text()).toBe(201);
 await page.getByRole('button',{name:'حسابات المكتب',exact:true}).click();
 const row=page.locator('.staff-row').filter({hasText:email});await row.getByRole('button',{name:'كلمة مرور جديدة'}).click();
 const form=page.locator('form.panel').filter({has:page.getByLabel('كلمة المرور الجديدة')});
 await form.getByLabel('كلمة المرور الجديدة').fill(newPassword);await form.getByRole('button',{name:'حفظ كلمة المرور'}).click();
 await expect(page.locator('.ok-text[role=status]')).toContainText('تم تحديث حساب');
 const api=await request.newContext({baseURL:E2E_API});
 const login=(password:string)=>api.post('/api/auth/login',{data:{email,password}});
 expect((await login(oldPassword)).status()).toBe(401);expect((await login(newPassword)).status()).toBe(200);
 await row.getByRole('button',{name:'إيقاف الحساب'}).click();await expect(row).toContainText('موقوف');
 expect((await login(newPassword)).status()).toBe(401);
 await row.getByRole('button',{name:'تفعيل الحساب'}).click();await expect(row).toContainText('شغال');
 expect((await login(newPassword)).status()).toBe(200);await api.dispose();
});

test('تغيير الشهر بسرعة لا يعرض أرقام شهر قديم تحت الشهر الجديد',async({page})=>{
 await signInAsManager(page);await page.getByRole('button',{name:'السجل الشهري',exact:true}).click();
 const select=page.getByLabel('الشهر');await expect(page.getByRole('button',{name:'تحديث',exact:true})).toBeEnabled();
 const months=await select.locator('option').evaluateAll(options=>options.map(o=>(o as HTMLOptionElement).value));
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>started=r);
 await page.route('**/api/monthly?*',async route=>{
   const month=new URL(route.request().url()).searchParams.get('month');
   if(month===months[1]){const response=await route.fetch();started();await gate;await route.fulfill({response});}
   else await route.continue();
 });
 await select.selectOption(months[1]);await waiting;await select.selectOption(months[2]);
 await expect(page.getByRole('heading',{name:new RegExp(`سجل ${months[2]}`)})).toBeVisible();
 release();await page.waitForTimeout(300);
 await expect(page.getByRole('heading',{name:new RegExp(`سجل ${months[2]}`)})).toBeVisible();
 await expect(page.getByText(new RegExp(`البيانات حتى ${months[2]}`))).toBeVisible();
 await page.unroute('**/api/monthly?*');
 await page.route('**/api/monthly?*',route=>route.abort());await select.selectOption(months[3]);
 await expect(page.getByRole('alert')).toBeVisible();await expect(page.locator('.stats')).toHaveCount(0);
});

test('تغيير فترة المؤشرات بسرعة لا يستبدلها برد قديم',async({page})=>{
 await signInAsManager(page);await page.getByRole('button',{name:'مؤشرات التأثير',exact:true}).click();
 await expect(page.getByRole('button',{name:'تحديث',exact:true})).toBeEnabled();
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>started=r);
 let count=0;
 await page.route('**/api/kpis?*',async route=>{
  if(++count===1){const response=await route.fetch();started();await gate;const json=await response.json();json.rows=json.rows.map((r:any)=>({...r,name:'رد قديم لا يجب عرضه'}));await route.fulfill({response,json});}
  else await route.continue();
 });
 await page.getByRole('button',{name:'اليوم',exact:true}).click();await waiting;
 await page.getByRole('button',{name:'٣٠ يوم',exact:true}).click();
 await expect(page.getByRole('button',{name:'تحديث',exact:true})).toBeEnabled();
 release();await page.waitForTimeout(300);await expect(page.getByText('رد قديم لا يجب عرضه')).toHaveCount(0);
 await page.unroute('**/api/kpis?*');await page.route('**/api/kpis?*',route=>route.abort());
 await page.getByRole('button',{name:'٧ أيام',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();await expect(page.locator('.stats')).toHaveCount(0);
});

test('بحث الأصناف يتجاهل الرد القديم ولا يعرض قائمة قديمة عند فشل التحميل',async({page})=>{
 await signInAsManager(page);await page.getByRole('button',{name:'المبيعات',exact:true}).click();
 await page.getByRole('button',{name:'تعديل الأسعار'}).click();await page.getByRole('button',{name:'إدارة الأصناف وأنواع الأسعار'}).click();
 await expect(page.locator('.panel.filters').getByRole('button',{name:'تحديث',exact:true})).toBeEnabled();
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>started=r);
 await page.route('**/api/products?*',async route=>{
  const q=new URL(route.request().url()).searchParams.get('q');
  if(q==='قديم'){const response=await route.fetch();started();await gate;const json=await response.json();json.products=[{id:'old',name:'نتيجة قديمة غلط',category:'other',unit:'عبوة',unitSize:'',notes:'',active:true,prices:[]}];await route.fulfill({response,json});}
  else await route.continue();
 });
 const search=page.getByLabel('بحث',{exact:true});await search.fill('قديم');await waiting;await search.fill('جديدغيرموجود');
 await expect(page.getByText('مفيش أصناف بالفلاتر دي', {exact:false})).toBeVisible();
 release();await page.waitForTimeout(300);await expect(page.getByText('نتيجة قديمة غلط')).toHaveCount(0);
 await page.unroute('**/api/products?*');await page.route('**/api/products?*',route=>route.abort());
 await search.fill('فشل');await expect(page.getByRole('alert').first()).toBeVisible();await expect(page.locator('.products-table')).toHaveCount(0);
});
