import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { frontendModules } from './helpers/frontend-module.mjs';
import { breadthTimeline, pressureTone, shareBalance, timelineBucketMinutes, timelineTicks } from '../src/features/market-picture/breadth-timeline.mjs';
import { seriesInRange, zoomSelection } from '../src/features/quant-ops/kit/series.ts';

const base = Date.parse('2026-10-01T00:00:00Z');
const H = ['1', '5', '15', '60', '240', '1440'];
const point = (minute, pressure, extra = {}) => ({
  time: base + minute * 60_000, snapshot_id: `s-${minute}`, valid: 5, expected: 5, membership: 'm', gapBefore: false,
  breadth: Object.fromEntries(H.map(h => [h, { positive: pressure == null ? null : (pressure + 3) / 6, negative: pressure == null ? null : (3 - pressure) / 6, flat: 0, pressure }])),
  ...extra,
});

test('a column is the mean of its own frames and names how many it averaged', () => {
  const timeline = breadthTimeline([point(0, 3), point(1, -3), point(2, 1.8)], H, { maxColumns: 1 });
  assert.equal(timeline.bucketMinutes, 2);
  assert.equal(timeline.columns.length, 2);
  assert.equal(timeline.columns[0].frames, 2);
  assert.equal(timeline.columns[0].cells['60'].pressure, 0, 'mean of +3 and -3');
  assert.equal(timeline.columns[0].time, base + 60_000, 'the column carries its newest frame time');
  assert.equal(timeline.columns[0].first, base);
  assert.equal(timeline.columns[1].cells['60'].pressure, 1.8);
});

test('sampling spacing is bridged but an owner-flagged gap stays empty', () => {
  const samples = [point(0, 3), point(3, 3), point(10, -3, { gapBefore: true })];
  const timeline = breadthTimeline(samples, H, { maxColumns: 20 });
  assert.equal(timeline.bucketMinutes, 1);
  const at = minute => timeline.columns.find(column => column.start === base + minute * 60_000);
  assert.equal(at(1).carried, true, 'a missing minute inside continuous sampling repeats the previous column');
  assert.equal(at(1).time, base, 'a carried column keeps the real time of its frame');
  assert.equal(at(1).frames, 0);
  for (const minute of [4, 5, 9]) assert.equal(at(minute).time, null, `minute ${minute} lies in the retained gap`);
  assert.ok(Object.values(at(5).cells).every(cell => cell === null));
  assert.equal(at(10).gapBefore, true);
  assert.equal(at(10).cells['60'].pressure, -3);
});

test('missing breadth values stay null instead of becoming zero', () => {
  const timeline = breadthTimeline([point(0, null), point(1, 0)], H, { maxColumns: 10 });
  assert.equal(timeline.columns[0].cells['60'].pressure, null);
  assert.equal(timeline.columns[0].cells['60'].positive, null);
  assert.equal(timeline.columns[1].cells['60'].pressure, 0);
  assert.deepEqual(pressureTone(0), { side: 'flat', strength: 0 });
  assert.equal(pressureTone(null), null);
  assert.deepEqual(pressureTone(-1.5), { side: 'down', strength: 0.5 });
});

test('a zoom range clips columns, starts from the latest earlier frame and never changes the samples', () => {
  const samples = Array.from({ length: 120 }, (_, minute) => point(minute, minute % 2 ? 3 : -3));
  const frozen = JSON.stringify(samples);
  const timeline = breadthTimeline(samples, H, { range: [base + 30 * 60_000, base + 60 * 60_000], maxColumns: 40 });
  assert.equal(timeline.bucketMinutes, 1);
  assert.equal(timeline.columns[0].start, base + 30 * 60_000);
  assert.equal(timeline.columns.at(-1).start, base + 60 * 60_000);
  assert.equal(JSON.stringify(samples), frozen);
  assert.equal(breadthTimeline(samples, H, { maxColumns: 40 }).bucketMinutes, 5, 'the full window uses wider buckets');
});

test('coverage markers, counts, buckets and ticks follow their rules', () => {
  const timeline = breadthTimeline([point(0, 3), point(1, 3, { valid: 4 }), point(2, 3, { valid: 4 })], H, { maxColumns: 10 });
  assert.deepEqual(timeline.columns.map(column => column.coverageChanged), [false, true, false]);
  // One of five instruments qualifies on this horizon and advances: the share is 100%, never "5 up".
  assert.equal(shareBalance({ positive: 1, negative: 0, flat: 0, pressure: 3 }), '100% up · 0% down');
  assert.equal(shareBalance({ positive: 0.5, negative: 0.25, flat: 0.25, pressure: 0.75 }), '50% up · 25% down · 25% flat');
  assert.equal(shareBalance(null), 'No observation');
  assert.equal(timelineBucketMinutes(24 * 3_600_000, 160), 10);
  assert.equal(timelineBucketMinutes(7 * 24 * 3_600_000, 180), 60);
  const ticks = timelineTicks([base, base + 6 * 3_600_000], 600);
  assert.ok(ticks.length >= 3 && ticks.every(tick => tick % (30 * 60_000) === 0));
});

