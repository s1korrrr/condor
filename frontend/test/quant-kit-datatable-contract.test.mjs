import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { frontendModules } from './helpers/frontend-module.mjs';

const require = createRequire(import.meta.url);
const React = require('react');
const core = require('@tanstack/table-core');

function makeHarness({ filters = [], search = '', sorting, effects = [] } = {}) {
  const refs = [];
  let refIndex = 0;
  const react = {
    useMemo: factory => factory(),
    useEffect: effect => effects.push(effect),
    useRef(initial) {
      const index = refIndex++;
      refs[index] ??= { current: initial };
      return refs[index];
    },
    useState(initial) {
      const index = stateIndex++;
      const values = [sorting ?? initial, filters, search, false, false];
      return [values[index] ?? initial, () => {}];
    },
  };
  let stateIndex = 0;
  const tanstack = {
    ...core,
    flexRender: (render, context) => typeof render === 'function' ? render(context) : render,
    useReactTable: options => {
      const table = core.createTable({ ...options, renderFallbackValue: null, onStateChange: () => {} });
      table.setOptions(previous => ({ ...previous, state: { ...table.initialState, ...options.state } }));
      return table;
    },
  };
  const { DataTable } = frontendModules({ react, '@tanstack/react-table': tanstack })
    .load('features/quant-ops/kit/DataTable.tsx');
  return props => {
    stateIndex = 0;
    refIndex = 0;
    return DataTable(props);
  };
}

function* walk(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!node || typeof node !== 'object' || !node.props) return;
  yield node;
  yield* walk(node.props.children);
}

function rowIds(tree) {
  return [...walk(tree)]
    .filter(node => node.type === 'th' && node.props.scope === 'row')
    .map(node => node.props.children);
}

const columns = [
  { id: 'id', header: 'Id', rowHeader: true, value: row => row.id },
  { id: 'ret', header: 'Return', kind: 'number', value: row => row.ret, sortGroup: row => row.rank },
];

const rows = [
  { id: 'w-high', basis: 'wallet', rank: 0, ret: 0.8 },
  { id: 'w-low', basis: 'wallet', rank: 0, ret: 0.4 },
  { id: 'w-missing', basis: 'wallet', rank: 0, ret: null },
  { id: 'c-high', basis: 'peak cash', rank: 1, ret: 0.7 },
  { id: 'c-missing', basis: 'peak cash', rank: 1, ret: null },
  { id: 'd-high', basis: 'peak deployed', rank: 2, ret: 0.95 },
  { id: 'd-low', basis: 'peak deployed', rank: 2, ret: 0.2 },
];

function tableProps(overrides = {}) {
  return {
    label: 'Backtest catalog', rows, columns, rowId: row => row.id,
    initialSort: { id: 'ret', desc: true }, exportName: 'catalog.csv',
    ...overrides,
  };
}

test('sortGroup stays ascending while numeric values and nulls sort within each group', () => {
  const makeTable = makeHarness();
  const descending = makeTable(tableProps());
  assert.deepEqual(rowIds(descending), ['w-high', 'w-low', 'w-missing', 'c-high', 'c-missing', 'd-high', 'd-low']);

  const makeAscending = makeHarness({ sorting: [{ id: 'ret', desc: false }] });
  const ascending = makeAscending(tableProps({ initialSort: undefined }));
  assert.deepEqual(rowIds(ascending), ['w-low', 'w-high', 'w-missing', 'c-high', 'c-missing', 'd-low', 'd-high']);
});

test('sortGroup preserves text sorting and nulls last inside each fixed group', () => {
  const words = [
    { id: 'w-alpha', rank: 0, word: 'Alpha' },
    { id: 'w-zulu', rank: 0, word: 'Zulu' },
    { id: 'w-missing', rank: 0, word: null },
    { id: 'c-bravo', rank: 1, word: 'Bravo' },
  ];
  const textColumns = [columns[0], { id: 'word', header: 'Word', value: row => row.word, sortGroup: row => row.rank }];
  for (const desc of [false, true]) {
    const tree = makeHarness()(tableProps({ rows: words, columns: textColumns, initialSort: { id: 'word', desc } }));
    assert.deepEqual(rowIds(tree), desc ? ['w-zulu', 'w-alpha', 'w-missing', 'c-bravo'] : ['w-alpha', 'w-zulu', 'w-missing', 'c-bravo']);
  }
});

