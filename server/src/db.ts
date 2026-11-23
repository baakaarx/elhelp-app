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
        unit TEXT NOT NULL DEFAULT 'كرتونة',
        -- The catalogue price is the warehouse's answer, not the engineer's: it is set here so one
        -- price is used everywhere and a phone cannot invent one.
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
