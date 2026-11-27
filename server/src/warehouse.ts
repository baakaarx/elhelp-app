import { Router } from 'express';
import { hasDecimalPrecision } from './decimal.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './db.js';
import { hashPassword } from './auth.js';
import { MIN_ADMIN_PASSWORD_LENGTH } from './config.js';

const name = z.string().trim().min(2).max(120);
const id = z.string().trim().min(1).max(64);
const productFields = z.object({ name, category: z.enum(['fertilizer', 'pesticide', 'other']), unit: z.string().trim().min(1).max(40), unitSize: z.string().trim().max(60).default('') }).strict();

/** مخازن مستقلة؛ الحركات تحفظ بالكسر بالألف، وتُنفَّذ كلها في معاملة واحدة. */
export function createWarehouseRouter(store: Store) {
  const router = Router();
  router.use((_req, res, next) => {
    if (res.locals.user.role !== 'admin') { res.status(403).json({ error: 'المخازن لحسابات المكتب والمخازن فقط.' }); return; }
    next();
  });
  const warehouseColumns = new Set(store.all('PRAGMA table_info(warehouses)').map(column => column.name));
  const legacyColumns = new Set(store.all('PRAGMA table_info(stock_movements)').map(column => column.name));
  const legacyHistory = legacyColumns.size > 0 && !['id','kind','product_id','from_warehouse_id','to_warehouse_id','milli_qty','note','actor_id','actor_name','created_at'].every(column => legacyColumns.has(column)) && !!store.get('SELECT 1 FROM stock_movements LIMIT 1');
  const product = (productId: string) => store.get('SELECT id,name,category,unit,unit_size AS unitSize,active FROM products WHERE id=?', productId);
  router.get('/products', (_req, res) => {
    const products = store.all('SELECT id,name,category,unit,unit_size AS unitSize,active FROM products ORDER BY active DESC,name COLLATE NOCASE');
    res.json({ products: products.map(p => ({ ...p, active: !!p.active })) });
  });
  router.post('/products', (req, res) => {
    const parsed = productFields.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'اكتب اسم الصنف ونوعه ووحدته بشكل صحيح.' }); return; }
    const p = parsed.data;
    if (store.get("SELECT id FROM products WHERE name COLLATE NOCASE=? AND unit COLLATE NOCASE=? AND (trim(unit_size)='' OR ?='' OR unit_size COLLATE NOCASE=?)", p.name, p.unit, p.unitSize, p.unitSize)) { res.status(409).json({ error: 'الصنف بنفس الوحدة والعبوة موجود، أو حجم العبوة غير محدد؛ راجع الصنف الموجود.' }); return; }
    const productId = randomUUID(), now = Date.now();
    try {store.run('INSERT INTO products(id,name,category,unit,unit_size,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', productId,p.name,p.category,p.unit,p.unitSize,now,now);} catch(e) {if (/PRODUCT_PACK_CONFLICT|UNIQUE/.test(String(e))) {res.status(409).json({error:'الصنف بنفس الوحدة والعبوة موجود، أو حجم العبوة غير محدد؛ راجع الصنف الموجود.'});return;} throw e;}
    store.audit(res.locals.user.id, 'warehouse.product.create', { productId });
    res.status(201).json({ product: product(productId) });
  });
  router.patch('/products/:id', (req, res) => {
    const current = product(String(req.params.id));
    if (!current) { res.status(404).json({ error: 'الصنف غير موجود.' }); return; }
    const parsed = z.object({ name:name.optional(), category:z.enum(['fertilizer','pesticide','other']).optional(), unit:z.string().trim().min(1).max(40).optional(), unitSize:z.string().trim().max(60).optional(), active:z.boolean().optional() }).strict().safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data).length) { res.status(400).json({ error: 'بيانات الصنف غير صحيحة.' }); return; }
    const p = parsed.data;
    if ((p.unit !== undefined && p.unit !== current.unit || p.unitSize !== undefined && p.unitSize !== current.unitSize)
      && store.get('SELECT 1 AS x FROM warehouse_stock WHERE product_id=? LIMIT 1', current.id)) {
      res.status(409).json({ error: 'الصنف له رصيد مسجّل؛ تغيير الوحدة أو العبوة يغيّر معنى الرصيد. أضف صنفًا جديدًا بدلًا من ذلك.' }); return;
    }
    const nextName = p.name ?? current.name, unit = p.unit ?? current.unit, unitSize = p.unitSize ?? current.unitSize;
    if (store.get("SELECT id FROM products WHERE name COLLATE NOCASE=? AND unit COLLATE NOCASE=? AND (trim(unit_size)='' OR ?='' OR unit_size COLLATE NOCASE=?) AND id<>?", nextName, unit, unitSize, unitSize, current.id)) { res.status(409).json({ error: 'الصنف بنفس الوحدة والعبوة موجود، أو حجم العبوة غير محدد؛ راجع الصنف الموجود.' }); return; }
    try {store.run('UPDATE products SET name=?,category=?,unit=?,unit_size=?,active=?,updated_at=? WHERE id=?', nextName, p.category ?? current.category, unit, unitSize, p.active === undefined ? current.active : Number(p.active), Date.now(), current.id);} catch(e) {if (/PRODUCT_PACK_CONFLICT|UNIQUE/.test(String(e))) {res.status(409).json({error:'الصنف بنفس الوحدة والعبوة موجود، أو حجم العبوة غير محدد؛ راجع الصنف الموجود.'});return;} throw e;}
    store.audit(res.locals.user.id, 'warehouse.product.update', { productId: current.id });
    res.json({ product: product(String(current.id)) });
  });
  // Create a catalogue item and its first balance together, in the explicitly chosen warehouse.
  // A persisted request ID makes a retry after a lost response safe.
  router.post('/stock-items', (req, res) => {
    const schema = z.object({ id:z.uuid(), warehouseId:id, product:productFields, qty:z.number().nonnegative().max(1_000_000_000) }).strict();
    const parsed = schema.safeParse(req.body);
    if (!parsed.success || !hasDecimalPrecision(parsed.success ? parsed.data.qty : 0, 3)) { res.status(400).json({ error:'راجع بيانات الصنف والرصيد؛ الكمية تقبل ٣ أرقام عشرية.' }); return; }
    const data=parsed.data, request=JSON.stringify(data), actor=res.locals.user;
    const p=data.product, productId=randomUUID(), now=Date.now(), milli=Math.round(data.qty*1000);
    let previousProductId: string | null = null;
    try {
      store.transaction(()=>{
        // Check only after acquiring the write lock: another server process may have committed
        // the same request while this one was waiting for BEGIN IMMEDIATE.
        const old=store.get('SELECT actor_id,request_json,product_id FROM warehouse_item_requests_v1 WHERE id=?',data.id);
        if (old) {
          if (old.actor_id!==actor.id || old.request_json!==request) throw Error('REQUEST_CONFLICT');
          previousProductId=String(old.product_id);return;
        }
        if(!store.get('SELECT id FROM warehouses WHERE id=?',data.warehouseId)) throw Error('WAREHOUSE');
        if(store.get("SELECT id FROM products WHERE name COLLATE NOCASE=? AND unit COLLATE NOCASE=? AND (trim(unit_size)='' OR ?='' OR unit_size COLLATE NOCASE=?)",p.name,p.unit,p.unitSize,p.unitSize)) throw Error('PRODUCT_PACK_CONFLICT');
        store.run('INSERT INTO products(id,name,category,unit,unit_size,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',productId,p.name,p.category,p.unit,p.unitSize,now,now);
        store.run('INSERT INTO warehouse_stock(warehouse_id,product_id,milli_qty) VALUES(?,?,?)',data.warehouseId,productId,milli);
        store.run("INSERT INTO inventory_movements(id,kind,product_id,from_warehouse_id,to_warehouse_id,milli_qty,note,actor_id,actor_name,created_at) VALUES(?,'opening',?,NULL,?,?, '',?,?,?)",data.id,productId,data.warehouseId,milli,actor.id,actor.name,now);
        store.run('INSERT INTO warehouse_item_requests_v1(id,actor_id,request_json,product_id) VALUES(?,?,?,?)',data.id,actor.id,request,productId);
        store.audit(actor.id,'warehouse.product.create',{productId,warehouseId:data.warehouseId});
      });
    } catch(e) {
      if ((e as Error).message==='WAREHOUSE') {res.status(400).json({error:'اختار مخزن موجود.'});return;}
      if ((e as Error).message==='REQUEST_CONFLICT') {res.status(409).json({error:'رقم العملية مستخدم لبيانات مختلفة.'});return;}
      if (/PRODUCT_PACK_CONFLICT|UNIQUE/.test(String(e))) {res.status(409).json({error:'الصنف بنفس العبوة موجود بالفعل. اختاره لتسجيل رصيده في المخزن ده.'});return;}
      throw e;
    }
    res.status(previousProductId ? 200 : 201).json({ok:true,duplicate:!!previousProductId,productId:previousProductId ?? productId});
  });
  router.get('/low-stock', (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const rows=store.all(`SELECT w.id AS warehouseId,w.name AS warehouseName,p.id AS productId,p.name AS productName,p.unit,p.unit_size AS unitSize,s.milli_qty AS qty
      FROM warehouse_stock s JOIN warehouses w ON w.id=s.warehouse_id JOIN products p ON p.id=s.product_id
      WHERE p.active=1 AND s.milli_qty<100000 ORDER BY w.name COLLATE NOCASE,p.name COLLATE NOCASE,p.id`);
    res.json({items:rows.map(row=>({...row,qty:Number(row.qty)/1000}))});
  });
  router.get('/warehouses', (_req, res) => {
    res.json({ warehouses: store.all('SELECT id,name,created_at AS createdAt FROM warehouses ORDER BY name COLLATE NOCASE'), legacyHistory });
  });
  router.post('/warehouses', (req, res) => {
    const parsed = z.object({ name }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'اكتب اسم المخزن.' }); return; }
    if (store.get('SELECT id FROM warehouses WHERE name=? COLLATE NOCASE', parsed.data.name)) { res.status(409).json({ error: 'اسم المخزن موجود بالفعل.' }); return; }
    const warehouseId = randomUUID();
    const now = Date.now();
    if (warehouseColumns.has('updated_at')) store.run('INSERT INTO warehouses(id,name,created_at,updated_at) VALUES (?,?,?,?)', warehouseId, parsed.data.name, now, now);
    else store.run('INSERT INTO warehouses(id,name,created_at) VALUES (?,?,?)', warehouseId, parsed.data.name, now);
    store.audit(res.locals.user.id, 'warehouse.create', { warehouseId, name: parsed.data.name });
    res.status(201).json({ warehouse: store.get('SELECT id,name FROM warehouses WHERE id=?', warehouseId) });
  });
  router.get('/stock', (req, res) => {
    const warehouseId = String(req.query.warehouseId || '');
    if (!store.get('SELECT id FROM warehouses WHERE id=?', warehouseId)) { res.status(404).json({ error: 'المخزن غير موجود.' }); return; }
    const rows = store.all(`SELECT p.id,p.name,p.category,p.unit,p.unit_size AS unitSize,p.active, s.milli_qty AS milliQty
      FROM products p LEFT JOIN warehouse_stock s ON s.product_id=p.id AND s.warehouse_id=? ORDER BY p.active DESC,p.name COLLATE NOCASE`, warehouseId);
    res.json({ stock: rows.map(p => ({ id:p.id,name:p.name,category:p.category,unit:p.unit,unitSize:p.unitSize,active:!!p.active,qty:p.milliQty === null ? null : Number(p.milliQty)/1000 })) });
  });
  router.get('/movements', (req, res) => {
    const warehouseId = typeof req.query.warehouseId === 'string' ? req.query.warehouseId : '';
    const where = warehouseId ? 'WHERE m.from_warehouse_id=? OR m.to_warehouse_id=?' : '';
    const rows = store.all(`SELECT m.id,m.kind,m.milli_qty AS milliQty,m.note,m.actor_name AS actorName,m.created_at AS createdAt,
      p.name AS productName,p.unit,p.unit_size AS unitSize,fw.name AS fromName,tw.name AS toName
      FROM inventory_movements m JOIN products p ON p.id=m.product_id
      LEFT JOIN warehouses fw ON fw.id=m.from_warehouse_id LEFT JOIN warehouses tw ON tw.id=m.to_warehouse_id
      ${where} ORDER BY m.created_at DESC,m.rowid DESC LIMIT 200`, ...(warehouseId ? [warehouseId, warehouseId] : []));
    res.json({ movements: rows.map(({ milliQty, ...r }) => ({ ...r, qty: Number(milliQty)/1000 })) });
  });
  router.post('/movements', (req, res) => {
    const schema = z.object({ id: z.uuid(), kind: z.enum(['opening','in','out','transfer']), productId:id,
      fromWarehouseId:id.optional(), toWarehouseId:id.optional(), qty:z.number().nonnegative().max(1_000_000_000), note:z.string().trim().max(500).default('') }).strict();
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'بيانات حركة المخزون غير صحيحة.' }); return; }
    const m = parsed.data, scaled = m.qty * 1000, milli = Math.round(scaled);
    const from = m.kind === 'in' || m.kind === 'opening' ? null : m.fromWarehouseId ?? null, to = m.kind === 'out' ? null : m.toWarehouseId ?? null;
    if ((m.kind !== 'in' && m.kind !== 'opening' && !from) || (m.kind !== 'out' && !to) || (from && to && from === to) || ((m.kind === 'in' || m.kind === 'opening') && m.fromWarehouseId) || (m.kind === 'out' && m.toWarehouseId)) { res.status(400).json({ error: 'اختار مخازن الحركة بشكل صحيح.' }); return; }
    const duplicate = () => {
      const existing = store.get('SELECT * FROM inventory_movements WHERE id=?', m.id);
      if (!existing) return 0;
      return existing.actor_id === res.locals.user.id && existing.kind === m.kind && existing.product_id === m.productId
        && existing.from_warehouse_id === from && existing.to_warehouse_id === to && Number(existing.milli_qty) === milli && existing.note === m.note ? 1 : -1;
    };
    const existing = duplicate();
    if (existing) { res.status(existing === 1 ? 200 : 409).json(existing === 1 ? {ok:true, duplicate:true} : {error:'معرّف الحركة مستخدم لبيانات مختلفة.'}); return; }
    // Older clients could submit excess precision; a recorded movement remains retryable above.
    if (!hasDecimalPrecision(m.qty,3)) { res.status(400).json({ error: 'الكمية تقبل لحد ٣ أرقام بعد العلامة العشرية.' }); return; }
    if (m.kind !== 'opening' && milli < 1) { res.status(400).json({ error: 'اكتب كمية أكبر من صفر للحركة؛ الصفر مسموح للرصيد الافتتاحي فقط.' }); return; }
    const item = product(m.productId);
    if (!item) { res.status(400).json({ error: 'الصنف غير موجود.' }); return; }
    if ((from && !store.get('SELECT id FROM warehouses WHERE id=?', from)) || (to && !store.get('SELECT id FROM warehouses WHERE id=?', to))) { res.status(400).json({ error: 'المخزن غير موجود.' }); return; }
    let replay = false;
    try {
      store.transaction(() => {
        // Another process can commit the request after the initial check but before this lock.
        const previous = duplicate();
        if (previous === 1) { replay = true; return; }
        if (previous === -1) throw new Error('REQUEST_CONFLICT');
        if (m.kind === 'opening') {
          if (store.get('SELECT 1 FROM warehouse_stock WHERE warehouse_id=? AND product_id=?', to, m.productId)) throw new Error('STOCK_INITIALIZED');
          store.run('INSERT INTO warehouse_stock(warehouse_id,product_id,milli_qty) VALUES (?,?,?)', to, m.productId, milli);
        } else {
          for (const warehouseId of [from, to].filter(Boolean)) {
            if (!store.get('SELECT 1 FROM warehouse_stock WHERE warehouse_id=? AND product_id=?', warehouseId, m.productId)) throw new Error('STOCK_NOT_INITIALIZED');
          }
        }
        if (from) {
          const result = store.run('UPDATE warehouse_stock SET milli_qty=milli_qty-? WHERE warehouse_id=? AND product_id=? AND milli_qty>=?', milli, from, m.productId, milli);
          if (!result.changes) throw new Error('INSUFFICIENT_STOCK');
        }
        if (to && m.kind !== 'opening' && Number(store.get('SELECT milli_qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?',to,m.productId)!.milli_qty) > Number.MAX_SAFE_INTEGER-milli) throw new Error('STOCK_LIMIT');
        if (to && m.kind !== 'opening') store.run('INSERT INTO warehouse_stock(warehouse_id,product_id,milli_qty) VALUES (?,?,?) ON CONFLICT(warehouse_id,product_id) DO UPDATE SET milli_qty=milli_qty+excluded.milli_qty', to, m.productId, milli);
        store.run('INSERT INTO inventory_movements(id,kind,product_id,from_warehouse_id,to_warehouse_id,milli_qty,note,actor_id,actor_name,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', m.id,m.kind,m.productId,from,to,milli,m.note,res.locals.user.id,res.locals.user.name,Date.now());
        store.audit(res.locals.user.id, 'warehouse.movement', { movementId:m.id, kind:m.kind, productId:m.productId, from, to, qty:m.qty });
      });
    } catch (e) {
      if ((e as Error).message === 'REQUEST_CONFLICT') { res.status(409).json({ error: 'معرّف الحركة مستخدم لبيانات مختلفة.' }); return; }
      if ((e as Error).message === 'STOCK_INITIALIZED') { res.status(409).json({ error: 'الرصيد الافتتاحي اتسجل قبل كده.' }); return; }
      if ((e as Error).message === 'STOCK_NOT_INITIALIZED') { res.status(409).json({ error: 'سجّل الرصيد الافتتاحي للصنف في كل مخزن للحركة الأول.' }); return; }
      if ((e as Error).message === 'STOCK_LIMIT') { res.status(409).json({ error: 'الرصيد أكبر من الحد الآمن للتسجيل. راجع المسؤول.', code:'STOCK_LIMIT' }); return; }
      if ((e as Error).message === 'INSUFFICIENT_STOCK') { res.status(409).json({ error: 'الكمية أكبر من الرصيد المتاح في المخزن.', code:'INSUFFICIENT_STOCK' }); return; }
      throw e;
    }
    if (replay) { res.json({ok:true, duplicate:true}); return; }
    res.status(201).json({ ok:true, duplicate:false });
  });
  return router;
}

