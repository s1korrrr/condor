import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeControlEligibility, nativeCommandOutcome, nativeBotPath, awaitingNativeOwnerTransition } from '../src/lib/native-bot-controls.ts';

const now=Date.parse('2026-09-08T22:00:00Z');
const boot='12345678-1234-1234-1234-123456789abc';
test('native routes stay dedicated and encode server and bot path identities',()=>{
  assert.equal(nativeBotPath('server/other','bot?x','stop'),'/api/v1/servers/server%2Fother/bots/bot%3Fx/native/stop');
  assert.equal(nativeBotPath('server','bot','start'),'/api/v1/servers/server/bots/bot/native/start');
  assert.throws(()=>nativeBotPath('server','bot','archive'));
  assert.throws(()=>nativeBotPath('','bot','stop'));
});
function observation(state='running') {
  return {status:'success',data:{bot_name:'bot',status:state,source:'native_mqtt',execution_owner:'native_hummingbot',identity_verified:true,mqtt_instance_id:'instance',stale_after_seconds:30,heartbeat:{retained:false,received_at:now/1000,source_timestamp:now*1000},lifecycle:{valid:true,blocked_reason:null,state,reconciliation_complete:true,boot_id:boot,sequence:3,observation:{retained:false,replayed:false,received_at:now/1000,payload:{generated_at:now/1000,boot_id:boot,sequence:3,instance_id:'instance',state}}}}};
}
test('only current verified native lifecycle enables the matching action',()=>{
  assert.equal(nativeControlEligibility(observation(),'bot',true,true,now).action,'stop');
  assert.equal(nativeControlEligibility(observation(),'bot',true,true,now).allowed,true);
  assert.equal(nativeControlEligibility(observation('stopped'),'bot',true,true,now).action,'start');
  const value=observation('stopped');value.data.lifecycle.reconciliation_complete=false;
  assert.equal(nativeControlEligibility(value,'bot',true,true,now).allowed,false);
});
test('clock expiry, stale identity, capability loss and wrong bot fail closed',()=>{
  assert.equal(nativeControlEligibility(observation(),'bot',true,true,now+30000).allowed,false);
  assert.equal(nativeControlEligibility(observation(),'other',true,true,now).allowed,false);
  assert.equal(nativeControlEligibility(observation(),'bot',false,true,now).allowed,false);
  assert.equal(nativeControlEligibility(observation('stopped'),'bot',true,false,now).allowed,false);
  for(const modify of [v=>v.data.identity_verified=false,v=>v.data.lifecycle.valid=false,v=>v.data.lifecycle.observation.retained=true,v=>v.data.heartbeat.source_timestamp=(now+60000)*1000]) {
    const value=observation();modify(value);assert.equal(nativeControlEligibility(value,'bot',true,true,now).allowed,false);
  }
});
test('fresh verified unknown lifecycle permits only reconciliation stop',()=>{
  const value=observation('unknown');
  value.data.lifecycle.reconciliation_complete=false;
  const allowed=nativeControlEligibility(value,'bot',true,true,now);
  assert.equal(allowed.action,'stop');
  assert.equal(allowed.allowed,true);
  assert.notEqual(allowed.action,'start');
  assert.equal(nativeControlEligibility(value,'bot',true,true,now+30000).allowed,false);
  value.data.lifecycle.valid=false;
  assert.equal(nativeControlEligibility(value,'bot',true,true,now).allowed,false);
  for(const state of ['starting','stopping','unrecognized']) {
    assert.equal(nativeControlEligibility(observation(state),'bot',true,true,now).allowed,false);
  }
});
test('publication and accepted commands never imply execution completion',()=>{
  const expected={botName:'bot',action:'stop',bootId:boot,instanceId:'instance'};
  assert.equal(nativeCommandOutcome({httpStatus:202,body:{status:'unknown',response:{publication_accepted:true,outcome_unknown:true}}},expected).state,'unknown');
  assert.equal(nativeCommandOutcome({httpStatus:200,body:{status:'success',response:{execution_verified:true}}},expected).state,'unknown');
  assert.equal(nativeCommandOutcome({httpStatus:409,body:{detail:'Lifecycle unavailable'}},expected).state,'rejected');
});
test('only exact completed owner acknowledgement establishes verified stop',()=>{
  const expected={botName:'bot',action:'stop',bootId:boot,instanceId:'instance'};
  const result={httpStatus:200,body:{status:'success',response:{execution_verified:true,owner_accepted:true,owner_execution_completed:true,outcome_unknown:false,verification_source:'native_owner_acknowledgement',request_id:'request',bot_name:'bot',action:'stop',acknowledgement:{request_id:'request',boot_id:boot,instance_id:'instance',action:'stop',accepted:true,execution_completed:true,state:'stopped',reconciliation_complete:true}}}};
  assert.equal(nativeCommandOutcome(result,expected).state,'verified');
  result.body.response.acknowledgement.boot_id='other';
  assert.equal(nativeCommandOutcome(result,expected).state,'unknown');
});


test('fresh terminal unknown permits deliberate reconciliation retry after failed stop',()=>{
  const submitted={bootId:boot,sequence:2,action:'stop'};
  const eligible=nativeControlEligibility(observation('unknown'),'bot',true,true,now);
  assert.equal(awaitingNativeOwnerTransition(submitted,eligible),false);
  assert.equal(eligible.action,'stop');
  assert.equal(awaitingNativeOwnerTransition(submitted,{...eligible,sequence:2}),true);
  assert.equal(awaitingNativeOwnerTransition(submitted,nativeControlEligibility(observation('unknown'),'bot',true,true,now+30000)),true);
  assert.equal(awaitingNativeOwnerTransition(submitted,nativeControlEligibility(observation('running'),'bot',true,true,now)),true);
});

test('fresh replacement boot releases old request without claiming its execution',()=>{
  const submitted={bootId:'previous-boot',sequence:999,action:'stop'};
  const eligible=nativeControlEligibility(observation('running'),'bot',true,true,now);
  assert.equal(awaitingNativeOwnerTransition(submitted,eligible),false);
  assert.equal(awaitingNativeOwnerTransition(submitted,{...eligible,allowed:false}),true);
  assert.equal(awaitingNativeOwnerTransition(null,eligible),false);
});
