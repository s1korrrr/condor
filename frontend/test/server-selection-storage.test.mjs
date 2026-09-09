import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { frontendModules, memoryStorage } from './helpers/frontend-module.mjs';

function provider(t, storage) {
  const original = globalThis.localStorage;
  globalThis.localStorage = storage;
  t.after(() => { globalThis.localStorage = original; });
  let initialized = false, state;
  const overrides = {
    react: {...React, useState(initial){
      if(!initialized){state=typeof initial==='function'?initial():initial;initialized=true;}
      return [state,value=>{state=typeof value==='function'?value(state):value;}];
    },useCallback:fn=>fn},
    '@/components/layout/AppShell': {AppShell:()=>null},
  };
  for(const name of ['AgentDetail','Agents','BotDetail','Bots','CreateExecutor','Executors','Login','Portfolio','Routines','Settings','StrategyDetail','WorkspaceTools'])overrides[`@/pages/${name}`]={[name]:()=>null};
  const modules=frontendModules(overrides,{'App.tsx':['ServerProvider']});
  const Provider=modules.load('App.tsx').ServerProvider;
  return ()=>Provider({children:null}).props.value;
}

test('unavailable selection storage does not crash the authenticated shell', t => {
  const render=provider(t,{getItem(){throw new Error('Storage denied');}});
  let context;
  assert.doesNotThrow(()=>{context=render();});
  assert.equal(context.server,null);
  assert.equal(typeof context.persistenceError,'string');
});

test('failed persistence keeps the chosen server in this tab and reports the limitation', t => {
  const storage=memoryStorage({condor_selected_server:'native-owner'});
  storage.setItem=()=>{throw new Error('Storage denied');};
  const render=provider(t,storage);
  const before=render();
  assert.doesNotThrow(()=>before.setServer('next-owner'));
  const after=render();
  assert.equal(after.server,'next-owner');
  assert.equal(typeof after.persistenceError,'string');
  assert.equal(storage.getItem('condor_selected_server'),'native-owner');
});
