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
});
