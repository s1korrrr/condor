import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const sourceRoot = path.resolve(import.meta.dirname, '../src');
const modules = () => frontendModules({ '@/components/charts/RecordedCandleChart': {} }, { 'v5/V5Stocks.tsx': ['StockRecord', 'depthColumns', 'tradeColumns'], 'v5/V5CandleStore.tsx': ['columns'], 'v5/V5Market.tsx': ['systemCoverage'] }, (filename, source) => {
  if (!process.env.V5_TITLE_BASELINE || !filename.startsWith(sourceRoot + path.sep)) return source;
  return execFileSync('git', ['show', `${process.env.V5_TITLE_BASELINE}:frontend/src/${path.relative(sourceRoot, filename)}`], { cwd: path.resolve(sourceRoot, '../..'), encoding: 'utf8' });
});
const raw = '114.1396691483993272381433853';
const rounded = '≈ 114.139669148399 (rounded)';

test('desktop td and row-header th titles bound typed string and number values', () => {
  const { DataTable } = modules().load('features/quant-ops/kit/DataTable.tsx');
  const html = renderToStaticMarkup(React.createElement(DataTable, {
    rows: [{ amount: raw }], rowId: () => 'row', label: 'Owner values',
    columns: [
      { id: 'amount', header: 'Amount', kind: 'number', value: row => row.amount, cell: () => '114.14' },
      { id: 'number', header: 'Number', rowHeader: true, kind: 'number', value: () => Number(raw), cell: () => '114.14' },
    ],
  }));
  assert.match(html, /<td[^>]*title="≈ 114\.139669148399 \(rounded\)"/);
  assert.match(html, /<th[^>]*title="≈ 114\.139669148399 \(rounded\)"/);
  assert.ok(!html.includes(`title="${raw}"`));
});

test('numeric title overrides are bounded without changing the visible phone note', () => {
  const { DataTable } = modules().load('features/quant-ops/kit/DataTable.tsx');
  const html = renderToStaticMarkup(React.createElement(DataTable, {
    rows: [raw], rowId: () => 'row', label: 'Owner note', columns: [{ id: 'amount', header: 'Amount', kind: 'number', value: row => row, cell: () => '114.14', title: row => row }],
  }));
  assert.ok(!html.includes(`title="${raw}"`));
  assert.ok(html.includes(`<small class="v5-phone-row-note">${raw}</small>`));
});

test('text columns preserve decimal-looking identifiers on desktop and phone', () => {
  const { DataTable } = modules().load('features/quant-ops/kit/DataTable.tsx');
  const identifier = 'order/1.12345678901234567890';
  const html = renderToStaticMarkup(React.createElement(DataTable, {
    rows: [identifier, '1e-13'], rowId: row => row, label: 'IDs',
    columns: [{ id: 'id', header: 'ID', rowHeader: true, value: row => row }],
  }));
  assert.equal((html.match(/title="order\/1\.12345678901234567890"/g) ?? []).length, 3);
  assert.equal((html.match(/title="1e-13"/g) ?? []).length, 3);
  assert.ok(!html.includes('≈'));
});

test('candle health bounds numeric rule detail only in titles and preserves its visible note', () => {
  const { load } = modules();
  const { columns } = load('v5/V5CandleStore.tsx');
  const { DataTable } = load('features/quant-ops/kit/DataTable.tsx');
  const html = renderToStaticMarkup(React.createElement(DataTable, {
    rows: [{ health: 'green', health_rules: [{ rule: 'coverage', detail: raw }] }],
    columns: [columns.find(column => column.id === 'health')], rowId: () => 'lane', label: 'Lane health',
  }));
  assert.ok(html.includes(`title="coverage: ${rounded}"`));
  assert.ok(html.includes(`<small class="v5-phone-row-note">coverage: ${raw}</small>`));
  assert.ok(!html.includes(`title="coverage: ${raw}"`));
});

test('stock record titles bound owner amounts without rounding trade IDs or paths', () => {
  const { StockRecord } = modules().load('v5/V5Stocks.tsx');
  const html = renderToStaticMarkup(React.createElement(StockRecord, { record: {
    tradeId: '1e-13', source: 'order/1.12345678901234567890', px: raw,
    bids: [[raw, '1e-13', '1e-13']],
  } }));
  const title = html.match(/title="([^"]*)"/)[1];
  assert.ok(title.includes('&quot;tradeId&quot;: &quot;1e-13&quot;'));
  assert.ok(title.includes('order/1.12345678901234567890'));
  assert.ok(title.includes(rounded));
  assert.ok(title.includes('≈ 0 (rounded)'));
});

test('stock depth and trade prices have title-only numeric metadata without changing sort kinds', () => {
  const { depthColumns, tradeColumns } = modules().load('v5/V5Stocks.tsx');
  for (const columns of [depthColumns, tradeColumns]) {
    for (const id of ['price', 'size']) {
      assert.equal(columns.find(column => column.id === id).ownerValue, true);
      assert.equal(columns.find(column => column.id === id).kind, undefined);
    }
  }
  assert.notEqual(tradeColumns.find(column => column.id === 'id').kind, 'number');
  const { DataTable } = modules().load('features/quant-ops/kit/DataTable.tsx');
  const html = renderToStaticMarkup(React.createElement(DataTable, { rows: [{ side: 'Bid', price: raw, size: raw, orders: '2' }], columns: depthColumns, rowId: () => 'bid', label: 'Book' }));
  assert.ok(!html.includes(`title="${raw}"`));
  assert.ok(html.includes(`title="${rounded}"`));
});

test('breakeven titles format typed operands even when the source expression has glued signs', () => {
  const { breakEvenDistanceDetail } = modules().load('v5/bots-position-model.mjs');
  const detail = breakEvenDistanceDetail('1.12345678901234567890', 2.1234567890123456);
  assert.ok(detail.exact.includes('1.12345678901234567890'));
  assert.match(detail.title, /≈ 1\.123456789012 \(rounded\)/);
  assert.match(detail.title, /≈ 2\.123456789012 \(rounded\)/);
});

test('typed Helm distance and System mean builders also bound their derived results', () => {
  const { load } = modules();
  const { helmCoinRow } = load('v5/helm-model.mjs');
  const row = helmCoinRow({ pair: 'BNB-USDC', signal: { at: 990, rsi: '1.12345678901234567890', oversold: '1' } }, { fresh: true, nowS: 1000 });
  assert.equal(row.rsiTitle, 'RSI ≈ 1.123456789012 (rounded) − line 1 = ≈ 0.123456789012 (rounded)');
  assert.equal(row.rsi, 'RSI 1.12346, 0.123457 points above the line');
  const { systemCoverage } = load('v5/V5Market.tsx');
  const coverage = systemCoverage([{ available: true, coverage_7d: 0.1234567890123456 }]);
  assert.equal(coverage.exact, 'exact mean of ≈ 0.123456789012 (rounded) = ≈ 12.345678901235 (rounded)%');
  assert.equal(coverage.text, '12.3%');
});
