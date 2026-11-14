import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daily, equityChangeSince, holdReturn, latest, series } from '../src/v5/money-model.mjs';

const T0 = Date.UTC(2026, 10, 14, 0, 0);
const row = (minutes, extra = {}) => ({ bot: 'v5', at_ms: T0 + minutes * 60_000, equity: '100', realized: '1', ...extra });

test('series break at gap rows and at holes longer than two sample intervals', () => {
  const rows = [row(0), row(5, { gap: 'wallet: stale' }), row(10), row(40), { bot: 'helm', at_ms: T0, gap: 'x' }];
  const points = series(rows, 'v5', 'equity');
  assert.deepEqual(points.map(point => point.value), [100, null, 100, null, 100]);
  assert.equal(points[3].time, T0 + 15 * 60_000);
});

test('latest names a gap as newest while keeping the last values', () => {
  const result = latest([row(0, { equity: '99' }), row(5, { gap: 'accounting: degraded' })], 'v5');
  assert.equal(result.newest.gap, 'accounting: degraded');
  assert.equal(result.withValues.equity, '99');
  assert.deepEqual(latest([], 'helm'), { newest: null, withValues: null });
});

test('daily change uses the first and last sample with values and reports coverage', () => {
  const rows = [row(0, { equity: '100', realized: '1' }), row(5, { gap: 'x' }), row(600, { equity: '90', realized: '3' }), row(24 * 60 + 5, { equity: '95' })];
  const [second, first] = daily(rows, 'v5');
  assert.equal(first.equityChange, -10);
  assert.equal(first.realizedChange, 2);
  assert.deepEqual([first.samples, first.gaps], [3, 1]);
  assert.ok(Math.abs(first.coverage - 3 / 288) < 1e-12);
  assert.equal(second.equityChange, 0);
  assert.equal(daily([row(0, { gap: 'x' })], 'v5')[0].equityChange, null);
});

test('holding and equity comparisons need the window start', () => {
  const start = 1_000_000;
  const result = holdReturn({ BTC: [[start, 100], [start + 600, 110]], ETH: [[start + 7200, 50], [start + 7800, 55]], SOL: undefined }, start);
  assert.deepEqual(result.missing, ['ETH', 'SOL']);
  assert.ok(Math.abs(result.pct - 10) < 1e-9);
  assert.equal(holdReturn({}, start).pct, null);
  const rows = [row(0, { equity: '100' }), row(60, { equity: '110' })];
  assert.ok(Math.abs(equityChangeSince(rows, 'v5', T0) - 10) < 1e-9);
  assert.equal(equityChangeSince(rows, 'v5', T0 - 3 * 3_600_000), null);
});
