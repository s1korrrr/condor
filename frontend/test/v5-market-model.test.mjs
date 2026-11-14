import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ageSeconds, breadth, coinStats, coinTile, featureRows, featureText, grid, indexedReturns, premiumSeries, STALE_AFTER_S, storeHealth, venueGrid } from '../src/v5/market-model.mjs';
import { tri, utcMinute } from '../src/v5/shown.mjs';

const T0 = 1_794_474_120; // a minute boundary

/**
 * A contract-valid owner window (condor/v5/candles.py): one row per minute from `start`, prices and volume only on
 * final minutes, `end` = last minute, `now` just after it, `totals` matching the rows. `close(i)` returns a price or
 * null (missing minute); `volume(i)` defaults to 1.
 */
function dense(count, close, volume = () => 1) {
  const buckets = [];
  const totals = { final: 0, no_trade: 0, unrecoverable: 0, missing: 0, pending: 0, corrections: 0 };
  for (let i = 0; i < count; i += 1) {
    const value = close(i);
    if (value == null) { buckets.push([T0 + i * 60, null, null, null, null, null, 0, 0, 0, 1, 0, 0]); totals.missing += 1; }
    else { buckets.push([T0 + i * 60, value, value, value, value, volume(i), 1, 0, 0, 0, 0, 0]); totals.final += 1; }
  }
  const end = T0 + (count - 1) * 60;
  return { buckets, start: T0, end, now: end + 70, totals };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('grid keeps every owner minute; a non-final minute has no price', () => {
  const minutes = grid(dense(3, i => (i === 1 ? null : 100 + i)));
  assert.equal(minutes.length, 3);
  assert.deepEqual(minutes[1], { t: T0 + 60, high: null, low: null, close: null, volume: null });
  assert.equal(grid(null), null);
});

test('tile: window and hour returns need their exact boundary minute', () => {
  // 24h window; the first 23 hours are missing, then a price.
  const late = dense(1440, i => (i >= 1380 ? 100 + (i - 1380) : null));
  const tile = coinTile('BTC', late, null);
  assert.equal(tile.changePct, null);
  assert.equal(tile.change1hPct, null); // the minute 60 before the last close (index 1379) is missing
  assert.equal(tile.heldMinutes, 60);
  assert.equal(tile.windowMinutes, 1440);
  assert.equal(breadth([tile, null]).measured, 0);
  const whole = coinTile('ETH', dense(1440, i => 100 + i / 100), null);
  near(whole.changePct, ((100 + 14.39) / 100 - 1) * 100);
  near(whole.change1hPct, ((100 + 14.39) / (100 + 13.79) - 1) * 100);
  assert.equal(coinTile('X', dense(5, () => null), null), null);
});

test('premium from the newest minute both legs closed, named with that minute; charts keep nulls', () => {
  const spot = dense(120, i => (i < 110 ? 100 : null)); // last ten minutes missing
  const perpetual = dense(120, () => 101);
  const tile = coinTile('BNB', spot, perpetual);
  assert.equal(tile.lastTime, T0 + 109 * 60);
  near(tile.premiumBps, 100);
  assert.equal(tile.premiumTime, T0 + 109 * 60);
  // The perpetual has not finalized the newest spot minute yet: the premium is from the minute before, and says so.
  const lagging = coinTile('BNB', spot, dense(120, i => (i === 108 ? 102 : i === 109 ? null : 101)));
  assert.equal(lagging.lastTime, T0 + 109 * 60);
  assert.equal(lagging.premiumTime, T0 + 108 * 60);
  near(lagging.premiumBps, 200);
  const none = coinTile('BNB', spot, dense(120, () => null));
  assert.equal(none.premiumBps, null);
  assert.equal(none.premiumTime, null);
  const series = premiumSeries(spot, perpetual);
  assert.equal(series.at(-1).value, null);
  assert.ok(series.some(point => point.value != null));
  const returns = indexedReturns(dense(30, i => (i >= 10 && i < 20 ? null : 50 + i)));
  assert.deepEqual(returns.map(point => point.value === null), [false, false, true, true, false, false]);
  // A gap strictly between two sample positions (minute 6, samples at 4 and 9) still breaks the line.
  const between = indexedReturns(dense(10, i => (i === 6 ? null : 100 + i)));
  assert.deepEqual(between.map(point => [(point.time / 1000 - T0) / 60, point.value === null]), [[4, false], [6, true], [9, false]]);
  const premiumGap = premiumSeries(dense(10, () => 100), dense(10, i => (i === 7 ? null : 101)));
  assert.deepEqual(premiumGap.map(point => point.value === null), [false, true, false]);
  assert.deepEqual(indexedReturns(dense(10, i => (i === 0 ? null : 1))), []);
  // The window's last minute still pending: the line ends at the newest minute with a close, as the tile does.
  const pending = indexedReturns(dense(12, i => (i === 11 ? null : 100 + i)));
  assert.deepEqual(pending.map(point => [(point.time / 1000 - T0) / 60, point.value === null]), [[4, false], [9, false], [10, false], [11, true]]);
  near(pending.find(point => (point.time / 1000 - T0) / 60 === 10).value, 10);
  near(coinTile('X', dense(12, i => (i === 11 ? null : 100 + i)), null).changePct, 10);
});

test('age follows the owner clock plus time since the read arrived', () => {
  const read = dense(10, () => 1);
  const received = 1_000_000;
  assert.equal(ageSeconds(read.end, read, received, received), 10);
  assert.ok(ageSeconds(read.end, read, received, received + 10 * 60_000) > STALE_AFTER_S);
  // A local clock behind the read time never makes the price younger than the owner said.
  assert.equal(ageSeconds(read.end, read, received, received - 60_000), 10);
});

test('window statistics: volume and minutes from the full window', () => {
  const sparse = coinStats(dense(60, i => (i >= 58 ? 100 + (i - 58) * 10 : null)), null);
  assert.equal(sparse.volumeQuote, null);
  assert.equal(sparse.volumeMissingMinutes, 58);
  assert.equal(sparse.heldMinutes, 2);
  assert.equal(sparse.windowMinutes, 60);
  assert.equal(sparse.returnWindowPct, null);
  const prices = i => (i <= 60 ? 100 + i : 160 - (i - 60) * 2);
  const full = coinStats(dense(121, prices), dense(121, () => 200));
  near(full.returnWindowPct, (40 / 100 - 1) * 100);
  near(full.return1hPct, (40 / 160 - 1) * 100);
  near(full.maxDrawdownPct, (40 / 160 - 1) * 100);
  assert.equal(full.volumeQuote, dense(121, prices).buckets.reduce((sum, row) => sum + row[4], 0));
  assert.equal(full.premium.minutes, 121);
  const noVolume = coinStats(dense(3, () => 100, () => null), null);
  assert.equal(noVolume.volumeQuote, null);
  assert.equal(noVolume.volumeMissingMinutes, 3);
});

test('breadth counts only measured coins', () => {
  const result = breadth([{ changePct: 2, change1hPct: 1 }, { changePct: -1, change1hPct: null }, null, { changePct: null, change1hPct: -3 }]);
  assert.deepEqual({ ...result, averagePct: Math.round(result.averagePct * 10) / 10 }, { measured: 2, up: 1, measured1h: 2, up1h: 1, averagePct: 0.5 });
});

test('venue grid and store health keep unknown values unknown', () => {
  const tiles = [
    { lane: 'okx__spot', venue: 'okx', segment: 'spot', available: true, pairs_listed: 5, pairs_held: 5, coverage_7d: 1, gaps_7d: 0, last_minute_age_s: 30 },
    { lane: 'okx__perpetual', venue: 'okx', segment: 'perpetual', available: false, pairs_listed: 5, pairs_held: 3, coverage_7d: 0.9, gaps_7d: 12, last_minute_age_s: 90 },
    { lane: 'hyperliquid__perpetual', venue: 'hyperliquid', segment: 'perpetual', available: null, pairs_listed: 5, pairs_held: 5, coverage_7d: null, gaps_7d: null, last_minute_age_s: null },
  ];
  const lanes = venueGrid(tiles);
  assert.deepEqual(lanes.map(row => row.venue), ['hyperliquid', 'okx']);
  assert.equal(lanes[0].spot, null);
  const health = storeHealth(tiles);
  assert.equal(health.lanesLive, 1);
  assert.equal(health.lanesUnknown, 1);
  assert.equal(health.pairsHeld, 13);
  assert.equal(health.coverage7d, null);
  assert.equal(health.gaps7d, null);
  assert.equal(health.oldestMinuteAge, null);
  assert.deepEqual(health.unreported, { pairs: 0, coverage: 1, gaps: 1, age: 1 });
  const reported = storeHealth(tiles.slice(0, 2));
  near(reported.coverage7d, 0.95);
  assert.equal(reported.gaps7d, 12);
  assert.equal(reported.oldestMinuteAge, 90);
  assert.equal(storeHealth([]).coverage7d, null);
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

test('shared display helpers never throw and keep three states', () => {
  assert.equal(utcMinute(Date.UTC(2026, 10, 13, 9, 5)), '2026-11-13 09:05Z');
  assert.equal(utcMinute(1e18), null);
  assert.equal(utcMinute(-1e21), null);
  assert.equal(utcMinute('1'), null);
  assert.equal(utcMinute(NaN), null);
  assert.equal(tri(true, 'clean', 'not clean'), 'clean');
  assert.equal(tri(false, 'clean', 'not clean'), 'not clean');
  assert.equal(tri(null, 'clean', 'not clean'), 'not published');
  assert.equal(tri(undefined, 'a', 'b', 'unknown'), 'unknown');
});
