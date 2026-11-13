import assert from 'node:assert/strict';
import { test } from 'node:test';
import { averaged, breadth, closes, coinStats, coinTile, crossLatest, featureRows, featureText, indexedReturns, premiumSeries, storeHealth, venueGrid } from '../src/v5/market-model.mjs';

// Owner bucket order without a `columns` field (the server forwards only these fields): t, open, high, low, close, volume, ...
const minute = (t, close, high = close, low = close) => [t, close, high, low, close, 1, 1, 0, 0, 0, 0, 0];
const read = rows => ({ buckets: rows });
const T0 = 1_794_474_120;

test('missing minutes are dropped, never read as zero prices', () => {
  const rows = closes(read([minute(T0, 100), [T0 + 60, null, null, null, null, null, 0, 0, 0, 1, 0, 0], minute(T0 + 120, 101)]));
  assert.deepEqual(rows.map(row => row.close), [100, 101]);
});

test('coin tile: change, range, premium and volatility only over adjacent minutes', () => {
  const spot = read([minute(T0, 100, 102, 99), minute(T0 + 60, 101), minute(T0 + 180, 99, 99, 95)]);
  const perpetual = read([minute(T0, 100.1), minute(T0 + 180, 98.95)]);
  const tile = coinTile('BTC', spot, perpetual);
  assert.equal(tile.last, 99);
  assert.ok(Math.abs(tile.changePct - -1) < 1e-9);
  assert.equal(tile.high, 102);
  assert.equal(tile.low, 95);
  assert.ok(Math.abs(tile.premiumBps - (98.95 / 99 - 1) * 1e4) < 1e-9);
  // Two returns exist but one spans a gap, so fewer than 30 adjacent returns: no volatility claim.
  assert.equal(tile.volatilityPct, null);
  assert.equal(coinTile('BTC', read([minute(T0, 1)]), null), null);
});

test('premium uses only minutes where both legs closed', () => {
  const points = premiumSeries(read([minute(T0, 100), minute(T0 + 60, 100)]), read([minute(T0 + 60, 101), minute(T0 + 120, 102)]));
  assert.equal(points.length, 1);
  assert.equal(points[0].time, (T0 + 60) * 1000);
  assert.ok(Math.abs(points[0].value - 100) < 1e-9);
});

test('indexed returns start at zero and averaging keeps window ends', () => {
  const returns = indexedReturns(read([minute(T0, 50), minute(T0 + 60, 55), minute(T0 + 120, 45)]), 1);
  assert.deepEqual(returns.map(point => Math.round(point.value)), [0, 10, -10]);
  assert.deepEqual(averaged([{ time: 1, value: 1 }, { time: 2, value: 3 }, { time: 3, value: null }], 2), [{ time: 2, value: 2 }]);
});

test('breadth counts coins up over the window and over the last hour', () => {
  const hour = 3_600_000;
  const returnsByCoin = { BTC: [{ time: 0, value: 0 }, { time: hour, value: 1 }], ETH: [{ time: 0, value: 0 }, { time: hour, value: -1 }], BNB: [{ time: 0, value: 0 }] };
  const tiles = [{ changePct: 2 }, { changePct: -1 }, null, { changePct: -3 }, null];
  const result = breadth(tiles, returnsByCoin);
  assert.equal(result.coins, 3);
  assert.equal(result.up24h, 1);
  assert.equal(result.up1h, 1);
  assert.equal(result.measured1h, 2);
  assert.ok(Math.abs(result.averagePct - -2 / 3) < 1e-9);
});

test('cross-venue cell is the last owner deviation; a venue with none is absent', () => {
  const view = { series: [
    { venue: 'okx', pair: 'BNB-USDT', close: [[1, 600], [2, 601]], deviation_bps: [[1, 0.5], [2, -1.25]] },
    { venue: 'kucoin', pair: 'BNB-USDT', close: [], deviation_bps: [] },
  ] };
  assert.deepEqual(crossLatest('BNB', view), [{ venue: 'okx', coin: 'BNB', pair: 'BNB-USDT', bps: -1.25, time: 2, close: 601 }]);
  assert.deepEqual(crossLatest('BNB', null), []);
});

