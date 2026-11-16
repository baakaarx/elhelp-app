import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { localDate } from '../src/geo.js';

/**
 * The monthly register (Excel and screen) counted daily reports by `created_at` — the moment the
 * form was submitted — while every other surface keys them to `report_date`, the day the report
 * covers. A form filled in for Monday but sent on Tuesday morning moved to Tuesday; one sent on
 * the 1st for the 30th changed month in the register the company files.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 365, timezone: 'Africa/Cairo',
  adminEmail: 'admin@mandoub.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  staleGpsMinutes: 10,
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

const DAY = 86400000;
const dayAgo = (days: number) => localDate(config.timezone, Date.now() - days * DAY);

test('a daily report counts in the day it covers, not the day it was sent', async () => {
  const admin = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
  assert.equal(admin.status, 200);
  const adminToken = admin.body.token as string;

  const repId = randomUUID();
  const email = `kpi.${Date.now()}@mandoub.test`;
  store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
    repId, 'مهندس التقرير', email, hashPassword('RepPassword123!'), 'rep', Date.now() - 30 * DAY);
  const login = await client.post('/api/auth/login').send({ email, password: 'RepPassword123!' });
  assert.equal(login.status, 200, JSON.stringify(login.body));

  // The form is written today but covers two days ago (a shift that ran past midnight, or a
  // paper form handed in late).
  const covered = dayAgo(2);
  const created = await client.post('/api/daily-reports').set('Authorization', `Bearer ${login.body.token}`).send({
    version: 1, id: randomUUID(), engineerName: 'مهندس التقرير', reportDate: covered,
    leftAt: '08:00', returnedAt: '17:00', circumstances: '', signedName: 'مهندس التقرير', confirmed: true, location: null,
    visits: [{
      customerName: 'مزرعة النور', governorate: 'القاهرة', district: 'مدينة نصر', village: '',
      phone: '', areaFeddan: 10, crops: 'قمح', recommendations: '', outcome: 'متابعة',
    }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const rowFor = async (from: string, to: string) => {
    const res = await client.get(`/api/kpis?from=${from}&to=${to}`).set('Authorization', `Bearer ${adminToken}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return (res.body.rows as Array<{ repId: string; dailyReports: number }>).find(row => row.repId === repId)!;
  };

  const coveredRow = await rowFor(covered, covered);
  assert.equal(coveredRow.dailyReports, 1, 'the covered day must show the report');

  const sentRow = await rowFor(dayAgo(0), dayAgo(0));
  assert.equal(sentRow.dailyReports, 0, 'the day it was typed must not claim it');
});
