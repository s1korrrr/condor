import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';
const {load}=frontendModules();
const {EquityChart}=load('features/quant-ops/EquityChart.tsx');
const {Donut}=load('features/quant-ops/primitives.tsx');
const {projectTimeSeries}=load('features/quant-ops/kit/series.ts');
const {historySeries}=load('features/portfolio/model.ts');
const mark=(second,value,complete=true)=>({observed_at:new Date(Date.UTC(2026,8,1)+second*1000).toISOString(),priced_total:value,valuation_complete:complete,unpriced_assets:[]});
test('equity chart splits at unpriced observations and counts only valued marks',()=>{
 const points=[mark(0,'100'),mark(60,'101'),mark(120,'103',false),mark(180,'104'),mark(240,'105')];
 const projection=projectTimeSeries([{id:'wallet',label:'Wallet',color:'blue',points:historySeries(points)}]);
 assert.deepEqual(projection.keys.map(entry=>entry.key),['wallet~0','wallet~1'],'the unpriced mark breaks the line into two runs');
 assert.equal(projection.rows.length,4);
 const html=renderToStaticMarkup(React.createElement(EquityChart,{unit:'USDT',points}));
 assert.match(html,/4 valued marks · hover to inspect/);
 assert.doesNotMatch(html,/type="range"|Equity observation/,'the observation slider is replaced by hover inspection');
 assert.doesNotMatch(html,/NaN|Infinity/);
});
test('empty history and invalid chronology are stated, not plotted',()=>{
 assert.match(renderToStaticMarkup(React.createElement(EquityChart,{unit:'USDT',points:[]})),/No valued observations yet/);
 assert.match(renderToStaticMarkup(React.createElement(EquityChart,{unit:'USDT',points:[mark(60,'100'),mark(0,'101')]})),/timestamps are invalid/);
});
test('one-asset composition renders a full ring legend at 100%',()=>{
 const html=renderToStaticMarkup(React.createElement(Donut,{slices:[{label:'USDC',value:100}],center:'100',unit:'USDT',complete:true}));
 assert.match(html,/100\.0%/);
 assert.match(html,/USDC/);
});
test('history gaps follow the read cadence, not a fixed minute',()=>{
 const points=[0,300,600,2400].map((second,index)=>mark(second,String(100+index)));
 assert.equal(historySeries(points).filter(point=>point.value===null).length,3,'one-minute cadence: every 5-minute step is a gap');
 assert.equal(historySeries(points,750_000).filter(point=>point.value===null).length,1,'5-minute buckets: only the 30-minute hole is a gap');
});
