import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as helm from '../src/v5/helm-model.mjs';

const nowS = 1793929900;
const signal = (extra = {}) => ({
  at: nowS - 10, candle_open: nowS - 60, close: '643.1',
  rsi: '41.2', previous_rsi: '28.8', rsi_length: 17, oversold: '29',
  atr_fraction: '0.001', atr_length: 14, min_atr_fraction: '.0002', max_atr_fraction: '.01',
  decision: { enter: true, reason: 'rsi_rebound' }, ...extra,
});
const coin = (published = signal(), extra = {}) => ({
  pair: 'BNB-USDC', signal: published, status: 'portfolio_grant_required', candidate_hold: 'no_rebound',
  bag: { held_amount: '0', breakeven_price: '0' }, ...extra,
});
const row = (published = signal(), options = {}, extra = {}) => helm.helmCoinRow(coin(published, extra), { fresh: true, nowS, ...options });

test('published signal uses owner parameters, exact distance, decision and its own UTC evaluation clock', () => {
  const shown = row();
  assert.equal(shown.rule, 'Buys when RSI(17) crosses up through 29');
  assert.equal(shown.rsi, 'RSI 41.2, 12.2 points above the line');
  assert.equal(shown.atr, 'ATR(14)/close 0.001, inside the 0.0002–0.01 band');
  assert.equal(shown.decision, 'Entry signal: yes · Helm: rsi rebound');
  assert.equal(shown.sample, '6 Nov 01:51 UTC · 10 s ago');
  assert.equal(shown.held, '—');
  assert.equal(shown.breakeven, '—');
  assert.equal(shown.bagNote, 'Nothing held');
  assert.equal(row(signal({ rsi_length: 21, oversold: '30.500' })).rule, 'Buys when RSI(21) crosses up through 30.5');
});

test('unpublished signal has no invented parameters or decision and still shows a published bag', () => {
  const shown = row(null, {}, { bag: { held_amount: '0.123456789012345678901234567890', breakeven_price: '640.000000000000000000000000000001' } });
  assert.equal(shown.signalPublished, false);
  for (const cell of ['rule', 'rsi', 'atr', 'decision', 'sample']) assert.equal(shown[cell], '—', cell);
  assert.equal(shown.held, '0.123457 BNB');
  assert.equal(shown.breakeven, '640.00');
});

test('a stale Helm read withholds signal numbers and holdings but keeps the signal time and age', () => {
  const shown = row(signal(), { fresh: false }, { bag: { held_amount: '2', breakeven_price: '640' } });
  assert.equal(shown.rule, 'Rule unavailable · Helm status is stale');
  assert.equal(shown.rsi, '— · Helm status is stale');
  assert.equal(shown.atr, '— · Helm status is stale');
  assert.equal(shown.decision, '— · Helm status is stale');
  assert.equal(shown.sample, '6 Nov 01:51 UTC · 10 s ago · stale');
  assert.equal(shown.held, '—');
  assert.equal(shown.breakeven, '—');
  assert.equal(shown.bagNote, 'Helm status is stale');
  assert.doesNotMatch(shown.owner, /portfolio grant|no rebound/);
});

test('old, missing and future evaluation clocks cannot make a fresh status contain a current signal', () => {
  assert.equal(row(signal({ at: nowS - 31 })).rsi, '— · Signal is stale');
  assert.match(row(signal({ at: nowS - 31 })).sample, /31 s ago · stale/);
  assert.equal(row(signal({ at: null })).rsi, '— · Signal time not published');
  assert.equal(row(signal({ at: nowS + 1 })).rsi, '— · Signal time is in the future');
  assert.doesNotMatch(row(signal({ at: nowS + 1 })).sample, /0 s ago/);
  assert.match(row(signal({ at: nowS - 30 })).rsi, /^RSI 41.2/);
});

for (const reason of ['rsi_rebound', 'no_rebound', 'low_volatility', 'high_volatility', 'atr_unavailable', 'no_turn', 'score_below_minimum', 'no_breakout', 'future_owner_reason']) {
  test(`decision reason stays the engine's words: ${reason}`, () => {
    assert.equal(row(signal({ decision: { enter: false, reason } })).decision, `Entry signal: no · Helm: ${reason.replaceAll('_', ' ')}`);
  });
}

test('missing decision fields do not become a negative decision', () => {
  assert.equal(row(signal({ decision: null })).decision, '— · Entry decision not published');
  assert.equal(row(signal({ decision: { enter: null, reason: 'no_rebound' } })).decision, '— · Entry decision not published');
  assert.equal(row(signal({ decision: { enter: true, reason: null } })).decision, '— · Entry decision not published');
});

