import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword, verifyPassword } from '../src/auth.js';

const instance = createApp({dbPath:':memory:', production:false, adminEmail:'admin@product-races.test', adminPassword:'AdminPassword123!', loginAccountLimit:500, loginRateLimit:{windowMs:60000,limit:5000}});
const {app,store}=instance, client=request(app);
test.after(async()=>instance.close());
const adminToken=(await client.post('/api/auth/login').send({email:'admin@product-races.test',password:'AdminPassword123!'})).body.token;
const admin={Authorization:`Bearer ${adminToken}`};
async function makeRep(){const email=`${randomUUID()}@product-races.test`, password='Password12345!';const r=await client.post('/api/reps').set(admin).send({name:'مهندس الاختبار',email,password,region:'الإسكندرية'});assert.equal(r.status,201);return {id:r.body.user.id as string,email,password};}
const warehouse=(await client.post('/api/warehouse/warehouses').set(admin).send({name:'مخزن تداخل الأصناف'})).body.warehouse.id as string;
async function newProduct(){const r=await client.post('/api/warehouse/products').set(admin).send({name:`صنف ${randomUUID()}`,category:'other',unit:'عبوة',unitSize:'واحد'});assert.equal(r.status,201);return r.body.product.id as string;}

for (const route of ['/api/products/', '/api/warehouse/products/']) {
 test(`${route} rechecks stock after locking and preserves unrelated edits`,async()=>{
  const id=await newProduct(), transaction=store.transaction.bind(store);
  store.transaction=fn=>{store.run('INSERT INTO warehouse_stock(warehouse_id,product_id,milli_qty) VALUES (?,?,?)',warehouse,id,7000);transaction(fn);};
  let result;try{result=await client.patch(route+id).set(admin).send({unit:'كرتونة'});}finally{store.transaction=transaction;}
  assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(store.get('SELECT unit FROM products WHERE id=?',id)?.unit,'عبوة');assert.equal(store.get('SELECT milli_qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?',warehouse,id)?.milli_qty,7000);
  store.transaction=fn=>{store.run('UPDATE products SET category=? WHERE id=?','pesticide',id);transaction(fn);};
  try{result=await client.patch(route+id).set(admin).send({active:false});}finally{store.transaction=transaction;}
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(store.get('SELECT category FROM products WHERE id=?',id)?.category,'pesticide');
 });
}

test('product, warehouse and price changes roll back on audit failure',async()=>{
 const tier=String(store.get('SELECT id FROM price_tiers LIMIT 1')!.id), id=await newProduct();
 const cases=[
  {action:'warehouse.product.create',request:()=>client.post('/api/warehouse/products').set(admin).send({name:'مرفوض مخزن',category:'other',unit:'عبوة'}),check:()=>assert.equal(store.get("SELECT id FROM products WHERE name='مرفوض مخزن'"),undefined)},
  {action:'product.create',request:()=>client.post('/api/products').set(admin).send({name:'مرفوض مكتب',unit:'عبوة',prices:[{tierId:tier,price:7}]}),check:()=>assert.equal(store.get("SELECT id FROM products WHERE name='مرفوض مكتب'"),undefined)},
  {action:'warehouse.create',request:()=>client.post('/api/warehouse/warehouses').set(admin).send({name:'مخزن مرفوض'}),check:()=>assert.equal(store.get("SELECT id FROM warehouses WHERE name='مخزن مرفوض'"),undefined)},
  {action:'product.update',request:()=>client.patch(`/api/products/${id}`).set(admin).send({notes:'تعديل مرفوض'}),check:()=>assert.notEqual(store.get('SELECT notes FROM products WHERE id=?',id)?.notes,'تعديل مرفوض')},
  {action:'warehouse.product.update',request:()=>client.patch(`/api/warehouse/products/${id}`).set(admin).send({category:'fertilizer'}),check:()=>assert.equal(store.get('SELECT category FROM products WHERE id=?',id)?.category,'other')},
  {action:'product.prices',request:()=>client.put(`/api/products/${id}/prices`).set(admin).send({prices:[{tierId:tier,price:7}]}),check:()=>assert.equal(store.get('SELECT price FROM product_prices WHERE product_id=? AND tier_id=?',id,tier),undefined)},
 ];
 for(const c of cases){store.db.exec(`CREATE TRIGGER fail_product_audit BEFORE INSERT ON audit_log WHEN NEW.action='${c.action}' BEGIN SELECT RAISE(ABORT,'audit failure'); END`);try{const r=await c.request();assert.equal(r.status,500,`${c.action}: ${JSON.stringify(r.body)}`);c.check();}finally{store.db.exec('DROP TRIGGER fail_product_audit');}}
});

test('password changes and reset do not partially commit when audit fails',async()=>{
 const rep=await makeRep(), login=await client.post('/api/auth/login').send({email:rep.email,password:rep.password});const auth={Authorization:`Bearer ${login.body.token}`};
 for(const c of [
  {action:'auth.password_change',request:()=>client.post('/api/me/password').set(auth).send({currentPassword:rep.password,newPassword:'NewPassword123!'})},
  {action:'rep.password_reset',request:()=>client.post(`/api/reps/${rep.id}/password`).set(admin).send({password:'NewPassword123!'})},
 ]){
  store.db.exec(`CREATE TRIGGER fail_password_audit BEFORE INSERT ON audit_log WHEN NEW.action='${c.action}' BEGIN SELECT RAISE(ABORT,'audit failure'); END`);
  try{assert.equal((await c.request()).status,500);assert.ok(verifyPassword(rep.password,String(store.get('SELECT password_hash FROM users WHERE id=?',rep.id)!.password_hash)));assert.ok(store.get('SELECT 1 FROM sessions WHERE user_id=?',rep.id));}finally{store.db.exec('DROP TRIGGER fail_password_audit');}
 }
});

test('stale password change and login cannot defeat a concurrent reset',async()=>{
 const rep=await makeRep(), login=await client.post('/api/auth/login').send({email:rep.email,password:rep.password}),auth={Authorization:`Bearer ${login.body.token}`};
 const transaction=store.transaction.bind(store), newer=hashPassword('ResetPassword123!');
 store.transaction=fn=>{store.run('UPDATE users SET password_hash=? WHERE id=?',newer,rep.id);transaction(fn);};
 let response;try{response=await client.post('/api/me/password').set(auth).send({currentPassword:rep.password,newPassword:'OtherPassword123!'});}finally{store.transaction=transaction;}
 assert.equal(response.status,409);assert.ok(verifyPassword('ResetPassword123!',String(store.get('SELECT password_hash FROM users WHERE id=?',rep.id)!.password_hash)));
 store.run('UPDATE users SET password_hash=? WHERE id=?',hashPassword(rep.password),rep.id);
 store.run('DELETE FROM sessions WHERE user_id=?',rep.id);
 store.transaction=fn=>{store.run('UPDATE users SET password_hash=? WHERE id=?',newer,rep.id);transaction(fn);};
 try{response=await client.post('/api/auth/login').send({email:rep.email,password:rep.password});}finally{store.transaction=transaction;}
 assert.equal(response.status,401);assert.equal(store.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?',rep.id)?.n,0);
});

test('failed login audit does not leave a session or cookie',async()=>{
 const rep=await makeRep();store.db.exec("CREATE TRIGGER fail_login_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.login' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
 try{const response=await client.post('/api/auth/login').send({email:rep.email,password:rep.password});assert.equal(response.status,500);assert.equal(store.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?',rep.id)?.n,0);assert.equal(response.headers['set-cookie'],undefined);}finally{store.db.exec('DROP TRIGGER fail_login_audit');}
});
