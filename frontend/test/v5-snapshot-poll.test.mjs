import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import * as ReactQuery from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { setImmediate } from 'node:timers/promises';
import { frontendModules } from './helpers/frontend-module.mjs';
import { paperCoherentRead, paperSectionError } from '../src/v5/policy.ts';

test('validated snapshot pages are immutable while unadmitted inputs still get validated', async () => {
  const fixture = section => JSON.parse(readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));
  const packets = {status:fixture('status'), executors:fixture('executors')};
  const progress = [];
  const reads = await paperCoherentRead('/status', [{section:'executors',path:'/executors',paginate:true}],
    async (_path, section) => packets[section], undefined, current => progress.push(current));
  const executors = progress.at(-1).find(read => read.section === 'executors');
  assert.equal(executors, reads[1]);
  assert.equal(paperSectionError(executors), null);
  assert.throws(() => {executors.data[0].executor_id = 7;}, TypeError);
  const mutable = structuredClone(executors);
  assert.equal(paperSectionError(mutable), null);
  mutable.data[0].executor_id = 7;
  assert.match(paperSectionError(mutable), /owner schema invalid/);
});

test('journal evidence survives switching snapshot queries and clears with a qualified newer observation', async () => {
  const client = new ReactQuery.QueryClient();
  client.setQueryData(['v5-profile'], {});
  const status = JSON.parse(readFileSync(new URL('../../tests/fixtures/paper-api-final3/native-replay/status.json', import.meta.url)));
  status.data.journal_budget = {state:'exceeded',journal_evidence_held:true};
  let options, view;
  const {usePaperSnapshot} = frontendModules({
    '@tanstack/react-query':{...ReactQuery, useQueryClient:() => client, useQuery:query => {
      options = query;
      return client.getQueryCache().build(client, query).state;
    }},
  }).load('v5/usePaperSnapshot.ts');
  const observe = key => {
    renderToStaticMarkup(React.createElement(function Probe() {
      view = usePaperSnapshot([key, status.bot_id], true, 1, async progress => {
        progress([status]);
        throw new Error('Later section failed');
      }, false, {journalAcrossRoutes:true});
      return null;
    }));
    return view.journalReads;
  };
  try {
    const health = 'v5-paper-observation-health', bots = 'v5-paper-bots';
    assert.deepEqual(observe(health), []);
    await assert.rejects(options.queryFn({signal:new AbortController().signal}), /Later section failed/);
    assert.deepEqual(observe(bots), [status]);
    const healed = {...status, state:'available', reason:null, snapshot_id:'next', source:{...status.source, sequence:status.source.sequence + 1},
      data:{...status.data, journal_budget:null, operations:{state:'available', completeness:'complete', reason:null, stale_reason:null}}};
    client.setQueryData([bots, status.bot_id], [healed]);
    assert.deepEqual(observe(bots), []);
    assert.deepEqual(observe(health), []);
    client.removeQueries({queryKey:['v5-profile']});
    assert.deepEqual(observe(bots), []);
  } finally {client.clear();}
});

test('shared snapshot hook waits for settlement and joins a pending manual refresh', async context => {
  context.mock.timers.enable({apis:['setTimeout','setInterval']});
  ReactQuery.environmentManager.setIsServer(() => false);
  const client = new ReactQuery.QueryClient({defaultOptions:{queries:{staleTime:Infinity,gcTime:Infinity}}});
  const key = ['snapshot-poll-test'];
  client.setQueryData(key, []);
  let observer, view;
  const pending = [];
  const load = (_progress, signal) => new Promise(resolve => pending.push({signal,resolve}));
  const {usePaperSnapshot} = frontendModules({
    '@tanstack/react-query':{...ReactQuery, useQueryClient:() => client, useQuery:options => {
      observer = new ReactQuery.QueryObserver(client, options);
      return observer.getCurrentResult();
    }},
  }).load('v5/usePaperSnapshot.ts');
  renderToStaticMarkup(React.createElement(function Probe() {
    view = usePaperSnapshot(key, true, 0, load, 100);
    return null;
  }));
  const unobserve = observer.subscribe(() => {});
  try {
    context.mock.timers.tick(100);
    assert.equal(pending.length, 1);
    const first = pending[0];
    context.mock.timers.tick(300);
    assert.equal(pending.length, 1);
    const manual = view.refetch();
    assert.equal(pending.length, 1, 'a manual refresh joins the in-flight poll');
    assert.equal(first.signal.aborted, false);
    first.resolve([]);
    await manual;
    await setImmediate();
    context.mock.timers.tick(99);
    assert.equal(pending.length, 1);
    context.mock.timers.tick(1);
    assert.equal(pending.length, 2, 'the next poll waits a full interval after settlement');
    pending[1].resolve([]);
  } finally {
    for (const attempt of pending) attempt.resolve([]);
    unobserve();
    client.clear();
    ReactQuery.environmentManager.setIsServer(() => true);
  }
});
