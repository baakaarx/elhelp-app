import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmShiftState } from '../../mobile/src/shiftReconciliation.js';

const wait = async () => {};
test('a failed confirmation never reports an active local shift as closed', async () => {
  const network = Object.assign(new Error('connection lost'), { status: 0 });
  await assert.rejects(confirmShiftState(null, true, async () => { throw network; }, wait), error => error === network);
});

test('closure requires a second successful empty response', async () => {
  assert.deepEqual(await confirmShiftState(null, true, async () => ({ shift: null }), wait), { shift: null, closed: true });
  const shift = { id: 'active' };
  assert.deepEqual(await confirmShiftState(null, true, async () => ({ shift }), wait), { shift, closed: false });
  assert.deepEqual(await confirmShiftState(shift, true, async () => { throw Error('unexpected retry'); }, wait), { shift, closed: false });
  assert.deepEqual(await confirmShiftState(null, false, async () => { throw Error('unexpected retry'); }, wait), { shift: null, closed: false });
});
