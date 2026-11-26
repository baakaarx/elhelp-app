import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PRICE_TIERS, Store } from '../src/db.js';

/**
 * The price list at the database layer: the items, the buyer types, and the prices between them.
 *
 * Three things get checked, because three things went wrong in real quotes before:
 * one item entered under two packs (and sold twice as much), a unit guessed by the software
 * («كرتونة» for something that ships in bottles, which reads as twelve times the price), and a
 * restart putting back a buyer type the office had deliberately deleted.
 */
const DAY = 86400000;
function tempStore(name = 'mandoub.db') {
  const dir = mkdtempSync(join(tmpdir(), 'elhelp-catalogue-'));
  return { dir, file: join(dir, name), store: new Store(join(dir, name)) };
}
const columns = (store: Store, table: string) => (store.all(`PRAGMA table_info(${table})`) as Array<{ name: string; dflt_value: string | null; notnull: number }>)
  .map(col => col.name);
const column = (store: Store, table: string, name: string) =>
  (store.all(`PRAGMA table_info(${table})`) as Array<Record<string, any>>).find(col => col.name === name);
function addProduct(store: Store, id: string, name: string, unit: string, unitSize = '') {
  store.run('INSERT INTO products(id,name,category,unit,unit_size,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    id, name, 'fertilizer', unit, unitSize, Date.now(), Date.now());
}
function tierId(store: Store, name: string) {
  return String(store.get('SELECT id FROM price_tiers WHERE name=?', name)!.id);
}

test('a new installation gets the price list, and starts with the three buyer types', () => {
  const { dir, store } = tempStore();
  assert.deepEqual(columns(store, 'products'), ['id', 'name', 'category', 'unit', 'unit_size', 'notes', 'active', 'created_at', 'updated_at']);
  assert.deepEqual(columns(store, 'product_prices'), ['product_id', 'tier_id', 'price', 'updated_at']);
  // A customer carries a buyer type, and it is not the relationship stage: «جديد» says where things
  // stand, «جملة» says what he pays.
  assert.ok(column(store, 'customers', 'price_tier_id'), 'the customer row knows how he is quoted');
  assert.equal(column(store, 'customers', 'price_tier_id')!.notnull, 0, 'and null is allowed: nobody decided yet');

  const tiers = store.all('SELECT name, position, active FROM price_tiers ORDER BY position') as Array<{ name: string; position: number; active: number }>;
  assert.deepEqual(tiers.map(tier => tier.name), DEFAULT_PRICE_TIERS, 'the seeded list, in the order it is read');
  assert.deepEqual(tiers.map(tier => tier.position), [0, 1, 2]);
  assert.ok(tiers.every(tier => tier.active === 1));

  // The unit is not filled in by the software. This is the whole reason the column has no default.
  assert.throws(() => store.run('INSERT INTO products(id,name,category,created_at,updated_at) VALUES (?,?,?,?,?)', 'p-x', 'يوريا', 'fertilizer', Date.now(), Date.now()), /NOT NULL/);
  assert.equal(column(store, 'products', 'unit')!.dflt_value, null, 'no default, so nobody inherits one');

  const urea = 'p-urea';
  addProduct(store, urea, 'يوريا', 'شيكارة', '٥٠ كجم');
  // The same item by the same pack is one item, whatever the office's second typist believes.
  assert.throws(() => addProduct(store, 'p-dup', 'يوريا', 'شيكارة'), /UNIQUE|PRODUCT_PACK_CONFLICT/);
  // …and a different pack is a different item: 50 kg and 25 kg are not one price.
  addProduct(store, 'p-urea25', 'يوريا', 'شيكارة', '٢٥ كجم');
  assert.throws(() => addProduct(store, 'p-dup25', 'يوريا', 'شيكارة', '٢٥ كجم'), /UNIQUE|PRODUCT_PACK_CONFLICT/);

  store.run('INSERT INTO product_prices(product_id,tier_id,price,updated_at) VALUES (?,?,?,?)', urea, tierId(store, 'جملة'), 1150, Date.now());
  // SQLite reports a composite primary key as a unique violation; either wording means the second row
  // for the same item and type was refused rather than quietly replacing the price.
  assert.throws(() => store.run('INSERT INTO product_prices(product_id,tier_id,price,updated_at) VALUES (?,?,?,?)', urea, tierId(store, 'جملة'), 1200, Date.now()), /constraint failed: product_prices/);
  // An item is allowed to have no price for a type: that order gets priced by hand.
  assert.equal(store.get('SELECT price FROM product_prices WHERE product_id=? AND tier_id=?', urea, tierId(store, 'تجزئة')), undefined);
  // A buyer type is named or it is not a type: the name is what the price list header reads, and a
  // blank row is exactly what a half-finished migration left on a real installation.
  assert.throws(() => store.run('INSERT INTO price_tiers(id,name,position,created_at,updated_at) VALUES (?,?,?,?,?)', 'blank', '', 9, Date.now(), Date.now()), /CHECK/);
  assert.throws(() => store.run('INSERT INTO price_tiers(id,name,position,created_at,updated_at) VALUES (?,?,?,?,?)', 'sp', '   ', 9, Date.now(), Date.now()), /CHECK/);
  assert.equal(store.get("SELECT id FROM price_tiers WHERE id='blank'"), undefined, 'the refused row never arrived');
  // …and a price is never negative: either a mistake, or a discount hiding where a discount needs a reason.
  assert.throws(() => store.run('INSERT INTO product_prices(product_id,tier_id,price,updated_at) VALUES (?,?,?,?)', 'p-urea25', tierId(store, 'جملة'), -5, Date.now()), /CHECK/);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a buyer type the office deleted is not resurrected by the next start', () => {
  const { dir, file, store } = tempStore();
  assert.equal(store.get("SELECT id FROM price_tiers WHERE name='نصف جملة'") !== undefined, true, 'the seed put it there first');
  store.run('DELETE FROM price_tiers WHERE name=?', 'نصف جملة');
  store.close();
  // The seeding asks whether THIS OPEN created the table, not whether the table is empty — otherwise a
  // manager removing a rate finds it back in the list the next morning.
  const again = new Store(file);
  assert.equal(again.get("SELECT id FROM price_tiers WHERE name='نصف جملة'"), undefined, 'a deliberate deletion survives a restart');
  assert.equal(Number(again.get('SELECT COUNT(*) AS c FROM price_tiers')?.c), 2, 'and the two that stay, stay');
  again.close();
  rmSync(dir, { recursive: true, force: true });
});

test('deleting an item takes its prices, deleting a type leaves customers unquoted', () => {
  const { dir, store } = tempStore();
  const urea = 'p-urea';
  addProduct(store, urea, 'يوريا', 'شيكارة', '٥٠ كجم');
  const wholesale = tierId(store, 'جملة');
  store.run('INSERT INTO product_prices(product_id,tier_id,price,updated_at) VALUES (?,?,?,?)', urea, wholesale, 1150, Date.now());
  store.run(`INSERT INTO customers(id,name,phone,governorate,district,stage,price_tier_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, 'c-1', 'مزرعة الدلتا', '01000000000', 'الغربية', 'طنطا', 'active', wholesale, Date.now(), Date.now());
  assert.equal(Number(store.get('SELECT price FROM product_prices WHERE product_id=? AND tier_id=?', urea, wholesale)?.price), 1150);

  // A price list row without its item is noise, so it goes with it. A customer without a buyer type is
  // still a customer, so the reference only clears the link.
  store.run('DELETE FROM products WHERE id=?', urea);
  assert.equal(store.get('SELECT * FROM product_prices WHERE product_id=?', urea), undefined, 'the price went with the item');
  assert.equal(store.get("SELECT price_tier_id AS t FROM customers WHERE id='c-1'")?.t, wholesale, 'the type still exists, the customer still carries it');
  store.run('DELETE FROM price_tiers WHERE id=?', wholesale);
  assert.equal(store.get("SELECT price_tier_id AS t FROM customers WHERE id='c-1'")?.t, null, 'and losing the type makes him unquoted, not deleted');
  assert.equal(store.get("SELECT name FROM customers WHERE id='c-1'")?.name, 'مزرعة الدلتا');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a table left behind with another shape does not stop the server from starting', () => {
  // The state a real installation gets into: an abandoned version of this file already made a products
  // table, with its own columns under the same name. The schema above skips the CREATE, so the indexes
  // that name our columns would be asking SQLite to index a column that is not there — which is not a
  // warning an operator ever sees, it is a server that never comes up.
  const { dir, file, store } = tempStore();
  store.run('PRAGMA foreign_keys=OFF');
  store.run('DROP TABLE product_prices');
  store.run('DROP TABLE products');
  // Exactly the shape that abandoned version left: a guessed «كرتونة» default and one flat price.
  store.run(`CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'كرتونة',
      default_price REAL NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  store.run("INSERT INTO products(id,name,unit,default_price,created_at,updated_at) VALUES ('legacy','يوريا ٥٠ كجم','كرتونة',13800,?,?)", Date.now(), Date.now());
  store.close();

  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  let legacy: Store | undefined;
  try { legacy = new Store(file); } finally { console.error = realError; }
  assert.ok(legacy, 'the installation came up');
  const messages = errors.join('\n');
  assert.match(messages, /skipped index products_active_category/, 'and said which index it could not build');
  assert.match(messages, /products does not have category/, 'and which column is missing');
  assert.equal(legacy!.get("SELECT unit, default_price AS price FROM products WHERE id='legacy'")?.price, 13800, 'the foreign rows were left exactly as they were');
  assert.deepEqual(legacy!.all('SELECT name FROM price_tiers ORDER BY position').map((row: any) => row.name), DEFAULT_PRICE_TIERS, 'the tables it can build, it built');
  legacy!.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a price table left pointing at the renamed copy is said at boot, not at the first write', () => {
  // What my own repair left behind on the dev database once: the legacy products table was renamed, and
  // SQLite quietly moved product_prices' foreign key onto the renamed copy. The list read fine, and the
  // first price anybody saved failed with a constraint error that named nothing useful.
  const { dir, file, store } = tempStore();
  store.run('PRAGMA foreign_keys=OFF');
  store.run('ALTER TABLE products RENAME TO products_legacy_rejected_batch');
  store.run(`CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other',
      unit TEXT NOT NULL, unit_size TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  store.close();

  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  let again: Store | undefined;
  try { again = new Store(file); } finally { console.error = realError; }
  const messages = errors.join('\n');
  assert.match(messages, /product_prices\.product_id references products_legacy_rejected_batch instead of products/, 'it says which link is wrong');
  assert.match(messages, /repair-legacy-catalogue\.mjs/, 'and names the script that fixes it');
  // The server still comes up: a broken link is a write that fails, not a boot that fails, and the
  // dashboard still reads the list while the office finds the terminal.
  assert.ok(again, 'the installation came up anyway');
  assert.deepEqual(again!.all('SELECT name FROM price_tiers ORDER BY position').map((row: any) => row.name), DEFAULT_PRICE_TIERS, 'and the rest of the boot ran');
  assert.equal((again!.all('PRAGMA foreign_key_list(product_prices)') as Array<Record<string, any>>).find(fk => fk.from === 'product_id')!.table, 'products_legacy_rejected_batch', 'the bad link is left as it is — the office runs the repair, the server does not rewrite a table under them');
  again!.close();
  rmSync(dir, { recursive: true, force: true });
});

test('an empty price list is refilled, a partial one is left alone', () => {
  const { dir, store } = tempStore();
  // The half-boot case: the table exists, nothing in it. An office that deleted ONE type keeps that
  // deletion (proved in the test above), because only an empty list is refilled.
  store.run('DELETE FROM price_tiers');
  store.close();
  const again = new Store(join(dir, 'mandoub.db'));
  assert.deepEqual(again.all('SELECT name FROM price_tiers ORDER BY position').map((row: any) => row.name), DEFAULT_PRICE_TIERS, 'a list with nothing in it is not a usable state');
  again.close();
  rmSync(dir, { recursive: true, force: true });
});

test('an existing database gains the price list on startup without losing its customers', () => {
  const { dir, file, store } = tempStore();
  store.run('INSERT INTO users(id,name,email,password_hash,role,region,created_at) VALUES (?,?,?,?,?,?,?)',
    'rep-1', 'مهندس طنطا', 'r1@x.test', 'salt:hash', 'rep', 'طنطا', Date.now());
  store.run(`INSERT INTO customers(id,rep_id,name,phone,governorate,district,stage,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, 'c-old', 'rep-1', 'محل النصر', '01000000001', 'الغربية', 'طنطا', 'active', Date.now() - DAY, Date.now() - DAY);
  store.run("INSERT INTO visits(id,user_id,customer_name,customer_id,checked_in_at,created_at,status) VALUES ('v-1','rep-1','محل النصر','c-old',?,?, 'closed')",
    Date.now() - DAY, Date.now() - DAY);
  // Downgrade to what a live install holds today: no price list at all, and no link column on the row.
  store.run('PRAGMA foreign_keys=OFF');
  store.run('DROP TABLE product_prices');
  store.run('DROP TABLE products');
  store.run('ALTER TABLE customers DROP COLUMN price_tier_id');
  store.run('DROP TABLE price_tiers');
  store.run('PRAGMA foreign_keys=ON');
  assert.equal(columns(store, 'products').length, 0, 'the fixture really is the old shape');
  assert.equal(columns(store, 'customers').includes('price_tier_id'), false);
  store.close();

  // This line is the test: an index or a seed placed before the migrations is exactly what made the
  // server refuse to start on an install that already existed.
  const upgraded = new Store(file);
  assert.ok(columns(upgraded, 'products').includes('unit'));
  assert.ok(columns(upgraded, 'customers').includes('price_tier_id'), 'the customer gains the column');
  assert.deepEqual(upgraded.all('SELECT name FROM price_tiers ORDER BY position').map((row: any) => row.name), DEFAULT_PRICE_TIERS, 'and the office starts from the three types');
  const customer = upgraded.get("SELECT name, price_tier_id AS tier FROM customers WHERE id='c-old'") as Record<string, any>;
  assert.equal(customer.name, 'محل النصر', 'the book survived');
  assert.equal(customer.tier, null, 'and nobody is quoted at a rate that was never chosen for him');
  assert.equal(upgraded.get("SELECT customer_name AS name FROM visits WHERE id='v-1'")?.name, 'محل النصر', 'the visit is untouched');
  assert.equal((upgraded.all('PRAGMA foreign_key_check') as any[]).length, 0, 'nothing points at a missing row');
  upgraded.close();
  rmSync(dir, { recursive: true, force: true });
});

test('retention sweeps the visit log and never the price list', () => {
  const { dir, store } = tempStore();
  const old = Date.now() - 400 * DAY;
  addProduct(store, 'p-old', 'سوبر فوسفات', 'شيكارة', '٥٠ كجم');
  store.run('INSERT INTO product_prices(product_id,tier_id,price,updated_at) VALUES (?,?,?,?)', 'p-old', tierId(store, 'جملة'), 780, old);
  store.run('UPDATE products SET created_at=?, updated_at=? WHERE id=?', old, old, 'p-old');
  store.run('UPDATE price_tiers SET created_at=?, updated_at=?', old, old);
  store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
    'rep-1', 'مهندس', 'r@x.test', 'salt:hash', 'rep', old);
  store.run(`INSERT INTO customers(id,rep_id,name,phone,governorate,district,stage,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, 'c-1', 'rep-1', 'مزرعة', '', 'الغربية', 'طنطا', 'new', old, old);
  store.run("INSERT INTO visits(id,user_id,customer_name,customer_id,checked_in_at,created_at,status) VALUES ('v-old','rep-1','مزرعة','c-1',?,?, 'closed')", old, old);
  store.cleanup(30);
  assert.equal(store.get("SELECT id FROM visits WHERE id='v-old'"), undefined, 'the visit is history');
  assert.ok(store.get("SELECT id FROM products WHERE id='p-old'"), 'the item is not');
  assert.equal(Number(store.get("SELECT COUNT(*) AS c FROM product_prices")?.c), 1, 'nor is its price');
  assert.equal(Number(store.get("SELECT COUNT(*) AS c FROM price_tiers")?.c), 3, 'nor the buyer types');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});


test('old product index migrates atomically without changing linked prices or stock', () => {
  const {dir,file,store}=tempStore();
  addProduct(store,'legacy-pack','اختبار ترحيل عبوة','عبوة','١٠٠ جم');
  const tier=tierId(store,'جملة');store.run('INSERT INTO product_prices(product_id,tier_id,price,updated_at) VALUES (?,?,?,?)','legacy-pack',tier,123.45,100);
  store.db.exec('DROP TRIGGER products_pack_insert; DROP TRIGGER products_pack_update; DROP INDEX products_name_unit_size; CREATE UNIQUE INDEX products_name_unit ON products(name COLLATE NOCASE,unit COLLATE NOCASE)');
  store.close();const upgraded=new Store(file);
  assert.equal(upgraded.get('SELECT price FROM product_prices WHERE product_id=? AND tier_id=?','legacy-pack',tier)?.price,123.45);
  assert.equal(upgraded.get('SELECT unit_size FROM products WHERE id=?','legacy-pack')?.unit_size,'١٠٠ جم');
  assert.equal(upgraded.get("SELECT name FROM sqlite_master WHERE type='index' AND name='products_name_unit'"),undefined);
  addProduct(upgraded,'new-pack','اختبار ترحيل عبوة','عبوة','٢٥٠ جم');
  assert.throws(()=>addProduct(upgraded,'unknown-pack','اختبار ترحيل عبوة','عبوة',''),/PRODUCT_PACK_CONFLICT|UNIQUE/);
  assert.throws(()=>upgraded.run("UPDATE products SET unit_size=? WHERE id=?",'١٠٠ جم','new-pack'),/PRODUCT_PACK_CONFLICT|UNIQUE/);
  upgraded.close();const restarted=new Store(file);assert.equal(restarted.get('SELECT COUNT(*) AS c FROM products WHERE name=?','اختبار ترحيل عبوة')?.c,2);restarted.close();rmSync(dir,{recursive:true,force:true});
});

test('migration fails without deleting data if a legacy database has conflicting exact packs', () => {
  const {dir,file,store}=tempStore();
  store.db.exec('DROP TRIGGER products_pack_insert; DROP TRIGGER products_pack_update; DROP INDEX products_name_unit_size');
  addProduct(store,'legacy-a','صنف تضارب قديم','عبوة','١٠٠ جم');
  addProduct(store,'legacy-b','صنف تضارب قديم','عبوة','١٠٠ جم');
  store.close();
  assert.throws(()=>new Store(file),/UNIQUE/);
  const raw=new DatabaseSync(file);assert.equal((raw.prepare("SELECT COUNT(*) AS c FROM products WHERE name='صنف تضارب قديم'").get() as {c:number}).c,2);
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='products_name_unit_size'").get(),undefined);raw.close();rmSync(dir,{recursive:true,force:true});
});
