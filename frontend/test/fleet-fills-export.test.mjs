import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { frontendModules } from './helpers/frontend-module.mjs';

const require = createRequire(import.meta.url);
const core = require('@tanstack/table-core');

const react = {
  useMemo: factory => factory(),
  useEffect: effect => { effect(); },
  useRef: current => ({ current }),
  useState: initial => [initial, () => {}],
};
const tanstack = {
  ...core,
  flexRender: (render, context) => typeof render === 'function' ? render(context) : render,
  useReactTable: options => {
    const table = core.createTable({ ...options, renderFallbackValue: null, onStateChange: () => {} });
    table.setOptions(previous => ({ ...previous, state: { ...table.initialState, ...options.state } }));
    return table;
  },
};
const { load } = frontendModules({ react, '@tanstack/react-table': tanstack });
const { FleetFillsView } = load('components/bots/FleetFillsPanel.tsx');
const { DataTable } = load('features/quant-ops/kit/DataTable.tsx');
const lib = load('lib/fleet-fills.ts');
const model = load('features/bots/fleet-fills-model.ts');
const columns = load('components/bots/fleet-fills-columns.tsx').fleetFillColumns;

function* walk(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!node || typeof node !== 'object' || !node.props) return;
  yield node;
  yield* walk(node.props.children);
}

test('fleet fill CSV exports raw PnL beside the actual per-fill quote unit', async t => {
  const body = JSON.parse(fs.readFileSync(
    new URL('../../tests/fixtures/fleet_fills/page_first.example.json', import.meta.url), 'utf8',
  ));
  body.items[0].realized_pnl = '0';
  body.items[0].quote = 'USDC';
  body.items[1].realized_pnl = '-1.2500';
  body.items[1].quote = 'USDT';
  body.items[2].realized_pnl = null;
  body.items[2].quote = 'USDC';
  const page = lib.parseFleetFills(body);
  const view = model.projectFleetFills({ pages: [page] });
  const panel = FleetFillsView({
    view,
    filters: { bots: [], side: null, pair: null },
    botOptions: [],
    pairDraft: '',
    onToggleBot() {}, onSide() {}, onPairDraft() {}, onReset() {}, onLoadMore() {},
  });
  const tableElement = [...walk(panel)].find(node => node.type === DataTable);
  assert.ok(tableElement, 'the fleet fills panel renders the shared data table');
  assert.equal(typeof tableElement.props.exportMetadata?.pnl_unit, 'function');
  const exportButton = [...walk(DataTable(tableElement.props))]
    .find(node => node.type === 'button' && node.props.children === 'Export CSV');
  assert.ok(exportButton, 'the export button is part of the actual table');

  const oldDocument = globalThis.document;
  const oldURL = globalThis.URL;
  const capture = {};
  globalThis.URL = {
    createObjectURL: blob => { capture.blob = blob; return 'blob:fleet-fills'; },
    revokeObjectURL() {},
  };
  globalThis.document = { createElement: () => ({ click() {} }) };
  t.after(() => { globalThis.document = oldDocument; globalThis.URL = oldURL; });
  exportButton.props.onClick();
  const csv = await capture.blob.text();
  const [header, ...rows] = csv.split('\n');
  assert.match(header, /PnL,Fee,Receipt,pnl_unit,table_search/);
  assert.ok(rows.some(row => row.includes(',0,') && row.includes(',USDC,')), 'zero keeps its raw decimal and USDC metadata');
  assert.ok(rows.some(row => row.includes(',-1.2500,') && row.includes(',USDT,')), 'negative precision and USDT metadata are preserved');
  const missingPnl = rows.find(row => row.endsWith('rsi_modular_v2|db-v2|ETH-USDC|v2-1'));
  assert.ok(missingPnl);
  assert.equal(missingPnl.split(',')[8], '', 'null PnL exports no numeric value');
  assert.equal(missingPnl.split(',')[11], '', 'null PnL claims no unit');
});

test('fleet PnL sorting keeps unlike quote units in separate groups', () => {
  const fixture = JSON.parse(fs.readFileSync(
    new URL('../../tests/fixtures/fleet_fills/page_first.example.json', import.meta.url), 'utf8',
  ));
  const template = lib.parseFleetFills(fixture).items[0];
  const rows = [
    ['usdc-high', 'USDC', '9'],
    ['usdt-high', 'USDT', '8'],
    ['unknown', null, '7'],
    ['usdc-low', 'USDC', '3'],
    ['usdt-low', 'USDT', '2'],
  ].map(([id, quote, realized_pnl]) => ({ ...template, id, quote, realized_pnl }));
  const sorted = [];
  DataTable({
    rows,
    columns,
    rowId: row => row.id,
    label: 'Fleet fills',
    initialSort: { id: 'pnl', desc: true },
    onRowsChange: values => sorted.push(values),
  });
  const result = sorted.at(-1);
  assert.ok(result, 'the production data table reports its actual sorted rows');
  const groups = result.map(row => row.quote ?? '[unit unreported]');
  assert.equal(new Set(groups).size, 3);
  assert.deepEqual(groups.filter((group, index) => index === 0 || group !== groups[index - 1]), [...new Set(groups)], 'each quote group remains contiguous');
  for (const quote of ['USDC', 'USDT', '[unit unreported]']) {
    const values = result.filter(row => (row.quote ?? '[unit unreported]') === quote).map(row => Number(row.realized_pnl));
    assert.deepEqual(values, [...values].sort((left, right) => right - left), `${quote} PnL sorts numerically within its group`);
  }
});
