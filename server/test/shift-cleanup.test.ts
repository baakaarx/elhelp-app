import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/db.js';

/**
 * A shift nobody stopped is closed by the hourly cleanup once it has no fixes for 18 hours.
 *
 * The lookup used the representative's newest fix *anywhere*, so a shift left open last week was
 * invisible to that rule as long as the same engineer was still driving on a newer shift: the
 * manager's board kept showing an open shift from days ago, and the app re-attached to it.
 */
const HOUR = 3600000;

test('a forgotten shift is closed even when the engineer has newer fixes on another shift', () => {
  const store = new Store(':memory:');
  const userId = randomUUID();
  store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
    userId, 'مهندس', `stale.${Date.now()}@test`, 'x', 'rep', Date.now() - 72 * HOUR);
  const now = Date.now();

  // Last week's shift: opened, never used, never closed.
  const staleShift = randomUUID();
  store.run('INSERT INTO shifts(id,user_id,started_at,ended_at,consent_version,consent_at) VALUES (?,?,?,NULL,?,?)',
    staleShift, userId, now - 60 * HOUR, '1.0', now - 60 * HOUR);

  // Yesterday's shift: the engineer really drove, and the last fix is an hour old.
  const freshShift = randomUUID();
  store.run('INSERT INTO shifts(id,user_id,started_at,ended_at,consent_version,consent_at) VALUES (?,?,?,NULL,?,?)',
    freshShift, userId, now - 3 * HOUR, '1.0', now - 3 * HOUR);
  store.run(`INSERT INTO locations(point_id,user_id,shift_id,lat,lng,accuracy,speed,heading,battery,recorded_at,received_at,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(), userId, freshShift, 31.2, 29.9, 8, null, null, null, now - HOUR, now - HOUR, 'gps');

  store.cleanup(365);

  const stale = store.get('SELECT ended_at FROM shifts WHERE id=?', staleShift) as { ended_at: number | null };
  assert.ok(stale.ended_at, 'the forgotten shift must be closed');
  assert.equal(Number(stale.ended_at), now - 60 * HOUR, 'and it ends where it started, not at the newer fix');
  const fresh = store.get('SELECT ended_at FROM shifts WHERE id=?', freshShift) as { ended_at: number | null };
  assert.equal(fresh.ended_at, null, 'a shift with a fix an hour ago is still running');
  store.close();
});

test('a shift with old fixes of its own ends at its last fix', () => {
  const store = new Store(':memory:');
  const userId = randomUUID();
  store.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
    userId, 'مهندس', `olds.${Date.now()}@test`, 'x', 'rep', Date.now() - 72 * HOUR);
  const now = Date.now();
  const shiftId = randomUUID();
  store.run('INSERT INTO shifts(id,user_id,started_at,ended_at,consent_version,consent_at) VALUES (?,?,?,NULL,?,?)',
    shiftId, userId, now - 30 * HOUR, '1.0', now - 30 * HOUR);
  store.run(`INSERT INTO locations(point_id,user_id,shift_id,lat,lng,accuracy,speed,heading,battery,recorded_at,received_at,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(), userId, shiftId, 31.2, 29.9, 8, null, null, null, now - 25 * HOUR, now - 25 * HOUR, 'gps');
  store.cleanup(365);
  const row = store.get('SELECT ended_at FROM shifts WHERE id=?', shiftId) as { ended_at: number | null };
  assert.equal(Number(row.ended_at), now - 25 * HOUR, 'the shift ends at its own last fix');
  store.close();
});
