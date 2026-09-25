import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';

const {load}=frontendModules();
const {Heatmap,StackedBar}=load('features/quant-ops/primitives.tsx');
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

test('signed controller PnL heatmap identifies PnL rather than exposure',()=>{
  const html=renderToStaticMarkup(React.createElement(Heatmap,{rows:['v2'],columns:['BTC','ETH'],cells:[
    {row:'v2',column:'BTC',value:-50},{row:'v2',column:'ETH',value:30},
  ]}));
  assert.match(html,/Controller PnL by symbol heatmap/);
  assert.match(html,/var\(--q-negative\)/);
  assert.match(html,/var\(--q-positive\)/);
  assert.match(html,/<table[^>]*class="sr-only"/);
  assert.match(html,/<caption>Controller PnL by symbol/);
  assert.match(html,/<td>-50\.00<\/td>/);
});
