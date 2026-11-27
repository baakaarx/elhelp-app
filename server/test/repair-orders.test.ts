import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.js';

/**
 * The repair script on a database whose `orders` table belongs to someone else.
 *
 * This is the upgrade path, tested end to end because each half of it looked fine on its own: the server
 * comes up on a wrong-shaped table and only says so in the boot log, and the script renames the table and
 * reports success. Between them sat the fault — SQLite moves a child's REFERENCES clause along with the
 * renamed parent, so `order_lines` stayed pointing at the dead copy and the office had to run the script a
 * second time to find out. So this file boots a dirty database, repairs it once, and boots it again.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/repair-legacy-catalogue.mjs', import.meta.url));

/** A real installation shape: the current schema, then an abandoned build's `orders` laid over it. */
function dirtyDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'elhelp-repair-orders-'));
  const file = join(dir, 'mandoub.db');
  const first = new Store(file);
  first.close();
  const wrecked = new Store(file);
  wrecked.run('DROP TABLE IF EXISTS order_lines');
  wrecked.run('DROP TABLE IF EXISTS orders');
  wrecked.run('CREATE TABLE orders (id TEXT PRIMARY KEY, rep_id TEXT, invoice_date INTEGER, amount REAL)');
  wrecked.run("INSERT INTO orders(id,rep_id,invoice_date,amount) VALUES ('legacy-1','rep-x',1700000000000,4200)");
  wrecked.close();
  return { dir, file };
}
/** Opens the file and keeps whatever the constructor had to say. */
function boot(file: string) {
  const lines: string[] = [];
  const real = console.error;
  try {
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    const store = new Store(file);
    return { store, complaints: lines.filter(line => line.includes('[db]')) };
  } finally {
    console.error = real;
  }
}
const foreignKeysOf = (store: Store, table: string) => (store.all(`PRAGMA foreign_key_list(${table})`) as Array<Record<string, any>>)
  .map(fk => `${fk.from}->${fk.table}`);

test('a dirty install warns at boot and still serves', () => {
  const { dir, file } = dirtyDatabase();
  const { store, complaints } = boot(file);
  assert.ok(complaints.length, 'the boot says which table is not the one it expects');
  assert.match(complaints.join('\n'), /skipped index orders_rep_time.*does not have user_id/s, '…by name, with the column that is missing');
  assert.equal(Number(store.get("SELECT COUNT(*) AS c FROM orders WHERE id='legacy-1'")!.c), 1, 'the foreign rows are its own business until the operator decides');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('one run of the repair leaves the child pointing at the real parent', () => {
  const { dir, file } = dirtyDatabase();
  boot(file).store.close();
  const output = execFileSync('node', [SCRIPT, '--db', file], { encoding: 'utf8', timeout: 120000 });
  assert.match(output, /orders → orders_legacy_rejected_batch/, 'it renames, never deletes');
  assert.match(output, /order_lines/, '…and it says it dealt with the child that got dragged along');
  const { store, complaints } = boot(file);
  assert.deepEqual(complaints, [], 'the second boot has nothing to complain about — the script is not a two-pass ritual');
  assert.equal((store.all('PRAGMA table_info(orders)') as unknown[]).length, 14, 'the current schema owns its table now');
  assert.deepEqual(foreignKeysOf(store, 'order_lines').sort(),
    ['order_id->orders', 'product_id->products', 'tier_id->price_tiers'].sort(), 'and the line points at a live parent');
  assert.equal(store.get("SELECT rep_id FROM orders_legacy_rejected_batch WHERE id='legacy-1'")!.rep_id, 'rep-x', 'nothing was thrown away on the way');
  assert.equal(store.all('PRAGMA foreign_key_check').length, 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('and the repaired box takes a real order', () => {
  const { dir, file } = dirtyDatabase();
  boot(file).store.close();
  execFileSync('node', [SCRIPT, '--db', file], { encoding: 'utf8', timeout: 120000 });
  const store = new Store(file);
  const now = Date.now();
  store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
    'rep-1', 'مهندس مصلَّح', 'rep1@repair.test', 'salt:hash', 'rep', now);
  store.run('INSERT INTO customers(id,rep_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', 'cust-1', 'rep-1', 'مزرعة مصلَّحة', now, now);
  store.run('INSERT INTO products(id,name,category,unit,unit_size,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    'prod-1', 'يوريا ٥٠ كجم', 'fertilizer', 'شيكارة', '٥٠ كجم', now, now);
  store.run('INSERT INTO orders(id,user_id,customer_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    'ord-1', 'rep-1', 'cust-1', 'sent', now, now);
  store.run(`INSERT INTO order_lines(id,order_id,position,product_id,product_name,unit,unit_size,qty,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, 'line-1', 'ord-1', 0, 'prod-1', 'يوريا ٥٠ كجم', 'شيكارة', '٥٠ كجم', 4, now);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM order_lines WHERE order_id=?', 'ord-1')!.c, 1, 'the write the office would have attempted goes through');
  assert.throws(() => store.run('DELETE FROM products WHERE id=?', 'prod-1'), /FOREIGN KEY constraint failed/,
    'with the guard that comes from the schema, not from a list someone updates');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
