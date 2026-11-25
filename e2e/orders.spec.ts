import { test, expect } from '@playwright/test';
import { signInAsManager } from './helpers';

test('الطلبية توصية كميات فقط ولا يمكن تسعيرها من شاشة الطلبيات أو من الرابط القديم',async({page})=>{
 await signInAsManager(page);
 const nav=page.locator('button.nav-item').filter({hasText:'الزيارات والطلبيات'});
 await expect(nav.locator('em.badge')).toHaveText('١');await nav.click();await page.getByRole('tab',{name:/الطلبيات/}).click();
 const card=page.locator('.order-card').filter({hasText:'عميل اختبار الطلبية'});
 await expect(card).toContainText('مستنية فاتورة');await expect(card).toContainText('يوريا ٤٦٪');await expect(card).toContainText('أحمد حسن');
 await expect(card).toContainText('ترشيح ٢');await expect(page.getByRole('button',{name:/تسعير/})).toHaveCount(0);await expect(page.locator('.orders-panel input')).toHaveCount(0);
 const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const orders=await (await page.request.get('/api/orders?status=sent',{headers})).json();const order=orders.orders.find((o:{customerName:string})=>o.customerName==='عميل اختبار الطلبية');
 expect(order.lines[0]).not.toHaveProperty('price');expect(order.lines[0]).not.toHaveProperty('suggestedPrice');
 const result=await page.request.post(`/api/orders/${order.id}/price`,{headers,data:{lines:[{productId:order.lines[0].productId,price:1}]}});expect(result.status()).toBe(410);
 await page.setViewportSize({width:390,height:844});const size=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));expect(size.scroll).toBeLessThanOrEqual(size.width+1);
});
