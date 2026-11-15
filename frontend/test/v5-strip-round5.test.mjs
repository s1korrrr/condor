import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));

test('strip rejects repeated successful summaries with an old owner evaluation time', () => {
  let now = 1_793_929_900_000;
  const paper = {data:undefined,isError:false,safetyEvidence:[],reconcileSafety:reads => reads};
  const summary = {now:(now - 600_000) / 1000,status_age_s:1,tiles:[{available:true,last_minute_age_s:20,health:'green',partition_errors:[]}]};
  const candles = {data:summary,dataUpdatedAt:now,isError:false};
  const {load} = frontendModules({
    './usePaperObservation':{usePaperObservation:() => paper},
    './usePaperClock':{usePaperClock:() => now},
    '@tanstack/react-query':{useQuery:options => options.queryKey[0] === 'candle-summary' ? candles : {data:undefined,dataUpdatedAt:0,isError:false}},
    'react-router-dom':{NavLink:({children,...props}) => React.createElement('a',props,children)},
  });
  const Strip = load('v5/StatusStrip').StatusStrip;
  for (let refresh = 0; refresh < 2; refresh++) {
    candles.dataUpdatedAt = now;
    const html = renderToStaticMarkup(React.createElement(Strip,{bot:null,candleConfigured:true}));
    assert.match(html,/Owner summary not current/);
    assert.doesNotMatch(html,/Live · slowest lane/);
    now += 30_000;
  }
});

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
