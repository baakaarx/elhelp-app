#!/usr/bin/env node
/*
 * Frees the table names this schema owns, when an abandoned build left its own tables behind.
 *
 * How a database ends up here: a branch was built, tried on a real installation, and then rejected —
 * without dropping what it had made. Those tables keep their names (`products`, `warehouses`, …) while
 * holding columns the current code never asked for. Nothing crashes any more — the startup skips an
 * index it cannot build and says so — but the new code cannot use a table whose columns are someone
 * else's, and an office looking at the catalogue would see an empty list it did not empty.
 *
 * So: rename, never delete. The old rows stay in the file under a name that says where they came from,
 * and the current schema builds its own table on the name it expects. Undoing this is the same command
 * in the other direction.
 *
 *   node scripts/repair-legacy-catalogue.mjs --db server/data/mandoub.db          # does the work
 *   node scripts/repair-legacy-catalogue.mjs --db … --dry-run                     # only reports
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const dbFlag = args.indexOf('--db');
const dbPath = resolve(dbFlag === -1 ? 'server/data/mandoub.db' : args[dbFlag + 1]);
const dryRun = args.includes('--dry-run');

/**
 * What the current schema needs from each table it declares, and the name an abandoned build used for
 * something else. A table is only touched when it exists AND is missing a column this schema declares —
 * a matching table is left alone, because then it is simply the current table.
 */
const EXPECTED = {
  products: ['id', 'name', 'category', 'unit', 'unit_size', 'notes', 'active', 'created_at', 'updated_at'],
  product_prices: ['product_id', 'tier_id', 'price', 'updated_at'],
  price_tiers: ['id', 'name', 'position', 'active', 'created_at', 'updated_at'],
};
/** Names an abandoned build owns that this schema has no opinion about yet. Reported, never renamed. */
const FOREIGN = ['warehouses', 'stock_movements', 'invoices', 'invoice_series', 'invoice_items', 'collections', 'collection_events', 'sales_targets'];
const SUFFIX = '_legacy_rejected_batch';

const db = new DatabaseSync(dbPath);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
const columnsOf = name => (db.prepare(`PRAGMA table_info(${name})`).all() || []).map(col => col.name);
const rowsOf = name => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c);

const toRename = [];
const mismatched = [];
for (const [table, needs] of Object.entries(EXPECTED)) {
  if (!tables.includes(table)) continue;
  const have = new Set(columnsOf(table));
  const missing = needs.filter(column => !have.has(column));
  if (!missing.length) continue;
  const taken = tables.includes(table + SUFFIX);
  mismatched.push({ table, missing, rows: rowsOf(table), taken });
  if (!taken) toRename.push(table);
}
/**
 * Rows the current code cannot have written: a buyer type is named, so a blank or one-letter name is a
 * leftover from a half-finished migration. These are cleaned in place instead of renaming the table —
 * and leaving them is not harmless, because a price list with a row in it never gets its defaults back.
 */
const junkTiers = tables.includes('price_tiers')
  ? db.prepare('SELECT id, name FROM price_tiers WHERE length(trim(name)) < 2').all()
  : [];
const orphans = FOREIGN.filter(name => tables.includes(name));

/**
 * A rename takes the links that pointed at it: SQLite rewrites every child's REFERENCES clause to the
 * new name, which is right for a table that keeps its data and wrong here. `product_prices` ends up
 * quoting products_legacy_rejected_batch — a bag of dead rows — so the new price list cannot be written
 * to at all, and the office gets «FOREIGN KEY constraint failed» on the first item they add. Re-pointing
 * those links at the plain name is what lets the app's own CREATE TABLE, on its first boot, be the
 * parent again.
 */
const dragged = [];
// Only a table the current code owns is re-pointed. invoice_lines and stock_movements from the
// abandoned batch keep their link to the legacy bag, because the ids in their rows live there — moving
// them would leave every one of those rows pointing at nothing.
for (const name of tables.filter(candidate => Object.keys(EXPECTED).includes(candidate) && !toRename.includes(candidate))) {
  const parents = [...new Set((db.prepare(`PRAGMA foreign_key_list(${name})`).all() || [])
    .map(fk => String(fk.table))
    .filter(table => table.endsWith(SUFFIX) && Object.keys(EXPECTED).includes(table.slice(0, -SUFFIX.length))))];
  if (parents.length) dragged.push({ table: name, parents, rows: rowsOf(name) });
}

console.log(`base: ${dbPath}${dryRun ? '  [dry-run: لا تعديل]' : ''}`);
if (!mismatched.length) console.log('مفيش ترابيزة اسمها بيخالف الشكل اللي الكود الحالي يتوقعه — مفيش حاجة تتعمل.');
for (const item of mismatched) {
  console.log(`\n${item.table}: ${item.rows} صف — الأعمدة الناقصة: ${item.missing.join(', ')}`);
  console.log(`   ${item.taken ? `«${item.table}${SUFFIX}» موجود من قبل — سيبتها زي ما هي، اتعامل مع دي بنفسك.` : `هتتحول لـ ${item.table}${SUFFIX} (الصفوف ما بتتمسحش)`}`);
}
if (orphans.length) {
  console.log('\nترابيزات من البناء القديم مفيش ليها علاقة بالكود الحالي — متلمسهاش:');
  for (const name of orphans) console.log(`   ${name}: ${rowsOf(name)} صف`);
}
if (junkTiers.length) {
  console.log(`\nprice_tiers: في ${junkTiers.length} صف من غير اسم (الراوت ما يكتبهمش) — هيتتمسح عشان القايمعة تتبني تاني:`);
  for (const row of junkTiers) console.log(`   «${row.name}» (id=${String(row.id).slice(0, 8)}…)`);
}
if (dragged.length) {
  console.log('\nرواحط اتسحبت مع الاسم القديم — هتترجع لمكانها:');
  for (const item of dragged) console.log(`   ${item.table} (${item.rows} صف) → كان بيشير ${item.parents.join(', ')}`);
}
if (dryRun || (!toRename.length && !junkTiers.length && !dragged.length)) { db.close(); process.exit(0); }

