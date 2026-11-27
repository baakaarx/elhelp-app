import {test,expect} from '@playwright/test';
import {signInAsManager} from './helpers';

test('الانتقال السريع من الخريطة لا يترك مؤقتًا يستخدم خريطة أُغلقت',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.stack || e.message));await signInAsManager(page);
 for(let i=0;i<4;i++){
  await expect(page.getByRole('application',{name:'خريطة مواقع المهندسين'})).toBeVisible();
  await page.getByRole('button',{name:'العملاء',exact:true}).click();await page.getByRole('button',{name:/مركز العمليات/}).click();
 }
 await page.getByRole('button',{name:'العملاء',exact:true}).click();await page.waitForTimeout(400);expect(errors).toEqual([]);
});

test('الخريطة تقلل تذبذب الثبات وتعرض آخر دقة مع إمكانية رؤية القراءات الخام',async({page})=>{
 const now=Date.now();
 await page.route('**/api/reps/*/route**',async r=>{
  const points=[0,18,-20,15].map((meters,i)=>({id:`gps-${i}`,shiftId:'shift',lat:31.2+meters/111195,lng:29.9,accuracy:25,speed:null,heading:null,battery:null,recordedAt:now+i*30000,receivedAt:now+i*30000,source:'gps'}));
  await r.fulfill({json:{date:'2026-01-01',timezone:'Africa/Cairo',points,pointCount:4,sampled:false,truncated:false,distanceMeters:0}});
 });
 await signInAsManager(page);
 await page.getByRole('button',{name:/أحمد حسن/}).first().click();
 const map=page.getByRole('application',{name:'خريطة مواقع المهندسين'});
 await expect(page.getByText('مسار تقريبي؛ الحركة الصغيرة قد لا تظهر')).toBeVisible();
 await expect(map.locator('path.route-line')).toHaveCount(0);
 await expect(map.locator('.pin-head')).toBeVisible();
 await map.locator('.pin-head').hover();await expect(page.getByText('دقة الإشارة ±25 م')).toBeVisible();
 await page.getByRole('button',{name:'عرض القراءات الخام'}).click();
 await expect(page.getByText('قراءات خام؛ ليست دليلًا على الحركة')).toBeVisible();
 await expect(map.locator('path.route-line')).toHaveCount(1);
 await page.getByRole('button',{name:'عرض تقريبي'}).click();await expect(map.locator('path.route-line')).toHaveCount(0);
});
