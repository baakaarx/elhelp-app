#!/usr/bin/env node
/**
 * محاكاة حمل لتطبيق الهلب (elhelp-app): يسجل دخول 30 مهندس + 5 حسابات مبيعات + 5 حسابات مخازن،
 * ويشغّلهم كلهم في نفس الوقت وهم بيعملوا كل العمليات الأساسية بالتوازي: وردية، مواقع، زيارات،
 * طلبيات، فواتير، تحصيل، حركات مخزون.
 *
 * مبني على قراءة الكود الفعلي (server/src/app.ts, sales.ts, warehouse.ts) وملفات الاختبار، مش تخمين،
 * لكن لو شكل أي طلب اتغيّر في الريبو هيظهر خطأ 400 واضح في أول محاولة — شوف أول رسالة خطأ لكل
 * عملية في المخرجات لو حصل فشل كتير على نوع واحد من الطلبات.
 *
 * ⚠️ السكريبت ده بيكتب بيانات حقيقية (مهندسين، عملاء، طلبيات، فواتير، حركات مخزون) على أي قاعدة
 *    بيانات يشاور عليها BASE_URL. ما تشغّلهوش على سيرفر فيه بيانات الشركة الحقيقية. شغّله على نسخة
 *    تجربة: إما سيرفر محلي بقاعدة بيانات مؤقتة (DB_PATH=:memory: أو ملف جديد)، أو نسخة staging منفصلة.
 *
 * التشغيل:
 *   1) في مجلد الريبو، شغّل سيرفر تجربة منفصل:
 *        DB_PATH=:memory: NODE_ENV=development ADMIN_EMAIL=admin@loadtest.local \
 *        ADMIN_PASSWORD='LoadTest12345!' PORT=3001 node server/dist/index.js
 *      (أو npm run build قبلها لو dist مش موجود)
 *   2) في مجلد تاني أو نفس المجلد:
 *        BASE_URL=http://localhost:3001 ADMIN_EMAIL=admin@loadtest.local \
 *        ADMIN_PASSWORD='LoadTest12345!' ALLOW_WRITE_TEST=yes node loadtest.mjs
 *
 * متغيرات البيئة:
 *   BASE_URL          رابط سيرفر الاختبار (مطلوب؛ مثال http://localhost:3001)
 *   ADMIN_EMAIL       إيميل حساب مدير كامل موجود بالفعل على السيرفر ده
 *   ADMIN_PASSWORD    كلمة مروره
 *   REP_COUNT         عدد المهندسين (افتراضي 30)
 *   SALES_COUNT       عدد حسابات المبيعات (افتراضي 5)
 *   WAREHOUSE_COUNT   عدد حسابات المخازن (افتراضي 5)
 *   DURATION_SEC      مدة مرحلة الحمل بالثواني (افتراضي 120)
 *   LOGIN_DELAY_MS    تأخير بين كل تسجيل دخول وقت الإعداد، عشان حد محاولات الدخول (15/دقيقة لكل IP)
 *                     ما يتلمش (افتراضي 4500)
 *   ALLOW_WRITE_TEST  لازم تكون "yes" صراحةً، وإلا السكريبت يرفض يشتغل
 */

const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const REP_COUNT = Number(process.env.REP_COUNT || 30);
const SALES_COUNT = Number(process.env.SALES_COUNT || 5);
const WAREHOUSE_COUNT = Number(process.env.WAREHOUSE_COUNT || 5);
const DURATION_SEC = Number(process.env.DURATION_SEC || 120);
const LOGIN_DELAY_MS = Number(process.env.LOGIN_DELAY_MS || 4500);
const RUN_ID = Date.now().toString(36);

