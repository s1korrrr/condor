import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { frontendModules } from './helpers/frontend-module.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { create, act } from 'react-test-renderer';
import { Window } from 'happy-dom';

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

test('last final close survives later gaps but expires after 180 seconds', () => {
  const {load} = frontendModules();
  const {latestFinalCandle} = load('v5/paper-candles.ts');
  const buckets = [[360,1,2,1,1.5,0,1],[540,null,null,null,null,null,0]];
  assert.deepEqual(latestFinalCandle(buckets), {close:1.5,at:420000});
  assert.equal(latestFinalCandle([[540,null,null,null,null,null,0]]), null);
  const {PaperPositions} = load('v5/PaperPositions.tsx');
  const prices = {'BNB-USDC':{buckets}};
  assert.match(renderToStaticMarkup(React.createElement(PaperPositions,{now:600000,prices})), /Price: <span title="1.5">1.5000 USDC/);
  assert.match(renderToStaticMarkup(React.createElement(PaperPositions,{now:600001,prices})), /latest closed candle unavailable or old/);
  const {PaperPriceChart} = load('v5/PaperPriceChart.tsx');
  const chart = renderToStaticMarkup(React.createElement(PaperPriceChart,{now:600000,view:{pair:'BNB-USDC',venue:'OKX',volume_unit:'base',start:360,end:540,buckets}}));
  assert.match(chart, /Requested window:.*00:10:00 UTC.*Latest final candle:.*00:07:00 UTC/);
});

test('money and candle price stay outside the dimmed snapshot values', () => {
  const {PaperPositions} = frontendModules().load('v5/PaperPositions.tsx');
  const prices = {'BNB-USDC':{buckets:[[360,1,2,1,1.5,0,1],[540,null,null,null,null,null,0]]}};
  const money = {rows:[{bot:'v5',at_ms:590000,snapshot_at_ms:590000,unit:'USDC',coins:{BNB:{realized:'2',unrealized:'1'}}}]};
  const browser = new Window();
  browser.document.body.innerHTML = renderToStaticMarkup(React.createElement(PaperPositions,{now:600000,asOf:540000,prices,money}));
  const card = browser.document.querySelector('.paper-pair');
  assert.match(card.textContent, /3.00 USDC.*profit or loss/);
  assert.equal(card.querySelector('strong').getAttribute('title'), '2 + 1 = 3');
  assert.match(card.textContent, /Price: 1.5000 USDC/);
  assert.doesNotMatch(card.querySelector('.paper-dimmed-position').textContent, /profit or loss|Price: 1.5/);
  assert.match(card.querySelector('.paper-dimmed-position').textContent, /Holding/);
  assert.match(card.textContent, /not current/);
  browser.close();
});

test('clock-only chart rerenders reuse marker projection', async () => {
  let calls = 0;
  const rendered = [];
  const records = [{trading_pair:'BNB-USDC',side:'BUY',event_at_ms:60000}];
  const view = {pair:'BNB-USDC',venue:'OKX',volume_unit:'base',start:60,end:60,buckets:[[60,1,2,1,1.5,0,1]]};
  const {PaperPriceChart} = frontendModules({
    react:{...React,lazy:() => props => {rendered.push(props.markers);return null;}},
    './policy':{paperRetainedRecords:() => records,paperPairBag:() => null,paperTime:time => String(time)},
    './bots-chart-model.mjs':{tradeMarkers:() => {calls++;return {entries:1,exits:0,markers:[{time:60,side:'BUY'}]};}},
  }).load('v5/PaperPriceChart.tsx');
  let renderer;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => {renderer = create(React.createElement(PaperPriceChart,{now:120000,view}));});
    await act(async () => {renderer.update(React.createElement(PaperPriceChart,{now:121000,view}));});
    assert.equal(calls, 1);
    assert.equal(rendered[0], rendered[1]);
    await act(async () => {renderer.update(React.createElement(PaperPriceChart,{now:121000,view,pair:'BTC-USDC'}));});
    assert.equal(calls, 2);
  } finally {await act(async () => renderer?.unmount());delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});
