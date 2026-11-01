import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {QueryClient} from '@tanstack/react-query';
import * as queryLibrary from '@tanstack/react-query';
import {frontendModules} from './helpers/frontend-module.mjs';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));
const sections = ['status','wallet','positions','executors','risk'];

test('retained journal status never replaces newer complete engine identity', () => {
  const old = sections.map(fixture);
  const held = structuredClone(old[0]);
  held.source.sequence += 1; held.snapshot_id = `${held.source.boot_id}:${held.source.sequence}`; held.generated_at_ms += 15000;
  held.state = 'degraded'; held.reason = 'OWNER_JOURNAL_EXCEEDED';
  held.data.journal_budget = {state:'exceeded',journal_evidence_held:true,native_execution_continues:true};
  const newer = sections.map(fixture).map(read => ({...read, snapshot_id:'newboot:1', generated_at_ms:read.generated_at_ms + 600000,
    source:{...read.source, boot_id:'newboot', sequence:1, source_sha256:'NEW_ENGINE_SOURCE'}}));
  const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
  const queryKey = ['v5-paper-observation-health', held.bot_id];
  client.setQueryData(queryKey, old);
  let data = old, progress = [held], error = true;
  const graph = frontendModules({
    react:{...React, useRef:()=>({current:null}),
      useState:()=>[{key:JSON.stringify(queryKey),signal:new AbortController().signal,reads:progress},()=>{}],
      useSyncExternalStore:(_s,get)=>get()},
    '@tanstack/react-query':{...queryLibrary,useQueryClient:()=>client,
      useQuery:()=>({data,isError:error,isPending:false,isFetching:false,error:error ? new Error('wallet failed') : null})}
  });
  const hook = graph.load('v5/usePaperObservation.ts').usePaperObservation;
  const first = hook(held.bot_id);
  data = newer; progress = []; error = false; client.setQueryData(queryKey, newer);
  const second = hook(held.bot_id);
  assert.equal(second.status.snapshot_id, 'newboot:1', 'Identity consumers read status.source / snapshot_id');
  assert.equal(second.status.source.source_sha256, 'NEW_ENGINE_SOURCE');
  assert.ok(second.snapshot, 'New completed identity keeps its As of presentation');
  assert.equal(second.journalStatus.reason, 'OWNER_JOURNAL_EXCEEDED');
  assert.equal(second.journalStatus.source.boot_id, held.source.boot_id);
  assert.match(second.journalSnapshotLabel, /received.*partial/i);
  assert.equal(first.journalStatus.reason, 'OWNER_JOURNAL_EXCEEDED');
  assert.equal(first.status.snapshot_id, old[0].snapshot_id);
  client.clear();
});
