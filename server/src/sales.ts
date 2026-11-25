import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './db.js';

const id = z.uuid();
const entityId = z.string().trim().min(1).max(64);
const money = z.number().finite().nonnegative().max(1_000_000_000);
const quantity = z.number().finite().positive().max(100_000);
const cents = (n: number) => Math.round(n * 100);
const milli = (n: number) => Math.round(n * 1000);
const exact = (n: number, scale: number) => Math.abs(n * scale - Math.round(n * scale)) < 0.00001;
const bodySale = z.object({ id, customerId:entityId, warehouseId:entityId, orderId:entityId.optional(), paid:money,
  lines:z.array(z.object({productId:entityId,qty:quantity,price:money}).strict()).max(100).default([]) }).strict();
const bodyEntry = z.object({id,customerId:entityId,amount:money}).strict();

/** Office-only confirmed sales; a priced order is not itself a sale or a payment. */
export function createSalesRouter(store: Store) {
  const router = Router();
  const balance = (customerId: string): number => Number(store.get(`SELECT
    COALESCE((SELECT SUM(amount_piasters) FROM office_debts_v1 WHERE customer_id=?),0)
    + COALESCE((SELECT SUM(total_piasters-paid_piasters) FROM office_sales_v1 WHERE customer_id=?),0)
    - COALESCE((SELECT SUM(amount_piasters) FROM office_receipts_v1 WHERE customer_id=?),0) AS amount`,customerId,customerId,customerId)?.amount || 0);
  const duplicate = (table:'office_sales_v1'|'office_receipts_v1'|'office_debts_v1', entryId:string, payload:string, userId:string) => {
    const old = store.get(`SELECT actor_id,request_json FROM ${table} WHERE id=?`,entryId);
    if (!old) return 0;
    return old.actor_id === userId && old.request_json === payload ? 1 : -1;
  };
  const fail = (code:string) => {
    const errors:Record<string,string> = {
      CUSTOMER:'اختار عميل شغال من القائمة.', WAREHOUSE:'اختار مخزن صحيح.', ORDER:'الطلبية مش متسعّرة أو تخص عميل تاني.',
      ORDER_SOLD:'الطلبية دي اتسجّلت كبيعة قبل كده.', ORDER_TOTAL:'إجمالي الطلبية المتسعّرة مختلف عن حساب البيعة بالقرش. راجع المسؤول قبل التسجيل.', PRODUCT:'الصنف غير موجود أو موقوف.',
      DUPLICATE_PRODUCT:'اختار كل صنف مرة واحدة.', PRECISION:'الكمية تقبل ٣ أرقام عشرية والسعر رقمين عشريين.',
      NO_OPENING:'سجّل الرصيد الافتتاحي للصنف في المخزن الأول.', SHORT:'الكمية المطلوبة أكبر من رصيد المخزن.',
      PAID:'المبلغ المدفوع أكبر من إجمالي البيعة.', BIG:'إجمالي البيعة أكبر من المسموح.',
      OPENING:'المديونية القديمة للعميل اتسجلت قبل كده.', PAYMENT:'الدفعة أكبر من المبلغ المتبقي على العميل.',
    };
    return errors[code] || 'تعذر تسجيل العملية.';
  };
  router.get('/options', (_req,res) => {
    const customers=store.all("SELECT c.id,c.name,c.phone,c.price_tier_id AS priceTierId,EXISTS(SELECT 1 FROM office_debts_v1 d WHERE d.customer_id=c.id) AS hasOpening FROM customers c WHERE c.active=1 ORDER BY c.name COLLATE NOCASE,c.id");
    const products=store.all("SELECT id,name,unit,unit_size AS unitSize FROM products WHERE active=1 ORDER BY name COLLATE NOCASE,id");
    const warehouses=store.all('SELECT id,name FROM warehouses ORDER BY name COLLATE NOCASE,id');
    const prices=store.all('SELECT product_id AS productId,tier_id AS tierId,price FROM product_prices');
    const orders=store.all(`SELECT o.id,o.customer_id AS customerId,c.name AS customerName,o.total,o.priced_at AS pricedAt
      FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.status='priced' AND c.active=1
      AND NOT EXISTS (SELECT 1 FROM office_sales_v1 s WHERE s.order_id=o.id) ORDER BY o.priced_at,o.id`);
    const pendingOrders=orders.map(order=>({...order,lines:store.all('SELECT product_id AS productId,product_name AS name,unit,unit_size AS unitSize,qty,price FROM order_lines WHERE order_id=? ORDER BY position',order.id)}));
    const tiers=store.all('SELECT id,name,active FROM price_tiers ORDER BY position,name COLLATE NOCASE');
    res.json({customers,products,warehouses,prices,tiers,orders:pendingOrders});
  });
  // A read-only trace lets the office reconcile the numbers without editing historical entries.
  router.get('/statement/:customerId', (req,res) => {
    const customer=store.get('SELECT id,name,phone FROM customers WHERE id=?',String(req.params.customerId));
    if(!customer){res.status(404).json({error:'العميل غير موجود.'});return;}
    const opening=store.get('SELECT amount_piasters AS amount,actor_name AS actorName,created_at AS createdAt FROM office_debts_v1 WHERE customer_id=?',customer.id);
    const sales=store.all(`SELECT id,total_piasters AS total,paid_piasters AS paid,actor_name AS actorName,created_at AS createdAt,order_id AS orderId,
      (SELECT name FROM warehouses WHERE id=s.warehouse_id) AS warehouseName FROM office_sales_v1 s WHERE customer_id=? ORDER BY created_at DESC,rowid DESC LIMIT 101`,customer.id);
    const receipts=store.all('SELECT id,amount_piasters AS amount,actor_name AS actorName,created_at AS createdAt FROM office_receipts_v1 WHERE customer_id=? ORDER BY created_at DESC,rowid DESC LIMIT 101',customer.id);
    const moreSales=sales.length>100,moreReceipts=receipts.length>100;
    res.json({customer,opening:opening?{...opening,amount:Number(opening.amount)/100}:null,due:balance(String(customer.id))/100,moreSales,moreReceipts,
      sales:sales.slice(0,100).map(s=>({...s,total:Number(s.total)/100,paid:Number(s.paid)/100,
        lines:store.all('SELECT product_name AS name,unit,unit_size AS unitSize,milli_qty AS qty,price_piasters AS price,line_piasters AS amount FROM office_sales_lines_v1 WHERE sale_id=? ORDER BY rowid',s.id)
          .map(l=>({...l,qty:Number(l.qty)/1000,price:Number(l.price)/100,amount:Number(l.amount)/100}))})),
      receipts:receipts.slice(0,100).map(r=>({...r,amount:Number(r.amount)/100}))});
  });
  router.get('/overview', (_req,res) => {
    const totals=store.get(`SELECT COUNT(*) AS count,COALESCE(SUM(total_piasters),0) AS sales,COALESCE(SUM(paid_piasters),0) AS salePaid FROM office_sales_v1`)!;
    const receipts=Number(store.get('SELECT COALESCE(SUM(amount_piasters),0) AS n FROM office_receipts_v1')?.n || 0);
    const debtors=store.all(`SELECT c.id,c.name,c.phone,
      COALESCE((SELECT SUM(amount_piasters) FROM office_debts_v1 x WHERE x.customer_id=c.id),0)
      +COALESCE((SELECT SUM(total_piasters-paid_piasters) FROM office_sales_v1 s WHERE s.customer_id=c.id),0)
      -COALESCE((SELECT SUM(amount_piasters) FROM office_receipts_v1 r WHERE r.customer_id=c.id),0) AS due
      FROM customers c WHERE due>0 ORDER BY due DESC,c.name COLLATE NOCASE`);
    const latest=store.all(`SELECT s.id,s.order_id AS orderId,c.name AS customerName,w.name AS warehouseName,
      s.total_piasters AS total,s.paid_piasters AS paid,s.created_at AS createdAt FROM office_sales_v1 s
      JOIN customers c ON c.id=s.customer_id JOIN warehouses w ON w.id=s.warehouse_id ORDER BY s.created_at DESC,s.rowid DESC LIMIT 50`);
    const soldItems=store.all(`SELECT product_name AS name,unit,unit_size AS unitSize,SUM(milli_qty) AS qty,SUM(line_piasters) AS amount
      FROM office_sales_lines_v1 GROUP BY product_id,product_name,unit,unit_size ORDER BY amount DESC,name COLLATE NOCASE`);
    const payments=store.all(`SELECT c.name AS customerName,r.amount_piasters AS amount,r.created_at AS createdAt
      FROM office_receipts_v1 r JOIN customers c ON c.id=r.customer_id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 50`);
    const stock=store.all(`SELECT w.id AS warehouseId,w.name AS warehouseName,p.id AS productId,p.name AS productName,p.unit,p.unit_size AS unitSize,
      s.milli_qty AS qty FROM warehouses w CROSS JOIN products p LEFT JOIN warehouse_stock s ON s.warehouse_id=w.id AND s.product_id=p.id
      WHERE p.active=1 ORDER BY w.name COLLATE NOCASE,p.name COLLATE NOCASE`);
    res.json({ count:Number(totals.count), sales:Number(totals.sales)/100, collected:(Number(totals.salePaid)+receipts)/100,
      due:debtors.reduce((sum,row)=>sum+Number(row.due),0)/100,
      debtors:debtors.map(x=>({...x,due:Number(x.due)/100})), latest:latest.map(x=>({...x,total:Number(x.total)/100,paid:Number(x.paid)/100})),
      soldItems:soldItems.map(x=>({...x,qty:Number(x.qty)/1000,amount:Number(x.amount)/100})),
      payments:payments.map(x=>({...x,amount:Number(x.amount)/100})),
      stock:stock.map(x=>({...x,qty:x.qty===null?null:Number(x.qty)/1000})) });
  });
  router.post('/', (req,res) => {
    const parsed=bodySale.safeParse(req.body); if (!parsed.success) {res.status(400).json({error:'راجع العميل والمخزن والأصناف والمبالغ.'});return;}
    const data=parsed.data, request=JSON.stringify(data), actor=res.locals.user;
    const old=duplicate('office_sales_v1',data.id,request,actor.id);
    if (old) {res.status(old===1?200:409).json(old===1?{ok:true,duplicate:true}:{error:'رقم العملية مستخدم لبيانات مختلفة.'});return;}
    try {
      store.transaction(()=>{
        const customer=store.get('SELECT id,active FROM customers WHERE id=?',data.customerId); if (!customer?.active) throw Error('CUSTOMER');
        if (!store.get('SELECT id FROM warehouses WHERE id=?',data.warehouseId)) throw Error('WAREHOUSE');
        if (!exact(data.paid,100)) throw Error('PRECISION');
        let lines: {productId:string;qty:number;price:number;name:string;unit:string;unitSize:string}[]=[];
        let pricedOrderTotal: number | undefined;
        if (data.orderId) {
          if(data.lines.length) throw Error('ORDER');
          const order=store.get("SELECT id,customer_id,total FROM orders WHERE id=? AND status='priced'",data.orderId);
          if(!order || order.customer_id!==data.customerId) throw Error('ORDER');
          if(store.get('SELECT id FROM office_sales_v1 WHERE order_id=?',data.orderId)) throw Error('ORDER_SOLD');
          if(typeof order.total!=='number' || !Number.isFinite(order.total) || !exact(order.total,100)) throw Error('ORDER_TOTAL');
          pricedOrderTotal=cents(order.total);
          lines=store.all('SELECT product_id AS productId,qty,price,product_name AS name,unit,unit_size AS unitSize FROM order_lines WHERE order_id=? ORDER BY position',data.orderId) as typeof lines;
        } else {
          if (!data.lines.length) throw Error('PRODUCT');
          lines=data.lines.map(line=>{const product=store.get('SELECT id,name,unit,unit_size AS unitSize,active FROM products WHERE id=?',line.productId);if(!product?.active)throw Error('PRODUCT');return {...line,name:String(product.name),unit:String(product.unit),unitSize:String(product.unitSize)};});
        }
        if (!lines.length || new Set(lines.map(l=>l.productId)).size!==lines.length) throw Error('DUPLICATE_PRODUCT');
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
        for (const line of calculated) {
          if (!store.get('SELECT 1 FROM warehouse_stock WHERE warehouse_id=? AND product_id=?',data.warehouseId,line.productId)) throw Error('NO_OPENING');
          if (!store.run('UPDATE warehouse_stock SET milli_qty=milli_qty-? WHERE warehouse_id=? AND product_id=? AND milli_qty>=?',line.qtyMilli,data.warehouseId,line.productId,line.qtyMilli).changes) throw Error('SHORT');
          store.run('INSERT INTO office_sales_lines_v1 VALUES(?,?,?,?,?,?,?,?,?)',randomUUID(),data.id,line.productId,line.name,line.unit,line.unitSize,line.qtyMilli,line.priceCents,line.amount);
          store.run("INSERT INTO inventory_movements(id,kind,product_id,from_warehouse_id,to_warehouse_id,milli_qty,note,actor_id,actor_name,created_at) VALUES(?,'out',?,?,NULL,?,?,?,?,?)",randomUUID(),line.productId,data.warehouseId,line.qtyMilli,'صرف لبيعة مؤكدة',actor.id,actor.name,now);
        }
        store.audit(actor.id,'sales.confirm',{saleId:data.id,customerId:data.customerId,orderId:data.orderId??null});
      });
    } catch(e) { const code=(e as Error).message; if (['CUSTOMER','WAREHOUSE','ORDER','ORDER_SOLD','ORDER_TOTAL','PRODUCT','DUPLICATE_PRODUCT','PRECISION','NO_OPENING','SHORT','PAID','BIG'].includes(code)) {res.status(409).json({error:fail(code),code});return;} throw e; }
    res.status(201).json({ok:true,duplicate:false});
  });
  router.post('/opening', (req,res) => {
    const parsed=bodyEntry.safeParse(req.body);if(!parsed.success||!exact(parsed.success?parsed.data.amount:0,100)){res.status(400).json({error:'اكتب المديونية بالجنيه والقرش.'});return;}
    const data=parsed.data, request=JSON.stringify(data), actor=res.locals.user, old=duplicate('office_debts_v1',data.id,request,actor.id);
    if(old){res.status(old===1?200:409).json(old===1?{ok:true,duplicate:true}:{error:'رقم العملية مستخدم لبيانات مختلفة.'});return;}
    try { store.transaction(()=>{
      if(!store.get('SELECT 1 FROM customers WHERE id=? AND active=1',data.customerId))throw Error('CUSTOMER');
      if(store.get('SELECT 1 FROM office_debts_v1 WHERE customer_id=?',data.customerId))throw Error('OPENING');
      store.run('INSERT INTO office_debts_v1 VALUES(?,?,?,?,?,?,?)',data.id,data.customerId,cents(data.amount),actor.id,actor.name,request,Date.now());
      store.audit(actor.id,'sales.opening',{customerId:data.customerId});
    }); } catch(e) {const code=(e as Error).message;if(['CUSTOMER','OPENING'].includes(code)){res.status(409).json({error:fail(code),code});return;}throw e;}
    res.status(201).json({ok:true,duplicate:false});
  });
  router.post('/receipts', (req,res) => {
    const parsed=bodyEntry.safeParse(req.body);if(!parsed.success||!exact(parsed.success?parsed.data.amount:0,100)||!(parsed.success&&parsed.data.amount>0)){res.status(400).json({error:'اكتب مبلغ الدفعة بالجنيه والقرش.'});return;}
    const data=parsed.data, request=JSON.stringify(data), actor=res.locals.user, old=duplicate('office_receipts_v1',data.id,request,actor.id);
    if(old){res.status(old===1?200:409).json(old===1?{ok:true,duplicate:true}:{error:'رقم العملية مستخدم لبيانات مختلفة.'});return;}
    try {store.transaction(()=>{
      if(!store.get('SELECT 1 FROM customers WHERE id=?',data.customerId))throw Error('CUSTOMER');
      if(cents(data.amount)>balance(data.customerId))throw Error('PAYMENT');
      store.run('INSERT INTO office_receipts_v1 VALUES(?,?,?,?,?,?,?)',data.id,data.customerId,cents(data.amount),actor.id,actor.name,request,Date.now());
      store.audit(actor.id,'sales.receipt',{receiptId:data.id,customerId:data.customerId});
    });} catch(e){const code=(e as Error).message;if(['CUSTOMER','PAYMENT'].includes(code)){res.status(409).json({error:fail(code),code});return;}throw e;}
    res.status(201).json({ok:true,duplicate:false});
  });
  return router;
}
