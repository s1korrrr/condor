// The "Bot market" lane (OKX spot, -USDC: what the bots trade), the venue labels on the Binance views, and the Market
// card's bag comparison against the owner's real position/decision replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ReactQuery from '@tanstack/react-query';
import { frontendModules } from './helpers/frontend-module.mjs';

const COINS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
const start = Date.UTC(2026, 10, 15) / 1000;
const candles = (pair, { venue = 'okx', last = 100 } = {}) => ({
  pair, venue, volume_unit: 'base', start, end: start + 59 * 60, now: start + 60 * 60 + 10,
  buckets: Array.from({ length: 60 }, (_, index) => [start + index * 60, null, null, null, index === 59 ? last : 90 + index / 10, null, 1]),
});
const modules = () => frontendModules({ '@/features/quant-ops/kit/charts': { SparkChart: () => null, TimeSeriesChart: () => null } });
const bot = () => modules().load('v5/market-bot.ts');

test('labels name the venue and the pair; the Binance basis says it is not the bots market', () => {
  const { marketLabel, botPair } = bot();
  const { REFERENCE } = modules().load('v5/market-model.mjs');
  assert.equal(marketLabel('okx', 'BNB-USDC'), 'OKX spot · BNB-USDC');
  assert.equal(marketLabel('binance', 'BNB-USDT'), 'Binance spot · BNB-USDT');
  assert.deepEqual(COINS.map(botPair), ['BTC-USDC', 'ETH-USDC', 'BNB-USDC', 'SOL-USDC', 'XRP-USDC']);
  assert.equal(REFERENCE.basis, 'Binance spot, USDT pairs; not the OKX USDC pairs the bots trade (Market › Bot market)');
});

test('the Market page labels the Binance coin cards and mounts the Bot market lane; Money labels its benchmark venue', () => {
  const market = readFileSync(new URL('../src/v5/V5Market.tsx', import.meta.url), 'utf8');
  assert.match(market, /Coin cards: \{venueTitle\(REFERENCE\.venue\)\} spot, \{REFERENCE\.quote\} pairs\. These are not the \{BOT_MARKET\.quote\} pairs the bots trade/);
  assert.match(market, /<V5BotMarket range=\{range\} enabled=\{binanceViewSettled\}/);
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: ({ queryKey }) => ({ data: queryKey[0] === 'v5-money' ? { rows: [], daily: [], range: '7d', sampler: true } : queryKey[0] === 'v5-profile' ? { candle_store: { configured: true } } : undefined, isPending: false, refetch() {} }) },
    '@/features/quant-ops/kit/charts': { BarsChart: () => null, TimeSeriesChart: () => null },
    '@/features/quant-ops/kit/DataTable': { DataTable: () => null },
  });
  const html = renderToStaticMarkup(React.createElement(load('v5/V5Money.tsx').V5Money));
  assert.match(html, /Equal weights in BTC, ETH, BNB, SOL, XRP over the candle store&#x27;s 7 days \(Binance spot, USDT pairs; not the OKX USDC pairs the bots trade/);
});

test('reads: one symbol list is shared, then five okx__spot -USDC reads, one at a time, each painted as it arrives', async () => {
  const { readBotMarket } = bot();
  const calls = [], painted = [];
  let inFlight = 0, maxInFlight = 0;
  const read = async (view, params) => {
    calls.push([view, params]); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 2));
    inFlight--; return candles(params.pair);
  };
  const symbols = { rows: COINS.map(coin => ({ lane: 'okx__spot', pair: `${coin}-USDC` })) };
  const rows = await readBotMarket({ range: '24h', symbols, read, onCoin: row => painted.push(`${row.coin}:${row.state}:${calls.length}`) });
  assert.equal(calls.length, 5, 'five price reads in all');
  assert.equal(maxInFlight, 1, 'never more than one in flight, so the owner\'s two slots stay free for the Binance view');
  assert.deepEqual(calls.map(([view, params]) => `${view} ${params.lane} ${params.pair} ${params.range}`), COINS.map(coin => `candles okx__spot ${coin}-USDC 24h`));
  assert.deepEqual(painted, ['BTC:ok:1', 'ETH:ok:2', 'BNB:ok:3', 'SOL:ok:4', 'XRP:ok:5'], 'a coin is reported before the next is read');
  assert.equal(rows.length, 5);
});

