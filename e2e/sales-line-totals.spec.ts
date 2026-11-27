import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {signInAsManager} from './helpers';

test('الفاتورة توضح وحدة الصنف وحجمه وتنبه لتكرار الصنف',async({page})=>{
 await signInAsManager(page);
 const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const send=async(path:string,data:object)=>{const r=await page.request.post(path,{headers,data});expect(r.ok(),await r.text()).toBeTruthy();return r.json();};
 const customer=(await send('/api/customers',{name:`عميل حساب سطور ${Date.now()}`})).customer;
 const warehouse=(await send('/api/warehouse/warehouses',{name:`مخزن حساب سطور ${Date.now()}`})).warehouse;
 const productId=(await send('/api/warehouse/stock-items',{id:randomUUID(),warehouseId:warehouse.id,product:{name:`مبيد حساب سطور ${Date.now()}`,category:'other',unit:'عبوة',unitSize:'١ لتر'},qty:500})).productId;
 const sackId=(await send('/api/warehouse/stock-items',{id:randomUUID(),warehouseId:warehouse.id,product:{name:`سماد حساب سطور ${Date.now()}`,category:'other',unit:'شكارة',unitSize:'٥٠ كجم'},qty:500})).productId;
 await page.getByRole('button',{name:'المبيعات',exact:true}).click();await page.getByRole('button',{name:'تسجيل فاتورة',exact:true}).click();
 const form=page.locator('form').filter({has:page.getByRole('heading',{name:'تسجيل فاتورة'})});
 await form.getByRole('combobox',{name:'العميل',exact:true}).selectOption(customer.id);await form.getByRole('combobox',{name:'المخزن',exact:true}).selectOption(warehouse.id);await form.getByRole('combobox',{name:'المهندس المسؤول'}).selectOption('none');
 for(const [index,qty] of ['100','5','10','200'].entries()){
  if(index) await form.getByRole('button',{name:'إضافة صنف'}).click();
  await form.locator('select').filter({has:page.locator(`option[value="${productId}"]`)}).nth(index).selectOption(productId);
  await form.getByLabel('الكمية',{exact:true}).nth(index).fill(qty);await form.getByLabel('سعر الوحدة (ج.م)').nth(index).fill('100');
 }
 await expect(form.locator('.sale-unit')).toHaveText(Array(4).fill('وحدة الكمية: عبوة · حجم الوحدة: ١ لتر'));
 await expect(form).toContainText('الإجمالي: ٣١٬٥٠٠ ج.م');await expect(form.getByRole('alert')).toContainText('الصنف نفسه مكرر');
 await form.getByLabel('المدفوع دلوقتي (ج.م)').fill('0');await form.getByRole('button',{name:'مراجعة الفاتورة'}).click();await expect(page.getByRole('heading',{name:'راجع البيانات قبل الحفظ'})).toHaveCount(0);
 for(let n=0;n<3;n++) await form.getByRole('button',{name:'إزالة الصنف'}).last().click();
 await expect(form.getByRole('alert')).toHaveCount(0);await expect(form).toContainText('الإجمالي: ١٠٬٠٠٠ ج.م');
 await form.getByRole('combobox',{name:'الصنف ١'}).selectOption(sackId);
 await form.getByLabel('سعر الوحدة (ج.م)').fill('100');
 await expect(form.locator('.sale-unit')).toHaveText('وحدة الكمية: شكارة · حجم الوحدة: ٥٠ كجم');
 await form.getByRole('button',{name:'مراجعة الفاتورة'}).click();await expect(page.getByLabel('مراجعة العملية')).toContainText('١٠٠ شكارة ٥٠ كجم');await expect(page.getByLabel('مراجعة العملية')).toContainText('١٠٬٠٠٠ ج.م');
});
