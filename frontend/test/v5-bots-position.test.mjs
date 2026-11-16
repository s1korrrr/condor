import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeLots, breakEvenDistance, breakEvenDistanceDetail, exactSignedSum, moneySampleState } from '../src/v5/bots-position-model.mjs';

test('distance uses the close, sign and missing inputs', () => {
  assert.equal(breakEvenDistance('110.000000000000000000000000000001', 100), 'Needs +10.0% to break even');
  assert.equal(breakEvenDistance('90', 100), 'Above breakeven by 11.1%');
  assert.equal(breakEvenDistance('9007199254740993', 9007199254740992), 'Needs 0.0% to break even');
  assert.equal(breakEvenDistance('90', null), '—');
  assert.equal(breakEvenDistance('0', 100), '—');
  assert.deepEqual(breakEvenDistanceDetail('110', 100), { text: 'Needs +10.0% to break even', exact: '(110 − 100) × 100 / 100 = 1000/100% (exact fraction)' });
});
test('money samples follow the five-minute cadence and late is never current', () => {
  const row = { at_ms: 300001, snapshot_at_ms: 300000, unit: 'USDC' };
  assert.deepEqual(moneySampleState(row, 599999), { state:'sample', next:600000 });
  assert.deepEqual(moneySampleState({...row, snapshot_at_ms:302000}, 400000), { state:'sample', next:600000 });
  assert.deepEqual(moneySampleState(row, 600001), { state:'late', next:600000 });
  assert.equal(moneySampleState({...row, gap:'unavailable'}, 400000), null);
  assert.equal(moneySampleState({...row, snapshot_at_ms:1}, 400000), null);
});
test('terminal dust is excluded and money sums exactly', () => {
  const lots = activeLots([{state:'held_reconciliation',protected_exit:true}, {state:'terminal_dust',protected_exit:false}]);
  assert.equal(lots.length, 1);
  assert.equal(exactSignedSum('100000000000000000000.000000000000000000000000000001', '-0.000000000000000000000000000002'), '99999999999999999999.999999999999999999999999999999');
  assert.equal(exactSignedSum('1', null), null);
});
