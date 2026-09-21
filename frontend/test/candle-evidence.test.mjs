import test from 'node:test';
import assert from 'node:assert/strict';
import { CandleStore, validateSpotCandle } from '../src/lib/candle-store.ts';

const liveKey = 'candles:server-a:okx:BTC-USDC:1h';
const candle = (timestamp, close = 100, extras = {}) => ({
  timestamp, open: close, high: close, low: close, close, volume: 1, ...extras,
});

function store(now) {
  let clock = now;
  const candles = new CandleStore({ now: () => clock, idleCleanup: false });
  return {
    candles,
    setNow(value) { clock = value; },
    advance(ms) { clock += ms; },
  };
}

test('invalid OHLC never enters the collection', () => {
  const { candles } = store(1_000_000);
  for (const row of [
    { timestamp: 1, open: NaN, high: 2, low: 1, close: 1, volume: 1 },
    { timestamp: 1, open: 1, high: Infinity, low: 1, close: 1, volume: 1 },
    { timestamp: 1, open: 3, high: 2, low: 1, close: 1, volume: 1 },
    { timestamp: 1, open: 1, high: 2, low: 3, close: 1, volume: 1 },
    { timestamp: 1, open: -1, high: 2, low: 1, close: 1, volume: 1 },
    { timestamp: 1, open: 1, high: 2, low: 1, close: 1, volume: -0.1 },
    null,
    12,
  ]) {
    assert.equal(validateSpotCandle(row), null);
    candles.mergeCandles(liveKey, [row]);
  }
  assert.equal(candles.getCandles(liveKey).length, 0);
  assert.equal(candles.getQuality(liveKey).rejected, 8);
  assert.equal(candles.getLastUpdateAge(liveKey), Infinity);
});

test('empty merge and historical backfill cannot clear a stale live clock', () => {
  const harness = store(Date.parse('2026-09-18T12:00:00Z'));
  harness.candles.mergeCandles(liveKey, [candle(1_700_000_000, 101)], 'live');
  harness.advance(3_600_000);
  assert.ok(harness.candles.getLastUpdateAge(liveKey) > 120_000);
  harness.candles.mergeCandles(liveKey, []);
  harness.candles.mergeCandles(liveKey, [candle(1_699_999_000, 90)]);
  assert.ok(harness.candles.getLastUpdateAge(liveKey) > 120_000);
  assert.equal(harness.candles.getCandles(liveKey).length, 2);
  harness.candles.mergeCandles(liveKey, [candle(1_700_000_000, 102)], 'live');
  assert.equal(harness.candles.getLastUpdateAge(liveKey), 0);
  assert.equal(harness.candles.getCandles(liveKey).at(-1).close, 102);
});

test('a live update to an open one-hour bar uses receipt time, not the opening timestamp', () => {
  const opening = Date.parse('2026-09-18T10:00:00Z') / 1000;
  const harness = store(Date.parse('2026-09-18T10:45:00Z'));
  harness.candles.mergeCandles(liveKey, [candle(opening, 50)], 'live');
  assert.equal(harness.candles.getLastUpdateAge(liveKey), 0);
  assert.equal(harness.candles.getCandles(liveKey)[0].timestamp, opening);
});

test('equal-time history that disagrees with a live bar stays a conflict', () => {
  const { candles } = store(1_000);
  candles.mergeCandles(liveKey, [candle(50, 10)], 'live');
  candles.mergeCandles(liveKey, [candle(50, 11)]);
  assert.equal(candles.getCandles(liveKey)[0].close, 10);
  assert.deepEqual(candles.getQuality(liveKey).conflicts, [50]);
  assert.equal(candles.getLastUpdateAge(liveKey), 0);
});

test('no source stays empty and 100 idle identities cannot evict an active subscriber', () => {
  const harness = store(5_000);
  assert.equal(harness.candles.getCandles('').length, 0);
  const active = 'candles:keep:okx:ETH-USDC:1m';
  harness.candles.subscribe(active);
  harness.candles.mergeCandles(active, [candle(1, 3)], 'live');
  for (let i = 0; i < 100; i++) {
    harness.candles.mergeCandles(`candles:idle-${i}:okx:AAA-USDC:1m`, [candle(i + 2, 4)]);
  }
  assert.equal(harness.candles.getCandles(active)[0].close, 3);
  assert.ok(harness.candles.collections.has(active));
  assert.ok(harness.candles.collections.size <= 20);
  harness.advance(11 * 60 * 1000);
  harness.candles._cleanupIdle();
  assert.ok(harness.candles.collections.has(active));
  assert.equal(harness.candles.lastUpdateTime.has(active), true);
  for (const key of harness.candles.collections.keys()) {
    if (key !== active) assert.equal(harness.candles.subscriptions.get(key)?.refCount ?? 0, 0);
  }
  harness.candles.unsubscribe(active);
  harness.candles.dispose();
});
