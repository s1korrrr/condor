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

/** Quantity cells of the real DataTable, in the order it shows them, for the real Bots column definition. */
function shown(section, amounts, desc, tables = botsTables()) {
  const { captured, PaperWorkspace } = tables;
  const read = structuredClone(fixture[section]);
  read.next_cursor = null;
  read.data = amounts.map((amount, index) => ({ ...fixture[section].data[0], [idKeys[section]]: `row-${index}`, ...(section === 'fills' ? { order_id: `order-${index}` } : {}), trading_pair: 'BNB-USDC', [quantityField[section]]: amount, ...(section === 'positions' ? { state: 'active' } : {}) }));
  const reads = Object.values(fixture).map(item => item.section === section ? read : item);
  renderToStaticMarkup(React.createElement(PaperWorkspace, { reads, accountingRead: fixture.accounting, now, reportAt: now, heartbeat: 'Fresh', bot: fixture.status.bot_id }));
  const props = captured[`Paper ${section}`];
  assert.ok(props, `Paper ${section} table rendered`);
  const html = renderToStaticMarkup(React.createElement(DataTable, { ...props, initialSort: { id: 'quantity', desc } }));
  const table = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
  return [...table.matchAll(/<td[^>]*><span(?: title="[^"]*")?>([^<]* BNB)<\/span>/g)].map(match => match[1]);
}

const amounts = ['0.1', '12.5', '0.00000001', '0.09'];
const ascending = ['0.00000001 BNB', '0.09 BNB', '0.1 BNB', '12.5 BNB'];

for (const section of ['fills', 'positions', 'executors']) {
  test(`Bots ${section} quantity sorts by the owner decimal, ascending and descending`, () => {
    assert.deepEqual(shown(section, amounts, false), ascending);
    assert.deepEqual(shown(section, amounts, true), [...ascending].reverse());
  });
}

test('Bots quantity sort keeps 18-decimal owner values apart and gives an unpublished amount no sort value', () => {
  const tables = botsTables();
  assert.deepEqual(shown('fills', ['0.016245819000000002', '0.016245819000000001', '0.016245819000000000'], false, tables), ['0.016246 BNB', '0.016246 BNB', '0.016246 BNB']);
  const read = tables.captured['Paper fills'];
  const rows = read.rows, value = read.columns.find(column => column.id === 'quantity').value;
  assert.deepEqual(rows.map(value), ['0.016245819000000002', '0.016245819000000001', '0.016245819000000000']);
  const sorted = [...rows].sort((left, right) => compareDecimal(value(left), value(right)));
  assert.deepEqual(sorted.map(value), ['0.016245819000000000', '0.016245819000000001', '0.016245819000000002']);
  assert.equal(read.columns.find(column => column.id === 'quantity').kind, 'number');
  for (const invalid of ['not a number', '1e-8', '', undefined, null, 1]) assert.equal(value({ ...rows[0], quantity: invalid }), undefined, String(invalid));
});

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
