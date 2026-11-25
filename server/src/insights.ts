import { Router } from 'express';
import type { Store } from './db.js';
import { dayBounds, localDate } from './geo.js';

/** Read-only, office-only calculations. Never treat priced orders or collection reports as sales. */
export function createInsightsRouter(store:Store, timezone:string) {
  const router=Router();
  router.get('/',(req,res)=>{
    const today=localDate(timezone);
    const from=typeof req.query.from==='string'?req.query.from:today;
    const to=typeof req.query.to==='string'?req.query.to:from;
    let start:number,end:number;
    try {start=dayBounds(from,timezone).start;end=dayBounds(to,timezone).end;}catch{res.status(400).json({error:'راجع تواريخ الفترة.'});return;}
    if(to<from || (Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000>=366){res.status(400).json({error:'اختار فترة صحيحة لا تزيد عن ٣٦٦ يوم.'});return;}
    const params=[start,end];
    const totals=store.get('SELECT COUNT(*) AS count,COUNT(DISTINCT customer_id) AS customers,COALESCE(SUM(total_piasters),0) AS amount FROM office_sales_v1 WHERE created_at>=? AND created_at<?',...params)!;
    const customers=store.all(`SELECT c.id,c.name,c.phone,COUNT(*) AS count,SUM(s.total_piasters) AS amount
      FROM office_sales_v1 s JOIN customers c ON c.id=s.customer_id
      WHERE s.created_at>=? AND s.created_at<? GROUP BY c.id,c.name,c.phone ORDER BY amount DESC,c.name COLLATE NOCASE,c.id LIMIT 10`,...params);
    const productRows=store.all(`SELECT p.id,p.name,l.unit,l.unit_size AS unitSize,SUM(l.milli_qty) AS qty,SUM(l.line_piasters) AS amount
      FROM office_sales_lines_v1 l JOIN office_sales_v1 s ON s.id=l.sale_id JOIN products p ON p.id=l.product_id
      WHERE s.created_at>=? AND s.created_at<? GROUP BY p.id,p.name,l.unit,l.unit_size`,...params);
    // Quantity and revenue are intentionally separate rankings; units across products aren't interchangeable.
    const shapeProduct=(p:Record<string,any>)=>({...p,qty:Number(p.qty)/1000,amount:Number(p.amount)/100});
    // A customer cannot be ranked by a sum of sacks + litres. Rank consumption separately per pack.
    const consumers=store.all(`WITH client_totals AS (
      SELECT l.product_id AS productId,l.unit,l.unit_size AS unitSize,c.id,c.name,c.phone,SUM(l.milli_qty) AS qty,SUM(l.line_piasters) AS amount
      FROM office_sales_lines_v1 l JOIN office_sales_v1 s ON s.id=l.sale_id JOIN customers c ON c.id=s.customer_id
      WHERE s.created_at>=? AND s.created_at<? GROUP BY l.product_id,l.unit,l.unit_size,c.id,c.name,c.phone
    ), ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY productId,unit,unitSize ORDER BY qty DESC,amount DESC,name COLLATE NOCASE,id) AS pos FROM client_totals)
      SELECT * FROM ranked WHERE pos<=10 ORDER BY productId,unit,unitSize,pos`,...params);
    const enrich=(p:Record<string,any>)=>({...shapeProduct(p),consumers:consumers.filter(c=>c.productId===p.id&&c.unit===p.unit&&c.unitSize===p.unitSize)
      .map(c=>({id:c.id,name:c.name,phone:c.phone,qty:Number(c.qty)/1000,amount:Number(c.amount)/100}))});
    const productsByValue=[...productRows].sort((a,b)=>Number(b.amount)-Number(a.amount)||String(a.name).localeCompare(String(b.name),'ar')||String(a.id).localeCompare(String(b.id))).slice(0,10).map(enrich);
    const productsByQty=[...productRows].sort((a,b)=>Number(b.qty)-Number(a.qty)||String(a.name).localeCompare(String(b.name),'ar')||String(a.id).localeCompare(String(b.id))).slice(0,10).map(enrich);
    const visitRows=store.all('SELECT user_id AS id,COUNT(*) AS n FROM visits WHERE checked_in_at>=? AND checked_in_at<? GROUP BY user_id',...params);
    const orderRows=store.all("SELECT user_id AS id,COUNT(*) AS n FROM orders WHERE status IN ('sent','priced') AND sent_at>=? AND sent_at<? GROUP BY user_id",...params);
    // Existing order-backed sales can be attributed to their actual order author if that order survives.
    // A new explicit 'none' snapshot never falls back to the customer's current owner.
    const saleRows=store.all(`SELECT CASE WHEN a.sale_id IS NOT NULL THEN a.rep_id ELSE o.user_id END AS id,
      COUNT(*) AS n,SUM(s.total_piasters) AS amount,
      SUM(CASE WHEN a.sale_id IS NULL AND o.user_id IS NOT NULL THEN 1 ELSE 0 END) AS legacy
      FROM office_sales_v1 s LEFT JOIN office_sale_rep_v1 a ON a.sale_id=s.id
      LEFT JOIN orders o ON o.id=s.order_id
      WHERE s.created_at>=? AND s.created_at<? GROUP BY CASE WHEN a.sale_id IS NOT NULL THEN a.rep_id ELSE o.user_id END`,...params);
    const reps=store.all("SELECT id,name,region,active FROM users WHERE role='rep' ORDER BY name COLLATE NOCASE,id").map(rep=>{
      const visit=visitRows.find(x=>x.id===rep.id),order=orderRows.find(x=>x.id===rep.id),sale=saleRows.find(x=>x.id===rep.id);
      return {id:rep.id,name:rep.name,region:rep.region,active:!!rep.active,visits:Number(visit?.n||0),orders:Number(order?.n||0),salesCount:Number(sale?.n||0),sales:Number(sale?.amount||0)/100,legacyOrders:Number(sale?.legacy||0)};
    }).sort((a,b)=>b.sales-a.sales||b.orders-a.orders||String(a.name).localeCompare(String(b.name),'ar'));
    const unknown=saleRows.find(x=>x.id===null);
    res.setHeader('Cache-Control','private, no-store');
    res.json({from,to,timezone,salesCount:Number(totals.count),customerCount:Number(totals.customers),sales:Number(totals.amount)/100,
      customers:customers.map(c=>({...c,count:Number(c.count),amount:Number(c.amount)/100,
        items:store.all(`SELECT p.id,p.name,l.unit,l.unit_size AS unitSize,SUM(l.milli_qty) AS qty,SUM(l.line_piasters) AS amount
          FROM office_sales_lines_v1 l JOIN office_sales_v1 s ON s.id=l.sale_id JOIN products p ON p.id=l.product_id
          WHERE s.customer_id=? AND s.created_at>=? AND s.created_at<? GROUP BY p.id,p.name,l.unit,l.unit_size ORDER BY amount DESC,p.name COLLATE NOCASE LIMIT 10`,c.id,...params).map(shapeProduct)})),productsByValue,productsByQty,reps,
      unassignedCount:Number(unknown?.n||0),unassignedSales:Number(unknown?.amount||0)/100,
      legacyOrders:saleRows.reduce((sum,r)=>sum+Number(r.legacy||0),0)});
  });
  return router;
}
