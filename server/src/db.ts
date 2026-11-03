import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Row = Record<string, any>;
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
        color TEXT NOT NULL DEFAULT '#28745b', is_demo INTEGER NOT NULL DEFAULT 0,
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
        source TEXT NOT NULL CHECK(source IN ('gps','demo')),
        PRIMARY KEY(user_id, point_id)
      );
      CREATE INDEX IF NOT EXISTS locations_user_time ON locations(user_id, recorded_at);
      CREATE INDEX IF NOT EXISTS shifts_user_start ON shifts(user_id, started_at);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
        action TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}'
      );
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
        in_lat REAL, in_lng REAL, in_accuracy REAL,
        out_lat REAL, out_lng REAL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS visits_user_time ON visits(user_id, checked_in_at);
      CREATE INDEX IF NOT EXISTS visits_open ON visits(user_id, status);
      -- Pending approval for OAuth social login (manager must approve)
      CREATE TABLE IF NOT EXISTS idle_reports (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        shift_id TEXT REFERENCES shifts(id) ON DELETE SET NULL,
        lat REAL, lng REAL, accuracy REAL, reason TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL, device_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
    `);
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
  }
  close() { this.db.close(); }
}
