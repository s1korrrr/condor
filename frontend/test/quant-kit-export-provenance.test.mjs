import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const require = createRequire(import.meta.url);
const core = require('@tanstack/table-core');

function makeTableHarness(filters = [], search = '') {
  let stateIndex = 0;
  const react = {
    useMemo: factory => factory(),
    useState(initial) {
      const index = stateIndex++;
      const value = index === 1 ? filters : index === 2 ? search : initial;
      return [value, () => {}];
    },
    // The harness calls the component once, like a server render: effects (the onRowsChange report) do not run.
    useLayoutEffect: () => {},
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
  const { DataTable } = frontendModules({ react, '@tanstack/react-table': tanstack })
    .load('features/quant-ops/kit/DataTable.tsx');
  return DataTable;
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

async function exportTable(t, { metadata, rows, filters = [], search = '', pageSize = 1 }) {
  const previousDocument = globalThis.document;
  const previousURL = globalThis.URL;
  const capture = { clicks: 0, revoked: [] };
  globalThis.URL = {
    createObjectURL: blob => { capture.blob = blob; return 'blob:quant-kit-export'; },
    revokeObjectURL: url => capture.revoked.push(url),
  };
  globalThis.document = {
    createElement: name => {
      assert.equal(name, 'a');
      return {
        click() { capture.clicks += 1; },
      };
    },
  };
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.URL = previousURL;
  });

  const DataTable = makeTableHarness(filters, search);
  const table = DataTable({
    label: 'Synthetic export fixture',
    rows,
    rowId: row => row.id,
    initialSort: { id: 'amount', desc: true },
    pageSize,
    exportName: 'fixture.csv',
    ...(metadata === undefined ? {} : { exportMetadata: metadata }),
    columns: [
      { id: 'asset', header: 'Asset', rowHeader: true, value: row => row.asset },
      { id: 'amount', header: 'Amount', kind: 'number', value: row => row.amount },
    ],
  });
  const exportButton = [...walk(table)].find(node => node.type === 'button' && node.props.children === 'Export CSV');
  assert.ok(exportButton, 'the component renders its actual export action');
  assert.equal(renderToStaticMarkup(table).match(/<tbody>(.*?)<\/tbody>/s)?.[1].match(/<tr/g)?.length, 1,
    'the displayed page remains limited to one row');
  exportButton.props.onClick();
  return { csv: await capture.blob.text(), capture };
}

const rows = [
  { id: 'a', asset: 'alpha', amount: 3 },
  { id: 'b', asset: 'echo', amount: 8 },
  { id: 'c', asset: 'gamma', amount: 4 },
  { id: 'd', asset: 'delta', amount: 1 },
];

test('CSV export retains filtered and sorted rows beyond the page and appends escaped provenance', async t => {
  const { csv, capture } = await exportTable(t, {
    rows,
    filters: [{ id: 'amount', value: '>2' }],
    search: 'a',
    metadata: {
      Snapshot: 'snapshot,"one"\nline 2',
      'Run,Id': 7,
      Formula: '=SUM(1,1)',
    },
  });

  assert.equal(csv,
    'Asset,Amount,Snapshot,"Run,Id",Formula,table_search,table_column_filters,table_sort,table_exported_count,table_row_id\n' +
    'gamma,4,"snapshot,""one""\nline 2",7,"\'=SUM(1,1)",a,"[{""id"":""amount"",""value"":"">2""}]","[{""id"":""amount"",""desc"":true}]",2,c\n' +
    'alpha,3,"snapshot,""one""\nline 2",7,"\'=SUM(1,1)",a,"[{""id"":""amount"",""value"":"">2""}]","[{""id"":""amount"",""desc"":true}]",2,a');
  assert.equal(capture.clicks, 1);
  assert.deepEqual(capture.revoked, ['blob:quant-kit-export']);
});

test('CSV export without metadata keeps the existing header and row bytes', async t => {
  const { csv, capture } = await exportTable(t, { rows, filters: [{ id: 'amount', value: '>2' }], search: 'a' });

  assert.equal(csv, 'Asset,Amount\ngamma,4\nalpha,3');
  assert.equal(capture.clicks, 1);
  assert.deepEqual(capture.revoked, ['blob:quant-kit-export']);
});
