import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';

/**
 * The price list the way the office uses it: the items, their packs, one price per buyer type, and the
 * customer who is quoted at one of them.
 *
 * Two of these tests exist for the mistakes that are expensive rather than obvious. A guessed unit turns
 * a bottle price into a case price and the invoice still looks finished. And an item that an order line
 * points at cannot be deleted — which is checked here by building such a table on the spot, because the
 * guard reads the schema, so it starts working the day the first order table appears and not when someone
 * remembers to update a list.
 */
const config = {
  dbPath: ':memory:', production: false, retentionDays: 30, timezone: 'Africa/Cairo',
  adminEmail: 'admin@catalogue.test', adminPassword: 'TestPassword123!', allowedOrigins: [], port: 0,
  loginAccountLimit: 500, loginRateLimit: { windowMs: 60000, limit: 5000 },
};
const instance = createApp(config);
const { app, store } = instance;
const client = request(app);
test.after(async () => { await instance.close(); });

async function login(email: string, password: string, kind: 'admin' | 'rep' = 'admin') {
  const res = await client.post('/api/auth/login').send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { Authorization: `Bearer ${res.body.token as string}`, 'X-Mandoub-Client': kind };
}
const admin = await login(config.adminEmail, config.adminPassword);
const PASSWORD = 'Rep1234!Rep';
async function makeRep(name: string) {
  const email = `rep.${randomUUID().slice(0, 8)}@catalogue.test`;
  const created = await client.post('/api/reps').set(admin).send({ name, email, password: PASSWORD, region: 'الغربية' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { id: created.body.user.id as string, name, email, auth: await login(email, PASSWORD, 'rep') };
}
const tierByName = (name: string) => store.get('SELECT id FROM price_tiers WHERE name=?', name)!.id as string;
const addProduct = (body: Record<string, unknown>) => client.post('/api/products').set(admin).send(body);

test('an item is entered with its pack, and only the office sees the prices', async () => {
  const created = await addProduct({
    name: 'يوريا ٤٦٪', category: 'fertilizer', unit: 'شيكارة', unitSize: '٥٠ كجم', notes: 'السعر للشيكارة نفسها',
    prices: [{ tierId: tierByName('جملة'), price: 1150 }, { tierId: tierByName('نصف جملة'), price: 1220 }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.product.unit, 'شيكارة');
  assert.deepEqual(created.body.product.prices.map((row: any) => row.price).sort((a: number, b: number) => a - b), [1150, 1220]);
  // The item that has no price for a type is not broken — «تجزئة» is simply not decided.
  assert.equal(created.body.product.prices.length, 2, 'and the missing rate stays missing rather than zero');

  const rep = await makeRep('مهندس أصناف');
  const mine = await client.get('/api/products').set(rep.auth);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.products.length, 1);
  assert.equal(mine.body.products[0].prices, undefined, 'the phone is not shown a price at all');
  assert.equal(mine.body.products[0].name, 'يوريا ٤٦٪', '…but it reads the item and its pack, which is what an order needs');
  assert.match(JSON.stringify(mine.body.products[0]), /شيكارة/, 'the unit travels with the name');

  // A number the man in the field quotes from a screen becomes a promise the warehouse did not make.
  const fieldEdit = await addProduct({ name: 'عميل من الشارع', unit: 'عبوة' }).set(rep.auth);
  assert.equal(fieldEdit.status, 403);
  const fieldPrice = await client.put(`/api/products/${created.body.product.id}/prices`).set(rep.auth).send({ prices: [] });
  assert.equal(fieldPrice.status, 403);
  const fieldTiers = await client.get('/api/price-tiers').set(rep.auth);
  assert.equal(fieldTiers.status, 403, 'the list of buyer types is the office’s too');
  assert.equal((await client.get('/api/products')).status, 401);
});

test('an item cannot be entered without saying what one unit of it is', async () => {
  const noUnit = await addProduct({ name: 'سوبر فوسفات', category: 'fertilizer' });
  assert.equal(noUnit.status, 400, JSON.stringify(noUnit.body));
  // The message is the point: this field is where a «كرتونة» used to be guessed, and the guess is what
  // made a bottle price read as twelve times its value.
  assert.match(noUnit.body.error, /عبوة|شيكارة|جركن/, 'the error names the units instead of saying «required»');
  const blank = await addProduct({ name: 'سوبر فوسفات', unit: '   ' });
  assert.equal(blank.status, 400);
  const bogusCategory = await addProduct({ name: 'أسمنت', unit: 'شيكارة', category: 'cement' });
  assert.equal(bogusCategory.status, 400, 'the catalogue holds what this company sells');
});

test('the same item under the same pack is one item, and a different pack is not a duplicate', async () => {
  const first = await addProduct({ name: 'سايبيرمثرين ٥٠٪', unit: 'عبوة', unitSize: '٥٠٠ مل', category: 'pesticide' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  // Trailing spaces are the same farm: the value is normalised before the index and before this check.
  const again = await addProduct({ name: ' سايبيرمثرين ٥٠٪ ', unit: ' عبوة ' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'PRODUCT_EXISTS');
  assert.match(again.body.error, /قايمعة الأصناف/);
  // A drum of the same poison is a different item with a different price, and must be enterable.
  assert.equal((await addProduct({ name: 'سايبيرمثرين ٥٠٪', unit: 'جرن', unitSize: '٢٠ لتر' })).status, 201);
  // Renaming one item into another item's slot is the same duplicate.
  const renamed = await client.patch(`/api/products/${(await addProduct({ name: 'مبيد جديد', unit: 'عبوة' })).body.product.id}`)
    .set(admin).send({ name: 'سايبيرمثرين ٥٠٪' });
  assert.equal(renamed.status, 409, JSON.stringify(renamed.body));
  assert.match(renamed.body.error, /عدّل السطر اللي موجود/, 'and the answer says which row to edit instead');
  assert.equal(store.get("SELECT name FROM products WHERE name='مبيد جديد'")?.name, 'مبيد جديد', 'the refused rename left the row alone');
});

test('prices are written per type, and the rest of the row is left alone', async () => {
  const product = await addProduct({ name: 'هيوميك', unit: 'جركن', unitSize: '٥ لتر', category: 'other' });
  const id = product.body.product.id as string;
  const wholesale = tierByName('جملة');
  const retail = tierByName('تجزئة');

  const first = await client.put(`/api/products/${id}/prices`).set(admin).send({ prices: [{ tierId: wholesale, price: 350 }] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // The screen that edits one column must not wipe the others by omission.
  const second = await client.put(`/api/products/${id}/prices`).set(admin).send({ prices: [{ tierId: retail, price: 420 }] });
  assert.equal(second.body.product.prices.length, 2, 'both rates are there');
  const cleared = await client.put(`/api/products/${id}/prices`).set(admin).send({ prices: [{ tierId: retail, price: null }] });
  assert.deepEqual(cleared.body.product.prices, [{ tierId: wholesale, price: 350 }], 'null clears one rate, and clearing is not zero');
  assert.equal(store.get('SELECT price FROM product_prices WHERE product_id=? AND tier_id=?', id, retail), undefined, 'the row is gone, not 0');
  // …so the office can find what is still unfinished.
  const unpriced = await client.get(`/api/products?unpricedFor=${retail}`).set(admin);
  assert.ok(unpriced.body.products.some((row: any) => row.id === id), 'and it shows up as unpriced for that type');

  assert.equal((await client.put(`/api/products/${id}/prices`).set(admin).send({ prices: [{ tierId: wholesale, price: -1 }] })).status, 400);
  const ghost = await client.put(`/api/products/${id}/prices`).set(admin).send({ prices: [{ tierId: randomUUID(), price: 10 }] });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body.code, 'TIER_NOT_FOUND');
  const twice = await client.put(`/api/products/${id}/prices`).set(admin).send({ prices: [{ tierId: wholesale, price: 1 }, { tierId: wholesale, price: 2 }] });
  assert.equal(twice.status, 400);
  assert.match(twice.body.error, /نوع واحد = سعر واحد/);
  const logged = store.get("SELECT metadata FROM audit_log WHERE action='product.prices' ORDER BY created_at DESC, rowid LIMIT 1");
  assert.equal(JSON.parse(String(logged.metadata)).cleared[0], retail, 'the audit trail says which rate was taken away');
});

test('a stopped item leaves the list the phone reads, and stays for the records', async () => {
  const product = await addProduct({ name: 'مركب ١٥-١٥-١٥', unit: 'شيكارة' });
  const id = product.body.product.id as string;
  const rep = await makeRep('مهندسوقوف');
  assert.equal((await client.get('/api/products').set(rep.auth)).body.products.some((row: any) => row.id === id), true);
  await client.patch(`/api/products/${id}`).set(admin).send({ active: false });
  assert.equal((await client.get('/api/products').set(rep.auth)).body.products.some((row: any) => row.id === id), false, 'a stopped item is not something to order');
  const withStopped = await client.get('/api/products?includeInactive=1').set(admin);
  assert.ok(withStopped.body.products.some((row: any) => row.id === id && row.active === false), 'the office still sees it to bring it back');
  // Deleting is allowed only while nothing points at the row (next test proves the refusal).
  assert.equal((await client.delete(`/api/products/${id}`).set(admin)).status, 200);
  assert.equal(store.get('SELECT id FROM products WHERE id=?', id), undefined);
  assert.equal(store.get('SELECT COUNT(*) AS c FROM product_prices WHERE product_id=?', id)?.c, 0, 'its prices went with it');
  assert.equal((await client.delete('/api/products/nope').set(admin)).status, 404);
  assert.equal((await client.delete(`/api/products/${id}`).set(rep.auth)).status, 403);
});

test('the delete guard reads the schema, so the first table that cites an item protects it', async () => {
  const product = await addProduct({ name: 'مبيد له طلبية', unit: 'عبوة' });
  const id = product.body.product.id as string;
  // Tomorrow's order line, built here because the guard must work the day it exists — not the day
  // somebody edits this route and remembers the list of tables.
  store.run('CREATE TABLE order_items(id TEXT PRIMARY KEY, product_id TEXT REFERENCES products(id), qty REAL NOT NULL)');
  store.run("INSERT INTO order_items(id,product_id,qty) VALUES ('oi-1',?,2)", id);
  const blocked = await client.delete(`/api/products/${id}`).set(admin);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'PRODUCT_IN_USE');
  assert.match(blocked.body.error, /1 سطر في order_items/, 'the answer names the table, because «it is used» is not actionable');
  assert.match(blocked.body.error, /وقّفه/);
  assert.ok(store.get('SELECT id FROM products WHERE id=?', id), 'and nothing was deleted');
  store.run('DROP TABLE order_items');
  assert.equal((await client.delete(`/api/products/${id}`).set(admin)).status, 200, 'once nothing points at it, it can go');
});

test('buyer types are the office’s, and a type with prices is stopped not deleted', async () => {
  const tiers = await client.get('/api/price-tiers').set(admin);
  assert.equal(tiers.status, 200);
  assert.deepEqual(tiers.body.tiers.map((row: any) => row.name), ['جملة', 'نصف جملة', 'تجزئة'], 'the seeded list, in the order it is read');

  const added = await client.post('/api/price-tiers').set(admin).send({ name: 'موزع' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.tier.position, 3, 'a new type joins at the end rather than being sorted by alphabet');
  assert.equal((await client.post('/api/price-tiers').set(admin).send({ name: ' موزع ' })).status, 409, 'one heading, one meaning');
  assert.equal((await client.post('/api/price-tiers').set(admin).send({ name: ' ج ' })).status, 400);

  const priced = await addProduct({ name: 'سماد له نوع', unit: 'كيس', prices: [{ tierId: added.body.tier.id, price: 200 }] });
  assert.equal(priced.status, 201);
  const deletePriced = await client.delete(`/api/price-tiers/${added.body.tier.id}`).set(admin);
  assert.equal(deletePriced.status, 409, JSON.stringify(deletePriced.body));
  assert.equal(deletePriced.body.code, 'TIER_HAS_PRICES');
  assert.match(deletePriced.body.error, /وقّف النوع/, 'cascade would take a price with it to remove a heading');
  assert.equal((await client.patch(`/api/price-tiers/${added.body.tier.id}`).set(admin).send({ active: false })).body.tier.active, false);
  assert.equal((await client.delete(`/api/price-tiers/${added.body.tier.id}`).set(admin)).status, 409, 'stopping it does not unlock the delete — the price is still there');
  // Empty it first, on purpose, so the number is not lost by accident: then the heading can go.
  await client.delete(`/api/products/${priced.body.product.id}`).set(admin);
  assert.equal((await client.delete(`/api/price-tiers/${added.body.tier.id}`).set(admin)).status, 200, 'a stopped type with nothing on it can be deleted');

  // The last working type is the price list itself.
  const others = tiers.body.tiers.length;
  for (const row of (await client.get('/api/price-tiers').set(admin)).body.tiers.slice(0, others - 1)) {
    assert.equal((await client.patch(`/api/price-tiers/${row.id}`).set(admin).send({ active: false })).status, 200);
  }
  const lastOnes = (await client.get('/api/price-tiers').set(admin)).body.tiers.filter((row: any) => row.active);
  assert.equal(lastOnes.length, 1, 'one type is left standing');
  const stopLast = await client.patch(`/api/price-tiers/${lastOnes[0].id}`).set(admin).send({ active: false });
  assert.equal(stopLast.status, 409);
  assert.equal(stopLast.body.code, 'LAST_TIER');
  for (const row of (await client.get('/api/price-tiers').set(admin)).body.tiers) {
    await client.patch(`/api/price-tiers/${row.id}`).set(admin).send({ active: true });
  }
  assert.equal((await client.patch(`/api/price-tiers/${lastOnes[0].id}`).set(admin).send({})).status, 400, 'a patch that changes nothing is a bug elsewhere');
});

test('a customer is quoted at a type, and the office can take that back', async () => {
  const wholesale = tierByName('جملة');
  const created = await client.post('/api/customers').set(admin)
    .send({ name: 'حاج محمد جملة', governorate: 'الغربية', district: 'طنطا', priceTierId: wholesale });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.customer.priceTierId, wholesale);
  assert.equal(created.body.customer.priceTierName, 'جملة', 'the list reads the heading next to his name');
  const id = created.body.customer.id as string;

  const ghost = await client.post('/api/customers').set(admin).send({ name: 'عميل نوع غلط', priceTierId: randomUUID() });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body.code, 'TIER_NOT_FOUND');
  await client.patch(`/api/price-tiers/${wholesale}`).set(admin).send({ active: false });
  const stopped = await client.patch(`/api/customers/${id}`).set(admin).send({ notes: 'ملاحظة' });
  assert.equal(stopped.status, 200, 'an edit of another field never touches the rate');
  assert.equal(stopped.body.customer.priceTierId, wholesale, 'and the existing one survives being stopped');
  const newChoice = await client.post('/api/customers').set(admin).send({ name: 'عميل نوع موقوف', priceTierId: wholesale });
  assert.equal(newChoice.status, 404, 'a stopped type cannot be chosen for a new customer');
  await client.patch(`/api/price-tiers/${wholesale}`).set(admin).send({ active: true });

  const cleared = await client.patch(`/api/customers/${id}`).set(admin).send({ priceTierId: null });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.customer.priceTierId, null, '«من غير تحديد» is an answer, not a missing field');
  assert.equal(cleared.body.customer.priceTierName, '');
  const listed = await client.get('/api/customers?q=حاج محمد جملة').set(admin);
  assert.equal(listed.body.customers[0].priceTierId, null, 'and the list reads it that way');
});

test('an edit cannot erase the unit either, and a partial edit keeps it', async () => {
  const created = await addProduct({ name: 'فول تمكى', unit: 'جركن', unitSize: '١ لتر' });
  const id = created.body.product.id as string;
  assert.equal((await client.patch(`/api/products/${id}`).set(admin).send({ unit: '' })).status, 400);
  assert.equal((await client.patch(`/api/products/${id}`).set(admin).send({ unit: '   ' })).status, 400);
  assert.equal(store.get('SELECT unit FROM products WHERE id=?', id)?.unit, 'جركن', 'the refused edit changed nothing');
  const nameOnly = await client.patch(`/api/products/${id}`).set(admin).send({ name: 'فول عبادي' });
  assert.equal(nameOnly.status, 200, JSON.stringify(nameOnly.body));
  assert.equal(nameOnly.body.product.unit, 'جركن', 'renaming does not lose the pack');
});

test('stopping an item does not reset its pack, its category or its notes', async () => {
  // The same trap as the customer book, in the schema this phase added: category, unitSize and notes all
  // carry create-time defaults, so a `{ active }` patch would have moved a fertilizer under «أخرى» and
  // blanked the pack text while nobody asked for either.
  const created = await addProduct({
    name: 'سلفو ماغنسيوم', category: 'fertilizer', unit: 'جركن', unitSize: '٥ لتر', notes: 'يُخزّن في الظل',
    prices: [{ tierId: tierByName('جملة'), price: 260 }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.product.id as string;

  const stopped = await client.patch(`/api/products/${id}`).set(admin).send({ active: false });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.product.active, false);
  assert.equal(stopped.body.product.category, 'fertilizer', 'the classification survives an unrelated edit');
  assert.equal(stopped.body.product.unit, 'جركن');
  assert.equal(stopped.body.product.unitSize, '٥ لتر');
  assert.equal(stopped.body.product.notes, 'يُخزّن في الظل');
  assert.deepEqual(stopped.body.product.prices, [{ tierId: tierByName('جملة'), price: 260 }], 'and the price row is untouched');

  const renamed = await client.patch(`/api/products/${id}`).set(admin).send({ name: 'سلفو ماغنسيوم ٩.٨٪' });
  assert.equal(renamed.body.product.unit, 'جركن', 'a rename does not lose the pack either');
  assert.equal(renamed.body.product.unitSize, '٥ لتر');
});
