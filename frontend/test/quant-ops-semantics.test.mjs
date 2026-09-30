import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules({
  './kit/charts': { BarsChart: () => null, DonutChart: () => null, SparkChart: () => null, TimeSeriesChart: () => null },
  './kit/series': { CHART: {} },
  './kit/grid': { TileGrid: ({ children }) => children },
});
const { Heatmap, LifecycleCounts } = load('features/quant-ops/primitives.tsx');

test('shared heatmap and lifecycle counts expose their actual meaning without cohort percentages', () => {
  const heat = renderToStaticMarkup(React.createElement(Heatmap, { metricLabel: 'Owned exposure', unitLabel: 'marked quote value', rows: ['V2'], columns: ['BTC'], cells: [{ row: 'V2', column: 'BTC', value: 12 }] }));
  assert.match(heat, /Owned exposure by symbol heatmap/);
  assert.match(heat, /Owned exposure by symbol, marked quote value/);
  const counts = renderToStaticMarkup(React.createElement(LifecycleCounts, { stages: [{ stage: 'decisions', count: 42 }, { stage: 'orders', count: 63 }] }));
  assert.match(counts, /Independent lifecycle event counts/);
  assert.match(counts, /42/);
  assert.match(counts, /63/);
  assert.doesNotMatch(counts, /150\.0%|funnel/i);
});
