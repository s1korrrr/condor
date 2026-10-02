import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const fleet = load('features/quant-ops/fleet-performance.ts');
const history = load('features/quant-ops/performance-history.ts');

const NOW = Date.parse('2026-10-02T06:00:00Z');
const MIN = 60_000;
const row = (minutesAgo, total, realized, identity, segment, quote = 'USDC') => ({
  timestamp: (NOW - minutesAgo * MIN) / 1000, total_pnl_quote: String(total), realized_pnl_quote: String(realized),
  unrealized_pnl_quote: String(+(total - realized).toFixed(10)), quote, identity, segment,
});
const payload = points => ({ source: 'native_mqtt_observer', bot_name: 'v1', range: '1D', coverage_start: points[0].timestamp, points, truncated: false });
const parse = points => fleet.parseBotHistory(payload(points), 'v1', '1D', NOW + 5_000);

// Backfill rows (segment backfill-v1) cover before recording began and a gap between two live runs.
const joined = [
  row(9, 0, 0, 'backfill:v1', 'backfill-v1'), row(8, 4, 1, 'backfill:v1', 'backfill-v1'),
  row(7, 6, 2, 'live-a', 'seg-a'), row(6, 7, 2, 'live-a', 'seg-a'),
  row(5, 9, 3, 'backfill:v1', 'backfill-v1'), row(4, 12, 5, 'backfill:v1', 'backfill-v1'),
  row(3, 13, 5, 'live-b', 'seg-b'), row(2, 14, 5, 'live-b', 'seg-b'), row(1, 14.5, 5.5, 'live-b', 'seg-b'), row(0, 15, 6, 'live-b', 'seg-b'),
];

test('backfill rows join live runs: one owner, no gap markers, and the window change is last minus first', () => {
  const parsed = history.projectPerformanceHistory(payload(joined), 'v1', NOW + 5_000, '1D');
  assert.equal(parsed.reason, null);
  assert.ok(parsed.points.every(point => point.value !== null), 'no null gap markers between backfill and live rows');
  assert.deepEqual(parsed.owners, [0]);
  assert.equal(parsed.change, 15);
  const bot = parse(joined);
  const window = fleet.fleetWindow([bot], ['v1'], NOW - 86_400_000, NOW, NOW);
  assert.equal(window.total, 15);
  assert.equal(window.realized, 6);
  assert.equal(window.unrealized, 9);
  assert.equal(window.bots[0].restarts, 0);
  assert.equal(fleet.fleetDailyBars([bot], NOW).reduce((sum, day) => sum + day.net, 0), 15);
});

test('two live runs with different owners and no backfill between them stay a boundary', () => {
  const live = [row(60, 5, 1, 'live-a', 'seg-a'), row(50, 6, 1, 'live-a', 'seg-a'), row(40, 0, 0, 'live-b', 'seg-b'), row(0, 3, 1, 'live-b', 'seg-b')];
  const window = fleet.fleetWindow([parse(live)], ['v1'], NOW - 86_400_000, NOW, NOW);
  assert.equal(window.total, 1 + 3);
  assert.equal(window.bots[0].restarts, 1);
});

test('a backfill row never bridges a real time gap larger than the read spacing', () => {
  const sparse = [row(600, 0, 0, 'backfill:v1', 'backfill-v1'), row(0, 3, 1, 'live-a', 'seg-a')];
  const parsed = history.projectPerformanceHistory(payload(sparse), 'v1', NOW + 5_000, '1D');
  assert.equal(parsed.points.filter(point => point.value === null).length, 1);
  assert.equal(parsed.change, null);
});
