import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayCoverage, equityChange, holdReturn, latest, series } from '../src/v5/money-model.mjs';

const T0 = Date.UTC(2026, 10, 14, 0, 0);
const row = (minutes, extra = {}) => ({ bot: 'v5', at_ms: T0 + minutes * 60_000, equity: '100', realized: '1', ...extra });

test('series break at gap rows, rows without the field, and one missed five-minute slot', () => {
  const rows = [row(0), row(5, { gap: 'wallet: stale' }), row(10), row(20), { bot: 'helm', at_ms: T0, gap: 'x' }];
  const points = series(rows, 'v5', 'equity');
  // 10 → 20 misses the 15-minute slot: a null at 15 breaks the line.
  assert.deepEqual(points.map(point => point.value), [100, null, 100, null, 100]);
  assert.equal(points[3].time, T0 + 15 * 60_000);
  // Fable's case: a missing :10–:20 and a row with no equity both stay gaps.
  assert.deepEqual(series([row(0), row(5), row(25, { equity: null }), row(30)], 'v5', 'equity').map(point => point.value), [100, 100, null, null, 100]);
});

test('latest names a gap as newest while keeping the last values', () => {
  const result = latest([row(0, { equity: '99' }), row(5, { gap: 'accounting: degraded' })], 'v5');
  assert.equal(result.newest.gap, 'accounting: degraded');
  assert.equal(result.withValues.equity, '99');
  assert.deepEqual(latest([], 'helm'), { newest: null, withValues: null });
});

test('day coverage counts only slots with values', () => {
  assert.equal(dayCoverage({ valid: 0, samples: 288, gaps: 288 }), 0);
  assert.equal(dayCoverage({ valid: 144 }), 0.5);
  assert.equal(dayCoverage(null), null);
});

test('holding uses only minutes every coin shares, and names them', () => {
  const s = 1_000_000;
  // ETH lacks the first minute: the shared first minute is s+300, never a substitute for s.
  const result = holdReturn({ BTC: [[s, 100], [s + 300, 100], [s + 600, 110]], ETH: [[s + 300, 50], [s + 600, 45]] });
  assert.deepEqual([result.startS, result.endS], [s + 300, s + 600]);
  assert.ok(Math.abs(result.pct - 0) < 1e-9);
  assert.deepEqual(holdReturn({ BTC: [[s, 1], [s + 300, 2]], SOL: undefined }).missing, ['SOL']);
  assert.equal(holdReturn({ BTC: [[s, 1], [s + 300, 2]], ETH: [[s + 600, 1]] }).pct, null);  // no shared minute
  assert.equal(holdReturn({}).pct, null);
});

test('V5 equity change uses its own first and last sample with values', () => {
  const rows = [row(0, { equity: '100' }), row(55, { equity: '105' }), row(60, { gap: 'x' })];
  const result = equityChange(rows, 'v5');
  assert.deepEqual([result.startMs, result.endMs], [T0, T0 + 55 * 60_000]);
  assert.ok(Math.abs(result.pct - 5) < 1e-9);
  assert.equal(equityChange([row(0)], 'v5').pct, null);
});
