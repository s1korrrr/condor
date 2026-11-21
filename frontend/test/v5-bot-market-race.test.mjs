// The Bot market lane under range switches and refreshes, on the mounted component with the real react-query client and a
// network whose reads finish only when the test says so. A read the browser abandoned can still finish at the owner
// (an aborted request does not free the owner's slot), so the fake network ignores the abort unless a test asks for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import * as ReactQuery from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { frontendModules } from './helpers/frontend-module.mjs';

const browser = new Window({ url: 'https://fixture.invalid/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? browser : browser[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');

const COINS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
const modules = () => frontendModules({ '@tanstack/react-query': ReactQuery, '@/features/quant-ops/kit/charts': { SparkChart: () => null } });
const { readBotMarket, whenNeighboursIdle } = modules().load('v5/market-bot.ts');
const { V5BotMarket } = modules().load('v5/V5MarketBot.tsx');

const minute = () => Math.floor(Date.now() / 60_000) * 60;
/** 60 one-minute candles ending at the last full minute: first close 90, last close `last`; `edit` may blank a bucket. */
function candles(pair, last, edit = buckets => buckets) {
  const end = minute() - 60, start = end - 59 * 60;
  const buckets = Array.from({ length: 60 }, (_, index) => [start + index * 60, null, null, null, index === 59 ? last : 90, null, 1]);
  return { pair, venue: 'okx', volume_unit: 'base', start, end, now: Date.now() / 1000, buckets: edit(buckets) };
}
const symbols = { rows: COINS.map(coin => ({ lane: 'okx__spot', pair: `${coin}-USDC` })) };
const cachedRow = (coin, last) => ({ coin, pair: `${coin}-USDC`, state: 'ok', read: candles(`${coin}-USDC`, last), error: null, receivedAt: Date.now() });

/** Reads wait until released; `release(key)` answers the oldest waiting read for "<range> <pair>". */
function network({ honorAbort = false } = {}) {
  const waiting = new Map(), log = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => new Promise((resolve, reject) => {
    const url = new URL(String(input), 'https://fixture.invalid'), pair = url.searchParams.get('pair');
    const key = `${url.searchParams.get('range')} ${pair}`;
    log.push(key);
    waiting.set(key, [...(waiting.get(key) ?? []), last => resolve({ ok: true, status: 200, json: async () => ({ state: 'AVAILABLE', reason: null, data: candles(pair, last) }) })]);
    if (honorAbort) init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  return { log, restore: () => { globalThis.fetch = original; }, release: async (key, last) => { const answer = waiting.get(key)?.shift(); assert.ok(answer, `no read waiting for ${key}`); await act(async () => { answer(last); await pause(); }); } };
}
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
const settle = () => act(async () => { await pause(); await pause(); });

function mount({ client = new ReactQuery.QueryClient({ defaultOptions: { queries: { retry: false } } }), enabled = true } = {}) {
  client.setQueryData(['v5-bots-candle-symbols'], symbols);
  const container = document.createElement('div');
  const root = createRoot(container);
  const element = (nextRange, nextEnabled = enabled) => React.createElement(ReactQuery.QueryClientProvider, { client }, React.createElement(V5BotMarket, { range: nextRange, enabled: nextEnabled, now: Date.now(), color: Object.fromEntries(COINS.map(coin => [coin, '#888'])), holding: () => null }));
  return {
    client,
    show: async (nextRange, nextEnabled) => { await act(async () => { root.render(element(nextRange, nextEnabled)); }); await settle(); },
    card: coin => container.querySelector(`[data-bot-market="${coin}"]`),
    price: coin => container.querySelector(`[data-bot-market="${coin}"] .v5m-price`)?.textContent ?? null,
    text: coin => container.querySelector(`[data-bot-market="${coin}"]`)?.textContent ?? '',
    unmount: () => act(async () => root.unmount()),
  };
}
const usdc = value => new RegExp(`^${value}(\\.0+)? USDC$`);

test('R1: hold 24h BTC, switch to 1h, hold 1h ETH, release the old 24h BTC: 1h BTC stays at 200', async () => {
  const net = network(), view = mount();
  try {
    await view.show('24h');
    assert.deepEqual(net.log, ['24h BTC-USDC']);
    await view.show('1h');
    assert.deepEqual(net.log, ['24h BTC-USDC', '1h BTC-USDC']);
    await net.release('1h BTC-USDC', 200);
    assert.match(view.price('BTC'), usdc(200), '1h BTC paints at 200');
    assert.equal(net.log.at(-1), '1h ETH-USDC', 'the 1h batch is holding ETH');
    await net.release('24h BTC-USDC', 100); // the abandoned 24h read finishes at the owner
    assert.match(view.price('BTC'), usdc(200), 'the old range does not replace the new one');
    assert.deepEqual(net.log, ['24h BTC-USDC', '1h BTC-USDC', '1h ETH-USDC'], 'the abandoned batch reads nothing more');
    await net.release('1h ETH-USDC', 300);
    for (const coin of ['BNB', 'SOL', 'XRP']) await net.release(`1h ${coin}-USDC`, 400);
    assert.match(view.price('BTC'), usdc(200));
    assert.match(view.price('ETH'), usdc(300));
    for (const coin of COINS) assert.doesNotMatch(view.text(coin), /Reading…/, `${coin} is read`);
  } finally { await view.unmount(); net.restore(); }
});

test('two overlapping batches for one range: the batch that left reads nothing more and never replaces the current one', async () => {
  const net = network(), view = mount();
  try {
    await view.show('24h');       // batch 1 holds BTC
    await view.show('1h');        // batch 1 is abandoned
    await view.show('24h');       // batch 3 starts the same range again while batch 1's read is still out
    assert.deepEqual(net.log, ['24h BTC-USDC', '1h BTC-USDC', '24h BTC-USDC']);
    await net.release('24h BTC-USDC', 100);   // batch 1 (the oldest) finishes first
    assert.equal(view.price('BTC'), null, 'batch 1\'s late read paints nothing: BTC is still being read');
    assert.match(view.text('BTC'), /Reading…/);
    await net.release('24h BTC-USDC', 150);   // batch 3
    assert.match(view.price('BTC'), usdc(150), 'the current batch paints its own read');
    assert.deepEqual(net.log.filter(key => key === '24h ETH-USDC').length, 1, 'only the current batch moves on to ETH');
  } finally { await view.unmount(); net.restore(); }
});

test('an aborted batch publishes nothing, whether its read finishes or fails after the abort', async () => {
  for (const honorAbort of [false, true]) {
    const controller = new AbortController(), painted = [];
    let finish; const read = (_view, _params, signal) => new Promise((resolve, reject) => {
      finish = () => resolve(candles('BTC-USDC', 100));
      if (honorAbort) signal.addEventListener('abort', () => reject(signal.reason));
    });
    const batch = readBotMarket({ range: '24h', symbols, signal: controller.signal, read, onCoin: row => painted.push(row.coin) });
    controller.abort();
    if (!honorAbort) finish();
    await assert.rejects(batch, { name: 'AbortError' });
    assert.deepEqual(painted, [], `nothing painted (read ${honorAbort ? 'failed' : 'finished'} after the abort)`);
  }
});

test('the abort reaches the owner read', async () => {
  const controller = new AbortController(); let seen;
  const batch = readBotMarket({ range: '24h', symbols, signal: controller.signal, read: async (_view, _params, signal) => { seen = signal; controller.abort(); return candles('BTC-USDC', 100); } });
  await assert.rejects(batch);
  assert.equal(seen, controller.signal);
});

test('a refresh keeps the cached coins it has not re-read, and a finished refresh replaces them all', async () => {
  const net = network(), client = new ReactQuery.QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['v5-market', 'bot', '24h'], COINS.map((coin, index) => cachedRow(coin, 10 * (index + 1))));
  const view = mount({ client });
  try {
    await view.show('24h');
    assert.deepEqual(net.log, ['24h BTC-USDC'], 'the cached rows are stale, so the lane refreshes');
    COINS.forEach((coin, index) => assert.match(view.price(coin), usdc(10 * (index + 1)), `${coin} keeps its cached price while the first coin is read`));
    await net.release('24h BTC-USDC', 15);
    assert.match(view.price('BTC'), usdc(15));
    for (const [coin, last] of [['ETH', 20], ['BNB', 30], ['SOL', 40], ['XRP', 50]]) assert.match(view.price(coin), usdc(last), `${coin} keeps its cached price while BTC refreshes`);
    for (const coin of ['ETH', 'BNB', 'SOL', 'XRP']) await net.release(`24h ${coin}-USDC`, 99);
    assert.match(view.price('BTC'), usdc(15));
    for (const coin of ['ETH', 'BNB', 'SOL', 'XRP']) assert.match(view.price(coin), usdc(99), `${coin} shows the finished refresh`);
  } finally { await view.unmount(); net.restore(); }
});

test('a lane that is not enabled reads nothing; once enabled it starts at the first coin', async () => {
  const net = network(), view = mount({ enabled: false });
  try {
    await view.show('24h', false);
    assert.deepEqual(net.log, []);
    assert.match(view.text('BTC'), /Waiting for the Binance view…/);
    await view.show('24h', true);
    assert.deepEqual(net.log, ['24h BTC-USDC']);
  } finally { await view.unmount(); net.restore(); }
});

test('the Market page starts the lane only once the whole Binance view (coins and cross-venue) has settled, cached success or not', async () => {
  const { readFileSync } = await import('node:fs');
  const market = readFileSync(new URL('../src/v5/V5Market.tsx', import.meta.url), 'utf8');
  assert.match(market, /<V5BotMarket range=\{range\} enabled=\{binanceViewSettled\}/);
  assert.match(market, /binanceViewSettled = \(coins\.isSuccess \|\| coins\.isError\) && !coins\.isFetching && !cross\.isPending && !cross\.isFetching;/);
});

function endCard(edit) {
  const row = { coin: 'BTC', pair: 'BTC-USDC', state: 'ok', read: candles('BTC-USDC', 95, edit), error: null, receivedAt: Date.now() };
  const client = new ReactQuery.QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['v5-bots-candle-symbols'], symbols);
  client.setQueryData(['v5-market', 'bot', '24h'], [row]);
  const html = renderToStaticMarkup(React.createElement(ReactQuery.QueryClientProvider, { client }, React.createElement(V5BotMarket, { range: '24h', enabled: true, now: Date.now(), color: {}, holding: () => null })));
  return html.match(/data-bot-market="BTC"[\s\S]*?<\/article>/)[0];
}
const blank = index => buckets => buckets.map((bucket, at) => at === index ? [bucket[0], null, null, null, null, null, 0] : bucket);

test('the card names the end that is missing: a valid opening close, a recent penultimate close and no final minute', () => {
  const html = endCard(blank(59));
  assert.match(html, /24h change unavailable\. A price at the end of the period is missing or unusable\./);
  assert.doesNotMatch(html, /at the start/);
  assert.match(endCard(blank(0)), /A price at the start of the period is missing or unusable\./);
  assert.match(endCard(buckets => blank(59)(blank(0)(buckets))), /Prices at the start and the end of the period are missing or unusable\./);
  assert.match(endCard(buckets => buckets.map((bucket, at) => at === 0 ? [bucket[0], null, null, null, 0, null, 1] : bucket)), /A price at either end of the period is missing or unusable\./, 'both ends present but the change unusable (no positive opening close)');
});

// ---- the Bot lane next to Market's other candle reads -------------------------------------------------------------------
// The whole Market page, mounted, with the real react-query client. Every candle read waits until the test releases it, except the
// summary (answered at once); `inFlight` is what the owner would be serving, `issued` records what was already in flight at each issue.
const marketModules = () => frontendModules({
  '@tanstack/react-query': ReactQuery,
  'react-router-dom': { useParams: () => ({}), useNavigate: () => () => {}, Link: ({ to, children }) => React.createElement('a', { href: to }, children) },
  './api': { v5Api: { profile: async () => ({ readiness: {} }), workspace: async () => ({}) } },
  './usePaperClock': { usePaperClock: () => Date.now() },
  './V5CandleStore': { V5CandleStore: () => null },
  './V5MarketDetail': { V5MarketDetail: () => null },
  './V5MarketFeatures': { V5MarketFeatures: () => null },
  '@/features/quant-ops/kit/charts': { SparkChart: () => null, TimeSeriesChart: () => null },
});
const { V5Market } = marketModules().load('v5/V5Market.tsx');

function marketNetwork() {
  const waiting = [], inFlight = new Set(), issued = [], original = globalThis.fetch;
  let peak = 0;
  globalThis.fetch = (input) => new Promise(resolve => {
    const url = new URL(String(input), 'https://fixture.invalid'), view = url.pathname.split('/').pop(), q = url.searchParams;
    const key = view === 'candles' ? `${q.get('lane')} ${q.get('pair')} ${q.get('range')}` : view === 'cross' ? `cross ${q.get('asset')}` : view;
    const done = data => { inFlight.delete(entry); resolve({ ok: true, status: 200, json: async () => ({ state: 'AVAILABLE', reason: null, data }) }); };
    const entry = { key };
    issued.push({ key, concurrent: [...inFlight].map(item => item.key) });
    inFlight.add(entry);
    peak = Math.max(peak, inFlight.size);
    if (view === 'summary') return void Promise.resolve().then(() => done({ now: Date.now() / 1000, status_age_s: 0, tiles: [] }));
    waiting.push({ key, answer: () => done(view === 'cross' ? { table: [] } : candles(q.get('pair'), 100)) });
  });
  const release = async key => { const index = waiting.findIndex(item => key === undefined || item.key === key); assert.ok(index >= 0, `no read waiting for ${key}`); const [read] = waiting.splice(index, 1); await act(async () => { read.answer(); await pause(); }); };
  return {
    issued, restore: () => { globalThis.fetch = original; },
    get peak() { return peak; }, get waiting() { return waiting.map(item => item.key); },
    release,
    /** Answers the oldest waiting read until none is left, asserting after every step that the owner never serves more than two. */
    drain: async () => { for (let step = 0; waiting.length; step++) { assert.ok(step < 80, 'the reads do not end'); await release(); assert.ok(peak <= 2, `at most 2 candle reads in flight, saw ${peak}`); } },
  };
}

async function mountMarket() {
  const client = new ReactQuery.QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['v5-bots-candle-symbols'], symbols);
  const container = document.createElement('div'), root = createRoot(container);
  await act(async () => { root.render(React.createElement(ReactQuery.QueryClientProvider, { client }, React.createElement(V5Market))); });
  await settle();
  // A Binance refetch (the window regaining focus, or the 60 s interval) is the coins query reading again.
  const refetchBinance = () => act(async () => { void client.refetchQueries({ queryKey: ['v5-market', 'coins'] }); await pause(); });
  return { client, container, refetchBinance, unmount: () => act(async () => root.unmount()) };
}
const binanceBatch = async net => { for (const coin of COINS) for (const lane of ['binance__spot', 'binance__perpetual']) await net.release(`${lane} ${coin}-USDT 24h`); };
const okxReads = net => net.issued.filter(item => item.key.startsWith('okx__spot'));

