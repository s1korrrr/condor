import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';
import { candleCurrent, hourlyReturns, marketHolding, marketSentence, windowChange } from '../src/v5/market-header.ts';

const coins = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
const changes = values => Object.fromEntries(coins.map((coin, index) => [coin, values[index] ?? null]));
const start = Date.UTC(2026, 10, 15) / 1000;
const dense = (count, missing = -1) => ({
  start, end: start + (count - 1) * 60, now: start + count * 60 + 10,
  buckets: Array.from({ length: count }, (_, index) => [start + index * 60, null, null, null, index === missing ? null : 100 + index, null, index === missing ? 0 : 1]),
});
const fixture = section => JSON.parse(readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));
const paper = (quote = 'USDT') => {
  const reads = ['status', 'positions', 'decisions'].map(fixture);
  reads[1].data = [
    { position_id: 'one', controller_id: 'v5-btc', trading_pair: `BTC-${quote}`, state: 'held', quantity: '0.016200000000000000000000000001' },
    { position_id: 'two', controller_id: 'v5-btc', trading_pair: `BTC-${quote}`, state: 'held', quantity: '0.000000000000000000000000000009' },
  ];
  reads[2].data = { controllers: [{ pair: `BTC-${quote}`, custom_info: { bag: { held_amount: '0.016200000000000000000000000010', breakeven_price: '100' } } }] };
  return reads;
};

test('sentence uses the selected range, all down, all up, mixed and unchanged', () => {
  assert.equal(marketSentence(changes(['-3.55', '-3.55', '-3.55', '-5.90', '-1.20']), '24h'), 'All five coins are down over 24 hours, on average −3.55%. SOL is weakest at −5.90%.');
  assert.match(marketSentence(changes(['1', '2', '3', '4', '5']), '6h'), /^All five coins are up over 6 hours, on average \+3.00%\. XRP is strongest at \+5.00%\.$/);
  assert.match(marketSentence(changes(['-1', '0', '1', '-2', '2']), '1h'), /2 up, 2 down, 1 unchanged over 1 hour, on average 0.00%/);
  assert.match(marketSentence(changes(['0', '0', '0', '0', '0']), '7d'), /All five coins are unchanged over 7 days/);
});

test('sentence names every missing coin and averages only published changes exactly', () => {
  assert.equal(marketSentence(changes(['0.10', '0.20']), '24h'), 'All 2 published coins are up over 24 hours, on average +0.15%. ETH is strongest at +0.20%. BNB, SOL, XRP: — change not published; excluded from the average.');
  assert.match(marketSentence(changes(['-1.00', '-1.01']), '24h'), /on average −1.01%/);
  assert.match(marketSentence(changes(['1.00', '1.01']), '24h'), /on average \+1.01%/);
  assert.match(marketSentence(changes(['1.00']), '24h'), /^BTC is up over 24 hours/);
  assert.match(marketSentence(changes([]), '24h'), /No current changes published over 24 hours/);
});

test('sentence uses the shared percent format for grouped exact decimals and rounded zero', () => {
  assert.match(marketSentence(changes(['1234.565']), '24h'), /on average \+1,234\.57%\. BTC is strongest at \+1,234\.57%\./);
  assert.match(marketSentence(changes(['-0.004']), '24h'), /on average 0\.00%\. BTC is weakest at 0\.00%\./);
});

test('window return rounds exact candle decimals, not binary floating point; no substituted boundary', () => {
  const read = dense(2);
  read.buckets[0][4] = 100;
  read.buckets[1][4] = 101.005;
  assert.equal(windowChange(read), '1.01');
  read.buckets[1][4] = 98.995;
  assert.equal(windowChange(read), '-1.01');
  read.buckets[1][4] = 0;
  assert.equal(windowChange(read), '-100.00');
  assert.equal(windowChange(dense(2, 0)), null);
  assert.equal(windowChange(dense(2, 1)), null);
  assert.equal(windowChange(null), null);
});

