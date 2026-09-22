import test from 'node:test';
import assert from 'node:assert/strict';
import {frontendModules} from './helpers/frontend-module.mjs';
const {load}=frontendModules();
const {buildBotPositionView,mixedOperationalLabel}=load('features/bots/position-view.ts');
const now=Date.parse('2026-09-10T20:00:00Z');
test('September BTC and ETH receipts reconcile as net active plus retained units, not gross spend',()=>{
 for(const [pair,remaining,retained,total,price] of [['BTC-USDC','0.001675698368',0.000099934992,'0.00177563336',77666.3],['ETH-USDC','0.0440087648',7.984e-7,'0.0440095632',2483.57]]){
  const p=snapshot();p.runtime_status.controllers=[{controller_id:'c',pair,price_quote:price}];
  p.runtime_status.positions_held=[{controller_id:'c',pair,amount_base:retained,unrealized_pnl_quote:0.01}];
  p.runtime_status.active_executors=[{executor_id:'e',controller_id:'c',pair,side:'buy',executor_type:'position',remaining_position_amount_base:remaining,amount_base:'999',net_pnl_quote:-0.2}];
  const row=buildBotPositionView(p,'ok_rsi',now).pairs[0];assert.equal(row.quantity,total);assert.equal(row.markValue,Number(total)*price);assert.equal(row.bagPnl,-0.19);assert.equal(row.breakeven,null);
 }
});
test('missing, malformed, duplicate and unsupported active inventory fail closed; episodes are not counted twice',()=>{
 for(const change of [{remaining_position_amount_base:null},{remaining_position_amount_base:'oops'},{side:'sell'},{executor_type:'order'}]){
  const p=snapshot();p.runtime_status.controllers[0].custom_info={};p.runtime_status.active_executors=[{executor_id:'e',controller_id:'eth',pair:'ETH-USDC',side:'buy',executor_type:'position',remaining_position_amount_base:'1',...change}];
  const row=buildBotPositionView(p,'ok_rsi',now).pairs[0];assert.equal(row.quantity,null);assert.equal(row.markValue,null);assert.equal(row.bagPnl,null);
 }
 const p=snapshot();p.runtime_status.active_executors=[{executor_id:'e',controller_id:'eth',pair:'ETH-USDC',side:'buy',executor_type:'position',remaining_position_amount_base:'1'}];assert.equal(buildBotPositionView(p,'ok_rsi',now).pairs[0].quantity,'10');
 p.runtime_status.controllers[0].custom_info={};p.runtime_status.active_executors.push(p.runtime_status.active_executors[0]);assert.equal(buildBotPositionView(p,'ok_rsi',now).pairs[0].quantity,null);
});
test('closing executor inventory survives active-list removal and transfers once to retained inventory',()=>{
 const p=snapshot();p.runtime_status.controllers[0].custom_info={};
 const executor={executor_id:'e',controller_id:'eth',pair:'ETH-USDC',side:'buy',executor_type:'position',remaining_position_amount_base:'1',net_pnl_quote:2,status:'running'};
 p.runtime_status.active_executors=[executor];p.runtime_status.lifecycle_executors=[executor];
 assert.equal(buildBotPositionView(p,'ok_rsi',now).pairs[0].quantity,'4');
 p.runtime_status.active_executors=[];executor.status='shutting_down';
 let view=buildBotPositionView(p,'ok_rsi',now);assert.equal(view.pairs[0].quantity,'4');assert.equal(view.activeExecutorCount,0);assert.equal(view.pairs[0].executors.length,1);
 p.runtime_status.lifecycle_executors=[];p.runtime_status.positions_held[0].amount_base=4;
 assert.equal(buildBotPositionView(p,'ok_rsi',now).pairs[0].quantity,'4');
 p.runtime_status.lifecycle_executors=null;assert.throws(()=>buildBotPositionView(p,'ok_rsi',now),/lifecycle/);
 p.runtime_status.lifecycle_executors=[];p.runtime_status.active_executors=[executor];assert.throws(()=>buildBotPositionView(p,'ok_rsi',now),/disagree/);
});
function snapshot(){return {runtime_status:{bot_name:'ok_rsi',updated_at:new Date(now-1000).toISOString(),active_orders_count:2,controllers:[{controller_id:'eth',pair:'ETH-USDC',price_quote:110,custom_info:{episode:{enabled:true,phase:'DISTRIBUTE',base:'10',cost:'1000',cost_known:true,target_base:'6',minimum_profit_price:'102',exit_risk_clear:true,reason:'trail_wait'},trailing_policy:{policy:'episode_aggregate',peak:'115',floor:'108',target_base:'6'}}}],positions_held:[{controller_id:'eth',pair:'ETH-USDC',amount_base:3,breakeven_price:100,unrealized_pnl_quote:30}],active_executors:[]},monitoring:{bot_name:'ok_rsi',stale_threshold_seconds:30}};}
test('uses tracked episode bag once, mark value and gross PnL; separates conditional reduction from active orders',()=>{const view=buildBotPositionView(snapshot(),'ok_rsi',now);assert.equal(view.activeOrderCount,2);const row=view.pairs[0];assert.equal(row.base,10);assert.equal(row.markValue,1100);assert.equal(row.bagPnl,100);assert.equal(row.breakeven,100);assert.equal(row.plannedReduction,4);assert.equal(row.floor,108);assert.equal(row.profitPrice,102);assert.equal(view.orders,null);});
test('unknown cost hides basis/PnL and unarmed acquisition does not imply a full next sell',()=>{const p=snapshot();Object.assign(p.runtime_status.controllers[0].custom_info.episode,{cost_known:false,phase:'ACCUMULATE',target_base:'0'});const row=buildBotPositionView(p,'ok_rsi',now).pairs[0];assert.equal(row.breakeven,null);assert.equal(row.bagPnl,null);assert.equal(row.plannedReduction,null);});
test('stale, missing timestamp, wrong bot and malformed numbers fail closed',()=>{for(const change of [{updated_at:new Date(now-31000).toISOString()},{updated_at:null},{bot_name:'other'}]){const p=snapshot();Object.assign(p.runtime_status,change);assert.throws(()=>buildBotPositionView(p,'ok_rsi',now));}const p=snapshot();p.runtime_status.controllers[0].price_quote='NaN';assert.equal(buildBotPositionView(p,'ok_rsi',now).pairs[0].markValue,null);});
test('legacy position value_quote is basis value: mark holding value comes from current price',()=>{const p=snapshot();p.runtime_status.controllers[0].custom_info={};p.runtime_status.positions_held[0].value_quote=300;const row=buildBotPositionView(p,'ok_rsi',now).pairs[0];assert.equal(row.base,3);assert.equal(row.markValue,330);assert.equal(row.bagPnl,30);assert.equal(row.inventorySource,'Managed bot inventory · executor + retained');assert.equal(row.plannedReduction,null);});
test('different controller holdings never leak through a shared pair',()=>{const p=snapshot();p.runtime_status.controllers.push({controller_id:'other',pair:'ETH-USDC',price_quote:110});const row=buildBotPositionView(p,'ok_rsi',now).pairs[1];assert.equal(row.base,0);assert.equal(row.bagPnl,null);});

