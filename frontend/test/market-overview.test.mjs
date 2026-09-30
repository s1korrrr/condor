import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules({ './model.mjs': { formatDisplayNumber: (value) => value == null ? '—' : String(value) } });
const { MarketOverview } = load('features/screener/MarketOverview.tsx');

test('participation separates qualifying matches from valid observation coverage', () => {
  const context = {
    schema_version: 'market-context.v1',
    source: { venue: 'okx', lane: 'spot', quote_asset: 'USDC', aligned_count: 1, subscribed_count: 1, completeness: 'complete', interval: '1m' },
    assets: [],
    capabilities: [],
    correlations: { window_returns: 0, summary: { mean_off_diagonal: null, valid_pair_count: 0, pair_count: 0, dense_pair_count: 0 }, edge_threshold_abs: 0.5, matrix: {} },
    breadth: {
      horizons: {},
      participation: {
        rsi_oversold_30: { count: 0, denominator: 5, subscribed_denominator: 5, omitted: 0, percent: 0, reason_codes: [] },
      },
    },
  };
  const html = renderToStaticMarkup(React.createElement(MarketOverview, { context, freshness: 'Recorded candles' }));
  assert.match(html, /0\/5 matches · 5\/5 valid · 0 omitted/);
  assert.doesNotMatch(html, /0\/5 valid · 0 omitted/);
});
