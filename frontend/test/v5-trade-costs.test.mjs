import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import * as tradesModel from '../src/v5/trades-model.mjs';
import { ownerDisplay } from '../src/v5/format.mjs';
import { frontendModules } from './helpers/frontend-module.mjs';

const receipt = change => ({
  accounting_owner: 'executor',
  entry_gross_base: '4', entry_gross_quote: '70',
  exit_gross_base: '2', exit_gross_quote: '60', fees_quote: '9.99',
  remaining_owned_base: '2', residual_dust_base: '0', ...change,
});
const executor = (change = {}, row = {}) => ({
  executor_id: 'cost-trade', terminal: false, realized_pnl_quote: '10',
  cum_fees_quote: '1.25', custom_info: { execution_receipt: receipt(change) }, ...row,
});
const costs = (change, row) => tradesModel.tradeCosts(executor(change, row));
const liveShape = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/v5-trade-costs-live-shape.json', import.meta.url)));

test('unequal-price partial fills use gross totals for VWAP, never the equal price average', () => {
  const fills = [
    { side: 'BUY', quantity: '1', price: '10' }, { side: 'BUY', quantity: '3', price: '20' },
    { side: 'SELL', quantity: '0.5', price: '15' }, { side: 'SELL', quantity: '1.5', price: '35' },
  ].map((fill, index) => ({ ...fill, executor_id: 'cost-trade', order_id: `order-${index}`, trade_id: `fill-${index}` }));
  const value = tradesModel.tradeCosts(tradesModel.groupTrades([executor()], [], fills)[0]);
  assert.equal(value.grossEntryCost, '70');
  assert.equal(value.grossSaleProceeds, '60');
  assert.equal(value.averageEntryPrice.value, '17.5');
  assert.equal(value.averageExitPrice.value, '30');
  assert.match(value.averageEntryPrice.exact, /70 \/ 4 = 17\.5/);
  assert.notEqual(value.averageEntryPrice.value, '15');
  assert.notEqual(value.averageExitPrice.value, '25');
});

test('zero entry denominators are unavailable; a zero exit denominator is not sold', () => {
  for (const change of [{ entry_gross_base: '0' }, { entry_gross_quote: '0' }]) {
    const value = costs(change);
    assert.equal(value.grossEntryCost, null);
    assert.equal(value.averageEntryPrice, null);
    assert.equal(value.realizedReturn, null);
  }
  const value = costs({ exit_gross_base: '0', exit_gross_quote: '0' });
  assert.equal(value.averageExitPrice, null);
  assert.equal(value.notSold, true);
});

test('high-precision receipt totals and terminating quotients stay exact beyond Number precision', () => {
  const value = costs({ entry_gross_base: '0.000000000000000003', entry_gross_quote: '100000000000000000000.000000000002' });
  assert.equal(value.grossEntryCost, '100000000000000000000.000000000002');
  assert.equal(value.averageEntryPrice.value, '33333333333333333333333333333334000000');
  assert.equal(value.averageEntryPrice.rounded, false);
  assert.match(value.averageEntryPrice.exact, /100000000000000000000\.000000000002 \/ 0\.000000000000000003/);
});

test('repeating decimals carry the exact source ratio and shared rounded-title wording', () => {
  const value = costs({ entry_gross_base: '3', entry_gross_quote: '1' });
  assert.equal(value.averageEntryPrice.rounded, true);
  assert.match(value.averageEntryPrice.exact, /1 \/ 3 = ≈ 0\.3333 \(rounded\)/);
  assert.equal(ownerDisplay(value.averageEntryPrice.value, 'price').text, '0.3333');
  const boundary = costs({ entry_gross_base: '300000', entry_gross_quote: '370334' });
  assert.equal(ownerDisplay(boundary.averageEntryPrice.value, 'price').text, '1.2344');
  const bucket = costs({ entry_gross_base: '3000', entry_gross_quote: '2999999' });
  assert.equal(ownerDisplay(bucket.averageEntryPrice.value, 'price').text, '1,000.00');
});

