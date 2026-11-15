import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));

test('strip reports a native hold even when its controller is omitted', () => {
  const risk = fixture('risk');
  const id = Object.keys(risk.data.controllers)[0];
  risk.data.controllers = {[id]:risk.data.controllers[id]};
  Object.assign(risk.data.controllers[id].operator, {paused:false, emergency:false});
  Object.assign(risk.data.controllers[id].native, {complete:true, latched:false, entry_hold:false});
  Object.assign(risk.data, {holds:[], control_hold:null, native_entry_holds:[{controller_id:'missing-controller',reason:'native_refusal_receipt_pending',explanation:'receipt pending',protected_exits:'preserved'}]});
  const policy = frontendModules().load('v5/policy');
  assert.equal(policy.paperNativeHolds(risk).length, 1);
  const paper = {data:[risk],dataUpdatedAt:risk.read_at_ms,isError:false,safetyEvidence:[],reconcileSafety:reads => reads};
  const {load} = frontendModules({
    './policy':{...policy,paperObservationSummary:() => ({label:'Available'})},
    './usePaperObservation':{usePaperObservation:() => paper},
    './usePaperClock':{usePaperClock:() => risk.read_at_ms},
    '@tanstack/react-query':{useQuery:() => ({data:undefined,dataUpdatedAt:0,isError:false})},
    'react-router-dom':{NavLink:({children,...props}) => React.createElement('a',props,children)},
  });
  const html = renderToStaticMarkup(React.createElement(load('v5/StatusStrip').StatusStrip,{bot:risk.bot_id,candleConfigured:false}));
  assert.match(html,/Buying paused by an owner hold/);
  assert.doesNotMatch(html,/V5 running/);
});

test('last usable paper report does not advance on unusable observations', () => {
  let result = {data:[{usable:true}],dataUpdatedAt:1000,reads:[],journalReads:[],complete:true,isPending:false,isFetching:false,isError:false};
  const ref = {current:null};
  const {load} = frontendModules({
    react:{...React,useRef:() => ref},
    './usePaperClock':{usePaperClock:() => 1000},
    './usePaperSnapshot':{usePaperSnapshot:() => result},
    './policy':{paperObservationSummary:reads => ({label:reads[0]?.usable ? 'Available' : 'Unavailable'})},
  });
  const observe = load('v5/usePaperObservation').usePaperObservation;
  assert.equal(observe('bot').lastUsableAtMs,1000);
  result = {...result,data:[{usable:false}],dataUpdatedAt:2000};
  assert.equal(observe('bot').lastUsableAtMs,1000);
  result = {...result,isError:true,dataUpdatedAt:3000,error:new Error('offline')};
  assert.equal(observe('bot').lastUsableAtMs,1000);
});
