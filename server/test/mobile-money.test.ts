import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoneyText } from '../../mobile/src/format';

test('field money input preserves Arabic decimals and rejects ambiguous or over-precise amounts', () => {
  for (const [input, expected] of [['٥٠٠',500], ['١٫٥٠',1.5], ['1,234.50',1234.5], ['۱٬۲۳۴٫۵۰',1234.5], ['0',0], ['1.2300',1.23]] as const)
    assert.equal(parseMoneyText(input), expected, input);
  for (const input of ['', '1,5', '١،٥', '1,23', '1.001', '0.000001', '1e2', '-1', '1000000001', '1 500'])
    assert.equal(parseMoneyText(input), null, input);
});