test('active executor and terminal history share the same closed receipt return without a terminal flag', () => {
  const row = executor({ remaining_owned_base: '0' });
  const active = tradesModel.groupTrades([row], [], [])[0];
  const history = tradesModel.groupTrades([], [row], [])[0];
  assert.notEqual(tradesModel.tradeCosts(active).realizedReturn, null);
  assert.deepEqual(tradesModel.tradeCosts(active), tradesModel.tradeCosts(history));
  assert.deepEqual(tradesModel.tradeCosts(active), tradesModel.tradeCosts({ ...row, terminal: true }));
});

test('live-shaped exponent zero closes an executor-owned receipt with known PnL', () => {
  const value = costs(liveShape.closed_executor, { realized_pnl_quote: liveShape.realized_pnl_quote });
  assert.equal(value.grossEntryCost, '99.700523000');
  assert.equal(value.realizedReturn?.value, '10');
  assert.equal(value.realizedReturn?.exact, '9.970052300 / 99.700523000 × 100 = 10%');
});

test('receipt exponent amounts and residual dust parse exactly without Number precision loss', () => {
  for (const dust of ['1E-7', '6E-7']) {
    const value = costs({ residual_dust_base: dust });
    assert.equal(value.averageEntryPrice?.value, '17.5');
    assert.equal(tradesModel.lotBreakeven(dust, '1'), dust === '1E-7' ? '0.000000100000' : '0.000000600000');
  }
  assert.equal(tradesModel.lotBreakeven('9007199254740993E-7', '1'), '900719925.474099300000');
  assert.equal(tradesModel.lotBreakeven('1E+2', '00.1'), '1000.000000000000');
});

test('each receipt numeric field accepts bounded exponent and leading-zero owner decimals', () => {
  for (const key of ['entry_gross_base', 'entry_gross_quote', 'exit_gross_base', 'exit_gross_quote', 'fees_quote', 'remaining_owned_base', 'residual_dust_base']) {
    for (const valid of ['1E-7', '6E-7', '1e+2', '00.1', '1E-64', '1E+64', '1e-0008', `${'0'.repeat(124)}1E0`]) {
      assert.notEqual(costs({ [key]: valid }).grossEntryCost, null, `${key}: ${valid}`);
    }
  }
});

test('boss held-position sample has exact 641.78 entry and keeps pooled-owner limits', () => {
  const value = costs(liveShape.held_position);
  assert.equal(value.averageEntryPrice?.value, '641.78');
  assert.equal(value.averageEntryPrice?.rounded, false);
  assert.equal(value.averageEntryPrice?.exact, '99.700523000 / 0.1553500 = 641.78');
  for (const key of ['grossSaleProceeds', 'averageExitPrice', 'realizedReturn']) assert.equal(value[key], null);
});

test('missing receipt is unavailable, never a fabricated zero; fees remain owner supplied', () => {
  const value = tradesModel.tradeCosts(executor({}, { custom_info: {} }));
  for (const key of ['grossEntryCost', 'grossSaleProceeds', 'averageEntryPrice', 'averageExitPrice', 'realizedReturn']) assert.equal(value[key], null);
  assert.equal(value.feesQuote, '1.25');
});

