import * as SQLite from 'expo-sqlite';
import { outboxKey } from './outboxKey';
import { OUTBOX_ORDER_BY_SQL } from './queueOrder';
import type { Outbox } from './queue';
import type { OutboxItem, OutboxKind } from './types';

// A durable outbox: GPS fixes and reports survive app restarts and offline periods.
const db = SQLite.openDatabaseSync('mandoub-outbox.db');
db.execSync(`CREATE TABLE IF NOT EXISTS outbox (
  key TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0
);`);
try { db.execSync('ALTER TABLE outbox ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0'); }
catch { /* already present on a newer install */ }

/*
 * One fix per second is ~86k rows a day. An engineer who stays offline for a week used to come
 * back to a database big enough to make every flush crawl; fixes older than three days can no
 * longer belong to a shift, so they are dropped at startup. Reports are never pruned here —
 * they are the engineer's work, and the report queue is small.
 */
db.runSync("DELETE FROM outbox WHERE kind='location' AND created_at < ?", Date.now() - 3 * 86400000);

export async function createQueue(): Promise<Outbox> {
  return {
    async add(kind: OutboxKind, payload: unknown) {
      const key = outboxKey(kind, payload);
      db.runSync('INSERT OR IGNORE INTO outbox(key,kind,payload,created_at,attempts) VALUES (?,?,?,?,0)', key, kind, JSON.stringify(payload), Date.now());
    },
    async list(limit = 200) {
      // Reports before fixes: an hour of GPS backlog is thousands of rows, and ordering by
      // time alone meant a queued collection report waited behind every one of them. `rowid`
      // breaks same-millisecond ties so an offline check-in is always sent before its check-out.
      const rows = db.getAllSync<{ key: string; kind: string; payload: string; created_at: number; attempts: number; rejected: number }>(
        `SELECT key,kind,payload,created_at,attempts,rejected FROM outbox
         ORDER BY ${OUTBOX_ORDER_BY_SQL} LIMIT ?`, limit);
      return rows.map(row => ({ key: row.key, kind: row.kind as OutboxKind, payload: row.payload, createdAt: row.created_at, attempts: row.attempts, rejected: row.rejected === 1 }));
    },
    async remove(key: string) { db.runSync('DELETE FROM outbox WHERE key=?', key); },
    async bump(key: string) { db.runSync('UPDATE outbox SET attempts=attempts+1 WHERE key=?', key); },
    async reject(key: string) { db.runSync('UPDATE outbox SET rejected=1 WHERE key=?', key); },
    async unreject(key: string) { db.runSync('UPDATE outbox SET rejected=0 WHERE key=?', key); },
    async count(kind?: OutboxKind) {
      if (kind) return db.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM outbox WHERE kind=?', kind)?.c ?? 0;
      return db.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM outbox')?.c ?? 0;
    },
    async clear() { db.runSync('DELETE FROM outbox'); },
  };
}
