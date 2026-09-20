import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './controller-fixture.cjs';
const props = {server:'isolated',controllerTypes:{generic:['rsi_modular']},onClose:()=>{},initialControllerName:'rsi_modular'};
function render(profile='') {
  return fixture.render('components/editor/EditorDialogs.tsx','NewConfigDialog',props,{
    stateOverrides:{0:'candidate',1:{},2:'generic',3:profile,4:'rsi_modular'},
    queries:{'controller-template':{data:{profile:{required:true},controller_name:{default:'rsi_modular'}}}},
  });
}
test('no profile disables template request and submission',()=>{
  const r=render();
  assert.equal(r.queriesSeen[0].enabled,false);
  assert.equal(r.buttons.find(b=>b.text.trim()==='Create Config').disabled,true);
});
for(const profile of ['ok_rsi','rsi_v5']) test(`profile ${profile} selects schema and persists exact identity`,async()=>{
  const r=render(profile);
  assert.equal(r.queriesSeen[0].enabled,true);
  await r.queriesSeen[0].queryFn();
  assert.deepEqual(r.apiCalls[0],{name:'getControllerConfigTemplate',args:['isolated','generic','rsi_modular',profile]});
  r.buttons.find(b=>b.text.trim()==='Create Config').onClick();
  await Promise.all(r.mutations);
  assert.equal(r.apiCalls[1].args[2].profile,profile);
  assert.equal(r.apiCalls[1].args[2].controller_name,'rsi_modular');
});