test('held and other pooled owners withhold exit VWAP, proceeds and return', () => {
  for (const accounting_owner of ['held_position', 'future_pool', '']) {
    const value = costs({ accounting_owner, remaining_owned_base: '0' }, { terminal: true });
    assert.equal(value.grossEntryCost, '70');
    assert.equal(value.averageEntryPrice.value, '17.5');
    for (const key of ['averageExitPrice', 'grossSaleProceeds', 'realizedReturn']) assert.equal(value[key], null);
    assert.match(value.reason, /recovery sales are allocated across held bags.*not reflected in this executor's receipt/i);
  }
});

test('only a fully closed direct executor with known owner PnL shows realized return', () => {
  const closed = { remaining_owned_base: '0', exit_gross_base: '4', exit_gross_quote: '80' };
  const value = costs(closed, { terminal: true });
  assert.equal(ownerDisplay(value.realizedReturn.value, 'pct').text, '+14.29%');
  assert.match(value.realizedReturn.exact, /10 \/ 70 × 100 = ≈ 14\.2857 % \(rounded\)/);
  assert.equal(value.feesQuote, '1.25');
  assert.equal(value.grossEntryCost, '70');
  assert.equal(value.grossSaleProceeds, '80');
  assert.deepEqual(costs(closed, { terminal: false }).realizedReturn, value.realizedReturn);
  assert.deepEqual(costs(closed, { realized_pnl_quote: '1e1' }).realizedReturn, { ...value.realizedReturn, exact: '1e1 / 70 × 100 = ≈ 14.2857 % (rounded)' });
  for (const row of [{ realized_pnl_quote: null }, { realized_pnl_quote: 10 }, { realized_pnl_quote: 'NaN' }, { realized_pnl_quote: '1e65' }]) assert.equal(costs(closed, row).realizedReturn, null);
  assert.equal(costs({}, { terminal: true }).realizedReturn, null);
  assert.equal(costs(closed, { terminal: true, realized_pnl_quote: '-7' }).realizedReturn.value, '-10');
  assert.equal(costs(closed, { terminal: true, realized_pnl_quote: '0' }).realizedReturn.value, '0');
});

test('every consumed receipt field rejects negative, nonfinite, JSON number, unbounded exponent and bad shape', () => {
  for (const key of ['entry_gross_base', 'entry_gross_quote', 'exit_gross_base', 'exit_gross_quote', 'fees_quote', 'remaining_owned_base', 'residual_dust_base']) {
    for (const invalid of ['-1', '-0E-8', 'NaN', 'Infinity', 1, null, '', ' 1', '1.', '.1', '1\n', '1e65', '1e-65', '0e999999999', '1e', '1E+-2', '1'.repeat(129)]) {
      const value = costs({ [key]: invalid });
      assert.equal(value.grossEntryCost, null, `${key}: ${JSON.stringify(invalid)}`);
      assert.equal(value.averageEntryPrice, null);
    }
  }
  for (const invalid of [[], 'receipt', 1, null, {}]) assert.equal(tradesModel.tradeCosts(executor({}, { custom_info: { execution_receipt: invalid } })).grossEntryCost, null);
  assert.equal(costs({ accounting_owner: 1 }).grossEntryCost, null);
});

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));

