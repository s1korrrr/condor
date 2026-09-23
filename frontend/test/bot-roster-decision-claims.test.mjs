import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';

const {load}=frontendModules({'react-router-dom':{Link:({to,children})=>React.createElement('a',{href:to},children)}});
const {RosterObservation}=load('components/bots/BotsRoster.tsx');
const now=Date.parse('2026-09-23T00:00:01Z');
const payload={runtime_status:{bot_name:'rsi_modular_v2',updated_at:'2026-09-23T00:00:00Z',
  controllers:[{controller_id:'btc',pair:'BTC-USDC',state:'FLAT',price_quote:100,plan_next:'Wait for entry'}],
  positions_held:[],active_executors:[]},monitoring:{bot_name:'rsi_modular_v2',stale_threshold_seconds:30}};

test('current plan condition does not become a recent decision or market regime',()=>{
  const html=renderToStaticMarkup(React.createElement(RosterObservation,{payload,bot:'rsi_modular_v2',now,events:{data:{decisions:[]}}}));
  const decisionPanel=html.split('data-panel-id="B20"')[1].split('data-panel-id="B21"')[0];
  assert.match(decisionPanel,/No decision journal is admitted/);
  assert.doesNotMatch(decisionPanel,/Wait for entry/);
  assert.doesNotMatch(html,/>Regime</);
  assert.doesNotMatch(html,/Open vs closed trips/);
});

test('only a recorded owner decision appears in the recent-decisions panel',()=>{
  const events={data:{decisions:[
    {decision_id:'d1',owner_boot_id:'boot',config_revision:'rev',sequence:1,
      occurred_at:'2026-09-23T00:00:00Z',action:'Hold risk',pair:'BTC-USDC',linkage:'unlinked'},
    {occurred_at:'2026-09-23T00:00:00Z',action:'Unqualified',pair:'BTC-USDC'},
  ]}};
  const html=renderToStaticMarkup(React.createElement(RosterObservation,{payload,bot:'rsi_modular_v2',now,events}));
  const decisionPanel=html.split('data-panel-id="B20"')[1].split('data-panel-id="B21"')[0];
  assert.match(decisionPanel,/Hold risk/);
  assert.doesNotMatch(decisionPanel,/Unqualified|Wait for entry/);
});
