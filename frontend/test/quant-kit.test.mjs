import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';

const {load}=frontendModules();
const {TileGrid}=load('features/quant-ops/kit/grid.tsx');
const {balancedColumns,tileSpans}=load('features/quant-ops/kit/layout.ts');
const {projectTimeSeries,valueAt,valueDomain}=load('features/quant-ops/kit/series.ts');
const {DataTable}=load('features/quant-ops/kit/DataTable.tsx');
const {numericFilterMatch,searchMatch}=load('features/quant-ops/kit/table-filter.ts');

test('tile grid fills rows instead of leaving a lone tile',()=>{
  assert.equal(balancedColumns(10,1640,210,10,5),5,'ten KPI tiles become two rows of five');
  assert.equal(balancedColumns(6,1640,210,10,5),3,'six tiles become two rows of three, not five plus one');
  assert.equal(balancedColumns(11,1640,150,10),6);
  assert.equal(balancedColumns(12,900,200,10,6),4,'a narrow screen keeps the minimum tile width');
  assert.equal(balancedColumns(3,300,200,10),2,'phones use two compact columns');
  assert.equal(balancedColumns(1,300,200,10),1);
  assert.deepEqual(tileSpans(11,6),{tracks:30,spans:[...Array(6).fill(5),...Array(5).fill(6)]},'the short last row stretches edge to edge');
  assert.deepEqual(tileSpans(10,5).spans,Array(10).fill(1));
});

test('tile grid renders every child in its own size container',()=>{
  const html=renderToStaticMarkup(React.createElement(TileGrid,{label:'KPIs',min:200},...['a','b','c'].map(key=>React.createElement('article',{key},key))));
  assert.equal([...html.matchAll(/class="q-tile-cell"/g)].length,3);
  assert.match(html,/aria-label="KPIs"/);
});

test('time projection merges series on one axis without breaking the other series',()=>{
  const wallet=[{time:0,value:100},{time:60,value:101},{time:120,value:102}];
  const bot=[{time:30,value:1},{time:90,value:null},{time:150,value:2}];
  const projection=projectTimeSeries([{id:'wallet',label:'Wallet',color:'b',points:wallet},{id:'bot',label:'Bot',color:'c',axis:'secondary',points:bot}]);
  assert.deepEqual(projection.rows.map(row=>row.time),[0,30,60,120,150]);
  assert.deepEqual(projection.keys.map(key=>key.key),['wallet~0','bot~0','bot~1']);
  assert.equal(projection.keys.find(key=>key.key==='bot~1').single.time,150,'an isolated sample is marked as a single point');
  assert.equal(valueAt(bot,100).value,null);
  assert.equal(valueAt(wallet,-1),null,'no value before the first sample');
  assert.match(projectTimeSeries([{id:'x',label:'X',color:'r',points:[{time:5,value:1},{time:5,value:2}]}]).invalid,/out of order/);
  assert.match(projectTimeSeries([{id:'x',label:'X',color:'r',points:[{time:5,value:Infinity}]}]).invalid,/finite/);
  const [low,high]=valueDomain([{id:'w',label:'W',color:'b',points:[{time:0,value:-0.1},{time:1,value:0}]}],true);
  assert.ok(low< -0.1 && high>0,'drawdown domain includes zero with padding');
});

test('numeric column filters accept comparisons and ranges',()=>{
  assert.equal(numericFilterMatch('-0.84','<0'),true);
  assert.equal(numericFilterMatch(5,'>=5'),true);
  assert.equal(numericFilterMatch(5,'1..4'),false);
  assert.equal(numericFilterMatch('2.5','2..3'),true);
  assert.equal(numericFilterMatch(null,'>0'),false,'missing values never pass a comparison');
  assert.equal(numericFilterMatch('84105.6','8410'),true,'plain text falls back to contains');
});

test('data table sorts by the raw value and keeps formatted cells',()=>{
  const rows=[{id:'a',asset:'ETH',value:'7231.19'},{id:'b',asset:'BTC',value:'107.5'},{id:'c',asset:'XRP',value:null}];
  const html=renderToStaticMarkup(React.createElement(DataTable,{label:'Holdings',rows,rowId:row=>row.id,initialSort:{id:'value',desc:true},exportName:'h.csv',
    columns:[{id:'asset',header:'Asset',rowHeader:true,value:row=>row.asset},{id:'value',header:'Value',kind:'number',value:row=>row.value,cell:row=>row.value==null?'Unavailable':`${row.value} USDT`}]}));
  assert.ok(html.indexOf('ETH')<html.indexOf('BTC')&&html.indexOf('BTC')<html.indexOf('XRP'),'numeric sort, missing values last');
  assert.match(html,/7231\.19 USDT/);
  assert.match(html,/aria-sort="descending"/);
  assert.match(html,/3 rows/);
  assert.match(html,/Export CSV/);
  assert.match(html,/role="separator"[^>]*aria-label="Resize Value"/);
});

test('table search matches displayed text as well as raw values',()=>{
  assert.equal(searchMatch(['0.553',null],'55.3%'),false);
  assert.equal(searchMatch(['0.553','55.3%'],'55.3%'),true);
  assert.equal(searchMatch([null,'Unknown basis'],'unknown'),true);
  assert.equal(searchMatch(['ETH'],'  '),true,'blank search keeps every row');
  const rows=[{id:'a',pnl:null},{id:'b',pnl:'1'}];
  const columns=[{id:'id',header:'Id',value:row=>row.id},{id:'pnl',header:'PnL',kind:'number',value:row=>row.pnl,cell:row=>row.pnl==null?'Unknown basis':row.pnl}];
  const html=renderToStaticMarkup(React.createElement(DataTable,{label:'T',rows,columns,rowId:row=>row.id}));
  assert.match(html,/Unknown basis/);
});

test('a pinned row leads every sort and is never hidden behind Show all',()=>{
  const rows=Array.from({length:15},(_,index)=>({id:`r${index}`,value:index}));
  const html=renderToStaticMarkup(React.createElement(DataTable,{label:'T',rows,rowId:row=>row.id,pageSize:5,initialSort:{id:'value',desc:true},pinned:row=>row.id==='r0',
    columns:[{id:'id',header:'Id',rowHeader:true,value:row=>row.id},{id:'value',header:'Value',kind:'number',value:row=>row.value}]}));
  const order=[...html.matchAll(/<th scope="row"[^>]*>(r\d+)</g)].map(match=>match[1]);
  assert.deepEqual(order,['r0','r14','r13','r12','r11'],'the smallest value is pinned first, the rest follow the sort');
  assert.match(html,/Show all 15 rows/);
  assert.match(html,/role="separator" tabindex="0"/,'column resize is keyboard reachable');
});
