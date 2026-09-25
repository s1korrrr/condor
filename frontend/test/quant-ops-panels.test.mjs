import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';

const {load}=frontendModules({'react-router-dom':{Link:({to,children,...rest})=>React.createElement('a',{href:to,...rest},children)}});
const {formatDecimal}=load('features/quant-ops/format.ts');
const {projectCapitalModel,observedDrawdown,concentration,nativeWalletFromRuntime}=load('features/quant-ops/capital-project.ts');
const {CAPITAL_PANELS,BOT_PANELS,SHELL_PANELS,ORIGINAL_CAPITAL_PANELS,ORIGINAL_BOT_PANELS,ORIGINAL_SHELL_PANELS,CAPITAL_SLICE_ROWS_1_3}=load('features/quant-ops/panel-registry.ts');
const {statStrip,drawdownSeries,maxDrawdownPoint}=load(new URL('../../../dashboard/condor-workspace/src/features/overview/capital-stats.ts', import.meta.url).pathname);
const {CapitalPage}=load(new URL('../../../dashboard/condor-workspace/src/features/overview/CapitalPage.tsx', import.meta.url).pathname);
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

test('Capital page renders every C01-C28 panel and shell panels without nested tabs',()=>{
  const model=projectCapitalModel({current:null,history:[],now:Date.now()});
  const stats=statStrip({model,accountAllowed:true,risk:null,walletChange:null,botPnl:{daily:null,weekly:null,monthly:null,quote:null},cycles:null,meanWallet:null,rangeLabel:'1D',unit:'USDT'});
  const html=renderToStaticMarkup(React.createElement(CapitalPage,{
    model,range:'1D',onRange:()=>{},bot:'rsi_modular_v2',bots:['rsi_modular_v2'],onBot:()=>{},
    botPnl:{total:null,realized:null,unrealized:null,quote:'USDC'},accountAllowed:true,
    notice:[],footer:'native',onHighlight:()=>{},highlight:null,search:'',onSearch:()=>{},
    holdingsTable:React.createElement('p',null,'holdings'),strategyChart:React.createElement('p',null,'chart'),
    stats,drawdown:{series:[],worst:null,state:{kind:'collecting',sample:{have:0,need:2}}},
    pageState:{worst:'unavailable',label:'3 sources unavailable',offenders:['a','b','c']},
  }));
  for(const id of CAPITAL_PANELS) assert.match(html,new RegExp(`data-panel-id="${id}"`));
  for(const id of CAPITAL_SLICE_ROWS_1_3) assert.match(html,new RegExp(`data-panel-id="${id}"`));
  for(const id of ['S01','S02','S03','S04','S05','S06']) assert.match(html,new RegExp(`data-panel-id="${id}"`));
  assert.doesNotMatch(html,/role="tablist"|Capital sections/);
  assert.match(html,/rsi_modular_v2/);
  assert.match(html,/30D/);
  assert.match(html,/3 sources unavailable/);
  assert.doesNotMatch(html,/All systems operational/i);
  assert.match(html,/data-state="collecting"/);
  assert.match(html,/N\/A on spot/,'liquidation risk is explicitly N\/A on the spot lane');
});