if (process.env.ALLOW_WRITE_TEST !== 'yes') {
  console.error('هذا السكريبت يكتب بيانات حقيقية. شغّله على نسخة تجربة فقط، ثم أعد التشغيل مع ALLOW_WRITE_TEST=yes.');
  process.exit(1);
}
if (!BASE_URL) { console.error('لازم تحدد BASE_URL لسيرفر اختبار منفصل.'); process.exit(1); }
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('لازم ADMIN_EMAIL و ADMIN_PASSWORD لحساب مدير كامل موجود بالفعل على السيرفر.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, spread) => base + (Math.random() * 2 - 1) * spread;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---- قياس الأداء -----------------------------------------------------------------------------
const metrics = []; // { op, status, ms, ok, errorBody? }
function record(op, status, ms, ok, errorBody) {
  metrics.push({ op, status, ms, ok, errorBody });
}
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
function summarize() {
  const byOp = new Map();
  for (const m of metrics) {
    if (!byOp.has(m.op)) byOp.set(m.op, []);
    byOp.get(m.op).push(m);
  }
  console.log('\n=== النتائج ===');
  console.log('العملية'.padEnd(28), 'العدد'.padStart(7), 'فشل'.padStart(6), 'p50ms'.padStart(7), 'p95ms'.padStart(7), 'p99ms'.padStart(7), 'أقصى ms'.padStart(8));
  let totalReq = 0, totalFail = 0;
  for (const [op, list] of [...byOp.entries()].sort()) {
    const times = list.map((m) => m.ms).sort((a, b) => a - b);
    const fails = list.filter((m) => !m.ok);
    totalReq += list.length; totalFail += fails.length;
    console.log(
      op.padEnd(28), String(list.length).padStart(7), String(fails.length).padStart(6),
      String(percentile(times, 50)).padStart(7), String(percentile(times, 95)).padStart(7),
      String(percentile(times, 99)).padStart(7), String(times[times.length - 1] || 0).padStart(8),
    );
    if (fails.length) {
      const sample = fails.slice(0, 2).map((f) => `${f.status}: ${JSON.stringify(f.errorBody).slice(0, 140)}`);
      console.log('   أمثلة فشل:', sample.join(' | '));
    }
  }
  console.log('---');
  console.log(`الإجمالي: ${totalReq} طلب، ${totalFail} فشل (${((totalFail / Math.max(1, totalReq)) * 100).toFixed(2)}%).`);
  console.log('ملحوظة: أزمنة الجدول تشمل الطلبات الناجحة والمرفوضة؛ راجع عدد كل عملية وأخطاءها ولا تعتبر النتائج شهادة أداء.');
  for (const op of ['rep.checkIn', 'rep.checkOut', 'rep.createOrder', 'sales.createInvoice', 'sales.receipt', 'warehouse.movement']) {
    if (!byOp.get(op)?.some(m => m.ok)) console.log(`تحذير: لم تنجح أي عملية ${op} أثناء الاختبار؛ هذا المسار لم يُختبر بنجاح.`);
  }
}

// ---- عميل HTTP بسيط ---------------------------------------------------------------------------
async function call(op, method, path, token, body) {
  const start = Date.now();
  try {
    const res = await fetch(BASE_URL + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const ms = Date.now() - start;
    let json = null;
    try { json = await res.json(); } catch {}
    const ok = res.status >= 200 && res.status < 300;
    record(op, res.status, ms, ok, ok ? undefined : json);
    return { ok, status: res.status, body: json };
  } catch (error) {
    const ms = Date.now() - start;
    record(op, 0, ms, false, String(error));
    return { ok: false, status: 0, body: null };
  }
}

async function loginWithRetry(email, password) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await call('auth.login', 'POST', '/api/auth/login', null, { email, password });
    if (res.ok) return res.body.token;
    if (res.status === 429) { await sleep(8000); continue; }
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  throw new Error(`login kept hitting 429 for ${email}`);
}

// ---- مرحلة الإعداد: حسابات، عملاء، مخازن، أصناف -----------------------------------------------
async function setup() {
  console.log(`[setup] تسجيل دخول المدير...`);
  const adminToken = await loginWithRetry(ADMIN_EMAIL, ADMIN_PASSWORD);

  console.log(`[setup] إنشاء ${REP_COUNT} مهندس...`);
  const reps = [];
  for (let i = 0; i < REP_COUNT; i++) {
    const email = `rep-${RUN_ID}-${i}@loadtest.local`;
    const password = 'LoadTest12345!';
    const res = await call('setup.createRep', 'POST', '/api/reps', adminToken, {
      name: `مهندس تجربة ${i + 1}`, email, password, region: pick(['الجيزة', 'البحيرة', 'المنيا', 'الإسماعيلية']),
    });
    if (!res.ok) throw new Error(`فشل إنشاء مهندس ${i}: ${JSON.stringify(res.body)}`);
    const id = res.body?.user?.id;
    if (!id) throw new Error('رد إنشاء المهندس لا يحتوي user.id؛ أوقفنا الاختبار قبل إنشاء العملاء.');
    reps.push({ id, email, password });
  }

  console.log(`[setup] إنشاء ${SALES_COUNT} حساب مبيعات و${WAREHOUSE_COUNT} حساب مخازن...`);
  const salesStaff = [];
  for (let i = 0; i < SALES_COUNT; i++) {
    const email = `sales-${RUN_ID}-${i}@loadtest.local`, password = 'LoadTest12345!';
    const res = await call('setup.createStaff', 'POST', '/api/staff/', adminToken, {
      name: `مبيعات تجربة ${i + 1}`, email, password, accessScope: 'full',
    });
    if (!res.ok) throw new Error(`فشل إنشاء حساب مبيعات ${i}: ${JSON.stringify(res.body)}`);
    salesStaff.push({ email, password });
  }
  const warehouseStaff = [];
  for (let i = 0; i < WAREHOUSE_COUNT; i++) {
    const email = `wh-${RUN_ID}-${i}@loadtest.local`, password = 'LoadTest12345!';
    const res = await call('setup.createStaff', 'POST', '/api/staff/', adminToken, {
      name: `مخازن تجربة ${i + 1}`, email, password, accessScope: 'warehouse',
    });
    if (!res.ok) throw new Error(`فشل إنشاء حساب مخازن ${i}: ${JSON.stringify(res.body)}`);
    warehouseStaff.push({ email, password });
  }

  console.log('[setup] إنشاء مخزنين وأصناف ورصيد افتتاحي...');
  const wh1 = (await call('setup.createWarehouse', 'POST', '/api/warehouse/warehouses', adminToken, { name: `مخزن تجربة أ ${RUN_ID}` })).body.warehouse;
  const wh2 = (await call('setup.createWarehouse', 'POST', '/api/warehouse/warehouses', adminToken, { name: `مخزن تجربة ب ${RUN_ID}` })).body.warehouse;
  const products = [];
  for (let i = 0; i < 8; i++) {
    const res = await call('setup.createProduct', 'POST', '/api/warehouse/products', adminToken, {
      name: `صنف تجربة ${RUN_ID}-${i}`, category: pick(['pesticide', 'fertilizer', 'other']), unit: 'عبوة', unitSize: '١ لتر',
    });
    if (!res.ok) throw new Error(`فشل إنشاء صنف ${i}: ${JSON.stringify(res.body)}`);
    const productId = res.body.product.id;
    for (const warehouseId of [wh1.id, wh2.id]) {
      const opening = await call('setup.openingStock', 'POST', '/api/warehouse/movements', adminToken, {
        id: crypto.randomUUID(), kind: 'opening', productId, toWarehouseId: warehouseId, qty: 100000,
      });
      if (!opening.ok) throw new Error(`فشل الرصيد الافتتاحي: ${JSON.stringify(opening.body)}`);
    }
    products.push({ id: productId });
  }

  console.log('[setup] تسعير الأصناف لأي نوع عميل متاح (اختياري، يفيد اختبار شاشة الأسعار)...');
  // غير حرج لو فشل — التسعير مش شرط لعمل فاتورة يدوية.

  console.log(`[setup] إنشاء عملاء وتوزيعهم على المهندسين...`);
  const customersByRep = new Map();
  for (const rep of reps) customersByRep.set(rep.email, []);
  const customerCount = REP_COUNT * 4;
  const allCustomers = [];
  for (let i = 0; i < customerCount; i++) {
    const rep = reps[i % reps.length];
    const res = await call('setup.createCustomer', 'POST', '/api/customers', adminToken, {
      name: `عميل تجربة ${RUN_ID}-${i}`, phone: '01000000000', governorate: 'الجيزة', district: 'أطفيح', village: 'قرية تجربة', repId: rep.id,
    });
    if (!res.ok) throw new Error(`فشل إنشاء عميل ${i}: ${JSON.stringify(res.body)}`);
    if (res.body?.customer?.repId !== rep.id) throw new Error(`لم يتم إسناد العميل ${i} للمهندس المطلوب؛ أوقفنا الاختبار.`);
    const customer = { id: res.body.customer.id };
    customersByRep.get(rep.email).push(customer);
    allCustomers.push(customer);
  }

  console.log('[setup] تسجيل دخول كل الحسابات (بفواصل عشان حد تسجيل الدخول)...');
  for (const rep of reps) { rep.token = await loginWithRetry(rep.email, rep.password); await sleep(LOGIN_DELAY_MS); }
  for (const s of salesStaff) { s.token = await loginWithRetry(s.email, s.password); await sleep(LOGIN_DELAY_MS); }
  for (const w of warehouseStaff) { w.token = await loginWithRetry(w.email, w.password); await sleep(LOGIN_DELAY_MS); }

  return { adminToken, reps, salesStaff, warehouseStaff, customersByRep, allCustomers, products, warehouses: [wh1, wh2] };
}

// ---- حلقات الحمل المتزامنة ---------------------------------------------------------------------
async function repLoop(rep, myCustomers, products, deadline) {
  const base = { lat: jitter(30.15, 0.3), lng: jitter(31.0, 0.3) };
  const shiftRes = await call('rep.shiftStart', 'POST', '/api/shifts/start', rep.token, {
    consentVersion: '1.0', deviceId: `loadtest-${rep.email}`, location: { lat: base.lat, lng: base.lng, accuracy: 8 },
  });
  const shiftId = shiftRes.body?.shift?.id;
  if (!shiftId) { console.error(`[${rep.email}] تعذر بدء وردية:`, JSON.stringify(shiftRes.body)); return; }

  while (Date.now() < deadline) {
    // دفعة مواقع (محاكاة GPS)
    const points = Array.from({ length: 5 + Math.floor(Math.random() * 10) }, () => ({
      id: crypto.randomUUID(), shiftId, lat: jitter(base.lat, 0.01), lng: jitter(base.lng, 0.01),
      accuracy: 10 + Math.random() * 20, speed: Math.random() * 15, heading: Math.random() * 359,
      battery: 50 + Math.random() * 50, recordedAt: Date.now(),
    }));
    await call('rep.locations', 'POST', '/api/locations', rep.token, { points });

    // زيارة كاملة (دخول + خروج)، وأحيانًا طلبية
    if (myCustomers.length && Math.random() < 0.5) {
      const customer = pick(myCustomers);
      const visitId = crypto.randomUUID();
      const checkIn = await call('rep.checkIn', 'POST', '/api/visits/check-in', rep.token, {
        id: visitId, customerId: customer.id, purpose: 'visit', notes: '', location: { lat: jitter(base.lat, 0.005), lng: jitter(base.lng, 0.005), accuracy: 9 },
      });
      if (checkIn.ok) {
        await sleep(300 + Math.random() * 700);
        await call('rep.checkOut', 'POST', `/api/visits/${visitId}/check-out`, rep.token, {
          outcome: pick(['تمت الزيارة', 'اتفقنا على طلبية', 'العميل محتاج متابعة']), notes: '', amount: null,
          location: { lat: jitter(base.lat, 0.005), lng: jitter(base.lng, 0.005), accuracy: 9 },
        });
        if (Math.random() < 0.4) {
          const chosen = [...products].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 2));
          const lines = chosen.map(product => ({ productId: product.id, qty: 1 + Math.floor(Math.random() * 5) }));
          await call('rep.createOrder', 'POST', '/api/orders', rep.token, {
            id: crypto.randomUUID(), customerId: customer.id, visitId, lines, notes: '', send: true,
          });
        }
      }
    }
    await sleep(400 + Math.random() * 600);
  }
  await call('rep.shiftStop', 'POST', '/api/shifts/stop', rep.token, {});
}

