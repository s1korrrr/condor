import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';
const {load}=frontendModules({'react-router-dom':{Link:({to,children,...rest})=>React.createElement('a',{href:to,...rest},children)}});
test('small holdings are grouped without hiding active execution or unknown value',()=>{
 const {partitionBotInventory}=load('features/bots/position-view.ts');
 const row={markValue:0.001,executors:[],pendingSells:[],plannedReduction:null};
 const result=partitionBotInventory([row,{...row,markValue:null},{...row,executors:[{}]},{...row,pendingSells:[{}]}]);
 assert.equal(result.small.length,1);assert.equal(result.primary.length,3);
});
test('legacy inventory stays compact, retains tiny owner units and has one source coverage notice',()=>{
 const {BotPositionObservation}=load('components/bots/NativeBotPositions.tsx');const now=Date.now();
 const payload={monitoring:{bot_name:'b',stale_threshold_seconds:30},runtime_status:{bot_name:'b',updated_at:new Date(now).toISOString(),active_orders_count:0,controllers:[{pair:'ETH-USDC',price_quote:2000,state:'WAIT'}],positions_held:[{pair:'ETH-USDC',amount_base:'0.000000000012345678',breakeven_price:1000}],active_executors:[]}};
 const html=renderToStaticMarkup(React.createElement(BotPositionObservation,{payload,bot:'b',now}));
 assert.match(html,/Retained bot inventory/);assert.match(html,/Small &amp; zero inventory/);assert.match(html,/0.000000000012345678/);assert.doesNotMatch(html,/Unavailable|Bag holding/);
 assert.equal((html.match(/aria-label="Observation coverage"/g)||[]).length,1);
});
test('research summaries use bounded titles, preserve full rationale and distinguish attempts',()=>{
 const {researchRecordSummary}=load('features/research/record-summary.ts');
 const rationale='A long source rationale. '.repeat(25);
 const result=researchRecordSummary({id:'run:attempt-002',title:rationale,status:'FAILED',recorded_at:'2026-09-12T12:00:00Z',data:{rationale,lane:'spot',venue:'okx'}});
 assert.ok(result.title.length<=100);assert.equal(result.rationale,rationale);assert.equal(result.id,'run:attempt-002');assert.ok(result.scope.includes('spot'));assert.equal(result.verdict,'FAILED');
});
test('MQTT policy requires fresh matching bot, controller and unambiguous pair; ratios display as percentages',()=>{
 const {currentControllerPolicy}=load('features/bots/observed-policy.ts');const now=Date.now();
 const row={pair:'ETH-USDC',controllerId:null,uniquePair:true};
 const page={bots:[{bot_name:'b',status:'running',controller_count_current:true,status_received_at:now/1000,status_stale_after_seconds:30,performance_received_at:now/1000,performance_stale_after_seconds:30}],controllers:[{controller_id:'eth',bot_name:'b',trading_pair:'ETH-USDC',custom_info:{trailing_policy:{selected_activation_pct:0.015},operator:{entry_paused:true}}}]};
 assert.deepEqual(currentControllerPolicy(page,'b',row,now).fields,[['Selected activation','1.5%'],['New entries','Paused']]);
 for(const [bot,scope,time] of [['other',row,now],['b',{...row,controllerId:'conflict'},now],['b',{...row,uniquePair:false},now],['b',row,now+31000]]) assert.equal(currentControllerPolicy(page,bot,scope,time),null);
 page.controllers.push(page.controllers[0]);assert.equal(currentControllerPolicy(page,'b',row,now),null);
});
test('Research overview failure has one recoverable state and does not start dependent record reads',async()=>{
 const {renderResearch,envelope}=await import('./helpers/research-render.mjs');
 const failed=renderResearch({'research-overview':{isError:true,error:new Error('Read failed')}},{search:''});
 assert.equal((failed.html.match(/Read failed/g)||[]).length,1);assert.doesNotMatch(failed.html,/Loading research records|Recorded conclusions/);
 assert.ok(!failed.requests.some(q=>q.queryKey[0]==='research-recent-assessments'));
 const recovered=renderResearch({'research-overview':{data:envelope({revision:'r',freshness:{state:'CURRENT'}})}},{search:''});
 assert.match(recovered.html,/Recorded conclusions/);assert.doesNotMatch(recovered.html,/Read failed/);
});
test('deployment receipt errors hide previous versions and absence has one explanation',()=>{
 for(const query of [{isError:true,error:new Error('Receipt read failed'),data:{recorded:true,components:[{name:'OLD_IMAGE'}]}},{data:{recorded:false,reason:'Deployment details have not been recorded.'}}]) {
  const {load}=frontendModules({'@/lib/auth-token':{authFetch:()=>{throw new Error('Unexpected request')}},'@tanstack/react-query':{useQuery:()=>({isPending:false,isFetching:false,refetch(){},...query})}});
  const html=renderToStaticMarkup(React.createElement(load('components/settings/DeploymentVersions.tsx').DeploymentVersions));
  assert.doesNotMatch(html,/OLD_IMAGE/);assert.match(html,query.isError ? /Receipt read failed/ : /Deployment details have not been recorded/);
 }
});
test('invalid episode quantities never expose a retained-lot quantity as the episode total',()=>{
 const {buildBotPositionView}=load('features/bots/position-view.ts');const now=Date.now();
 const payload={monitoring:{bot_name:'b',stale_threshold_seconds:30},runtime_status:{bot_name:'b',updated_at:new Date(now).toISOString(),controllers:[{pair:'ETH-USDC',custom_info:{episode:{enabled:true,base:'bad'}}}],positions_held:[{pair:'ETH-USDC',amount_base:'3'}],active_executors:[]}};
 const row=buildBotPositionView(payload,'b',now).pairs[0];assert.equal(row.base,null);assert.equal(row.quantity,null);
});
