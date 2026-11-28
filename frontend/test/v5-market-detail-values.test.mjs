import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';
import { coinStats, marketDetailTitles } from '../src/v5/market-model.mjs';

test('venue gap statistics use rounded text and retain the exact owner number', () => {
  const { columns } = frontendModules({ '@/components/charts/RecordedCandleChart': {} }, { 'v5/V5MarketDetail.tsx': ['columns'] }).load('v5/V5MarketDetail.tsx');
  const row = { mean_bps: -0.004, mean_abs_bps: 0.004, p95_abs_bps: 1.23456, max_abs_bps: 2.34567 };
  for (const [id, exact, shown] of [['mean', '-0.004', '0.00'], ['abs', '0.004', '0.00'], ['p95', '1.23456', '1.23'], ['max', '2.34567', '2.35']]) {
    const cell = columns.find(column => column.id === id).cell(row);
    assert.equal(renderToStaticMarkup(cell), `<span title="${exact}">${shown}</span>`);
  }
});

test('market detail titles name received inputs and explicitly mark rounded results', () => {
  const spot = { buckets: [[0, 10, 11, 9, 10, 2, 1], [60, 10, 12, 8, 9.9996, 3, 1]] };
  const perpetual = { buckets: [[0, 10, 11, 9, 10.1, 1, 1], [60, 10, 12, 8, 10, 1, 1]] };
  const stats = coinStats(spot, perpetual);
  const titles = marketDetailTitles(spot, perpetual, stats);
  assert.equal(titles.returnWindowPct, 'result ≈ −0.004 (rounded); close 9.9996 / first close 10');
  assert.equal(titles.rangePct, 'result 50; high 12 / low 8');
  assert.equal(titles.volumeQuote, 'result ≈ 49.9988 (rounded); [close, volume] [[10,2],[9.9996,3]]');
  assert.match(titles.premium, /\[spot close, perpetual close\] \[\[10,10\.1\],\[9\.9996,10\]\]/);
});

test('market detail displays rounded figures with their input titles', () => {
  const { V5MarketDetail } = frontendModules({
    '@/components/charts/RecordedCandleChart': { RecordedCandleChart: () => null },
    '@tanstack/react-query': { useQuery: () => ({ isPending: false, isError: false, data: [] }) },
  }).load('v5/V5MarketDetail.tsx');
  const spot = { buckets: [[0, 10, 11, 9, 10, 2, 1], [60, 10, 12, 8, 9.9996, 3, 1]] };
  const html = renderToStaticMarkup(React.createElement(V5MarketDetail, { coin: 'BTC', color: 'blue', onClose: () => {}, tileRead: { spot, perpetual: null, perpetualError: null } }));
  assert.match(html, /<strong title="result [^"]+; close 9\.9996 \/ first close 10">0\.00%<\/strong>/);
  assert.match(html, /<strong title="result 50; high 12 \/ low 8">50\.00%<\/strong>/);
});
