import {test,expect} from '@playwright/test';
import {signInAsManager} from './helpers';

test('فشل تحميل الأولويات لا يظل مكتوبًا كأنه جارٍ التحميل',async({page})=>{
 await signInAsManager(page);await page.route('**/api/work-priorities',route=>route.abort());await page.getByRole('button',{name:'المساعد الذكي',exact:true}).click();
 await page.locator('summary').filter({hasText:'أولويات الشغل الحالية'}).click();const priorities=page.locator('details.panel').filter({hasText:'أولويات الشغل الحالية'});
 await expect(priorities.locator('.error')).toBeVisible();await expect(priorities.getByText('جارٍ تحميل الأولويات…')).toHaveCount(0);
 await page.unroute('**/api/work-priorities');await page.getByRole('button',{name:'تحديث التحليل'}).click();await expect(priorities.getByRole('heading',{name:'الميدان'})).toBeVisible();
});

test('تحديث الأولويات لا يستبدل النتيجة الجديدة برد قديم متأخر',async({page})=>{
 await signInAsManager(page);let release!:()=>void,started!:()=>void,fulfilled!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>started=r),delivered=new Promise<void>(r=>fulfilled=r);let first=true;
 await page.route('**/api/work-priorities',async route=>{if(first){first=false;const response=await route.fetch();started();await gate;const json=await response.json();json.waitingOrders=[{id:'old',customerName:'بيانات أولوية قديمة اختبارية',repName:'مهندس تجريبي',sentAt:Date.now()}];await route.fulfill({response,json});fulfilled();}else await route.continue();});
 await page.getByRole('button',{name:'المساعد الذكي',exact:true}).click();await waiting;await page.locator('summary').filter({hasText:'أولويات الشغل الحالية'}).click();
 await page.getByRole('button',{name:'تحديث التحليل'}).click();const priorities=page.locator('details.panel').filter({hasText:'أولويات الشغل الحالية'});await expect(priorities.getByRole('heading',{name:'الميدان'})).toBeVisible();
 release();await delivered;await page.waitForTimeout(300);await expect(priorities).not.toContainText('بيانات أولوية قديمة اختبارية');
});

test('خطأ استجابة الأولويات يظهر برسالة عربية غير مكررة',async({page})=>{
 await signInAsManager(page);await page.route('**/api/work-priorities',route=>route.fulfill({status:200,contentType:'application/json',body:'{'}));
 await page.getByRole('button',{name:'المساعد الذكي',exact:true}).click();await page.locator('summary').filter({hasText:'أولويات الشغل الحالية'}).click();
 const alert=page.locator('details.panel').filter({hasText:'أولويات الشغل الحالية'}).getByRole('alert');
 await expect(alert).toHaveText('تعذر تحميل الأولويات. حاول تاني.');
});
