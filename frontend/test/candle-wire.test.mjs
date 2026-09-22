import test from 'node:test';
import assert from 'node:assert/strict';
import { CandleStore } from '../src/lib/candle-store.ts';

const key = 'candles:v2:okx:BTC-USDC:1h';
const bar = (close, timestamp = 1800000000) => ({ timestamp, open: 100, high: 110, low: 90, close, volume: 1 });
function fixture() {
  let now = 1000;
  const messages = new Set(), connects = new Set(), disconnects = new Set();
  const ws = {
    onMessage: fn => { messages.add(fn); return () => messages.delete(fn); },
    onConnect: fn => { connects.add(fn); return () => connects.delete(fn); },
    onDisconnect: fn => { disconnects.add(fn); return () => disconnects.delete(fn); },
    subscribe() {}, unsubscribe() {},
  };
  const store = new CandleStore({ now: () => now, idleCleanup: false });
  store.attachWs(ws);
  return { store, ws, advance: ms => { now += ms; },
    send: (payload, channel = key) => messages.forEach(fn => fn(channel, payload)),
    connect: () => connects.forEach(fn => fn()), disconnect: () => disconnects.forEach(fn => fn()),
    handlerCount: () => messages.size + connects.size + disconnects.size };
}

for (const source of ['stream', 'rest', 'gecko']) {
  test(`${source} current batches revise an open bar and refresh source receipt`, () => {
    const f = fixture();
    f.send({ type: 'candles', kind: 'live', source, data: [bar(100)] });
    f.advance(60000);
    f.send({ type: 'candles', kind: 'live', source, data: [bar(103)] });
    assert.equal(f.store.getCandles(key)[0].close, 103);
    assert.equal(f.store.getLastUpdateAge(key), 0);
    assert.deepEqual(f.store.getQuality(key).conflicts, []);
    f.advance(10000);
    f.send({ type: 'candles', kind: 'live', source, data: [bar(103)] });
    assert.equal(f.store.getLastUpdateAge(key), 0, 'successful unchanged poll is a current receipt');
    f.store.dispose();
  });
}

test('initial/backfill and legacy unmarked batches never refresh current receipt or replace a live conflict', () => {
  const f = fixture();
  f.send({ type: 'candle_update', candle: bar(103) });
  f.advance(150000);
  for (const extra of [{ kind: 'history', source: 'snapshot' }, { kind: 'history', source: 'backfill' }, {}]) {
    f.send({ type: 'candles', ...extra, data: [bar(101)] });
    assert.equal(f.store.getCandles(key)[0].close, 103);
    assert.equal(f.store.getLastUpdateAge(key), 150000);
  }
  f.send({ type: 'candles', kind: 'live', source: 'rest', data: [bar(90, 1799990000)] });
  assert.equal(f.store.getLastUpdateAge(key), 150000, 'older-only current batch cannot refresh latest series');
  f.store.dispose();
});

test('disconnect/reconnect retains history but needs a new current receipt for each identity', () => {
  const f = fixture(), other = 'candles:v2:okx:ETH-USDC:1h';
  f.send({ type: 'candle_update', candle: bar(103) });
  f.send({ type: 'candle_update', candle: bar(104) }, other);
  f.disconnect();
  assert.equal(f.store.getLastUpdateAge(key), Infinity);
  assert.equal(f.store.getCandles(key)[0].close, 103);
  f.connect();
  f.send({ type: 'candles', kind: 'history', data: [bar(103)] });
  assert.equal(f.store.getLastUpdateAge(key), Infinity);
  f.send({ type: 'candles', kind: 'live', source: 'rest', data: [bar(105)] });
  assert.equal(f.store.getLastUpdateAge(key), 0);
  assert.equal(f.store.getLastUpdateAge(other), Infinity);
  f.store.detachWs(f.ws);
  assert.equal(f.store.getLastUpdateAge(key), Infinity);
  assert.equal(f.handlerCount(), 0);
  f.store.dispose();
});

test('source errors and invalid current updates cannot leave a receipt fresh', () => {
  const f = fixture();
  f.send({ type: 'candle_update', candle: bar(103) });
  f.send({ type: 'error', message: 'stream disconnected' });
  assert.equal(f.store.getLastUpdateAge(key), Infinity);
  f.send({ type: 'candles', kind: 'live', source: 'rest', data: [bar(NaN)] });
  assert.equal(f.store.getLastUpdateAge(key), Infinity);
  f.store.dispose();
});

test('Gecko polling cadence sets a bounded source-specific receipt deadline', () => {
  const f = fixture();
  f.send({ type: 'candles', kind: 'live', source: 'gecko', receipt_max_age_ms: 120000, data: [bar(103)] });
  f.advance(60000);
  assert.equal(f.store.getStaleThreshold(key, 30000), 120000);
  assert.ok(f.store.getLastUpdateAge(key) < f.store.getStaleThreshold(key, 30000));
  f.send({ type: 'candles', kind: 'history', receipt_max_age_ms: 900000, data: [bar(103)] });
  assert.equal(f.store.getStaleThreshold(key, 30000), 120000);
  f.send({ type: 'candle_update', candle: bar(104) });
  assert.equal(f.store.getStaleThreshold(key, 30000), 30000, 'stream resumption restores normal deadline');
  f.send({ type: 'candles', kind: 'live', source: 'gecko', receipt_max_age_ms: Infinity, data: [bar(104)] });
  assert.equal(f.store.getStaleThreshold(key, 30000), 30000, 'unbounded deadline is rejected');
  f.store.dispose();
});
