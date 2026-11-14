import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayCoverage, equityChangeSince, holdReturn, latest, series } from '../src/v5/money-model.mjs';

const T0 = Date.UTC(2026, 10, 14, 0, 0);
const row = (minutes, extra = {}) => ({ bot: 'v5', at_ms: T0 + minutes * 60_000, equity: '100', realized: '1', ...extra });

test('series break at gap rows and at one missed five-minute slot', () => {
  const rows = [row(0), row(5, { gap: 'wallet: stale' }), row(10), row(20), { bot: 'helm', at_ms: T0, gap: 'x' }];
  const points = series(rows, 'v5', 'equity');
  // 10 → 20 misses the 15-minute slot: a null at 15 breaks the line.
  assert.deepEqual(points.map(point => point.value), [100, null, 100, null, 100]);
  assert.equal(points[3].time, T0 + 15 * 60_000);
  // Hourly rows (30 days) use the hourly step: no false breaks between consecutive hours.
  const hourly = [row(0), row(60), row(180)];
  assert.deepEqual(series(hourly, 'v5', 'equity', 3_600_000).map(point => point.value), [100, 100, null, 100]);
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

test('holding needs the whole basket at both window ends', () => {
  const start = 1_000_000, end = start + 7 * 86_400;
  const full = { BTC: [[start, 100], [end, 110]], ETH: [[start + 60, 50], [end - 60, 45]] };
  assert.ok(Math.abs(holdReturn(full, start, end).pct - 0) < 1e-9);
  // A coin with only a start close, or one starting late, makes the comparison unavailable, never a smaller basket.
  const onlyStart = holdReturn({ ...full, SOL: [[start, 10]] }, start, end);
  assert.deepEqual([onlyStart.pct, onlyStart.missing], [null, ['SOL']]);
  assert.equal(holdReturn({ ...full, XRP: [[start + 7200, 1], [end, 2]] }, start, end).pct, null);
  assert.equal(holdReturn({ ...full, BNB: undefined }, start, end).pct, null);
  assert.equal(holdReturn({}, start, end).pct, null);
});

test('equity change needs samples at both ends of the same window', () => {
  const rows = [row(0, { equity: '100' }), row(60, { equity: '110' }), row(120, { gap: 'x' })];
  assert.ok(Math.abs(equityChangeSince(rows, 'v5', T0, T0 + 60 * 60_000) - 10) < 1e-9);
  // The window ends 3 hours after the last valid sample: trailing gaps do not silently shorten it.
  assert.equal(equityChangeSince(rows, 'v5', T0, T0 + 4 * 3_600_000), null);
  assert.equal(equityChangeSince(rows, 'v5', T0 - 3 * 3_600_000, T0 + 60 * 60_000), null);
  assert.equal(equityChangeSince([row(0)], 'v5', T0, T0), null);
});
