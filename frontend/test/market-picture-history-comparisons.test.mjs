import test from 'node:test';
import assert from 'node:assert/strict';
import { historyComparisons } from '../src/features/market-picture/history-comparisons.mjs';

const at = 1_800_000_000_000;
function point(index, changes = {}) {
  return {
    time: at + index * 60_000, snapshot_id: String(index), valid: 10, expected: 10,
    membership: 'cohort', definitionRegistryHash: 'definition', gapBefore: false,
    breadthTrajectory: { '15/15': { level: -0.2, change: 0.1, shareChange: 5,
      velocity: 0.4, acceleration: -0.3, matched: 10, expected: 10, membership: 'matched' } },
    benchmarkReturns: { instrumentId: 'okx:spot:BTC-USDC', quoteAsset: 'USDC',
      definitionId: 'return_pct', definitionHash: 'returns', cutoff: at + index * 60_000,
      values: { '15': 2 }, reasons: { '15': [] } },
    contributions: { '15': { equalReturn: 0, medianReturn: -1, cappedReturn: 0.4,
      valid: 10, expected: 10, startCohortAvailable: true, priorWeightsAvailable: true } },
    breadthDivergence: { '15': { value: 1, provenance: { horizon: 15, interval: 15,
      benchmarkInstrumentId: 'okx:spot:BTC-USDC', definitionId: 'breadth_price_divergence',
      definitionHash: 'divergence', referenceWindowMinutes: 1440 }, matched: 10, expected: 10, membership: 'b'.repeat(64) } },
    ...changes,
  };
}

test('return comparison uses owner percent returns at the same timestamps with real zero', () => {
  const result = historyComparisons([point(0), point(1)], '15', '15', 'returns');
  assert.deepEqual(result.series.map(s => s.id), ['benchmark', 'equal', 'median', 'capped']);
  assert.ok(result.series.every(s => s.unit === '%'));
  assert.deepEqual(result.series[1].points.map(p => p.value), [0, 0]);
  assert.deepEqual(result.rows.map(p => p.values.median), [-1, -1]);
  assert.equal(result.markers.filter(m => m.label.includes('divergence')).length, 2);
});

test('missing frozen cohort never borrows a valid-subset median or capped return', () => {
  const row = point(0);
  row.contributions['15'] = { ...row.contributions['15'], valid: 9, medianReturn: null,
    equalReturn: null, cappedReturn: null };
  const result = historyComparisons([row], '15', '15', 'returns');
  assert.deepEqual(result.series.map(s => s.points[0].value), [2, null, null, null]);
  assert.equal(result.rows[0].coverage, '9/10 · frozen start cohort');
});

test('level, change, share change, velocity and acceleration retain separate units', () => {
  const expected = { level: [-0.2, 'pressure'], change: [0.1, 'pressure change'],
    shareChange: [5, 'pp'], velocity: [0.4, 'pressure/minute'], acceleration: [-0.3, 'pressure/minute²'] };
  for (const [view, [value, unit]] of Object.entries(expected)) {
    const result = historyComparisons([point(0)], '15', '15', view);
    assert.equal(result.series.length, 1);
    assert.equal(result.series[0].unit, unit);
    assert.equal(result.series[0].points[0].value, value);
  }
});

test('retained gaps and changed matched cohorts break lines without altering raw observations', () => {
  const rows = [point(0), point(1), point(3, { gapBefore: true })];
  rows[1].breadthTrajectory['15/15'].membership = 'different-match';
  const result = historyComparisons(rows, '15', '15', 'velocity');
  assert.deepEqual(result.series[0].points.map(p => p.value), [0.4, null, 0.4, null, 0.4]);
  assert.equal(result.rows.length, 3);
  assert.match(result.rows[1].continuity, /cohort/);
  assert.match(result.rows[2].continuity, /gap/);
  assert.deepEqual(rows.map(r => r.breadthTrajectory['15/15'].velocity), [0.4, 0.4, 0.4]);
});

test('legacy divergence without retained provenance is not labeled as observed', () => {
  const row = point(0, { benchmarkReturns: null });
  row.breadthDivergence['15'].provenance = null;
  const result = historyComparisons([row], '15', '15', 'returns');
  assert.equal(result.series[0].points[0].value, null);
  assert.equal(result.markers.length, 0);
  assert.match(result.rows[0].divergence, /Unavailable/);
});

test('divergence without matched coverage cannot become an observed marker', () => {
  for (const value of [0, 1]) {
    const row = point(0);
    row.breadthDivergence['15'] = { ...row.breadthDivergence['15'], value, matched: 0 };
    const result = historyComparisons([row], '15', '15', 'returns');
    assert.equal(result.markers.length, 0);
    assert.match(result.rows[0].divergence, /Unavailable/);
  }
});

test('range selects raw owner points and leaves values and external input unchanged', () => {
  const rows = [point(0), point(1), point(2)];
  const original = structuredClone(rows);
  const result = historyComparisons(rows, '15', '15', 'returns', [rows[1].time, rows[2].time]);
  assert.deepEqual(result.rows.map(row => row.time), [rows[1].time, rows[2].time]);
  assert.deepEqual(result.series[0].points.map(row => row.value), [2, 2]);
  assert.deepEqual(rows, original);
});

test('observed to reconstructed source transitions break the line and stay labeled', () => {
  const result = historyComparisons([point(0, { source_kind: 'observed' }),
    point(1, { source_kind: 'reconstructed' })], '15', '15', 'returns');
  assert.deepEqual(result.series[0].points.map(item => item.value), [2, null, 2]);
  assert.equal(result.rows[1].continuity, 'Source or cohort changed');
});

test('unsupported trajectory horizon is explicit and never silently selects another horizon', () => {
  const result = historyComparisons([point(0)], '1440', '15', 'acceleration');
  assert.equal(result.series[0].points[0].value, null);
  assert.match(result.unavailable, /5m, 15m and 60m/);
  assert.equal(result.markers.length, 0);
});

test('owner-downsampled history stays continuous; only owner-flagged gaps break the lines', () => {
  // A 24h window returns about one point per five minutes; spacing alone is not a gap.
  const rows = [0, 5, 10, 16, 21].map(minute => point(minute));
  const result = historyComparisons(rows, '15', '15', 'returns');
  assert.equal(result.markers.filter(marker => !marker.label.includes('divergence')).length, 0);
  assert.ok(result.series[0].points.every(p => p.value !== null), 'no gap sentinel splits sampled points');
  assert.ok(result.rows.every(row => row.continuity === 'Same retained basis'));
  rows[3].gapBefore = true;
  const gapped = historyComparisons(rows, '15', '15', 'returns');
  assert.equal(gapped.markers.filter(marker => marker.label === 'Retained gap').length, 1);
});
