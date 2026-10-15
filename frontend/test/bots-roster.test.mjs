import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRequire} from 'node:module';
import {frontendModules} from './helpers/frontend-module.mjs';
const {QueryClient,QueryClientProvider}=createRequire(import.meta.url)('@tanstack/react-query');
const {load}=frontendModules({'react-router-dom':{Link:({to,children,...rest})=>React.createElement('a',{href:to,...rest},children),useSearchParams:()=>[new URLSearchParams()],useLocation:()=>({hash:''})},'@/hooks/useServer':{useServer:()=>({server:'native'})}});
const {RosterObservation,BotsRoster}=load('components/bots/BotsRoster.tsx');
const {botSourceFreshness,quoteUnavailableReason,historyComparison}=load('features/bots/bot-net.ts');
const now=Date.parse('2026-09-15T10:00:00Z');
function snapshot(){return {runtime_status:{bot_name:'rsi_modular_v2',updated_at:new Date(now-1000).toISOString(),controllers:[{controller_id:'eth',pair:'ETH-USDC',price_quote:2500,state:'HOLDING',custom_info:{episode:{enabled:true,base:'0.04',cost:'99',cost_known:true},trailing_policy:{floor:2490,peak:2520}}},{controller_id:'btc',pair:'BTC-USDC',price_quote:70000,state:'FLAT',custom_info:{}}],positions_held:[],active_executors:[],active_orders:[],active_orders_status:{complete:true}},monitoring:{bot_name:'rsi_modular_v2',stale_threshold_seconds:30}};}
test('quant roster keeps every pair in page flow including a mixed FLAT/HOLDING bot',()=>{
 const html=renderToStaticMarkup(React.createElement(RosterObservation,{payload:snapshot(),bot:'rsi_modular_v2',now}));
 assert.match(html,/ETH-USDC/);
 assert.match(html,/BTC-USDC/);
 assert.match(html,/MIXED: 1 holding \/ 1 flat|MIXED: 1 flat \/ 1 holding/);
 assert.doesNotMatch(html,/position inspector|bot-desk__rail/);
 assert.doesNotMatch(html,/<svg width="88"/);
 assert.match(html,/Performance history requires a timestamped/);
});
test('wrong owner withholds amounts instead of borrowing another bot',()=>{
 const html=renderToStaticMarkup(React.createElement(RosterObservation,{payload:snapshot(),bot:'ok_rsi',now}));
 assert.match(html,/does not match/);
 assert.doesNotMatch(html,/99 USDC|ETH-USDC/);
});
test('partial multi-pair report renders unavailable position count rather than a flat bot',()=>{
 const payload=snapshot();
 payload.runtime_status.controllers=['BTC-USDC','BNB-USDC'].map(pair=>({controller_id:'meridian',pair,pair_projection_source:'native_owner_symbols',observation_status:'unavailable',price_quote:null,custom_info:{}}));
 const html=renderToStaticMarkup(React.createElement(RosterObservation,{payload,bot:'rsi_modular_v2',now}));
 assert.match(html,/Open pair count unavailable/);
 assert.doesNotMatch(html,/0 open pairs/);
 assert.match(html,/BTC-USDC/);
 assert.match(html,/BNB-USDC/);
});

test('current controller conditions are never rendered as recorded decisions',()=>{
 const html=renderToStaticMarkup(React.createElement(RosterObservation,{payload:snapshot(),bot:'rsi_modular_v2',now,events:{schema_version:'rsibot.quant_ops.v1',execution_authorized:false,generated_at:new Date(now).toISOString(),scope:{bot_key:'rsi_modular_v2',execution_mode:'live'},data:{bot_id:'rsi_modular_v2',current_conditions:[{pair:'FAKE-USD',action:'SYNTHETIC_STATUS'}]}}}));
 assert.match(html,/No identity-validated recorded decision journal is available/);
 assert.doesNotMatch(html,/FAKE-USD|SYNTHETIC_STATUS/);
});
test('bots page filters, New Bot draft control and fleet panels stay in flow; money PnL tiles belong to Capital',()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(BotsRoster,{renderControls:()=>null,renderLogs:()=>null})));
 for(const id of ['B06','B07','B08','B24','B25','B29','B-fleet-tiles']) assert.match(html,new RegExp(`data-panel-id="${id}"`));
 for(const id of ['B02','B04','B23']) assert.doesNotMatch(html,new RegExp(`data-panel-id="${id}"`),'PnL headline and comparison tiles are Capital content');
 assert.match(html,/\+ New Bot/);
});

test('local New Bot draft cannot authorize execution',()=>{
 const {BotDraftWizard}=load('components/bots/BotDraftWizard.tsx');
 const html=renderToStaticMarkup(React.createElement(BotDraftWizard,{bots:['rsi_modular_v2'],onClose:()=>{}}));
 assert.match(html,/rsi_modular_v2/);
 assert.match(html,/execution_authorized is false/);
 assert.doesNotMatch(html,/ok_rsi/);
});


