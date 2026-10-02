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
const {DataTable}=load('features/quant-ops/kit/DataTable.tsx');
const {projectBotPnlHistory}=load(new URL('../../../dashboard/condor-workspace/src/features/overview/useBotPnlHistory.ts', import.meta.url).pathname);

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

const FLEET={bots:['rsi_modular_v2','meridian_v3'],counted:2,expected:2,missing:[],paper:[]};
const capitalProps=(model,extra={})=>({model,now:Date.now(),range:'7D',onRange:()=>{},fleet:FLEET,accountAllowed:true,notice:[],footer:'native',onHighlight:()=>{},highlight:null,search:'',onSearch:()=>{},holdingsTable:React.createElement('p',null,'holdings'),...extra});
const fleetWallet=()=>nativeWalletFromRuntime({observedAt:new Date().toISOString(),quoteCurrency:'USDT',balances:[
  {asset:'BNB',total_balance:8,available_balance:8,value_quote:6300},{asset:'USDC',total_balance:2900,available_balance:2900,value_quote:2898},{asset:'BTC',total_balance:0.05,available_balance:0.05,value_quote:3500},
]});

test('Capital page with no data renders only shell panels and never prints Unavailable or a strategy selector',()=>{
  const model=projectCapitalModel({current:null,history:[],now:Date.now()});
  const html=renderToStaticMarkup(React.createElement(CapitalPage,capitalProps(model,{
    pageState:{worst:'collecting',label:'3 sources collecting',offenders:['a','b','c']},
  })));
  for(const id of ['S01','S02','S03','S04','S05','S06']) assert.match(html,new RegExp(`data-panel-id="${id}"`));
  for(const id of ['C01','C04','C05','C17','C06','C19','C20','C21','C25','C29']) assert.doesNotMatch(html,new RegExp(`data-panel-id="${id}"`),`${id} has no source, so it is not rendered`);
  assert.doesNotMatch(html,/Unavailable|unavailable/);
  assert.doesNotMatch(html,/role="tablist"|Capital sections|Capital strategy/);
  assert.match(html,/rsi_modular_v2/);
  assert.match(html,/meridian_v3/);
  assert.match(html,/2 of 2 bots counted/);
  assert.match(html,/30D/);
  assert.match(html,/3 sources collecting/);
  assert.doesNotMatch(html,/All systems operational/i);
  assert.match(html,/Waiting for a wallet valuation/);
  assert.match(html,/N\/A on spot/,'liquidation risk is explicitly N\/A on the spot lane');
});
test('Capital draws fleet tiles, strategy table, allocation, rails and fills from computed data and prints no Unavailable',()=>{
  const t=(minutes)=>new Date(Date.now()-(30-minutes)*60000).toISOString();
  const history=[100,110,99,120,108].map((value,index)=>({observed_at:t(index),priced_total:String(value),valuation_complete:true,unpriced_assets:[]}));
  const current=fleetWallet();
  const model=projectCapitalModel({current,history:[current],now:Date.now(),unit:'USDT'});
  const series=drawdownSeries(history);
  const at=new Date().toISOString();
  const rail={bot:'rsi_modular_v2',name:'max_daily_loss_quote',scope:'bot',limit:'50',used:'2.3',remaining:'47.7',utilization:0.046,unit:'USDC',state:'ok',observedAt:at,source:'runtime_status.daily_entry_risk'};
  const html=renderToStaticMarkup(React.createElement(CapitalPage,capitalProps(model,{
    stats:[
      {id:'C02',label:'Fleet PnL · 7D',value:'12.5',unit:'USDC',state:{kind:'fresh'},note:'since 2026-10-01 07:21 UTC (history starts here) · 2 of 2 bots'},
      {id:'C03',label:'Daily PnL',value:'4.25',unit:'USDC',state:{kind:'fresh'},note:'24h window · 2 of 2 bots'},
    ],
    statsFootnote:'Sharpe, Sortino and volatility appear after 14 days of fleet PnL (3 so far).',
    wallet:{points:history,currency:'USDT',state:{kind:'fresh'},coverageStart:Date.now()/1000-3600},
    drawdown:{series,worst:maxDrawdownPoint(series),state:{kind:'incomplete',reason:'observed'}},
    pnlNow:{total:12,realized:10,unrealized:2,quote:'USDC',counted:2,expected:2,missing:[],fromHistory:[]},
    pnlSeries:{line:history.map((point,index)=>({time:Date.parse(point.observed_at),value:index*2})),restarts:[],quote:'USDC'},
    dailyBars:[{day:'2026-09-23',realized:1,unrealized:-0.5,cumulative:0.5},{day:'2026-09-24',realized:0.2,unrealized:0.1,cumulative:0.8}],
    walletRisk:{days:5,volatilityDaily:0.012,sharpe:null,sortino:null,maxDrawdown:-0.1,var95:null,expectedShortfall95:null,returns:[0.1,-0.1,0.2,-0.1]},
    fleetRisk:null,rails:[rail],
    cycles:{quote:'USDC',bots:2,of:2,scored:3,wins:2,losses:1,winRate:2/3,grossWin:6,grossLoss:2,profitFactor:3,fees:0.21,feeBots:2,grossVolume:264,volumeBots:2,fillCount:9,openLots:3,oldestSeconds:78577},
    fills:[{bot:'rsi_modular_v2',fillId:'5541826',sourceDbId:'db',pair:'BTC-USDC',side:'buy',amount:'0.00011',price:'84105.6',volume:'9.251616',fee:'0.0074012928',orderType:'LIMIT_MAKER',timestamp:at,orderId:'o'}],
    strategies:[
      {bot:'rsi_modular_v2',pnl:9,realized:7,unrealized:2,share:0.72,netNow:9.5,netSource:'controller',quote:'USDC',fees:0.1,trades:5,scored:2,winRate:0.5,owned:200,ownedUnit:'USDT',ownedShare:0.01,since:null,restarts:0,stale:false,note:null},
      {bot:'meridian_v3',pnl:3.5,realized:3,unrealized:0.5,share:0.28,netNow:2.5,netSource:'history',quote:'USDC',fees:0.11,trades:4,scored:1,winRate:1,owned:null,ownedUnit:null,ownedShare:null,since:Date.now()-3600000,restarts:1,stale:false,note:'History starts inside the range.'},
    ],
    allocation:{rows:[{label:'rsi_modular_v2',value:200},{label:'meridian_v3',value:100}],unit:'USDT',remainder:12000,basis:['USDC valued in USDT at the wallet\'s USDC mark 0.9993'],stale:false,exceedsWallet:false},
    holdingsUnrealized:{BTC:'+0.25 USDC'},
  })));
  for(const id of ['C01','C04','C05','C17','C26','C25','C09','C10','C28','C06','C19','C20','C07','C08','C21','C29','C11','C12','C13','C22','C15','C24','C18']) assert.match(html,new RegExp(`data-panel-id="${id}"`),id);
  assert.doesNotMatch(html,/Unavailable|unavailable/);
  assert.match(html,/class="q-negative">-10\.00%</,'worst drawdown heads the C19 panel; the chart marks it on hover');
  assert.match(html,/Fleet cumulative net PnL/);
  assert.match(html,/since 2026-10-01 07:21 UTC \(history starts here\)/);
  assert.match(html,/Fleet PnL · 7D/);
  assert.match(html,/Sharpe, Sortino and volatility appear after 14 days/);
  assert.match(html,/\+12\.00|\+12/);
  assert.match(html,/4\.6% of 50/);
  assert.match(html,/84105\.6/);
  assert.match(html,/1\.00x spot/);
  assert.match(html,/PnL by strategy/);
  assert.match(html,/meridian_v3/);
  assert.match(html,/Allocation by strategy/);
  assert.match(html,/Includes deposits and withdrawals/);
  assert.match(html,/oldest open lot|oldest 21\.8h/);
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

test('available cash tile is not rendered when no USDC balance exists, regardless of a fresh USDT wallet',()=>{
  const current=nativeWalletFromRuntime({observedAt:new Date().toISOString(),quoteCurrency:'USDT',balances:[{asset:'BTC',total_balance:'0.1',available_balance:'0.1',value_quote:'6000'}]});
  const model=projectCapitalModel({current,history:[],now:Date.now(),unit:'USDT'});
  const html=renderToStaticMarkup(React.createElement(CapitalPage,capitalProps(model,{range:'1D'})));
  assert.match(html,/data-panel-id="C01"/);
  assert.doesNotMatch(html,/data-panel-id="C04"/);
  assert.doesNotMatch(html,/Unavailable/);
});
test('allocation by strategy states when no remainder can be computed and when owned value exceeds the wallet',()=>{
  const model=projectCapitalModel({current:null,history:[],now:Date.now(),unit:'USDT'});
  const withheld=renderToStaticMarkup(React.createElement(CapitalPage,capitalProps(model,{allocation:{rows:[{label:'rsi_modular_v2',value:120}],unit:'USDC',remainder:null,basis:['Owned values are in USDC; the wallet is in USDT. No wallet mark converts them, so no remainder is computed.'],stale:false,exceedsWallet:false}})));
  assert.match(withheld,/data-panel-id="C21" data-state="incomplete"/);
  assert.doesNotMatch(withheld,/Unallocated/);
  assert.match(withheld,/no remainder is computed/);
  const exceeds=renderToStaticMarkup(React.createElement(CapitalPage,capitalProps(model,{allocation:{rows:[{label:'rsi_modular_v2',value:120}],unit:'USDT',remainder:0,basis:['Owned value exceeds the wallet valuation; the remainder is shown as zero.'],stale:false,exceedsWallet:true}})));
  assert.match(exceeds,/data-panel-id="C21" data-state="incomplete"/);
  assert.match(exceeds,/exceeds the wallet valuation/);
});
test('Capital holdings use the seven-column table adapter and render header and row values',()=>{
  const rows=[{token:'BTC',total:'0.12',available:'0.12',price:'100000',value:'12000'}];
  const columns=[
    {id:'asset',header:'Asset',rowHeader:true,value:row=>row.token,cell:row=>React.createElement('button',null,row.token)},
    {id:'total',header:'Total',kind:'number',value:row=>row.total,cell:row=>row.total},
    {id:'available',header:'Available',kind:'number',value:row=>row.available,cell:row=>row.available},
    {id:'mark',header:'Mark',kind:'number',value:row=>row.price,cell:row=>row.price},
    {id:'value',header:'Value',kind:'number',value:row=>row.value,cell:row=>row.value},
    {id:'unrealized',header:'V2 unrealized',kind:'number',value:()=>null,cell:()=>React.createElement('span',{className:'q-muted'},'not V2-owned')},
    {id:'chart',header:'Chart',value:()=>null,cell:()=>React.createElement('span',{className:'q-muted'},'—')},
  ];
  const html=renderToStaticMarkup(React.createElement(DataTable,{label:'Account holdings',rows,columns,rowId:row=>row.token,initialSort:{id:'value',desc:true},pageSize:10}));
  for(const header of ['Asset','Total','Available','Mark','Value','V2 unrealized','Chart']) assert.match(html,new RegExp(`>${header}<`));
  for(const cell of ['BTC','0.12','100000','12000','not V2-owned']) assert.match(html,new RegExp(cell));
  assert.equal((html.match(/<td /g)||[]).length,6);
  assert.equal((html.match(/<th scope="col"/g)||[]).length,7);
});

test('bot PnL qualification rejects stale and partial range history while preserving the quote',()=>{
  const now=Date.parse('2026-09-26T15:00:00Z');
  const start=Date.parse('2026-09-20T00:00:00Z');
  const end=Date.parse('2026-09-25T12:32:00Z');
  const points=Array.from({length:3044},(_,index)=>{
    const timestamp=Math.floor((start+index*(end-start)/3043)/1000);
    return {timestamp,total_pnl_quote:String(index/10),realized_pnl_quote:String(index/20),unrealized_pnl_quote:String(index/20),quote:'USDC',identity:'bot-v2',segment:'owner-1'};
  });
  const payload={source:'native_mqtt_observer',bot_name:'rsi_modular_v2',range:'1W',coverage_start:points[0].timestamp,points,truncated:false};
  const stale=projectBotPnlHistory(payload,'rsi_modular_v2','1W',now);
  assert.equal(stale.state.kind,'stale','a 27-hour-old observation cannot be labeled fresh');
  assert.equal(stale.change,null,'stale performance cannot produce weekly PnL');
  assert.equal(stale.quote,'USDC','native bot quote stays separate from wallet USDT');
  const partialPoints=Array.from({length:5*24+1},(_,index)=>{
    const timestamp=Math.floor((now-5*86_400_000+index*5*86_400_000/(5*24))/1000);
    return {timestamp,total_pnl_quote:String(index),realized_pnl_quote:String(index/2),unrealized_pnl_quote:String(index/2),quote:'USDC',identity:'bot-v2',segment:'owner-1'};
  });
  const partial=projectBotPnlHistory({...payload,points:partialPoints},'rsi_modular_v2','1W',now);
  assert.equal(partial.state.kind,'incomplete','five days cannot qualify as a full seven-day window');
  assert.equal(partial.change,null);
});

test('a fresh, fully covered selected bot window still withholds its delta across a restart gap',()=>{
  const now=Date.parse('2026-09-26T15:00:00Z');
  const start=Math.floor((now-7*86_400_000)/1000);
  const finish=Math.floor(now/1000);
  const points=[
    {timestamp:start,total_pnl_quote:'1',realized_pnl_quote:'0.5',unrealized_pnl_quote:'0.5',quote:'USDC',identity:'bot-v2',segment:'old'},
    {timestamp:Math.floor((start+finish)/2),total_pnl_quote:'2',realized_pnl_quote:'1',unrealized_pnl_quote:'1',quote:'USDC',identity:'bot-v2',segment:'new'},
    {timestamp:finish,total_pnl_quote:'3',realized_pnl_quote:'1.5',unrealized_pnl_quote:'1.5',quote:'USDC',identity:'bot-v2',segment:'new'},
  ];
  const result=projectBotPnlHistory({source:'native_mqtt_observer',bot_name:'rsi_modular_v2',range:'1W',coverage_start:start,points,truncated:false},'rsi_modular_v2','1W',now);
  assert.equal(result.state.kind,'incomplete','a restart gap inside the selected window makes its history incomplete');
  assert.equal(result.change,null,'a segment transition inside the selected window blocks a synthetic partial delta');
  assert.ok(result.line.some(point=>point.value===null),'the chart retains an explicit break at the segment boundary');
});

test('broad saved history cannot qualify a long selected range using only its recent tail',()=>{
  const now=Date.parse('2026-09-26T15:00:00Z');
  const old=Date.parse('2025-09-01T00:00:00Z');
  const points=[
    {timestamp:Math.floor(old/1000),total_pnl_quote:'1',realized_pnl_quote:'0.5',unrealized_pnl_quote:'0.5',quote:'USDC',identity:'bot-v2',segment:'owner'},
    ...Array.from({length:5*24+1},(_,index)=>{const timestamp=Math.floor((now-5*86_400_000+index*5*86_400_000/(5*24))/1000);return {timestamp,total_pnl_quote:String(index+2),realized_pnl_quote:String(index+1),unrealized_pnl_quote:'1',quote:'USDC',identity:'bot-v2',segment:'owner'};}),
  ];
  const result=projectBotPnlHistory({source:'native_mqtt_observer',bot_name:'rsi_modular_v2',range:'ALL',coverage_start:points[0].timestamp,points,truncated:false},'rsi_modular_v2','ALL',now,false,{start:new Date(now-90*86_400_000).toISOString(),end:new Date(now).toISOString()});
  assert.equal(result.state.kind,'incomplete','the selected 90-day interval has only five days of samples');
  assert.equal(result.change,null);
  assert.equal(result.points.length,5*24,'the half-open window excludes its exact end-boundary sample');
  assert.ok(result.points[0].time >= now-6*86_400_000);
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
  const html=renderToStaticMarkup(React.createElement(CapitalPage,capitalProps(model,{range:'1D',accountAllowed:false,footer:'rsibot-stack-v2'})));
  assert.match(html,/21,182\.86|21182/);
  assert.doesNotMatch(html,/Research read check failed/);
  assert.doesNotMatch(html,/Unavailable/);
});
test('row panels from last-known owner data read stale, never fresh; empty is unavailable',()=>{
  const {rowsPanelState}=load('features/quant-ops/panel-state.ts');
  assert.deepEqual(rowsPanelState(3,'none',[]),{kind:'fresh'});
  assert.deepEqual(rowsPanelState(0,'No rows.',[{name:'v2',observedAt:'2026-10-01T07:00:00Z'}]),{kind:'unavailable',reason:'No rows.'});
  const one=rowsPanelState(5,'x',[{name:'v2',observedAt:'2026-10-01T07:00:00Z'}]);
  assert.equal(one.kind,'stale');assert.equal(one.observedAt,'2026-10-01T07:00:00Z');assert.match(one.reason,/v2 has no current owner heartbeat/);
  const two=rowsPanelState(5,'x',[{name:'a',observedAt:'2026-10-01T08:00:00Z'},{name:'b',observedAt:'2026-10-01T06:00:00Z'},{name:'c',observedAt:null}]);
  assert.equal(two.observedAt,'2026-10-01T06:00:00Z');assert.match(two.reason,/a, b, c have no current owner heartbeat/);
});
