import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';

/**
 * Upgrading a live database onto the company customer list.
 *
 * `customers.rep_id` used to be NOT NULL, and that one word is what makes «the office enters the list,
 * the engineers are handed their part of it afterwards» impossible: a name typed in the office before
 * anybody decided who drives that area was a 400. SQLite cannot drop a NOT NULL in place, so the
 * migration rebuilds the table — and rebuilding a parent table whose children say
 * `REFERENCES customers(id) ON DELETE SET NULL` is the one operation in this codebase that can quietly
 * destroy data: with foreign keys enforced, DROP TABLE runs every child's ON DELETE action, which
 * would set visits.customer_id and invoices.customer_id to NULL for the whole database. Every recorded
 * visit and every invoice would still exist and simply stop knowing whose customer it was.
 *
 * So the test is not «did the column change». It is «did the links survive the change».
 */
const DAY = 86400000;

/** The customers table exactly as it was defined before this release, rebuilt over the current one. */
function downgradeBook(store: Store) {
  store.run('PRAGMA foreign_keys = OFF');
  store.run(`
    CREATE TABLE customers_legacy (
      id TEXT PRIMARY KEY,
      rep_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      governorate TEXT NOT NULL DEFAULT '',
      district TEXT NOT NULL DEFAULT '',
      village TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      lat REAL, lng REAL,
      stage TEXT NOT NULL DEFAULT 'new' CHECK(stage IN ('new','following','active','dormant','lost')),
      lost_reason TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  store.run(`INSERT INTO customers_legacy
      SELECT id, rep_id, name, phone, governorate, district, village, notes, lat, lng, stage, lost_reason, active, created_at, updated_at
      FROM customers`);
  store.run('DROP TABLE customers');
  store.run('ALTER TABLE customers_legacy RENAME TO customers');
  store.run('CREATE UNIQUE INDEX customers_rep_name ON customers(rep_id, name COLLATE NOCASE)');
  store.run('CREATE INDEX customers_rep_active ON customers(rep_id, active)');
  store.run('DROP INDEX IF EXISTS customers_unassigned_name');
  store.run('PRAGMA foreign_keys = ON');
}

/** A database in the old shape, holding one customer with a visit and an invoice already on him. */
function legacyBook(name = 'legacy.db', dropVisitLink = false) {
  const dir = mkdtempSync(join(tmpdir(), 'elhelp-customer-book-'));
  const file = join(dir, name);
  const store = new Store(file);
  const now = Date.now();
  const ids = { rep: randomUUID(), customer: randomUUID(), visit: randomUUID(), invoice: randomUUID(), warehouse: randomUUID() };
  store.run('INSERT INTO users(id,name,email,password_hash,role,region,created_at) VALUES (?,?,?,?,?,?,?)',
    ids.rep, 'مهندس طنطا', `rep.${ids.rep.slice(0, 8)}@mandoub.test`, 'salt:hash', 'rep', 'طنطا', now);
  store.run('INSERT INTO warehouses(id,name,governorate,created_at,updated_at) VALUES (?,?,?,?,?)',
    ids.warehouse, 'مخزن طنطا', 'الغربية', now, now);
  store.run(`INSERT INTO customers(id,rep_id,name,phone,governorate,district,stage,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, ids.customer, ids.rep, 'مزرعة الجابرية', '01000000001', 'الغربية', 'طنطا', 'active', now - 30 * DAY, now - 2 * DAY);
  if (!dropVisitLink) {
    store.run(`INSERT INTO visits(id,user_id,customer_name,customer_id,checked_in_at,created_at,status)
      VALUES (?,?,?,?,?,?,'closed')`, ids.visit, ids.rep, 'مزرعة الجابرية', ids.customer, now - 2 * DAY, now - 2 * DAY);
  } else {
    // An even older book: visits were free text, and the column that links them to a customer is
    // itself added by a migration further down the list.
    store.run('DROP INDEX IF EXISTS visits_customer');
    store.run('ALTER TABLE visits DROP COLUMN customer_id');
  }
  store.run(`INSERT INTO invoices(id,number,customer_id,customer_name,rep_id,warehouse_id,invoice_date,total,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, ids.invoice, 'INV-2026-0777', dropVisitLink ? null : ids.customer, 'مزرعة الجابرية',
  ids.rep, ids.warehouse, now - DAY, 5240, now, now);
  downgradeBook(store);
  assert.match(String(store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='customers'")?.sql || ''), /rep_id TEXT NOT NULL/,
    'the fixture has to be the shape the migration is meant to find');
  return { dir, file, store, ids, now };
}

test('the rebuild makes rep_id nullable without unlinking the history that points at it', () => {
  const { dir, file, store, ids } = legacyBook();
  store.close();

  const upgraded = new Store(file);
  const definition = String(upgraded.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='customers'")?.sql || '');
  assert.doesNotMatch(definition, /rep_id\s+TEXT\s+NOT NULL/i, 'the constraint that blocked the company list is gone');
  assert.match(definition, /rep_id TEXT REFERENCES users\(id\) ON DELETE SET NULL/, 'and a customer outlives the engineer he was assigned to');

  // The row itself, with its owner and its fields, carried over — not re-seeded.
  const row = upgraded.get('SELECT rep_id AS repId, name, phone, governorate, district, stage, created_at AS createdAt FROM customers WHERE id=?', ids.customer) as Record<string, any>;
  assert.ok(row, 'the customer is still there');
  assert.equal(row.repId, ids.rep);
  assert.equal(row.name, 'مزرعة الجابرية');
  assert.equal(row.district, 'طنطا');
  assert.equal(row.stage, 'active');

  // The failure this file exists to catch: a rebuild that leaves the rows and quietly clears what
  // points at them.
  assert.equal(upgraded.get('SELECT customer_id AS customerId FROM visits WHERE id=?', ids.visit)?.customerId, ids.customer,
    'the visit still knows whose customer it was');
  assert.equal(upgraded.get('SELECT customer_id AS customerId FROM invoices WHERE id=?', ids.invoice)?.customerId, ids.customer,
    'and so does the invoice');
  assert.equal((upgraded.all('PRAGMA foreign_key_check') as any[]).length, 0, 'no broken reference anywhere');

  // What has to survive the rebuild is the rule that was there before it: two rows for one farm inside
  // ONE engineer's list is still refused by SQLite itself, index and all.
  assert.throws(() => upgraded.run('INSERT INTO customers(id,rep_id,name,created_at,updated_at) VALUES (?,?,?,?,?)',
    randomUUID(), ids.rep, 'مزرعة الجابرية', Date.now(), Date.now()), /UNIQUE/,
  'the rebuild must not quietly drop the per-owner name rule');

  // The company list, on the other hand, has a lookup index and not a UNIQUE one — deliberately, and
  // this is the reason. The office has typed the same farm itself; when the engineer goes, his row
  // comes back to the list and lands next to it. A unique index here would refuse the ON DELETE SET
  // NULL, so the manager pressing «حذف الحساب» would get an error about a duplicate name with the
  // account half-deleted. Two rows a person can see and merge beats a deletion that cannot happen.
  upgraded.run('INSERT INTO customers(id,name,governorate,district,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    randomUUID(), 'مزرعة الجابرية', 'الغربية', 'طنطا', Date.now(), Date.now());
  upgraded.run('DELETE FROM users WHERE id=?', ids.rep);
  assert.equal(upgraded.get('SELECT rep_id AS repId FROM customers WHERE id=?', ids.customer)?.repId, null,
    'an engineer leaving returns his customers to the company instead of taking them with him');
  assert.equal(Number(upgraded.get('SELECT COUNT(*) AS c FROM customers WHERE rep_id IS NULL AND name=?', 'مزرعة الجابرية')?.c), 2,
    'the pair is left for the area screen to show and the manager to merge');
  upgraded.close();

  // The second boot finds nothing to do and must not move anybody twice.
  const again = new Store(file);
  assert.equal(Number(again.get('SELECT COUNT(*) AS c FROM customers')?.c), 2);
  assert.equal(again.get('SELECT rep_id AS repId FROM customers WHERE id=?', ids.customer)?.repId, null);
  again.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a database older than the visit link still boots through the rebuild', () => {
  // The rebuild checks that no child row was left pointing at a missing customer, and two of those
  // children only have the column because a later migration adds it. Asking for it first is the
  // difference between an upgrade and a server that refuses to start.
  const { dir, file, store } = legacyBook('very-old.db', true);
  store.close();
  const upgraded = new Store(file);
  assert.ok((upgraded.all('PRAGMA table_info(visits)') as Array<{ name: string }>).some(col => col.name === 'customer_id'),
    'the migration adds the link column back after the rebuild ran without it');
  assert.equal((upgraded.all('PRAGMA foreign_key_check') as any[]).length, 0);
  assert.ok(upgraded.get('SELECT id FROM customers'), 'the old customer rows came through');
  upgraded.close();
  rmSync(dir, { recursive: true, force: true });
});
