import {test,expect} from '@playwright/test';
import {signInAsManager} from './helpers';

test('إيقاف حساب المكتب ثم فشل تحديث القائمة لا يترك حالة قديمة قابلة للتعديل',async({page})=>{
 await signInAsManager(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const email=`staff-reload-${Date.now()}@test.example`;
 const create=await page.request.post('/api/staff',{headers,data:{name:'حساب اختبار تحديث',email,password:'WarehousePassword123!',accessScope:'warehouse'}});expect(create.ok(),await create.text()).toBeTruthy();
 await page.getByRole('button',{name:'حسابات المكتب',exact:true}).click();const row=page.locator('.staff-row').filter({hasText:email});await expect(row).toContainText('شغال');
 await page.route('**/api/staff',route=>route.abort());await row.getByRole('button',{name:'إيقاف الحساب'}).click();
 await expect(page.locator('.ok-text[role=status]')).toContainText('تم تحديث حساب');await expect(page.locator('p.error[role=alert]')).toContainText('القائمة ما اتحدّثتش');
 await expect(row).toHaveCount(0);await page.unroute('**/api/staff');await page.getByRole('button',{name:'إعادة تحميل الحسابات'}).click();
 await expect(row).toContainText('موقوف');await row.getByRole('button',{name:'تفعيل الحساب'}).click();await expect(row).toContainText('شغال');
});

test('فشل تحميل حسابات المكتب لا يظهر قائمة فارغة ويمكن إعادة المحاولة',async({page})=>{
 await signInAsManager(page);await page.route('**/api/staff',route=>route.abort());await page.getByRole('button',{name:'حسابات المكتب',exact:true}).click();
 await expect(page.getByRole('alert')).toBeVisible();await expect(page.locator('.staff-row')).toHaveCount(0);await expect(page.getByText('لا توجد حسابات')).toHaveCount(0);
 await page.unroute('**/api/staff');await page.getByRole('button',{name:'إعادة تحميل الحسابات'}).click();await expect(page.locator('.staff-row').first()).toBeVisible();
});

test('رد قديم لحسابات المكتب لا يعيد حالة قديمة بعد إيقاف الحساب',async({page})=>{
 await signInAsManager(page);const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};const email=`staff-race-${Date.now()}@test.example`;
 const created=await page.request.post('/api/staff',{headers,data:{name:'اختبار سباق الحسابات',email,password:'WarehousePassword123!',accessScope:'warehouse'}});expect(created.ok(),await created.text()).toBeTruthy();
 let first=true,release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>started=r);
 await page.route('**/api/staff',async route=>{if(route.request().method()!=='GET')return route.continue();if(first){first=false;const response=await route.fetch();started();await gate;await route.fulfill({response});}else await route.continue();});
 await page.getByRole('button',{name:'حسابات المكتب',exact:true}).click();await waiting;
 const row=page.locator('.staff-row').filter({hasText:email});await expect(row).toContainText('شغال');await row.getByRole('button',{name:'إيقاف الحساب'}).click();await expect(row).toContainText('موقوف');
 release();await page.waitForTimeout(350);await expect(row).toContainText('موقوف');
});
