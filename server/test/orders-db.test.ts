import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/db.js';

/**
 * The order at the database layer: what the engineer agreed to sell, before the office put a number on it.
 *
 * Five things are checked here because each one is a way the paper lies later. A quantity that counts
 * nothing (the same item on two lines, or zero, or a fat-fingered shipment). A price list edit reaching
 * backwards into a promise already made. A customer or an item being deleted out from under a closed
 * agreement. The nightly retention sweep taking an order along with the visit it was written in. And an
 * installation that already owns the name `orders` for something else — which is the one of these a
 * running server cannot notice by itself.
 */
const DAY = 86400000;

function tempStore(name = 'mandoub.db') {
  const dir = mkdtempSync(join(tmpdir(), 'elhelp-orders-'));
  return { dir, file: join(dir, name), store: new Store(join(dir, name)) };
}
const columns = (store: Store, table: string) => (store.all(`PRAGMA table_info(${table})`) as Array<{ name: string }>).map(col => col.name);
const foreignKeys = (store: Store, table: string) => (store.all(`PRAGMA foreign_key_list(${table})`) as Array<Record<string, any>>)
  .map(fk => `${fk.from}->${fk.table}:${fk.on_delete}`);
function seedRep(store: Store, id: string) {
  store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
    id, 'مهندس ' + id.slice(-4), `${id}@orders.test`, 'salt:hash', 'rep', Date.now());
}
function addProduct(store: Store, id: string, name = 'يوريا ٥٠ كجم', unit = 'شيكارة', unitSize = '٥٠ كجم') {
  store.run('INSERT INTO products(id,name,category,unit,unit_size,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    id, name, 'fertilizer', unit, unitSize, Date.now(), Date.now());
}
function addCustomer(store: Store, id: string, repId: string) {
  store.run('INSERT INTO customers(id,rep_id,name,phone,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    id, repId, 'مزرعة ' + id.slice(-4), '01000000000', Date.now(), Date.now());
}
function addVisit(store: Store, id: string, repId: string, customerId: string, ageDays = 0) {
  const at = Date.now() - ageDays * DAY;
  store.run(`INSERT INTO visits(id,user_id,customer_name,customer_id,purpose,status,checked_in_at,created_at)
    VALUES (?,?,?,?,'order','closed',?,?)`, id, repId, 'اسم من الزمن القديم', customerId, at, at);
}
function addOrder(store: Store, fields: { id?: string; repId: string; customerId: string; visitId?: string | null; status?: string; at?: number } = { repId: '', customerId: '' }) {
  const id = fields.id ?? randomUUID();
  const at = fields.at ?? Date.now();
  store.run(`INSERT INTO orders(id,user_id,customer_id,visit_id,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`, id, fields.repId, fields.customerId, fields.visitId ?? null, fields.status ?? 'draft', at, at);
  return id;
}
function addLine(store: Store, orderId: string, productId: string, qty: number, position = 0, extra: Record<string, unknown> = {}) {
  const product = store.get('SELECT name, unit, unit_size AS unitSize FROM products WHERE id=?', productId)!;
  store.run(`INSERT INTO order_lines(id,order_id,position,product_id,product_name,unit,unit_size,qty,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, extra.id ?? randomUUID(), orderId, position, productId,
  String(product.name), String(product.unit), String(product.unitSize), qty, Date.now());
}

test('a fresh install gets the order, its lines, and the direction each link points', () => {
  const { dir, store } = tempStore();
  assert.deepEqual(columns(store, 'orders'),
    ['id', 'user_id', 'customer_id', 'visit_id', 'status', 'notes', 'recorded_offline', 'total',
      'created_at', 'updated_at', 'sent_at', 'priced_at', 'priced_by'],
    'the columns the flow needs, and nothing the phone is allowed to fill in — there is no price column on the order');
  assert.deepEqual(columns(store, 'order_lines'),
    ['id', 'order_id', 'position', 'product_id', 'product_name', 'unit', 'unit_size', 'qty', 'notes', 'tier_id', 'price', 'created_at'],
    'a line is an item and a quantity, with the money fields left empty for the office');

  // Restriced where a deletion would un-make an agreement, cascading where the child is nothing without
  // the parent, and SET NULL where the linked row is a fact that ages out (a visit) or a decision that
  // can be revoked (a buyer type).
  assert.deepEqual(foreignKeys(store, 'orders').sort(),
    ['customer_id->customers:RESTRICT', 'priced_by->users:SET NULL', 'user_id->users:CASCADE', 'visit_id->visits:SET NULL'].sort());
  assert.deepEqual(foreignKeys(store, 'order_lines').sort(),
    ['order_id->orders:CASCADE', 'product_id->products:RESTRICT', 'tier_id->price_tiers:SET NULL'].sort());

  const names = store.all("SELECT name FROM sqlite_master WHERE type='index' AND (name LIKE 'orders%' OR name LIKE 'order_lines%')")
    .map((row: any) => row.name);
  for (const index of ['orders_rep_time', 'orders_customer_time', 'orders_visit', 'orders_queue', 'order_lines_item', 'order_lines_position', 'order_lines_product_ref']) {
    assert.ok(names.includes(index), `the queue the dashboard reads is indexed: ${index}`);
  }
  assert.equal(store.get("SELECT sql FROM sqlite_master WHERE name='orders_queue'")!.sql.includes("status = 'sent'"), true,
    'and it is a partial index: «what is waiting for the team» is a slice, not a scan');
  rmSync(dir, { recursive: true, force: true });
});

test('an order is three states, and nothing else', () => {
  const { dir, store } = tempStore();
  seedRep(store, 'rep-a');
  addCustomer(store, 'cust-a', 'rep-a');
  const id = addOrder(store, { repId: 'rep-a', customerId: 'cust-a' });
  assert.equal(store.get('SELECT status FROM orders WHERE id=?', id)!.status, 'draft', 'a new order starts on the phone, unsent');
  for (const status of ['sent', 'priced']) {
    assert.doesNotThrow(() => store.run('UPDATE orders SET status=? WHERE id=?', status, id), status);
  }
  // A fourth word is not a spelling variation: «cancelled» and «deleted» are what people reach for when
  // an agreement falls through, and both lose the fact that it was ever made.
  for (const status of ['cancelled', 'deleted', 'open', '']) {
    assert.throws(() => store.run('UPDATE orders SET status=? WHERE id=?', status, id), /CHECK constraint failed/, status);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('a quantity is a quantity: one line per item, never zero, never a shipment nobody ordered', () => {
  const { dir, store } = tempStore();
  seedRep(store, 'rep-b');
  addCustomer(store, 'cust-b', 'rep-b');
  addProduct(store, 'prod-b1');
  addProduct(store, 'prod-b2', 'سوبر فوسفات', 'جركن', '٢٠ لتر');
  const orderId = addOrder(store, { repId: 'rep-b', customerId: 'cust-b' });
  addLine(store, orderId, 'prod-b1', 3, 0);
  // The phone sends the same payload twice when a signal comes back mid-send; that is a replay, not a
  // second agreement, and it must not be able to double the sale.
  assert.throws(() => addLine(store, orderId, 'prod-b1', 3, 1), /UNIQUE constraint failed: order_lines.order_id, order_lines.product_id/);
  addLine(store, orderId, 'prod-b2', 2, 1, { id: randomUUID() });
  const other = addOrder(store, { repId: 'rep-b', customerId: 'cust-b' });
  addLine(store, other, 'prod-b1', 1, 0);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM order_lines WHERE order_id=?', other)!.c, 1, 'the same item is fine in a different order');
  for (const qty of [0, -2, 1e9]) {
    assert.throws(() => addLine(store, other, 'prod-b2', qty, 5), /CHECK constraint failed/, `qty ${qty}`);
  }
  addLine(store, other, 'prod-b2', 0.5, 6);
  assert.equal(Number(store.get('SELECT qty FROM order_lines WHERE order_id=? AND position=6', other)!.qty), 0.5, 'half a pack is a real order in this trade');
  // The office writes the money; a negative line price is a discount hiding where a reason belongs.
  assert.doesNotThrow(() => store.run('UPDATE order_lines SET price=1150 WHERE order_id=? AND position=0', orderId));
  assert.throws(() => store.run('UPDATE order_lines SET price=-1 WHERE order_id=? AND position=0', orderId), /CHECK constraint failed/);
  rmSync(dir, { recursive: true, force: true });
});

test('the line keeps the pack it was agreed in, even after the office changes it', () => {
  const { dir, store } = tempStore();
  seedRep(store, 'rep-c');
  addCustomer(store, 'cust-c', 'rep-c');
  addProduct(store, 'prod-c', 'يوريا ٥٠ كجم', 'شيكارة', '٥٠ كجم');
  const orderId = addOrder(store, { repId: 'rep-c', customerId: 'cust-c', status: 'priced' });
  addLine(store, orderId, 'prod-c', 4);
  // The catalogue is a live list: it gets renamed and re-packed. The order is a record.
  store.run("UPDATE products SET name='يوريا ٢٥ كجم', unit='كرتونة', unit_size='٢٥ كجم' WHERE id='prod-c'");
  const line = store.get('SELECT product_name AS name, unit, unit_size AS unitSize, qty FROM order_lines WHERE order_id=?', orderId)!;
  assert.deepEqual({ name: line.name, unit: line.unit, unitSize: line.unitSize, qty: line.qty },
    { name: 'يوريا ٥٠ كجم', unit: 'شيكارة', unitSize: '٥٠ كجم', qty: 4 },
    '«٤ شيكارة» stays four bags of fifty, because the number without the pack is not a promise');
  assert.equal(store.get('SELECT name FROM products WHERE id=?', 'prod-c')!.name, 'يوريا ٢٥ كجم', 'and the item itself did change for everyone else');
  rmSync(dir, { recursive: true, force: true });
});

test('an agreement cannot be deleted out from under', () => {
  const { dir, store } = tempStore();
  seedRep(store, 'rep-d');
  addCustomer(store, 'cust-d', 'rep-d');
  addProduct(store, 'prod-d');
  const orderId = addOrder(store, { repId: 'rep-d', customerId: 'cust-d', status: 'priced' });
  addLine(store, orderId, 'prod-d', 10);
  store.run('UPDATE orders SET total=? WHERE id=?', 11500, orderId);
  assert.throws(() => store.run('DELETE FROM customers WHERE id=?', 'cust-d'), /FOREIGN KEY constraint failed/,
    'the customer an order was written against stays, stopped rather than deleted');
  assert.throws(() => store.run('DELETE FROM products WHERE id=?', 'prod-d'), /FOREIGN KEY constraint failed/,
    'and so does the item a priced line points at');
  // The order itself is the exception: it belongs to a line of the book, and taking the whole order away
  // with its lines is what deleting a mis-typed draft means.
  assert.doesNotThrow(() => store.run('DELETE FROM orders WHERE id=?', orderId));
  assert.equal(store.get('SELECT COUNT(*) AS c FROM order_lines WHERE order_id=?', orderId)!.c, 0, 'the lines go with it, and no orphan is left to price');
  assert.equal(store.get('SELECT COUNT(*) AS c FROM customers WHERE id=?', 'cust-d')!.c, 1, 'the customer is still there');
  rmSync(dir, { recursive: true, force: true });
});

test('retention sweeps the visit and leaves the order, with its history intact', () => {
  const { dir, store } = tempStore();
  seedRep(store, 'rep-e');
  addCustomer(store, 'cust-e', 'rep-e');
  addProduct(store, 'prod-e');
  addVisit(store, 'visit-e', 'rep-e', 'cust-e', 30);
  const orderId = addOrder(store, { repId: 'rep-e', customerId: 'cust-e', visitId: 'visit-e', status: 'priced', at: Date.now() - 30 * DAY });
  addLine(store, orderId, 'prod-e', 6);
  store.run('UPDATE orders SET total=?, priced_at=? WHERE id=?', 6900, Date.now() - 30 * DAY, orderId);
  store.cleanup(7);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM visits WHERE id=?', 'visit-e')!.c, 0, 'the visit is past the retention window');
  const order = store.get('SELECT visit_id AS visitId, status, total FROM orders WHERE id=?', orderId)!;
  assert.equal(order.visitId, null, 'the order stops claiming a visit that is gone');
  assert.equal(order.status, 'priced', '…but it is still a priced order');
  assert.equal(Number(order.total), 6900, '…with the number the office wrote');
  assert.equal(store.get('SELECT COUNT(*) AS c FROM order_lines WHERE order_id=?', orderId)!.c, 1, '…and its lines');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('an install whose `orders` table is someone else starts anyway and says which table is wrong', () => {
  // Not hypothetical: an abandoned branch of this project already owns `invoices`, `warehouses` and
  // `stock_movements` on boxes it was tried on. If a future one owns `orders`, the server must come up —
  // with the mismatch named — rather than refuse to boot on the manager's only machine.
  const { dir, file } = tempStore();
  const foreign = new Store(file);
  foreign.close();
  const raw = new Store(file);
  raw.run('ALTER TABLE orders RENAME TO orders_something_else');
  raw.run('CREATE TABLE orders (id TEXT PRIMARY KEY, rep_id TEXT, invoice_date INTEGER, amount REAL)');
  raw.run("INSERT INTO orders(id,rep_id,invoice_date,amount) VALUES ('old-1','rep-x',1,999)");
  raw.close();

  const messages: unknown[] = [];
  const realError = console.error;
  let reopened: Store | undefined;
  try {
    console.error = (...args: unknown[]) => { messages.push(args); };
    reopened = new Store(file);
  } finally {
    console.error = realError;
  }
  assert.ok(reopened, 'the installation came up');
  const logged = messages.flat().map(String).join('\n');
  assert.match(logged, /orders/, 'and the warning names the table');
  assert.match(logged, /older shape|does not have/, '…and says what is missing');
  assert.equal(reopened!.get("SELECT rep_id FROM orders WHERE id='old-1'")!.rep_id, 'rep-x', 'the foreign rows were left exactly as they were');
  assert.ok(columns(reopened!, 'order_lines').includes('qty'), 'the tables it can build, it built');
  assert.match(logged, /repair-legacy-catalogue\.mjs/, '…and it names the script that frees the table name');
  reopened!.close();
  rmSync(dir, { recursive: true, force: true });
});
