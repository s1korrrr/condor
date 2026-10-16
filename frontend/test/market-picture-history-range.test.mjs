import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const { historyRangeTimes, normalizeHistoryRange, selectHistoryPoints } = await import('../src/features/market-picture/history-range.mjs');
const { load } = frontendModules({ react: { ...React, useId: () => 'history-range-test' } });
const { HistoryRangeSelector } = load('features/market-picture/HistoryRangeSelector.tsx');

function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== 'object' || !node.props) return;
  yield node;
  yield* walk(node.props.children);
}

const times = [1000, 2000, 3000, 4000];
const points = [
  { time: 1000, value: 0 },
  { time: 2000, value: null, gap: true },
  { time: 3000, value: 2 },
  { time: 4000, value: -1 },
];

test('historyRangeTimes returns sorted unique finite timestamps without changing inputs', () => {
  const series = [
    { points: [{ time: 3000 }, { time: 1000 }, { time: Number.NaN }] },
    { points: [{ time: 2000 }, { time: 3000 }, { time: Infinity }] },
  ];
  const before = structuredClone(series);
  assert.deepEqual(historyRangeTimes(series), [1000, 2000, 3000]);
  assert.deepEqual(series, before);
});

test('normalizeHistoryRange clamps malformed indexes and restores ordered one-point bounds', () => {
  assert.equal(normalizeHistoryRange(times, null), null);
  assert.deepEqual(normalizeHistoryRange(times, { start: -9, end: 99 }), { start: 0, end: 3 });
  assert.deepEqual(normalizeHistoryRange(times, { start: 2.4, end: 1.2 }), { start: 1, end: 2 });
  assert.deepEqual(normalizeHistoryRange(times, { start: 3, end: 0 }), { start: 0, end: 3 });
  assert.deepEqual(normalizeHistoryRange([1000], { start: 0, end: 0 }), { start: 0, end: 0 });
  assert.equal(normalizeHistoryRange([], { start: 0, end: 0 }), null);
  assert.equal(normalizeHistoryRange(times, { start: Number.NaN, end: 2 }), null);
});

test('selectHistoryPoints applies inclusive time bounds and preserves zero, gaps, refs, and source rows', () => {
  const before = structuredClone(points);
  const selected = selectHistoryPoints(points, times, { start: 1, end: 2 });
  assert.deepEqual(selected, [points[1], points[2]]);
  assert.equal(selected[0], points[1]);
  assert.equal(selected[0].value, null);
  assert.equal(selected[1].value, 2);
  assert.deepEqual(selectHistoryPoints(points, times, null), points);
  assert.deepEqual(points, before);
});

test('native controls expose full UTC bounds, clamp crossing handles, reset, and Escape without blur', () => {
  const changed = [];
  const render = range => HistoryRangeSelector({ times, range, onChange: value => changed.push(value) });
  const tree = render(null);
  let nodes = [...walk(tree)];
  const start = nodes.find(node => node.type === 'input' && node.props['aria-label'] === 'Chart range start');
  const end = nodes.find(node => node.type === 'input' && node.props['aria-label'] === 'Chart range end');
  assert.ok(start && end);
  assert.equal(start.props.type, 'range');
  assert.equal(start.props.value, 0);
  assert.equal(start.props.min, 0);
  assert.equal(start.props.max, 3);
  assert.equal(end.props.value, 3);
  assert.equal(end.props.min, 0);
  assert.equal(end.props.max, 3);
  assert.equal(start.props['aria-valuetext'], new Date(times[0]).toISOString());
  assert.equal(end.props['aria-valuetext'], new Date(times[3]).toISOString());
  const markup = renderToStaticMarkup(tree);
  assert.match(markup, /Chart time range/);
  assert.match(markup, /UTC/);
  assert.match(markup, /4 plotted timestamps/);

  start.props.onChange({ currentTarget: { value: '3' } });
  assert.deepEqual(changed.pop(), { start: 3, end: 3 }, 'start cannot pass end; a one-point interval is valid');
  end.props.onChange({ currentTarget: { value: '0' } });
  assert.deepEqual(changed.pop(), { start: 0, end: 0 }, 'end cannot precede start');
  start.props.onKeyDown({ key: 'Escape', preventDefault() {} });
  assert.equal(changed.pop(), null, 'Escape resets the range without requiring a blur');
  const selectedTree = render({ start: 1, end: 2 });
  const reset = [...walk(selectedTree)].find(node => node.type === 'button' && node.props.children === 'Reset range');
  assert.equal(reset.props.disabled, false);
  reset.props.onClick();
  assert.equal(changed.pop(), null);
});

test('range controls disable for fewer than two points and reset when no points exist', () => {
  for (const values of [[], [1000]]) {
    const changed = [];
    const tree = HistoryRangeSelector({ times: values, range: null, onChange: value => changed.push(value) });
    const nodes = [...walk(tree)];
    const controls = nodes.filter(node => node.type === 'input');
    assert.equal(controls.length, 2);
    assert.ok(controls.every(node => node.props.disabled));
    assert.equal(nodes.find(node => node.type === 'button' && node.props.children === 'Reset range').props.disabled, true);
    if (values.length === 0) assert.match(renderToStaticMarkup(tree), /No plotted timestamps/);
  }
});

test('reset stays enabled after restoring the full view so native focus can remain on it', () => {
  const changed = [];
  const render = range => HistoryRangeSelector({ times, range, onChange: value => changed.push(value) });
  const selected = [...walk(render({ start: 1, end: 2 }))];
  const reset = selected.find(node => node.type === 'button' && node.props.children === 'Reset range');
  assert.equal(reset.props.disabled, false);
  reset.props.onClick();
  assert.equal(changed.pop(), null);

  const restored = [...walk(render(null))];
  const stillFocusedReset = restored.find(node => node.type === 'button' && node.props.children === 'Reset range');
  assert.equal(stillFocusedReset.props.disabled, false, 'an idempotent native reset remains focusable after it restores the full range');
  stillFocusedReset.props.onClick();
  assert.equal(changed.pop(), null);
});