test('real position panel renders levels, scope and drilldowns; stale observations suppress all old prices',async()=>{
 const React=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const {load}=frontendModules({'react-router-dom':{Link:({to,children,...rest})=>React.createElement('a',{href:to,...rest},children)}});
 const {CommandDeskObservation}=load('components/bots/NativeBotCommandDesk.tsx');
 const props={payload:snapshot(),bot:'ok_rsi',now,section:'positions',selected:null,onSelect:()=>{}};
 const html=renderToStaticMarkup(React.createElement(CommandDeskObservation,props));
 for(const text of ['Active limit orders','Managed net units','Current market value','Open-position PnL','Controller plan and gates','Observed price levels','Planned bag reduction','before exit costs','record=fills'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/No active orders/);
 const stale=renderToStaticMarkup(React.createElement(CommandDeskObservation,{...props,now:now+31000}));
 assert.match(stale,/stale/);assert.doesNotMatch(stale,/1,100|ETH-USDC|Bag holding/);
});

test('legacy shared-pair controllers do not turn unattributed holdings into zero bags',()=>{const p=snapshot();p.runtime_status.controllers=[{pair:'ETH-USDC',price_quote:110},{pair:'ETH-USDC',price_quote:110}];const result=buildBotPositionView(p,'ok_rsi',now);for(const row of result.pairs){assert.equal(row.base,null);assert.equal(row.markValue,null);assert.equal(row.bagPnl,null);}});

test('explicit failed enriched observation withholds bag values even with empty retained positions',()=>{const p=snapshot();p.runtime_status.controllers[0].observation_status='unavailable';p.runtime_status.controllers[0].custom_info={};p.runtime_status.positions_held=[];const row=buildBotPositionView(p,'ok_rsi',now).pairs[0];assert.equal(row.base,null);assert.equal(row.markValue,null);assert.equal(row.bagPnl,null);assert.match(row.inventorySource,/unavailable/);});

test('duplicate controller identities cannot duplicate a bag',()=>{const p=snapshot();p.runtime_status.controllers.push(p.runtime_status.controllers[0]);assert.throws(()=>buildBotPositionView(p,'ok_rsi',now),/duplicated/);});

test('actual owner snapshot fixture flows through the UI projection without changing quantities', {skip: !process.env.BOT_OBSERVATION_FIXTURE}, async()=>{const fs=await import('node:fs');const runtime=JSON.parse(fs.readFileSync(process.env.BOT_OBSERVATION_FIXTURE,'utf8'));const view=buildBotPositionView({runtime_status:runtime,monitoring:{bot_name:runtime.bot_name,stale_threshold_seconds:30}},runtime.bot_name,Date.parse(runtime.updated_at)+1000);assert.equal(view.activeOrderCount,1);assert.equal(view.pairs[0].base,10);assert.equal(view.pairs[0].markValue,125);assert.equal(view.pairs[0].bagPnl,35);assert.equal(view.pairs[0].pendingSells[0].remaining_amount_base,'2');assert.equal(view.pairs[0].executors[0].trailing_trigger_price,'12');assert.equal(view.orders[0].remaining_amount_base,'2');assert.equal(view.ordersStatus.complete,true);});

test('complete connector order list supplies total count; legacy count is explicitly limit-only',()=>{const p=snapshot();assert.equal(buildBotPositionView(p,'ok_rsi',now).orderCountLabel,'Active limit orders');p.runtime_status.active_orders=[{order_id:'o1',pair:'ETH-USDC'},{order_id:'o2',pair:'ETH-USDC'},{order_id:'o3',pair:'ETH-USDC'}];p.runtime_status.active_orders_status={complete:true};const view=buildBotPositionView(p,'ok_rsi',now);assert.equal(view.activeOrderCount,3);assert.equal(view.orderCountLabel,'Active orders');});

test('cancellation-pending and expired sell requests never look like pending fresh orders',()=>{const p=snapshot();p.runtime_status.controllers[0].custom_info.pending_sell_requests=[{request_id:'canceled',termination_requested:true,expires_at:now/1000+100},{request_id:'expired',termination_requested:false,expires_at:now/1000-1},{request_id:'pending',termination_requested:false,expires_at:now/1000+100}];const rows=buildBotPositionView(p,'ok_rsi',now).pairs[0].pendingSells;assert.deepEqual(rows.map(row=>row.request_state),['Cancellation requested','Expiry reached; awaiting owner','Pending owner request']);});

test('mixed pair states never collapse to one asset label',()=>{
  assert.equal(mixedOperationalLabel([{phase:'FLAT'},{phase:'HOLDING'}]),'MIXED: 1 flat / 1 holding');
  assert.equal(mixedOperationalLabel([{phase:'FLAT'},{phase:'FLAT'}]),'FLAT');
  assert.equal(mixedOperationalLabel([]),'UNKNOWN');
});
