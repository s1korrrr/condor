import test from 'node:test';
import assert from 'node:assert/strict';
import {retainReadProfile,transientReadFailure} from '../src/lib/read-continuity.ts';
import {serverCapabilities} from '../src/lib/server-capabilities.ts';
test('health errors preserve verified layout but disable every action and fresh read capability',()=>{
  const prior={status:'online',profile:'native',capabilities:{native_status:true,native_controls_enabled:true,native_stop:true,accounts:true,portfolio_read:true}};
  const result=retainReadProfile({status:'error'},prior);
  assert.equal(result.profile,'native');
  const access=serverCapabilities(result);
  for(const key of ['online','botStop','botRead','portfolioRead','accountManagement','manualTrading','controllerMutation']) assert.equal(access[key],false,key);
  assert.equal(retainReadProfile({status:'error'},{...prior,capabilities:{native_status:false}}).profile,undefined);
});
test('only known transport failures qualify, not denial or invalid responses',()=>{
  for(const status of [408,429,500,503]) assert.equal(transientReadFailure({status}),true);
  for(const error of [null,{},new Error('Malformed'),{status:401},{status:403},{status:404}]) assert.equal(transientReadFailure(error),false);
  assert.equal(transientReadFailure(new TypeError('Failed to fetch')),true);
});
