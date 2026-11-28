import { test, expect } from '@playwright/test';
import { E2E_API, E2E_REPS, E2E_REP_PASSWORD } from './fixtures';

test('تغيير الحساب في تبويب آخر يغلق الشاشة القديمة دون إرسال عمليات بحساب مختلف', async ({page, context}) => {
 await page.setViewportSize({width:420,height:850});
 const login = async (p: typeof page, email:string) => {
   await p.goto(`${E2E_API}/app/`);
   await p.getByPlaceholder('rep@company.com').fill(email);
   await p.getByPlaceholder('••••••••').fill(E2E_REP_PASSWORD);
   await p.getByRole('button',{name:'دخول',exact:true}).click();
   await expect(p.getByRole('button',{name:'تسجيل طلبية'})).toBeVisible();
 };
 await login(page,E2E_REPS[0].email);
 const oldToken=await page.evaluate(()=>localStorage.getItem('mandoub_token'));
 const other=await context.newPage();
 // A second tab already shares A's session; log in as B through the API and replace its token,
 // equivalent to B signing in on this origin, without touching test fixture shifts.
 await other.goto(`${E2E_API}/app/`);
 const response=await other.request.post(`${E2E_API}/api/auth/login`,{data:{email:E2E_REPS[1].email,password:E2E_REP_PASSWORD}});
 expect(response.ok()).toBeTruthy(); const token=(await response.json()).token;
 expect(token).not.toBe(oldToken);
 await other.evaluate(t=>localStorage.setItem('mandoub_token',t),token);
 await expect(page.getByPlaceholder('rep@company.com')).toBeVisible();
 expect(await other.evaluate(()=>localStorage.getItem('mandoub_token'))).toBe(token);
 await page.close(); await other.close();
});

test('زيارة محفوظة بلا شبكة تظهر ويمكن تسجيل نتيجتها دون إنشاء زيارة ثانية', async ({page,context}) => {
 await context.grantPermissions(['geolocation'], {origin:E2E_API});
 await context.setGeolocation({latitude:31.2,longitude:29.9,accuracy:8});
 await page.setViewportSize({width:420,height:850}); await page.goto(`${E2E_API}/app/`);
 await page.getByPlaceholder('rep@company.com').fill(E2E_REPS[0].email);
 await page.getByPlaceholder('••••••••').fill(E2E_REP_PASSWORD);
 await page.getByRole('button',{name:'دخول',exact:true}).click();
 await expect(page.getByRole('button',{name:'تسجيل طلبية'})).toBeVisible();
 const token=await page.evaluate(()=>localStorage.getItem('mandoub_token'));
 const headers={Authorization:`Bearer ${token}`};
 const user=(await (await page.request.get(`${E2E_API}/api/auth/me`,{headers})).json()).user;
 const customer=(await (await page.request.get(`${E2E_API}/api/customers`,{headers})).json()).customers[0];
 const visit={id:crypto.randomUUID(), customerId:customer.id,purpose:'visit',notes:'',location:{lat:31.2,lng:29.9,accuracy:8},recordedAt:Date.now()};
 await page.route('**/api/visits/check-in',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
 await page.evaluate(({visit,userId})=>{
   localStorage.setItem('mandoub_outbox_owner',userId);
   localStorage.setItem('mandoub.outbox',JSON.stringify([{key:visit.id,kind:'visit-checkin',payload:JSON.stringify(visit),createdAt:Date.now(),attempts:0,rejected:false}]));
 },{visit,userId:user.id});
 await page.reload();
 await page.getByRole('tab',{name:'الزيارات'}).click();
 await expect(page.getByText('الزيارة محفوظة على الهاتف وتنتظر المزامنة.')).toBeVisible();
 await expect(page.getByRole('button',{name:'+ تسجيل زيارة جديدة'})).toHaveCount(0);
 await page.getByRole('button',{name:'إنهاء وتسجيل النتيجة'}).click();
 await page.getByPlaceholder('اتفقنا على توريد ٢٠ كرتونة الأسبوع القادم').fill('تمت الزيارة بنجاح');
 await page.getByRole('button',{name:'إنهاء الزيارة وإرسال النتيجة'}).click();
 await expect.poll(async()=>page.evaluate(()=>JSON.parse(localStorage.getItem('mandoub.outbox')||'[]').filter((x:{kind:string})=>x.kind==='visit-checkout').length)).toBe(1);
 await expect(page.getByRole('button',{name:'+ تسجيل زيارة جديدة'})).toBeDisabled();
 const rows=await page.evaluate(()=>JSON.parse(localStorage.getItem('mandoub.outbox')||'[]'));
 expect(rows.some((x:{kind:string})=>x.kind==='visit-checkin')).toBe(true);
});
