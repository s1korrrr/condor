import test from 'node:test';
import assert from 'node:assert/strict';
import {frontendModules} from './helpers/frontend-module.mjs';
import {botHoldingsAt,holdingsEntry,unavailableEntry} from './helpers/holdings.mjs';
const {load}=frontendModules();
const {buildBotPositionView,mixedOperationalLabel}=load('features/bots/position-view.ts');
const lib=load('lib/fleet-holdings.ts');
const now=Date.parse('2026-09-10T20:00:00Z');
// Inventory comes only from fleet holdings; the bootstrap rows below carry identity, plans, executors and orders.
const ethHolding={controller_id:'eth',pair:'ETH-USDC',units:'10',mark_price:'110',marked_value_quote:'1100',entry_cost_quote:'1000',breakeven_price:'100',unrealized_pnl_quote:'100'};
const holdings=(pairs=[ethHolding],over={})=>botHoldingsAt(lib,holdingsEntry('ok_rsi',pairs,{held:1,value:'1100',unrealized:'100',entryCost:'1000',...over}),now);
const view=(payload,options={})=>buildBotPositionView(payload,'ok_rsi',now,{holdings:holdings(),...options});
test('unknown multi-pair inventory never becomes zero open positions',()=>{
 const partial=holdings([{...ethHolding,units:null,marked_value_quote:null}],{held:null,value:null,known:'0',unrealized:null,entryCost:null,reasons:['PAIR_QUANTITY_UNKNOWN']});
 assert.equal(view(snapshot(),{holdings:partial}).inventory.heldPairCount,null,'a partial book has no held count');
 assert.equal(view(snapshot(),{holdings:null}).inventory.heldPairCount,null,'no holdings read is unknown, not zero');
 assert.equal(view(snapshot(),{holdings:botHoldingsAt(lib,unavailableEntry('ok_rsi'),now)}).inventory.heldPairCount,null);
 assert.equal(view(snapshot()).inventory.heldPairCount,1);
 const flat=holdings([{...ethHolding,units:'0',marked_value_quote:'0',entry_cost_quote:null,breakeven_price:null,unrealized_pnl_quote:null,state:'FLAT'}],{held:0,value:'0',unrealized:'0',entryCost:'0'});
 assert.equal(view(snapshot(),{holdings:flat}).inventory.heldPairCount,0,'an admitted empty book is a confirmed zero');
});
test('September BTC and ETH receipts render the owner holdings units exactly, never re-summed from executor and retained rows',()=>{
 for(const [pair,remaining,retained,total,price,value] of [['BTC-USDC','0.001675698368',0.000099934992,'0.00177563336','77666.3','137.906908'],['ETH-USDC','0.0440087648',7.984e-7,'0.0440095632','2483.57','109.300']]){
  const p=snapshot();p.runtime_status.controllers=[{controller_id:'c',pair,price_quote:1}];
  p.runtime_status.positions_held=[{controller_id:'c',pair,amount_base:retained,unrealized_pnl_quote:0.01}];
  p.runtime_status.active_executors=[{executor_id:'e',controller_id:'c',pair,side:'buy',executor_type:'position',remaining_position_amount_base:remaining,amount_base:'999',net_pnl_quote:-0.2}];
  // Executor inventory has no retained cost: the owner publishes null cost and breakeven while an executor runs.
  const h=holdings([{controller_id:'c',pair,units:total,mark_price:price,marked_value_quote:value,unrealized_pnl_quote:'-0.19',running_executor_count:1}],{held:1,value,unrealized:'-0.19',entryCost:null});
  const row=view(p,{holdings:h}).pairs[0];assert.equal(row.quantity,total);assert.equal(row.markValue,Number(value));assert.equal(row.price,Number(price),'the holdings mark, not the controller price');assert.equal(row.bagPnl,-0.19);assert.equal(row.breakeven,null);assert.equal(row.entryCost,null);
  assert.equal(row.executors.length,1,'the running executor stays attached as owner evidence');
 }
});
test('unknown, duplicate or absent holdings units fail closed; bootstrap rows never supply a quantity',()=>{
 const unknown=holdings([{...ethHolding,units:null,marked_value_quote:null,unrealized_pnl_quote:null}],{held:null,value:null,known:'0',unrealized:null,entryCost:null,reasons:['PAIR_QUANTITY_UNKNOWN']});
 let row=view(snapshot(),{holdings:unknown}).pairs[0];assert.equal(row.quantity,null);assert.equal(row.markValue,null);assert.equal(row.bagPnl,null);
 const duplicated=holdings([ethHolding,ethHolding],{held:null,value:null,known:'0',unrealized:null,entryCost:null,reasons:['PAIR_DUPLICATE']});
 row=view(snapshot(),{holdings:duplicated}).pairs[0];assert.equal(row.quantity,null,'a repeated owner identity is never picked from');assert.equal(row.markValue,null);
 for(const options of [{holdings:null},{holdings:holdings([{...ethHolding,controller_id:'other'}])}]){
  row=view(snapshot(),options).pairs[0];assert.equal(row.quantity,null);assert.equal(row.base,null);assert.equal(row.markValue,null);assert.equal(row.bagPnl,null);assert.equal(row.breakeven,null);
 }
 assert.equal(view(snapshot()).pairs[0].quantity,'10');
});
test('closing executors stay attached as evidence while the lifecycle lists them; malformed lifecycle observations still throw',()=>{
 const p=snapshot();p.runtime_status.controllers[0].custom_info={};
 const executor={executor_id:'e',controller_id:'eth',pair:'ETH-USDC',side:'buy',executor_type:'position',remaining_position_amount_base:'1',net_pnl_quote:2,status:'running'};
 const h=holdings([{...ethHolding,units:'4',running_executor_count:1}]);
 p.runtime_status.active_executors=[executor];p.runtime_status.lifecycle_executors=[executor];
 assert.equal(view(p,{holdings:h}).pairs[0].quantity,'4');
 p.runtime_status.active_executors=[];executor.status='shutting_down';
 let v=view(p,{holdings:h});assert.equal(v.pairs[0].quantity,'4');assert.equal(v.activeExecutorCount,0);assert.equal(v.pairs[0].executors.length,1);
 p.runtime_status.lifecycle_executors=[];p.runtime_status.positions_held[0].amount_base=4;
 v=view(p,{holdings:h});assert.equal(v.pairs[0].quantity,'4');assert.equal(v.pairs[0].executors.length,0);
 p.runtime_status.lifecycle_executors=null;assert.throws(()=>view(p),/lifecycle/);
 p.runtime_status.lifecycle_executors=[];p.runtime_status.active_executors=[executor];assert.throws(()=>view(p),/disagree/);
});
function snapshot(){return {runtime_status:{bot_name:'ok_rsi',updated_at:new Date(now-1000).toISOString(),active_orders_count:2,controllers:[{controller_id:'eth',pair:'ETH-USDC',price_quote:110,custom_info:{episode:{enabled:true,phase:'DISTRIBUTE',base:'10',cost:'1000',cost_known:true,target_base:'6',minimum_profit_price:'102',exit_risk_clear:true,reason:'trail_wait'},trailing_policy:{policy:'episode_aggregate',peak:'115',floor:'108',target_base:'6'}}}],positions_held:[{controller_id:'eth',pair:'ETH-USDC',amount_base:3,breakeven_price:100,unrealized_pnl_quote:30}],active_executors:[]},monitoring:{bot_name:'ok_rsi',stale_threshold_seconds:30}};}
test('uses the holdings bag, mark value and open-position PnL; separates conditional reduction from active orders',()=>{const v=view(snapshot());assert.equal(v.activeOrderCount,2);const row=v.pairs[0];assert.equal(row.base,10);assert.equal(row.markValue,1100);assert.equal(row.bagPnl,100);assert.equal(row.breakeven,100);assert.equal(row.plannedReduction,4);assert.equal(row.floor,108);assert.equal(row.profitPrice,102);assert.equal(v.orders,null);});
test('unknown cost hides basis/PnL and unarmed acquisition does not imply a full next sell',()=>{const p=snapshot();Object.assign(p.runtime_status.controllers[0].custom_info.episode,{cost_known:false,phase:'ACCUMULATE',target_base:'0'});const row=view(p,{holdings:holdings([{...ethHolding,entry_cost_quote:null,breakeven_price:null,unrealized_pnl_quote:null}],{unrealized:null,entryCost:null})}).pairs[0];assert.equal(row.breakeven,null);assert.equal(row.bagPnl,null);assert.equal(row.plannedReduction,null);});
test('stale, missing timestamp, wrong bot and malformed numbers fail closed',()=>{for(const change of [{updated_at:new Date(now-31000).toISOString()},{updated_at:null},{bot_name:'other'}]){const p=snapshot();Object.assign(p.runtime_status,change);assert.throws(()=>buildBotPositionView(p,'ok_rsi',now));}const p=snapshot();p.runtime_status.controllers[0].price_quote='NaN';assert.equal(view(p).pairs[0].markValue,1100,'the controller price never values inventory');assert.equal(view(p,{holdings:null}).pairs[0].markValue,null);});
test('legacy position value_quote is never a holding value: marked value is the holdings field',()=>{const p=snapshot();p.runtime_status.controllers[0].custom_info={};p.runtime_status.positions_held[0].value_quote=300;const row=view(p,{holdings:holdings([{...ethHolding,units:'3',marked_value_quote:'330',unrealized_pnl_quote:'30'}],{value:'330',unrealized:'30'})}).pairs[0];assert.equal(row.base,3);assert.equal(row.markValue,330);assert.equal(row.bagPnl,30);assert.match(row.inventorySource,/^Fleet holdings/);assert.equal(row.plannedReduction,null);});
test('different controller holdings never leak through a shared pair',()=>{const p=snapshot();p.runtime_status.controllers.push({controller_id:'other',pair:'ETH-USDC',price_quote:110});
 let row=view(p).pairs[1];assert.equal(row.base,null,'no holdings pair for this controller is unknown, not zero');assert.equal(row.bagPnl,null);assert.equal(view(p).pairs[0].base,10);
 row=view(p,{holdings:holdings([ethHolding,{controller_id:'other',pair:'ETH-USDC',units:'0',marked_value_quote:'0',state:'FLAT'}],{held:1})}).pairs[1];assert.equal(row.base,0);assert.equal(row.bagPnl,null);});

