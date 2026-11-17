import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { OUTBOX_ORDER_BY_SQL } from '../../mobile/src/queueOrder.js';

test('the native SQLite outbox keeps same-millisecond check-in before check-out and sends visits ahead of GPS', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE outbox (key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)');
    const add = db.prepare('INSERT INTO outbox(key, kind, payload, created_at) VALUES (?, ?, ?, ?)');
    add.run('gps-old', 'location', '{}', 100);
    add.run('checkin', 'visit-checkin', '{}', 200);
    add.run('checkout', 'visit-checkout', '{}', 200);

    const ordered = db.prepare(`SELECT key FROM outbox ORDER BY ${OUTBOX_ORDER_BY_SQL}`).all() as Array<{ key: string }>;
    assert.deepEqual(ordered.map(row => row.key), ['checkin', 'checkout', 'gps-old']);
  } finally { db.close(); }
});