/** حساب المبيعات مدير كامل، وحساب المخازن معزول في جميع واجهات API. */
export function createStaffRouter(store: Store, disconnectUser: (id: string) => void) {
  const router = Router();
  router.get('/', (_req, res) => res.json({ staff: store.all("SELECT id,name,email,access_scope AS accessScope,active,created_at AS createdAt FROM users WHERE role='admin' ORDER BY created_at DESC").map(u => ({ ...u,active:!!u.active })), minimumPasswordLength:MIN_ADMIN_PASSWORD_LENGTH }));
  router.post('/', (req,res) => {
    const parsed = z.object({ name, email:z.email().trim().toLowerCase(), password:z.string().min(MIN_ADMIN_PASSWORD_LENGTH).max(200), accessScope:z.enum(['full','warehouse']) }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error:`اكتب الاسم والبريد وكلمة مرور من ${MIN_ADMIN_PASSWORD_LENGTH} حرفًا على الأقل، واختار نوع الحساب.` }); return; }
    const u = parsed.data;
    if (store.get('SELECT id FROM users WHERE email=?', u.email)) { res.status(409).json({ error:'البريد مستخدم بالفعل.' }); return; }
    const userId = randomUUID();
    store.run("INSERT INTO users(id,name,email,password_hash,role,access_scope,created_at) VALUES (?,?,?,?,'admin',?,?)", userId,u.name,u.email,hashPassword(u.password),u.accessScope,Date.now());
    store.audit(res.locals.user.id,'staff.create',{ userId,accessScope:u.accessScope });
    res.status(201).json({ user:{ id:userId,name:u.name,email:u.email,accessScope:u.accessScope } });
  });
  router.patch('/:id', (req,res) => {
    const target = store.get("SELECT id,name,role,access_scope,active FROM users WHERE id=? AND role='admin'", String(req.params.id));
    if (!target) { res.status(404).json({ error:'الحساب غير موجود.' }); return; }
    const parsed = z.object({ active:z.boolean().optional(), password:z.string().min(MIN_ADMIN_PASSWORD_LENGTH).max(200).optional() }).strict().safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data).length) { res.status(400).json({ error:'بيانات الحساب غير صحيحة.' }); return; }
    if (parsed.data.active === false && target.id === res.locals.user.id) { res.status(409).json({error:'ما ينفعش توقف حسابك الحالي.'}); return; }
    if (parsed.data.active === false && target.active && target.access_scope === 'full' && Number(store.get("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND access_scope='full' AND active=1")?.c || 0) <= 1) { res.status(409).json({error:'لازم يفضل حساب مبيعات أو مدير شغّال.'}); return; }
    store.transaction(() => {
      if (parsed.data.active !== undefined) store.run('UPDATE users SET active=? WHERE id=?',Number(parsed.data.active),target.id);
      if (parsed.data.password !== undefined) store.run('UPDATE users SET password_hash=? WHERE id=?',hashPassword(parsed.data.password),target.id);
      if (parsed.data.active === false || parsed.data.password !== undefined) store.run('DELETE FROM sessions WHERE user_id=?',target.id);
    });
    if (parsed.data.active === false || parsed.data.password !== undefined) disconnectUser(String(target.id));
    store.audit(res.locals.user.id,'staff.update',{userId:target.id,fields:Object.keys(parsed.data)});
    res.json({ ok:true });
  });
  return router;
}
