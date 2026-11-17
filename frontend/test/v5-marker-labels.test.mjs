import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { frontendModules } from './helpers/frontend-module.mjs';
import { tradeMarkers } from '../src/v5/bots-chart-model.mjs';
import { reconcileFills } from '../src/v5/trades-model.mjs';

const buckets = [
  [60, 101.123456789, 102.123456789, 100.123456789, 101.123456789, 0.123456789, 1, 0, 0, 0, 0, 0],
  [120, 103, 105, 102, 104, 2, 1, 0, 0, 0, 0, 0],
];
const fills = [
  { time: 60, event_at_ms: 61023, side: 'BUY', quantity: '0.000000000000000001', price: '101.1234567890123456789' },
  { time: 60, event_at_ms: 62987, side: 'SELL', quantity: '1.234567890123456789', price: '102.9876543210987654321' },
];
const lines = [
  'BUY 0.000000000000000001 @ 101.1234567890123456789 · 1970-01-01T00:01:01.023Z',
  'SELL 1.234567890123456789 @ 102.9876543210987654321 · 1970-01-01T00:01:02.987Z',
];
const titles = [
  'BUY ≈ 0 (rounded) @ ≈ 101.123456789012 (rounded) · 1970-01-01T00:01:01.023Z',
  'SELL ≈ 1.234567890123 (rounded) @ ≈ 102.987654321099 (rounded) · 1970-01-01T00:01:02.987Z',
];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : (node?.children ?? []).map(text).join('');

async function withChart(check, markerFills = fills) {
  let markers, crosshair, renderer;
  const { RecordedCandleChart } = frontendModules({
    'lightweight-charts': { CandlestickSeries: {}, ColorType: { Solid: 'solid' }, LineStyle: { Dashed: 2 },
      createChart: () => ({ addSeries: () => ({ setData() {} }), subscribeCrosshairMove(callback) { crosshair = callback; }, timeScale: () => ({ fitContent() {} }), remove() {} }),
      createSeriesMarkers: (_series, value) => { markers = value; } },
    '@/hooks/useTheme': { useTheme: () => ({ theme: 'dark' }) },
    '@/lib/theme-colors': { getThemeColors: () => ({ up: 'green', down: 'red' }) },
  }).load('components/charts/RecordedCandleChart.tsx');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => { renderer = create(React.createElement(RecordedCandleChart, { buckets, label: 'BNB', volumeUnit: 'BNB', markers: markerFills }), { createNodeMock: node => node.type === 'div' ? {} : null }); });
    await check({ markers, renderer, hover: async time => { await act(async () => crosshair({ time })); }, readout: () => renderer.root.findByProps({ 'aria-live': 'polite' }) });
  } finally {
    await act(async () => renderer?.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
}

test('fill arrows have no always-on text and preserve minute, price, side and colour', async () => {
  await withChart(({ markers }) => {
    assert.deepEqual(markers.map(({ time, price, position, shape, color }) => ({ time, price, position, shape, color })), [
      { time: 60, price: Number(fills[0].price), position: 'atPriceBottom', shape: 'arrowUp', color: 'green' },
      { time: 60, price: Number(fills[1].price), position: 'atPriceTop', shape: 'arrowDown', color: 'red' },
    ]);
    assert.ok(markers.every(marker => !marker.text), 'fill arrows must have no always-on text');
  });
});

test('hovering one minute shows formatted fill lines with bounded owner titles', async () => {
  await withChart(async ({ hover, readout }) => {
    await hover(60);
    assert.deepEqual(readout().findAll(node => node.type === 'span' && node.props.className === 'block').map(text), lines);
    assert.deepEqual(readout().findAll(node => node.type === 'span' && node.props.className === 'block').map(node => node.props.title), titles);
    assert.match(text(readout()), /O 101\.12.*H 102\.12.*L 100\.12.*C 101\.12.*Volume 0\.123457 BNB/);
  });
});

test('moving from a fill minute to an empty minute leaves only its OHLC readout', async () => {
  await withChart(async ({ hover, readout }) => {
    await hover(60);
    assert.ok(text(readout()).includes(lines[0]), 'the starting minute must show its fill before moving away');
    await hover(120);
    assert.equal(text(readout()), '1970-01-01T00:02:00.000Z · Final · O 103.00 · H 105.00 · L 102.00 · C 104.00 · Volume 2 BNB');
  });
});

test('the title retains every fill under the shared owner rule while arrows carry no labels', async () => {
  await withChart(({ renderer, markers }) => {
    assert.equal(renderer.root.findByProps({ role: 'img' }).props.title, titles.join(' · '));
    assert.ok(markers.every(marker => !marker.text), 'the title carries exact details without always-on arrow labels');
  });
});

test('same-minute same-price same-side fills retain distinct ids and exact hover lines after duplicate reconciliation', async () => {
  const first = { executor_id: 'collision-executor', order_id: 'collision-order', trade_id: 'trade-a', trading_pair: 'BNB-USDC', side: 'BUY', event_at_ms: 61023, quantity: '0.1', price: '100.00' };
  const second = { ...first, trade_id: 'trade-b', event_at_ms: 62987, quantity: '0.2' };
  const reconciled = reconcileFills([first, first, second]);
  assert.equal(reconciled.conflicts, 0);
  assert.equal(reconciled.withheldExecutors.size, 0);
  const mapped = tradeMarkers(reconciled.fills, 'BNB-USDC', 60, 120, buckets);
  const exactLines = [
    'BUY 0.1 @ 100.00 · 1970-01-01T00:01:01.023Z',
    'BUY 0.2 @ 100.00 · 1970-01-01T00:01:02.987Z',
  ];
  await withChart(async ({ markers, hover, readout, renderer }) => {
    assert.equal(markers.length, 2, 'the repeated A fill must not hide the distinct B fill');
    assert.deepEqual(markers.map(marker => marker.id), exactLines);
    assert.equal(new Set(markers.map(marker => marker.id)).size, 2);
    for (const marker of markers) {
      assert.equal(marker.time, 60);
      assert.equal(marker.price, 100);
      assert.equal(marker.position, 'atPriceBottom');
      assert.equal(marker.shape, 'arrowUp');
      assert.ok(!marker.text, 'colliding arrows must have no always-on text');
    }
    await hover(60);
    assert.deepEqual(readout().findAll(node => node.type === 'span' && node.props.className === 'block').map(text), exactLines);
    assert.equal(renderer.root.findByProps({ role: 'img' }).props.title, exactLines.join(' · '));
  }, mapped.markers);
});
