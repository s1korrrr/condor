import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';

const {load}=frontendModules({'react-router-dom':{Link:({to,children,...rest})=>React.createElement('a',{href:to,...rest},children)}});
const {formatDecimal}=load('features/quant-ops/format.ts');
const {projectCapitalModel,observedDrawdown,concentration,nativeWalletFromRuntime}=load('features/quant-ops/capital-project.ts');
const {CAPITAL_PANELS,BOT_PANELS,SHELL_PANELS}=load('features/quant-ops/panel-registry.ts');
const {CapitalPage}=load('/Users/s1kor/dev/trading/rsibot/dashboard/condor-workspace/src/features/overview/CapitalPage.tsx');
const {RosterObservation}=load('components/bots/BotsRoster.tsx');

test('capital dashboard overlay keeps incomplete flows as unavailable PnL',()=>{
  const model=projectCapitalModel({
    current:{observed_at:new Date().toISOString(),priced_total:'12100',valuation_complete:true,unpriced_assets:[],holdings:[
      {token:'USDC',total:'2000',available:'2000',locked:'0',price:'1',value:'2000',quote_currency:'USDT',valuation_source:'x',price_observed_at:new Date().toISOString()},
    ]},
    history:[],
    now:Date.now(),
    dashboard:{period_pnl:{value:null,reason_code:'FLOW_COVERAGE_INCOMPLETE'},sample_days:12,volatility:null,sharpe:null},
  });
  assert.equal(model.periodPnl.value,null);
  assert.equal(model.sampleDays,0);
  assert.equal(model.volatility,null);
});

test('tiny nonzero BNB stays nonzero and missing is not zero',()=>{
  assert.equal(formatDecimal('0'),'0');
  assert.match(formatDecimal('0.0000005224'),/5\.224e-7|0\.0000005224|5\.224/);
  assert.equal(formatDecimal(null),'Unavailable');
});

test('capital projection does not turn deposits or missing flows into PnL',()=>{
  const model=projectCapitalModel({
    current:{observed_at:new Date().toISOString(),priced_total:'12100',valuation_complete:true,unpriced_assets:[],holdings:[
      {token:'USDC',total:'2000',available:'2000',locked:'0',price:'1',value:'2000',quote_currency:'USDT',valuation_source:'x',price_observed_at:new Date().toISOString()},
      {token:'ETH',total:'1',available:'1',locked:'0',price:'10100',value:'10100',quote_currency:'USDT',valuation_source:'x',price_observed_at:new Date().toISOString()},
    ]},
    history:[{observed_at:new Date(Date.now()-60000).toISOString(),priced_total:'10000',valuation_complete:true,unpriced_assets:[]},{observed_at:new Date().toISOString(),priced_total:'12100',valuation_complete:true,unpriced_assets:[]}],
    now:Date.now(),
  });
  assert.equal(model.periodPnl.value,null);
  assert.equal(model.todayPnl.value,null);
  assert.equal(model.volatility,null);
  assert.equal(model.sampleDays,0);
  assert.equal(model.availableQuote.value,'2000');
  assert.ok(Number(model.deployed.value)>0);
  assert.equal(concentration(model.holdings,12100).top3,1);
  assert.ok(observedDrawdown(model.history)===null || observedDrawdown(model.history)<=0);
});

test('Capital page renders C01-C16 and shell panels without nested tabs',()=>{
  const model=projectCapitalModel({current:null,history:[],now:Date.now()});
  const html=renderToStaticMarkup(React.createElement(CapitalPage,{
    model,range:'1D',onRange:()=>{},bot:'rsi_modular_v2',bots:['rsi_modular_v2'],onBot:()=>{},
    botPnl:{total:null,realized:null,unrealized:null,quote:'USDC'},accountAllowed:true,
    notice:[],footer:'native',onHighlight:()=>{},highlight:null,search:'',onSearch:()=>{},
    holdingsTable:React.createElement('p',null,'holdings'),strategyChart:React.createElement('p',null,'chart'),
  }));
  for(const id of CAPITAL_PANELS) assert.match(html,new RegExp(`data-panel-id="${id}"`));
  for(const id of ['S01','S02','S03','S04','S05','S06']) assert.match(html,new RegExp(`data-panel-id="${id}"`));
  assert.doesNotMatch(html,/role="tablist"|Capital sections/);
  assert.match(html,/rsi_modular_v2/);
  assert.match(html,/Unavailable/);
  assert.match(html,/30D/);
});