test('current candle reads expire by owner age plus elapsed time and refuse future closes', () => {
  const read = dense(2), received = 1000;
  assert.equal(candleCurrent(read, received, received), true);
  assert.equal(candleCurrent(read, received, received + 181000), false);
  assert.equal(candleCurrent({ ...read, now: read.end }, received, received), false);
  assert.equal(candleCurrent(null, received, received), false);
  assert.equal(candleCurrent({ ...read, now: read.now + 181 }, received, received), false);
});

test('holds uses complete same-bot snapshots and exact 30-place totals; gap uses the tile close', () => {
  const reads = paper(), now = reads[0].generated_at_ms;
  const holding = marketHolding('BTC', reads, reads[0].bot_id, 90.8, 'USDT', now);
  assert.equal(holding.text, 'V5 holds 0.016200000000000000000000000010 · −9.2% to breakeven');
  assert.equal(holding.reason, null);
  assert.equal(holding.asOf, now);
  assert.match(marketHolding('BTC', reads, reads[0].bot_id, 109.2, 'USDT', now).text, /\+9.2% to breakeven/);
  for (const mutate of [
    rows => { rows[1].completeness = 'partial'; },
    rows => { rows[1].next_cursor = 'more'; },
    rows => { rows[2].snapshot_id = 'different'; },
    rows => { rows[2].generated_at_ms += 1; },
    rows => { rows[2].bot_id = 'other'; },
    rows => { rows[1].data[0].quantity = 0.0162; },
    rows => { rows[1].data[0].quantity = '0.0000000000000000000000000000001'; },
  ]) {
    const bad = structuredClone(reads); mutate(bad);
    assert.equal(marketHolding('BTC', bad, reads[0].bot_id, 90.8, 'USDT', now).text, 'V5 holds —');
  }
  assert.equal(marketHolding('BTC', reads, reads[0].bot_id, 90.8, 'USDT', now + 120001).text, 'V5 holds —');
});

test('holds never equates quote currencies, infers missing breakeven, or hides stale prices', () => {
  const reads = paper('USDC'), now = reads[0].generated_at_ms;
  const mismatch = marketHolding('BTC', reads, reads[0].bot_id, 90.8, 'USDT', now);
  assert.match(mismatch.text, / · — to breakeven$/);
  assert.match(mismatch.reason, /USDT.*USDC/);
  const same = paper();
  assert.match(marketHolding('BTC', same, same[0].bot_id, null, 'USDT', now).reason, /current close/);
  same[2].data.controllers[0].custom_info.bag.breakeven_price = '0';
  assert.match(marketHolding('BTC', same, same[0].bot_id, 90, 'USDT', now).reason, /breakeven/);
  same[2].data.controllers[0].custom_info.bag.held_amount = '1';
  assert.match(marketHolding('BTC', same, same[0].bot_id, 90, 'USDT', now).reason, /bag amount/);
});

test('hourly strip uses UTC hour boundaries with the preceding close, not a neighbouring minute', () => {
  const read = dense(180);
  const hours = hourlyReturns(read);
  assert.deepEqual(hours.map(hour => hour.from), [start, start + 3600, start + 7200]);
  assert.equal(hours[0].change, null);
  assert.equal(hours[1].change, '37.74');
  assert.equal(hours[2].change, '27.40');
  for (const missing of [59, 60, 90, 119]) assert.equal(hourlyReturns(dense(180, missing))[1].change, null);
  assert.equal(hourlyReturns(dense(150)).at(-1).change, null);
  const flat = dense(180), falling = dense(180);
  flat.buckets.forEach(row => { row[4] = 100; });
  falling.buckets.forEach((row, index) => { row[4] = 300 - index; });
  assert.equal(hourlyReturns(flat)[1].change, '0.00');
  assert.equal(hourlyReturns(falling)[1].change, '-24.90');
  assert.deepEqual(hourlyReturns(null), []);
});

