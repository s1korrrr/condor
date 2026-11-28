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
const BUCKET_A = 1794219300, BUCKET_B = 1794824100; // seconds: the candle owner's bucket opening times
const candleBody = { state: 'AVAILABLE', reason: null, data: { series: [{ venue: 'binance', lane: 'binance__spot', close: [[BUCKET_A, 100], [BUCKET_B, 86]] }] } };
const profile = { candle_store: { configured: true } };
const reply = body => ({ ok: true, status: 200, json: async () => body });
const minute = ms => { const date = new Date(ms); return `${date.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`; };
const v5Change = `−${(Math.abs((199057.11379198655820 - 199197.63587918115820) / 199197.63587918115820) * 100).toFixed(2)}%`;

/**
 * Requests resolve only when the test advances the virtual clock to their due time. With `owner`, price reads go
 * through two shared slots with a caller deadline taken before admission. Browser abort and an expired caller
 * deadline do not release a slot held by the owner.
 */
function network({ money = 40, cross = 250, answer = {}, owner = null } = {}) {
  let now = 0, seq = 0, inFlight = 0, maxInFlight = 0; // price reads only
  const pending = [], issued = [], signals = [], slots = [0, 0], ownerReads = [];
  const activeAt = time => ownerReads.filter(({ start, finish }) => start <= time && time < finish).length;
  const fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const path = String(url), kind = path.startsWith('/api/v5/money') ? 'money' : path.includes('/candle-store/cross') ? 'cross' : null;
    if (!kind) throw new Error(`Unexpected request ${path}`);
    const coin = new URL(path, 'https://fixture.invalid').searchParams.get('asset');
    issued.push({ kind, coin, at: now });
    signals.push(init.signal);
    let due = now + (kind === 'money' ? money : cross), timedOut = false;
    if (owner && kind === 'cross') {
      const slot = slots.indexOf(Math.min(...slots)), start = Math.max(now, slots[slot]);
      if (start - now >= owner.deadline) { due = now + owner.deadline; timedOut = true; }
      else {
        const finish = slots[slot] = start + owner.service;
        ownerReads.push({ start, finish });
        pending.push({ due: finish, seq: seq++, resolve() {} });
        due = Math.min(finish, now + owner.deadline);
        timedOut = due < finish;
      }
    }
    const counted = kind === 'cross' ? 1 : 0;
    inFlight += counted; maxInFlight = Math.max(maxInFlight, inFlight);
    const entry = { due, seq: seq++, resolve: () => { inFlight -= counted; resolve(timedOut ? reply({ state: 'UNAVAILABLE', reason: 'owner_unreachable', data: null }) : answer[kind === 'money' ? 'money' : coin]?.() ?? reply(kind === 'money' ? moneyBody(liveMoneyRows) : candleBody)); } };
    pending.push(entry);
    init.signal?.addEventListener('abort', () => { const index = pending.indexOf(entry); if (index >= 0) { pending.splice(index, 1); inFlight -= counted; reject(init.signal.reason); } });
  });
  return {
    fetch, issued, signals,
    get now() { return now; },
    get maxInFlight() { return maxInFlight; },
    get ownerInFlight() { return activeAt(now); },
    get maxOwnerInFlight() { return Math.max(0, ...ownerReads.map(({ start }) => activeAt(start))); },
    next() { pending.sort((a, b) => a.due - b.due || a.seq - b.seq); const request = pending.shift(); if (request) { now = Math.max(now, request.due); request.resolve(); } return Boolean(request); },
  };
}