test('a symbol missing from the store is "missing" with no read; an unread symbol list still reads; a failure never stops the rest', async () => {
  const { readBotMarket } = bot();
  const calls = [];
  const read = async (_view, params) => { calls.push(params.pair); if (params.pair === 'SOL-USDC') throw new Error('owner read timed out'); return candles(params.pair); };
  const symbols = { rows: ['BTC', 'SOL', 'XRP', 'BNB'].map(coin => ({ lane: 'okx__spot', pair: `${coin}-USDC` })).concat([{ lane: 'binance__spot', pair: 'ETH-USDT' }, { lane: 'binance__spot', pair: 'ETH-USDC' }]) };
  const rows = await readBotMarket({ range: '24h', symbols, read });
  assert.deepEqual(rows.map(row => `${row.coin}:${row.state}`), ['BTC:ok', 'ETH:missing', 'BNB:ok', 'SOL:error', 'XRP:ok']);
  assert.equal(rows[1].read, null);
  assert.equal(rows[3].error, 'owner read timed out');
  assert.deepEqual(calls, ['BTC-USDC', 'BNB-USDC', 'SOL-USDC', 'XRP-USDC'], 'ETH-USDC exists only on another lane, so it is not read from okx__spot');
  const unknown = await readBotMarket({ range: '1h', symbols: undefined, read: async (_view, params) => candles(params.pair) });
  assert.deepEqual(unknown.map(row => row.state), ['ok', 'ok', 'ok', 'ok', 'ok']);
});

test('an answer for another pair or venue is an error, never shown as the bots market; abort stops the reads', async () => {
  const { readBotMarket } = bot();
  const rows = await readBotMarket({ range: '24h', symbols: undefined, read: async (_view, params) => params.pair === 'BTC-USDC' ? candles('BTC-USDT') : params.pair === 'ETH-USDC' ? candles('ETH-USDC', { venue: 'binance' }) : candles(params.pair) });
  assert.equal(rows[0].state, 'error');
  assert.match(rows[0].error, /answered for BTC-USDT, not OKX spot · BTC-USDC/);
  assert.equal(rows[1].state, 'error');
  assert.match(rows[1].error, /answered for binance ETH-USDC/);
  const controller = new AbortController(); let reads = 0;
  await assert.rejects(readBotMarket({ range: '24h', symbols: undefined, signal: controller.signal, read: async (_view, params) => { reads++; controller.abort(); return candles(params.pair); } }));
  assert.equal(reads, 1);
});

test('a refresh replaces one coin at a time and keeps the others', () => {
  const { withCoin } = bot();
  const row = (coin, state) => ({ coin, pair: `${coin}-USDC`, state, read: null, error: null, receivedAt: 1 });
  let rows = withCoin(undefined, row('ETH', 'ok'));
  rows = withCoin(rows, row('BTC', 'ok'));
  assert.deepEqual(rows.map(item => item.coin), ['BTC', 'ETH']);
  rows = withCoin(rows, row('BTC', 'error'));
  assert.deepEqual(rows.map(item => `${item.coin}:${item.state}`), ['BTC:error', 'ETH:ok'], 'a failed read replaces the earlier success');
});

function renderLane({ seeded, symbolsData = { rows: [] }, enabled = true, range = '24h', now }) {
  const client = new ReactQuery.QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (symbolsData) client.setQueryData(['v5-bots-candle-symbols'], symbolsData);
  if (seeded) client.setQueryData(['v5-market', 'bot', range], seeded);
  const { V5BotMarket } = frontendModules({ '@tanstack/react-query': ReactQuery, '@/features/quant-ops/kit/charts': { SparkChart: () => React.createElement('i', { 'data-spark': true }) } }).load('v5/V5MarketBot.tsx');
  return renderToStaticMarkup(React.createElement(ReactQuery.QueryClientProvider, { client }, React.createElement(V5BotMarket, { range, enabled, now, color: Object.fromEntries(COINS.map(coin => [coin, '#888'])), holding: (coin, last) => React.createElement('p', { 'data-holding': coin }, `holding ${last}`) })));
}

test('the lane renders venue and pair on every card, a priced coin, a missing symbol, a failed read and coins still to read', () => {
  const now = (start + 60 * 60 + 70) * 1000;
  const ok = (coin, last) => ({ coin, pair: `${coin}-USDC`, state: 'ok', read: candles(`${coin}-USDC`, { last }), error: null, receivedAt: now });
  const html = renderLane({ now, seeded: [ok('BTC', 95.5), { coin: 'ETH', pair: 'ETH-USDC', state: 'missing', read: null, error: null, receivedAt: now }, { coin: 'BNB', pair: 'BNB-USDC', state: 'error', read: null, error: 'owner read timed out', receivedAt: now }] });
  assert.match(html, /<h2>Bot market<\/h2><span>OKX spot · \*-USDC · the pairs the V5 bots trade · 24h<\/span>/);
  assert.match(html, /OKX spot · BTC-USDC/);
  assert.match(html, /title="95\.5">95\.5\d* USDC/);
  assert.match(html, /data-holding="BTC">holding 95\.5</, 'the breakeven comparison gets the current USDC close');
  assert.match(html, /OKX spot · ETH-USDC<\/small><strong class="v5m-price">—<\/strong><p class="v5m-hint">Not in the candle store: okx__spot ETH-USDC is not in its symbol list\./);
  assert.match(html, /Price unavailable\. owner read timed out/);
  assert.match(html, /OKX spot · SOL-USDC<\/small><p class="v5m-hint" role="status">Reading…/);
  assert.equal((html.match(/data-bot-market=/g) ?? []).length, 5);
  assert.equal((html.match(/OKX spot · [A-Z]+-USDC/g) ?? []).length >= 5, true);
});

