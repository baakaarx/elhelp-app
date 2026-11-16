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
      -- Field visits: a rep checks in at a customer, then checks out. The pair is the
      -- auditable record used by the manager timeline and the daily KPIs.
      CREATE TABLE IF NOT EXISTS visits (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        customer_name TEXT NOT NULL,
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
    `);
    // The product no longer ships simulated engineers. Deleting the marker without deleting
    // the rows would have left fake people inside a live account, so the rows go first.
    if (this.all('PRAGMA table_info(users)').some((column: any) => column.name === 'is_demo')) {
      this.run('DELETE FROM users WHERE is_demo=1');
      this.db.exec('ALTER TABLE users DROP COLUMN is_demo');
    }
    // `source` used to allow 'demo'. SQLite cannot alter a CHECK constraint, so the table is
    // rebuilt once and any legacy simulated track is dropped.
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
    ]) { try { this.db.exec(sql); } catch {} }
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
    // with "لديك زيارة مفتوحة" and kept a stopwatch running for days on both screens. It is
    // closed here at zero duration, marked as automatic, and keeps the result if one was typed.
    // The duration is not measured, so the KPI average ignores it (`auto_closed`).
    // A visit is opened inside a shift and can only be closed by one, so a visit still open for
    // an account with no open shift is over: its shift was closed (by the rule above, by another
    // device, or by the engineer's own stop that never reached the server). Waiting for the
    // 18-hour clock left it open — and therefore invisible on the "today" screen while it kept
    // blocking the next check-in with "لديك زيارة مفتوحة" — for a whole working day.
    this.run(`UPDATE visits SET status='closed', auto_closed=1,
        checked_out_at = checked_in_at, duration_seconds = 0,
        outcome = CASE WHEN TRIM(COALESCE(outcome,''))='' THEN ? ELSE outcome END
      WHERE status='open' AND (checked_in_at < ?
        OR NOT EXISTS (SELECT 1 FROM shifts s WHERE s.user_id = visits.user_id AND s.ended_at IS NULL))`,
    AUTO_CLOSED_OUTCOME, staleBefore);
  }
  close() { this.db.close(); }
}