async function salesLoop(staff, customerIds, deadline) {
  while (Date.now() < deadline) {
    const options = await call('sales.options', 'GET', '/api/sales/options', staff.token);
    const salesOverview = await call('sales.overview', 'GET', '/api/sales/overview', staff.token);
    await call('overview', 'GET', '/api/overview', staff.token);
    // Each customer belongs to one sales worker: avoid artificial duplicate invoices/receipts.
    const pendingOrders = (options.body?.orders || []).filter(order => customerIds.has(order.customerId));
    if (pendingOrders.length && Math.random() < 0.5) {
      const order = pick(pendingOrders);
      const warehouse = pick(options.body.warehouses || []);
      if (warehouse) {
        const lines = (order.lines?.length ? order.lines : []).map((l) => ({ productId: l.productId, qty: l.qty, price: (1000 + Math.floor(Math.random() * 4001)) / 100 }));
        if (lines.length) {
          await call('sales.createInvoice', 'POST', '/api/sales/', staff.token, {
            id: crypto.randomUUID(), customerId: order.customerId, warehouseId: warehouse.id, orderId: order.id,
            paid: 0, lines,
          });
        }
      }
    }
    const debtor = pick((salesOverview.body?.debtors || []).filter(c => customerIds.has(c.id) && c.due >= 1));
    if (debtor && Math.random() < 0.2) {
      await call('sales.receipt', 'POST', '/api/sales/receipts', staff.token, { id: crypto.randomUUID(), customerId: debtor.id, amount: 1 });
    }
    await sleep(500 + Math.random() * 1000);
  }
}

