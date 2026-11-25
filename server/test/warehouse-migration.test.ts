import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Store } from '../src/db.js';

const config = { production: false, adminEmail: 'migration@test.com', adminPassword: 'MigrationPassword123!' };

test('legacy warehouse and movement schema is preserved and new actions work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warehouse-legacy-'));
  const dbPath = join(dir, 'app.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE warehouses(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO warehouses VALUES('old-warehouse','مخزن قديم',1,1);
    CREATE TABLE stock_movements(id TEXT PRIMARY KEY, product_id TEXT, warehouse_id TEXT, qty REAL, kind TEXT, note TEXT, created_by TEXT, created_at INTEGER);
    INSERT INTO stock_movements VALUES('old-movement','old-product','old-warehouse',12.5,'receipt','قديم',NULL,1);`);
  legacy.close();
  const instance = createApp({ ...config, dbPath });
  try {
    const client = request(instance.app);
    const login = await client.post('/api/auth/login').send({ email: config.adminEmail, password: config.adminPassword });
    const auth = { Authorization: `Bearer ${login.body.token}` };
    const list = await client.get('/api/warehouse/warehouses').set(auth);
    assert.equal(list.status, 200); assert.equal(list.body.legacyHistory, true);
    assert.equal(list.body.warehouses[0].name, 'مخزن قديم');
    assert.equal((await client.get('/api/warehouse/movements?warehouseId=old-warehouse').set(auth)).status, 200);
    const warehouse = await client.post('/api/warehouse/warehouses').set(auth).send({ name:'مخزن جديد' });
    assert.equal(warehouse.status, 201, JSON.stringify(warehouse.body));
    const product = await client.post('/api/warehouse/products').set(auth).send({ name:'صنف جديد', category:'other', unit:'عبوة' });
    const movement = await client.post('/api/warehouse/movements').set(auth).send({ id:randomUUID(),kind:'opening',productId:product.body.product.id,toWarehouseId:warehouse.body.warehouse.id,qty:2 });
    assert.equal(movement.status, 201, JSON.stringify(movement.body));
    assert.equal(instance.store.get('SELECT qty FROM stock_movements WHERE id=?','old-movement')?.qty, 12.5);
    assert.equal(instance.store.get('SELECT COUNT(*) AS n FROM stock_movements')?.n, 1);
    assert.equal(instance.store.get('SELECT COUNT(*) AS n FROM inventory_movements')?.n, 1);
  } finally { await instance.close(); rmSync(dir, { recursive:true, force:true }); }
});

test('prior inventory ledger is copied once without losing balances or reimporting rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'warehouse-v1-'));
  const dbPath = join(dir, 'app.db');
  let store = new Store(dbPath);
  try {
    const id = randomUUID();
    store.run('INSERT INTO warehouses(id,name,created_at) VALUES(?,?,?)', 'w', 'مخزن سابق', 1);
    store.run("INSERT INTO products(id,name,category,unit,created_at,updated_at) VALUES(?,?,'other','عبوة',1,1)", 'p', 'صنف سابق');
    store.run("INSERT INTO warehouse_stock(warehouse_id,product_id,milli_qty) VALUES('w','p',3000)");
    store.db.exec(`CREATE TABLE stock_movements(id TEXT PRIMARY KEY,kind TEXT,product_id TEXT,from_warehouse_id TEXT,to_warehouse_id TEXT,milli_qty INTEGER,note TEXT,actor_id TEXT,actor_name TEXT,created_at INTEGER);`);
    store.run("INSERT INTO stock_movements VALUES(?,'opening','p',NULL,'w',3000,'',NULL,'قديم',1)", id);
    store.close(); store = new Store(dbPath);
    assert.equal(store.get('SELECT milli_qty FROM inventory_movements WHERE id=?',id)?.milli_qty, 3000);
    assert.equal(store.get("SELECT milli_qty FROM warehouse_stock WHERE warehouse_id='w' AND product_id='p'")?.milli_qty, 3000);
    store.run("INSERT INTO inventory_movements VALUES(?,'in','p',NULL,'w',1000,'',NULL,'جديد',2)", randomUUID());
    store.close(); store = new Store(dbPath);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM inventory_movements')?.n, 2);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM stock_movements')?.n, 1);
  } finally { store.close(); rmSync(dir, { recursive:true, force:true }); }
});
