import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { pnlSeries } = frontendModules().load('features/bots/pnl-series.ts');
const now = Date.parse('2026-09-29T10:00:00Z');
const start = now / 1000 - 86_400;
const completePoints = Array.from({ length: 1441 }, (_, index) => ({ timestamp: start + 30 + index * ((86_340) / 1440), identity: 'boot-a', segment: 'a', quote: 'USDC', total_pnl_quote: String(1 + index / 1440) }));
const full = (changes = {}) => ({ source: 'native_mqtt_observer', bot_name: 'v2', range: '1D', coverage_start: start - 60, truncated: false, points: completePoints, ...changes });

test('24h PnL is admitted only for complete, unbroken coverage from one owner', () => {
  const complete = pnlSeries(full(), 'v2', now, '1D');
  assert.equal(complete.change, 1);
  assert.equal(complete.reason, null);

  const partial = pnlSeries(full({ points: full().points.slice(-60), coverage_start: now / 1000 - 3600 }), 'v2', now, '1D');
  assert.equal(partial.points.length, 60, 'partial history remains visible as a chart');
  assert.equal(partial.change, null, 'a one-hour slice cannot be labeled as 24h change');
  assert.match(partial.reason, /complete window coverage/);

  const gap = full({ points: [full().points[0], { ...full().points[2], timestamp: full().points[0].timestamp + 91 }] });
  assert.equal(pnlSeries(gap, 'v2', now, '1D').change, null);
  const ownerChange = full({ points: full().points.map((point, index) => index ? { ...point, identity: 'boot-b' } : point) });
  assert.equal(pnlSeries(ownerChange, 'v2', now, '1D').change, null);
  assert.equal(pnlSeries(full({ range: '1W' }), 'v2', now, '1D').change, null, 'the requested window must match the payload');
});

for (const bad of [null, undefined, '', ' ', false, '0x10', 'NaN', 'Infinity', {}, []]) {
  test(`PnL history rejects invalid persisted money ${JSON.stringify(bad)}`, () => {
    const points = completePoints.map((point, index) => index === 720 ? { ...point, total_pnl_quote: bad } : point);
    const result = pnlSeries(full({ points }), 'v2', now, '1D');
    assert.equal(result.change, null);
    assert.deepEqual(result.points, []);
    assert.match(result.reason, /incompatible/);
  });
}
test('PnL history rejects missing owner identity and out-of-window boundaries', () => {
  for (const changes of [{ identity: '' }, { segment: null }, { quote: '' }]) {
    const points = completePoints.map(point => ({ ...point, ...changes }));
    assert.equal(pnlSeries(full({ points }), 'v2', now, '1D').change, null);
  }
  const points = [{ ...completePoints[0], timestamp: start - 3600 }, ...completePoints];
  assert.equal(pnlSeries(full({ points }), 'v2', now, '1D').change, null);
  assert.equal(pnlSeries(full({ points: [null] }), 'v2', now, '1D').change, null);
});

// The server reads 1W as the last stored sample per UTC five-minute bucket per segment.
const weekStart = now / 1000 - 604_800;
const weekPoints = (from = weekStart, to = now / 1000) => {
  const rows = [];
  for (let bucket = Math.floor(from / 300); bucket * 300 <= to; bucket += 1) {
    const time = Math.min(bucket * 300 + 270, to - 10);
    if (time >= from) rows.push({ timestamp: time, identity: 'boot-a', segment: 'a', quote: 'USDC', total_pnl_quote: String(time - weekStart) });
  }
  return rows;
};
const week = (changes = {}) => ({ source: 'native_mqtt_observer', bot_name: 'v2', range: '1W', bucket_seconds: 300, coverage_start: weekStart - 600, truncated: false, points: weekPoints(), ...changes });

test('bucketed 7d history is continuous at bucket spacing and covers the whole week', () => {
  const result = pnlSeries(week(), 'v2', now, '1W');
  assert.equal(result.reason, null);
  assert.ok(result.points.every(point => point.value !== null), 'bucket spacing is not a sampling gap');
  const rows = week().points;
  assert.equal(result.change, Number(rows.at(-1).total_pnl_quote) - Number(rows[0].total_pnl_quote));
});

test('bucketed 7d history still voids real gaps, owner changes, late starts and mismatched buckets', () => {
  const rows = week().points;
  const gap = rows.filter((_, index) => index !== 1000);
  assert.equal(pnlSeries(week({ points: gap }), 'v2', now, '1W').change, null, 'a missing bucket is a gap');
  assert.ok(pnlSeries(week({ points: gap }), 'v2', now, '1W').points.some(point => point.value === null));
  const segment = rows.map((row, index) => index > 1000 ? { ...row, segment: 'b' } : row);
  assert.equal(pnlSeries(week({ points: segment }), 'v2', now, '1W').change, null);
  const owner = rows.map((row, index) => index > 1000 ? { ...row, identity: 'boot-b', segment: 'b' } : row);
  assert.equal(pnlSeries(week({ points: owner }), 'v2', now, '1W').change, null);
  const late = week({ points: rows.slice(3), coverage_start: rows[3].timestamp });
  assert.equal(pnlSeries(late, 'v2', now, '1W').change, null, 'the first point must fall inside the first bucket');
  assert.equal(pnlSeries(week({ coverage_start: weekStart + 200 }), 'v2', now, '1W').change, null, 'recording that began after the window start is not a full week');
  for (const bucket_seconds of [1800, 60, '300']) assert.match(pnlSeries(week({ bucket_seconds }), 'v2', now, '1W').reason, /identity|invalid/);
  assert.match(pnlSeries(full({ bucket_seconds: 300 }), 'v2', now, '1D').reason, /identity|invalid/, '1D reads are never bucketed');
});
