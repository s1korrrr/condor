import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';
import { compareDecimal } from '../src/v5/format.mjs';

// The Bots records tables sort the Quantity and Remaining close columns by the owner's exact decimal, never by the
// trimmed display text ("0.1 BNB" must not come before "0.09 BNB").
const stubs = Object.fromEntries(['@/components/bots/AggregatedPnlChart', '@/components/bots/ControllerBrowser', '@/components/bots/DeployBotDialog', '@/components/bots/PnlSparkline', '@/hooks/useWebSocket', '@/hooks/useRates'].map(name => [name, {}]));
const { DataTable } = frontendModules(stubs).load('features/quant-ops/kit/DataTable.tsx');
/** A fresh Bots module whose DataTable only records the props the page gives it (the page caches reads per module). */
function botsTables() {
  const captured = {};
  const { PaperWorkspace } = frontendModules({ ...stubs, '@/features/quant-ops/kit/DataTable': { DataTable: props => { captured[props.label] = props; return null; } } }).load('pages/tabs/ActiveBotsTab.tsx');
  return { captured, PaperWorkspace };
}
const fixture = Object.fromEntries(['status', 'wallet', 'positions', 'executors', 'fills', 'risk', 'decisions', 'history', 'operations', 'accounting'].map(section => [section, JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)))]));
const now = fixture.wallet.generated_at_ms;
const idKeys = { fills: 'trade_id', positions: 'position_id', executors: 'executor_id' };
const quantityField = { fills: 'quantity', positions: 'quantity', executors: 'remaining_close_quantity' };

/** Quantity cells and owner IDs in the real Bots DataTable's rendered row order. */
function shown(section, amounts, desc, { tables = botsTables(), filter, search } = {}) {
  const { captured, PaperWorkspace } = tables;
  const read = structuredClone(fixture[section]);
  read.next_cursor = null;
  read.data = amounts.map((amount, index) => ({ ...fixture[section].data[0], [idKeys[section]]: `row-${index}`, ...(section === 'fills' ? { order_id: `order-${index}` } : {}), trading_pair: 'BNB-USDC', [quantityField[section]]: amount, ...(section === 'positions' ? { state: 'active' } : {}) }));
  const reads = Object.values(fixture).map(item => item.section === section ? read : item);
  renderToStaticMarkup(React.createElement(PaperWorkspace, { reads, accountingRead: fixture.accounting, now, reportAt: now, heartbeat: 'Fresh', bot: fixture.status.bot_id }));
  const props = captured[`Paper ${section}`];
  assert.ok(props, `Paper ${section} table rendered`);
  let Table = DataTable;
  if (filter !== undefined || search !== undefined) {
    let stateIndex = 0;
    const react = { ...React, useState(initial) {
      const index = stateIndex++;
      return React.useState(index === 1 && filter !== undefined ? [{ id: 'quantity', value: filter }] : index === 2 && search !== undefined ? search : initial);
    } };
    Table = frontendModules({ ...stubs, react }).load('features/quant-ops/kit/DataTable.tsx').DataTable;
  }
  const html = renderToStaticMarkup(React.createElement(Table, { ...props, initialSort: { id: 'quantity', desc } }));
  const table = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
  return {
    quantities: [...table.matchAll(/<td[^>]*><span(?: title="[^"]*")?>([^<]* BNB)<\/span>/g)].map(match => match[1]),
    ids: [...table.matchAll(/<button[^>]*title="Copy full owner ID"[^>]*>([^<]+)<\/button>/g)].map(match => match[1]),
  };
}

const amounts = ['0.1', '12.5', '0.00000001', '0.09'];
const ascending = ['0.00000001 BNB', '0.09 BNB', '0.1 BNB', '12.5 BNB'];

for (const section of ['fills', 'positions', 'executors']) {
  test(`Bots ${section} quantity sorts by the owner decimal, ascending and descending`, () => {
    assert.deepEqual(shown(section, amounts, false).quantities, ascending);
    assert.deepEqual(shown(section, amounts, true).quantities, [...ascending].reverse());
  });
}

test('Bots quantity sort keeps 18-decimal owner values apart and gives an unpublished amount no sort value', () => {
  const tables = botsTables();
  const precise = ['0.016245819000000002', '0.016245819000000000', '0.016245819000000001'];
  const sorted = shown('fills', precise, false, { tables });
  assert.deepEqual(sorted.quantities, ['0.016246 BNB', '0.016246 BNB', '0.016246 BNB']);
  assert.deepEqual(sorted.ids, ['row-1', 'row-2', 'row-0']);
  assert.deepEqual(shown('fills', precise, true).ids, ['row-0', 'row-2', 'row-1']);
  const read = tables.captured['Paper fills'];
  const rows = read.rows, value = read.columns.find(column => column.id === 'quantity').value;
  assert.deepEqual(rows.map(value), precise);
  assert.equal(read.columns.find(column => column.id === 'quantity').kind, 'number');
  for (const invalid of ['not a number', '1e-8', '', undefined, null, 1]) assert.equal(value({ ...rows[0], quantity: invalid }), undefined, String(invalid));
});

const adjacent = ['0.100000000000000000', '0.100000000000000001'];
for (const [filter, values, ids] of [
  ['>0.1', adjacent, ['row-1']],
  ['=0.100000000000000001', adjacent, ['row-1']],
  ['0.09..0.1', adjacent, ['row-0']],
  ['<=0.09', [...adjacent, '0.090000000000000000', '0.090000000000000001'], ['row-2']],
  ['0.01..1', [...adjacent, '0.009999999999999999', '0.01', '1', '1.000000000000000001'], ['row-3', 'row-0', 'row-1', 'row-4']],
  ['>0', [...adjacent, '0', `0.${'0'.repeat(125)}1`], ['row-3', 'row-0', 'row-1']],
  ['>0.1oops', adjacent, []],
]) {
  test(`Bots Recent fills filters exact quantity with ${filter}`, () => {
    assert.deepEqual(shown('fills', values, false, { filter }).ids, ids);
  });
}

for (const [search, ids] of [
  ['0.016246', ['row-2']],
  ['0.1 BNB', ['row-0', 'row-1']],
  ['0.100000000000000001', ['row-1']],
]) {
  test(`Bots Recent fills search finds quantity ${search}`, () => {
    assert.deepEqual(shown('fills', [...adjacent, '0.016245819000000001'], false, { search }).ids, ids);
  });
}

test('compareDecimal compares exact decimal strings and declines anything else', () => {
  assert.equal(compareDecimal('0.09', '0.1'), -1);
  assert.equal(compareDecimal('12.5', '0.00000001'), 1);
  assert.equal(compareDecimal('0.016245819000000001', '0.016245819000000002'), -1);
  assert.equal(compareDecimal('1.50', '1.5'), 0);
  assert.equal(compareDecimal('-0.5', '0.1'), -1);
  assert.equal(compareDecimal('-0', '0'), 0);
  assert.equal(compareDecimal('1e-8', '0.00000002'), -1);
  assert.equal(compareDecimal('0.5 BTC', '0.1'), null);
  assert.equal(compareDecimal(1, '2'), null);
  assert.equal(compareDecimal('', '2'), null);
});
