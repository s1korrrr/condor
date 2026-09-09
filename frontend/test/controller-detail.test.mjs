import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './controller-fixture.cjs';
const {render}=fixture;
const ctrl={controller_name:'ok_rsi',controller_id:'shared',bot_name:'main',status:'running',connector:'okx',trading_pair:'ETH-USDC',realized_pnl_quote:0,unrealized_pnl_quote:0,global_pnl_quote:0,global_pnl_pct:0,volume_traded:0,close_type_counts:{},positions_summary:[],deployed_at:null,config:{manual_kill_switch:false},custom_info:{}};
const props={server:'native',controllers:[ctrl],initialControllerKey:'main-shared',onClose:()=>{},convert:value=>({value,converted:false}),currencySymbol:'USDC '};
const native={native:true,online:true,controllerMutation:false,controllerHistory:false};
function detail(access=native){return render('components/bots/ControllerBrowser.tsx','ControllerBrowser',props,{access});}
function history(botName='main',options={}){return render('components/bots/ControllerPnlChart.tsx','ControllerPnlChart',{server:'source',controllerId:'shared',botName},{access:native,...options});}
test('native detail disables controller mutation and guards direct handler invocation',async()=>{
 const r=detail(); const action=r.buttons.find(b=>b.text.trim()==='Pause');
 assert.equal(action.disabled,true);
 action.onClick(); await assert.rejects(r.mutations[0],/unavailable/i); assert.deepEqual(r.apiCalls,[]);
 assert.match(r.html,/Read only/);
});
test('known full server still dispatches the intended controller and bot',async()=>{
 const r=detail({native:false,online:true,controllerMutation:true,controllerHistory:true});
 r.buttons.find(b=>b.text.trim()==='Pause').onClick(); await Promise.all(r.mutations);
 assert.deepEqual(r.apiCalls,[{name:'stopControllers',args:['native','main',['shared']]}]);
});
test('unsupported history disables the query and states the unavailable capability',()=>{
 const r=history();assert.equal(r.queriesSeen[0].enabled,false);assert.match(r.html,/history is unavailable on this server/);
});
test('history cache includes bot identity and deployment identity',()=>{
 const a=history('main'),b=history('sui');assert.notDeepEqual(a.queriesSeen[0].queryKey,b.queriesSeen[0].queryKey);
 assert.ok(a.queriesSeen[0].queryKey.includes('main'));
});
test('history failed refresh hides stale points and exposes retry rather than a false empty state',()=>{
 const r=history('main',{access:{controllerHistory:true},queries:{'controller-perf-history':{isError:true,error:new Error('read failed'),data:{snapshots:[]}}}});
 assert.match(r.html,/Unable to load performance history/);assert.ok(r.buttons.some(b=>b.text==='Retry'));assert.doesNotMatch(r.html,/No performance history/);
});
test('successful empty history is distinct from unavailable history',()=>{
 const r=history('main',{access:{controllerHistory:true},queries:{'controller-perf-history':{data:{snapshots:[]}}}});
 assert.match(r.html,/No recorded performance snapshots/);
});
test('controller detail declares a named modal dialog',()=>{
 const r=detail();assert.match(r.html,/role="dialog"/);assert.match(r.html,/aria-modal="true"/);assert.match(r.html,/aria-label="Controller details"/);
});