// react-query batches its notifications on a macrotask and React renders after that; a few turns settle both.
const flush = () => act(async () => { for (let turn = 0; turn < 4; turn++) await new Promise(done => setTimeout(done, 0)); });
const find = (root, selector, test) => [...root.querySelectorAll(selector)].find(test);
const holdPanel = () => find(browser.document, 'article.v5m-card', card => card.querySelector('h3')?.textContent === 'Against holding the five coins');
const tile = label => find(holdPanel() ?? browser.document, '.v5m-stat', item => item.firstElementChild.textContent === label);
const note = label => tile(label)?.querySelector('small')?.textContent;
const day = () => find(browser.document, 'section.v5m-section', section => section.querySelector('h2')?.textContent === 'Day by day');
const percent = label => /[−+]?\d[\d,.]*%/.exec(tile(label)?.querySelector('strong')?.textContent ?? '')?.[0] ?? null;
const hasDays = () => Number(day()?.querySelector('table')?.dataset.rows) > 0;
const crossReads = net => net.issued.filter(read => read.kind === 'cross');

async function render({ net, seedMoney, profileData = profile, existingClient }) {
  globalThis.fetch = net.fetch;
  const client = existingClient ?? new ReactQuery.QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } } });
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
  let mounted = true;
  await act(async () => { root.render(React.createElement(ReactQuery.QueryClientProvider, { client }, React.createElement(Router.MemoryRouter, null, React.createElement(V5Overview)))); });
  await flush();
  observe();
  return {
    first, observe, client,
    async runToEnd() { while (net.next()) { await flush(); observe(); } },
    async refresh() { await act(async () => { browser.document.querySelector('.v5m-refresh').click(); }); await flush(); },
    async leave() { if (mounted) { mounted = false; await act(async () => root.unmount()); } },
    async finish() { await this.leave(); client.clear(); container.remove(); },
  };
}

test('cold start: Day by day and the V5 side paint when Money arrives; the price reads go two at a time', async t => {
  const net = network({ money: 40, cross: 250 });
  const page = await render({ net });
  try {
    assert.match(browser.document.body.textContent, /Reading money samples…/);
    assert.equal(day(), undefined, 'nothing is available yet, so only the loading line is shown');
    await page.runToEnd();
    t.diagnostic(`cold start, first content in virtual ms (Money 40 ms, each price read 250 ms): ${JSON.stringify(page.first)}`);
    assert.deepEqual(page.first, { 'Day by day rows': 40, 'V5 side of the comparison': 40, 'Holding side of the comparison': 750 });
    assert.deepEqual(crossReads(net).map(read => read.coin).sort(), [...COINS].sort());
    assert.deepEqual(crossReads(net).map(read => read.at), [0, 0, 250, 250, 500], 'the first two start together, each next one when a slot frees');
    assert.ok(net.maxInFlight <= 2, `at most two price reads at once, saw ${net.maxInFlight}`);
  } finally { await page.finish(); }
});

test('the owner serves two reads at a time: five slow price reads all complete and no coin is dropped', async t => {
  // Each read takes 5 s; the owner times a read out 12 s after it was asked for, whether or not it has a slot yet.
  const net = network({ cross: 5000, owner: { service: 5000, deadline: 12_000 } });
  const page = await render({ net, seedMoney: moneyBody(liveMoneyRows) });
  try {
    await page.runToEnd();
    t.diagnostic(`slow owner reads, first content in virtual ms: ${JSON.stringify(page.first)}`);
    assert.equal(page.first['Holding side of the comparison'], 15_000);
    assert.equal(percent('Holding the five coins'), '−14.00%');
    assert.doesNotMatch(holdPanel().textContent, /could not read|owner_unreachable/);
    assert.ok(net.maxInFlight <= 2);
  } finally { await page.finish(); }
});

test('cached Money paints Day by day and the V5 side at once with their times; only the price read is pending', async t => {
  const net = network({ cross: 250 });
  const page = await render({ net, seedMoney: moneyBody(liveMoneyRows) });
  try {
    t.diagnostic(`cached Money, content already on screen at paint (virtual ms): ${JSON.stringify(page.first)}`);
    assert.doesNotMatch(browser.document.body.textContent, /Reading money samples…/);
    assert.deepEqual(page.first, { 'Day by day rows': 0, 'V5 side of the comparison': 0 });
    assert.match(note('V5 wallet equity'), new RegExp(`^from ${new Date(T1).toISOString().slice(0, 16).replace('T', ' ')}.* to ${new Date(T2).toISOString().slice(0, 16).replace('T', ' ')}`));
    assert.equal(percent('V5 wallet equity'), v5Change);
    assert.equal(percent('Holding the five coins'), null);
    assert.match(tile('Holding the five coins').textContent, /Reading 7 days of prices…/);
    await page.runToEnd();
    assert.equal(percent('Holding the five coins'), '−14.00%');
  } finally { await page.finish(); }
});

