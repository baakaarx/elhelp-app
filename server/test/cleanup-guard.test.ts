import assert from 'node:assert/strict';
import test from 'node:test';
import { runCleanup, Store } from '../src/db.js';

/**
 * The nightly sweep must not be able to take the installation down with it.
 *
 * It runs inside `setInterval`, where a thrown error is an uncaught exception: Node prints it and
 * exits. One bad sweep — a full disk, a write lock held past the busy timeout — used to mean the
 * server was gone until somebody noticed, and nobody notices at three in the morning.
 */
test('a failing sweep is logged and swallowed', (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  const broken = { cleanup() { throw new Error('SQLITE_FULL: database or disk is full'); } };
  assert.equal(runCleanup(broken, 365), false);
  assert.equal(logged.length, 1, 'the failure is reported, not hidden');
  assert.match(String((logged[0] as unknown[])[0]), /cleanup/);
});

test('a working sweep still runs and says so', () => {
  const calls: number[] = [];
  assert.equal(runCleanup({ cleanup: (days: number) => { calls.push(days); } }, 365), true);
  assert.deepEqual(calls, [365]);
});

test('the real store survives being swept twice', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(runCleanup(store, 365), true);
    assert.equal(runCleanup(store, 365), true);
  } finally { store.close(); }
});
