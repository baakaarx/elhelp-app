import * as SQLite from 'expo-sqlite';
import { outboxKey } from './outboxKey';
import type { Outbox } from './queue';
import type { OutboxItem, OutboxKind } from './types';

// A durable outbox: GPS fixes and reports survive app restarts and offline periods.
const db = SQLite.openDatabaseSync('mandoub-outbox.db');
db.execSync(`CREATE TABLE IF NOT EXISTS outbox (
  key TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);`);

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
      // time alone meant a queued collection report waited behind every one of them.
      const rows = db.getAllSync<{ key: string; kind: string; payload: string; created_at: number; attempts: number }>(
        `SELECT key,kind,payload,created_at,attempts FROM outbox
         ORDER BY CASE WHEN kind='location' THEN 1 ELSE 0 END, created_at LIMIT ?`, limit);
      return rows.map(row => ({ key: row.key, kind: row.kind as OutboxKind, payload: row.payload, createdAt: row.created_at, attempts: row.attempts }));
    },
    async remove(key: string) { db.runSync('DELETE FROM outbox WHERE key=?', key); },
    async bump(key: string) { db.runSync('UPDATE outbox SET attempts=attempts+1 WHERE key=?', key); },
    async count() {
      return db.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM outbox')?.c ?? 0;
    },
    async clear() { db.runSync('DELETE FROM outbox'); },
  };
}
