import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { frontendModules } from './helpers/frontend-module.mjs';
import { pulseSeries } from '../src/features/market-picture/pulse.mjs';

const base = Date.parse('2026-10-01T00:00:00Z');
const history = () => Array.from({ length: 40 }, (_, i) => ({
  time: base + i * 60_000, snapshot_id: `snapshot-${i}`, valid: 4, expected: 5,
  membership: i < 20 ? 'before' : 'after', gapBefore: i === 20,
  breadth: Object.fromEntries(['1', '5', '15', '60', '240', '1440'].map(h => [h, {
    positive: i === 24 ? null : 0.5, negative: i === 24 ? null : 0.5,
    pressure: i === 24 ? null : i === 23 ? 0 : i % 2 ? 3 : -3,
  }])),
}));
function* walk(node) {
  if (Array.isArray(node)) { for (const item of node) yield* walk(item); return; }
  if (!node || typeof node !== 'object' || !node.props) return;
  yield node;
  yield* walk(node.props.children);
}
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : '';
function harness() {
  let index = 0;
  const slots = [], calls = [];
  const react = { ...React, useMemo: fn => fn(), useState(initial) {
    const at = index++;
    if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
    return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; }];
  } };
  const chart = () => null;
  const { load } = frontendModules({ react,
    '@/features/quant-ops/kit/useElementWidth': { useElementWidth: () => [() => {}, 800] },
    '@/features/quant-ops/kit/charts': { TimeSeriesChart: chart, SparkChart: () => null },
  }, { 'features/market-picture/MarketPulse.tsx': ['PulseDataTable', 'pulseDataRows'] });
  const owner = load('features/market-picture/MarketPulse.tsx');
  const props = { frame: null, history: history(), horizon: '60', window: '6h',
    setHorizon: h => calls.push(['horizon', h]), setWindow: w => calls.push(['window', w]), replay: id => calls.push(['replay', id]) };
  const render = () => { index = 0; return owner.MarketPulseHero(props); };
  const find = predicate => [...walk(render())].find(predicate);
  const selector = () => find(node => node.type?.name === 'HistoryRangeSelector');
  return { owner, props, render, find, selector, calls,
    chart: () => find(node => node.type === chart),
    table: () => find(node => node.type === owner.PulseDataTable),
    openTable: () => find(node => node.type === 'details').props.onToggle({ currentTarget: { open: true } }),
  };
}

test('chart range filters existing points and its table without changing the source window or observations', () => {
  const h = harness();
  assert.ok(h.selector(), 'the chart has pointer/keyboard range controls');
  const original = pulseSeries(h.props.history, '6h', '60');
  h.selector().props.onChange({ start: 5, end: 26 });
  h.openTable();
  const series = h.chart().props.series;
  const selected = original.smoothed.slice(5, 27);
  assert.deepEqual(series[0].points, selected, 'smoothing is not restarted at the chosen start');
  assert.deepEqual(h.table().props.pressureSeries.points, selected);
  assert.deepEqual(h.table().props.pulse.advancing, series.find(s => s.id === 'advancing').points);
  assert.equal(h.table().props.pulse.bucketMinutes, original.bucketMinutes);
  assert.equal(h.table().props.pulse.label, original.label, 'retained coverage is not relabelled');
  const rows = h.owner.pulseDataRows(h.table().props.pulse.samples, selected,
    h.table().props.pulse.advancing, h.table().props.pulse.declining,
    h.table().props.rawPressureSeries.points);
  assert.equal(rows.find(row => row.time === base + 20 * 60_000 - 1).gap, true);
  assert.equal(rows.find(row => row.time === base + 23 * 60_000).rawPressure, 0);
  assert.equal(rows.find(row => row.time === base + 24 * 60_000).rawPressure, null);
  assert.match(h.table().props.rangeLabel, /2026-10-01T00:05:00.000Z/);
  assert.equal(h.chart().props.markers.length, 1);
  assert.deepEqual(h.calls, [], 'local selection never dispatches H/W, replay or source requests');
  assert.equal(h.props.history.length, 40);
});

test('smoothing retains selected times and gap-only selection keeps explicit gap identity', () => {
  const h = harness();
  assert.ok(h.selector());
  h.selector().props.onChange({ start: 5, end: 26 });
  const before = h.chart().props.series[0].points.map(point => point.time);
  h.find(node => node.type === 'button' && text(node) === 'Raw').props.onClick();
  assert.deepEqual(h.chart().props.series[0].points.map(point => point.time), before);
  const original = pulseSeries(h.props.history, '6h', '60');
  assert.deepEqual(h.chart().props.series[0].points, original.pressure.slice(5, 27));
  const gapIndex = h.selector().props.times.indexOf(base + 20 * 60_000 - 1);
  h.selector().props.onChange({ start: gapIndex, end: gapIndex });
  h.openTable();
  const table = h.table().props;
  const rows = h.owner.pulseDataRows(table.pulse.samples, table.pressureSeries.points, table.pulse.advancing, table.pulse.declining);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gap, true, 'the source gap marker survives even when its following point is outside the view');
  assert.equal(h.chart().props.markers.length, 0);
});

test('history, horizon and requested-window changes reset the view instead of reusing old indexes', () => {
  const h = harness();
  assert.ok(h.selector());
  for (const update of [() => { h.props.history = [...h.props.history, { ...h.props.history.at(-1), time: base + 41 * 60_000, snapshot_id: 'new' }]; },
    () => { h.props.horizon = '15'; }, () => { h.props.window = '24h'; }]) {
    h.selector().props.onChange({ start: 2, end: 6 });
    assert.equal(h.chart().props.series[0].points.length, 5);
    update();
    assert.equal(h.selector().props.range, null);
    assert.equal(h.chart().props.series[0].points.length, h.selector().props.times.length);
  }
  h.selector().props.onChange({ start: 2, end: 6 });
  h.selector().props.onChange(null);
  assert.equal(h.selector().props.range, null);
  assert.equal(h.chart().props.series[0].points.length, h.selector().props.times.length);
});


test('returning to an earlier horizon or window does not revive a reset selection', () => {
  const h = harness();
  for (const key of ['horizon', 'window']) {
    const original = h.props[key];
    h.selector().props.onChange({ start: 2, end: 6 });
    h.props[key] = key === 'horizon' ? '15' : '24h';
    assert.equal(h.selector().props.range, null);
    h.props[key] = original;
    assert.equal(h.selector().props.range, null, 'the earlier selection has been reset, not hidden');
  }
});
