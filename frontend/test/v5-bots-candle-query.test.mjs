import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { frontendModules } from './helpers/frontend-module.mjs';

test('the card and chart share one per-pair and range owner request', async () => {
  let calls = 0;
  const { paperCandleQuery } = frontendModules({ './candle-store-api': { readCandleStore: async () => { calls++; return { buckets: [] }; } } }).load('v5/paper-candles.ts');
  const client = new QueryClient();
  const card = paperCandleQuery('BNB-USDC', '24h', true);
  const chart = paperCandleQuery('BNB-USDC', '24h', true);
  await Promise.all([client.fetchQuery(card), client.fetchQuery(chart)]);
  assert.equal(calls, 1);
  assert.notDeepEqual(chart.queryKey, paperCandleQuery('BNB-USDC', '7d', true).queryKey);
  assert.notDeepEqual(chart.queryKey, paperCandleQuery('BTC-USDC', '24h', true).queryKey);
  client.clear();
});
