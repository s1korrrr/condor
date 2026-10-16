import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

test('benchmark and breadth plots are visible together with separate units and noncolor line keys', () => {
  const { load } = frontendModules();
  const { HistoryComparisons } = load('features/market-picture/HistoryComparisons.tsx');
  const html = renderToStaticMarkup(React.createElement(HistoryComparisons, { samples: [], horizon: '15', range: null }));
  assert.match(html, /Benchmark &amp; cohort returns/);
  assert.match(html, /Breadth trajectory/);
  assert.match(html, /Pressure change/);
  assert.match(html, /stroke-dasharray="6 4"/);
  assert.match(html, /Historical change interval/);
  assert.match(html, /No qualified owner observations/);
});

test('line pattern survives gap segmentation in the shared chart projection', () => {
  const { load } = frontendModules();
  const { projectTimeSeries } = load('features/quant-ops/kit/series.ts');
  const result = projectTimeSeries([{ id:'equal', label:'Equal', color:'blue', dash:'6 4',
    points:[{time:1,value:0},{time:2,value:null},{time:3,value:2}] }]);
  assert.equal(result.keys.length, 2);
  assert.ok(result.keys.every(item => item.series.dash === '6 4'));
  assert.equal(result.keys[0].single.value, 0);
});


test('small breadth derivatives stay distinguishable instead of rounding to one tick value', () => {
  const { load } = frontendModules({}, { 'features/market-picture/HistoryComparisons.tsx': ['signed'] });
  const { signed } = load('features/market-picture/HistoryComparisons.tsx');
  assert.equal(signed(-0.001666666), '-1.67e-3');
  assert.notEqual(signed(-0.00165), signed(-0.00168));
});

test('aligned charts retain a missing edge interval without extending the last value', () => {
  const domains = [], lines = [];
  const pass = ({children}) => children ?? null;
  const recharts = Object.fromEntries(['Area','Bar','CartesianGrid','Cell','ComposedChart','Pie','PieChart','ReferenceDot','ReferenceLine','ResponsiveContainer','Tooltip','YAxis'].map(key=>[key,pass]));
  recharts.XAxis = props => { domains.push(props.domain); return null; };
  recharts.Line = props => { lines.push(props); return null; };
  const {load}=frontendModules({recharts});
  const {TimeSeriesChart}=load('features/quant-ops/kit/charts.tsx');
  renderToStaticMarkup(React.createElement(TimeSeriesChart, {
    series:[{id:'cvd',label:'Cumulative delta',color:'blue',points:[{time:1,value:2},{time:2,value:3},{time:3,value:null}]}],
    timeDomain:[1,3],ariaLabel:'Recorded CVD',
  }));
  assert.deepEqual(domains,[[1,3]],'the missing final interval stays visible on the axis');
  assert.equal(lines.length,1,'only the two real values form the single line');
});
