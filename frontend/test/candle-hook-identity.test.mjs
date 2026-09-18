import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Executes the actual hook with a deterministic hook/store harness, not a browser or React renderer.
const source = stripTypeScriptTypes(readFileSync(new URL('../src/hooks/useCandleStore.ts', import.meta.url), 'utf8'))
  .replace(/^import .* from "(?:react|@\/lib\/candle-store)";\n/gm, '')
  .replace('export function useCandleStore', 'function useCandleStore');
const initial = ['server-a', 'exchange', 'BTC-USD', '1m'];
const channel = args => `candles:${args.join(':')}`;
const candle = close => ({ timestamp: 1800000000, open: close, high: close, low: close, close, volume: 1 });
function harness() {
  const slots = [], effects = [], pending = [], data = new Map(), ages = new Map(), listeners = new Map(), timers = new Map();
  const subscriptions = [], unsubscriptions = [], merges = [], durations = [];
  let cursor = 0, timerId = 0, args = initial;
  const useState = init => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init;
    return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
  };
  const useRef = init => { const [ref] = useState(() => ({ current: init })); return ref; };
  const useEffect = (setup, deps) => {
    const i = cursor++;
    if (!effects[i] || deps.some((value, j) => !Object.is(value, effects[i].deps[j]))) {
      pending.push(() => { effects[i]?.cleanup?.(); effects[i] = { deps, cleanup: setup() }; });
    }
  };
  const candleStore = {
    subscribe: key => { subscriptions.push(key); return data.get(key) ?? []; },
    unsubscribe: key => unsubscriptions.push(key),
    onUpdate: (key, listener) => { listeners.set(key, listener); return () => listeners.delete(key); },
    getLastUpdateAge: key => ages.get(key) ?? Infinity,
    mergeCandles: (key, rows) => merges.push([key, rows]),
    setDuration: (key, seconds) => durations.push([key, seconds]),
  };
  const hook = vm.runInNewContext(`${source}\nuseCandleStore`, {
    useState, useRef, useEffect, candleStore,
    setInterval: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearInterval: id => timers.delete(id),
  });
  const render = (next = args) => { args = next; cursor = 0; return hook(...args); };
  const flush = () => { for (const run of pending.splice(0)) run(); return render(); };
  return { render, flush, listeners, timers, subscriptions, unsubscriptions, merges, durations,
    seed: (key, rows, age = 0) => { data.set(key, rows); ages.set(key, age); },
    age: (key, age) => ages.set(key, age),
    unmount: () => { effects.forEach(effect => effect?.cleanup?.()); },
  };
}
for (const [name, index, value] of [['server', 0, 'server-b'], ['connector', 1, 'other'], ['pair', 2, 'ETH-USD'], ['interval', 3, '5m']]) {
  test(`${name} switch hides the old series before effects and after an empty subscription`, () => {
    const h = harness(); h.seed(channel(initial), [candle(100)]);
    h.render(); assert.equal(h.flush().candles[0].close, 100);
    const next = [...initial]; next[index] = value;
    assert.equal(h.render(next).candles.length, 0);
    const result = h.flush(); assert.equal(result.candles.length, 0); assert.equal(result.isStale, true);
    h.unmount();
  });
}
test('no server hides the prior series synchronously', () => {
  const h = harness(); h.seed(channel(initial), [candle(100)]); h.render(); h.flush();
  const result = h.render([null, ...initial.slice(1)]);
  assert.equal(result.candles.length, 0); assert.equal(result.isStale, false);
  const empty = h.flush().candles; assert.equal(empty, h.render().candles); h.unmount();
});
test('cached target series replaces the previous source without mixing values', () => {
  const h = harness(), next = [...initial]; next[2] = 'ETH-USD';
  h.seed(channel(initial), [candle(100)]); h.seed(channel(next), [candle(200)]);
  h.render(); h.flush(); h.render(next);
  const result = h.flush(); assert.equal(result.candles.length, 1); assert.equal(result.candles[0].close, 200); h.unmount();
});
test('stale cached data is marked stale immediately, before the periodic timer', () => {
  const h = harness(); h.seed(channel(initial), [candle(100)], 30001);
  h.render(); assert.equal(h.flush().isStale, true); h.unmount();
});
test('data age still expires and a current update recovers', () => {
  const h = harness(); h.seed(channel(initial), [candle(100)]); h.render(); h.flush();
  h.age(channel(initial), 30001); h.timers.forEach(fn => fn()); assert.equal(h.render().isStale, true);
  h.age(channel(initial), 0); h.listeners.get(channel(initial))([candle(101)]);
  const result = h.render(); assert.equal(result.isStale, false); assert.equal(result.candles[0].close, 101); h.unmount();
});
test('cleaned-up callbacks cannot overwrite a subsequent subscription to the same key', () => {
  const h = harness(); h.seed(channel(initial), [candle(100)]); h.render(); h.flush();
  const old = h.listeners.get(channel(initial)), next = [...initial]; next[2] = 'ETH-USD';
  h.render(next); h.flush(); h.render(initial); h.flush(); old([candle(999)]);
  assert.equal(h.render().candles[0].close, 100); h.unmount();
});
test('cleanup balances subscriptions and removes timers; writes keep their source identity', () => {
  const h = harness(); h.render(); const result = h.flush();
  result.mergeCandles([candle(100)]); result.setDuration(3600);
  assert.equal(h.merges[0][0], channel(initial)); assert.equal(h.durations[0][0], channel(initial));
  h.unmount(); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
  assert.equal(h.subscriptions.length, h.unsubscriptions.length);
});