test('missing or stale lifecycle page never becomes zero active bots',()=>{
 for(const page of [undefined,{bots:[{bot_name:'rsi_modular_v2',status:'stale'}],controllers:[]}]) {
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  client.setQueryData(['native-command-desk-sources'],[{bot:'rsi_modular_v2',server:'native'}]);
  const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(BotsRoster,{page,renderControls:()=>null,renderLogs:()=>null})));
  const card=html.match(/<article[^>]*data-panel-id="B01"[\s\S]*?<\/article>/)?.[0];
  assert.match(card,/0 verified \/ 1/,'an unverified lifecycle counts only verified running bots, labelled as such');
  assert.match(card,/data-state="stale"/);
  assert.doesNotMatch(card,/>0 \/ 1</,'never an unlabelled zero');
  assert.match(html,/<section[^>]*data-panel-id="B40"[^>]*data-state="collecting"/,'the all-bots fills feed is part of the fleet composite and reads its own source');
  assert.match(html,/id="fleet-fills"/);
  assert.doesNotMatch(html.match(/<section[^>]*data-panel-id="B-fleet-tiles"[\s\S]*?<\/section>/)?.[0] ?? '',/Unavailable/,'no fleet tile prints Unavailable');
  client.clear();
 }
});

test('per-bot lifecycle controls supplied by the guarded caller reach the owner card',()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 client.setQueryData(['native-command-desk-sources'],[{bot:'rsi_modular_v2',server:'native'}]);
 const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(BotsRoster,{
  page:{bots:[{bot_name:'rsi_modular_v2',status:'stale'}],controllers:[]},
  renderControls:()=>React.createElement('span',null,'guarded lifecycle controls'),renderLogs:()=>null,
 })));
 assert.match(html,/guarded lifecycle controls/);
 client.clear();
});

test('fresh quant data cannot make unavailable lifecycle or performance look fresh',()=>{
 const base={status:'running',controller:{reason:null,total:12,observedAt:now},quant:{freshness:'current'}};
 assert.deepEqual(botSourceFreshness(base),{lifecycle:true,performance:true,quant:true});
 assert.deepEqual(botSourceFreshness({...base,status:'stale'}),{lifecycle:false,performance:true,quant:true});
 assert.deepEqual(botSourceFreshness({...base,controller:{reason:'expired',total:null,observedAt:null}}),{lifecycle:true,performance:false,quant:true});
 assert.deepEqual(botSourceFreshness({...base,controller:{reason:'No current controllers reported.',total:null,observedAt:now}}),{lifecycle:true,performance:true,quant:true});
 assert.deepEqual(botSourceFreshness({...base,quant:null}),{lifecycle:true,performance:true,quant:false});
});

test('missing quote evidence and conflicting quote currencies have distinct reasons',()=>{
 assert.match(quoteUnavailableReason([null]),/currency is unavailable/);
 assert.match(quoteUnavailableReason(['USDC',null]),/currency is unavailable/);
 assert.match(quoteUnavailableReason(['USDC','USDT']),/different quote currencies/);
});

test('lifecycle diagnostics follows native status independently of quant summary',()=>{
 for(const [status,label] of [['running','running'],['stale','stale'],[null,'Unavailable']]) {
  const html=renderToStaticMarkup(React.createElement(RosterObservation,{payload:snapshot(),bot:'rsi_modular_v2',now,lifecycleStatus:status}));
  const row=html.match(/<li><span>Lifecycle<\/span><strong>(.*?)<\/strong><\/li>/)?.[1];
  assert.equal(row,label,'a missing quant summary must not replace native lifecycle evidence');
 }
});

test('weekly comparison admits matching historical quotes and counts observations, not gaps',()=>{
 const series=quote=>({quote,points:[{time:1,value:1},{time:2,value:2}],reason:null});
 assert.deepEqual(historyComparison([series('USDC')],true),{quote:'USDC',drawable:true,complete:true});
 assert.deepEqual(historyComparison([series('USDC'),series('USDT')],true),{quote:null,drawable:false,complete:false});
 assert.equal(historyComparison([series('USDC'),{quote:null,points:[],reason:'unavailable'}],true).drawable,false);
 assert.equal(historyComparison([series('USDC')],false).drawable,false);
 assert.equal(historyComparison([{...series('USDC'),points:[{time:1,value:1},{time:2,value:null}]}],true).drawable,false);
 assert.equal(historyComparison([],true).drawable,false);
 assert.equal(historyComparison([{...series('USDC'),reason:'Window incomplete'}],true).complete,false);
});