test('Capital rows draw wallet history, bot overlay, drawdown, rails, cycles and fills from admitted data',()=>{
  const t=(minutes)=>new Date(Date.now()-(30-minutes)*60000).toISOString();
  const history=[100,110,99,120,108].map((value,index)=>({observed_at:t(index),priced_total:String(value),valuation_complete:true,unpriced_assets:[]}));
  const model=projectCapitalModel({current:null,history,now:Date.now(),unit:'USDT'});
  const series=drawdownSeries(history);
  const at=new Date().toISOString();
  const html=renderToStaticMarkup(React.createElement(CapitalPage,{
    model,range:'7D',onRange:()=>{},bot:'rsi_modular_v2',bots:['rsi_modular_v2'],onBot:()=>{},
    botPnl:{total:12,realized:10,unrealized:2,quote:'USDC'},accountAllowed:true,
    notice:[],footer:'native',onHighlight:()=>{},highlight:null,search:'',onSearch:()=>{},
    holdingsTable:React.createElement('p',null,'holdings'),strategyChart:null,
    stats:statStrip({model,accountAllowed:true,risk:null,walletChange:{amount:8,percent:0.08},botPnl:{daily:1.5,weekly:null,monthly:null,quote:'USDC'},cycles:{scored:0,wins:0,losses:0,winRate:null,profitFactor:null,profitFactorReason:'NO_SCORED_CYCLE',fees:'0.21',grossVolume:'264'},meanWallet:107,rangeLabel:'7D',unit:'USDT'}),
    wallet:{points:history,currency:'USDT',state:{kind:'fresh'},coverageStart:Date.now()/1000-3600},
    drawdown:{series,worst:maxDrawdownPoint(series),state:{kind:'incomplete',reason:'observed'}},
    botSeries:{points:history.map((point,index)=>({time:Date.parse(point.observed_at),realized:index,unrealized:index,total:index*2,owner:0})),line:history.map((point,index)=>({time:Date.parse(point.observed_at),value:index*2})),quote:'USDC',state:{kind:'fresh'},restarts:[]},
    dailyBars:[{day:'2026-09-23',realized:1,unrealized:-0.5,cumulative:0.5},{day:'2026-09-24',realized:0.2,unrealized:0.1,cumulative:0.8}],
    risk:{days:5,volatilityDaily:0.012,sharpe:null,sortino:null,maxDrawdown:-0.1,var95:null,expectedShortfall95:null,returns:[0.1,-0.1,0.2,-0.1]},
    rails:{availability:'available',rails:[{name:'max_daily_loss_quote',scope:'bot',limit:'50',used:'2.3',remaining:'47.7',utilization:0.046,unit:'USDC',state:'ok',observedAt:at,source:'runtime_status.daily_entry_risk'}],tightest:{name:'max_daily_loss_quote',scope:'bot',limit:'50',used:'2.3',remaining:'47.7',utilization:0.046,unit:'USDC',state:'ok',observedAt:at,source:'runtime_status.daily_entry_risk'}},
    cycles:{quote:'USDC',counts:{open:3},cycles:[],stats:{scored:0,minSample:10,sufficient:false,wins:0,losses:0,breakeven:0,winRate:null,profitFactor:null,profitFactorReason:'NO_SCORED_CYCLE',expectancy:null,averageWin:null,averageLoss:null,payoffRatio:null,averageHoldingSeconds:null,fees:'0.21',grossVolume:'264',fillCount:9},inventoryAge:{availability:'available',reason:null,oldestAt:at,oldestSeconds:78577,weightedSeconds:59052,lots:[]}},
    fills:[{fillId:'5541826',pair:'BTC-USDC',side:'buy',amount:'0.00011',price:'84105.6',volume:'9.251616',fee:'0.0074012928',orderType:'LIMIT_MAKER',timestamp:at,orderId:'o'}],
    strategyAllocation:{owned:250.7,wallet:20691.94,unit:'USDT',ownedUnit:'USDC'},
    pageState:{worst:'incomplete',label:'2 sources incomplete',offenders:['Drawdown','Max drawdown']},
  }));
  assert.match(html,/class="q-negative">-10\.00%</, "worst drawdown heads the C19 panel; the chart marks it on hover");
  assert.match(html,/cumulative net PnL/);
  assert.match(html,/data-panel-id="C03"[^>]*data-state="fresh"/);
  assert.match(html,/\+1\.50/);
  assert.match(html,/1\.00x spot/);
  assert.match(html,/Benchmark off/);
  assert.match(html,/4\.6% of 50/);
  assert.match(html,/84105\.6/);
  assert.match(html,/Outside V2 \(wallet remainder\)/);
  assert.match(html,/21\.8h|oldest open lot/);
  assert.doesNotMatch(html,/>N\/A</);
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

test('panel registry keeps the 47 original IDs and adds the revision-2 and adaptive-layout panels (75 total)',()=>{
  assert.equal(ORIGINAL_SHELL_PANELS.length+ORIGINAL_CAPITAL_PANELS.length+ORIGINAL_BOT_PANELS.length,47);
  assert.equal(SHELL_PANELS.length+CAPITAL_PANELS.length+BOT_PANELS.length,75);
  assert.equal(new Set([...SHELL_PANELS,...CAPITAL_PANELS,...BOT_PANELS]).size,75);
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
