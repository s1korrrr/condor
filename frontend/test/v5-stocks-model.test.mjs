import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureEntry, effectiveState, filterStockRows, fundingApplicable, publicObservation, selectedStock, stockCaptured, stockKey, stockProductLabel, unlistedCapture } from '../src/v5/stocks-model.mjs';

const now = 1793620800000;
const instrument = (instType, instId, extra = {}) => ({ instCategory: '3', instType, instId, ...extra });
const row = (instType, instId, extra = {}) => ({ instrument: instrument(instType, instId), ...extra });

test('filter requires owner equity classification and keeps product identities separate', () => {
  const rows = [row('SPOT', 'EXAMPLE-USDT'), row('SWAP', 'EXAMPLE-USDT-SWAP'), row('FUTURES', 'EXAMPLE-USDT-270101'), { instrument: { instId: 'BTC-USDT', instType: 'SPOT', instCategory: '1' } }, { instrument: { instId: 'EQUITYNAME-USDT', instType: 'SPOT' } }];
  assert.equal(filterStockRows(rows, 'ALL').length, 3);
  assert.deepEqual(filterStockRows(rows, 'FUTURES').map(item => item.instrument.instId), ['EXAMPLE-USDT-270101']);
  assert.notEqual(stockKey('eea', rows[0].instrument), stockKey('global', rows[0].instrument));
  assert.notEqual(stockKey('eea', rows[0].instrument), stockKey('eea', rows[1].instrument));
});

test('selection is restricted to current region and filtered catalog', () => {
  const rows = [row('FUTURES', 'EXAMPLE-USDT-270101'), row('FUTURES', 'OTHER-USDT-270101')];
  assert.equal(selectedStock(rows, 'eea', stockKey('eea', rows[1].instrument)), rows[1]);
  assert.equal(selectedStock(rows, 'eea', stockKey('global', rows[1].instrument)), rows[0]);
  assert.equal(selectedStock([], 'eea', ''), null);
});

test('owner states and an aged view do not become current by client receipt', () => {
  assert.equal(effectiveState({ state: 'live', now: now / 1000 }, false, now), 'live');
  assert.equal(effectiveState({ state: 'live', now: now / 1000 - 91 }, false, now), 'stale');
  assert.equal(effectiveState({ state: 'error', now: now / 1000 }, false, now), 'error');
  assert.equal(effectiveState({ state: 'live', now: now / 1000 }, true, now), 'unavailable');
  assert.equal(effectiveState(null, false, now), 'unavailable');
});

test('failed refresh and broken channels remove retained observations', () => {
  const observation = { data: { last: '123.456789012345678901' } };
  const source = { state: 'live', now: now / 1000, latest: { ticker: observation }, channels: { ticker: { state: 'live' } } };
  assert.equal(publicObservation(source, 'ticker', false, now), observation);
  assert.equal(publicObservation(source, 'ticker', true, now), null);
  assert.equal(publicObservation({ ...source, state: 'error' }, 'ticker', false, now), null);
  for (const state of ['gap', 'error', 'unavailable', 'waiting']) {
    assert.equal(publicObservation({ ...source, channels: { ticker: { state } } }, 'ticker', false, now), null);
  }
  assert.equal(publicObservation({ ...source, channels: { ticker: { state: 'stale' } } }, 'ticker', false, now), observation);
});

test('dated futures are never relabeled perpetual and xperp needs explicit metadata', () => {
  assert.equal(stockProductLabel(instrument('SPOT', 'EXAMPLE-USDT')), 'Spot · tokenized stock');
  assert.equal(stockProductLabel(instrument('SWAP', 'EXAMPLE-USDT-SWAP')), 'Perpetual · SWAP');
  assert.equal(stockProductLabel(instrument('FUTURES', 'EXAMPLE-USDT-270101')), 'Futures');
  assert.equal(stockProductLabel(instrument('FUTURES', 'EXAMPLE-USDT-270101', { ruleType: 'xperp' })), 'X-Perp · FUTURES');
  assert.equal(fundingApplicable(instrument('SPOT', 'EXAMPLE-USDT')), false);
  assert.equal(fundingApplicable(instrument('FUTURES', 'EXAMPLE-USDT-270101')), false);
  assert.equal(fundingApplicable(instrument('FUTURES', 'EXAMPLE-USDT-270101', { ruleType: 'xperp' })), true);
  assert.equal(fundingApplicable(instrument('SWAP', 'EXAMPLE-USDT-SWAP')), true);
});

test('capture helpers use the exact collector allowlist entry and only an explicit true flag', () => {
  assert.equal(captureEntry('eea', instrument('SWAP', 'AAPL-USDT-SWAP')), 'eea:SWAP:AAPL-USDT-SWAP');
  assert.equal(captureEntry('global', { instType: 'FUTURES', instId: 'XBRK.B-USDT-270101' }), 'global:FUTURES:XBRK.B-USDT-270101');
  assert.equal(stockCaptured({ captured: true }), true);
  for (const value of [false, undefined, 'true', 1]) assert.equal(stockCaptured({ captured: value }), false);
  assert.equal(stockCaptured(null), false);
  const capture = [{ instType: 'SPOT', instId: 'A-USDT', listed: true }, { instType: 'SWAP', instId: 'B-USDT-SWAP', listed: false }];
  assert.deepEqual(unlistedCapture({ capture }), [capture[1]]);
  assert.deepEqual(unlistedCapture({ capture: [] }), []);
  assert.deepEqual(unlistedCapture(null), []);
});
