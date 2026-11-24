import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Row = Record<string, any>;
/** An open shift with no fixes for this long is treated as left behind, not as still running. */
const STALE_SHIFT_MS = 18 * 3600000;
/** The value `users.color` defaults to, shared by every account created before this migration. */
const DEFAULT_REP_COLOR = '#28745b';
/** Written into `visits.outcome` when the system closed a visit nobody ended. */
export const AUTO_CLOSED_OUTCOME = 'أُغلقت تلقائيًا: انتهت الوردية قبل تسجيل النتيجة';
/**
 * The hourly sweep, and the reason it may fail.
 *
 * `cleanup` runs unattended at three in the morning inside a timer: a full disk, a lock held past
 * `busy_timeout`, or a corrupt index makes it throw — and an exception inside a timer is an
 * uncaught exception, so Node exits and the whole installation goes dark until someone notices.
 * Losing one sweep costs nothing (the next one is an hour later); losing the process costs the
 * manager the day's trail. So the error is logged and the server keeps serving.
 */
export function runCleanup(store: Pick<Store, 'cleanup'>, retentionDays: number): boolean {
  try { store.cleanup(retentionDays); return true; }
  catch (error) { console.error('[cleanup] the sweep failed, the server keeps running:', error); return false; }
}

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','rep')),
        phone TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '#28745b',
        active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_seen INTEGER,
        -- '' = manager, 'sales' = sales office, 'stock' = warehouses only. See the migration list
        -- below for why this is not part of role.
        scope TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shifts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL, ended_at INTEGER,
        consent_version TEXT NOT NULL, consent_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS locations (
        point_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
        lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL, speed REAL, heading REAL, battery REAL,
        recorded_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('gps')),
        PRIMARY KEY(user_id, point_id)
      );
      CREATE INDEX IF NOT EXISTS locations_user_time ON locations(user_id, recorded_at);
      -- Retention now keeps a year of fixes; without this the hourly cleanup scans the whole
      -- table, and it is the only query that filters on time alone.
      CREATE INDEX IF NOT EXISTS locations_recorded ON locations(recorded_at);
      CREATE INDEX IF NOT EXISTS shifts_user_start ON shifts(user_id, started_at);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
        action TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log(created_at);
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        shift_id TEXT REFERENCES shifts(id) ON DELETE SET NULL,
        type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
        customer TEXT NOT NULL DEFAULT '', amount REAL,
        lat REAL, lng REAL, accuracy REAL,
        status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed')),
        created_at INTEGER NOT NULL, reviewed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS reports_user_time ON reports(user_id, created_at);
      CREATE INDEX IF NOT EXISTS reports_time ON reports(created_at);
      -- Daily engineer reports (the uploaded paper form). Legacy reports rows are left untouched.
      CREATE TABLE IF NOT EXISTS daily_reports (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        shift_id TEXT REFERENCES shifts(id) ON DELETE SET NULL,
        engineer_name TEXT NOT NULL, report_date TEXT NOT NULL, day_name TEXT NOT NULL,
        left_at TEXT NOT NULL DEFAULT '', returned_at TEXT NOT NULL DEFAULT '',
        circumstances TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed')),
        created_at INTEGER NOT NULL, reviewed_at INTEGER,
        signed_name TEXT NOT NULL, signed_at INTEGER NOT NULL,
        lat REAL, lng REAL, accuracy REAL
      );
      CREATE TABLE IF NOT EXISTS daily_report_visits (
        id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, customer_name TEXT NOT NULL,
        governorate TEXT NOT NULL DEFAULT '', district TEXT NOT NULL DEFAULT '', village TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '', area_feddan REAL, crops TEXT NOT NULL DEFAULT '',
        recommendations TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT '',
        UNIQUE(report_id, position)
      );
      CREATE INDEX IF NOT EXISTS daily_reports_user_time ON daily_reports(user_id, created_at);
      CREATE INDEX IF NOT EXISTS daily_reports_date ON daily_reports(report_date);
      CREATE INDEX IF NOT EXISTS daily_reports_time ON daily_reports(created_at);
      CREATE INDEX IF NOT EXISTS daily_report_visits_report ON daily_report_visits(report_id, position);
      -- Customers: the list each sales engineer owns and writes invoices against.
      --
      -- This is the first master-data table in the schema, and it exists because visits.customer_name
      -- was free text: the same farm arrived as «مزرعة النور» and «النور», so nothing could be counted
      -- per customer. Uniqueness is (owner, name) — two engineers may each sell to «الحاج محمد», and
      -- one engineer may not create him twice. The unique index compares names case-insensitively,
      -- because the difference between «Abu Ali» and «ABU ALI» was never a different farm.
      --
      -- lat/lng are the address the manager or the engineer pinned, and they are what later lets a
      -- check-in be measured against where the customer actually is.
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        -- Null means «the company's customer, not linked to an engineer yet». The office enters the
        -- list first and hands it out afterwards — area by area — so a name typed in the office must
        -- not be rejected because nobody had decided who owns it. ON DELETE SET NULL and not CASCADE:
        -- a customer is an asset of the company, and an engineer leaving must not delete him.
        rep_id TEXT REFERENCES users(id) ON DELETE SET NULL,
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
      CREATE UNIQUE INDEX IF NOT EXISTS customers_rep_name ON customers(rep_id, name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS customers_rep_active ON customers(rep_id, active);

      -- ---- Sales: the catalogue, the warehouses, the stock ledger, the invoices ----
      --
      -- These tables are the money record of the company, which changes what the schema has to
      -- promise. The activity tables (locations, visits, reports) answer «what happened today»; an
      -- invoice answers «what was sold, at what price, to whom» and has to still say the same thing
      -- in five years. Three consequences are written into the definitions below:
      --
      --   1. Nothing here is swept by RETENTION_DAYS. The cleanup() method lists the tables it
      --      clears, and these are deliberately not among them.
      --   2. Deleting a person never deletes a sale: rep_id and created_by are ON DELETE SET NULL,
      --      unlike every other table in this schema. An invoice is a fact about the company, not
      --      about the man who left it.
      --   3. Names and prices are copied into the line at the moment of the sale. A product renamed
      --      or re-priced tomorrow must not rewrite an invoice already handed to a customer.
      --
      -- Stock is a ledger, not a number. There is deliberately no products.stock_qty column:
      -- «what is left» is always the SUM of the movements, so a manual correction and a sale cannot
      -- disagree, and every figure on the warehouse screen has a row behind it.
      CREATE TABLE IF NOT EXISTS warehouses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        governorate TEXT NOT NULL DEFAULT '',
        district TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      -- Two warehouses both called «الإسكندرية» would split one pile of cartons into two wrong numbers.
      CREATE UNIQUE INDEX IF NOT EXISTS warehouses_name ON warehouses(name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        -- What one of this product is: عبوة، شيكارة، جركن، كرتونة… deliberately with no default.
        -- A guessed unit is not cosmetic: the invoice multiplies this unit's price by a quantity in
        -- this unit, so a pesticide priced per bottle and defaulted to «كرتونة» sells a carton for
        -- the price of a bottle, and the shelf drops 1 for what physically left as 12.
        unit TEXT NOT NULL,
        -- The catalogue price is the warehouse's answer, not the engineer's: it is set here so one
        -- price is used everywhere and a phone cannot invent one. It is the price of one unit and
        -- nothing else, which is why the two columns share a row and a form.
        default_price REAL NOT NULL DEFAULT 0 CHECK(default_price >= 0),
        notes TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS products_name ON products(name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        -- Assigned by the server when the invoice lands (INV-YYYY-NNNN from invoice_series). A number
        -- typed by a client is a number that can be typed twice.
        number TEXT UNIQUE,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        customer_name TEXT NOT NULL,
        rep_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
        invoice_date INTEGER NOT NULL,
        subtotal REAL NOT NULL DEFAULT 0,
        discount REAL NOT NULL DEFAULT 0 CHECK(discount >= 0),
        total REAL NOT NULL DEFAULT 0,
        paid_amount REAL NOT NULL DEFAULT 0 CHECK(paid_amount >= 0),
        status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','partial','paid')),
        -- 1 when a line drove the warehouse below zero: the goods really left, so the sale stands and
        -- the shortage is said out loud instead of being refused or hidden.
        stock_short INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        -- An invoice is never deleted, only voided with a reason: invoice numbers are a series, and a
        -- hole in the series is what makes an auditor ask questions.
        voided INTEGER NOT NULL DEFAULT 0,
        void_reason TEXT NOT NULL DEFAULT '',
        voided_at INTEGER,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS invoices_rep_date ON invoices(rep_id, invoice_date);
      CREATE INDEX IF NOT EXISTS invoices_customer ON invoices(customer_id);
      CREATE INDEX IF NOT EXISTS invoices_date ON invoices(invoice_date);

      CREATE TABLE IF NOT EXISTS invoice_lines (
        id TEXT PRIMARY KEY,
        invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
        product_name TEXT NOT NULL,
        unit TEXT NOT NULL DEFAULT '',
        qty REAL NOT NULL CHECK(qty > 0),
        unit_price REAL NOT NULL CHECK(unit_price >= 0),
        line_total REAL NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS invoice_lines_invoice ON invoice_lines(invoice_id, position);
      -- The top-seller question is «group by product over all lines»; without this it walks every
      -- invoice in the file.
      CREATE INDEX IF NOT EXISTS invoice_lines_product ON invoice_lines(product_id);

      CREATE TABLE IF NOT EXISTS stock_movements (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
        -- Signed: incoming positive, outgoing negative. One column, one rule, and no direction field
        -- that can disagree with the sign.
        qty REAL NOT NULL CHECK(qty <> 0),
        kind TEXT NOT NULL CHECK(kind IN ('opening','receipt','sale','return','count','writeoff')),
        invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stock_movements_lookup ON stock_movements(warehouse_id, product_id, created_at);
      CREATE INDEX IF NOT EXISTS stock_movements_invoice ON stock_movements(invoice_id);

      -- Per-year counter for invoice numbers, so INV-2026-0007 cannot be issued twice even if two
      -- managers save in the same second. The row is claimed in the transaction that writes the invoice.
      CREATE TABLE IF NOT EXISTS invoice_series (
        year INTEGER PRIMARY KEY, last_number INTEGER NOT NULL DEFAULT 0
      );
      -- Every recorded collection, in one row per recording. It is an event log and not a column on
      -- the invoice, because an invoice can be paid in three visits by two different hands: the office
      -- typing what it banked, and the engineer typing what he took in front of the customer. The row
      -- names both — rep_id is the engineer whose money it is (whose name the collection report is
      -- grouped by), recorded_by is who typed it — so the report can show both without inventing a
      -- second truth about the same cash.
      CREATE TABLE IF NOT EXISTS collection_events (
        id TEXT PRIMARY KEY,
        invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        rep_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        -- The change in what was paid on that invoice. It can be negative: a correction typed as a
        -- negative collection is honest, and hiding it is how a report stops matching the drawer.
        amount REAL NOT NULL,
        source TEXT NOT NULL DEFAULT 'office',
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS collection_events_window ON collection_events(created_at);
      CREATE INDEX IF NOT EXISTS collection_events_rep ON collection_events(rep_id, created_at);
      -- Upgrading a database that already kept money in paid_amount: the register starts empty, and a
      -- report that reads only the register would say the month collected nothing while the invoices
      -- say otherwise. So the cash already on the books is written once, as an entry per invoice dated
      -- on the invoice's own day, marked as what it is. An empty register (a fresh install) inserts
      -- nothing, and after this the register is never empty again, so it never runs twice.
      INSERT INTO collection_events(id, invoice_id, customer_id, rep_id, recorded_by, amount, source, note, created_at)
      SELECT lower(hex(randomblob(16))), i.id, i.customer_id, i.rep_id, i.created_by, i.paid_amount, 'office',
             'من الفواتير: مسدد قبل ما سجل التحصيل يتفعّل', i.invoice_date
      FROM invoices i
      WHERE i.paid_amount > 0 AND NOT EXISTS (SELECT 1 FROM collection_events LIMIT 1);
      -- Monthly targets: «كل مهندس هدفه كام في الشهر»، وهدف للشركة كلها. month is a local
      -- YYYY-MM, so the row means the same month to the manager and to the phone. A rep_id of NULL is
      -- the company/office target, which is why the unique key has to spell out the NULL case: SQLite
      -- treats NULLs as distinct in a UNIQUE index, and without this a manager could save the company
      -- target twice and the progress bar would read the first one.
      CREATE TABLE IF NOT EXISTS sales_targets (
        id TEXT PRIMARY KEY,
        month TEXT NOT NULL,
        rep_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        revenue REAL NOT NULL DEFAULT 0 CHECK(revenue >= 0),
        invoices INTEGER NOT NULL DEFAULT 0 CHECK(invoices >= 0),
        note TEXT NOT NULL DEFAULT '',
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS sales_targets_month_rep ON sales_targets(month, IFNULL(rep_id, ''));
      -- Field visits: a rep checks in at a customer, then checks out. The pair is the
      -- auditable record used by the manager timeline and the daily KPIs.
      CREATE TABLE IF NOT EXISTS visits (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        customer_name TEXT NOT NULL,
        -- Set when the visit was booked from the engineer's customer list. The free-text name stays
        -- for the row itself (a customer renamed later must not rewrite history).
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        governorate TEXT NOT NULL DEFAULT '',
        district TEXT NOT NULL DEFAULT '',
        village TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT 'visit' CHECK(purpose IN ('visit','order','collection','note','issue','other')),
        notes TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
        checked_in_at INTEGER NOT NULL,
        checked_out_at INTEGER,
        duration_seconds INTEGER,
        -- 1 when the shift ended (or the cleanup ran) before the engineer recorded a result,
        -- so the row is a real check-in but its duration is an artifact, not a measured visit.
        auto_closed INTEGER NOT NULL DEFAULT 0,
        -- 1 when the row was typed on the phone with no signal and sent later, so its times come
        -- from the engineer's clock: the manager sees the difference instead of guessing.
        recorded_offline INTEGER NOT NULL DEFAULT 0,
        in_lat REAL, in_lng REAL, in_accuracy REAL,
        out_lat REAL, out_lng REAL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS visits_user_time ON visits(user_id, checked_in_at);
      CREATE INDEX IF NOT EXISTS visits_open ON visits(user_id, status);
      CREATE INDEX IF NOT EXISTS visits_created ON visits(created_at);
      -- Pending approval for OAuth social login (manager must approve)
      CREATE TABLE IF NOT EXISTS idle_reports (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        shift_id TEXT REFERENCES shifts(id) ON DELETE SET NULL,
        lat REAL, lng REAL, accuracy REAL, reason TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL, device_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      -- Expo tokens are scoped to a user and device. They can be rotated at each install, so one
      -- device may replace its token without leaving stale credentials behind.
      CREATE TABLE IF NOT EXISTS push_tokens (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform TEXT NOT NULL CHECK(platform IN ('ios','android')),
        device_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(user_id, device_id)
      );
      CREATE INDEX IF NOT EXISTS push_tokens_user ON push_tokens(user_id);
      -- A single OS-flagged simulated-location event per shift is enough for the manager to
      -- investigate, and prevents a fast GPS stream from turning detection into an event flood.
      CREATE TABLE IF NOT EXISTS mock_location_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(shift_id)
      );
      CREATE INDEX IF NOT EXISTS mock_location_events_time ON mock_location_events(created_at);
    `);
    // The product no longer ships simulated engineers. Deleting the marker without deleting
    // the rows would have left fake people inside a live account, so the rows go first.
    if (this.all('PRAGMA table_info(users)').some((column: any) => column.name === 'is_demo')) {
      this.run('DELETE FROM users WHERE is_demo=1');
      this.db.exec('ALTER TABLE users DROP COLUMN is_demo');
    }
    // The legacy SQLite table allowed an additional location source. Rebuild it with the
    // GPS-only constraint and keep only genuine GPS rows.
    const locationsSql = String(this.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='locations'")?.sql || '');
    if (locationsSql.includes("'demo'")) {
      this.db.exec(`
        CREATE TABLE locations_rebuilt (
          point_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
          lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL, speed REAL, heading REAL, battery REAL,
          recorded_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('gps')),
          PRIMARY KEY(user_id, point_id)
        );
        INSERT INTO locations_rebuilt
          SELECT point_id, user_id, shift_id, lat, lng, accuracy, speed, heading, battery, recorded_at, received_at, source
          FROM locations WHERE source='gps';
        DROP TABLE locations;
        ALTER TABLE locations_rebuilt RENAME TO locations;
        CREATE INDEX IF NOT EXISTS locations_user_time ON locations(user_id, recorded_at);
        CREATE INDEX IF NOT EXISTS locations_recorded ON locations(recorded_at);
      `);
    }
    // One name per owner is the rule above. The rows with no owner — the company's own list — need the
    // same rule on their own terms, and UNIQUE(rep_id, name) matches nothing there (NULL is never equal
    // to NULL in SQLite). It is a lookup index and not a UNIQUE one, deliberately: a database-level
    // rule would make deleting an engineer fail. His account going sets rep_id to NULL on every row he
    // had, and if the office already typed one of those names itself, the unique index rejects the SET
    // NULL — so a manager pressing «حذف الحساب» gets an error about a duplicate name, and the account
    // stays half-deleted. Refusing a deletion is worse than a duplicate: the pair of rows is a thing a
    // person can see and merge on the area screen, and the API checks the name on every write it owns.
    // The office list is written from the dashboard, and both the create route and the area move ask
    // the pool before they write.
    this.db.exec('CREATE INDEX IF NOT EXISTS customers_unassigned_name ON customers(name) WHERE rep_id IS NULL');

    // customers.rep_id used to be NOT NULL, which made «add the company's customers, link them later»
    // impossible — the office could not type a name before deciding who owns it. SQLite cannot drop a
    // NOT NULL in place, so the table is rebuilt and the rows are carried over.
    // PRAGMA foreign_keys has to be OFF for the swap: with enforcement on, DROP TABLE on a parent runs
    // every child's ON DELETE action — which would have set visits.customer_id and invoices.customer_id
    // to NULL for the whole database, silently unlinking every recorded visit and invoice from the
    // customer it belongs to. The pragma is per-connection and cannot change inside a transaction, so
    // it is set outside one and restored even if the rebuild throws.
    const customersSql = String(this.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='customers'")?.sql || '');
    if (/rep_id\s+TEXT\s+NOT NULL/i.test(customersSql)) {
      this.db.exec('PRAGMA foreign_keys = OFF');
      try {
        this.transaction(() => {
          this.db.exec(`
            CREATE TABLE customers_rebuilt (
              id TEXT PRIMARY KEY,
              rep_id TEXT REFERENCES users(id) ON DELETE SET NULL,
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
            INSERT INTO customers_rebuilt
              SELECT id, rep_id, name, phone, governorate, district, village, notes, lat, lng, stage, lost_reason, active, created_at, updated_at
              FROM customers;
            DROP TABLE customers;
            ALTER TABLE customers_rebuilt RENAME TO customers;
            CREATE INDEX IF NOT EXISTS customers_rep_active ON customers(rep_id, active);
          `);
          // The child tables keep their own text (`REFERENCES customers(id) ON DELETE SET NULL`), and
          // the rename restores the name they point at. Verify rather than trust it: a rebuild that
          // quietly broke those links is worse than the constraint it removed.
          const broken = this.all('PRAGMA foreign_key_check') as Array<Record<string, any>>;
          if (broken.length) throw new Error(`rebuilding customers broke ${broken.length} foreign key reference(s)`);
          // A database older than the visits.customer_id / invoices.customer_id columns has nothing to
          // re-point — those columns are added by migrations further down this list — so asking for them
          // here would throw «no such column» on exactly the upgrade this block exists to serve.
          for (const child of ['visits', 'invoices']) {
            if (!this.all(`PRAGMA table_info(${child})`).some((col: any) => col.name === 'customer_id')) continue;
            const orphaned = Number(this.get(`SELECT COUNT(*) AS c FROM ${child} WHERE customer_id IS NOT NULL
              AND customer_id NOT IN (SELECT id FROM customers)`)?.c || 0);
            if (orphaned) throw new Error(`rebuilding customers orphaned ${orphaned} row(s) of ${child}`);
          }
          // The rebuild drops the table's indexes with it, so put both back: the per-owner uniqueness
          // rule that was there before, and the office list's lookup index next to it.
          this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS customers_rep_name ON customers(rep_id, name COLLATE NOCASE)');
          this.db.exec('CREATE INDEX IF NOT EXISTS customers_unassigned_name ON customers(name) WHERE rep_id IS NULL');
        });
      } finally {
        this.db.exec('PRAGMA foreign_keys = ON');
      }
    }
    // Every representative used to be created with the same default colour, so the live map
    // drew identical pins for the whole team. Give each one its own colour once; an explicit
    // colour is never touched, and the second run finds nothing to do.
    const repColors = this.all("SELECT id, color FROM users WHERE role='rep' ORDER BY created_at, id");
    const shared = repColors.filter(rep => String(rep.color || '').toLowerCase() === DEFAULT_REP_COLOR).length;
    if (shared > 1) {
      const palette = ['#28745b', '#1f6feb', '#b8611a', '#7a3ea8', '#0f766e', '#b02a37', '#3f6212', '#a16207'];
      let index = 0;
      for (const rep of repColors) {
        if (String(rep.color || '').toLowerCase() !== DEFAULT_REP_COLOR) continue;
        this.run('UPDATE users SET color=? WHERE id=?', palette[index % palette.length], rep.id);
        index += 1;
      }
    }
    // Lightweight migrations for international/enterprise requirements
    for (const sql of [
      "ALTER TABLE shifts ADD COLUMN device_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE shifts ADD COLUMN device_name TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE shifts ADD COLUMN start_lat REAL",
      "ALTER TABLE shifts ADD COLUMN start_lng REAL",
      "ALTER TABLE shifts ADD COLUMN start_accuracy REAL",
      "ALTER TABLE users ADD COLUMN oauth_provider TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE users ADD COLUMN oauth_subject TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'",
      "ALTER TABLE users ADD COLUMN device_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE visits ADD COLUMN auto_closed INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE visits ADD COLUMN recorded_offline INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE visits ADD COLUMN customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL",
      "ALTER TABLE visits ADD COLUMN customer_linked_at INTEGER",
      "CREATE INDEX IF NOT EXISTS visits_customer ON visits(customer_id)",
      // What a dashboard account is allowed to see: '' = manager (everything), 'sales' = the sales
      // office, 'stock' = the warehouses only.
      //
      // This is a column and not a new value of users.role, and that is the whole point. role answers
      // «which client may sign in» — 'admin' for the website, 'rep' for the phone — and it is
      // compared against the X-Mandoub-Client hint, used to name the session cookie, and checked on
      // every route. Adding values to it means rebuilding the table eleven others point at with
      // ON DELETE CASCADE, just to change one CHECK clause, on a live production file, in order to
      // express a permission that has nothing to do with which client you are. Scope is a separate
      // question, so it is a separate column, and adding it is one safe ALTER.
      "ALTER TABLE users ADD COLUMN scope TEXT NOT NULL DEFAULT ''",
    ]) { try { this.db.exec(sql); } catch {} }
    // An index added after the fact: SQLite rejects `CREATE UNIQUE INDEX` on a table that already
    // holds two rows with the same owner and name, and refusing to start is worse than the
    // duplicates a manager can see and merge himself.
    try { this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS customers_rep_name ON customers(rep_id, name COLLATE NOCASE)'); }
    catch (error) { console.warn('[db] duplicate customer names exist; open the customers screen and merge them:', (error as Error).message); }
  }
  get(sql: string, ...params: any[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }
  all(sql: string, ...params: any[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  run(sql: string, ...params: any[]) { return this.db.prepare(sql).run(...params); }
  transaction(fn: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  audit(userId: string, action: string, metadata: object = {}) {
    this.run('INSERT INTO audit_log(user_id,action,created_at,metadata) VALUES (?,?,?,?)', userId, action, Date.now(), JSON.stringify(metadata));
  }
  cleanup(retentionDays: number) {
    const cutoff = Date.now() - retentionDays * 86400000;
    this.run('DELETE FROM locations WHERE recorded_at < ?', cutoff);
    this.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    this.run('DELETE FROM audit_log WHERE created_at < ?', cutoff);
    this.run('DELETE FROM mock_location_events WHERE created_at < ?', cutoff);
    this.run('DELETE FROM shifts WHERE ended_at IS NOT NULL AND ended_at < ? AND NOT EXISTS (SELECT 1 FROM locations WHERE locations.shift_id = shifts.id)', cutoff);
    this.run('DELETE FROM reports WHERE created_at < ?', cutoff);
    this.run('DELETE FROM daily_reports WHERE created_at < ?', cutoff);
    this.run('DELETE FROM visits WHERE created_at < ?', cutoff);
    // Stillness justifications carry a GPS fix and a free-text reason, so they are covered by
    // the same retention window the privacy policy promises. They used to be kept forever.
    this.run('DELETE FROM idle_reports WHERE created_at < ?', cutoff);
    // Invoices, their lines, the stock ledger, products and warehouses are NOT swept either, for a
    // stronger reason than customers: this file is the company's money record. An invoice that quietly
    // aged out of the database would leave a customer owing an amount nobody can any longer prove.
    // `customers` is deliberately NOT swept: it is master data, not a personal-activity log, and an
    // engineer whose whole customer list vanished after a year would find the register unreadable.
    // Their own erasure path deletes a customer list by deleting the account (ON DELETE CASCADE).
    // An app that is killed (or a phone that dies) never sends "stop shift", so a shift could
    // stay open for days: the manager saw an engineer "in the field" at 3 a.m. and the phone
    // kept re-attaching to a shift from last week. A shift with no fixes for a day is over.
    // The lookup is scoped to the shift itself. Asking for the representative's newest fix at all
    // meant a shift from last week was never closed as long as the same person still drove on a
    // newer one: the manager kept seeing an engineer "in the field" on the old shift, and the app
    // kept re-attaching to it. A shift's own last fix (or its start) is what decides it is over.
    const staleBefore = Date.now() - STALE_SHIFT_MS;
    this.run(`UPDATE shifts SET ended_at = MAX(started_at, COALESCE(
        (SELECT MAX(recorded_at) FROM locations WHERE locations.shift_id = shifts.id), started_at))
      WHERE ended_at IS NULL AND started_at < ?
        AND COALESCE((SELECT MAX(recorded_at) FROM locations WHERE locations.shift_id = shifts.id), started_at) < ?`,
    staleBefore, staleBefore);
    // A visit left open when the app was killed (or the phone died) blocked the next check-in
    // with "لديك زيارة مفتوحة" and kept a stopwatch running for days on both screens. Close it
    // and mark it as automatic, but leave checkout time and duration NULL: the server cannot
    // know when the engineer actually left, and a fabricated zero looks like a measured visit.
    // The KPI average also excludes these rows (`auto_closed`).
    // A visit is opened inside a shift and can only be closed by one, so a visit still open for
    // an account with no open shift is over: its shift was closed (by the rule above, by another
    // device, or by the engineer's own stop that never reached the server). Waiting for the
    // 18-hour clock left it open — and therefore invisible on the "today" screen while it kept
    // blocking the next check-in with "لديك زيارة مفتوحة" — for a whole working day.
    this.run(`UPDATE visits SET status='closed', auto_closed=1,
        checked_out_at = NULL, duration_seconds = NULL,
        outcome = CASE WHEN TRIM(COALESCE(outcome,''))='' THEN ? ELSE outcome END
      WHERE status='open' AND (checked_in_at < ?
        OR NOT EXISTS (SELECT 1 FROM shifts s WHERE s.user_id = visits.user_id AND s.ended_at IS NULL))`,
    AUTO_CLOSED_OUTCOME, staleBefore);
  }
  close() { this.db.close(); }
}