test('Market: cross-venue BTC pending, Binance view done, then a Binance refetch: the owner never serves more than two reads, and the Bot lane waits', async () => {
  const net = marketNetwork(), view = await mountMarket();
  try {
    await binanceBatch(net);
    await view.refetchBinance();                       // window focus / interval: Binance BTC-USDT reads again
    assert.ok(net.peak <= 2, `at most 2 candle reads in flight, saw ${net.peak}: ${JSON.stringify(net.issued.slice(-4))}`);
    assert.deepEqual(net.waiting, ['cross BTC', 'binance__spot BTC-USDT 24h'], 'cross-venue BTC is pending next to the Binance refetch');
    assert.deepEqual(okxReads(net), [], 'the Bot lane has not started: the Binance view is not settled');
    await net.drain();
    assert.deepEqual(okxReads(net).map(item => item.key), COINS.map(coin => `okx__spot ${coin}-USDC 24h`), 'then the five Bot reads, in order');
    assert.ok(okxReads(net).every(item => item.concurrent.length === 0), 'each Bot read is issued with nothing else of Market in flight');
    assert.ok(net.peak <= 2);
  } finally { await view.unmount(); net.restore(); }
});

test('Market: a Binance refetch that starts while the Bot batch holds a read stops the batch before its next read', async () => {
  const net = marketNetwork(), view = await mountMarket();
  try {
    await binanceBatch(net);
    for (const coin of COINS) await net.release(`cross ${coin}`);
    assert.deepEqual(net.waiting, ['okx__spot BTC-USDC 24h'], 'the Bot lane holds its first read');
    await view.refetchBinance();
    assert.deepEqual(net.waiting, ['okx__spot BTC-USDC 24h', 'binance__spot BTC-USDT 24h']);
    await net.release('okx__spot BTC-USDC 24h');
    assert.deepEqual(net.waiting, ['binance__spot BTC-USDT 24h'], 'ETH-USDC is not issued while the Binance refetch is outstanding');
    await net.drain();
    assert.deepEqual(okxReads(net).map(item => item.key), COINS.map(coin => `okx__spot ${coin}-USDC 24h`));
    assert.deepEqual(okxReads(net).slice(1).map(item => item.concurrent.length), [0, 0, 0, 0], 'every later Bot read starts with Binance and cross idle');
  } finally { await view.unmount(); net.restore(); }
});

