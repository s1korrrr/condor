import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { botNet, controllerPnlPart, ownerReadsFingerprint, pairOwnershipIsDisjoint, winRateText } = frontendModules().load('features/bots/bot-net.ts');
test('headline bot net uses only the controller report and never substitutes retained inventory', () => {
  assert.deepEqual(botNet(1.2), { value: 1.2, stale: false, source: 'controller report' });
  assert.deepEqual(botNet(null), { value: null, stale: false, source: null });
  assert.deepEqual(botNet(null, true), { value: null, stale: false, source: null });
});

test('controller realized and unrealized rows stay unavailable when retained pair values exist', () => {
  const reads = { controller: { realized: null, unrealized: null }, quant: { pairs: [{ realized: '4.25', unrealized: '1.50' }] } };
  assert.equal(controllerPnlPart(reads.controller.realized), null);
  assert.equal(controllerPnlPart(reads.controller.unrealized), null);
  assert.equal(Number(reads.quant.pairs[0].realized), 4.25, 'fixture proves a tempting retained-position fallback is present');
  assert.equal(controllerPnlPart(0), 0, 'observed controller zero remains distinct from unavailable');
});

test('owner publication fingerprint changes for same-count PnL, marks, orders and freshness updates', () => {
  const first = { controller: { total: 2 }, quant: { generatedAt: 'same', pairs: [{ markedValue: '100' }] }, view: { orders: [] }, status: 'running' };
  const key = ownerReadsFingerprint(first);
  for (const next of [
    { ...first, controller: { total: 3 } },
    { ...first, quant: { ...first.quant, pairs: [{ markedValue: '105' }] } },
    { ...first, view: { orders: [{ order_id: 'o-1' }] } },
    { ...first, status: 'stale' },
  ]) assert.notEqual(ownerReadsFingerprint(next), key);
  assert.equal(ownerReadsFingerprint(first), key);
});

test('multi-bot PnL requires current, nonempty, disjoint pair ownership', () => {
  assert.equal(pairOwnershipIsDisjoint([{ qualified: true, pairs: ['BTC-USDC'] }, { qualified: true, pairs: ['ETH-USDC'] }]), true);
  assert.equal(pairOwnershipIsDisjoint([{ qualified: true, pairs: ['BTC-USDC'] }, { qualified: true, pairs: ['BTC-USDC'] }]), false);
  assert.equal(pairOwnershipIsDisjoint([{ qualified: true, pairs: ['BTC-USDC'] }, { qualified: false, pairs: [] }]), false);
  assert.equal(pairOwnershipIsDisjoint([{ qualified: true, pairs: [] }, { qualified: true, pairs: ['ETH-USDC'] }]), false);
  assert.equal(pairOwnershipIsDisjoint([{ qualified: true, pairs: ['BTC-USDC'] }, { qualified: true, pairs: ['BNB-USDC, BTC-USDC'] }]), false, 'a multi-pair display label with missing view/quant identities cannot establish disjoint ownership');
  assert.equal(pairOwnershipIsDisjoint([{ qualified: false, pairs: [] }]), true, 'one owner does not need a cross-owner overlap proof');
});

test('win rate waits for the owner minimum sample', () => {
  assert.equal(winRateText({ scored: 2, minSample: 10, winRate: 1 }), '2 of 10 scored');
  assert.equal(winRateText({ scored: 0, minSample: 10, winRate: null }), '0 of 10 scored');
  assert.equal(winRateText({ scored: 12, minSample: 10, winRate: 0.5833 }), '58.3%');
});

test('every contributing metric must declare the same currency', () => {
  const { commonMetricQuote } = frontendModules().load('features/bots/bot-net.ts');
  assert.equal(commonMetricQuote(['USDC']), 'USDC');
  assert.equal(commonMetricQuote(['USDC','USDC']), 'USDC');
  for (const units of [[], ['USDC',null], ['USDC','USDT'], ['unknown'], [''], [undefined]]) {
    assert.equal(commonMetricQuote(units), null);
  }
});

test('below the owner minimum the win-rate text cannot read as a 9-of-10 rate and the sortable value is withheld', () => {
  const { winRateValue } = frontendModules().load('features/bots/bot-net.ts');
  const text = winRateText({ scored: 9, minSample: 10, winRate: 1 });
  assert.doesNotMatch(text, /^9\/10/, '"9/10 cycles" reads as a 90% win rate');
  assert.match(text, /9 of 10 scored/);
  assert.equal(winRateValue({ scored: 9, minSample: 10, winRate: 1 }), null, 'table sort, hover and CSV must not say 100 while the cell says collecting');
  assert.equal(winRateValue({ scored: 12, minSample: 10, winRate: 0.5833 }), 58.3);
  assert.equal(winRateValue({ scored: 12, minSample: 10, winRate: null }), null);
});