test('Bot roster keeps mixed pair states and B-panel anatomy in page flow',()=>{
  const now=Date.parse('2026-09-15T10:00:00Z');
  const payload={runtime_status:{bot_name:'rsi_modular_v2',updated_at:new Date(now-1000).toISOString(),controllers:[
    {controller_id:'eth',pair:'ETH-USDC',price_quote:2500,state:'HOLDING',custom_info:{episode:{enabled:true,base:'0.04',cost:'99',cost_known:true},trailing_policy:{floor:2490,peak:2520}}},
    {controller_id:'btc',pair:'BTC-USDC',price_quote:70000,state:'FLAT',custom_info:{}},
  ],positions_held:[],active_executors:[],active_orders:[],active_orders_status:{complete:true}},monitoring:{bot_name:'rsi_modular_v2',stale_threshold_seconds:30}};
  const html=renderToStaticMarkup(React.createElement(RosterObservation,{payload,bot:'rsi_modular_v2',now}));
  assert.match(html,/ETH-USDC/);
  assert.match(html,/BTC-USDC/);
  assert.match(html,/MIXED: 1 holding \/ 1 flat|MIXED: 1 flat \/ 1 holding/);
  assert.doesNotMatch(html,/position inspector|bot-desk__rail/);
  for(const id of ['B11','B12','B13','B14','B15','B16','B17','B18','B19','B20','B21','B22']) {
    assert.match(html,new RegExp(`data-panel-id="${id}"`));
  }
});

test('panel registry covers the 47 specified IDs',()=>{
  assert.equal(SHELL_PANELS.length+CAPITAL_PANELS.length+BOT_PANELS.length,47);
});

test('native wallet observation preserves tiny inventory and shared-wallet totals',()=>{
  const current=nativeWalletFromRuntime({
    observedAt:new Date().toISOString(),
    quoteCurrency:'USDT',
    balances:[
      {asset:'BNB',total_balance:8.015,available_balance:8.015,value_quote:6312.72,exchange:'okx'},
      {asset:'USDC',total_balance:2942.85,available_balance:2942.85,value_quote:2942.85,exchange:'okx'},
      {asset:'BTC',total_balance:5.224e-7,available_balance:5.224e-7,value_quote:0.04,exchange:'okx'},
    ],
  });
  assert.ok(current);
  assert.equal(current.valuation_complete,true);
  assert.ok(Number(current.priced_total)>9000);
  assert.equal(current.holdings.find(row=>row.token==='BTC').total,'5.224e-7');
  const model=projectCapitalModel({current,history:[current],now:Date.now(),unit:'USDT'});
  assert.equal(model.equity.unit,'USDT');
  assert.ok(Number(model.equity.value)>9000);
  assert.equal(model.availableQuote.value,'2942.85');
  assert.equal(model.periodPnl.value,null);
});

test('Capital KPIs use observed wallet even when account credential reads are off',()=>{
  const model=projectCapitalModel({
    current:{observed_at:new Date().toISOString(),priced_total:'21182.86',valuation_complete:true,unpriced_assets:[],holdings:[
      {token:'USDC',total:'2942.85',available:'2942.85',locked:'0',price:'1',value:'2942.85',quote_currency:'USDT',valuation_source:'native-runtime-status',price_observed_at:new Date().toISOString()},
    ]},
    history:[],
    now:Date.now(),
    unit:'USDC',
  });
  const html=renderToStaticMarkup(React.createElement(CapitalPage,{
    model,range:'1D',onRange:()=>{},bot:'rsi_modular_v2',bots:['rsi_modular_v2'],onBot:()=>{},
    botPnl:{total:null,realized:null,unrealized:null,quote:'USDC'},accountAllowed:false,
    notice:[],footer:'rsibot-stack-v2',onHighlight:()=>{},highlight:null,search:'',onSearch:()=>{},
    holdingsTable:React.createElement('p',null,'holdings'),strategyChart:React.createElement('p',null,'chart'),
  }));
  assert.match(html,/21,182\.86|21182/);
  assert.doesNotMatch(html,/Research read check failed/);
});