async function detail(row, fromHistory = false) {
  const sections = Object.fromEntries(['status', 'executors', 'fills', 'positions', 'wallet', 'history', 'accounting'].map(section => [section, fixture(section)]));
  const record = { ...sections.executors.data[0], ...row };
  sections.executors.data = fromHistory ? [] : [record];
  sections.fills.data = [];
  sections.history.data.terminal_executors = { completeness: 'complete', capabilities: ['read'], data: { delivery: 'publication_pages', records: fromHistory ? [record] : [], publication_record_count: fromHistory ? 1 : 0 } };
  const { TradesContent } = frontendModules({
    './paper-candles': { usePaperCandleSymbols: () => ({}), hasPaperCandlePair: () => false, paperCandleQuery: () => ({}) },
    '@tanstack/react-query': { useQuery: () => ({}) },
    './PaperPriceChart': { PaperPriceChart: () => null },
  }).load('v5/V5Trades.tsx');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer;
  const window = new Window();
  try {
    await act(async () => { renderer = create(React.createElement(TradesContent, { reads: Object.values(sections), now: sections.status.generated_at_ms, heartbeat: 'Fresh' })); });
    await act(async () => { renderer.root.findAllByType('button').find(button => button.children[0] === 'View trade').props.onClick(); });
    const section = renderer.root.findAllByType('section').find(section => section.findAllByType('h2').some(heading => heading.children.join('').startsWith('Trade details')));
    window.document.body.innerHTML = renderToStaticMarkup(React.createElement('div', null, section.props.children));
    const values = Object.fromEntries([...window.document.querySelectorAll('[data-trade-cost]')].map(element => [element.getAttribute('data-trade-cost'), { text: element.textContent, title: element.querySelector('[title]')?.getAttribute('title') }]));
    return { values, text: window.document.body.textContent };
  } finally {
    await act(async () => renderer?.unmount());
    window.close();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
}

test('trade details render gross totals, weighted prices, owner fees and source-ratio titles', async () => {
  const { values, text } = await detail(executor());
  assert.deepEqual(values.entry, { text: '70.00 USDC', title: '70' });
  assert.deepEqual(values.proceeds, { text: '60.00 USDC', title: '60' });
  assert.deepEqual(values.entryPrice, { text: '17.50', title: '70 / 4 = 17.5' });
  assert.deepEqual(values.exitPrice, { text: '30.00', title: '60 / 2 = 30' });
  assert.deepEqual(values.fees, { text: '1.25 USDC', title: '1.25' });
  assert.equal(values.return.text, '—');
  assert.match(text, /Realized return on gross entry/);
  assert.doesNotMatch(text, /Margin at sale|owner does not publish these sale metrics/);
});

test('rounded trade detail is visibly approximate and keeps its exact ratio title', async () => {
  const { values } = await detail(executor({ entry_gross_base: '3', entry_gross_quote: '1' }));
  assert.deepEqual(values.entryPrice, { text: '≈ 0.3333 (rounded)', title: '1 / 3 = ≈ 0.3333 (rounded)' });
});

test('missing receipt renders dashes while unsold and pooled receipts explain their limits', async () => {
  const missing = await detail(executor({}, { custom_info: {} }));
  for (const key of ['entry', 'proceeds', 'entryPrice', 'exitPrice', 'return']) assert.equal(missing.values[key]?.text, '—');
  const unsold = await detail(executor({ exit_gross_base: '0', exit_gross_quote: '0' }));
  assert.equal(unsold.values.exitPrice.text, 'Not sold');
  const invalid = await detail(executor({ entry_gross_quote: '1e65' }));
  for (const key of ['entry', 'proceeds', 'entryPrice', 'exitPrice', 'return']) assert.equal(invalid.values[key].text, '—');
  const held = await detail(executor({ accounting_owner: 'held_position' }, { terminal: true }));
  assert.equal(held.values.entry.text, '70.00 USDC');
  for (const key of ['proceeds', 'exitPrice', 'return']) assert.equal(held.values[key].text, '—');
  assert.match(held.text, /recovery sales are allocated across held bags.*not reflected in this executor's receipt/i);
});

test('closed executor renders the same receipt and realized return through terminal history', async () => {
  const row = executor({ remaining_owned_base: '0E-8', exit_gross_base: '4', exit_gross_quote: '80' }, { realized_pnl_quote: '-7' });
  const active = await detail(row);
  const history = await detail(row, true);
  assert.equal(active.values.return.text, '−10.00%');
  assert.equal(active.values.return.title, '-7 / 70 × 100 = −10%');
  assert.deepEqual(active.values, history.values);
});

test('live-shaped receipt displays through shared formatters with exact titles, without approximation for terminating values', async () => {
  const held = await detail(executor(liveShape.held_position));
  assert.deepEqual(held.values.entryPrice, { text: '641.78', title: '99.700523000 / 0.1553500 = 641.78' });
  const row = executor({ ...liveShape.closed_executor, entry_gross_quote: '00.1', entry_gross_base: '1', exit_gross_quote: '1E-7' }, { realized_pnl_quote: '0.01' });
  const active = await detail(row);
  const history = await detail(row, true);
  assert.deepEqual(active.values.entry, { text: '0.10 USDC', title: '00.1' });
  assert.deepEqual(active.values.proceeds, { text: '0.00 USDC', title: '1E-7' });
  assert.deepEqual(active.values.fees, { text: '1.25 USDC', title: '1.25' });
  assert.deepEqual(active.values.return, { text: '+10.00%', title: '0.01 / 00.1 × 100 = 10%' });
  assert.deepEqual(active.values, history.values);
});
