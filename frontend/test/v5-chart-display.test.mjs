import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const { TooltipCard, chartAxis, chartTone } = load('features/quant-ops/kit/charts.tsx');

test('chart ticks and tone follow the rounded display without scientific notation', () => {
  assert.equal(chartAxis(-0.0004, true), '0.00');
  assert.equal(chartAxis(-0.004, true), '0.00');
  assert.equal(chartAxis(199330.7), '199,330.70');
  assert.equal(chartTone('0.00', true), undefined);
  assert.equal(chartTone('−0.01', true), 'q-negative');
  assert.equal(chartTone('+0.01', true), 'q-positive');
});

test('chart tooltip retains its exact owner value in a title', () => {
  const html = renderToStaticMarkup(React.createElement(TooltipCard, { title: 'time', rows: [{ key: 'a', label: 'Equity', color: 'blue', value: '0.00', exact: '-0.004' }] }));
  assert.match(html, /<strong title="-0\.004">0\.00<\/strong>/);
});

test('time-series tooltip formats the original decimal and uses its rounded tone', () => {
  const wrap = ({ children }) => React.createElement('div', null, children);
  const names = ['Area', 'Bar', 'CartesianGrid', 'Cell', 'ComposedChart', 'Line', 'Pie', 'PieChart', 'ReferenceArea', 'ReferenceDot', 'ReferenceLine', 'ResponsiveContainer', 'XAxis', 'YAxis'];
  const recharts = Object.fromEntries(names.map(name => [name, wrap]));
  recharts.Tooltip = ({ content }) => content({ active: true, label: 1000 });
  const { TimeSeriesChart } = frontendModules({ recharts }).load('features/quant-ops/kit/charts.tsx');
  const series = [{ id: 'equity', label: 'Equity', color: 'blue', points: [{ time: 1000, value: -0.004, exact: '-0.004' }], format: (_value, exact) => exact === '-0.004' ? '0.00' : 'wrong' }];
  const html = renderToStaticMarkup(React.createElement(TimeSeriesChart, { series, signed: true, ariaLabel: 'Equity' }));
  assert.match(html, /<strong title="-0\.004">0\.00<\/strong>/);
  assert.doesNotMatch(html, /q-negative/);
});
