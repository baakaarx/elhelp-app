import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { E2E_ADMIN, E2E_API } from './fixtures';

test('النقاط المرفوضة تبقى على الهاتف مع تنبيه والمزامنة لا تحجب النقاط السليمة',async({page})=>{
 const login=await page.request.post(`${E2E_API}/api/auth/login`,{data:E2E_ADMIN});expect(login.ok()).toBeTruthy();
 const admin=(await login.json()).token;
 const email=`gps-replay-${Date.now()}@test.example`,password='RepPassword123!';
 const rep=await page.request.post(`${E2E_API}/api/reps`,{headers:{Authorization:`Bearer ${admin}`},data:{name:'مهندس مزامنة الموقع',email,password,region:'الإسكندرية'}});expect(rep.status()).toBe(201);const user=(await rep.json()).user;
 await page.setViewportSize({width:420,height:850});await page.goto(`${E2E_API}/app/`);
 await page.getByPlaceholder('rep@company.com').fill(email);await page.getByPlaceholder('••••••••').fill(password);await page.getByRole('button',{name:'دخول',exact:true}).click();
 await expect(page.getByRole('button',{name:'تسجيل طلبية'})).toBeVisible();
 const token=await page.evaluate(()=>localStorage.getItem('mandoub_token'));
 const started=await page.request.post(`${E2E_API}/api/shifts/start`,{headers:{Authorization:`Bearer ${token}`},data:{consentVersion:'1.0',deviceId:'gps-replay-test',location:{lat:31.2,lng:29.9,accuracy:8}}});expect(started.status()).toBe(200);const shift=(await started.json()).shift;
 const good=randomUUID(),bad=randomUUID(),now=Date.now();
 await page.evaluate(({good,bad,now,shiftId,userId})=>{
  const point=(id:string,recordedAt:number)=>({id,shiftId,lat:31.2,lng:29.9,accuracy:8,speed:null,heading:null,battery:null,recordedAt});
  const rows=[point(bad,now-2*86400000),point(good,now)].map((p,i)=>({key:p.id,kind:'location',payload:JSON.stringify(p),createdAt:now+i,attempts:0,rejected:false}));
  localStorage.setItem('mandoub.outbox',JSON.stringify(rows));localStorage.setItem('mandoub_outbox_owner',userId);localStorage.setItem('mandoub_active_user',userId);
  localStorage.setItem('mandoub_gps_save_warning','1');
 },{good,bad,now,shiftId:shift.id,userId:user.id});
 await page.reload();
 await expect(page.getByText(/تعذر حفظ بعض نقاط الموقع على الهاتف/).first()).toBeVisible();
 await expect(page.getByText(/نقطة موقع محفوظة على الهاتف لم يقبلها السيرفر/).first()).toBeVisible({timeout:15000});
 await expect.poll(async()=>page.evaluate(()=>JSON.parse(localStorage.getItem('mandoub.outbox')||'[]'))).toEqual([expect.objectContaining({key:bad,rejected:true})]);
 await page.reload();await expect(page.getByText(/نقطة موقع محفوظة على الهاتف لم يقبلها السيرفر/).first()).toBeVisible({timeout:15000});
 await page.getByRole('tab',{name:'حسابي'}).click();await page.getByRole('button',{name:'فهمت أن المسار قد يكون ناقصًا'}).click();
 await expect(page.getByText(/تعذر حفظ بعض نقاط الموقع على الهاتف/)).toHaveCount(0);await expect(page.getByText(/نقطة موقع محفوظة على الهاتف لم يقبلها السيرفر/).first()).toBeVisible();
 await page.getByRole('button',{name:'مزامنة الآن'}).click();
 await expect.poll(async()=>page.evaluate((id)=>JSON.parse(localStorage.getItem('mandoub.outbox')||'[]').find((x:{key:string})=>x.key===id)?.attempts,bad)).toBeGreaterThan(1);
});
