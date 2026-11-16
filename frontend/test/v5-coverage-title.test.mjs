import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

test('cohort and candle-store coverage retain source fractions', () => {
  const { CohortCoverageNotice } = frontendModules({}, { 'v5/V5Pages.tsx': ['CohortCoverageNotice'] }).load('v5/V5Pages.tsx');
  const evidence = { features: { 'spot.asset_coverage_fraction': { status: 'QUALIFIED', value: 0.123456789, unit: 'fraction_0_1' } } };
  const html = renderToStaticMarkup(React.createElement(CohortCoverageNotice, { evidence }));
  assert.match(html, /title="0\.123456789">12\.3%<\/small>/);
  const { columns } = frontendModules({ '@/components/charts/RecordedCandleChart': {} }, { 'v5/V5CandleStore.tsx': ['columns'] }).load('v5/V5CandleStore.tsx');
  const cell = columns.find(column => column.id === 'coverage_1h').cell({ coverage_1h: 0.123456789 });
  assert.equal(renderToStaticMarkup(cell), '<span title="0.123456789">12.35</span>');
  assert.equal(columns.find(column => column.id === 'coverage_1h').value({ coverage_1h: 0.123456789 }), 12.35);
});

test('daily coverage uses an exact slot fraction and names its inputs', () => {
  const { dailyColumns } = frontendModules({}, { 'v5/V5Money.tsx': ['dailyColumns'] }).load('v5/V5Money.tsx');
  const column = dailyColumns.find(entry => entry.id === 'coverage');
  assert.equal(renderToStaticMarkup(column.cell({ valid: 1 })), '<span title="1 / 288 slots; exact percentage ≈ 0.3472 % (rounded)">0%</span>');
});

test('daily equity change tone follows rounded text', () => {
  const { dailyColumns } = frontendModules({}, { 'v5/V5Money.tsx': ['dailyColumns'] }).load('v5/V5Money.tsx');
  const column = dailyColumns.find(entry => entry.id === 'change');
  assert.equal(column.className({ equity_change: '-0.004' }), undefined);
  assert.equal(column.className({ equity_change: '-0.01' }), 'is-down');
  assert.equal(column.className({ equity_change: '0.01' }), 'is-up');
});

test('derived cohort coverage names the exact count ratio', () => {
  const { CohortCoverageNotice } = frontendModules({}, { 'v5/V5Pages.tsx': ['CohortCoverageNotice'] }).load('v5/V5Pages.tsx');
  const features = {
    'spot.assets_expected': { status: 'QUALIFIED', value: 3 },
    'derivatives.matched_assets': { status: 'QUALIFIED', value: 1 },
  };
  const html = renderToStaticMarkup(React.createElement(CohortCoverageNotice, { evidence: { features } }));
  assert.match(html, /title="1 \/ 3; exact percentage ≈ 33\.3333 % \(rounded\)">33\.3%<\/small>/);
});
