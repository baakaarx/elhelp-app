import { request } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { E2E_ADMIN, E2E_API, E2E_DB_PATH, E2E_REPS, E2E_REP_PASSWORD } from './fixtures';

/**
 * Seeds the browser suite through the API the way a real deployment is used: create the
 * accounts from the manager dashboard, then have each engineer open a shift and record a
 * route, visits and reports. Two rows are back-dated in the database afterwards so the
 * manager alerts have something to raise (an unclosed visit and a lost signal).
 */
export default async function globalSetup() {
  const api = await request.newContext({ baseURL: E2E_API });
  const login = await api.post('/api/auth/login', { data: E2E_ADMIN });
  if (!login.ok()) throw new Error(`e2e: manager login failed (${login.status()}) ${await login.text()}`);
  const { token } = await login.json();
  const admin = { Authorization: `Bearer ${token}` };
  // Playwright forwards environment changes made here to the test workers, which install this
  // token as the session cookie instead of signing in again for every test.
  process.env.E2E_ADMIN_TOKEN = token;
  // The manager session is handed to the browser tests, so the suite never exhausts the
  // login rate limit (15 attempts per 15 minutes) while it runs.


  // The daily report is filed against the operator's local day, not the server's UTC date.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());

  const repIds: string[] = [];
  const seeded: { shiftId: string; pointIds: string[] }[] = [];
  for (const rep of E2E_REPS) {
    const created = await api.post('/api/reps', { data: { ...rep, password: E2E_REP_PASSWORD }, headers: admin });
    if (!created.ok()) throw new Error(`e2e: creating ${rep.email} failed (${created.status()}) ${await created.text()}`);
    repIds.push((await created.json()).user.id);
  }

  const repTokens = new Map<string, string>();
  async function repAuth(email: string) {
    if (!repTokens.has(email)) {
      const session = await api.post('/api/auth/login', { data: { email, password: E2E_REP_PASSWORD } });
      if (!session.ok()) throw new Error(`e2e: ${email} login failed (${session.status()})`);
      repTokens.set(email, (await session.json()).token);
    }
    return { Authorization: `Bearer ${repTokens.get(email)}` };
  }

  /**
   * The office enters a customer before a visit can be recorded on him, so the seed cannot skip
   * straight to check-in: it would be refused, and every browser test would run on an empty database.
   */
  async function book(repId: string, data: { name: string; governorate?: string; district?: string; phone?: string }) {
    const created = await api.post('/api/customers', { data: { ...data, repId }, headers: admin });
    if (!created.ok()) throw new Error(`e2e: booking ${data.name} failed (${created.status()}) ${await created.text()}`);
    return (await created.json()).customer.id as string;
  }

  for (const [index, rep] of E2E_REPS.entries()) {
    const auth = await repAuth(rep.email);
    const location = { lat: 31.2001 + index * 0.01, lng: 29.9187 + index * 0.01, accuracy: 12 };

    const started = await api.post('/api/shifts/start', {
      data: { consentVersion: '1.0', location, deviceId: `e2e-device-${index}` },
      headers: auth,
    });
    if (!started.ok()) throw new Error(`e2e: ${rep.email} could not start a shift (${started.status()}) ${await started.text()}`);
    const shift = (await started.json()).shift;

    // The API only accepts points inside the open shift and at most a few seconds in the future,
    // so the route is pushed "now" and moved into the past straight in the database afterwards.
    const points = [0, 1, 2, 3].map(step => ({
      id: randomUUID(), shiftId: shift.id,
      lat: location.lat + step * 0.0008, lng: location.lng + step * 0.0011,
      accuracy: 10 + step, speed: step === 0 ? 0 : 3.4, heading: 90, battery: 80 - step,
      recordedAt: Number(shift.started_at) + step * 1000,
    }));
    const pushed = await api.post('/api/locations', { data: { points }, headers: auth });
    if (!pushed.ok()) throw new Error(`e2e: ${rep.email} locations failed (${pushed.status()}) ${await pushed.text()}`);
    seeded.push({ shiftId: shift.id, pointIds: points.map(point => point.id) });
  }

  // Engineer 1: a closed visit, a field report and the signed daily report.
  const first = E2E_REPS[0];
  const firstAuth = await repAuth(first.email);
  const nourId = await book(repIds[0], { name: 'مزرعة النور', governorate: 'البحيرة', district: 'إيتاي البارود', phone: '01000000000' });
  const visit = await api.post('/api/visits/check-in', {
    data: { id: randomUUID(), customerId: nourId, purpose: 'visit', governorate: 'البحيرة', district: 'إيتاي البارود', location: { lat: 31.21, lng: 29.93, accuracy: 9 } },
    headers: firstAuth,
  });
  if (!visit.ok()) throw new Error(`e2e: check-in failed (${visit.status()}) ${await visit.text()}`);
  await api.post(`/api/visits/${(await visit.json()).visit.id}/check-out`, {
    data: { outcome: 'تم الاتفاق على طلبية', notes: '', amount: null, location: { lat: 31.21, lng: 29.93, accuracy: 9 } },
    headers: firstAuth,
  });
  const report = await api.post('/api/reports', {
    data: { id: randomUUID(), type: 'order', title: 'طلبية سماد', body: '٢٠ شيكارة يوريا', customer: 'مزرعة النور', amount: null },
    headers: firstAuth,
  });
  if (!report.ok()) throw new Error(`e2e: field report failed (${report.status()}) ${await report.text()}`);
  const daily = await api.post('/api/daily-reports', {
    data: {
      version: 1, id: randomUUID(), engineerName: first.name, reportDate: today,
      leftAt: '08:30', returnedAt: '16:00', circumstances: 'يوم ميداني',
      visits: [{ customerName: 'مزرعة النور', governorate: 'البحيرة', district: 'إيتاي البارود', village: 'الظاهرية', phone: '01000000000', areaFeddan: 12, crops: 'قمح', recommendations: 'مكافحة الحشائش', outcome: 'طلبية سماد' }],
      signedName: first.name, confirmed: true, location: { lat: 31.21, lng: 29.93, accuracy: 9 },
    },
    headers: firstAuth,
  });
  if (!daily.ok()) throw new Error(`e2e: daily report failed (${daily.status()}) ${await daily.text()}`);

  // The price list the office typed: one item, priced at one buyer type only, so the screens have both
  // states to show — a number, and «بلا سعر» next to it. Set through the same routes the dashboard uses.
  const tiers = (await (await api.get('/api/price-tiers', { headers: admin })).json()).tiers as Array<{ id: string; name: string }>;
  const wholesale = tiers.find(tier => tier.name === 'جملة')!;
  const product = await api.post('/api/products', {
    data: { name: 'يوريا ٤٦٪', category: 'fertilizer', unit: 'شيكارة', unitSize: '٥٠ كجم', notes: 'السعر للشيكارة نفسها' },
    headers: admin,
  });
  if (!product.ok()) throw new Error(`e2e: seeding the catalogue failed (${product.status()}) ${await product.text()}`);
  const productId = (await product.json()).product.id as string;
  const priced = await api.put(`/api/products/${productId}/prices`, {
    data: { prices: [{ tierId: wholesale.id, price: 1150 }] }, headers: admin,
  });
  if (!priced.ok()) throw new Error(`e2e: pricing the seeded item failed (${priced.status()}) ${await priced.text()}`);
  // A customer the office has already handed a buyer type, and one it has not: the book has to read both.
  const tiered = await api.patch(`/api/customers/${nourId}`, { data: { priceTierId: wholesale.id }, headers: admin });
  if (!tiered.ok()) throw new Error(`e2e: quoting the seeded customer failed (${tiered.status()}) ${await tiered.text()}`);

  // The queue the office opens to: one order the field already sent, on the customer who holds the
  // wholesale type, so the pricing sheet has a real prefill to be checked against — 2 × 1150 is
  // typed by nobody; it arrives on the list price the office itself entered two lines above.
  const orderCustomerId = await book(repIds[0], { name: 'عميل اختبار الطلبية', governorate: 'البحيرة', district: 'إيتاي البارود' });
  const orderTier = await api.patch(`/api/customers/${orderCustomerId}`, { data: { priceTierId: wholesale.id }, headers: admin });
  if (!orderTier.ok()) throw new Error(`e2e: pricing order customer failed (${orderTier.status()})`);
  const seededOrder = await api.post('/api/orders', {
    data: { id: randomUUID(), customerId: orderCustomerId, notes: 'التسليم الأحد الصبح', lines: [{ productId, qty: 2 }] },
    headers: firstAuth,
  });
  if (!seededOrder.ok()) throw new Error(`e2e: seeding the field order failed (${seededOrder.status()}) ${await seededOrder.text()}`);

  // Engineer 2: a visit left open for hours, so the manager sees the unclosed check-in.
  const second = E2E_REPS[1];
  const secondAuth = await repAuth(second.email);
  const deltaId = await book(repIds[1], { name: 'مزرعة الدلتا', governorate: 'المنوفية', district: 'شبين الكوم' });
  await api.post('/api/visits/check-in', {
    data: { id: randomUUID(), customerId: deltaId, purpose: 'visit', location: { lat: 31.05, lng: 30.47, accuracy: 14 } },
    headers: secondAuth,
  });

  // Spread the seeded activity over the working day, straight in the database: a real client
  // can only ever report "now", and the manager screens are built around a day of movement.
  const db = new DatabaseSync(E2E_DB_PATH);
  const minute = 60_000;
  try {
    const now = Date.now();
    for (const [index, repId] of repIds.entries()) {
      const { shiftId, pointIds } = seeded[index];
      const shiftStart = now - 6 * 3600_000;
      db.prepare('UPDATE shifts SET started_at=? WHERE id=?').run(shiftStart, shiftId);
      db.prepare('UPDATE shifts SET consent_at=? WHERE id=?').run(shiftStart, shiftId);
      // Engineer 1 finishes at the current minute, engineer 2 an hour ago, engineer 3 lost
      // signal 45 minutes ago (STALE_GPS_MINUTES is 10). Shift-start also records a GPS fix;
      // backdate that implicit point too, or it masks the deliberately stale seeded fixes.
      const lastPointAge = index === 0 ? 0 : index === 1 ? 60 : 45;
      const seededIds = pointIds.map(() => '?').join(',');
      db.prepare(`UPDATE locations SET recorded_at=? WHERE user_id=? AND shift_id=? AND point_id NOT IN (${seededIds})`)
        .run(now - lastPointAge * minute, repId, shiftId, ...pointIds);
      for (const [step, pointId] of pointIds.entries()) {
        const age = lastPointAge + (pointIds.length - 1 - step) * 8;
        db.prepare('UPDATE locations SET recorded_at=? WHERE user_id=? AND point_id=?')
          .run(now - age * minute, repId, pointId);
      }
      db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now - lastPointAge * minute, repId);
    }
    // Engineer 2 left a visit open for four hours: the manager must see it as an exception.
    const fourHoursAgo = now - 4 * 3600_000;
    db.prepare('UPDATE visits SET checked_in_at=?, created_at=? WHERE user_id=? AND status=?')
      .run(fourHoursAgo, fourHoursAgo, repIds[1], 'open');
  } finally {
    db.close();
  }
  await api.dispose();
}
