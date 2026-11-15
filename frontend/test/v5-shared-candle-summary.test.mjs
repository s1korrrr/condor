import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { QueryClient } from '@tanstack/react-query';
import { frontendModules } from './helpers/frontend-module.mjs';

test('strip, Market and candle details share one summary query and refresh', async () => {
  for (const file of ['StatusStrip.tsx', 'V5Market.tsx', 'V5CandleStore.tsx']) {
    const source = fs.readFileSync(new URL(`../src/v5/${file}`, import.meta.url), 'utf8');
    assert.match(source, /\.\.\.candleSummaryQuery</, `${file} uses canonical query`);
  }
  const { candleSummaryQuery, candleRequestedAt } = frontendModules().load('v5/candle-store-api');
  const strip = candleSummaryQuery();
  const market = candleSummaryQuery();
  assert.deepEqual(strip.queryKey, market.queryKey);
  assert.equal(strip.queryFn, market.queryFn);
  const originalFetch = globalThis.fetch;
  const client = new QueryClient();
  let requests = 0;
  globalThis.fetch = async () => ({ok:true, json:async () => ({state:'AVAILABLE', data:{tiles:[], version:++requests}})});
  try {
    const [first, same] = await Promise.all([client.fetchQuery(strip), client.fetchQuery(market)]);
    assert.equal(requests, 1);
    assert.equal(first, same);
    assert.equal(typeof candleRequestedAt(first), 'number');
    const refreshed = await client.fetchQuery(market);
    assert.equal(requests, 2);
    assert.equal(client.getQueryData(strip.queryKey), refreshed);
    assert.equal(typeof candleRequestedAt(refreshed), 'number');
  } finally {
    globalThis.fetch = originalFetch;
    client.clear();
  }
});