test('controlled row checkboxes call selection while CSV still exports every filtered row', async t => {
  const selected = new Set(['w-missing']);
  const selectedCalls = [];
  const makeTable = makeHarness({ filters: [{ id: 'ret', value: '>0.3' }] });
  const tree = makeTable(tableProps({
    selection: { selected, label: row => `${row.basis}: ${row.id}`, onSelect: (...args) => selectedCalls.push(args) },
  }));

  const checkboxes = [...walk(tree)].filter(node => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(checkboxes.length, 4);
  assert.equal(selected.has('w-missing'), true, 'a row hidden by a native filter remains selected in caller state');
  checkboxes.find(node => node.props['aria-label'] === 'Select wallet: w-high').props.onChange({ currentTarget: { checked: true } });
  assert.deepEqual(selectedCalls, [[['w-high'], true]]);
  assert.equal(selected.has('w-missing'), true, 'toggling a visible row does not clear hidden selections');

  const previousDocument = globalThis.document;
  const previousURL = globalThis.URL;
  let csv;
  globalThis.URL = { createObjectURL: blob => { csv = blob.text(); return 'blob:selection-test'; }, revokeObjectURL: () => {} };
  globalThis.document = { createElement: () => ({ click() {} }) };
  t.after(() => { globalThis.document = previousDocument; globalThis.URL = previousURL; });
  [...walk(tree)].find(node => node.type === 'button' && node.props.children === 'Export CSV').props.onClick();
  assert.equal(await csv, 'Id,Return\nw-high,0.8\nw-low,0.4\nc-high,0.7\nd-high,0.95');
});

test('searchable false hides global search but leaves default search enabled', () => {
  const makeTable = makeHarness({ search: 'w-high' });
  const hidden = makeTable(tableProps({ searchable: false }));
  assert.equal([...walk(hidden)].some(node => node.type === 'input' && node.props.type === 'search'), false);
  assert.equal(rowIds(hidden).length, rows.length, 'hidden native search state does not apply when disabled');

  const visible = makeTable(tableProps());
  assert.equal([...walk(visible)].some(node => node.type === 'input' && node.props.type === 'search'), true);
  assert.deepEqual(rowIds(visible), ['w-high'], 'the default global search remains active');
});

test('onRowsChange runs after render with complete sorted filtered rows before pinning and pagination', () => {
  const effects = [];
  const calls = [];
  const makeTable = makeHarness({ filters: [{ id: 'ret', value: '>0.3' }], effects });
  const props = tableProps({
    onRowsChange: value => calls.push(value),
    pageSize: 1,
    pinned: row => row.id === 'd-high',
  });
  const tree = makeTable(props);

  assert.deepEqual(calls, [], 'callback is deferred until after render');
  effects.splice(0).forEach(effect => effect());
  assert.deepEqual(calls[0].map(row => row.id), ['w-high', 'w-low', 'c-high', 'd-high']);
  assert.deepEqual(rowIds(tree), ['d-high'], 'rendered page still applies pinning and page size');

  makeTable({ ...props, onRowsChange: value => calls.push(value) });
  effects.splice(0).forEach(effect => effect());
  assert.equal(calls.length, 1, 'unchanged rows do not create a callback-driven render loop');

  const updatedRows = rows.map(row => row.id === 'w-high' ? { ...row, ret: 0.85 } : row);
  makeTable({ ...props, rows: updatedRows, onRowsChange: value => calls.push(value) });
  effects.splice(0).forEach(effect => effect());
  assert.equal(calls.length, 2, 'new row objects are reported even when their stable IDs do not change');
  assert.equal(calls[1][0], updatedRows[0]);
});