test('price times are labelled as 15-minute buckets, and equal labels never claim the same window', async () => {
  // V5 samples placed exactly on the two bucket opening times: the labels coincide, the windows are still not the same.
  const rows = [{ bot: 'v5', at_ms: BUCKET_A * 1000, equity: '100', initial_funding: '200000', unit: 'USDC' }, { bot: 'v5', at_ms: BUCKET_B * 1000, equity: '86', initial_funding: '200000', unit: 'USDC' }];
  const net = network();
  const page = await render({ net, seedMoney: moneyBody(rows) });
  try {
    await page.runToEnd();
    const holdingNote = note('Holding the five coins');
    assert.match(holdingNote, new RegExp(`${minute(BUCKET_A * 1000)}.*${minute(BUCKET_B * 1000)}`));
    assert.match(note('V5 wallet equity'), /^from 2026-.* to 2026-.* · its own samples, not tied to the price buckets$/);
    assert.equal(percent('V5 wallet equity'), '−14.00%');
    assert.doesNotMatch(holdPanel().textContent, /same window/);
  } finally { await page.finish(); }
});

test('a newer gap row is never carried into the comparison; its own end time is shown beside the gap', async () => {
  const net = network();
  const page = await render({ net, seedMoney: moneyBody([...liveMoneyRows, gapRow]) });
  try {
    await page.runToEnd();
    assert.match(note('V5 wallet equity'), new RegExp(` to ${new Date(T2).toISOString().slice(0, 16).replace('T', ' ')}`));
    assert.doesNotMatch(note('V5 wallet equity'), new RegExp(new Date(T3).toISOString().slice(0, 16).replace('T', ' ')));
    assert.match(browser.document.body.textContent, /Latest V5 sample at .* is a gap: OWNER_READ_FAILED/);
    assert.match(browser.document.body.textContent, /The newest sample had no values \(OWNER READ FAILED\)/);
    assert.equal(percent('V5 wallet equity'), v5Change);
  } finally { await page.finish(); }
});

test('no recorded samples: Day by day says so, the V5 side is blank, the prices still read', async () => {
  const net = network();
  const page = await render({ net, seedMoney: moneyBody([], []) });
  try {
    assert.match(day().textContent, /No samples yet\./);
    assert.equal(day().querySelector('table'), null);
    assert.equal(percent('V5 wallet equity'), null);
    assert.match(note('V5 wallet equity'), /fewer than two samples with values in 7 days/);
    await page.runToEnd();
    assert.equal(page.first['Holding side of the comparison'], 750);
    assert.equal(percent('V5 wallet equity'), null);
  } finally { await page.finish(); }
});

test('no candle store: the V5 side still shows, and Refresh sends no price reads', async () => {
  const net = network();
  const page = await render({ net, seedMoney: moneyBody(liveMoneyRows), profileData: { candle_store: { configured: false } } });
  try {
    assert.equal(percent('V5 wallet equity'), v5Change);
    assert.match(note('Holding the five coins'), /No candle store in this deployment/);
    await page.runToEnd();
    await page.refresh();
    await page.runToEnd();
    assert.equal(net.issued.filter(read => read.kind === 'money').length, 1, 'Refresh still re-reads Money');
    assert.equal(crossReads(net).length, 0, 'no price request without a candle store');
    assert.equal(percent('V5 wallet equity'), v5Change);
  } finally { await page.finish(); }
});

test('with a candle store, Refresh re-reads the five prices again', async () => {
  const net = network();
  const page = await render({ net, seedMoney: moneyBody(liveMoneyRows) });
  try {
    await page.runToEnd();
    await page.refresh();
    await page.runToEnd();
    assert.equal(crossReads(net).length, 10);
  } finally { await page.finish(); }
});

