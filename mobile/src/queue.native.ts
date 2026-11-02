import * as SQLite from 'expo-sqlite';
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

export async function createQueue(): Promise<Outbox> {
  return {
    async add(kind: OutboxKind, payload: unknown) {
      const key = kind === 'location' ? (payload as { id: string }).id : (payload as { id: string }).id;
      db.runSync('INSERT OR IGNORE INTO outbox(key,kind,payload,created_at,attempts) VALUES (?,?,?,?,0)', key, kind, JSON.stringify(payload), Date.now());
    },
    async list(limit = 200) {
      const rows = db.getAllSync<{ key: string; kind: string; payload: string; created_at: number; attempts: number }>(
        'SELECT key,kind,payload,created_at,attempts FROM outbox ORDER BY created_at LIMIT ?', limit);
      return rows.map(row => ({ key: row.key, kind: row.kind as OutboxKind, payload: row.payload, createdAt: row.created_at, attempts: row.attempts }));
    },
    async remove(key: string) { db.runSync('DELETE FROM outbox WHERE key=?', key); },
    async bump(key: string) { db.runSync('UPDATE outbox SET attempts=attempts+1 WHERE key=?', key); },
    async count() {
      return db.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM outbox')?.c ?? 0;
    },
  };
}