test('kit drag-to-zoom accepts a deliberate drag only and fits values to the visible range', () => {
  assert.deepEqual(zoomSelection(50, 10, [0, 100]), [10, 50]);
  assert.equal(zoomSelection(10, 10.5, [0, 100]), null, 'a click is not a zoom');
  assert.deepEqual(zoomSelection(-10, 40, [0, 100]), [0, 40]);
  assert.equal(zoomSelection(1, 2, [5, 5]), null);
  const [series] = seriesInRange([{ id: 'a', label: 'a', color: 'x', points: [{ time: 1, value: 1 }, { time: 5, value: 9 }, { time: 9, value: 3 }] }], [4, 9]);
  assert.deepEqual(series.points.map(point => point.value), [9, 3]);
});

function hero() {
  const calls = [];
  const react = { ...React, useMemo: fn => fn(), useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}] };
  const timeline = () => null;
  const { load } = frontendModules({ react, './BreadthTimeline': { BreadthTimeline: timeline } }, { 'features/market-picture/MarketPulse.tsx': ['PulseDataTable'] });
  const owner = load('features/market-picture/MarketPulse.tsx');
  const history = Array.from({ length: 40 }, (_, minute) => point(minute, 3));
  const props = { frame: null, history, horizon: '60', window: '6h', zoom: [base + 5 * 60_000, base + 9 * 60_000],
    setHorizon: h => calls.push(['horizon', h]), setWindow: w => calls.push(['window', w]), replay: id => calls.push(['replay', id]), onZoom: range => calls.push(['zoom', range]) };
  const walk = function* (node) {
    if (Array.isArray(node)) { for (const item of node) yield* walk(item); return; }
    if (!node || typeof node !== 'object' || !node.props) return;
    yield node; yield* walk(node.props.children);
  };
  const nodes = () => [...walk(owner.MarketPulseHero(props))];
  return { owner, props, calls, nodes, timeline };
}

test('the hero hands the whole window and the zoom to the timeline without dispatching anything', () => {
  const h = hero();
  const chart = h.nodes().find(node => node.type === h.timeline);
  assert.equal(chart.props.samples.length, 40, 'the timeline receives every retained sample in the window');
  assert.deepEqual(chart.props.zoom, h.props.zoom);
  assert.deepEqual(h.calls, []);
  assert.ok(!h.nodes().some(node => node.type === 'input' && node.props.type === 'range'), 'no slider controls remain');
});

test('choosing a window clears the zoom first and the reset chip clears it alone', () => {
  const h = hero();
  const windows = h.nodes().find(node => node.props['aria-label'] === 'History window');
  [...(function* (n) { for (const c of [].concat(n.props.children).flat()) yield c; })(windows)].find(node => node.props.children === '24h').props.onClick();
  assert.deepEqual(h.calls, [['zoom', null], ['window', '24h']]);
  h.calls.length = 0;
  h.nodes().find(node => node.type === 'button' && node.props.className === 'mp-zoom-chip').props.onClick();
  assert.deepEqual(h.calls, [['zoom', null]]);
});

test('a carried column repeats the last recorded frame, never the previous bucket mean', () => {
  // Two-minute buckets: +3 then -3 in the first bucket, nothing in the next, then a frame later.
  const samples = [point(0, 3, { valid: 4 }), point(1, -3, { valid: 4 }), point(6, 3, { valid: 4 })];
  const timeline = breadthTimeline(samples, H, { maxColumns: 4 });
  assert.equal(timeline.bucketMinutes, 2);
  const [mixed, carried] = timeline.columns;
  assert.equal(mixed.cells['60'].pressure, 0, 'the bucket itself shows its labelled mean');
  assert.equal(carried.carried, true);
  assert.equal(carried.cells['60'].pressure, -3, 'the carried column is the latest frame, not the mean');
  assert.equal(carried.time, base + 60_000);
  assert.equal(carried.cells['60'].negative, 1, 'the carried shares are the frame shares');
});

test('a zoomed timeline averages only frames inside the selected range', () => {
  const samples = Array.from({ length: 120 }, (_, minute) => point(minute, minute <= 90 ? 3 : -3));
  const timeline = breadthTimeline(samples, H, { range: [base + 30 * 60_000, base + 90 * 60_000], maxColumns: 12 });
  assert.equal(timeline.bucketMinutes, 5);
  const last = timeline.columns.at(-1);
  assert.equal(last.time, base + 90 * 60_000, 'no frame after the zoom end enters the last column');
  assert.equal(last.cells['60'].pressure, 3);
  assert.equal(timeline.columns[0].first, base + 30 * 60_000, 'no frame before the zoom start is averaged in');
});

test('a bucket never averages across an owner-flagged gap', () => {
  const samples = [point(0, 3), point(4, -3, { gapBefore: true }), point(120, 3)];
  const timeline = breadthTimeline(samples, H, { maxColumns: 24 });
  assert.equal(timeline.bucketMinutes, 5);
  const first = timeline.columns[0];
  assert.equal(first.gapBefore, true);
  assert.equal(first.frames, 1, 'only the frame after the gap is shown');
  assert.equal(first.framesBeforeGap, 1, 'the earlier frame is counted, not hidden');
  assert.equal(first.cells['60'].pressure, -3, 'never the +3/-3 mean of 0');
});
