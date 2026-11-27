import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { submitLogin } from './helpers';
import { E2E_ADMIN } from './fixtures';

test('مرتجع فاتورة يميز السليم عن التالف ويحدث الحساب والمخزنين مرة واحدة',async({page})=>{
 await page.goto('/');await submitLogin(page,E2E_ADMIN.email,E2E_ADMIN.password);await expect(page.getByRole('button',{name:'خروج'})).toBeVisible();
 const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const send=async(path:string,data:object)=>{const r=await page.request.post(path,{headers,data});expect(r.ok(),await r.text()).toBeTruthy();return r.json();};
 const c=(await send('/api/customers',{name:`عميل تجربة المرتجع ${Date.now()}`})).customer;
 const w=(await send('/api/warehouse/warehouses',{name:`مخزن المرتجع ${Date.now()}`})).warehouse;
 const p=(await send('/api/warehouse/products',{name:`صنف المرتجع ${Date.now()}`,category:'other',unit:'عبوة',unitSize:'١ لتر'})).product;
 await send('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:p.id,toWarehouseId:w.id,qty:10});
 const sale=randomUUID();await send('/api/sales',{id:sale,customerId:c.id,warehouseId:w.id,paid:500,lines:[{productId:p.id,qty:5,price:100}]});
 await page.getByRole('button',{name:'المبيعات',exact:true}).click();
 await page.getByRole('combobox',{name:'العميل لمراجعة الحساب'}).selectOption(c.id);
 await page.getByRole('button',{name:'عرض الحساب'}).click();
 const statement=page.getByLabel('حساب العميل');await statement.locator('summary').first().click();
 await statement.getByRole('button',{name:'تسجيل مرتجع',exact:true}).click();
 await page.getByRole('textbox',{name:`الكمية السليمة المرتجعة - ${p.name} · عبوة ١ لتر`}).fill('1');
 await page.getByRole('textbox',{name:`الكمية التالفة المرتجعة - ${p.name} · عبوة ١ لتر`}).fill('2');
 await page.getByRole('textbox',{name:'سبب التصحيح'}).fill('استلام بضاعة سليمة وتالفة');
 await page.getByRole('button',{name:'مراجعة المرتجع'}).click();
 const review=page.getByLabel('مراجعة التصحيح');await expect(review).toContainText('سليم لمخزن الفاتورة');await expect(review).toContainText('تالف لمخزن التالف');await expect(review).toContainText('٣٠٠');
 await page.getByRole('button',{name:'تأكيد المرتجع'}).click();await expect(page.getByRole('status').filter({hasText:'المرتجع اتحفظ'})).toBeVisible();
 const d=await (await page.request.get(`/api/sales/corrections/sale/${sale}`,{headers})).json();expect(d.balancePiasters).toBe(-30000);expect(d.lines[0].returned).toBe(3000);expect(d.events[0].lines[0].damaged).toBe(2000);
 const list=await (await page.request.get('/api/warehouse/warehouses',{headers})).json();const damaged=list.warehouses.find((x:{damaged:boolean})=>x.damaged);expect(damaged).toBeTruthy();
 const getQty=async(id:string)=>(await (await page.request.get(`/api/warehouse/stock?warehouseId=${id}`,{headers})).json()).stock.find((x:{id:string})=>x.id===p.id).qty;
 expect(await getQty(w.id)).toBe(6);expect(await getQty(damaged.id)).toBe(2);
 await page.getByRole('combobox',{name:'العميل لمراجعة الحساب'}).selectOption(c.id);await page.getByRole('button',{name:'عرض الحساب'}).click();await expect(statement).toContainText('رصيد لصالح العميل');
 await statement.locator('summary').first().click();await statement.getByRole('button',{name:'عرض الفاتورة'}).click();await expect(page.locator('.invoice-print')).toContainText('تالف إلى');
 // A previous financial correction can be followed by physical receipt without correcting twice.
 await send(`/api/sales/corrections/sale/${sale}`,{id:randomUUID(),reason:'تصحيح سابق قبل الاستلام',balancePiasters:d.balancePiasters,revision:d.revision,lines:[{lineId:d.lines[0].id,correctedMilli:1000,returnedMilli:0,stockKind:null}],cash:null});
 await page.getByRole('button',{name:'رجوع للحساب'}).click();await statement.locator('summary').first().click();await statement.getByRole('button',{name:'تسجيل مرتجع',exact:true}).click();
 await page.getByRole('textbox',{name:`الكمية التالفة المرتجعة - ${p.name} · عبوة ١ لتر`}).fill('1');
 await page.getByRole('textbox',{name:'سبب التصحيح'}).fill('استلام البضاعة المصححة سابقًا');
 await page.getByRole('button',{name:'مراجعة المرتجع'}).click();await expect(page.getByRole('alert')).toContainText('أو اكتب صفر');
 await page.getByRole('textbox',{name:`من المرتجع الحالي: كمية صُححت ماليًا سابقًا ولم يُسجّل استلامها - ${p.name} · عبوة ١ لتر`}).fill('1');
 await page.getByRole('button',{name:'مراجعة المرتجع'}).click();await expect(review).toContainText('قيمة تخفيض البيعة: ٠');
 let intercepted=0;await page.route(`**/api/sales/corrections/sale/${sale}`,async route=>{if(route.request().method()!=='POST')return route.continue();intercepted++;await route.fetch();await route.abort('failed');});
 await page.getByRole('button',{name:'تأكيد المرتجع'}).click();await expect(page.getByRole('heading',{name:'عملية محتاجة تأكيد'})).toBeVisible();await expect(page.getByRole('alert')).toBeVisible();
 await page.unroute(`**/api/sales/corrections/sale/${sale}`);await page.getByRole('button',{name:'تأكيد العملية'}).click();await expect(page.getByRole('status').filter({hasText:'اتأكدنا من العملية'})).toBeVisible();expect(intercepted).toBe(1);
 const after=await (await page.request.get(`/api/sales/corrections/sale/${sale}`,{headers})).json();expect(after.balancePiasters).toBe(-40000);expect(after.lines[0].returned).toBe(4000);expect(await getQty(damaged.id)).toBe(3);
});

test('رد نجاح غير مؤكد لا يمسح طلب المرتجع ولا يكرره عند المحاولة',async({page})=>{
 await page.goto('/');await submitLogin(page,E2E_ADMIN.email,E2E_ADMIN.password);await expect(page.getByRole('button',{name:'خروج'})).toBeVisible();
 const token=await page.evaluate(()=>localStorage.getItem('mandoub.token'));
 const headers={'X-Mandoub-Token':token!,'X-Mandoub-Client':'admin'};
 const send=async(path:string,data:object)=>{const r=await page.request.post(path,{headers,data});expect(r.ok(),await r.text()).toBeTruthy();return r.json();};
 const c=(await send('/api/customers',{name:`عميل تأكيد مرتجع ${Date.now()}`})).customer;
 const w=(await send('/api/warehouse/warehouses',{name:`مخزن تأكيد مرتجع ${Date.now()}`})).warehouse;
 const p=(await send('/api/warehouse/products',{name:`صنف تأكيد مرتجع ${Date.now()}`,category:'other',unit:'عبوة'})).product;
 await send('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:p.id,toWarehouseId:w.id,qty:5});
 const sale=randomUUID();await send('/api/sales',{id:sale,customerId:c.id,warehouseId:w.id,paid:0,lines:[{productId:p.id,qty:2,price:10}]});
 const path=`/api/sales/corrections/sale/${sale}`;
 await page.getByRole('button',{name:'المبيعات',exact:true}).click();
 const openReturn=async()=>{
  await page.getByRole('combobox',{name:'العميل لمراجعة الحساب'}).selectOption(c.id);await page.getByRole('button',{name:'عرض الحساب'}).click();
  const statement=page.getByLabel('حساب العميل');await statement.locator('summary').first().click();await statement.getByRole('button',{name:'تسجيل مرتجع',exact:true}).click();
  await expect(page.getByText(`مخزن الفاتورة (وجهة السليم):`,{exact:false})).toContainText(w.name);
 };
 await openReturn();
 for(const [iteration,response] of [['1','{"ok":true}'],['2','<html>proxy</html>']] as const){
  await page.getByRole('textbox',{name:`الكمية التالفة المرتجعة - ${p.name} · عبوة`}).fill('1');
  await page.getByRole('textbox',{name:'سبب التصحيح'}).fill('استلام مرتجع تالف');await page.getByRole('button',{name:'مراجعة المرتجع'}).click();
  await expect(page.getByLabel('مراجعة التصحيح')).toContainText('تالف لمخزن التالف');
  await expect(page.getByLabel('مراجعة التصحيح')).not.toContainText('سليم لمخزن الفاتورة');
  let sentId='';await page.route(`**${path}`,async route=>{
   if(route.request().method()!=='POST')return route.continue();
   sentId=route.request().postDataJSON().id;const r=await route.fetch();expect(r.status()).toBe(201);
   await route.fulfill({status:200,contentType:iteration==='1'?'application/json':'text/html',body:response});
  });
  await page.getByRole('button',{name:'تأكيد المرتجع'}).click();
  await expect(page.getByRole('alert')).toContainText('تعذر التأكد');await expect(page.getByRole('heading',{name:'عملية محتاجة تأكيد'})).toBeVisible();
  const pending=await page.evaluate(()=>Object.entries(localStorage).find(([k])=>k.startsWith('mandoub.sales.pending.'))?.[1]);expect(JSON.parse(pending!).body.id).toBe(sentId);
  await page.unroute(`**${path}`);await page.getByRole('button',{name:'تأكيد العملية'}).click();await expect(page.getByRole('status').filter({hasText:'اتأكدنا من العملية'})).toBeVisible();
  const detail=await (await page.request.get(path,{headers})).json();expect(detail.revision).toBe(Number(iteration));expect(detail.events.filter((e:{id:string})=>e.id===sentId)).toHaveLength(1);
  if(iteration==='1')await openReturn();
 }
 const detail=await (await page.request.get(path,{headers})).json();expect(detail.balancePiasters).toBe(0);expect(detail.lines[0].returned).toBe(2000);
 await page.getByRole('combobox',{name:'العميل لمراجعة الحساب'}).selectOption(c.id);await page.getByRole('button',{name:'عرض الحساب'}).click();
 const statement=page.getByLabel('حساب العميل');await statement.locator('summary').first().click();await statement.getByRole('button',{name:'عرض الفاتورة'}).click();
 const invoice=page.locator('.invoice-print');await expect(invoice).toContainText('تالف إلى');await expect(invoice).not.toContainText('رجعت لمخزن الفاتورة: ٠');
});
