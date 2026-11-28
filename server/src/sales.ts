import { Router } from 'express';
import { hasDecimalPrecision } from './decimal.js';
import { createHash, randomUUID } from 'node:crypto';
import { invoicePdf } from './invoicePdf.js';
import { z } from 'zod';
import type { Store } from './db.js';

const id = z.uuid();
const entityId = z.string().trim().min(1).max(64);
const money = z.number().finite().nonnegative().max(1_000_000_000);
const quantity = z.number().finite().positive().max(100_000);
const cents = (n: number) => Math.round(n * 100);
const milli = (n: number) => Math.round(n * 1000);
const exact = (n: number, scale: number) => hasDecimalPrecision(n, scale === 100 ? 2 : 3);
const bodySale = z.object({ id, customerId:entityId, warehouseId:entityId, orderId:entityId.optional(), repId:entityId.nullable().optional(), paid:money,
  lines:z.array(z.object({productId:entityId,qty:quantity,price:money}).strict()).max(100).default([]) }).strict();
const bodyEntry = z.object({id,customerId:entityId,amount:money}).strict();
const correctionBody=z.object({id,reason:z.string().trim().min(5).max(500),balancePiasters:z.number().int().safe(),revision:z.number().int().nonnegative(),
  lines:z.array(z.object({lineId:entityId,correctedMilli:z.number().int().nonnegative().max(100_000_000),returnedMilli:z.number().int().nonnegative().max(100_000_000),damagedMilli:z.number().int().nonnegative().max(100_000_000).optional(),stockKind:z.enum(['returned','error']).nullable()}).strict()).max(100),
  cash:z.object({kind:z.enum(['error','refund']),amountPiasters:z.number().int().positive().max(100_000_000_000)}).strict().nullable()}).strict();