test('real position panel renders levels, scope and drilldowns; stale observations suppress all old prices',async()=>{
 const React=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const {load}=frontendModules({'react-router-dom':{Link:({to,children,...rest})=>React.createElement('a',{href:to,...rest},children)}});
 const {CommandDeskObservation}=load('components/bots/NativeBotCommandDesk.tsx');
 const props={payload:snapshot(),bot:'ok_rsi',now,section:'positions',selected:null,onSelect:()=>{},holdings:holdings()};
 const html=renderToStaticMarkup(React.createElement(CommandDeskObservation,props));
 for(const text of ['Active limit orders','Managed net units','Current market value','Open-position PnL','Controller plan and gates','Observed price levels','Planned bag reduction','before exit costs','record=fills'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/No active orders/);
 const stale=renderToStaticMarkup(React.createElement(CommandDeskObservation,{...props,now:now+31000}));
 assert.match(stale,/stale/);assert.doesNotMatch(stale,/1,100|ETH-USDC|Bag holding/);
});

test('legacy shared-pair controllers do not turn unattributed holdings into zero bags or show one bag twice',()=>{const p=snapshot();p.runtime_status.controllers=[{pair:'ETH-USDC',price_quote:110},{pair:'ETH-USDC',price_quote:110}];const result=view(p,{holdings:holdings([{...ethHolding,controller_id:null}])});for(const row of result.pairs){assert.equal(row.base,null);assert.equal(row.markValue,null);assert.equal(row.bagPnl,null);}});

test('explicit failed enriched observation with no holdings withholds bag values even with empty retained positions',()=>{const p=snapshot();p.runtime_status.controllers[0].observation_status='unavailable';p.runtime_status.controllers[0].custom_info={};p.runtime_status.positions_held=[];const row=view(p,{holdings:null}).pairs[0];assert.equal(row.base,null);assert.equal(row.markValue,null);assert.equal(row.bagPnl,null);assert.match(row.inventorySource,/unavailable/);});

test('duplicate controller identities cannot duplicate a bag',()=>{const p=snapshot();p.runtime_status.controllers.push(p.runtime_status.controllers[0]);assert.throws(()=>buildBotPositionView(p,'ok_rsi',now),/duplicated/);});

test('explicit native multi-pair projection shows distinct pair identities without invented inventory',()=>{
 const p=snapshot();p.runtime_status.controllers=['BTC-USDC','BNB-USDC'].map(pair=>({controller_id:'meridian',pair,pair_projection_source:'native_owner_symbols',observation_status:'unavailable',price_quote:null,custom_info:{}}));
 p.runtime_status.positions_held=[];p.runtime_status.active_executors=[{executor_id:'e',controller_id:'meridian',pair:'BTC-USDC',side:'buy',executor_type:'position',remaining_position_amount_base:'0.01'}];
 const view=buildBotPositionView(p,'ok_rsi',now);assert.deepEqual(view.pairs.map(row=>row.pair),['BTC-USDC','BNB-USDC']);
 assert.equal(new Set(view.pairs.map(row=>row.id)).size,2);assert.equal(view.activeExecutorCount,1);
 for(const row of view.pairs){assert.equal(row.quantity,null);assert.equal(row.markValue,null);assert.equal(row.bagPnl,null);assert.match(row.inventorySource,/unavailable/);}
 p.runtime_status.controllers[1].pair='BTC-USDC';assert.throws(()=>buildBotPositionView(p,'ok_rsi',now),/duplicated/);
 p.runtime_status.controllers[1].pair='BNB-USDC';delete p.runtime_status.controllers[1].pair_projection_source;assert.throws(()=>buildBotPositionView(p,'ok_rsi',now),/duplicated/);
});

test('actual owner snapshot fixture flows through the UI projection without changing quantities', {skip: !process.env.BOT_OBSERVATION_FIXTURE}, async()=>{const fs=await import('node:fs');const runtime=JSON.parse(fs.readFileSync(process.env.BOT_OBSERVATION_FIXTURE,'utf8'));const v=buildBotPositionView({runtime_status:runtime,monitoring:{bot_name:runtime.bot_name,stale_threshold_seconds:30}},runtime.bot_name,Date.parse(runtime.updated_at)+1000);assert.equal(v.activeOrderCount,1);for(const field of ['base','markValue','bagPnl'])assert.equal(v.pairs[0][field],null,`${field} comes only from fleet holdings`);assert.equal(v.pairs[0].pendingSells[0].remaining_amount_base,'2');assert.equal(v.pairs[0].executors[0].trailing_trigger_price,'12');assert.equal(v.orders[0].remaining_amount_base,'2');assert.equal(v.ordersStatus.complete,true);});

test('complete connector order list supplies total count; legacy count is explicitly limit-only',()=>{const p=snapshot();assert.equal(buildBotPositionView(p,'ok_rsi',now).orderCountLabel,'Active limit orders');p.runtime_status.active_orders=[{order_id:'o1',pair:'ETH-USDC'},{order_id:'o2',pair:'ETH-USDC'},{order_id:'o3',pair:'ETH-USDC'}];p.runtime_status.active_orders_status={complete:true};const view=buildBotPositionView(p,'ok_rsi',now);assert.equal(view.activeOrderCount,3);assert.equal(view.orderCountLabel,'Active orders');});

test('cancellation-pending and expired sell requests never look like pending fresh orders',()=>{const p=snapshot();p.runtime_status.controllers[0].custom_info.pending_sell_requests=[{request_id:'canceled',termination_requested:true,expires_at:now/1000+100},{request_id:'expired',termination_requested:false,expires_at:now/1000-1},{request_id:'pending',termination_requested:false,expires_at:now/1000+100}];const rows=buildBotPositionView(p,'ok_rsi',now).pairs[0].pendingSells;assert.deepEqual(rows.map(row=>row.request_state),['Cancellation requested','Expiry reached; awaiting owner','Pending owner request']);});

test('mixed pair states never collapse to one asset label',()=>{
  assert.equal(mixedOperationalLabel([{phase:'FLAT'},{phase:'HOLDING'}]),'MIXED: 1 flat / 1 holding');
  assert.equal(mixedOperationalLabel([{phase:'FLAT'},{phase:'FLAT'}]),'FLAT');
  assert.equal(mixedOperationalLabel([]),'UNKNOWN');
});
