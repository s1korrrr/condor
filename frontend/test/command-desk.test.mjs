import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRequire} from 'node:module';
const queryLibrary=createRequire(import.meta.url)('@tanstack/react-query');
const {QueryClient, QueryClientProvider}=queryLibrary;
import {frontendModules} from './helpers/frontend-module.mjs';
const {load}=frontendModules({'react-router-dom':{Link:({to,children,...rest})=>React.createElement('a',{href:to,...rest},children)}});
const {CommandDeskObservation}=load('components/bots/NativeBotCommandDesk.tsx');
const now=Date.parse('2026-09-15T10:00:00Z');
function snapshot(){return {runtime_status:{bot_name:'ok_rsi',updated_at:new Date(now-1000).toISOString(),controllers:[{controller_id:'eth',pair:'ETH-USDC',price_quote:2500,state:'DISTRIBUTE',custom_info:{episode:{enabled:true,base:'0.04',cost:'99',cost_known:true},trailing_policy:{floor:2490,peak:2520}}},{controller_id:'btc',pair:'BTC-USDC',price_quote:70000,custom_info:{}}],positions_held:[],active_executors:[],active_orders:[],active_orders_status:{complete:true}},monitoring:{bot_name:'ok_rsi',stale_threshold_seconds:30}};}
const render=(props={})=>renderToStaticMarkup(React.createElement(CommandDeskObservation,{payload:snapshot(),bot:'ok_rsi',now,section:'positions',selected:null,onSelect:()=>{},...props}));
test('command desk selects an actual position and distinguishes mark, net units, cost and purchase receipts',()=>{
 const html=render();
 assert.match(html,/ETH-USDC position inspector/);assert.match(html,/100 USDC/);assert.match(html,/0.04 ETH/);assert.match(html,/99 USDC/);
 assert.match(html,/Gross purchase spend.*unavailable/);assert.match(html,/bot=ok_rsi&amp;pair=ETH-USDC&amp;view=activity&amp;record=fills/);
 assert.doesNotMatch(html,/BTC-USDC position inspector/);
});
test('selected controller identity does not fall back to another position or owner',()=>{
 assert.match(render({selected:'btc'}),/BTC-USDC position inspector/);
 const removed=render({selected:'removed'});assert.match(removed,/no longer reported/);assert.doesNotMatch(removed,/position inspector/);
 const wrongOwner=render({bot:'ok_rsi_sui_sell_only'});assert.match(wrongOwner,/does not match/);assert.doesNotMatch(wrongOwner,/100 USDC/);
});
test('stale observations suppress current inspector and known amounts',()=>{
 const stale=render({now:now+31000});assert.match(stale,/stale/);assert.doesNotMatch(stale,/100 USDC|position inspector|99 USDC/);
});
test('working orders requires complete exchange evidence, not conditional plans',()=>{
 assert.match(render({section:'orders'}),/No active orders/);
 const payload=snapshot();payload.runtime_status.active_orders_status.complete=false;payload.runtime_status.active_orders_count=0;
 const partial=render({payload,section:'orders'});assert.match(partial,/Complete exchange order detail is unavailable/);assert.doesNotMatch(partial,/No active orders/);
});
test('controller tab retains native evidence and hides unrelated inspector',()=>{
 const html=render({section:'controllers'});assert.match(html,/Controller observations/);assert.match(html,/Observed price levels/);assert.doesNotMatch(html,/position inspector/);
});

test('buy/sell trips tab lists filled realized PnL and omits guessed unknown-cost PnL',()=>{
 const trips=[{
  pair:'ETH-USDC',quote:'USDC',sourceDbId:'db',openedAt:'2026-09-01T00:00:00Z',closedAt:'2026-09-01T01:00:00Z',
  outcome:'filled',pnlUnavailableReason:null,buyAmountBase:'1',sellAmountBase:'1',remainingBase:'0',
  remainingCostQuote:0,realizedPnlQuote:10,feesQuote:0.1,fills:[{fillId:'s1',orderId:'o',side:'sell',amountBase:'1',priceQuote:110,feeQuote:0,timestamp:'2026-09-01T01:00:00Z',realizedPnlQuote:10}],
 },{
  pair:'SUI-USDC',quote:'USDC',sourceDbId:'db',openedAt:'2026-09-12T20:42:00Z',closedAt:null,
  outcome:'unknown_cost',pnlUnavailableReason:'unknown_wallet_acquisition_cost',buyAmountBase:'0',sellAmountBase:'20.975',remainingBase:'0',
  remainingCostQuote:null,realizedPnlQuote:null,feesQuote:0,fills:[],
 }];
 const html=render({section:'trips',trips});
 assert.match(html,/Buy\/sell trips/);assert.match(html,/>Filled</);assert.match(html,/\+10 USDC/);assert.match(html,/Unknown cost/);
 assert.match(html,/unknown wallet acquisition cost/);assert.doesNotMatch(html,/\+20\.975/);assert.doesNotMatch(html,/position inspector/);
});

test('cancelled unfilled orders collapse out of the trip table',()=>{
 const trips=[{
  pair:'ETH-USDC',quote:'USDC',sourceDbId:'db',openedAt:'2026-09-01T00:00:00Z',closedAt:'2026-09-01T01:00:00Z',
  outcome:'filled',pnlUnavailableReason:null,buyAmountBase:'1',sellAmountBase:'1',remainingBase:'0',
  remainingCostQuote:0,realizedPnlQuote:10,feesQuote:0,fills:[],
 },{
  pair:'ETH-USDC',quote:'USDC',sourceDbId:'db',openedAt:'2026-09-01T03:00:00Z',closedAt:'2026-09-01T03:00:00Z',
  outcome:'cancelled',pnlUnavailableReason:null,buyAmountBase:'0',sellAmountBase:'0',remainingBase:'0',
  remainingCostQuote:null,realizedPnlQuote:null,feesQuote:0,fills:[],
 }];
 const html=render({section:'trips',trips});
 assert.match(html,/Cancelled unfilled orders \(1\)/);
 assert.doesNotMatch(html,/<td>Cancelled</);
});