test('a Bot batch that waits for the other reads leaves at once when it is aborted, and reads nothing after', async () => {
  const client = new ReactQuery.QueryClient();
  let finish; const held = client.fetchQuery({ queryKey: ['v5-market', 'cross'], queryFn: () => new Promise(resolve => { finish = resolve; }) });
  const controller = new AbortController(), reads = [];
  const batch = readBotMarket({ range: '24h', symbols, signal: controller.signal, before: () => whenNeighboursIdle(client, controller.signal), read: async (_view, params) => { reads.push(params.pair); return candles(params.pair, 100); } });
  await pause();
  assert.deepEqual(reads, [], 'waiting for the cross-venue read');
  controller.abort();
  await assert.rejects(batch, { name: 'AbortError' });
  finish({ table: [] }); await held; await pause();
  assert.deepEqual(reads, [], 'nothing was read after the abort');
});

test('whenNeighboursIdle: the Binance coin reads and the cross-venue read count, other queries do not, and it checks again on every change', async () => {
  const client = new ReactQuery.QueryClient(), signal = new AbortController().signal;
  const other = client.fetchQuery({ queryKey: ['v5-market', 'summary'], queryFn: () => new Promise(() => {}) });
  void other.catch(() => {});
  await whenNeighboursIdle(client, signal);             // an unrelated read does not hold the Bot lane
  const releases = [];
  const hold = key => { const read = client.fetchQuery({ queryKey: key, queryFn: () => new Promise(resolve => releases.push(resolve)) }); return read; };
  const first = hold(['v5-market', 'coins', '24h']), second = hold(['v5-market', 'cross']);
  let idle = false; const wait = whenNeighboursIdle(client, signal).then(() => { idle = true; });
  await pause(); assert.equal(idle, false);
  releases[0](1); await first; await pause(); assert.equal(idle, false, 'the cross-venue read is still in flight');
  releases[1](2); await second; await wait; assert.equal(idle, true);
});

