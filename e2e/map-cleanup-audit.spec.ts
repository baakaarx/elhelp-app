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
