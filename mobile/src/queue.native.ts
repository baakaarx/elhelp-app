import * as SQLite from 'expo-sqlite';
import { assertSameQueuedAction, outboxKey } from './outboxKey';
import { OUTBOX_ORDER_BY_SQL } from './queueOrder';
import { initializeNativeOutbox, nativeLocationReplaySql } from './nativeOutboxSchema';
import type { Outbox } from './queue';
import type { OutboxItem, OutboxKind } from './types';

// A durable outbox: GPS fixes and reports survive app restarts and offline periods.
const db = SQLite.openDatabaseSync('mandoub-outbox.db');
initializeNativeOutbox(db);

// Never discard unsent fixes by age. The server verifies shift and retention boundaries;
// fixes it cannot accept stay on the phone for review instead of silently disappearing.

export async function createQueue(): Promise<Outbox> {
  return {
    async add(kind: OutboxKind, payload: unknown) {
      const key = outboxKey(kind, payload);
      const serialized = JSON.stringify(payload);
      const inserted = db.runSync('INSERT OR IGNORE INTO outbox(key,kind,payload,created_at,attempts) VALUES (?,?,?,?,0)', key, kind, serialized, Date.now());
      if (!inserted.changes) {
        const existing = db.getFirstSync<{ kind: string; payload: string }>('SELECT kind,payload FROM outbox WHERE key=?', key);
        if (!existing) throw new Error('تعذر التأكد من حفظ الطلب في قائمة المزامنة.');
        assertSameQueuedAction(existing, kind, serialized);
      }
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
    async listForReplay(locationLimit = 200, includeRejectedLocations = false) {
      // Keep rejected check-ins in the same ordered action stream as their dependent check-outs
      // and orders. A fixed overall limit lets rejected rows block all later work forever.
      const query = (where: string, ...params: number[]) => db.getAllSync<{ key: string; kind: string; payload: string; created_at: number; attempts: number; rejected: number }>(
        `SELECT key,kind,payload,created_at,attempts,rejected FROM outbox WHERE ${where} ORDER BY created_at, rowid`, ...params);
      const actions = query("kind<>'location'");
      const points = db.getAllSync<{ key: string; kind: string; payload: string; created_at: number; attempts: number; rejected: number }>(
        nativeLocationReplaySql(includeRejectedLocations), locationLimit);
      return [...actions, ...points].map(row => ({ key: row.key, kind: row.kind as OutboxKind, payload: row.payload, createdAt: row.created_at, attempts: row.attempts, rejected: row.rejected === 1 }));
    },
    async countRejectedLocations() { return db.getFirstSync<{ c: number }>("SELECT COUNT(*) AS c FROM outbox WHERE kind='location' AND rejected=1")?.c ?? 0; },
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
