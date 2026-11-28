import * as SQLite from 'expo-sqlite';
import { assertSameQueuedAction, outboxKey } from './outboxKey';
import { outboxOwnership } from './outboxOwnership';
import { OUTBOX_ORDER_BY_SQL } from './queueOrder';
import { initializeNativeOutbox, nativeLocationReplaySql } from './nativeOutboxSchema';
import type { Outbox } from './queue';
import type { OutboxItem, OutboxKind } from './types';

// A durable outbox: GPS fixes and reports survive app restarts and offline periods.
const db = SQLite.openDatabaseSync('mandoub-outbox.db');
initializeNativeOutbox(db);

// Never discard unsent fixes by age. The server verifies shift and retention boundaries;
// fixes it cannot accept stay on the phone for review instead of silently disappearing.

function replayItems(locationLimit: number, includeRejectedLocations: boolean): OutboxItem[] {
  const query = (where: string) => db.getAllSync<{ key:string; kind:string; payload:string; created_at:number; attempts:number; rejected:number }>(
    `SELECT key,kind,payload,created_at,attempts,rejected FROM outbox WHERE ${where} ORDER BY created_at, rowid`);
  const points = db.getAllSync<{ key:string; kind:string; payload:string; created_at:number; attempts:number; rejected:number }>(nativeLocationReplaySql(includeRejectedLocations), locationLimit);
  return [...query("kind<>'location'"), ...points].map(row => ({key:row.key,kind:row.kind as OutboxKind,payload:row.payload,createdAt:row.created_at,attempts:row.attempts,rejected:row.rejected===1}));
}
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
    async addOwned(kind: OutboxKind, payload: unknown, owner: string, legacyOwner: string | null) {
      const key = outboxKey(kind, payload), serialized = JSON.stringify(payload);
      // Synchronous SQLite transaction also serializes a separate headless task's connection.
      db.withTransactionSync(() => {
        const count = db.getFirstSync<{c:number}>('SELECT COUNT(*) AS c FROM outbox')?.c ?? 0;
        const saved = db.getFirstSync<{value:string}>("SELECT value FROM outbox_metadata WHERE key='owner'")?.value ?? legacyOwner;
        const ownership = outboxOwnership(saved, owner, count);
        if (!ownership.allowed) throw new Error(`${ownership.notice || 'لا يمكن إضافة البيانات إلى قائمة المزامنة الحالية.'} لم يُحفظ الطلب الجديد.`);
        if (!count || !db.getFirstSync("SELECT value FROM outbox_metadata WHERE key='owner'"))
          db.runSync("INSERT INTO outbox_metadata(key,value) VALUES('owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", owner);
        const inserted = db.runSync('INSERT OR IGNORE INTO outbox(key,kind,payload,created_at,attempts) VALUES (?,?,?,?,0)', key, kind, serialized, Date.now());
        if (!inserted.changes) {
          const existing = db.getFirstSync<{kind:string;payload:string}>('SELECT kind,payload FROM outbox WHERE key=?',key);
          if (!existing) throw new Error('تعذر التأكد من حفظ الطلب في قائمة المزامنة.');
          assertSameQueuedAction(existing, kind, serialized);
        }
      });
    },
    async owner(legacyOwner: string | null) { return db.getFirstSync<{value:string}>("SELECT value FROM outbox_metadata WHERE key='owner'")?.value ?? legacyOwner; },
    async snapshot(legacyOwner: string | null, locationLimit = 200, includeRejectedLocations = false) {
      let result!: {owner: string | null; count: number; items: OutboxItem[]};
      db.withTransactionSync(() => { result = {
        owner: db.getFirstSync<{value:string}>("SELECT value FROM outbox_metadata WHERE key='owner'")?.value ?? legacyOwner,
        count: db.getFirstSync<{c:number}>('SELECT COUNT(*) AS c FROM outbox')?.c ?? 0,
        items: replayItems(locationLimit, includeRejectedLocations),
      }; });
      return result;
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
      return replayItems(locationLimit, includeRejectedLocations);
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
    async clearOwned(owner: string, legacyOwner: string | null) {
      let cleared = false;
      db.withTransactionSync(() => {
        const count = db.getFirstSync<{c:number}>('SELECT COUNT(*) AS c FROM outbox')?.c ?? 0;
        const saved = db.getFirstSync<{value:string}>("SELECT value FROM outbox_metadata WHERE key='owner'")?.value ?? legacyOwner;
        if (!count || saved === owner) { db.runSync('DELETE FROM outbox'); cleared = true; }
      });
      return cleared;
    },
  };
}
