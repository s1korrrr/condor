import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { QueryClient } from '@tanstack/react-query';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

test('strip, Market, System and candle details share one summary query and refresh', async () => {
  for (const file of ['StatusStrip.tsx', 'V5Market.tsx', 'V5CandleStore.tsx']) {
    const source = fs.readFileSync(new URL(`../src/v5/${file}`, import.meta.url), 'utf8');
    assert.match(source, /\.\.\.candleSummaryQuery</, `${file} uses canonical query`);
  }
  const marketSource = fs.readFileSync(new URL('../src/v5/V5Market.tsx', import.meta.url), 'utf8');
  const stripSource = fs.readFileSync(new URL('../src/v5/StatusStrip.tsx', import.meta.url), 'utf8');
  assert.match(stripSource, /refetchInterval: candleSummaryInterval/, 'strip owns the shared warming retry');
  assert.equal((marketSource.match(/\.\.\.candleSummaryQuery</g) ?? []).length, 2, 'Market and System use the canonical query');
  assert.equal((marketSource.match(/\.\.\.candleSummaryQuery<Summary>\(\)[^\n]*refetchInterval: false/g) ?? []).length, 2, 'Market and System do not poll the summary');
  const detailSource = fs.readFileSync(new URL('../src/v5/V5CandleStore.tsx', import.meta.url), 'utf8');
  assert.match(detailSource, /\.\.\.candleSummaryQuery<Summary>\(\)[^\n]*refetchInterval: false/, 'candle details do not poll the summary');
  const { candleSummaryQuery, candleRequestedAt } = frontendModules().load('v5/candle-store-api');
  const strip = candleSummaryQuery();
  const market = candleSummaryQuery();
  assert.deepEqual(strip.queryKey, market.queryKey);
  assert.equal(strip.queryFn, market.queryFn);
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const client = new QueryClient();
  let requests = 0, now = 1_000_000;
  Date.now = () => now;
  globalThis.fetch = async () => ({ok:true, json:async () => ({state:'AVAILABLE', data:{tiles:[], version:++requests}})});
  try {
    const [first, same] = await Promise.all([client.fetchQuery(strip), client.fetchQuery(market)]);
    assert.equal(requests, 1);
    assert.equal(first, same);
    assert.equal(candleRequestedAt(first), now);
    now += 1000;
    await client.fetchQuery({...market, structuralSharing:true});
    const refreshed = client.getQueryData(strip.queryKey);
    assert.equal(requests, 2);
    assert.equal(refreshed.version, 2);
    assert.equal(refreshed.tiles, first.tiles);
    assert.equal(candleRequestedAt(refreshed), now);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    client.clear();
  }
});

test('Market and System withhold current health after the shared summary refresh fails', () => {
  const data = {now:1790000000,status_age_s:1,tiles:Array.from({length:14},(_, index) => ({lane:`lane${index}`,venue:`venue${Math.floor(index / 2)}`,segment:index % 2 ? 'perpetual' : 'spot',health:'green',available:true,pairs_held:4,pairs_listed:5,coverage_24h:1,coverage_7d:1,gaps_7d:0,last_minute_age_s:20}))};
  const summary = {data, dataUpdatedAt:1790000000000, isError:false, isSuccess:true, isPending:false, error:null, refetch() {}};
  const empty = {data:undefined,isError:false,isSuccess:false,isPending:false,refetch() {}};
  const {load} = frontendModules({
    '@tanstack/react-query':{useQuery:options => options.queryKey[0] === 'candle-summary' ? summary : options.queryKey[0] === 'v5-profile' ? {data:{candle_store:{configured:true}}} : empty},
    'react-router-dom':{useParams:() => ({}),useNavigate:() => () => {},Link:({children}) => React.createElement('a',null,children)},
    '@/features/quant-ops/kit/charts':{SparkChart:() => null,TimeSeriesChart:() => null},
    '@/features/quant-ops/kit/grid':{TileGrid:({children}) => React.createElement('div', null, children)},
    './V5CandleStore':{V5CandleStore:() => null},
    './V5MarketDetail':{V5MarketDetail:() => null},
    './V5MarketFeatures':{V5MarketFeatures:() => null},
    './usePaperClock':{usePaperClock:() => 1790000000000},
  });
  const {V5Market:Market,V5SystemMarket} = load('v5/V5Market');
  const good = renderToStaticMarkup(React.createElement(Market));
  assert.match(good,/14\/14 lanes available/);
  const goodSystem = renderToStaticMarkup(React.createElement(V5SystemMarket,{tab:'data-feeds',paused:false}));
  assert.match(goodSystem,/class="is-up"/);
  Object.assign(summary,{isError:true,isSuccess:false,error:new Error('owner_busy')});
  const html = renderToStaticMarkup(React.createElement(Market));
  assert.match(html, /Candle store.*unavailable/);
  assert.doesNotMatch(html, /class="is-up"|class="is-down"/);
  const failedSystem = renderToStaticMarkup(React.createElement(V5SystemMarket,{tab:'data-feeds',paused:false}));
  assert.match(failedSystem, /Candle store read failed: owner_busy/);
  assert.doesNotMatch(failedSystem, /class="is-up"|class="is-down"|venue0/i);
});
