import {test,expect} from '@playwright/test';
import {signInAsManager} from './helpers';

test('ترتيب نوع السعر يقبل الأرقام العربية ولا يحوّل الخانة الفاضية لصفر',async({page})=>{
 await signInAsManager(page);await page.getByRole('button',{name:'المبيعات',exact:true}).click();await page.getByRole('button',{name:'تعديل الأسعار'}).click();await page.getByRole('button',{name:'إدارة الأصناف وأنواع الأسعار'}).click();
 const panel=page.locator('.panel').filter({has:page.getByRole('heading',{name:/أنواع المشترين/})});const name=`نوع ترتيب ${Date.now()}`;
 await panel.getByLabel('نوع جديد').fill(name);await panel.getByLabel('ترتيبه (اختياري)').fill('٣');await panel.getByRole('button',{name:'ضيف',exact:true}).click();
 const row=page.locator('.tiers-table tr').filter({hasText:name});await expect(row).toBeVisible();await expect(row.locator('td').nth(1)).toHaveText('٣');
 await row.getByRole('button',{name:'تعديل'}).click();let edit=page.locator('.tiers-table tr').filter({has:page.getByLabel('ترتيب النوع')});await edit.getByLabel('ترتيب النوع').fill('');await edit.getByRole('button',{name:'احفظ'}).click();await expect(row.locator('td').nth(1)).toHaveText('٣');
 await row.getByRole('button',{name:'تعديل'}).click();edit=page.locator('.tiers-table tr').filter({has:page.getByLabel('ترتيب النوع')});await edit.getByLabel('ترتيب النوع').fill('2.5');await edit.getByRole('button',{name:'احفظ'}).click();
 await expect(panel.getByRole('alert')).toContainText('عدد صحيح');await expect(edit.getByLabel('ترتيب النوع')).toHaveValue('2.5');await edit.getByLabel('ترتيب النوع').fill('١٢');await edit.getByRole('button',{name:'احفظ'}).click();await expect(row.locator('td').nth(1)).toHaveText('١٢');
});

test('تعذر تحميل سجل الزيارات لا يظهر كأنه سجل فارغ ويمكن إعادة المحاولة',async({page})=>{
 await signInAsManager(page);await page.route('**/api/visits',route=>route.abort());
 await page.locator('button.nav-item').filter({hasText:'الزيارات والطلبيات'}).click();
 await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByText('لا توجد زيارات بهذه الفلاتر بعد.')).toHaveCount(0);
 await page.unroute('**/api/visits');await page.getByRole('button',{name:'إعادة تحميل الزيارات'}).click();await expect(page.locator('.report').first()).toBeVisible();
});

test('تغيير منطقة وكلمة مرور مهندس يظهر نتيجة الحفظ في موضعها',async({page})=>{
 await page.setViewportSize({width:390,height:844});await signInAsManager(page);
 const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const email=`field-controls-${Date.now()}@test.example`, password='FieldPassword123!',newPassword='FieldNewPassword123!';
 const response=await page.request.post('/api/reps',{headers,data:{name:'مهندس فحص النتيجة',email,password,region:'منطقة البداية'}});expect(response.status(),await response.text()).toBe(201);
 await page.getByRole('button',{name:'فريق الميدان',exact:true}).click();const row=page.locator('.team-row').filter({hasText:'مهندس فحص النتيجة'});await row.getByRole('button',{name:'تعديل المنطقة'}).click();
 await page.getByLabel('المنطقة الجديدة').fill('منطقة جديدة');await page.getByRole('button',{name:'حفظ المنطقة'}).click();
 await expect(page.getByRole('status').filter({hasText:'تم تحديث منطقة'})).toBeInViewport();await expect(row).toContainText('منطقة جديدة');
 await row.getByRole('button',{name:'كلمة المرور'}).click();const panel=page.locator('.panel').filter({has:page.getByRole('heading',{name:'كلمة مرور جديدة لـ مهندس فحص النتيجة'})});
 await panel.getByLabel('كلمة المرور').fill(newPassword);await panel.getByRole('button',{name:'حفظ',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'تم تغيير كلمة مرور'})).toBeInViewport();
 const login=await page.request.post('/api/auth/login',{data:{email,password:newPassword}});expect(login.ok(),await login.text()).toBeTruthy();
});