test('Market reads bind positions and decisions to the status snapshot and walk position pages', async () => {
  const reads = paper(), paths = [];
  const { load } = frontendModules();
  const { readMarketPaper } = load('v5/market-paper.ts');
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const path = new URL(url, 'https://fixture.invalid').searchParams.get('path');
    paths.push(path);
    const section = path.includes('native/status') ? 'status' : path.includes('holdings') ? 'positions' : 'decisions';
    const read = structuredClone(reads.find(row => row.section === section));
    if (section === 'positions' && !path.includes('cursor=')) {
      read.data = read.data.slice(0, 1); read.next_cursor = 'next';
    } else if (section === 'positions') {
      read.data = read.data.slice(1); read.next_cursor = null;
    }
    return { ok: true, text: async () => JSON.stringify(read) };
  };
  try {
    const result = await readMarketPaper(reads[0].bot_id, new AbortController().signal);
    assert.equal(result.length, 3);
    assert.equal(result[1].data.length, 2);
    assert.equal(paths.length, 4);
    assert.ok(paths.slice(1).every(path => new URL(path, 'https://fixture.invalid').searchParams.get('snapshot_id') === reads[0].snapshot_id));
    assert.ok(paths.every(path => !path.includes('live') && !path.includes('order')));
  } finally { globalThis.fetch = original; }
});

test('Market reads refuse foreign bots, malformed sections and non-JSON failures', async () => {
  const { load } = frontendModules();
  const { readMarketPaper } = load('v5/market-paper.ts');
  const original = globalThis.fetch;
  try {
    for (const mode of ['foreign', 'section', 'non-json']) {
      globalThis.fetch = async url => {
        const read = fixture('status');
        if (mode === 'foreign') read.bot_id = 'other';
        if (mode === 'section') read.section = 'wrong';
        return { ok: mode !== 'non-json', status: 502, text: async () => JSON.stringify(read), json: async () => { throw new SyntaxError('Not JSON'); } };
      };
      await assert.rejects(readMarketPaper('meridian_v5_paper', new AbortController().signal), mode === 'non-json' ? /Paper observations are unavailable \(HTTP 502\)/ : /validation/);
    }
  } finally { globalThis.fetch = original; }
});

function renderMarket({ expired = false, failed = false, range = '24h', summaryData = { tiles: [] } } = {}) {
  const spot = dense(180), reads = paper(), now = (spot.now + (expired ? 181 : 0)) * 1000;
  for (const read of reads) read.generated_at_ms = now;
  const coinReads = Object.fromEntries(coins.map(coin => [coin, { spot, perpetual: null, error: null, perpetualError: null, receivedAt: spot.now * 1000 }]));
  const queries = [];
  const { load } = frontendModules({
    react: { ...React, useState: initial => React.useState(initial === '24h' ? range : initial) },
    'react-router-dom': { useParams: () => ({}), useNavigate: () => () => {}, Link: ({to, children}) => React.createElement('a', {href:to}, children) },
    '@tanstack/react-query': { useQuery: options => {
      queries.push(options);
      const key = options.queryKey.join('/');
      const data = key === 'v5-profile' ? { readiness: { paper_owner: { bot_name: reads[0].bot_id } } } : key === 'v5-workspace' ? {} : key.includes('/coins/') ? coinReads : key.includes('/paper/') ? reads : key.endsWith('/summary') ? summaryData : [];
      const isError = failed && (key.includes('/coins/') || key.includes('/paper/'));
      return { data, isSuccess: !isError, isPending: false, isError, error: isError ? new Error('Read failed') : null, dataUpdatedAt: spot.now * 1000 };
    } },
    './api': { v5Api: {} },
    './usePaperClock': { usePaperClock: () => now },
    './V5CandleStore': { V5CandleStore: () => null },
    './V5MarketDetail': { V5MarketDetail: () => null },
    './V5MarketFeatures': { V5MarketFeatures: () => null },
    '@/features/quant-ops/kit/charts': { SparkChart: () => null, TimeSeriesChart: () => null },
    '@/features/quant-ops/kit/grid': { TileGrid: ({ children }) => React.createElement('div', null, children) },
  });
  return { html: renderToStaticMarkup(React.createElement(load('v5/V5Market.tsx').V5Market)), queries };
}