test('readBotMarket waits for `before` ahead of every read, not once per batch; a symbol that is not read waits for nothing', async () => {
  const order = [];
  const rows = await readBotMarket({ range: '24h', symbols: { rows: ['BTC', 'ETH', 'SOL', 'XRP'].map(coin => ({ lane: 'okx__spot', pair: `${coin}-USDC` })) },
    before: async () => { order.push('wait'); }, read: async (_view, params) => { order.push(params.pair); return candles(params.pair, 100); } });
  assert.deepEqual(order, ['wait', 'BTC-USDC', 'wait', 'ETH-USDC', 'wait', 'SOL-USDC', 'wait', 'XRP-USDC'], 'BNB-USDC is missing from the list: no wait, no read');
  assert.equal(rows.length, 5);
});

test('the Bot market hint says the symbol list is read once per session, not per refresh', () => {
  const client = new ReactQuery.QueryClient();
  const html = renderToStaticMarkup(React.createElement(ReactQuery.QueryClientProvider, { client }, React.createElement(V5BotMarket, { range: '24h', enabled: false, now: Date.now(), color: {}, holding: () => null })));
  assert.match(html, /\(5 price reads per refresh; the symbol list is read once per session\)/);
  assert.doesNotMatch(html, /one symbol list per refresh/);
});
