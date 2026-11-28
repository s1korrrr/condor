import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient} from '@tanstack/react-query';
import * as queryLibrary from '@tanstack/react-query';
import {frontendModules} from './helpers/frontend-module.mjs';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));
const {OwnerJournalCondition} = frontendModules().load('v5/OwnerJournalCondition.tsx');
const render = status => renderToStaticMarkup(React.createElement(OwnerJournalCondition, {status, snapshotLabel:'Owner snapshot'}));

test('old API diagnostic still exposes the named owner journal hold', () => {
  const status = fixture('status');
  status.state = 'degraded';
  status.reason = 'OWNER_SECTION_DEGRADED';
  status.data.operations.completeness = 'partial';
  status.data.operations.stale_reason = 'observation_journal_exceeded';
  status.data.operations.state = 'degraded';
  status.data.operations.reason = 'observation_journal_exceeded';
  const html = render(status);
  assert.match(html, /Paper journal evidence held/);
});

test('received new hold cannot disappear behind a prior complete healthy snapshot', () => {
  const retained = ['status','wallet','positions','executors','risk'].map(fixture);
  const status = structuredClone(retained[0]);
  status.state = 'degraded';
  status.reason = 'OWNER_JOURNAL_EXCEEDED';
  status.data.journal_budget = {state:'exceeded',journal_evidence_held:true,native_execution_continues:true};
  const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
  const queryKey = ['v5-paper-observation-health',status.bot_id];
  client.setQueryData(queryKey, retained);
  const graph = frontendModules({
    react:{...React, useRef:()=>({current:null}),
      useState:()=>[{key:JSON.stringify(queryKey),signal:new AbortController().signal,reads:[status]},()=>{}],
      useSyncExternalStore:(_subscribe,getSnapshot)=>getSnapshot()},
    '@tanstack/react-query':{...queryLibrary,useQueryClient:()=>client,
      useQuery:()=>({data:retained,isError:true,isPending:false,isFetching:false,error:new Error('wallet failed after status')})}
  });
  try {
    const observation = graph.load('v5/usePaperObservation.ts').usePaperObservation(status.bot_id);
    assert.equal(observation.reads[0].reason, 'OWNER_JOURNAL_EXCEEDED');
    assert.equal(observation.status, retained[0]);
    assert.equal(observation.journalStatus.reason, 'OWNER_JOURNAL_EXCEEDED');
    const Notice = graph.load('v5/OwnerJournalCondition.tsx').PaperJournalNotice;
    const html = renderToStaticMarkup(React.createElement(Notice, {bot:status.bot_id}));
    assert.match(html,/Paper journal evidence held/);
    assert.match(html,/received.*partial/i);
  } finally {
    client.clear();
  }
});

test('cached health status cannot resurrect a cleared journal hold on route revisit', () => {
  const cached = ['status','wallet','positions','executors','risk'].map(fixture);
  const status = cached[0];
  status.data.journal_budget = {state:'exceeded',journal_evidence_held:true};
  const client = new QueryClient();
  client.setQueryData(['v5-profile'], {});
  const healthKey = ['v5-paper-observation-health', status.bot_id];
  const botsKey = ['v5-paper-bots', status.bot_id];
  client.setQueryData(healthKey, cached);
  const {load} = frontendModules({
    react:{...React, useRef:()=>({current:null}), useState:()=>[null,()=>{}], useSyncExternalStore:(_subscribe,getSnapshot)=>getSnapshot()},
    '@tanstack/react-query':{...queryLibrary, useQueryClient:()=>client, useQuery:options => ({
      ...client.getQueryCache().build(client, options).state, isFetching:false,
    })},
  });
  const {PaperJournalNotice} = load('v5/OwnerJournalCondition.tsx');
  const {usePaperObservation} = load('v5/usePaperObservation.ts');
  const {usePaperSnapshot} = load('v5/usePaperSnapshot.ts');
  const noticeStatus = () => PaperJournalNotice({bot:status.bot_id}).props.status;
  try {
    assert.equal(noticeStatus(), status);
    const healed = cached.map(read => ({...read, snapshot_id:'next',
      source:{...read.source, sequence:read.source.sequence + 1}}));
    healed[0] = {...healed[0], state:'available', reason:null,
      data:{...status.data, journal_budget:null, operations:{state:'available', completeness:'complete', reason:null, stale_reason:null}}};
    client.setQueryData(botsKey, healed);
    assert.deepEqual(usePaperSnapshot(botsKey, true, healed.length, async () => healed, false, {journalAcrossRoutes:true}).journalReads, []);
    const health = usePaperObservation(status.bot_id);
    assert.equal(health.status, status, 'the health query still has the old data');
    assert.equal(health.journalStatus, undefined, 'the shared journal already cleared the hold');
    assert.equal(noticeStatus(), undefined);
  } finally {client.clear();}
});
