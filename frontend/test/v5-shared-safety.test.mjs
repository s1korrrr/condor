import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { create, act } from 'react-test-renderer';
import * as reactQuery from '@tanstack/react-query';
import { frontendModules } from './helpers/frontend-module.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { QueryClient, QueryClientProvider } = reactQuery;
const { usePaperSnapshot } = frontendModules({'@tanstack/react-query':reactQuery}).load('v5/usePaperSnapshot');
const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/${section}.json`, import.meta.url)));
const risk = fixture('risk');
const status = fixture('status');
const controller = Object.keys(risk.data.controllers)[0];
function pair(sequence, emergency, bot = risk.bot_id) {
  const next = structuredClone(risk);
  Object.assign(next, {bot_id:bot, snapshot_id:`snapshot-${sequence}`, source:{...next.source, sequence}});
  Object.assign(next.data, {holds:[], control_hold:null, native_entry_holds:[]});
  for (const row of Object.values(next.data.controllers)) {
    Object.assign(row.operator, {paused:false, emergency:false});
    Object.assign(row.native, {complete:true, latched:false, entry_hold:false});
  }
  next.data.controllers[controller].operator.emergency = emergency;
  return [{...status, bot_id:bot, snapshot_id:next.snapshot_id, source:next.source}, next];
}

test('different query keys share ordered bot safety, including failed strip refresh and isolation', async () => {
  const client = new QueryClient({defaultOptions:{queries:{retry:false, gcTime:Infinity}}});
  const bot = risk.bot_id;
  const states = {};
  const inputs = {strip:pair(41, false), bots:pair(42, true), other:pair(43, true, 'another-bot')};
  function Observer({name, queryKey}) {
    states[name] = usePaperSnapshot(queryKey, true, 2, async progress => {
      const value = inputs[name];
      if (value instanceof Error) throw value;
      progress(value);
      return value;
    });
    return null;
  }
  let root;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, {client},
      React.createElement(Observer, {name:'strip', queryKey:['v5-paper-observation-health', bot]}),
      React.createElement(Observer, {name:'bots', queryKey:['v5-paper-bots', bot]}),
      React.createElement(Observer, {name:'other', queryKey:['v5-paper-bots', 'another-bot']})));
  });
  const emergency = reads => reads.some(read => read.data.controllers?.[controller]?.operator.emergency === true);
  assert.equal(emergency(states.strip.safetyEvidence), true, 'Bots emergency reaches strip');
  assert.ok(states.strip.safetyEvidence.every(read => read.bot_id === bot), 'other bot does not leak');
  inputs.strip = new Error('offline');
  await act(async () => { await states.strip.refetch(); });
  assert.equal(emergency(states.strip.safetyEvidence), true, 'failed refresh retains hold');
  inputs.bots = pair(44, false);
  await act(async () => { await states.bots.refetch(); });
  assert.equal(emergency(states.strip.safetyEvidence), false, 'newer qualified clear reaches failed strip');
  assert.equal(emergency(states.strip.reconcileSafety(pair(42, true).slice(1))), false, 'older displayed hold is superseded');
  inputs.bots = pair(42, true);
  await act(async () => { await states.bots.refetch(); });
  assert.equal(emergency(states.strip.safetyEvidence), false, 'late older hold cannot resurrect');
  inputs.strip = pair(45, true);
  await act(async () => { await states.strip.refetch(); });
  inputs.strip = new Error('offline again');
  await act(async () => { await states.strip.refetch(); });
  inputs.bots = pair(46, false);
  await act(async () => { await states.bots.refetch(); });
  assert.equal(emergency(states.strip.safetyEvidence), false, 'Bots clear supersedes strip hold after failure');
  assert.equal(emergency(states.strip.reconcileSafety(pair(45, true).slice(1))), false, 'displayed strip hold is superseded too');
  await act(async () => root.unmount());
  client.clear();
});