async function warehouseLoop(staff, warehouses, products, deadline) {
  while (Date.now() < deadline) {
    const wh = pick(warehouses);
    await call('warehouse.stock', 'GET', `/api/warehouse/stock?warehouseId=${wh.id}`, staff.token);
    await call('warehouse.lowStock', 'GET', '/api/warehouse/low-stock', staff.token);
    if (Math.random() < 0.3) {
      const [from, to] = warehouses[0].id === wh.id ? warehouses : [warehouses[1], warehouses[0]];
      await call('warehouse.movement', 'POST', '/api/warehouse/movements', staff.token, {
        id: crypto.randomUUID(), kind: 'transfer', productId: pick(products).id, fromWarehouseId: from.id, toWarehouseId: to.id, qty: (1000 + Math.floor(Math.random() * 3001)) / 1000,
      });
    }
    await sleep(600 + Math.random() * 900);
  }
}

// ---- التشغيل -------------------------------------------------------------------------------
(async () => {
  console.log(`[loadtest] BASE_URL=${BASE_URL} reps=${REP_COUNT} sales=${SALES_COUNT} warehouse=${WAREHOUSE_COUNT} duration=${DURATION_SEC}s`);
  const { reps, salesStaff, warehouseStaff, customersByRep, allCustomers, products, warehouses } = await setup();
  // Exclude setup/login requests from the load-phase metrics.
  metrics.length = 0;

  console.log(`[loadtest] بدء مرحلة الحمل المتزامن لمدة ${DURATION_SEC} ثانية...`);
  // Shift start/stop appear in the load report; setup and login do not.
  const deadline = Date.now() + DURATION_SEC * 1000;
  await Promise.all([
    ...reps.map((rep) => repLoop(rep, customersByRep.get(rep.email) || [], products, deadline)),
    ...salesStaff.map((s, index) => salesLoop(s, new Set(allCustomers.filter((_, i) => i % salesStaff.length === index).map(c => c.id)), deadline)),
    ...warehouseStaff.map((w) => warehouseLoop(w, warehouses, products, deadline)),
  ]);

  summarize();
})().catch((error) => { console.error('[loadtest] فشل غير متوقع:', error); process.exit(1); });