// The views and triggers that pointed at the old table are dropped rather than left dangling: SQLite
// keeps a view whose table vanished, and the next person to touch this file gets «no such table» from a
// name they can see nowhere in the schema.
const dependents = db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('view','trigger')").all()
  .filter(row => toRename.includes(row.tbl_name));
db.exec('PRAGMA foreign_keys=OFF');
db.exec('BEGIN');
try {
  for (const row of dependents) db.exec(`DROP ${row.type.toUpperCase()} IF EXISTS ${row.name}`);
  for (const table of toRename) db.exec(`ALTER TABLE ${table} RENAME TO ${table}${SUFFIX}`);
  // Only when the table is the one this schema declares: on a table that came from elsewhere, our
  // column names mean nothing and deleting by them would be guessing.
  if (!mismatched.some(item => item.table === 'price_tiers') && junkTiers.length) {
    // prepare().run(), not exec(): exec takes a SQL string only, so a question mark in it binds nothing
    // and the statement quietly matches no row. A cleanup that deletes nothing is the worst kind of
    // silent success — the report said the rows were removed.
    let removed = 0;
    for (const row of junkTiers) removed += Number(db.prepare('DELETE FROM price_tiers WHERE id=?').run(row.id).changes);
    if (removed !== junkTiers.length) throw new Error(`مسحت ${removed} من ${junkTiers.length} — الوقف مش زي المتوقع، فالتغيير كله اترجّع.`);
  }
  // Rebuilt, not edited: SQLite has no ALTER that changes what a column references, so the child table
  // is recreated from its own definition with the parent name restored, row for row. The indexes it
  // carried go with the old copy and the app makes them again on its first boot.
  for (const item of dragged) {
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(item.table).sql);
    let fixed = sql;
    // No regex here: this file has already been burned by escapes, and the string to fix is a literal.
    // Quoted forms first, so what is left is the bare name, and the quotes do not survive the edit.
    for (const table of item.parents) {
      const wanted = table.slice(0, -SUFFIX.length);
      for (const form of [`"${table}"`, '`' + table + '`', table]) {
        fixed = fixed.split(form).join(wanted);
      }
    }
    if (fixed === sql) throw new Error(`«${item.table}» مرجعش لأي اسم بعد التصحيح — الوقف مش آمن.`);
    if (!/^CREATE TABLE (?:IF NOT EXISTS )?`?\w+`?/i.test(fixed)) throw new Error(`تعريف «${item.table}» مش شكل اللي أتوقعه — وقّف السكربت وابعته.`);
    const before = rowsOf(item.table);
    const fresh = `${item.table}__repaired`;
    db.exec(`DROP TABLE IF EXISTS ${fresh}`);
    db.exec(fixed.replace(/^CREATE TABLE (?:IF NOT EXISTS )?`?\w+`?/i, `CREATE TABLE ${fresh}`));
    db.exec(`INSERT INTO ${fresh} SELECT * FROM ${item.table}`);
    if (rowsOf(item.table) !== before) throw new Error(`الصفوف اتغيرت وقت النسخ في «${item.table}».`);
    db.exec(`DROP TABLE ${item.table}`);
    db.exec(`ALTER TABLE ${fresh} RENAME TO ${item.table}`);
    if (rowsOf(item.table) !== before) throw new Error(`«${item.table}» رجع ب${rowsOf(item.table)} صف بدل ${before}.`);
    const still = (db.prepare(`PRAGMA foreign_key_list(${item.table})`).all() || [])
      .map(fk => String(fk.table)).filter(table => table.endsWith(SUFFIX));
    if (still.length) throw new Error(`«${item.table}» لسه بيشير ${still.join(', ')} بعد التصحيح.`);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  db.close();
  console.error(`ما اتعملش حاجة: ${error.message}`);
  process.exit(1);
}
db.close();
console.log(`\nاتعمل: ${toRename.map(table => `${table} → ${table}${SUFFIX}`).join(' ، ')}`);
console.log(dependents.length ? `ومسحت ${dependents.length} من views/triggers اللي كانت مربوطة بيهم.` : 'مفيش views أو triggers مربوطة بيهم.');
console.log('الكود الحالي هيبني ترابيزاته لوحده أول ما السيرفر يقلع، والصفوف القديمة لسه جوه الأسماء الجديدة.');
if (dragged.length) console.log(`ورجّعت ${dragged.length} ترابيزة تشير للأسماء الجديدة بدل النسخة القديمة: ${dragged.map(item => item.table).join(', ')} — بنفس عدد الصفوف.`);
if (junkTiers.length) console.log('قايمعة الأنواع فاضية ⇒ جملة/نصف جملة/تجزئة ترجع أول إقلاع.');
