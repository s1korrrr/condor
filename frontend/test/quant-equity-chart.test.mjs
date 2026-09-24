import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';
const {load}=frontendModules();
const {EquityChart}=load('features/quant-ops/EquityChart.tsx');
const {Donut}=load('features/quant-ops/primitives.tsx');
const mark=(second,value,complete=true)=>({observed_at:new Date(Date.UTC(2026,8,1)+second*1000).toISOString(),priced_total:value,valuation_complete:complete,unpriced_assets:[]});
test('interactive equity chart preserves price gaps and exact inspected value',()=>{
 const html=renderToStaticMarkup(React.createElement(EquityChart,{unit:'USDT',points:[mark(0,'100'),mark(60,'101'),mark(120,'103',false),mark(180,'104'),mark(240,'105')]}));
 assert.equal([...html.matchAll(/stroke-width="2"\><\/path>/g)].length,2);
 assert.match(html,/Equity observation/);
 assert.match(html,/105\.00 USDT/);
 assert.doesNotMatch(html,/NaN|Infinity/);
});
test('isolated observation is a visible mark and invalid chronology is rejected',()=>{
 assert.match(renderToStaticMarkup(React.createElement(EquityChart,{unit:'USDT',points:[mark(0,'100')]})),/<circle/);
 assert.match(renderToStaticMarkup(React.createElement(EquityChart,{unit:'USDT',points:[mark(60,'100'),mark(0,'101')]})),/timestamps are invalid/);
});
test('one-asset composition renders a full ring instead of a degenerate arc',()=>{
 const html=renderToStaticMarkup(React.createElement(Donut,{slices:[{label:'USDC',value:100}],center:'100',unit:'USDT',complete:true}));
 assert.match(html,/<circle cx="56" cy="56" r="44"/);
});