test('selected position uses fill-replay remaining cost when the open trip has basis',()=>{
 const trips=[{
  pair:'ETH-USDC',quote:'USDC',sourceDbId:'db',openedAt:'2026-09-01T00:00:00Z',closedAt:null,outcome:'in_bag',
  pnlUnavailableReason:null,buyAmountBase:'0.04',sellAmountBase:'0',remainingBase:'0.04',remainingCostQuote:99,
  realizedPnlQuote:0,feesQuote:0,fills:[],
 }];
 const html=render({trips});
 assert.match(html,/Fill-replay remaining cost 99 USDC/);assert.match(html,/still in the bag 0.04/);assert.doesNotMatch(html,/Gross purchase spend/);
});

test('owner-keyed pending command survives remount without leaking to another owner',()=>{
 let revision=0;
 const mutations=[];
 const {load}=frontendModules({'@/lib/auth-session':{sessionRevision:()=>revision},'@tanstack/react-query':{...queryLibrary,useMutation:options=>{mutations.push(options);return {isPending:false};}},'@/components/bots/AggregatedPnlChart':{},'@/components/bots/ControllerBrowser':{},'@/components/bots/DeployBotDialog':{},'@/components/bots/PnlSparkline':{},'@/hooks/useWebSocket':{},'@/hooks/useRates':{},'@/hooks/useTheme':{useTheme:()=>({theme:'dark'})},'@/hooks/useServerCapabilities':{useServerCapabilities:()=>({access:{botStop:true},data:{capabilities:{native_start:true}}})}}, {'pages/tabs/ActiveBotsTab.tsx':['NativeBotControls']});
 const {NativeBotControls}=load('pages/tabs/ActiveBotsTab.tsx');
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{gcTime:Infinity}}});
 const stamp=Date.now(),boot='12345678-1234-1234-1234-123456789abc';
 for(const bot of ['main','sui'])client.setQueryData(['native-bot-status','server',bot],{status:'success',data:{bot_name:bot,status:'running',source:'native_mqtt',execution_owner:'native_hummingbot',identity_verified:true,mqtt_instance_id:'instance',stale_after_seconds:30,heartbeat:{retained:false,received_at:stamp/1000,source_timestamp:stamp*1000},lifecycle:{valid:true,state:'running',reconciliation_complete:true,boot_id:boot,sequence:3,observation:{retained:false,replayed:false,received_at:stamp/1000,payload:{generated_at:stamp/1000,boot_id:boot,sequence:3,instance_id:'instance',state:'running'}}}}});
 client.setQueryData(['native-control-session','server','main'],{submitted:{bootId:boot,sequence:3,action:'stop'},receipt:{state:'unknown',message:'Await owner evidence'}});
 const show=bot=>renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(NativeBotControls,{server:'server',botName:bot,key:bot})));
 try {
  assert.match(show('main'),/Awaiting a fresh owner state transition/);
  assert.doesNotMatch(show('sui'),/Await owner evidence|Awaiting a fresh owner state transition/);
  assert.match(show('main'),/Awaiting a fresh owner state transition/);
  const newer={submitted:{bootId:boot,sequence:5,action:'start'},receipt:null,requestId:'newer',pending:true};
  client.setQueryData(['native-control-session','server','main'],newer);
  mutations[0].onSuccess({result:{httpStatus:409,body:{detail:'Late rejected stop'}},expected:{botName:'main',action:'stop',bootId:boot,instanceId:'instance'}},{action:'stop',requestId:'older'});
  mutations[0].onError(new Error('Late timeout'),{action:'stop',requestId:'older'});
  assert.deepEqual(client.getQueryData(['native-control-session','server','main']),newer);
  assert.match(show('main'),/Awaiting owner/);
  mutations[0].onError(new Error('Current request timed out'),{action:'start',requestId:'newer'});
  const uncertain=client.getQueryData(['native-control-session','server','main']);
  assert.equal(uncertain.pending,false);
  assert.equal(uncertain.receipt.state,'unknown');
  assert.deepEqual(uncertain.submitted,newer.submitted);
  // A late response from the old authenticated session must not repopulate cache.
  revision++;
  client.clear();
  mutations[0].onError(new Error('Session changed while command was in flight'),{action:'stop',requestId:'older'});
  mutations[0].onSettled();
  assert.equal(client.getQueryData(['native-control-session','server','main']),undefined);
 } finally { client.clear(); }
 assert.equal(client.getQueryData(['native-control-session','server','main']),undefined);
});

test('native command transport has a bounded wait without converting timeout to rejection',async()=>{
 const originalTimeout=AbortSignal.timeout;let deadline;
 AbortSignal.timeout=ms=>{deadline=ms;return AbortSignal.abort(new DOMException('Timeout','TimeoutError'));};
 const {load}=frontendModules({'./auth-token':{authFetch:async(_path,init)=>{init.signal.throwIfAborted();}}});
 try {
  await assert.rejects(load('lib/api.ts').api.nativeBotCommand('server','main','stop'),{name:'TimeoutError'});
  assert.equal(deadline,65000);
 } finally {AbortSignal.timeout=originalTimeout;}
});