test('venue grid and store health keep unknown values unknown', () => {
  const tiles = [
    { lane: 'okx__spot', venue: 'okx', segment: 'spot', available: true, pairs_listed: 5, pairs_held: 5, coverage_7d: 1, gaps_7d: 0, last_minute_age_s: 30 },
    { lane: 'okx__perpetual', venue: 'okx', segment: 'perpetual', available: false, pairs_listed: 5, pairs_held: 3, coverage_7d: 0.9, gaps_7d: 12, last_minute_age_s: 90 },
    { lane: 'hyperliquid__perpetual', venue: 'hyperliquid', segment: 'perpetual', available: true, pairs_listed: 5, pairs_held: 5, coverage_7d: null, gaps_7d: null, last_minute_age_s: null },
  ];
  const grid = venueGrid(tiles);
  assert.deepEqual(grid.map(row => row.venue), ['hyperliquid', 'okx']);
  assert.equal(grid[0].spot, null);
  const health = storeHealth(tiles);
  assert.equal(health.lanesLive, 2);
  assert.equal(health.pairsHeld, 13);
  assert.ok(Math.abs(health.coverage7d - 0.95) < 1e-9);
  assert.equal(health.gaps7d, 12);
  assert.equal(health.oldestMinuteAge, 90);
  assert.equal(storeHealth([]).coverage7d, null);
});

test('window statistics: returns by elapsed time, drawdown from a running peak, traded value', () => {
  const rows = [];
  for (let i = 0; i <= 120; i += 1) rows.push(minute(T0 + i * 60, i <= 60 ? 100 + i : 160 - (i - 60) * 2));
  const stats = coinStats(read(rows), read([minute(T0, 101), minute(T0 + 60, 100)]));
  assert.equal(stats.minutes, 121);
  assert.equal(stats.windowMinutes, 121);
  assert.ok(Math.abs(stats.returnWindowPct - (40 / 100 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(stats.return1hPct - (40 / 160 - 1) * 100) < 1e-9);
  assert.equal(stats.return6hPct, null);
  assert.ok(Math.abs(stats.maxDrawdownPct - (40 / 160 - 1) * 100) < 1e-9);
  // Volume column is 1 base unit per minute, so traded value is the sum of closes.
  assert.equal(stats.volumeQuote, rows.reduce((sum, row) => sum + row[4], 0));
  assert.equal(stats.premium.minutes, 2);
  assert.ok(Math.abs(stats.premium.max - 100) < 1e-9);
  assert.equal(coinStats(read([]), null), null);
});

test('features keep owner units and say when a value is not qualified', () => {
  const rows = featureRows({
    'spot.advancers': { status: 'QUALIFIED', unit: 'asset_count', value: 4 },
    'spot.venue_coverage_fraction': { status: 'QUALIFIED', unit: 'fraction_0_1', value: 0.9 },
    'baseline.composite_score': { status: 'UNAVAILABLE', unit: 'score_unavailable_unbound', value: null },
    'spot.pressure_original_1m': { status: 'QUALIFIED', unit: 'pressure_minus3_to_3', value: '-1.2' },
  });
  assert.deepEqual(rows.map(row => row.group), ['Breadth', 'Breadth', 'Coverage', 'Other']);
  assert.equal(rows.find(row => row.id === 'spot.venue_coverage_fraction').text, '90%');
  assert.equal(rows.find(row => row.id === 'spot.pressure_original_1m').numeric, -1.2);
  assert.equal(rows.find(row => row.id === 'baseline.composite_score').numeric, null);
  assert.equal(featureText(0.0216, 'percent'), '+0.022%');
  assert.equal(featureText(null, 'percent'), '—');
});
