import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';

const {load}=frontendModules();
const {Heatmap,Histogram,RailBar,StackedBar}=load('features/quant-ops/primitives.tsx');
const {projectTimeSeries,valueAt}=load('features/quant-ops/kit/series.ts');
const {assetColor}=load('features/quant-ops/format.ts');

test('equity curve uses elapsed time and keeps gap fills separate',()=>{
  const start=Date.parse('2026-09-01T00:00:00Z');
  const points=[
    {time:start,value:100},{time:start+60_000,value:110},
    {time:start+120_000,value:null},{time:start+86_400_000,value:120},
    {time:start+86_460_000,value:130},
  ];
  const projection=projectTimeSeries([{id:'equity',label:'Equity',color:'green',points}]);
  assert.deepEqual(projection.domain,[start,start+86_460_000],'the axis spans elapsed time, not sample count');
  assert.equal(projection.keys.length,2,'a null observation separates the two filled runs');
  assert.equal(valueAt(points,start+3_600_000).value,null,'inside the gap the tooltip reports a gap');
  assert.equal(valueAt(points,start+86_430_000).value,120,'between samples the tooltip reports the latest sample');
});

test('selected asset preserves the full allocation denominator',()=>{
  const html=renderToStaticMarkup(React.createElement(StackedBar,{rows:[
    {label:'BTC',value:34},{label:'ETH',value:20},{label:'USDC',value:46},
  ],highlight:'BTC'}));
  assert.match(html,/BTC 34\.0%/);
  assert.match(html,/width:34%/);
  assert.match(html,/ETH 20\.0%/);
  assert.match(html,/data-highlighted="true"/);
});

test('asset colors follow identity across ordering and membership changes',()=>{
  const first=renderToStaticMarkup(React.createElement(StackedBar,{rows:[
    {label:'BTC',value:34},{label:'ETH',value:20},{label:'USDC',value:46},
  ]}));
  const reordered=renderToStaticMarkup(React.createElement(StackedBar,{rows:[
    {label:'USDC',value:46},{label:'BTC',value:34},
  ]}));
  const btcColor=assetColor('BTC');
  assert.ok(btcColor);
  assert.match(first,new RegExp(`background:${btcColor}[^>]*title="BTC 34\\.0%"`));
  assert.match(reordered,new RegExp(`background:${btcColor}[^>]*title="BTC 42\\.5%"`));
});

test('symbol exposure heatmap labels marked owned value rather than controller PnL',()=>{
  const html=renderToStaticMarkup(React.createElement(Heatmap,{rows:['v2'],columns:['BTC','ETH'],metricLabel:'Marked owned value',unitLabel:'each bot’s quote currency',cells:[
    {row:'v2',column:'BTC',value:-50},{row:'v2',column:'ETH',value:30},
  ]}));
  assert.match(html,/Marked owned value by symbol heatmap/);
  assert.match(html,/var\(--q-negative\)/);
  assert.match(html,/var\(--q-positive\)/);
  // A table keeps its content width even at width:1px, so the clipped wrapper must be a div,
  // otherwise the hidden table still adds horizontal scroll to the page on narrow viewports.
  assert.match(html,/<div class="sr-only"><table>/);
  assert.doesNotMatch(html,/<table[^>]*class="sr-only"/);
  assert.match(html,/<caption>Marked owned value by symbol, each bot’s quote currency/);
  assert.match(html,/<td>-50\.00<\/td>/);
});

test('histogram accessible table is clipped by a div wrapper, not a bare sr-only table',()=>{
  const html=renderToStaticMarkup(React.createElement(Histogram,{bins:[{from:-10,to:0,count:1},{from:0,to:10,count:3}],unit:'bps',sampleCount:4,excludedCount:0}));
  assert.match(html,/<div class="sr-only"><table><caption>Fill counts per bps bin/);
  assert.doesNotMatch(html,/<table[^>]*class="sr-only"/);
});

test('exposure heatmap is neutral and unsigned, while PnL heatmap stays signed',()=>{
  const cells=[{row:'v2',column:'BNB',value:2672.88}];
  const exposure=renderToStaticMarkup(React.createElement(Heatmap,{rows:['v2'],columns:['BNB'],cells,mode:'magnitude',metricLabel:'Owned exposure',unitLabel:'marked quote value'}));
  assert.match(exposure,/>2,672\.88</);
  assert.doesNotMatch(exposure,/\+2,672\.88/);
  assert.doesNotMatch(exposure,/var\(--q-positive\)/);
  assert.match(exposure,/var\(--q-blue\)/);
  const pnl=renderToStaticMarkup(React.createElement(Heatmap,{rows:['v2'],columns:['BNB'],cells}));
  assert.match(pnl,/\+2,672\.88/);
  assert.match(pnl,/var\(--q-positive\)/);
});

test('risk rail with unknown usage never reads as 0%',()=>{
  const unknown=renderToStaticMarkup(React.createElement(RailBar,{name:'daily_loss',used:null,limit:'500',unit:'USDC',state:'available',utilization:null}));
  assert.match(unknown,/Usage unavailable · limit 500\.00 USDC/);
  assert.doesNotMatch(unknown,/0\.0%/);
  const known=renderToStaticMarkup(React.createElement(RailBar,{name:'daily_loss',used:'125',limit:'500',unit:'USDC',state:'available',utilization:0.25}));
  assert.match(known,/125\.00 \/ 500\.00 USDC · 25\.0%/);
});
