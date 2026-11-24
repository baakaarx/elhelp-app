import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';

/**
 * The customer book at the database layer — two questions, both answered on a file rather than in
 * memory, because the risk here is the install that already exists.
 *
 * One: does a fresh install get the shape the office needs (a customer the manager can enter before
 * anybody decides who serves him, one name per owner, and the visit pointing at a row instead of at a
 * typed string). Two: does an old database gain all of that by starting up — it used to fail to start
 * at all, because the index on `visits.customer_id` was written next to the table definitions while
 * the column only arrives with a migration further down. That is not a warning an operator notices.
 */
const DAY = 86400000;

function tempStore(name = 'mandoub.db') {
  const dir = mkdtempSync(join(tmpdir(), 'elhelp-customer-book-'));
  return { dir, file: join(dir, name), store: new Store(join(dir, name)) };
}
const columns = (store: Store, table: string) => (store.all(`PRAGMA table_info(${table})`) as Array<{ name: string }>).map(col => col.name);
function seedRep(store: Store, id: string, region = 'طنطا') {
  store.run('INSERT INTO users(id,name,email,password_hash,role,region,created_at) VALUES (?,?,?,?,?,?,?)',
    id, 'مهندس ' + id, `${id}.${id.length}@mandoub.test`, 'salt:hash', 'rep', region, Date.now());
}
function addCustomer(store: Store, id: string, repId: string | null, name: string, area = { governorate: 'الغربية', district: 'طنطا' }) {
  store.run(`INSERT INTO customers(id,rep_id,name,phone,governorate,district,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, id, repId, name, '01000000000', area.governorate, area.district, Date.now(), Date.now());
}

test('a fresh install gets the book, the one-name rule, and the visit link', () => {
  const { dir, store } = tempStore();
  assert.deepEqual(['id', 'rep_id', 'name', 'phone', 'governorate', 'district', 'village', 'notes', 'stage', 'lost_reason', 'price_tier_id', 'active', 'created_at', 'updated_at'],
    columns(store, 'customers'), 'the columns the office edits, and nothing it has to guess');
  assert.ok(columns(store, 'visits').includes('customer_id'), 'a visit can point at a customer');
  seedRep(store, 'rep-1');
  // «not distributed yet» is a real state of the list, not a half-row: entering a customer in the
  // office before naming an engineer must be possible.
  addCustomer(store, 'pool-1', null, 'مزرعة السواحل');
  assert.equal(store.get('SELECT rep_id AS r FROM customers WHERE id=?', 'pool-1')?.r, null);
  addCustomer(store, 'held-1', 'rep-1', 'مزرعة أبو علي');
  // One name per owner is a UNIQUE index, because a duplicated customer is a duplicated sales figure.
  assert.throws(() => addCustomer(store, 'held-2', 'rep-1', 'مزرعة أبو علي'), /UNIQUE/);
  // …and the same farm in a different owner's hands (or nobody's) is real life, not a violation.
  seedRep(store, 'rep-2');
  addCustomer(store, 'held-3', 'rep-2', 'مزرعة أبو علي');
  addCustomer(store, 'pool-2', null, 'مزرعة أبو علي');
  // The book is entered by the office, so a row cannot pretend to belong to a person who does not
  // exist — the foreign key is what makes «we assigned him to nobody» impossible by accident.
  assert.throws(() => addCustomer(store, 'lost-1', 'ghost-rep', 'عميل يتيم'), /FOREIGN KEY/);
  // pool-1, held-1, held-3, pool-2 — the rejected row never arrived, so the count proves it too.
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM customers')?.c), 4);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('an existing database gains the book on startup without losing its visits', () => {
  const { dir, file, store } = tempStore();
  seedRep(store, 'rep-1');
  addCustomer(store, 'held-1', 'rep-1', 'مزرعة أبو علي');
  store.run("INSERT INTO visits(id,user_id,customer_name,checked_in_at,created_at,status) VALUES ('v-old','rep-1','محمود المزرعة',?,?, 'closed')",
    Date.now() - DAY, Date.now() - DAY);
  // Downgrade the file to the shape a live install has today: no book, and no link column at all.
  store.run('DROP INDEX IF EXISTS visits_customer');
  store.run('ALTER TABLE visits DROP COLUMN customer_id');
  store.run('DROP TABLE customers');
  assert.equal(columns(store, 'customers').length, 0, 'the fixture really is the old shape');
  assert.ok(!columns(store, 'visits').includes('customer_id'));
  store.close();

  // This line is the whole test: before the index moved below the migrations, it threw
  // «no such column: customer_id» and the server never came up.
  const upgraded = new Store(file);
  assert.ok(columns(upgraded, 'customers').includes('name'), 'the table arrives with the columns, not just the name');
  assert.ok(columns(upgraded, 'visits').includes('customer_id'), 'and the visit gains its link');
  assert.ok(upgraded.all("SELECT name FROM sqlite_master WHERE type='index' AND name='visits_customer'").length, 'the lookup index is there too');
  const visit = upgraded.get("SELECT customer_name AS name, customer_id AS customerId FROM visits WHERE id='v-old'") as Record<string, any>;
  assert.equal(visit.name, 'محمود المزرعة', 'the recorded name is kept as it was written');
  assert.equal(visit.customerId, null, 'and it is NOT merged into a customer by guessing from the text');
  // The book starts empty on an install that is upgrading, and that is the honest outcome: the names
  // typed in the field were never records, and «محمود» in a visit row is not proof of which farm it is.
  // The office enters the list; nothing here merges a visit into a customer by guessing from text.
  assert.equal(Number(upgraded.get('SELECT COUNT(*) AS c FROM customers')?.c), 0);
  // And the link is enforced, not decorative: a visit written against a customer that does not exist is
  // refused by the database, on a file that just gained the column a moment ago.
  const badVisit = "INSERT INTO visits(id,user_id,customer_name,customer_id,checked_in_at,created_at,status) VALUES ('v-bad','rep-1','عميل وهمي','ghost-customer',?,?,'open')";
  assert.throws(() => upgraded.run(badVisit, Date.now(), Date.now()), /FOREIGN KEY/);
  assert.equal((upgraded.all('PRAGMA foreign_key_check') as any[]).length, 0, 'nothing points at a missing row');
  upgraded.close();
  rmSync(dir, { recursive: true, force: true });
});

test('retention sweeps the visit log and never the customer book', () => {
  const { dir, store } = tempStore();
  seedRep(store, 'rep-1');
  addCustomer(store, 'held-1', 'rep-1', 'مزرعة أبو علي');
  store.run('UPDATE customers SET created_at=?, updated_at=? WHERE id=?', Date.now() - 400 * DAY, Date.now() - 400 * DAY, 'held-1');
  store.run("INSERT INTO visits(id,user_id,customer_name,customer_id,checked_in_at,created_at,status)\n    VALUES ('v-old','rep-1','مزرعة أبو علي','held-1',?,?, 'closed')",
    Date.now() - 400 * DAY, Date.now() - 400 * DAY);
  store.cleanup(30);
  assert.equal(store.get("SELECT id FROM visits WHERE id='v-old'"), undefined, 'the visit is history, and history ages out');
  assert.ok(store.get("SELECT id FROM customers WHERE id='held-1'"), 'the list itself does not');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
