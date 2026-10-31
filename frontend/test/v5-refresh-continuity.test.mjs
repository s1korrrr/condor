import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import * as ReactQuery from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { setImmediate } from 'node:timers/promises';
import { frontendModules } from './helpers/frontend-module.mjs';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));
const sections = ['status','wallet','positions','fills','executors','risk','decisions','history','accounting'];
const owner = fixture('wallet');
const completeReads = () => sections.map(section => {
  const read = fixture(section);
  if (section === 'risk') read.data.control_hold = 'clock_anomaly';
  return read;
});
const stubs = Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}]));

function harness(kind, initial) {
  let cursor = 0, spec;
  const slots = [], requests = [];
  const query = { data:initial, isFetching:false, isPending:!initial, isError:false, error:null, refetch() {} };
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial === Date.now ? owner.read_at_ms : initial() : initial;
    return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
  };
  const {load} = frontendModules({...stubs, '@/v5/usePaperClock':{usePaperClock:() => owner.read_at_ms}, react:{...React,useState,useRef:initial => useState(() => ({current:initial}))[0],useEffect() {}}, '@tanstack/react-query':{...ReactQuery,useQuery:options => {
    if (options.enabled === false) return {isPending:true,isFetching:false,isError:false,refetch() {}};
    spec = options;
    return query;
  }}});
  const component = kind === 'bots' ? load('pages/tabs/ActiveBotsTab.tsx').V5PaperBots : load('v5/usePaperObservation.ts').usePaperWorkspace;
  const render = () => {
    cursor = 0;
    return kind === 'bots' ? renderToStaticMarkup(component({bot:owner.bot_id,ownerState:'AVAILABLE',generatedAt:owner.generated_at_ms / 1000})) : component('capital',owner.bot_id);
  };
  const original = global.fetch;
  global.fetch = (url, options) => new Promise(resolve => requests.push({url,signal:options.signal,resolve}));
  function start() {
    render(); query.isFetching = true;
    const controller = new AbortController();
    const promise = spec.queryFn({signal:controller.signal});
    promise.catch(() => {});
    return {controller,promise};
  }
  async function deliver(request) {
    const path = new URL(request.url,'https://fixture.invalid').searchParams.get('path');
    const section = path.includes('/native/status') ? 'status' : path.includes('account-balances') || path.includes('fleet/summary') ? 'wallet' : path.includes('/history') ? 'history' : path.includes('/holdings') ? 'positions' : path.includes('/accounting') ? 'accounting' : sections.find(section => path.includes(section));
    const read = section === 'fills' && new URL(path,'https://fixture.invalid').searchParams.has('cursor') ? fixture('fills-offset-200') : fixture(section);
    request.resolve({ok:true,json:async () => read});
    await setImmediate();
  }
  return {query,render,start,requests,deliver,restore:() => {global.fetch = original;}};
}

test('Bots retains held complete snapshot, as-of and totals during refresh and failed refresh', () => {
  const reads = completeReads(), h = harness('bots',reads);
  try {
    const full = h.render(); h.query.isFetching = true;
    const mid = h.render();
    assert.match(mid,/New acquisitions held/);
    assert.match(mid,/Held by owner/);
    assert.match(mid,/Last complete owner snapshot.*As of/);
    assert.match(mid,/Refreshing: 0\/9 sections/);
    const riskCaption = html => html.match(/Risk rails &amp; entry latch[^]*?Decisions &amp; paper control/)?.[0];
    assert.ok(riskCaption(full));
    assert.equal(riskCaption(mid),riskCaption(full));
    h.query.isFetching = false; h.query.isError = true; h.query.error = new Error('Refresh failed');
    assert.match(h.render(),/New acquisitions held/);
    h.query.isError = false;
    h.query.data = reads.map(read => read.section === 'risk' ? {...read,data:{...read.data,control_hold:null}} : read);
    assert.match(h.render(),/New acquisitions held/,'Clearing the global hold cannot hide a controller emergency');
    h.query.isError = false; h.query.data = reads.map(read => ({...read,snapshot_id:'newer:752',generated_at_ms:read.generated_at_ms + 1,...(read.section === 'risk' ? {data:{...read.data,control_hold:null,native_entry_holds:[],controllers:Object.fromEntries(Object.entries(read.data.controllers).map(([id,controller]) => [id,{...controller,operator:{...controller.operator,paused:false,emergency:false},native:{...controller.native,entry_hold:false}}]))}} : {})}));
    assert.doesNotMatch(h.render(),/New acquisitions held/);
  } finally {h.restore();}
});

test('Bots first load reports pending risk and rails, never absent controls or numeric limits', () => {
  const h = harness('bots');
  try {
    h.query.isFetching = true;
    const html = h.render();
    assert.match(html,/Checking: 0\/9 sections/);
    assert.match(html,/Risk.*[Pp]ending/);
    assert.doesNotMatch(html,/Not connected|No owner limit or latch observation|Numeric rail limits are not published|Risk controls not yet connected/);
  } finally {h.restore();}
});

test('Capital hook retains the complete wallet, history and accounting while refreshing', () => {
  const reads = completeReads(), full = {...reads[1],history_read:fixture('history'),accounting_read:fixture('accounting')};
  const h = harness('capital',full);
  try {
    h.render(); h.query.isFetching = true;
    const result = h.render();
    assert.deepEqual(result.data,full);
    assert.equal(result.complete,true);
    assert.match(result.progress,/Refreshing: 0\/4 sections/);
    h.query.isFetching = false; h.query.isError = true; h.query.error = new Error('Read unavailable');
    assert.deepEqual(h.render().data,full);
  } finally {h.restore();}
});

for (const kind of ['bots','capital']) test(`${kind} ignores progress from an aborted orphaned refresh`, async () => {
  const h = harness(kind);
  try {
    const old = h.start(), oldRequest = h.requests.shift();
    old.controller.abort();
    const current = h.start();
    await h.deliver(h.requests.shift());
    await h.deliver(h.requests.shift());
    const currentView = h.render();
    const progress = kind === 'bots' ? currentView : currentView.progress;
    assert.match(progress,/2\/[49] sections/);
    if (kind === 'bots') assert.doesNotMatch(currentView,/Not connected|No owner limit or latch observation|Numeric rail limits are not published/);
    else assert.equal(currentView.complete,false);
    await h.deliver(oldRequest);
    const after = h.render();
    assert.equal(kind === 'bots' ? after : after.progress,progress);
    assert.equal(oldRequest.signal.aborted,true);
    while (h.requests.length) await h.deliver(h.requests.shift());
    await current.promise;
    await old.promise.catch(() => {});
  } finally {h.restore();}
});
