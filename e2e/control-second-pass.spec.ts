import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {signInAsManager} from './helpers';
import {E2E_API,E2E_REPS,E2E_REP_PASSWORD} from './fixtures';

test('بحث العملاء لا يعرض صفحة قديمة أو نتائج مضللة عند تعذر التحديث',async({page})=>{
 await signInAsManager(page);await page.getByRole('button',{name:'العملاء',exact:true}).click();
 await expect(page.locator('.customers-table')).toBeVisible();
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>started=r);
 await page.route('**/api/customers?*',async route=>{
  if(new URL(route.request().url()).searchParams.get('q')==='قديم'){const response=await route.fetch();started();await gate;const json=await response.json();json.customers=[{id:'old',name:'عميل من بحث قديم',active:true,stage:'new',visitCount:0,openVisits:0}];await route.fulfill({response,json});}
  else await route.continue();
 });
 const search=page.getByLabel('بحث',{exact:true});await search.fill('قديم');await waiting;
 await search.fill('جديدغيرموجود');await expect(page.getByText('مفيش عملاء مطابقين للبحث.')).toBeVisible();
 release();await page.waitForTimeout(300);await expect(page.getByText('عميل من بحث قديم')).toHaveCount(0);
 await page.unroute('**/api/customers?*');await page.route('**/api/customers?*',route=>route.abort());
 await search.fill('فشل');await expect(page.getByRole('alert')).toBeVisible();await expect(page.locator('.customers-table')).toHaveCount(0);await expect(page.getByText('مفيش عملاء مطابقين للبحث.')).toHaveCount(0);
});

test('إضافة عميل تنجح وتظهر النتيجة حتى لو تحديث القائمة فشل',async({page})=>{
 await signInAsManager(page);await page.getByRole('button',{name:'العملاء',exact:true}).click();
 await expect(page.locator('.customers-table')).toBeVisible();const name=`عميل فحص التحديث ${Date.now()}`;
 await page.getByRole('button',{name:'عميل جديد'}).click();const form=page.locator('form.panel');
 await form.getByLabel('اسم العميل / المزرعة').fill(name);
 await page.route('**/api/customers?*',route=>route.abort());await form.getByRole('button',{name:'حفظ',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'العميل اتضاف'})).toBeVisible();await expect(page.getByRole('alert')).toContainText('تعذر تحميل قائمة العملاء');
 await page.unroute('**/api/customers?*');const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const res=await page.request.get(`/api/customers?q=${encodeURIComponent(name)}`,{headers:{'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'}});
 expect((await res.json()).customers.filter((c:{name:string})=>c.name===name)).toHaveLength(1);
});

test('فشل تحميل الطلبيات بعد تغيير الفلتر لا يعرض طلبية قديمة تحت الفلتر الجديد',async({page})=>{
 await signInAsManager(page);await page.locator('button.nav-item').filter({hasText:'الزيارات والطلبيات'}).click();await page.getByRole('tab',{name:/الطلبيات/}).click();
 await expect(page.locator('.order-card').first()).toBeVisible();await page.route('**/api/orders?*',route=>route.abort());
 await page.locator('.orders-panel').getByRole('tab',{name:'الكل'}).click();await expect(page.locator('.orders-panel').getByRole('alert')).toBeVisible();
 await expect(page.locator('.order-card')).toHaveCount(0);await expect(page.getByText('مفيش طلبيات مسجلة لحد دلوقتي.')).toHaveCount(0);
 await page.unroute('**/api/orders?*');await page.locator('.orders-panel').getByRole('button',{name:'حاول تاني'}).click();await expect(page.locator('.order-card').first()).toBeVisible();
});