test('before the Binance view settles the lane says it is waiting; an old close is not shown as a price', () => {
  assert.match(renderLane({ now: 1, enabled: false, symbolsData: undefined }), /Waiting for the Binance view…/);
  const now = (start + 60 * 60 + 70 + 600) * 1000;
  const html = renderLane({ now, seeded: [{ coin: 'BTC', pair: 'BTC-USDC', state: 'ok', read: candles('BTC-USDC', { last: 80000 }), error: null, receivedAt: now - 600_000 }] });
  assert.match(html, /— close not current/);
  assert.doesNotMatch(html, /80,000/);
  assert.match(html, /data-holding="BTC">holding null</);
});

// ---- the bag comparison, on the owner's own replay (tests/fixtures/paper-api-final3/native-replay)
const fixture = section => JSON.parse(readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));
const replay = () => ['status', 'positions', 'decisions'].map(fixture);
const { marketHolding } = modules().load('v5/market-header.ts');

test('replay: the bag amount is the sum of the held-reconciliation rows, not of every row of the pair', () => {
  const reads = replay(), positions = reads[1].data, controllers = reads[2].data.controllers;
  for (const { pair, custom_info: { bag } } of controllers) {
    const rows = positions.filter(row => row.trading_pair === pair);
    const sum = state => rows.filter(row => row.state === state).reduce((total, row) => total + Number(row.quantity), 0);
    assert.ok(rows.some(row => row.state === 'active'), `${pair} also holds active lots`);
    assert.ok(Math.abs(sum('held_reconciliation') - Number(bag.held_amount)) < 1e-9, `${pair}: bag ${bag.held_amount} = held_reconciliation rows`);
    assert.ok(Math.abs(rows.reduce((total, row) => total + Number(row.quantity), 0) - Number(bag.held_amount)) > 1e-6, `${pair}: bag is not the whole holding`);
  }
});

test('replay: no false mismatch; the gap is computed on the USDC price against the bag breakeven, and names the bag', () => {
  const reads = replay(), now = reads[0].generated_at_ms, botId = reads[0].bot_id;
  for (const coin of COINS) {
    const pair = `${coin}-USDC`;
    const breakeven = reads[2].data.controllers.find(row => row.pair === pair).custom_info.bag.breakeven_price;
    const holding = marketHolding(coin, reads, botId, Number(breakeven) * 1.1, 'USDC', now);
    assert.equal(holding.warning, undefined, `${coin}: no bag-mismatch warning`);
    assert.equal(holding.reason, null, `${coin}: the comparison is complete`);
    assert.match(holding.text, new RegExp(`^V5 holds [\\d.,]+ · bag [\\d.,]+ · \\+(10\\.0|9\\.[89]|10\\.[01])% to bag breakeven$`), `${coin}: ${holding.text}`);
    assert.match(holding.title, /· bag /);
  }
});

test('replay: on the Binance USDT card a blank breakeven says why, and points to the USDC card', () => {
  const reads = replay(), now = reads[0].generated_at_ms;
  const holding = marketHolding('BTC', reads, reads[0].bot_id, 90000, 'USDT', now);
  assert.equal(holding.warning, undefined);
  assert.match(holding.text, / · — to bag breakeven$/);
  assert.equal(holding.reason, 'The market price on this card is in USDT. Breakeven is in USDC. The Bot market card compares in USDC.');
});

test('replay: a bag that matches no group of rows is a warning that names both amounts and says why no breakeven is shown', () => {
  const reads = replay(), now = reads[0].generated_at_ms;
  reads[2].data.controllers.find(row => row.pair === 'BTC-USDC').custom_info.bag.held_amount = '0.001';
  const holding = marketHolding('BTC', reads, reads[0].bot_id, 90000, 'USDC', now);
  assert.equal(holding.warning, 'bag-mismatch');
  assert.match(holding.text, / · — to breakeven$/);
  assert.equal(holding.reason, "No breakeven shown: the strategy's bag is 0.001 BTC; the position rows total 0.00505 (0.002483 in held reconciliation rows). The breakeven belongs to the bag, and no group of rows matches it.");
});