test('three rapid Refreshes after loading keep one batch and retain the comparison', async () => {
  const net = network({ owner: { deadline: 12_000, service: 5_000 } });
  const page = await render({ net, seedMoney: moneyBody(liveMoneyRows) });
  try {
    await page.runToEnd();
    assert.equal(percent('Holding the five coins'), '−14.00%');
    for (let click = 0; click < 3; click++) await page.refresh();
    const refreshDispatches = crossReads(net).length - 5;
    assert.equal(percent('Holding the five coins'), '−14.00%');
    await page.runToEnd();
    assert.deepEqual({ refreshDispatches, ownerPeak: net.maxOwnerInFlight, total: crossReads(net).length, holding: percent('Holding the five coins') },
      { refreshDispatches: 2, ownerPeak: 2, total: 10, holding: '−14.00%' });
  } finally { await page.finish(); }
});

test('turning off the candle store blanks a previously priced holding tile, not V5', async () => {
  const net = network();
  const page = await render({ net, seedMoney: moneyBody(liveMoneyRows) });
  try {
    await page.runToEnd();
    assert.equal(percent('Holding the five coins'), '−14.00%');
    await act(async () => page.client.setQueryData(['v5-profile'], { candle_store: { configured: false } }));
    await flush();
    assert.match(note('Holding the five coins'), /No candle store in this deployment/);
    assert.equal(percent('V5 wallet equity'), v5Change);
    assert.equal(percent('Holding the five coins'), null);
  } finally { await page.finish(); }
});

test('the 10:15 bucket priced by its 10:20 minute close is not described as a closed bucket', async () => {
  const latestBucket = Date.UTC(2026, 10, 19, 10, 15) / 1000;
  const net = network({ answer: Object.fromEntries(COINS.map(coin => [coin, () => reply({
    ...candleBody,
    data: { res_s: 900, now: latestBucket + 300, end: latestBucket + 240, series: [{ ...candleBody.data.series[0], close: [[BUCKET_A, 100], [latestBucket, 86]] }] },
  })])) });
  const page = await render({ net, seedMoney: moneyBody(liveMoneyRows) });
  try {
    await page.runToEnd();
    assert.equal(percent('Holding the five coins'), '−14.00%');
    assert.match(note('Holding the five coins'), /last minute close available.*19 Nov 10:15 UTC.*bucket may still be open/);
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
    assert.equal(percent('V5 wallet equity'), v5Change);
  } finally { await page.finish(); }
});

test('a quick remount rejoins the active price batch and gets the full comparison', async () => {
  const net = network({ owner: { deadline: 12_000, service: 5_000 } });
  const first = await render({ net, seedMoney: moneyBody(liveMoneyRows) });
  let second;
  try {
    assert.equal(crossReads(net).length, 2);
    await first.leave();
    assert.equal(net.ownerInFlight, 2, 'unmount cannot free an occupied owner slot');
    second = await render({ net, seedMoney: moneyBody(liveMoneyRows), existingClient: first.client });
    const dispatchesAtRemount = crossReads(net).length;
    await second.runToEnd();
    assert.deepEqual({ dispatchesAtRemount, ownerPeak: net.maxOwnerInFlight, total: crossReads(net).length,
      elapsed: net.now, holding: percent('Holding the five coins') },
      { dispatchesAtRemount: 2, ownerPeak: 2, total: 5, elapsed: 15_000, holding: '−14.00%' });
  } finally {
    if (second) await second.finish();
    await first.finish();
  }
});

test('leaving the page while Money is in flight aborts that read too', async () => {
  const net = network();
  const page = await render({ net });
  try {
    assert.equal(net.issued.filter(read => read.kind === 'money').length, 1);
    await page.leave();
    assert.ok(net.signals[0].aborted);
    assert.equal(page.client.getQueryData(['v5-money', '7d']), undefined);
  } finally { await page.finish(); }
});
