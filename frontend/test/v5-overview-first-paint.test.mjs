// First paint of the Overview's Money panels, rendered with the real components, the real react-query client and a
// virtual-clock network: every request has a latency, nothing resolves until the test advances the clock, so "time to
// first content" is a deterministic number of virtual milliseconds, not wall time.
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import * as ReactQuery from '@tanstack/react-query';
import * as Router from 'react-router-dom';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'https://fixture.invalid/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? browser : browser[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { frontendModules } = await import('./helpers/frontend-module.mjs');
const { liveMoneyRows } = await import('./helpers/v5-live-money.mjs');

const { V5Overview } = frontendModules({
  '@tanstack/react-query': ReactQuery,
  'react-router-dom': Router,
  '@/features/quant-ops/kit/charts': { BarsChart: () => null, TimeSeriesChart: () => null },
  '@/features/quant-ops/kit/DataTable': { DataTable: ({ rows, label }) => React.createElement('table', { 'aria-label': label, 'data-rows': rows.length }) },
  './V5Helm': { readHelm: () => new Promise(() => {}) },
}).load('v5/V5Overview.tsx');

const COINS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
const [T1, T2] = liveMoneyRows.filter(row => row.bot === 'v5').map(row => row.at_ms);
const T3 = T2 + 300_000;
const gapRow = { bot: 'v5', at_ms: T3, gap: 'OWNER_READ_FAILED', unit: null };
const dayRow = { day: Date.UTC(2026, 10, 19), samples: 3, gaps: 0, valid: 3, equity_start: '199197.63', equity_end: '199057.11', equity_change: '-140.52', realized_change: '114.13', first_at_ms: T1, last_at_ms: T2, equity_valid: 3, equity_first_at_ms: T1, equity_last_at_ms: T2 };
const moneyBody = (rows, daily = [dayRow]) => ({ sampler: true, started_at_ms: T1, now_ms: T2, range: '7d', rows, daily, recorder_errors: { count: 0, last: null, at_ms: null } });
const closes = [[1794219300, 100], [1794824100, 86]];
const candleBody = { state: 'AVAILABLE', reason: null, data: { series: [{ venue: 'binance', lane: 'binance__spot', close: closes }] } };
const profile = { candle_store: { configured: true } };
const reply = body => ({ ok: true, status: 200, json: async () => body });

/** Requests resolve only when the test advances the virtual clock to their due time. */
function network({ money = 40, cross = 250, answer = {} } = {}) {
  let now = 0, seq = 0;
  const pending = [], issued = [];
  const fetch = url => new Promise(resolve => {
    const path = String(url), kind = path.startsWith('/api/v5/money') ? 'money' : path.includes('/candle-store/cross') ? 'cross' : null;
    if (!kind) throw new Error(`Unexpected request ${path}`);
    const coin = new URL(path, 'https://fixture.invalid').searchParams.get('asset');
    issued.push({ kind, coin, at: now });
    pending.push({ due: now + (kind === 'money' ? money : cross), seq: seq++, resolve: () => resolve(answer[kind === 'money' ? 'money' : coin]?.() ?? reply(kind === 'money' ? moneyBody(liveMoneyRows) : candleBody)) });
  });
  return {
    fetch, issued,
    get now() { return now; },
    next() { pending.sort((a, b) => a.due - b.due || a.seq - b.seq); const request = pending.shift(); if (request) { now = Math.max(now, request.due); request.resolve(); } return Boolean(request); },
  };
}

// react-query batches its notifications on a macrotask and React renders after that; a few turns settle both.
const flush = () => act(async () => { for (let turn = 0; turn < 4; turn++) await new Promise(done => setTimeout(done, 0)); });
const find = (root, selector, test) => [...root.querySelectorAll(selector)].find(test);
const holdPanel = () => find(browser.document, 'article.v5m-card', card => card.querySelector('h3')?.textContent === 'Against holding the five coins');
const tile = label => find(holdPanel() ?? browser.document, '.v5m-stat', item => item.firstElementChild.textContent === label);
const day = () => find(browser.document, 'section.v5m-section', section => section.querySelector('h2')?.textContent === 'Day by day');
const percent = label => /[−+]?\d[\d,.]*%/.exec(tile(label)?.querySelector('strong')?.textContent ?? '')?.[0] ?? null;
const hasDays = () => Number(day()?.querySelector('table')?.dataset.rows) > 0;

async function render({ net, seedMoney, profileData = profile }) {
  globalThis.fetch = net.fetch;
  const client = new ReactQuery.QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } } });
  client.setQueryData(['v5-profile'], profileData);
  if (seedMoney) client.setQueryData(['v5-money', '7d'], seedMoney);
  const container = browser.document.createElement('div');
  browser.document.body.append(container);
  const root = createRoot(container);
  const first = {};
  const watch = {
    'Day by day rows': hasDays,
    'V5 side of the comparison': () => percent('V5 wallet equity') !== null,
    'Holding side of the comparison': () => percent('Holding the five coins') !== null,
  };
  const observe = () => { for (const [name, ready] of Object.entries(watch)) if (!(name in first) && ready()) first[name] = net.now; };
  await act(async () => { root.render(React.createElement(ReactQuery.QueryClientProvider, { client }, React.createElement(Router.MemoryRouter, null, React.createElement(V5Overview)))); });
  await flush();
  observe();
  return {
    first, observe, container,
    async runToEnd() { while (net.next()) { await flush(); observe(); } },
    async finish() { await act(async () => root.unmount()); client.clear(); container.remove(); },
  };
}

