import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Row = Record<string, any>;
/** An open shift with no fixes for this long is treated as left behind, not as still running. */
const STALE_SHIFT_MS = 18 * 3600000;
/** The value `users.color` defaults to, shared by every account created before this migration. */
const DEFAULT_REP_COLOR = '#28745b';
/** Written into `visits.outcome` when the system closed a visit nobody ended. */
/**
 * The buyer types an installation starts with, in the order the office reads them.
 *
 * They are a starting point, not a fixed list: the office renames them and adds its own (a «موزع» rate
 * is a real thing in this trade). A new installation and an old database gaining the price list both get
 * these three; nobody who deleted one ever gets it back on a restart.
 */
export const DEFAULT_PRICE_TIERS = ['جملة', 'نصف جملة', 'تجزئة'];
export const AUTO_CLOSED_OUTCOME = 'أُغلقت تلقائيًا: انتهت الوردية قبل تسجيل النتيجة';
/**
 * The hourly sweep, and the reason it may fail.
 *
 * cleanup runs unattended at three in the morning inside a timer: a full disk, a lock held past
 * busy_timeout, or a corrupt index makes it throw — and an exception inside a timer is an
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
        active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_seen INTEGER
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
      CREATE INDEX IF NOT EXISTS audit_order_notice ON audit_log(id) WHERE action='order.notification';
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
      -- ---- What the company sells: the price list and the items -------------------------------
      --
      -- The types of buyer, named by the office. This is what «same farm, two prices» means in this
      -- database: a customer carries one of these, and an item carries one price per type.
      CREATE TABLE IF NOT EXISTS price_tiers (
        id TEXT PRIMARY KEY,
        -- A type is named or it is not a type: this name is what the price list header reads and what an
        -- invoice explains itself with, and an empty one is a row no screen can label. The route asks for
        -- the same thing; a CHECK is what keeps a hand-edited row from becoming the bug instead.
        name TEXT NOT NULL CHECK(length(trim(name)) >= 2),
        -- The order the columns are shown in. Prices are read left to right — from the man who buys the
        -- most to the one who buys one bottle — so the office decides it, not the alphabet.
        position INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      -- Two types with the same name would make «سعر الجملة» mean two different numbers. The indexes of
      -- these three tables are created after the migrations (see ensureIndexes), not here.

      -- Pesticides and fertilizers, sold by the pack. The unit column has no default on purpose: a «كرتونة»
      -- guessed for an item that ships in bottles is a price read as twelve times its value, and the
      -- invoice looks finished while the number is wrong. An item cannot be entered without saying what
      -- one unit of it is.
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other' CHECK(category IN ('pesticide','fertilizer','other')),
        unit TEXT NOT NULL,
        -- What is inside that pack — «٥٠٠ مل»، «٥٠ كجم». Text, and never used in arithmetic: it is what
        -- a man reads on the screen to know he is pricing the bag he is standing next to.
        unit_size TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      -- «يوريا ٥٠ كجم – شيكارة» and «يوريا ٢٥ كجم – شيكارة» are two items; the same item entered twice
      -- under one pack is the duplicate that double-counts a sale. The route trims the text before it
      -- gets here, because this index compares what it is given.

      -- One price per item per buyer type. There is no single price column on the item on purpose: one
      -- number there is what gets quoted from memory to a man who buys at another rate. An item with no
      -- price for a type is a normal state — the office prices that order by hand.
      CREATE TABLE IF NOT EXISTS warehouses (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS warehouse_stock (
        warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        milli_qty INTEGER NOT NULL DEFAULT 0 CHECK(milli_qty >= 0),
        PRIMARY KEY (warehouse_id, product_id)
      );
      CREATE TABLE IF NOT EXISTS inventory_movements (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('opening','in','out','transfer')),
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        from_warehouse_id TEXT REFERENCES warehouses(id) ON DELETE RESTRICT,
        to_warehouse_id TEXT REFERENCES warehouses(id) ON DELETE RESTRICT,
        milli_qty INTEGER NOT NULL CHECK(milli_qty >= 0), note TEXT NOT NULL DEFAULT '',
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        actor_name TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inventory_movements_time ON inventory_movements(created_at DESC);
      CREATE TABLE IF NOT EXISTS inventory_migrations (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS warehouse_item_requests_v1 (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_json TEXT NOT NULL, product_id TEXT NOT NULL
      );
      -- Confirmed sales and customer balances are independent of priced orders and old collection reports.
      CREATE TABLE IF NOT EXISTS office_sales_v1 (
        id TEXT PRIMARY KEY, order_id TEXT UNIQUE, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
        warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
        total_piasters INTEGER NOT NULL CHECK(total_piasters >= 0), paid_piasters INTEGER NOT NULL CHECK(paid_piasters >= 0),
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, actor_name TEXT NOT NULL,
        request_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS office_sales_v1_customer_time ON office_sales_v1(customer_id,created_at);
      -- A stable invoice number is assigned once when a confirmed sale commits.
      CREATE TABLE IF NOT EXISTS office_invoice_numbers_v1 (
        number INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id TEXT NOT NULL UNIQUE REFERENCES office_sales_v1(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS office_sales_lines_v1 (
        id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES office_sales_v1(id) ON DELETE RESTRICT,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        product_name TEXT NOT NULL, unit TEXT NOT NULL, unit_size TEXT NOT NULL,
        milli_qty INTEGER NOT NULL CHECK(milli_qty > 0), price_piasters INTEGER NOT NULL CHECK(price_piasters >= 0),
        line_piasters INTEGER NOT NULL CHECK(line_piasters >= 0)
      );
      CREATE INDEX IF NOT EXISTS office_sales_lines_v1_sale ON office_sales_lines_v1(sale_id);
      -- Attribution is fixed at confirmation, never derived from today's customer assignment.
      -- A missing row means a sale from before attribution existed; a row with a NULL rep is deliberate.
      CREATE TABLE IF NOT EXISTS office_sale_rep_v1 (
        sale_id TEXT PRIMARY KEY REFERENCES office_sales_v1(id) ON DELETE RESTRICT,
        rep_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        rep_name TEXT NOT NULL DEFAULT '', source TEXT NOT NULL CHECK(source IN ('order','direct','none'))
      );
      CREATE INDEX IF NOT EXISTS office_sale_rep_v1_rep ON office_sale_rep_v1(rep_id);

      CREATE TABLE IF NOT EXISTS office_debts_v1 (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL UNIQUE REFERENCES customers(id) ON DELETE RESTRICT,
        amount_piasters INTEGER NOT NULL CHECK(amount_piasters >= 0), actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        actor_name TEXT NOT NULL, request_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS office_receipts_v1 (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
        amount_piasters INTEGER NOT NULL CHECK(amount_piasters > 0), actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        actor_name TEXT NOT NULL, request_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS office_receipts_v1_customer ON office_receipts_v1(customer_id,created_at);
      -- Corrections are append-only; their original sale or receipt remains intact.
      CREATE TABLE IF NOT EXISTS office_invoice_snapshots_v1 (
        sale_id TEXT PRIMARY KEY REFERENCES office_sales_v1(id) ON DELETE RESTRICT,
        customer_name TEXT NOT NULL, phone TEXT NOT NULL, governorate TEXT NOT NULL, district TEXT NOT NULL,
        village TEXT NOT NULL, warehouse_name TEXT NOT NULL, rep_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS office_corrections_v1 (
        id TEXT PRIMARY KEY, sale_id TEXT REFERENCES office_sales_v1(id) ON DELETE RESTRICT,
        receipt_id TEXT REFERENCES office_receipts_v1(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL, cash_kind TEXT CHECK(cash_kind IN ('error','refund')),
        cash_piasters INTEGER NOT NULL CHECK(cash_piasters >= 0),
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, actor_name TEXT NOT NULL,
        request_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        CHECK((sale_id IS NULL) <> (receipt_id IS NULL)),
        CHECK((cash_kind IS NULL AND cash_piasters=0) OR (cash_kind IS NOT NULL AND cash_piasters>0))
      );
      CREATE INDEX IF NOT EXISTS office_corrections_sale ON office_corrections_v1(sale_id);
      CREATE INDEX IF NOT EXISTS office_corrections_receipt ON office_corrections_v1(receipt_id);
      CREATE TABLE IF NOT EXISTS office_correction_lines_v1 (
        correction_id TEXT NOT NULL REFERENCES office_corrections_v1(id) ON DELETE RESTRICT,
        line_id TEXT NOT NULL REFERENCES office_sales_lines_v1(id) ON DELETE RESTRICT,
        corrected_milli INTEGER NOT NULL CHECK(corrected_milli>=0),
        returned_milli INTEGER NOT NULL CHECK(returned_milli>=0),
        amount_piasters INTEGER NOT NULL CHECK(amount_piasters>=0),
        stock_kind TEXT CHECK(stock_kind IN ('returned','error')),
        PRIMARY KEY(correction_id,line_id), CHECK(corrected_milli>0 OR returned_milli>0),
        CHECK((returned_milli=0 AND stock_kind IS NULL) OR (returned_milli>0 AND stock_kind IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS office_correction_lines_line ON office_correction_lines_v1(line_id);
      CREATE VIEW IF NOT EXISTS office_sales_lines_net_v1 AS
        SELECT l.id,l.sale_id,l.product_id,l.product_name,l.unit,l.unit_size,l.price_piasters,
          l.milli_qty-COALESCE((SELECT SUM(corrected_milli) FROM office_correction_lines_v1 cl WHERE cl.line_id=l.id),0) AS milli_qty,
          l.line_piasters-COALESCE((SELECT SUM(amount_piasters) FROM office_correction_lines_v1 cl WHERE cl.line_id=l.id),0) AS line_piasters
        FROM office_sales_lines_v1 l;
      CREATE VIEW IF NOT EXISTS office_sales_net_v1 AS
        SELECT s.id,s.order_id,s.customer_id,s.warehouse_id,s.paid_piasters,s.actor_id,s.actor_name,s.request_json,s.created_at,
          COALESCE((SELECT SUM(line_piasters) FROM office_sales_lines_net_v1 l WHERE l.sale_id=s.id),0) AS total_piasters
        FROM office_sales_v1 s WHERE EXISTS(SELECT 1 FROM office_sales_lines_net_v1 l WHERE l.sale_id=s.id AND l.milli_qty>0);



      CREATE TABLE IF NOT EXISTS product_prices (
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        tier_id TEXT NOT NULL REFERENCES price_tiers(id) ON DELETE CASCADE,
        -- A negative line is either a mistake or a discount hiding where a discount needs a reason.
        price REAL NOT NULL CHECK(price >= 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (product_id, tier_id)
      );

      -- ---- The company's customer book ---------------------------------------------------------
      -- Master data of the sales office: the manager and his team enter it from the dashboard, and an
      -- engineer never adds a customer from his phone. rep_id is the man the office handed him to,
      -- and it is deliberately nullable — a name the office typed before deciding who drives that
      -- area is a real customer, not a half-row waiting for an owner. ON DELETE SET NULL and not
      -- CASCADE: an engineer leaving the company must not delete his customers, they are the
      -- company's, and they come back to the unassigned pool to be handed out again.
      -- One name per owner is enforced by the unique index below (a duplicated customer is a duplicated
      -- sales figure); the unassigned pool gets the same rule checked in the API instead of an index,
      -- because a UNIQUE index over rep_id IS NULL would make deleting an engineer fail — his rows
      -- land in that pool on their way out, and a collision there is a fact to merge, not an error.
      -- This table is deliberately absent from Store.cleanup(): it is the list, not the log, and
      -- RETENTION_DAYS must not sweep it.
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        rep_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        governorate TEXT NOT NULL DEFAULT '',
        district TEXT NOT NULL DEFAULT '',
        village TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        -- Where the relationship stands. «lost» without a reason is how a refused customer becomes
        -- nobody's mistake, so the reason is required by the route, not by a CHECK.
        stage TEXT NOT NULL DEFAULT 'new' CHECK(stage IN ('new','following','active','dormant','lost')),
        lost_reason TEXT NOT NULL DEFAULT '',
        -- Which column of the price list this man buys at. Deliberately not the stage above: «جديد» or
        -- «برّد» says where the relationship stands, «جملة» says what he pays. Null is normal — a
        -- customer with no type is priced by hand, and the invoice keeps what was chosen.
        price_tier_id TEXT REFERENCES price_tiers(id) ON DELETE SET NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS customers_rep_name ON customers(rep_id, name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS customers_rep_active ON customers(rep_id, active, name COLLATE NOCASE);
      -- The office splits the list by place — «عملاء طنطا لمهندس طنطا» — so an area is a lookup path of
      -- its own here, not a filter people scroll past.
      CREATE INDEX IF NOT EXISTS customers_area ON customers(governorate, district, active);

      -- Field visits: a rep checks in at a customer, then checks out. The pair is the
      -- auditable record used by the manager timeline and the daily KPIs.
      CREATE TABLE IF NOT EXISTS visits (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- The name as it was written on the day. It is copied from the chosen customer rather than
        -- typed by hand, so the row keeps telling the truth after the office renames the farm — and an
        -- older visit, whose name was typed freely, still reads the same as it did.
        customer_name TEXT NOT NULL,
        -- Which row of the company's customer book this visit belongs to. Nullable because the visits
        -- recorded before the book existed have no row to point at, and rewriting them by name would be
        -- a guess: «محمود» and «محمود عبد الله» are not proof of one man.
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

      -- ---- What the engineer agreed to sell: the order ------------------------------------------
      --
      -- An order is the promise made in the yard, before anybody put a number on it. The office prices it
      -- and the phone never does, so there is no price a field could fill in here, and no rate travelling
      -- to a screen where it would be read as an offer. The team's move is to price these rows and close
      -- them; an invoice is a different document on top of a closed order, not a rename of one.
      --
      -- It is written against a row of the customer book — the same rule as a visit: a name typed by hand
      -- is a customer who may not exist. visit_id is a link and not a parent, because the man who takes
      -- an order by phone from the road must not have to check himself in at his own gate to make the
      -- paperwork work, and the man who agrees it in the field gets the connection the manager wants.
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        -- Who agreed it, kept beside the customer because «مين قال للمزارع الكمية دي؟» gets asked.
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- RESTRICT, never CASCADE: an order is money-talk, and deleting a customer must not quietly un-make
        -- a promise the company made to him. The office stops the row instead, and the sentence it is
        -- refused with names what is holding him.
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
        -- Nullable, and SET NULL rather than CASCADE: cleanup() sweeps visits under RETENTION_DAYS, and a
        -- promise made inside a swept visit is still a promise. The order survives; it only stops claiming
        -- a visit it can no longer point at.
        visit_id TEXT REFERENCES visits(id) ON DELETE SET NULL,
        -- draft: on the phone, not sent. sent: the office's turn. priced: the team put the numbers on it
        -- and closed it. There is no «cancelled» on purpose — a field order going away is a decision
        -- somebody signs, not a row that disappears, and it will be added with its reason when it is needed.
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','priced')),
        notes TEXT NOT NULL DEFAULT '',
        -- The engineer's free-text recommendation, preserved separately from the office's invoice.
        recommendation TEXT NOT NULL DEFAULT '',
        -- The phone's own clock on a replayed order, exactly as visits carry it, so the office can tell
        -- «أُرسلت من المزرعة» from «أُرسلت لما الشبكة رجعت» instead of guessing.
        recorded_offline INTEGER NOT NULL DEFAULT 0,
        -- Written once by the office and never recomputed afterwards: it is what the team said the order
        -- came to, so editing a catalogue price next month must not silently change a closed agreement.
        total REAL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        sent_at INTEGER, priced_at INTEGER,
        -- Which account closed it. A number written into the company's book carries a name with it.
        priced_by TEXT REFERENCES users(id) ON DELETE SET NULL
      );
      -- One line per item per order. Two lines for the same item are not two agreements — they are one
      -- agreement counted twice, which is exactly what a replayed offline send would do to the numbers.
      CREATE TABLE IF NOT EXISTS order_lines (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        -- The order the phone showed, kept rather than re-derived, because «٣ شيكارة يوريا» written under
        -- «١ شيكارة مبيد» is the sentence the office reads in that order.
        position INTEGER NOT NULL,
        -- RESTRICT again: the item the office priced against cannot disappear under the line. With this in
        -- place, the guard on deleting an item — which reads the schema instead of a list — starts refusing
        -- on its own the day orders exist, and names the rows that hold it.
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        -- The name and the pack as they were when the quantity was agreed. A pack is the only thing that
        -- makes a quantity mean something, and the office is allowed to change «عبوة» to «كرتونة» tomorrow
        -- without rewriting what was promised in the yard.
        product_name TEXT NOT NULL,
        unit TEXT NOT NULL,
        unit_size TEXT NOT NULL DEFAULT '',
        -- Zero is a line nobody needs and a negative is a refund wearing a costume; the ceiling is there
        -- for the fat finger («٣٠» typed as «٣٠٠٠٠٠») that no screen notices before the warehouse does.
        qty REAL NOT NULL CHECK(qty > 0 AND qty <= 100000),
        notes TEXT NOT NULL DEFAULT '',
        -- ---- what the office fills in, and NULL until it does ----
        -- Which column of the price list was used, so «ليه السعر ده؟» has an answer. Null together with a
        -- price means it was typed by hand — the normal state for a customer with no buyer type.
        tier_id TEXT REFERENCES price_tiers(id) ON DELETE SET NULL,
        price REAL CHECK(price IS NULL OR price >= 0),
        created_at INTEGER NOT NULL
      );
      -- Deliberately absent from Store.cleanup(): a promise outlives the GPS trail it was made in, and
      -- RETENTION_DAYS is a promise about locations, not about the company's sales history.
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
      "ALTER TABLE users ADD COLUMN access_scope TEXT NOT NULL DEFAULT 'full' CHECK(access_scope IN ('full','warehouse'))",
      "ALTER TABLE visits ADD COLUMN auto_closed INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE visits ADD COLUMN recorded_offline INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE visits ADD COLUMN customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL",
      // The buyer type a customer is quoted at. Nullable, and null means «nobody decided yet» rather
      // than «جملة by default»: an order for such a customer is priced by hand.
      "ALTER TABLE customers ADD COLUMN price_tier_id TEXT REFERENCES price_tiers(id) ON DELETE SET NULL",
    ]) { try { this.db.exec(sql); } catch {} }
    // Some old installations have an unrelated table called orders. Do not alter it; the existing
    // schema diagnostics explain how to repair it. Only migrate our own recognizable order schema.
    const orderColumns = new Set(this.all('PRAGMA table_info(orders)').map(column => String(column.name)));
    const ownOrderShape = ['id','user_id','customer_id','visit_id','status','notes','recorded_offline','created_at','updated_at','sent_at','priced_by'].every(column => orderColumns.has(column));
    if (ownOrderShape && !orderColumns.has('recommendation')) {
      this.db.exec("ALTER TABLE orders ADD COLUMN recommendation TEXT NOT NULL DEFAULT ''");
    }
    if (!this.all('PRAGMA table_info(users)').some(column => column.name === 'access_scope')) {
      throw new Error('تعذر إضافة صلاحيات حساب المخازن؛ السيرفر لن يعمل قبل إصلاح قاعدة البيانات.');
    }
    // Older databases can contain an unrelated stock_movements table. Preserve it untouched.
    // Only the previous version of this inventory feature has these exact columns; its movements
    // can be copied once into the separate ledger without assuming old signed entries are balances.
    const oldMovementColumns = new Set(this.all('PRAGMA table_info(stock_movements)').map(column => column.name));
    const inventoryColumns = ['id','kind','product_id','from_warehouse_id','to_warehouse_id','milli_qty','note','actor_id','actor_name','created_at'];
    if (inventoryColumns.every(column => oldMovementColumns.has(column)) && !this.get("SELECT 1 FROM inventory_migrations WHERE name='copy_v1_movements'")) {
      this.transaction(() => {
        this.db.exec(`INSERT INTO inventory_movements (${inventoryColumns.join(',')}) SELECT ${inventoryColumns.join(',')} FROM stock_movements`);
        this.run("INSERT INTO inventory_migrations(name) VALUES ('copy_v1_movements')");
      });
    }
    // Assign pre-existing test/legacy sales in their recorded order, atomically and only once.
    // BEGIN IMMEDIATE also serializes startup with another process writing confirmed sales.
    this.transaction(() => {
      this.db.exec(`INSERT INTO office_invoice_numbers_v1(sale_id)
        SELECT s.id FROM office_sales_v1 s WHERE NOT EXISTS
        (SELECT 1 FROM office_invoice_numbers_v1 n WHERE n.sale_id=s.id)
        ORDER BY s.created_at,s.rowid`);
    });
    this.ensureIndexes();
    try {this.ensureProductPacks();} catch (error) {this.db.close();throw error;}
    this.checkCatalogueLinks();

    // The check is made here, at seeding time, and not from a flag read before the schema block ran: an
    // installation whose boot died between creating this table and filling it has to end up with a list
    // the next time it comes up.
    if (!this.get('SELECT 1 AS x FROM price_tiers LIMIT 1')) {
      const now = Date.now();
      for (const [position, name] of DEFAULT_PRICE_TIERS.entries()) {
        this.run('INSERT INTO price_tiers(id,name,position,created_at,updated_at) VALUES (?,?,?,?,?)', randomUUID(), name, position, now, now);
      }
    }
  }
  /**
   * Every index that touches a column a migration may still be adding, or a table an old installation
   * can already own under the same name with a different shape.
   *
   * Two failures, one rule: the index is asked for after the migrations, and only when the columns it
   * needs are actually there. On a database that already had the table, the CREATE above is skipped, so
   * a column that arrives with an ALTER does not exist when the schema block runs — and an installation
   * that once ran an abandoned version of this file owns a table with the right name and the wrong
   * columns. In both cases SQLite refuses the index, and a refusal inside this constructor is not a
   * warning somebody notices: it is a server that never starts. So the mismatch is logged with the
   * column it is about, and the installation keeps serving.
   */
  private ensureIndexes() {
    const defs: Array<{ table: string; index: string; stmt: string; needs: string[] }> = [
      { table: 'visits', index: 'visits_customer', stmt: 'CREATE INDEX IF NOT EXISTS visits_customer ON visits(customer_id)', needs: ['customer_id'] },
      { table: 'price_tiers', index: 'price_tiers_name', stmt: 'CREATE UNIQUE INDEX IF NOT EXISTS price_tiers_name ON price_tiers(name COLLATE NOCASE)', needs: ['name'] },
      { table: 'price_tiers', index: 'price_tiers_active', stmt: 'CREATE INDEX IF NOT EXISTS price_tiers_active ON price_tiers(active, position)', needs: ['active', 'position'] },
      { table: 'products', index: 'products_active_category', stmt: 'CREATE INDEX IF NOT EXISTS products_active_category ON products(active, category, name COLLATE NOCASE)', needs: ['active', 'category', 'name'] },
      { table: 'product_prices', index: 'product_prices_tier', stmt: 'CREATE INDEX IF NOT EXISTS product_prices_tier ON product_prices(tier_id, price)', needs: ['tier_id', 'price'] },
      { table: 'orders', index: 'orders_rep_time', stmt: 'CREATE INDEX IF NOT EXISTS orders_rep_time ON orders(user_id, created_at)', needs: ['user_id', 'created_at'] },
      { table: 'orders', index: 'orders_customer_time', stmt: 'CREATE INDEX IF NOT EXISTS orders_customer_time ON orders(customer_id, created_at)', needs: ['customer_id', 'created_at'] },
      { table: 'orders', index: 'orders_visit', stmt: 'CREATE INDEX IF NOT EXISTS orders_visit ON orders(visit_id)', needs: ['visit_id'] },
      // The badge on the manager's dashboard is exactly «what is still waiting for the team», so the
      // queue is an index of its own rather than a scan over every order the company ever wrote.
      { table: 'orders', index: 'orders_queue', stmt: 'CREATE INDEX IF NOT EXISTS orders_queue ON orders(created_at) WHERE status = \'sent\'', needs: ['status', 'created_at'] },
      // Unique on the item, not merely on the pair with position: see the note above the table.
      { table: 'order_lines', index: 'order_lines_item', stmt: 'CREATE UNIQUE INDEX IF NOT EXISTS order_lines_item ON order_lines(order_id, product_id)', needs: ['order_id', 'product_id'] },
      { table: 'order_lines', index: 'order_lines_position', stmt: 'CREATE UNIQUE INDEX IF NOT EXISTS order_lines_position ON order_lines(order_id, position)', needs: ['order_id', 'position'] },
      // What the delete guard on `products` counts, one row per line — without it, deleting an item walks
      // the whole lines table and the office waits on a spinner to be told no.
      { table: 'order_lines', index: 'order_lines_product_ref', stmt: 'CREATE INDEX IF NOT EXISTS order_lines_product_ref ON order_lines(product_id)', needs: ['product_id'] },
    ];
    for (const def of defs) {
      const shape = new Set((this.all(`PRAGMA table_info(${def.table})`) as Array<Record<string, any>>).map(col => String(col.name)));
      const missing = def.needs.filter(column => !shape.has(column));
      if (missing.length) {
        // Loud on purpose: a missing index is a slow lookup, but a table whose columns are not the ones
        // this file expects means the data below is being read with the wrong assumptions.
        console.error(`[db] skipped index ${def.index}: table ${def.table} does not have ${missing.join(', ')} — this database holds an older shape of that table.`);
        continue;
      }
      try { this.db.exec(def.stmt); } catch (error) {
        console.error(`[db] could not create index ${def.index}:`, error);
      }
    }
  }
  /** Upgrade the old (name, unit) rule atomically; never rewrite products, prices or balances. */
  private ensureProductPacks() {
    const columns = new Set(this.all('PRAGMA table_info(products)').map(column => String(column.name)));
    if (!['id','name','unit','unit_size'].every(column => columns.has(column))) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS products_name_unit_size ON products(name COLLATE NOCASE, unit COLLATE NOCASE, unit_size COLLATE NOCASE);
        DROP INDEX IF EXISTS products_name_unit;
        CREATE TRIGGER IF NOT EXISTS products_pack_insert BEFORE INSERT ON products
        WHEN EXISTS (SELECT 1 FROM products p WHERE p.name=NEW.name COLLATE NOCASE AND p.unit=NEW.unit COLLATE NOCASE
          AND (trim(p.unit_size)='' OR trim(NEW.unit_size)='' OR p.unit_size=NEW.unit_size COLLATE NOCASE))
        BEGIN SELECT RAISE(ABORT,'PRODUCT_PACK_CONFLICT'); END;
        CREATE TRIGGER IF NOT EXISTS products_pack_update BEFORE UPDATE OF name,unit,unit_size ON products
        WHEN EXISTS (SELECT 1 FROM products p WHERE p.id<>NEW.id AND p.name=NEW.name COLLATE NOCASE AND p.unit=NEW.unit COLLATE NOCASE
          AND (trim(p.unit_size)='' OR trim(NEW.unit_size)='' OR p.unit_size=NEW.unit_size COLLATE NOCASE))
        BEGIN SELECT RAISE(ABORT,'PRODUCT_PACK_CONFLICT'); END;
      `);
    });
  }
  /**
   * The one catalogue fault that no data shows and no boot fails on: a price table whose parent moved.
   *
   * Renaming a table drags every child's REFERENCES clause with it, which is how an installation that was
   * put back by hand ends up with product_prices pointing at products_legacy_rejected_batch. Every read
   * of the list works, so nothing looks wrong — until the first price is saved, and the office is told
   * «FOREIGN KEY constraint failed» about a table nobody has seen in months. Saying it here, once, in the
   * sentence that names the script that fixes it, is the difference between a boot log and a support call.
   */
  private checkCatalogueLinks() {
    const links: Array<[table: string, column: string, parent: string, about: string]> = [
      ['product_prices', 'product_id', 'products', 'الأصناف ما تتسعّرش على القاعدة دي'],
      ['product_prices', 'tier_id', 'price_tiers', 'الأصناف ما تتسعّرش على القاعدة دي'],
      // The order tables are newer than this guard, and the fault costs more here: a line whose parent
      // moved is a promise the office can open in the list and cannot price.
      ['order_lines', 'order_id', 'orders', 'الطلبيات ما تتقفلش على القاعدة دي'],
      ['order_lines', 'product_id', 'products', 'الطلبيات ما تتسعّرش على القاعدة دي'],
      ['orders', 'customer_id', 'customers', 'الطلبيات ما تركبش على عميل القاعدة دي'],
      ['orders', 'visit_id', 'visits', 'الطلبيات ما تركبش على زيارة القاعدة دي'],
    ];
    for (const [table, column, parent, about] of links) {
      const columns = new Set((this.all(`PRAGMA table_info(${table})`) as Array<Record<string, any>>).map(col => String(col.name)));
      // No such column means the table itself is an older shape, which ensureIndexes has already reported
      // by name; two warnings for one fact teach the operator to ignore both.
      if (!columns.has(column)) continue;
      const link = (this.all(`PRAGMA foreign_key_list(${table})`) as Array<Record<string, any>>)
        .find(fk => String(fk.from) === column);
      const target = link ? String(link.table).replace(/^["`]/, '').replace(/["`]$/, '') : '';
      if (target !== parent) {
        console.error(`[db] ${table}.${column} references ${target || 'nothing'} instead of ${parent} — ${about}. شغّل: node scripts/repair-legacy-catalogue.mjs`);
      }
    }
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
