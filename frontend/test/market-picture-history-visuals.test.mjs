import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const base = Date.parse('2026-10-01T00:00:00Z');
const sample = (minute, { returns = null, trajectory = null } = {}) => ({
  time: base + minute * 60_000, snapshot_id: `s${minute}`, source_kind: 'observed', valid: 5, expected: 5, membership: 'm', definitionRegistryHash: 'd', gapBefore: false,
  breadth: {}, summary: {}, normalizedBreadth: {}, flowHistory: null,
  contributions: returns == null ? {} : { '15': { equalReturn: returns, medianReturn: returns / 2, cappedReturn: null, valid: 5, expected: 5, startCohortAvailable: true, priorWeightsAvailable: false } },
  benchmarkReturns: returns == null ? null : { instrumentId: 'okx:spot:BTC-USDC', quoteAsset: 'USDC', cutoff: base, definitionId: 'r', definitionHash: 'h', values: { '15': returns * 2 }, reasons: {} },
  breadthTrajectory: trajectory == null ? {} : { '15/15': { level: 0.4, change: trajectory, velocity: null, acceleration: null, shareChange: null, matched: 5, expected: 5, membership: 'a'.repeat(64) } },
});

test('the comparison panel renders nothing until the owner retains values', () => {
  const { load } = frontendModules();
  const { HistoryComparisons } = load('features/market-picture/HistoryComparisons.tsx');
  const props = { window: '24h', horizon: '15', zoom: null, onZoom: () => {} };
  assert.equal(renderToStaticMarkup(React.createElement(HistoryComparisons, { ...props, history: [] })), '');
  assert.equal(renderToStaticMarkup(React.createElement(HistoryComparisons, { ...props, history: [sample(0), sample(1)] })), '');
});

test('the returns panel plots returns only; breadth momentum lives in the hero timeline', () => {
  const { load } = frontendModules();
  const { HistoryComparisons } = load('features/market-picture/HistoryComparisons.tsx');
  const props = { window: '24h', horizon: '15', zoom: null, onZoom: () => {} };
  const returnsOnly = renderToStaticMarkup(React.createElement(HistoryComparisons, { ...props, history: [sample(0), sample(1, { returns: 0.5 }), sample(2, { returns: 0.25 })] }));
  assert.match(returnsOnly, /Benchmark &amp; cohort returns/);
  assert.match(returnsOnly, /stroke-dasharray="6 4"/);
  assert.match(returnsOnly, /not retained: Prior-liquidity-capped return/, 'a series without values is named, not drawn');
  assert.doesNotMatch(returnsOnly, /Historical change interval/);
  const both = renderToStaticMarkup(React.createElement(HistoryComparisons, { ...props, history: [sample(0, { returns: 0.5, trajectory: 0.2 }), sample(1, { returns: 0.25, trajectory: -0.1 })] }));
  assert.doesNotMatch(both, /Breadth trajectory/);
  assert.doesNotMatch(both, /Historical change interval/);
  assert.match(both, /Rolling returns/);
});

test('the time axis fits the rows that carry values, not the empty retained edge', async () => {
  const { valuedDomain, historyComparisons } = await import('../src/features/market-picture/history-comparisons.mjs');
  const rows = historyComparisons([sample(0), sample(1), sample(5, { returns: 1 }), sample(9, { returns: 2 }), sample(10)], '15', '15', 'returns');
  assert.deepEqual(valuedDomain(rows), [base + 5 * 60_000, base + 9 * 60_000]);
  assert.equal(valuedDomain(historyComparisons([sample(0)], '15', '15', 'returns')), undefined);
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