test('المهندس ينهي الزيارة بدون خانة تحصيل ولا يقدر يسجل دفعة',async({page})=>{
 const admin={Authorization:`Bearer ${process.env.E2E_ADMIN_TOKEN!}`};
 const auth=await page.request.post(`${E2E_API}/api/auth/login`,{data:{email:E2E_REPS[2].email,password:E2E_REP_PASSWORD}});expect(auth.ok()).toBeTruthy();
 const {token,user}=await auth.json();const rep={Authorization:`Bearer ${token}`};
 const customer=await page.request.post(`${E2E_API}/api/customers`,{headers:admin,data:{name:`عميل زيارة ${Date.now()}`,repId:user.id}});expect(customer.ok(),await customer.text()).toBeTruthy();
 const customerId=(await customer.json()).customer.id;
 const visit=await page.request.post(`${E2E_API}/api/visits/check-in`,{headers:rep,data:{id:randomUUID(),customerId,purpose:'visit',location:{lat:31.2,lng:29.91,accuracy:12}}});expect(visit.ok(),await visit.text()).toBeTruthy();
 await page.setViewportSize({width:420,height:850});await page.context().grantPermissions(['geolocation'],{origin:E2E_API});await page.context().setGeolocation({latitude:31.2,longitude:29.91,accuracy:12});
 await page.goto(`${E2E_API}/app/`);await page.getByPlaceholder('rep@company.com').fill(E2E_REPS[2].email);await page.getByPlaceholder('••••••••').fill(E2E_REP_PASSWORD);await page.getByRole('button',{name:'دخول',exact:true}).click();
 await page.getByRole('button',{name:'إنهاء الزيارة',exact:true}).click();
 await page.getByPlaceholder('اتفقنا على توريد ٢٠ كرتونة الأسبوع القادم').fill('تمت المتابعة');
 await expect(page.locator('input[inputmode="decimal"]')).toHaveCount(0);
 const response=page.waitForResponse(r=>r.url().includes('/check-out')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'إنهاء الزيارة وإرسال النتيجة'}).click();const done=await response;expect(done.ok(),await done.text()).toBeTruthy();expect(done.request().postDataJSON().amount).toBeNull();
});

test('أزرار الترشيح وقائمة الأصناف على واجهة المهندس تستجيب وتحمي الخانات المطلوبة',async({page})=>{
 await page.setViewportSize({width:320,height:780});await page.goto(`${E2E_API}/app/`);
 await page.getByPlaceholder('rep@company.com').fill(E2E_REPS[1].email);await page.getByPlaceholder('••••••••').fill(E2E_REP_PASSWORD);await page.getByRole('button',{name:'دخول',exact:true}).click();
 await page.getByRole('button',{name:'تسجيل طلبية'}).click();
 await page.getByRole('button',{name:'ابعت الطلبية للمكتب'}).click();await expect(page.getByText('اختار العميل من قائمتك الأول', {exact:false})).toBeVisible();
 await page.getByText('مزرعة الدلتا',{exact:true}).last().click();await page.getByRole('button',{name:'ابعت الطلبية للمكتب'}).click();await expect(page.getByText('ضيف صنف واحد على الأقل', {exact:false})).toBeVisible();
 await page.getByPlaceholder('مثال: يوريا أو شيكارة').fill('يوريا');await page.getByRole('button',{name:'ضيف يوريا ٤٦٪'}).click();
 const quantity=page.getByLabel('كمية يوريا ٤٦٪');await expect(quantity).toHaveValue('1');
 await page.getByRole('button',{name:'زود يوريا ٤٦٪'}).click();await expect(quantity).toHaveValue('2');
 await page.getByRole('button',{name:'ناقص يوريا ٤٦٪'}).click();await expect(quantity).toHaveValue('1');
 await quantity.fill('٠');await page.getByRole('button',{name:/ابعت الطلبية للمكتب/}).click();await expect(page.getByText('اكتب كمية أكبر من صفر لكل صنف.')).toBeVisible();
 await page.getByRole('button',{name:'احذف يوريا ٤٦٪'}).click();await expect(quantity).toHaveCount(0);
 await page.getByRole('button',{name:'إغلاق',exact:true}).click();await page.getByRole('tab',{name:'الزيارات'}).click();
 await page.getByRole('button',{name:'قائمة الأصناف اللي بنبيعها'}).click();await page.getByPlaceholder('مثال: يوريا أو شيكارة').fill('صنف غير موجود');
 await expect(page.getByText('مفيش صنف بالاسم ده في القائمة')).toBeVisible();await page.getByRole('button',{name:'إغلاق',exact:true}).click();
});
