import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createApp} from '../src/app.js';

const instance=createApp({dbPath:':memory:',production:false,timezone:'Africa/Cairo',adminEmail:'invoice@test.local',adminPassword:'AdminPassword123!',loginAccountLimit:500,loginRateLimit:{windowMs:60000,limit:5000}});
const client=request(instance.app);test.after(async()=>await instance.close());
const login=await client.post('/api/auth/login').send({email:'invoice@test.local',password:'AdminPassword123!'});const auth={Authorization:`Bearer ${login.body.token}`};
const send=async(path:string,body:object)=>{const r=await client.post(path).set(auth).send(body);assert.ok(r.status<300,`${path}: ${r.status} ${JSON.stringify(r.body)}`);return r.body;};
const get=async(path:string)=>{const r=await client.get(path).set(auth);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
const w=(await send('/api/warehouse/warehouses',{name:'مخزن اختبار الفاتورة'})).warehouse;
const c=(await send('/api/customers',{name:'عميل الفاتورة',phone:'01012345678',governorate:'الإسكندرية',district:'العامرية'})).customer;
const products=[];
for(let i=1;i<=40;i++){
 const name=i===40?'صنف رقم 40 ACME-40 '+ 'س'.repeat(90):i===39?'صنف زراعي رقم ٣٩ ACME-39':i===38?'صنف رقم -38 ACME-38 حجم 1,234.50 لتر':`صنف زراعي رقم ${i} ACME-${i}`;
 const p=(await send('/api/warehouse/products',{name,category:'other',unit:'عبوة',unitSize:'1.5 لتر'})).product;products.push(p);
 await send('/api/warehouse/movements',{id:randomUUID(),kind:'opening',productId:p.id,toWarehouseId:w.id,qty:10});
}
const id=randomUUID();await send('/api/sales',{id,customerId:c.id,warehouseId:w.id,paid:10,lines:products.map(p=>({productId:p.id,qty:1,price:50}))});
const detail=()=>get(`/api/sales/corrections/sale/${id}`);
const pdfUrl=(version:string)=>`/api/sales/invoice/${id}/pdf?version=${version}`;

test('invoice PDF is private, valid, contains all rows, accurate numbers and spans pages safely',async()=>{
 const d=await detail(),response=await client.get(pdfUrl(d.version)).set(auth);
 assert.equal(response.status,200);assert.match(response.headers['content-type'],/^application\/pdf/);assert.match(response.headers['content-disposition'],new RegExp(`invoice-${d.record.invoiceNumber}\\.pdf`));assert.match(response.headers['cache-control'],/no-store/);assert.equal(response.body.subarray(0,5).toString(),'%PDF-');
 const doc=await getDocument({data:new Uint8Array(response.body),useSystemFonts:true}).promise;assert.ok(doc.numPages>=2);
 const pages:string[][]=[];
 for(let i=1;i<=doc.numPages;i++){
  const page=await doc.getPage(i),viewport=page.getViewport({scale:1}),content=await page.getTextContent();
  const items=content.items.filter((x):x is Extract<(typeof content.items)[number],{str:string}>=>'str' in x && x.str.trim().length>0);pages.push(items.map(x=>x.str));
  for(const item of items){const x=item.transform[4],y=item.transform[5];assert.ok(x>=-1&&y>=-1&&x+item.width<=viewport.width+1&&y<=viewport.height+1,`outside page ${i}: ${item.str}`);}
 }
 const all=pages.flat().join(' ');
 for(let i=1;i<=40;i++)assert.ok(all.includes(`ACME-${i}`),`missing or reversed product code ACME-${i}`);
 assert.ok(all.includes('فاتورة معتمدة من مجموعة الهلب جروب'));assert.ok(!all.includes('ليست فاتورة'));
 assert.ok(all.includes('1.5'), 'pack size is not reversed');assert.ok(all.includes('1,234.50'));assert.ok(all.includes('-38'));assert.ok(all.includes('2,000.00'));assert.ok(all.includes('1,990.00'));assert.equal(d.record.invoiceNumber,1);assert.ok(!all.replace(/\s/g,'').includes(id));
 const ops=await (await doc.getPage(1)).getOperatorList();assert.ok(ops.fnArray.includes(85)||ops.fnArray.includes(82),'company logo is embedded as an image');
 assert.equal((await client.get(pdfUrl(d.version))).status,401);assert.equal((await client.get('/api/sales/invoice/not-an-id/pdf').set(auth)).status,404);
 await send('/api/staff',{name:'حساب مخازن',email:'warehouse@invoice.test',password:'Password12345!',accessScope:'warehouse'});
 const token=(await send('/api/auth/login',{email:'warehouse@invoice.test',password:'Password12345!'})).token;
 assert.equal((await client.get(pdfUrl(d.version)).set('Authorization',`Bearer ${token}`)).status,403);
});

test('reject stale versions and include correction history without changing financial records',async()=>{
 const before=await detail();assert.equal((await client.get(`/api/sales/invoice/${id}/pdf`).set(auth)).status,409);
 await send(`/api/sales/corrections/sale/${id}`,{id:randomUUID(),reason:'تصحيح كمية REF-37 بعد الفحص',balancePiasters:before.balancePiasters,revision:before.revision,lines:[{lineId:before.lines[0].id,correctedMilli:500,returnedMilli:500,stockKind:'returned'}],cash:{kind:'refund',amountPiasters:500}});
 assert.equal((await client.get(pdfUrl(before.version)).set(auth)).body.code,'INVOICE_CHANGED');
 const after=await detail();assert.notEqual(after.version,before.version);assert.equal(after.balancePiasters,197000);
 const r=await client.get(pdfUrl(after.version)).set(auth);assert.equal(r.status,200);
 const doc=await getDocument({data:new Uint8Array(r.body),useSystemFonts:true}).promise;let all='';for(let i=1;i<=doc.numPages;i++){let t=await (await doc.getPage(i)).getTextContent();all+=t.items.filter((x):x is Extract<(typeof t.items)[number],{str:string}>=>'str' in x).map(x=>x.str).join(' ');}
 assert.ok(all.includes('REF-37'));assert.ok(all.includes('1,975.00'));assert.ok(all.includes('25.00'));assert.ok(all.includes('5.00'));
 const again=await detail();assert.equal(again.revision,after.revision);assert.equal(again.balancePiasters,after.balancePiasters);
});

test('long unbroken correction reasons wrap and remain within page bounds',async()=>{
 const before=await detail();await send(`/api/sales/corrections/sale/${id}`,{id:randomUUID(),reason:'س'.repeat(500),balancePiasters:before.balancePiasters,revision:before.revision,lines:[],cash:{kind:'error',amountPiasters:500}});
 const d=await detail(),r=await client.get(pdfUrl(d.version)).set(auth);assert.equal(r.status,200);
 const doc=await getDocument({data:new Uint8Array(r.body),useSystemFonts:true}).promise;let all='';
 for(let i=1;i<=doc.numPages;i++){
  const page=await doc.getPage(i),v=page.getViewport({scale:1}),t=await page.getTextContent();
  for(const item of t.items)if('str' in item){all+=item.str;assert.ok(item.transform[4]>=-1&&item.transform[4]+item.width<=v.width+1&&item.transform[5]>=-1,`clipped: ${item.str}`);}
 }
 assert.ok((all.match(/س/g)||[]).length>=500);assert.ok(all.includes('REF-37'));
});


test('legacy details are disclosed to the office but the old warning is not printed on the invoice',async()=>{
 instance.store.run('DELETE FROM office_invoice_snapshots_v1 WHERE sale_id=?',id);
 const d=await detail();assert.equal(d.snapshot,null);assert.equal(d.record.invoiceNumber,1);
 const r=await client.get(pdfUrl(d.version)).set(auth);assert.equal(r.status,200);
 const doc=await getDocument({data:new Uint8Array(r.body),useSystemFonts:true}).promise;let text='';
 for(let i=1;i<=doc.numPages;i++){const t=await (await doc.getPage(i)).getTextContent();text+=t.items.filter((x):x is Extract<(typeof t.items)[number],{str:string}>=>'str' in x).map(x=>x.str).join(' ');}
 assert.ok(!text.includes('بيعة قديمة'));assert.ok(!text.includes(id));assert.ok(text.includes('البيانات الحالية'));
});