for (const [value, place] of [['.0001', 'below'], ['.0002', 'inside'], ['.001', 'inside'], ['.01', 'inside'], ['.02', 'above']]) {
  test(`ATR ${value} is ${place} the published band, including boundaries`, () => {
    assert.equal(row(signal({ atr_fraction: value })).atr, `ATR(14)/close 0${value}, ${place} the 0.0002–0.01 band`);
  });
}

test('missing ATR, missing band and invalid band stay unknown without inferred volatility', () => {
  assert.equal(row(signal({ atr_fraction: null })).atr, '— · ATR not published by Helm');
  assert.equal(row(signal({ min_atr_fraction: null })).atr, '— · ATR band not published by Helm');
  assert.equal(row(signal({ max_atr_fraction: null })).atr, '— · ATR band not published by Helm');
  assert.equal(row(signal({ atr_length: null })).atr, '— · ATR length not published by Helm');
  assert.equal(row(signal({ min_atr_fraction: '.02' })).atr, '— · ATR band is invalid');
});

test('RSI below or on the line needs a rise, never a back-solved price or inferred buy', () => {
  assert.equal(row(signal({ rsi: '28.5' })).rsi, 'RSI 28.5, 0.5 points below the line: a buy needs RSI to rise above 29');
  assert.equal(row(signal({ rsi: '29.000' })).rsi, 'RSI 29, on the line: a buy needs RSI to rise above 29');
  assert.equal(row(signal({ rsi: null })).rsi, '— · RSI or line not published by Helm');
  assert.equal(row(signal({ oversold: null })).rsi, '— · RSI or line not published by Helm');
  assert.equal(row(signal({ rsi_length: null })).rule, 'Rule not published by Helm');
});

test('RSI distances and ATR comparisons retain all thirty decimal places without floating point', () => {
  assert.equal(row(signal({ rsi: '29.000000000000000000000000000001' })).rsi, 'RSI 29, 0 points above the line');
  assert.equal(row(signal({ rsi: '28.999999999999999999999999999999' })).rsi, 'RSI 29, 0 points below the line: a buy needs RSI to rise above 29');
  assert.match(row(signal({ atr_fraction: '0.010000000000000000000000000001' })).atr, /above the/);
  assert.match(row(signal({ atr_fraction: '0.000199999999999999999999999999' })).atr, /below the/);
});

test('signal ages use shared whole units and holdings carry the base asset', () => {
  assert.equal(row(signal({ at: nowS - 180 })).sample, '6 Nov 01:48 UTC · 3 min ago · stale');
  const shown = row(signal(), {}, { pair: 'BTC-USDC', bag: { held_amount: '0.000000000000000000000000000001', breakeven_price: '123456.78' } });
  assert.equal(shown.held, '0 BTC');
  assert.equal(shown.breakeven, '123,457');
});

test('missing bags and incomplete breakevens have a reason, zero bags have no invented price', () => {
  assert.equal(row(signal(), {}, { bag: null }).bagNote, 'Bag not published by Helm');
  assert.equal(row(signal(), {}, { bag: { held_amount: null, breakeven_price: '640' } }).breakeven, '—');
  assert.equal(row(signal(), {}, { bag: { held_amount: '2', breakeven_price: null } }).bagNote, 'Breakeven not published by Helm');
  assert.equal(row(signal(), {}, { bag: { held_amount: '0.000', breakeven_price: '640' } }).breakeven, '—');
});

const NONE = 'Helm does not publish its buy rule or signal values; the state and hold reason below are Helm\'s own';

test('the unpublished-signal note is one table-level sentence, and only for coins without a signal', () => {
  const rows = (...signals) => signals.map((published, index) => helm.helmCoinRow(coin(published, { pair: `C${index}-USDC` }), { fresh: true, nowS }));
  assert.equal(helm.helmCoinsNote(rows(null, null, null)), NONE);
  assert.equal(helm.helmCoinsNote(rows(signal(), signal())), null);
  assert.equal(helm.helmCoinsNote([]), null);
  assert.equal(helm.helmCoinsNote(rows(signal(), null)), 'A — means Helm has not published that coin\'s buy rule or signal values.');
});

test('a coin whose signal is published still shows every published value beside an unpublished coin', () => {
  const [published, missing] = [signal(), null].map(value => helm.helmCoinRow(coin(value), { fresh: true, nowS }));
  assert.equal(published.signalPublished, true);
  assert.equal(published.rule, 'Buys when RSI(17) crosses up through 29');
  assert.equal(published.rsi, 'RSI 41.2, 12.2 points above the line');
  assert.equal(missing.rule, '—');
  assert.equal(JSON.stringify(missing).match(/not published/g), null);
});