test('Market renders a small header, selected range, two chips, holds and hourly returns', () => {
  const { html, queries } = renderMarket({ range: '6h' });
  assert.match(html, /href="\/system\/data-feeds"/);
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.equal((header.match(/class="v5m-chip /g) ?? []).length, 2);
  assert.doesNotMatch(header, /Refresh|Five coins across|Slowest lane/);
  assert.match(header, /aria-label="Market range"/);
  assert.match(html, /All five coins are up over 6 hours/);
  assert.match(html, /V5 holds 0.016200000000000000000000000010/);
  assert.match(html, /Hour-by-hour returns/);
  assert.doesNotMatch(html, /<dt>Minutes held<\/dt>|v5m-range/);
  assert.ok(queries.some(query => JSON.stringify(query.queryKey) === '["v5-market","coins","6h"]'));
  assert.match(html, /Venue and data health and V5 engine inputs are in/);
  assert.doesNotMatch(html, /<h2>V5 market features<\/h2>|<h2>Venues and data health<\/h2>/);
});

test('Market never displays retained failed or expired prices and holdings as current', () => {
  for (const scenario of [{ failed: true }, { expired: true }]) {
    const { html } = renderMarket(scenario);
    assert.doesNotMatch(html, /279\.00 USDT|All five coins are up/);
    assert.match(html, /No current changes published/);
    if (scenario.failed) {
      assert.doesNotMatch(html, /V5 holds 0\.0162/);
      assert.match(html, /Earlier prices are not shown/);
    } else assert.match(html, /close not current/);
  }
});

test('Market header withholds lane counts when owner status is old or availability is unknown', () => {
  const lane = { lane: 'binance__spot', venue: 'binance', segment: 'spot', available: true, last_minute_age_s: 10 };
  const header = summaryData => renderMarket({ summaryData }).html.split('</header>')[0];
  assert.match(header({ tiles: [lane], status_age_s: 0 }), /1\/1 lanes available/);
  assert.match(header({ tiles: [lane], status_age_s: 181 }), /— not current/);
  assert.doesNotMatch(header({ tiles: [lane], status_age_s: 181 }), /1\/1 lanes available/);
  assert.match(header({ tiles: [{ ...lane, available: null }], status_age_s: 0 }), /— · lane availability incomplete/);
  assert.match(header({ tiles: [lane], status_age_s: null }), /— data incomplete/);
});

test('Market candle-store chip uses current owner health, independently of availability', () => {
  const lane = { lane: 'binance__spot', venue: 'binance', segment: 'spot', available: true, last_minute_age_s: 10 };
  const header = (tiles, status_age_s = 0) => renderMarket({ summaryData: { tiles, status_age_s } }).html.split('</header>')[0];
  for (const [health, color] of [['red', 'is-bad'], ['amber', 'is-warn'], [null, 'is-unknown'], ['green', '']]) {
    assert.match(header([{ ...lane, health }]), new RegExp(`class="v5m-chip ${color}"[^]*Candle store <b>1/1 lanes available · owner health ${health ?? 'unknown'}`));
  }
  assert.match(header([{ ...lane, available: null, health: 'red' }]), /v5m-chip is-bad[^]*lane availability incomplete · owner health red/);
  assert.match(header([{ ...lane, health: 'red' }], 181), /v5m-chip is-warn[^]*Candle store <b>— not current/);
  assert.doesNotMatch(header([{ ...lane, health: 'red' }], 181), /owner health red/);
});

test('Market candle requests use the selected range for both lanes of every coin', async () => {
  const { queries } = renderMarket({ range: '6h' });
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async url => {
    calls.push(new URL(url, 'https://fixture.invalid'));
    return { ok: true, json: async () => ({ state: 'AVAILABLE', data: dense(360) }) };
  };
  try {
    await queries.find(query => query.queryKey.includes('coins')).queryFn();
    assert.equal(calls.length, 10);
    assert.ok(calls.every(url => url.searchParams.get('range') === '6h'));
    assert.deepEqual(calls.map(url => url.searchParams.get('pair')), coins.flatMap(coin => [`${coin}-USDT`, `${coin}-USDT`]));
    assert.deepEqual(calls.map(url => url.searchParams.get('lane')), coins.flatMap(() => ['binance__spot', 'binance__perpetual']));
  } finally { globalThis.fetch = original; }
});
