import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRequire} from 'node:module';
import {frontendModules} from './helpers/frontend-module.mjs';
const {QueryClient,QueryClientProvider}=createRequire(import.meta.url)('@tanstack/react-query');
const {load}=frontendModules({'react-router-dom':{Link:({to,children,...rest})=>React.createElement('a',{href:to,...rest},children)},'@/hooks/useServer':{useServer:()=>({server:'native'})}});
const {RosterObservation,BotsRoster}=load('components/bots/BotsRoster.tsx');
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

test('current controller conditions are never rendered as recorded decisions',()=>{
 const html=renderToStaticMarkup(React.createElement(RosterObservation,{payload:snapshot(),bot:'rsi_modular_v2',now,events:{schema_version:'rsibot.quant_ops.v1',execution_authorized:false,generated_at:new Date(now).toISOString(),scope:{bot_key:'rsi_modular_v2',execution_mode:'live'},data:{bot_id:'rsi_modular_v2',current_conditions:[{pair:'FAKE-USD',action:'SYNTHETIC_STATUS'}]}}}));
 assert.match(html,/No identity-validated recorded decision journal is available/);
 assert.doesNotMatch(html,/FAKE-USD|SYNTHETIC_STATUS/);
});
test('bots page KPIs, filters, New Bot draft control and comparison stay in flow',()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(BotsRoster,{renderControls:()=>null,renderLogs:()=>null})));
 for(const id of ['B01','B02','B03','B04','B05','B06','B07','B08','B23','B24','B25']) assert.match(html,new RegExp(`data-panel-id="${id}"`));
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
  if(page===undefined) assert.match(card,/Unavailable/);
  else { assert.match(card,/0 verified \/ 1/,'a stale lifecycle counts only verified running bots, labelled as such'); assert.match(card,/data-state="stale"/); }
  assert.doesNotMatch(card,/>0 \/ 1</,'never an unlabelled zero');
  client.clear();
 }
});
