import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { frontendModules } from './helpers/frontend-module.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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

test('missing or malformed symbols never make a pair available', () => {
  const {hasPaperCandlePair} = frontendModules().load('v5/paper-candles.ts');
  for (const value of [undefined, {}, {rows:null}, {rows:[null]}]) assert.equal(hasPaperCandlePair(value, 'BNB-USDC'), false);
  assert.equal(hasPaperCandlePair({rows:[{lane:'okx__spot',pair:'BNB-USDC'}]}, 'BNB-USDC'), true);
});

test('position and chart views render missing data without a query provider', () => {
  const {load} = frontendModules();
  const {PaperPositions} = load('v5/PaperPositions.tsx');
  const {PaperPriceChart} = load('v5/PaperPriceChart.tsx');
  const positions = renderToStaticMarkup(React.createElement(PaperPositions, {now: 1}));
  const chart = renderToStaticMarkup(React.createElement(PaperPriceChart, {now: 1}));
  assert.match(positions, /— · per-coin profit sample not published/);
  assert.match(chart, /— · Candle read unavailable/);
});
