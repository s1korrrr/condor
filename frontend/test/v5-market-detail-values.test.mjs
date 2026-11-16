import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

test('venue gap statistics use rounded text and retain the exact owner number', () => {
  const { columns } = frontendModules({ '@/components/charts/RecordedCandleChart': {} }, { 'v5/V5MarketDetail.tsx': ['columns'] }).load('v5/V5MarketDetail.tsx');
  const row = { mean_bps: -0.004, mean_abs_bps: 0.004, p95_abs_bps: 1.23456, max_abs_bps: 2.34567 };
  for (const [id, exact, shown] of [['mean', '-0.004', '0.00'], ['abs', '0.004', '0.00'], ['p95', '1.23456', '1.23'], ['max', '2.34567', '2.35']]) {
    const cell = columns.find(column => column.id === id).cell(row);
    assert.equal(renderToStaticMarkup(cell), `<span title="${exact}">${shown}</span>`);
  }
});
