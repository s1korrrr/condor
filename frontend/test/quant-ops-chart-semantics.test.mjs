import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';

const {load}=frontendModules();
const {QuantTimeSeries,Heatmap,StackedBar}=load('features/quant-ops/primitives.tsx');
const {assetColor}=load('features/quant-ops/format.ts');

test('equity curve uses elapsed time and keeps gap fills separate',()=>{
  const start=Date.parse('2026-09-01T00:00:00Z');
  const html=renderToStaticMarkup(React.createElement(QuantTimeSeries,{unit:'USDT',points:[
    {time:start,value:100},{time:start+60_000,value:110},
    {time:start+120_000,value:null},{time:start+86_400_000,value:120},
    {time:start+86_460_000,value:130},
  ]}));
  assert.match(html,/L 0\.22[0-9]*,/);
  assert.equal([...html.matchAll(/opacity="0\.16"/g)].length,2);
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
