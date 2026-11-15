import test from 'node:test';
import assert from 'node:assert/strict';
import * as reactQuery from '@tanstack/react-query';
import { frontendModules } from './helpers/frontend-module.mjs';

test('stale Helm responses do not advance the last fresh report time', async () => {
  const {readHelm} = frontendModules({'@tanstack/react-query':reactQuery}).load('v5/V5Helm');
  const client = new reactQuery.QueryClient();
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = 1000, state = 'FRESH';
  Date.now = () => now;
  globalThis.fetch = async () => ({ok:true, json:async () => ({state,reason:'',status:{generated_at:1,age_s:0}})});
  try {
    const options = {queryKey:['v5-helm'],queryFn:readHelm};
    await client.fetchQuery(options);
    const lastFresh = client.getQueryData(options.queryKey)._lastUsableAtMs;
    state = 'STALE'; now = 2000;
    await client.fetchQuery(options);
    assert.equal(client.getQueryData(options.queryKey)._lastUsableAtMs, lastFresh);
    now = 3000;
    await client.fetchQuery(options);
    assert.equal(client.getQueryData(options.queryKey)._lastUsableAtMs, lastFresh);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; client.clear(); }
});

test('Helm cached send time survives structural sharing and unavailable keeps the last usable time', async () => {
  const {readHelm, helmRequestedAt} = frontendModules({'@tanstack/react-query':reactQuery}).load('v5/V5Helm');
  const {statusStrip} = await import('../src/v5/status-strip-model.mjs');
  const client = new reactQuery.QueryClient();
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = 1_000_000, calls = 0;
  Date.now = () => now;
  globalThis.fetch = async () => {
    calls++; now += 2000;
    return {ok:true, json:async () => calls === 3 ? {state:'UNAVAILABLE',reason:'owner_down',status:null} :
      {state:'FRESH',reason:'',status:{generated_at:900,age_s:29,ready:true,reasons:[],gates:[],symbols:[],steps:calls}}};
  };
  try {
    const options = {queryKey:['v5-helm'],queryFn:readHelm};
    await client.fetchQuery(options);
    const first = client.getQueryData(options.queryKey);
    now += 1000;
    const sent = now;
    await client.fetchQuery(options);
    const second = client.getQueryData(options.queryKey);
    assert.equal(helmRequestedAt(second), sent);
    assert.equal(second.status.reasons, first.status.reasons, 'unchanged nested values are structurally shared');
    const strip = statusStrip({nowMs:now,v5:{bound:false,pending:false,current:false,entryHold:null,lastOkMs:null},
      helm:{read:second,failed:false,lastOkMs:second._lastUsableAtMs,requestedAtMs:helmRequestedAt(second),receivedAtMs:now},
      data:{configured:false,pending:false,failed:false,lanes:null,lastOkMs:null},wallet:{current:false},updatedMs:null});
    assert.equal(strip.chips.find(chip => chip.id === 'helm').tone, 'grey', '29 seconds plus 2 seconds delivery is stale');
    const lastUsable = second._lastUsableAtMs;
    await client.fetchQuery(options);
    const unavailable = client.getQueryData(options.queryKey);
    assert.equal(unavailable._lastUsableAtMs, lastUsable);
    assert.equal(unavailable.reason, 'owner_down');
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; client.clear(); }
});
