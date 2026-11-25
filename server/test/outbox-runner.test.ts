import assert from 'node:assert/strict';
import test from 'node:test';
import { createOutboxRunner } from '../../mobile/src/outboxRunner.js';

test('manual sync waits for automatic sync and still retries rejected work', async () => {
  const run = createOutboxRunner<string>();
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const automatic = run('rep:auto', async () => { calls.push('auto'); await gate; return 'auto'; });
  const duplicate = run('rep:auto', async () => { throw new Error('duplicate should not run'); });
  const manual = run('rep:manual', async () => { calls.push('manual'); return 'manual'; });
  await Promise.resolve();
  assert.deepEqual(calls, ['auto']);
  assert.equal(automatic, duplicate);
  release();
  assert.deepEqual(await Promise.all([automatic, duplicate, manual]), ['auto', 'auto', 'manual']);
  assert.deepEqual(calls, ['auto', 'manual']);
});

test('a failed sync does not block the next attempt or other accounts', async () => {
  const run = createOutboxRunner<string>();
  const first = run('rep:auto', async () => { throw new Error('offline'); });
  const next = run('other:auto', async () => 'done');
  await assert.rejects(first, /offline/);
  assert.equal(await next, 'done');
  assert.equal(await run('rep:auto', async () => 'recovered'), 'recovered');
});