/** Office-only confirmed sales; a priced order is not itself a sale or a payment. */
export function createSalesRouter(store: Store, timezone:string, onOrderSold:(orderId:string)=>void = ()=>{}) {
  const router = Router();
  const warehouseHasUpdatedAt = store.all('PRAGMA table_info(warehouses)').some(column => column.name === 'updated_at');
  // Called only within the correction transaction; never reclassify an existing real warehouse.
  const damagedWarehouse = (now: number): string => {
    const existing = store.get('SELECT warehouse_id FROM damaged_warehouse_v1 WHERE singleton=1');
    if (existing) return String(existing.warehouse_id);
    const warehouseId = randomUUID();
    const base = 'مخزن المرتجعات التالفة';
    let warehouseName = base, suffix = 2;
    while (store.get('SELECT 1 FROM warehouses WHERE name=? COLLATE NOCASE', warehouseName)) warehouseName = `${base} (${suffix++})`;
    if (warehouseHasUpdatedAt) store.run('INSERT INTO warehouses(id,name,created_at,updated_at) VALUES(?,?,?,?)',warehouseId,warehouseName,now,now);
    else store.run('INSERT INTO warehouses(id,name,created_at) VALUES(?,?,?)',warehouseId,warehouseName,now);
    store.run('INSERT INTO damaged_warehouse_v1(singleton,warehouse_id) VALUES(1,?)',warehouseId);
    return warehouseId;
  };
  const balance = (customerId: string): number => Number(store.get(`SELECT
    COALESCE((SELECT SUM(amount_piasters) FROM office_debts_v1 WHERE customer_id=?),0)
    + COALESCE((SELECT SUM(total_piasters-paid_piasters) FROM office_sales_v1 WHERE customer_id=?),0)
    - COALESCE((SELECT SUM(amount_piasters) FROM office_receipts_v1 WHERE customer_id=?),0)
    - COALESCE((SELECT SUM(cl.amount_piasters) FROM office_correction_lines_v1 cl JOIN office_corrections_v1 x ON x.id=cl.correction_id JOIN office_sales_v1 s ON s.id=x.sale_id WHERE s.customer_id=?),0)
    + COALESCE((SELECT SUM(x.cash_piasters) FROM office_sales_v1 s JOIN office_corrections_v1 x ON x.sale_id=s.id WHERE s.customer_id=?),0)
    + COALESCE((SELECT SUM(x.cash_piasters) FROM office_receipts_v1 r JOIN office_corrections_v1 x ON x.receipt_id=r.id WHERE r.customer_id=?),0) AS amount`,customerId,customerId,customerId,customerId,customerId,customerId)?.amount || 0);
  const duplicate = (table:'office_sales_v1'|'office_receipts_v1'|'office_debts_v1'|'office_corrections_v1', entryId:string, payload:string, userId:string) => {
    const old = store.get(`SELECT actor_id,request_json FROM ${table} WHERE id=?`,entryId);
    if (!old) return 0;
    return old.actor_id === userId && old.request_json === payload ? 1 : -1;
  };
  const fail = (code:string) => {
    const errors:Record<string,string> = {
      CUSTOMER:'اختار عميل شغال من القائمة.', WAREHOUSE:'اختار مخزن صحيح.', ORDER:'الطلبية مش مرسلة للمكتب أو تخص عميل تاني.', ORDER_CHANGED:'الطلبية اتغيرت. حدّث البيانات وراجع الفاتورة من جديد.', ORDER_LINES:'اختار أصناف من الطلبية واكتب الكمية الفعلية وسعر المكتب.',
      ORDER_SOLD:'الطلبية دي اتسجّلت لها فاتورة قبل كده.', REP:'المهندس المختار غير موجود أو موقوف.', ORDER_TOTAL:'الطلبية القديمة فيها اختلاف في الإجمالي. افتحها من شاشة الفاتورة وراجع الكميات والأسعار.', PRODUCT:'الصنف غير موجود أو موقوف.',
      DUPLICATE_PRODUCT:'اختار كل صنف مرة واحدة.', PRECISION:'الكمية تقبل ٣ أرقام عشرية والسعر رقمين عشريين.',
      ORDER_PRODUCT_CHANGED:'وحدة أو عبوة صنف في الطلبية تختلف عن الصنف الحالي في المخزن. الفاتورة لم تُسجّل؛ راجع المكتب قبل البيع.',
      NO_OPENING:'خلّي المخازن تسجّل الرصيد الافتتاحي للصنف الأول.', SHORT:'الكمية المطلوبة أكبر من رصيد المخزن.',
      PAID:'المبلغ المدفوع أكبر من إجمالي الفاتورة.', BIG:'إجمالي الفاتورة أكبر من المسموح.',
      OPENING:'المديونية القديمة للعميل اتسجلت قبل كده.', PAYMENT:'الدفعة أكبر من المبلغ المتبقي على العميل.',
    };
    return errors[code] || 'تعذر تسجيل العملية.';
  };
  router.get('/options', (_req,res) => {
    const customers=store.all("SELECT c.id,c.name,c.phone,c.price_tier_id AS priceTierId,EXISTS(SELECT 1 FROM office_debts_v1 d WHERE d.customer_id=c.id) AS hasOpening FROM customers c WHERE c.active=1 ORDER BY c.name COLLATE NOCASE,c.id");
    const statementCustomers=store.all('SELECT id,name,phone,active FROM customers ORDER BY name COLLATE NOCASE,id');
    const products=store.all("SELECT id,name,unit,unit_size AS unitSize FROM products WHERE active=1 ORDER BY name COLLATE NOCASE,id");
    const warehouses=store.all('SELECT id,name FROM warehouses WHERE id NOT IN (SELECT warehouse_id FROM damaged_warehouse_v1) ORDER BY name COLLATE NOCASE,id');
    const reps=store.all("SELECT id,name,region FROM users WHERE role='rep' AND active=1 ORDER BY name COLLATE NOCASE,id");
    const prices=store.all('SELECT product_id AS productId,tier_id AS tierId,price FROM product_prices');
    const orders=store.all(`SELECT o.id,o.customer_id AS customerId,c.name AS customerName,o.status,o.notes,o.recommendation,o.total,o.sent_at AS sentAt,o.priced_at AS pricedAt,u.name AS repName
      FROM orders o JOIN customers c ON c.id=o.customer_id JOIN users u ON u.id=o.user_id WHERE o.status IN ('sent','priced') AND c.active=1
      AND NOT EXISTS (SELECT 1 FROM office_sales_v1 s WHERE s.order_id=o.id) ORDER BY o.sent_at,o.id`);
    const pendingOrders=orders.map(order=>({...order,lines:store.all('SELECT product_id AS productId,product_name AS name,unit,unit_size AS unitSize,qty,price,notes FROM order_lines WHERE order_id=? ORDER BY position',order.id)}));
    const tiers=store.all('SELECT id,name,active FROM price_tiers ORDER BY position,name COLLATE NOCASE');
    res.json({customers,statementCustomers,products,warehouses,reps,prices,tiers,orders:pendingOrders});
  });
  // Ranking is computed across the full company book before search/pagination. Ties share a
  // class, zero-value customers remain unclassified, and all arithmetic stays in piasters.
  const customerRankCte = `WITH totals AS (
    SELECT customer_id, SUM(total_piasters) AS amount FROM office_sales_net_v1 GROUP BY customer_id
  ), buyers AS (
    SELECT customer_id, amount, RANK() OVER (ORDER BY amount DESC) AS position,
      COUNT(*) OVER () AS buyer_count FROM totals WHERE amount > 0
  ), invoice_counts AS (
    SELECT customer_id, COUNT(*) AS n FROM office_sales_v1 GROUP BY customer_id
  ), customer_ranks AS (
    SELECT c.id,c.name,c.phone,c.active,COALESCE(t.amount,0) AS amount,
      COALESCE(ic.n,0) AS invoice_count,b.position,b.buyer_count
    FROM customers c LEFT JOIN totals t ON t.customer_id=c.id
      LEFT JOIN buyers b ON b.customer_id=c.id LEFT JOIN invoice_counts ic ON ic.customer_id=c.id
  )`;
  const shapeCustomerRank = (row: Record<string, any>) => ({
    id: String(row.id), name: String(row.name), phone: String(row.phone || ''), active: !!row.active,
    purchases: Number(row.amount)/100, invoiceCount: Number(row.invoice_count),
    rank: row.position === null ? null : Number(row.position),
    category: row.position === null ? null : ['A','B','C','D'][Math.min(3, Math.floor((Number(row.position)-1)*4/Number(row.buyer_count)))],
  });
  router.get('/customer-ranking', (req,res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0,120) : '';
    const offset = Number(req.query.offset ?? 0), limit = 20;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) { res.status(400).json({error:'راجع صفحة العملاء.'}); return; }
    const match = `WHERE (?='' OR instr(lower(name),lower(?))>0 OR instr(phone,?)>0)`;
    const args = [query,query,query];
    const count = Number(store.get(`SELECT COUNT(*) AS n FROM customers ${match}`,...args)?.n || 0);
    const rows = store.all(`${customerRankCte} SELECT * FROM customer_ranks ${match}
      ORDER BY amount DESC,name COLLATE NOCASE,id LIMIT ? OFFSET ?`,...args,limit,offset);
    res.setHeader('Cache-Control','private, no-store');
    res.json({customers:rows.map(shapeCustomerRank),total:count,offset,limit,hasMore:offset+rows.length<count,updatedAt:Date.now()});
  });
  router.get('/customer-ranking/:customerId', (req,res) => {
    const id=String(req.params.customerId), offset=Number(req.query.offset ?? 0), limit=20;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) { res.status(400).json({error:'راجع صفحة الفواتير.'}); return; }
    const customer = store.get(`${customerRankCte} SELECT * FROM customer_ranks WHERE id=?`,id);
    if (!customer) { res.status(404).json({error:'العميل غير موجود.'}); return; }
    const invoices = store.all(`SELECT s.id,n.number AS invoiceNumber,s.total_piasters AS original,s.paid_piasters AS paid,s.created_at AS createdAt,
      s.total_piasters-COALESCE((SELECT SUM(cl.amount_piasters) FROM office_corrections_v1 x
        JOIN office_correction_lines_v1 cl ON cl.correction_id=x.id WHERE x.sale_id=s.id),0) AS net,
      EXISTS(SELECT 1 FROM office_corrections_v1 x WHERE x.sale_id=s.id) AS corrected
      FROM office_sales_v1 s LEFT JOIN office_invoice_numbers_v1 n ON n.sale_id=s.id
      WHERE s.customer_id=? ORDER BY s.created_at DESC,s.rowid DESC LIMIT ? OFFSET ?`,id,limit+1,offset);
    const signed=balance(id), opening=!!store.get('SELECT 1 FROM office_debts_v1 WHERE customer_id=?',id);
    res.setHeader('Cache-Control','private, no-store');
    res.json({customer:shapeCustomerRank(customer),due:Math.max(signed,0)/100,credit:Math.max(-signed,0)/100,hasOpening:opening,
      invoices:invoices.slice(0,limit).map(i=>({...i,original:Number(i.original)/100,paid:Number(i.paid)/100,net:Number(i.net)/100,corrected:!!i.corrected})),
      offset,hasMore:invoices.length>limit,updatedAt:Date.now()});
  });
  // A read-only trace lets the office reconcile the numbers without editing historical entries.
  router.get('/statement/:customerId', (req,res) => {
    const so=Number(req.query.salesOffset??0),ro=Number(req.query.receiptsOffset??0);
    if(!Number.isSafeInteger(so)||!Number.isSafeInteger(ro)||so<0||ro<0||so>10000000||ro>10000000){res.status(400).json({error:'راجع صفحة كشف الحساب.'});return;}
    const customer=store.get('SELECT id,name,phone FROM customers WHERE id=?',String(req.params.customerId));
    if(!customer){res.status(404).json({error:'العميل غير موجود.'});return;}
    const opening=store.get('SELECT amount_piasters AS amount,actor_name AS actorName,created_at AS createdAt FROM office_debts_v1 WHERE customer_id=?',customer.id);
    const sales=store.all(`SELECT s.id,(SELECT number FROM office_invoice_numbers_v1 n WHERE n.sale_id=s.id) AS invoiceNumber,s.total_piasters AS total,s.paid_piasters AS paid,s.actor_name AS actorName,s.created_at AS createdAt,s.order_id AS orderId,
      w.name AS warehouseName,CASE WHEN a.sale_id IS NOT NULL THEN a.rep_name ELSE COALESCE(u.name,'') END AS repName,
      CASE WHEN a.sale_id IS NULL AND u.id IS NOT NULL THEN 'legacy' WHEN a.sale_id IS NULL THEN 'unknown' ELSE a.source END AS repSource,
      CASE WHEN a.sale_id IS NOT NULL AND a.rep_id IS NULL AND a.rep_name<>'' THEN 1 ELSE 0 END AS repDeleted
      FROM office_sales_v1 s JOIN warehouses w ON w.id=s.warehouse_id
      LEFT JOIN office_sale_rep_v1 a ON a.sale_id=s.id LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN users u ON u.id=o.user_id
      WHERE s.customer_id=? ORDER BY s.created_at DESC,s.rowid DESC LIMIT 101 OFFSET ?`,customer.id,so);
    const receipts=store.all('SELECT id,amount_piasters AS amount,actor_name AS actorName,created_at AS createdAt FROM office_receipts_v1 WHERE customer_id=? ORDER BY created_at DESC,rowid DESC LIMIT 101 OFFSET ?',customer.id,ro);
    const moreSales=sales.length>100,moreReceipts=receipts.length>100;
    const signed=balance(String(customer.id));
    res.json({customer,opening:opening?{...opening,amount:Number(opening.amount)/100}:null,balance:signed/100,due:Math.max(signed,0)/100,credit:Math.max(-signed,0)/100,moreSales,moreReceipts,salesOffset:so,receiptsOffset:ro,
      sales:sales.slice(0,100).map(s=>({...s,total:Number(s.total)/100,paid:Number(s.paid)/100,corrected:!!store.get('SELECT 1 FROM office_corrections_v1 WHERE sale_id=?',s.id),
        lines:store.all('SELECT product_name AS name,unit,unit_size AS unitSize,milli_qty AS qty,price_piasters AS price,line_piasters AS amount FROM office_sales_lines_v1 WHERE sale_id=? ORDER BY rowid',s.id)
          .map(l=>({...l,qty:Number(l.qty)/1000,price:Number(l.price)/100,amount:Number(l.amount)/100}))})),
      receipts:receipts.slice(0,100).map(r=>({...r,amount:Number(r.amount)/100,corrected:!!store.get('SELECT 1 FROM office_corrections_v1 WHERE receipt_id=?',r.id)}))});
  });
  router.get('/overview', (_req,res) => {
    const totals=store.get(`SELECT COUNT(*) AS count,COALESCE(SUM(total_piasters),0) AS sales FROM office_sales_net_v1`)!;
    const paid=Number(store.get('SELECT COALESCE(SUM(paid_piasters),0) AS n FROM office_sales_v1')?.n||0);
    const receipts=Number(store.get('SELECT COALESCE(SUM(amount_piasters),0) AS n FROM office_receipts_v1')?.n||0);
    const cashCorrections=Number(store.get('SELECT COALESCE(SUM(cash_piasters),0) AS n FROM office_corrections_v1')?.n||0);
    const accounts=store.all('SELECT id,name,phone FROM customers').map(c=>({...c,balance:balance(String(c.id))}));
    const debtors=accounts.filter(c=>c.balance>0).sort((a,b)=>b.balance-a.balance);
    const creditors=accounts.filter(c=>c.balance<0).sort((a,b)=>a.balance-b.balance);
    const latest=store.all(`SELECT s.id,(SELECT number FROM office_invoice_numbers_v1 n WHERE n.sale_id=s.id) AS invoiceNumber,s.order_id AS orderId,c.name AS customerName,w.name AS warehouseName,
      s.total_piasters AS total,s.paid_piasters AS paid,s.created_at AS createdAt, EXISTS(SELECT 1 FROM office_corrections_v1 x WHERE x.sale_id=s.id) AS corrected FROM office_sales_v1 s
      JOIN customers c ON c.id=s.customer_id JOIN warehouses w ON w.id=s.warehouse_id ORDER BY s.created_at DESC,s.rowid DESC LIMIT 50`);
    const soldItems=store.all(`SELECT product_name AS name,unit,unit_size AS unitSize,SUM(milli_qty) AS qty,SUM(line_piasters) AS amount
      FROM office_sales_lines_net_v1 WHERE milli_qty>0 GROUP BY product_id,product_name,unit,unit_size ORDER BY amount DESC,name COLLATE NOCASE`);
    const payments=store.all(`SELECT c.name AS customerName,r.amount_piasters AS amount,r.created_at AS createdAt, EXISTS(SELECT 1 FROM office_corrections_v1 x WHERE x.receipt_id=r.id) AS corrected
      FROM office_receipts_v1 r JOIN customers c ON c.id=r.customer_id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 50`);
    const stock=store.all(`SELECT w.id AS warehouseId,w.name AS warehouseName,p.id AS productId,p.name AS productName,p.unit,p.unit_size AS unitSize,
      s.milli_qty AS qty FROM warehouse_stock s JOIN warehouses w ON w.id=s.warehouse_id JOIN products p ON p.id=s.product_id
      WHERE p.active=1 AND w.id NOT IN (SELECT warehouse_id FROM damaged_warehouse_v1) ORDER BY w.name COLLATE NOCASE,p.name COLLATE NOCASE`);
    res.json({ count:Number(totals.count), sales:Number(totals.sales)/100, collected:(paid+receipts-cashCorrections)/100,
      due:debtors.reduce((sum,row)=>sum+row.balance,0)/100,credit:creditors.reduce((sum,row)=>sum-row.balance,0)/100,
      debtors:debtors.map(x=>({...x,due:x.balance/100})),creditors:creditors.map(x=>({...x,credit:-x.balance/100})), latest:latest.map(x=>({...x,total:Number(x.total)/100,paid:Number(x.paid)/100})),
      soldItems:soldItems.map(x=>({...x,qty:Number(x.qty)/1000,amount:Number(x.amount)/100})),
      payments:payments.map(x=>({...x,amount:Number(x.amount)/100})),
      stock:stock.map(x=>({...x,qty:x.qty===null?null:Number(x.qty)/1000})) });
  });
  // All amounts sent to the correction API are integer piasters / thousandths of a unit.
  // Corrections and physical returns are independent: a return may be recorded later, but
  // cannot exceed the corrected quantity. Cash corrections can never exceed the original payment.
  function detail(type:string,targetId:string) {
    if(type!=='sale'&&type!=='receipt')return null;
    const sale=type==='sale';
    const record=sale?store.get(`SELECT s.id,(SELECT number FROM office_invoice_numbers_v1 n WHERE n.sale_id=s.id) AS invoiceNumber,s.customer_id AS customerId,s.warehouse_id AS warehouseId,s.total_piasters AS total,
      s.paid_piasters AS paid,s.created_at AS createdAt,s.actor_name AS actorName,c.name AS currentName,c.phone AS currentPhone,
      c.governorate AS currentGovernorate,c.district AS currentDistrict,c.village AS currentVillage,w.name AS currentWarehouse
      FROM office_sales_v1 s JOIN customers c ON c.id=s.customer_id JOIN warehouses w ON w.id=s.warehouse_id WHERE s.id=?`,targetId):
      store.get('SELECT r.id,r.customer_id AS customerId,r.amount_piasters AS paid,r.created_at AS createdAt,r.actor_name AS actorName,c.name AS currentName FROM office_receipts_v1 r JOIN customers c ON c.id=r.customer_id WHERE r.id=?',targetId);
    if(!record)return null;
    const key=sale?'sale_id':'receipt_id';
    const events=store.all(`SELECT id,reason,cash_kind AS cashKind,cash_piasters AS cash,actor_name AS actorName,created_at AS createdAt FROM office_corrections_v1 WHERE ${key}=? ORDER BY created_at,rowid`,targetId)
      .map(e=>({...e,lines:store.all(`SELECT l.product_name AS name,l.unit,l.unit_size AS unitSize,cl.corrected_milli AS corrected,cl.returned_milli AS returned,cl.amount_piasters AS amount,cl.stock_kind AS stockKind,
         COALESCE(d.milli_qty,0) AS damaged, w.name AS damagedWarehouseName
         FROM office_correction_lines_v1 cl JOIN office_sales_lines_v1 l ON l.id=cl.line_id
         LEFT JOIN damaged_return_lines_v1 d ON d.correction_id=cl.correction_id AND d.line_id=cl.line_id
         LEFT JOIN warehouses w ON w.id=d.warehouse_id WHERE cl.correction_id=? ORDER BY l.rowid`,e.id)}));
    const lines=sale?store.all(`SELECT l.id,l.product_name AS name,l.unit,l.unit_size AS unitSize,l.milli_qty AS qty,l.price_piasters AS price,l.line_piasters AS amount,
      COALESCE((SELECT SUM(corrected_milli) FROM office_correction_lines_v1 cl WHERE cl.line_id=l.id),0) AS corrected,
      COALESCE((SELECT SUM(returned_milli) FROM office_correction_lines_v1 cl WHERE cl.line_id=l.id),0) AS returned,
      COALESCE((SELECT SUM(amount_piasters) FROM office_correction_lines_v1 cl WHERE cl.line_id=l.id),0) AS correctedAmount
      FROM office_sales_lines_v1 l WHERE l.sale_id=? ORDER BY l.rowid`,targetId):[];
    const snapshot=sale?store.get('SELECT customer_name AS customerName,phone,governorate,district,village,warehouse_name AS warehouseName,rep_name AS repName FROM office_invoice_snapshots_v1 WHERE sale_id=?',targetId):null;
    const version=createHash('sha256').update(JSON.stringify({record,snapshot:snapshot??null,lines,events})).digest('hex');
    return {type,record,lines,events,version,revision:events.length,balancePiasters:balance(String(record.customerId)),
      cashRemaining:Number(record.paid)-Number(store.get(`SELECT COALESCE(SUM(cash_piasters),0) AS n FROM office_corrections_v1 WHERE ${key}=?`,targetId)?.n||0),snapshot:snapshot??null};
  }
  const readDetail=(type:string,targetId:string):ReturnType<typeof detail>=>{let result:ReturnType<typeof detail>=null;store.transaction(()=>{result=detail(type,targetId);});return result;};
  router.get('/invoice/:saleId/pdf',async(req,res)=>{
    const id=String(req.params.saleId);if(!z.uuid().safeParse(id).success){res.status(404).json({error:'البيعة غير موجودة.'});return;}
    const current=readDetail('sale',id);if(!current){res.status(404).json({error:'البيعة غير موجودة.'});return;}
    if(typeof req.query.version!=='string'||req.query.version!==current.version){res.status(409).json({error:'الفاتورة اتغيرت. ارجع وافتحها من جديد قبل التحميل.',code:'INVOICE_CHANGED'});return;}
    try {
      const bytes=await invoicePdf(current,timezone,Date.now());
      res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="invoice-${current.record.invoiceNumber}.pdf"`);res.send(bytes);
    }catch(error){console.error('[invoice pdf]',error);res.status(500).json({error:'تعذر إنشاء ملف الفاتورة. حاول مرة أخرى.'});}
  });
  router.get('/corrections/:type/:targetId',(req,res)=>{
    const result=readDetail(String(req.params.type),String(req.params.targetId));
    if(!result){res.status(404).json({error:'العملية غير موجودة.'});return;}
    res.setHeader('Cache-Control','private, no-store');res.json(result);
  });
  router.post('/corrections/:type/:targetId',(req,res)=>{
    const type=String(req.params.type),targetId=String(req.params.targetId), parsed=correctionBody.safeParse(req.body);
    if(!parsed.success || (type!=='sale'&&type!=='receipt')){res.status(400).json({error:'راجع بيانات التصحيح وسببه.'});return;}
    const data=parsed.data,actor=res.locals.user,request=JSON.stringify({type,targetId,...data});
    const old=duplicate('office_corrections_v1',data.id,request,actor.id);
    if(old){res.status(old===1?200:409).json(old===1?{ok:true,duplicate:true}:{error:'رقم العملية مستخدم لبيانات مختلفة.'});return;}
    let replay=false;
    try {store.transaction(()=>{
      const locked=duplicate('office_corrections_v1',data.id,request,actor.id);
      if(locked===1){replay=true;return;} if(locked===-1)throw Error('REQUEST_CONFLICT');
      const current=detail(type,targetId);if(!current)throw Error('NOT_FOUND');
      if(current.balancePiasters!==data.balancePiasters || current.revision!==data.revision)throw Error('STALE');
      if(new Set(data.lines.map(l=>l.lineId)).size!==data.lines.length || (type==='receipt'&&data.lines.length))throw Error('LINES');
      if(!data.cash&&!data.lines.some(l=>l.correctedMilli||l.returnedMilli))throw Error('EMPTY');
      if(data.cash && data.cash.amountPiasters>current.cashRemaining)throw Error('CASH');
      const calculated=data.lines.map(x=>{
        const line=current.lines.find(l=>l.id===x.lineId);if(!line || (!x.correctedMilli&&!x.returnedMilli) || (!!x.returnedMilli !== !!x.stockKind))throw Error('LINES');
        if ((x.damagedMilli ?? 0) > x.returnedMilli || ((x.damagedMilli ?? 0)>0 && x.stockKind!=='returned')) throw Error('LINES');
        const corrected=Number(line.corrected)+x.correctedMilli, returned=Number(line.returned)+x.returnedMilli;
        if(corrected>Number(line.qty)||returned>corrected)throw Error('QUANTITY');
        // Cumulative rounding means splitting a correction cannot create or lose piasters.
        const cumulative=Number((BigInt(corrected)*BigInt(Number(line.price))+500n)/1000n);
        const amount=cumulative-Number(line.correctedAmount);
        if(amount<0||cumulative>Number(line.amount))throw Error('QUANTITY');
        return {...x,line,amount};
      });
      const now=Date.now();
      const invoiceReference=current.record.invoiceNumber == null ? `البيعة ${targetId}` : `الفاتورة رقم ${current.record.invoiceNumber}`;
      store.run('INSERT INTO office_corrections_v1 VALUES(?,?,?,?,?,?,?,?,?,?)',data.id,type==='sale'?targetId:null,type==='receipt'?targetId:null,data.reason,data.cash?.kind??null,data.cash?.amountPiasters??0,actor.id,actor.name,request,now);
      for(const x of calculated){
        store.run('INSERT INTO office_correction_lines_v1 VALUES(?,?,?,?,?,?)',data.id,x.lineId,x.correctedMilli,x.returnedMilli,x.amount,x.stockKind);
        if(x.returnedMilli){
          const damaged=x.damagedMilli ?? 0, good=x.returnedMilli-damaged;
          const product=store.get('SELECT product_id FROM office_sales_lines_v1 WHERE id=?',x.lineId)!;
          if(good){
            const stock=store.get('SELECT milli_qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?',current.record.warehouseId,product.product_id);
            if(!stock || Number(stock.milli_qty)>Number.MAX_SAFE_INTEGER-good)throw Error('STOCK');
            store.run('UPDATE warehouse_stock SET milli_qty=milli_qty+? WHERE warehouse_id=? AND product_id=?',good,current.record.warehouseId,product.product_id);
            store.run("INSERT INTO inventory_movements(id,kind,product_id,from_warehouse_id,to_warehouse_id,milli_qty,note,actor_id,actor_name,created_at) VALUES(?,'in',?,NULL,?,?,?,?,?,?)",randomUUID(),product.product_id,current.record.warehouseId,good,`${x.stockKind==='error'?'تصحيح خصم مخزون بالخطأ':'إرجاع بضاعة سليمة'} لـ${invoiceReference} - مرجع التصحيح ${data.id}`,actor.id,actor.name,now);
          }
          if(damaged){
            const damagedId=damagedWarehouse(now);
            const stock=store.get('SELECT milli_qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?',damagedId,product.product_id);
            if(stock && Number(stock.milli_qty)>Number.MAX_SAFE_INTEGER-damaged)throw Error('STOCK');
            store.run('INSERT INTO warehouse_stock(warehouse_id,product_id,milli_qty) VALUES(?,?,?) ON CONFLICT(warehouse_id,product_id) DO UPDATE SET milli_qty=milli_qty+excluded.milli_qty',damagedId,product.product_id,damaged);
            store.run("INSERT INTO inventory_movements(id,kind,product_id,from_warehouse_id,to_warehouse_id,milli_qty,note,actor_id,actor_name,created_at) VALUES(?,'in',?,NULL,?,?,?,?,?,?)",randomUUID(),product.product_id,damagedId,damaged,`مرتجع تالف لـ${invoiceReference} - مرجع التصحيح ${data.id}`,actor.id,actor.name,now);
            store.run('INSERT INTO damaged_return_lines_v1(correction_id,line_id,warehouse_id,milli_qty) VALUES(?,?,?,?)',data.id,x.lineId,damagedId,damaged);
          }
        }
      }
      store.audit(actor.id,'sales.correction',{correctionId:data.id,type,targetId});
    });}catch(e){const code=(e as Error).message;const errors:Record<string,string>={REQUEST_CONFLICT:'رقم العملية مستخدم لبيانات مختلفة.',NOT_FOUND:'العملية غير موجودة.',STALE:'الحساب أو التصحيحات اتغيرت؛ افتح العملية وراجعها من جديد.',LINES:'راجع أصناف التصحيح.',EMPTY:'حدد تغييرًا واحدًا على الأقل.',CASH:'المبلغ أكبر من المدفوع المتبقي في العملية.',QUANTITY:'الكمية أكبر من المسموح أو البضاعة المرتجعة أكبر من الكمية المصححة.',STOCK:'تعذر إضافة المرتجع للمخزن؛ راجع المسؤول.'};if(errors[code]){res.status(409).json({error:errors[code],code});return;}throw e;}
    if(replay){res.json({ok:true,duplicate:true});return;}
    res.status(201).json({ok:true,duplicate:false});
  });
  router.post('/', (req,res) => {
    const parsed=bodySale.safeParse(req.body); if (!parsed.success) {res.status(400).json({error:'راجع العميل والمخزن والأصناف والمبالغ.'});return;}
    const data=parsed.data, request=JSON.stringify(data), actor=res.locals.user;
    const old=duplicate('office_sales_v1',data.id,request,actor.id);
    if (old) {res.status(old===1?200:409).json(old===1?{ok:true,duplicate:true}:{error:'رقم العملية مستخدم لبيانات مختلفة.'});return;}
    let replay=false;
    try {
      store.transaction(()=>{
        // Repeat the check under the database write lock: another process may have committed
        // this exact invoice after the first check but before BEGIN IMMEDIATE completed.
        const locked=duplicate('office_sales_v1',data.id,request,actor.id);
        if (locked===1) {replay=true;return;}
        if (locked===-1) throw Error('REQUEST_CONFLICT');
        const customer=store.get('SELECT id,active,name,phone,governorate,district,village FROM customers WHERE id=?',data.customerId); if (!customer?.active) throw Error('CUSTOMER');
        const warehouse=store.get('SELECT id,name FROM warehouses WHERE id=? AND id NOT IN (SELECT warehouse_id FROM damaged_warehouse_v1)',data.warehouseId); if (!warehouse) throw Error('WAREHOUSE');
        if (!exact(data.paid,100)) throw Error('PRECISION');
        let lines: {productId:string;qty:number;price:number;name:string;unit:string;unitSize:string}[]=[];
        let pricedOrderTotal: number | undefined;
        let saleRep: {id:string;name:string} | null=null;
        if (data.orderId) {
          if(data.repId) throw Error('ORDER');
          const order=store.get("SELECT o.id,o.status,o.customer_id,o.total,o.user_id,o.recommendation,u.name AS rep_name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=? AND o.status IN ('sent','priced')",data.orderId);
          if(!order || order.customer_id!==data.customerId) throw Error('ORDER');
          if(store.get('SELECT id FROM office_sales_v1 WHERE order_id=?',data.orderId)) throw Error('ORDER_SOLD');
          saleRep={id:String(order.user_id),name:String(order.rep_name)};
          const recommended=store.all('SELECT product_id AS productId,qty,price,product_name AS name,unit,unit_size AS unitSize FROM order_lines WHERE order_id=? ORDER BY position',data.orderId);
          if (order.status === 'sent' && String(order.recommendation).trim() && recommended.length === 0) {
            // Free text is never parsed into a product or a quantity. The office explicitly
            // chooses real active products, units, quantities and prices for the invoice.
            if (!data.lines.length || new Set(data.lines.map(line=>line.productId)).size!==data.lines.length) throw Error('ORDER_LINES');
            lines=data.lines.map(line=>{const product=store.get('SELECT id,name,unit,unit_size AS unitSize,active FROM products WHERE id=?',line.productId);if(!product?.active)throw Error('PRODUCT');return {...line,name:String(product.name),unit:String(product.unit),unitSize:String(product.unitSize)};});
          } else if(order.status==='priced' && !data.lines.length) {
            // Older office-priced orders remain frozen; never silently overwrite their agreement.
            if(typeof order.total!=='number' || !Number.isFinite(order.total) || Math.abs(order.total*100-Math.round(order.total*100)) >= 0.00001) throw Error('ORDER_TOTAL');
            pricedOrderTotal=cents(order.total);
            lines=recommended as typeof lines;
          } else {
            // Field quantities are recommendations, including historical priced orders. The office confirms sold
            // quantities and prices, without altering the original order or adding other products.
            if(!data.lines.length || new Set(data.lines.map(l=>l.productId)).size!==data.lines.length)throw Error('ORDER_LINES');
            const byId=new Map(recommended.map(line=>[String(line.productId),line]));
            if(data.lines.some(line=>!byId.has(line.productId)))throw Error('ORDER_LINES');
            const actual=new Map(data.lines.map(line=>[line.productId,line]));
            lines=recommended.filter(line=>actual.has(String(line.productId))).map(line=>{
              const edit=actual.get(String(line.productId))!;
              return {...edit,name:String(line.name),unit:String(line.unit),unitSize:String(line.unitSize)};
            });
          }
        } else {
          if (!data.lines.length) throw Error('PRODUCT');
          if(data.repId){const rep=store.get("SELECT id,name FROM users WHERE id=? AND role='rep' AND active=1",data.repId);if(!rep)throw Error('REP');saleRep={id:String(rep.id),name:String(rep.name)};}
          lines=data.lines.map(line=>{const product=store.get('SELECT id,name,unit,unit_size AS unitSize,active FROM products WHERE id=?',line.productId);if(!product?.active)throw Error('PRODUCT');return {...line,name:String(product.name),unit:String(product.unit),unitSize:String(product.unitSize)};});
        }
        if (!lines.length || new Set(lines.map(l=>l.productId)).size!==lines.length) throw Error('DUPLICATE_PRODUCT');
        // A historical order snapshots its pack. Stock is keyed by product id, so never deduct
        // a current 5-litre pack for an order and invoice that say 1 litre.
        if (data.orderId) for (const line of lines) {
          const current = store.get('SELECT unit,unit_size AS unitSize FROM products WHERE id=?', line.productId);
          if (!current || current.unit !== line.unit || current.unitSize !== line.unitSize) throw Error('ORDER_PRODUCT_CHANGED');
        }
        let total=0; const calculated=lines.map(line=>{
          if (!Number.isFinite(line.price) || line.price<0 || line.price>1_000_000_000 || !Number.isFinite(line.qty) || line.qty>100_000 || !exact(line.price,100) || !exact(line.qty,1000) || milli(line.qty)<1) throw Error('PRECISION');
          const amount=Number((BigInt(milli(line.qty))*BigInt(cents(line.price))+500n)/1000n);
          total+=amount; if(!Number.isSafeInteger(total)||total>100_000_000_000)throw Error('BIG');
          return {...line,qtyMilli:milli(line.qty),priceCents:cents(line.price),amount};
        });
        // A priced order has a previously agreed total. Never silently charge a different amount
        // because its historic whole-order rounding differs from the sales ledger's line rounding.
        if(pricedOrderTotal!==undefined && pricedOrderTotal!==total) throw Error('ORDER_TOTAL');
        const paid=cents(data.paid); if (paid>total) throw Error('PAID');
        const now=Date.now();
        store.run('INSERT INTO office_sales_v1 VALUES(?,?,?,?,?,?,?,?,?,?)',data.id,data.orderId??null,data.customerId,data.warehouseId,total,paid,actor.id,actor.name,request,now);
        store.run('INSERT INTO office_invoice_numbers_v1(sale_id) VALUES(?)',data.id);
        const invoiceNumber=Number(store.get('SELECT number FROM office_invoice_numbers_v1 WHERE sale_id=?',data.id)!.number);
        store.run('INSERT INTO office_sale_rep_v1(sale_id,rep_id,rep_name,source) VALUES(?,?,?,?)',data.id,saleRep?.id??null,saleRep?.name??'',data.orderId?'order':saleRep?'direct':'none');
        store.run('INSERT INTO office_invoice_snapshots_v1 VALUES(?,?,?,?,?,?,?,?)',data.id,customer.name,customer.phone,customer.governorate,customer.district,customer.village,warehouse.name,saleRep?.name??'');
        for (const line of calculated) {
          if (!store.get('SELECT 1 FROM warehouse_stock WHERE warehouse_id=? AND product_id=?',data.warehouseId,line.productId)) throw Error('NO_OPENING');
          if (!store.run('UPDATE warehouse_stock SET milli_qty=milli_qty-? WHERE warehouse_id=? AND product_id=? AND milli_qty>=?',line.qtyMilli,data.warehouseId,line.productId,line.qtyMilli).changes) throw Error('SHORT');
          store.run('INSERT INTO office_sales_lines_v1 VALUES(?,?,?,?,?,?,?,?,?)',randomUUID(),data.id,line.productId,line.name,line.unit,line.unitSize,line.qtyMilli,line.priceCents,line.amount);
          store.run("INSERT INTO inventory_movements(id,kind,product_id,from_warehouse_id,to_warehouse_id,milli_qty,note,actor_id,actor_name,created_at) VALUES(?,'out',?,?,NULL,?,?,?,?,?)",randomUUID(),line.productId,data.warehouseId,line.qtyMilli,`صرف للفاتورة رقم ${invoiceNumber}`,actor.id,actor.name,now);
        }
        if(data.orderId) store.run('INSERT INTO order_invoice_notices_v1(order_id,user_id,created_at) SELECT id,user_id,? FROM orders WHERE id=?',now,data.orderId);
        store.audit(actor.id,'sales.confirm',{saleId:data.id,customerId:data.customerId,orderId:data.orderId??null});
      });
    } catch(e) { const code=(e as Error).message; if(code==='REQUEST_CONFLICT'){res.status(409).json({error:'رقم العملية مستخدم لبيانات مختلفة.'});return;} if (['CUSTOMER','WAREHOUSE','ORDER','ORDER_CHANGED','ORDER_LINES','ORDER_SOLD','ORDER_TOTAL','ORDER_PRODUCT_CHANGED','REP','PRODUCT','DUPLICATE_PRODUCT','PRECISION','NO_OPENING','SHORT','PAID','BIG'].includes(code)) {res.status(409).json({error:fail(code),code});return;} throw e; }
    if(replay){res.json({ok:true,duplicate:true});return;}
    if(data.orderId){try{onOrderSold(data.orderId);}catch(e){console.error('[sales] order notification failed',e);}}
    res.status(201).json({ok:true,duplicate:false});
  });
  router.post('/opening', (req,res) => {
    const parsed=bodyEntry.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'اكتب المديونية بالجنيه والقرش.'});return;}
    const data=parsed.data, request=JSON.stringify(data), actor=res.locals.user, old=duplicate('office_debts_v1',data.id,request,actor.id);
    if(old){res.status(old===1?200:409).json(old===1?{ok:true,duplicate:true}:{error:'رقم العملية مستخدم لبيانات مختلفة.'});return;}
    if(!exact(data.amount,100)){res.status(400).json({error:'اكتب المديونية بالجنيه والقرش.'});return;}
    let replay=false;
    try { store.transaction(()=>{
      const locked=duplicate('office_debts_v1',data.id,request,actor.id);
      if(locked===1){replay=true;return;} if(locked===-1)throw Error('REQUEST_CONFLICT');
      if(!store.get('SELECT 1 FROM customers WHERE id=? AND active=1',data.customerId))throw Error('CUSTOMER');
      if(store.get('SELECT 1 FROM office_debts_v1 WHERE customer_id=?',data.customerId))throw Error('OPENING');
      store.run('INSERT INTO office_debts_v1 VALUES(?,?,?,?,?,?,?)',data.id,data.customerId,cents(data.amount),actor.id,actor.name,request,Date.now());
      store.audit(actor.id,'sales.opening',{customerId:data.customerId});
    }); } catch(e) {const code=(e as Error).message;if(code==='REQUEST_CONFLICT'){res.status(409).json({error:'رقم العملية مستخدم لبيانات مختلفة.'});return;}if(['CUSTOMER','OPENING'].includes(code)){res.status(409).json({error:fail(code),code});return;}throw e;}
    if(replay){res.json({ok:true,duplicate:true});return;}
    res.status(201).json({ok:true,duplicate:false});
  });
  router.post('/receipts', (req,res) => {
    const parsed=bodyEntry.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'اكتب مبلغ الدفعة بالجنيه والقرش.'});return;}
    const data=parsed.data, request=JSON.stringify(data), actor=res.locals.user, old=duplicate('office_receipts_v1',data.id,request,actor.id);
    if(old){res.status(old===1?200:409).json(old===1?{ok:true,duplicate:true}:{error:'رقم العملية مستخدم لبيانات مختلفة.'});return;}
    if(!exact(data.amount,100)||data.amount<=0){res.status(400).json({error:'اكتب مبلغ الدفعة بالجنيه والقرش.'});return;}
    let replay=false;
    try {store.transaction(()=>{
      const locked=duplicate('office_receipts_v1',data.id,request,actor.id);
      if(locked===1){replay=true;return;} if(locked===-1)throw Error('REQUEST_CONFLICT');
      if(!store.get('SELECT 1 FROM customers WHERE id=?',data.customerId))throw Error('CUSTOMER');
      if(cents(data.amount)>balance(data.customerId))throw Error('PAYMENT');
      store.run('INSERT INTO office_receipts_v1 VALUES(?,?,?,?,?,?,?)',data.id,data.customerId,cents(data.amount),actor.id,actor.name,request,Date.now());
      store.audit(actor.id,'sales.receipt',{receiptId:data.id,customerId:data.customerId});
    });} catch(e){const code=(e as Error).message;if(code==='REQUEST_CONFLICT'){res.status(409).json({error:'رقم العملية مستخدم لبيانات مختلفة.'});return;}if(['CUSTOMER','PAYMENT'].includes(code)){res.status(409).json({error:fail(code),code});return;}throw e;}
    if(replay){res.json({ok:true,duplicate:true});return;}
    res.status(201).json({ok:true,duplicate:false});
  });
  return router;
}