test('cold start: Day by day and the V5 side paint when Money arrives, the price reads run in parallel', async t => {
  const net = network({ money: 40, cross: 250 });
  const page = await render({ net });
  try {
    assert.match(browser.document.body.textContent, /Reading money samples…/);
    assert.equal(day(), undefined, 'nothing is available yet, so only the loading line is shown');
    await page.runToEnd();
    t.diagnostic(`cold start, first content in virtual ms (Money 40 ms, each price read 250 ms): ${JSON.stringify(page.first)}`);
    assert.deepEqual(page.first, { 'Day by day rows': 40, 'V5 side of the comparison': 40, 'Holding side of the comparison': 250 });
    const crossReads = net.issued.filter(read => read.kind === 'cross');
    assert.deepEqual(crossReads.map(read => read.coin).sort(), [...COINS].sort());
    assert.ok(crossReads.every(read => read.at === crossReads[0].at), `price reads must start together, started at ${crossReads.map(read => read.at)}`);
  } finally { await page.finish(); }
});

test('cached Money paints Day by day and the V5 side at once with their times; only the price read is pending', async t => {
  const net = network({ cross: 250 });
  const page = await render({ net, seedMoney: moneyBody(liveMoneyRows) });
  try {
    t.diagnostic(`cached Money, content already on screen at paint (virtual ms): ${JSON.stringify(page.first)}`);
    const text = browser.document.body.textContent;
    assert.doesNotMatch(text, /Reading money samples…/);
    assert.deepEqual(page.first, { 'Day by day rows': 0, 'V5 side of the comparison': 0 });
    const note = tile('V5 wallet equity').querySelector('small').textContent;
    assert.match(note, new RegExp(`from ${new Date(T1).toISOString().slice(0, 16).replace('T', ' ')}.* to ${new Date(T2).toISOString().slice(0, 16).replace('T', ' ')}`));
    assert.equal(percent('V5 wallet equity'), `−${(Math.abs((199057.11379198655820 - 199197.63587918115820) / 199197.63587918115820) * 100).toFixed(2)}%`);
    assert.equal(percent('Holding the five coins'), null);
    assert.match(tile('Holding the five coins').textContent, /Reading 7 days of prices…/);
    assert.doesNotMatch(note, /same window/, 'sameness is unknown until the prices arrive');
    await page.runToEnd();
    assert.equal(page.first['Holding side of the comparison'], 250);
    assert.match(tile('V5 wallet equity').querySelector('small').textContent, /same window|not the same window/);
  } finally { await page.finish(); }
});

test('a newer gap row is never carried into the comparison; its own end time is shown beside the gap', async () => {
  const net = network();
  const page = await render({ net, seedMoney: moneyBody([...liveMoneyRows, gapRow]) });
  try {
    await page.runToEnd();
    const end = new Date(T2).toISOString().slice(0, 16).replace('T', ' ');
    const note = tile('V5 wallet equity').querySelector('small').textContent;
    assert.match(note, new RegExp(` to ${end}`));
    assert.doesNotMatch(note, new RegExp(new Date(T3).toISOString().slice(0, 16).replace('T', ' ')));
    assert.match(browser.document.body.textContent, /Latest V5 sample at .* is a gap: OWNER_READ_FAILED/);
    assert.match(browser.document.body.textContent, /The newest sample had no values \(OWNER READ FAILED\)/);
    assert.equal(percent('V5 wallet equity'), `−${(Math.abs((199057.11379198655820 - 199197.63587918115820) / 199197.63587918115820) * 100).toFixed(2)}%`);
  } finally { await page.finish(); }
});

test('no recorded samples: Day by day says so, the V5 side is blank, the prices still read', async () => {
  const net = network();
  const page = await render({ net, seedMoney: moneyBody([], []) });
  try {
    assert.match(day().textContent, /No samples yet\./);
    assert.equal(day().querySelector('table'), null);
    assert.equal(percent('V5 wallet equity'), null);
    assert.match(tile('V5 wallet equity').textContent, /fewer than two samples with values in 7 days/);
    await page.runToEnd();
    assert.equal(page.first['Holding side of the comparison'], 250);
    assert.equal(percent('V5 wallet equity'), null);
  } finally { await page.finish(); }
});

test('no candle store: the comparison says so and reads no prices', async () => {
  const net = network();
  const page = await render({ net, seedMoney: moneyBody(liveMoneyRows), profileData: { candle_store: { configured: false } } });
  try {
    await page.runToEnd();
    assert.match(holdPanel().textContent, /No candle store in this deployment/);
    assert.equal(net.issued.filter(read => read.kind === 'cross').length, 0);
  } finally { await page.finish(); }
});

test('a failed price read names the coin and the owner reason; the basket is never reduced and the V5 side stays', async () => {
  const net = network({ answer: { SOL: () => reply({ state: 'UNAVAILABLE', reason: 'owner read timed out', data: null }) } });
  const page = await render({ net, seedMoney: moneyBody(liveMoneyRows) });
  try {
    await page.runToEnd();
    const text = holdPanel().textContent;
    assert.match(text, /could not read 7-day closes for SOL \(owner read timed out\)/);
    assert.doesNotMatch(text, /no 7-day closes for SOL/);
    assert.match(text, /never reduced to fewer coins/);
    assert.equal(percent('Holding the five coins'), null);
    assert.notEqual(percent('V5 wallet equity'), null);
  } finally { await page.finish(); }
});
