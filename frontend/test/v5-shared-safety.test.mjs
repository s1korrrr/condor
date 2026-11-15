import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { create, act } from 'react-test-renderer';
import * as reactQuery from '@tanstack/react-query';
import { frontendModules } from './helpers/frontend-module.mjs';
import { renderToStaticMarkup } from 'react-dom/server';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { QueryClient, QueryClientProvider } = reactQuery;
const { usePaperSnapshot } = frontendModules({'@tanstack/react-query':reactQuery}).load('v5/usePaperSnapshot');
const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/${section}.json`, import.meta.url)));
const risk = fixture('risk');
const status = fixture('status');
const controller = Object.keys(risk.data.controllers)[0];
function pair(sequence, emergency, bot = risk.bot_id) {
  const next = structuredClone(risk);
  Object.assign(next, {bot_id:bot, snapshot_id:`snapshot-${sequence}`, source:{...next.source, boot_epoch:1, sequence}});
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
  const overrides = Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}]));
  const {PaperWorkspace} = frontendModules(overrides).load('pages/tabs/ActiveBotsTab');
  const old = pair(45, true);
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace,{reads:old,safetyReads:states.strip.safetyReads,reconcileSafety:states.strip.reconcileSafety,complete:false,now:risk.generated_at_ms,reportAt:null,heartbeat:'Fresh',bot}));
  assert.doesNotMatch(html,/New acquisitions held|Emergency halt reported/);
  const clearHtml = renderToStaticMarkup(React.createElement(PaperWorkspace,{reads:pair(46, false),safetyReads:[],reconcileSafety:states.strip.reconcileSafety,complete:false,now:risk.generated_at_ms,reportAt:null,heartbeat:'Fresh',bot}));
  assert.match(clearHtml,/Entry controls/);
  await act(async () => root.unmount());
  client.clear();
});

test('different boot hold versus clear leaves strip restart order unknown', async () => {
  for (const clearKey of ['strip', 'bots']) {
    const client = new QueryClient({defaultOptions:{queries:{retry:false, gcTime:Infinity}}});
    const bot = risk.bot_id, states = {};
    const withBoot = (reads, boot) => reads.map(read => ({...read, source:{...read.source, boot_id:boot, boot_epoch:undefined}}));
    const inputs = {strip:withBoot(pair(2, true), 'boot-b'), bots:withBoot(pair(2, true), 'boot-b')};
    function Observer({name, queryKey}) {
      states[name] = usePaperSnapshot(queryKey, true, 2, async progress => { progress(inputs[name]); return inputs[name]; });
      return null;
    }
    let root;
    await act(async () => { root = create(React.createElement(QueryClientProvider, {client},
      React.createElement(Observer, {name:'strip', queryKey:['v5-paper-observation-health', bot]}),
      React.createElement(Observer, {name:'bots', queryKey:['v5-paper-bots', bot]}))); });
    inputs[clearKey] = withBoot(pair(99, false), 'boot-a');
    await act(async () => { await states[clearKey].refetch(); });
    assert.equal(states.strip.restartOrderUnknown, true);
    await act(async () => root.unmount());
    client.clear();
  }
});

test('epoch-ordered late old-boot clear retains the Bots emergency and newer clear supersedes it', async () => {
  const client = new QueryClient({defaultOptions:{queries:{retry:false, gcTime:Infinity}}});
  const bot = risk.bot_id, states = {};
  const withBoot = (reads, boot, epoch) => reads.map(read => ({...read, source:{...read.source, boot_id:boot, boot_epoch:epoch}}));
  const inputs = {strip:withBoot(pair(2, true), 'boot-b', 2), bots:withBoot(pair(2, true), 'boot-b', 2)};
  function Observer({name, queryKey}) {
    states[name] = usePaperSnapshot(queryKey, true, 2, async progress => { progress(inputs[name]); return inputs[name]; });
    return null;
  }
  let root;
  try {
    await act(async () => { root = create(React.createElement(QueryClientProvider, {client},
      React.createElement(Observer, {name:'strip', queryKey:['v5-paper-observation-health', bot]}),
      React.createElement(Observer, {name:'bots', queryKey:['v5-paper-bots', bot]}))); });
    inputs.strip = withBoot(pair(99, false), 'boot-a', 1);
    await act(async () => { await states.strip.refetch(); });
    assert.equal(states.strip.restartOrderUnknown, false, 'epochs make the restart order known');
    assert.ok(states.bots.safetyEvidence.some(read => read.data.controllers?.[controller]?.operator.emergency === true));
    const overrides = Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}]));
    const {PaperWorkspace} = frontendModules(overrides).load('pages/tabs/ActiveBotsTab');
    const html = renderToStaticMarkup(React.createElement(PaperWorkspace,{reads:inputs.bots,safetyReads:states.bots.safetyReads,reconcileSafety:states.bots.reconcileSafety,complete:true,now:risk.generated_at_ms,reportAt:null,heartbeat:'Fresh',bot}));
    assert.match(html, /New acquisitions held/);
    assert.match(html, /Reported emergency halt: Yes/);
    inputs.bots = withBoot(pair(1, false), 'boot-c', 3);
    await act(async () => { await states.bots.refetch(); });
    assert.equal(states.strip.safetyEvidence.some(read => read.data.controllers?.[controller]?.operator.emergency === true), false);
    assert.equal(states.strip.restartOrderUnknown, false);
  } finally { if (root) await act(async () => root.unmount()); client.clear(); }
});

test('same-boot clear before restart does not create a restart conflict', () => {
  const {PaperSafetyStore} = frontendModules().load('v5/paper-safety-store');
  const store = new PaperSafetyStore();
  const held = pair(41, true), cleared = pair(42, false);
  store.receive(held, held[1]);
  store.receive(cleared, cleared[1]);
  const nextBoot = pair(1, false).map(read => ({...read,source:{...read.source,boot_id:'replacement'}}));
  store.receive(nextBoot, nextBoot[1]);
  assert.equal(store.restartOrderUnknown, false);
});

test('reconciling an unavailable displayed risk never crashes or clears a retained hold', () => {
  const {PaperSafetyStore} = frontendModules().load('v5/paper-safety-store');
  const store = new PaperSafetyStore();
  const initial = pair(40, false), held = pair(41, true);
  store.receive(initial, initial[1]);
  store.receive(held);
  const unavailable = {...pair(42, false)[1],source:{...held[1].source,boot_id:'replacement'},state:'degraded',completeness:'unavailable',data:null};
  assert.deepEqual(store.reconcile([unavailable]), []);
  assert.equal(store.snapshot().length, 1);
});
