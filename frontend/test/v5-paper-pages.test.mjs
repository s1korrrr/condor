import test from 'node:test';
import assert from 'node:assert/strict';
import { paperWorkspaceLabel, paperReadiness } from '../src/v5/policy.ts';
import * as policy from '../src/v5/policy.ts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';
import fs from 'node:fs';
import * as ReactQuery from '@tanstack/react-query';

for (const page of ['health','capital','operations','bots']) for (const failure of [409,503]) for (const exhausted of [false,true]) test(`${page} actual query ${failure} ${exhausted?'stops unavailable at the cap':'retries once and publishes only a coherent result'}`, async () => {
  const queries=[]; const calls=[];let attempt=0,failed=false;
  const bot='meridian_v5_paper';
  const fixtures=Object.fromEntries(['status','wallet','positions','executors','risk','history','accounting','fills','decisions'].map(section=>[section,JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`,import.meta.url)))]));
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    const path=new URL(url,'https://fixture.invalid').searchParams.get('path');calls.push(path);
    const section=path.includes('native/status')?'status':path.includes('account-balances')||path.includes('fleet/summary')?'wallet':path.includes('holdings')?'positions':path.includes('performance/history')?'history':path.includes('operations/workspace')?'operations':path.split('?')[0].split('/').at(-1);
    if(section==='status'||section==='operations')attempt++;
    if ((!failed || exhausted) && (section==='risk'||page==='capital'&&section==='history'||section==='operations')) {failed=true;return {ok:false,status:failure,json:async()=>({})};}
    const value=structuredClone(fixtures[section]??fixtures.status);value.section=section;value.snapshot_id=`test:${attempt}`;value.generated_at_ms=1793275200000+attempt;value.next_cursor=null;
    return {ok:true,status:200,json:async()=>value};
  };
  try {
    const overrides={
      '@tanstack/react-query':{...ReactQuery,useQuery:options=>{queries.push(options);return {isPending:true,refetch(){}};}},
      ...Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name=>[name,{}])),
    };
    const {load}=frontendModules(overrides);
    if(page==='bots')renderToStaticMarkup(React.createElement(load('pages/tabs/ActiveBotsTab.tsx').V5PaperBots,{bot,generatedAt:1793275200,ownerState:'FRESH'}));
    else {
      const hooks=load('v5/usePaperObservation.ts');
      function Probe(){if(page==='health')hooks.usePaperObservation(bot);else hooks.usePaperWorkspace(page,bot);return null;}
      renderToStaticMarkup(React.createElement(Probe));
    }
    assert.equal(queries[0].retry,false);
    if (exhausted) {
      await assert.rejects(queries[0].queryFn({signal:new AbortController().signal}), /unavailable|snapshot changed/);
      assert.equal(attempt,2);
      return;
    }
    const result=await queries[0].queryFn({signal:new AbortController().signal});
    assert.equal(attempt,2);
    if(page==='bots'||page==='health')assert.ok(result.every(read=>read.snapshot_id==='test:2'));
    if(page==='capital')assert.deepEqual([result.snapshot_id,result.history_read.snapshot_id,result.accounting_read.snapshot_id],['test:2','test:2','test:2']);
    assert.ok(calls.length<25);
  } finally {globalThis.fetch=oldFetch;}
});

for (const status of [409, 503]) test(`whole paper read restarts coherently after ${status}`, async () => {
  const calls = [], waits = [];
  let attempt = 0;
  const reads = await policy.paperCoherentRead('/status', [{section:'wallet',path:'/wallet'}, {section:'risk',path:'/risk'}], async (path, section) => {
    calls.push(path);
    if (section === 'status') attempt++;
    if (section === 'risk' && attempt === 1) throw Object.assign(new Error('transient'), {status});
    return {section, snapshot_id:`boot:${attempt}`,generated_at_ms:attempt};
  }, async delay => waits.push(delay));
  assert.deepEqual(reads.map(read => read.snapshot_id), ['boot:2','boot:2','boot:2']);
  assert.deepEqual(calls, ['/status','/wallet?snapshot_id=boot%3A1','/risk?snapshot_id=boot%3A1','/status','/wallet?snapshot_id=boot%3A2','/risk?snapshot_id=boot%3A2']);
  assert.deepEqual(waits, status === 503 ? [200] : []);
});

test('paper retries stop at two whole attempts and never retry auth/schema failures', async () => {
  for (const status of [409,503,401,502]) {
    let calls = 0;
    await assert.rejects(policy.paperCoherentRead('/status', [], async () => {calls++;throw Object.assign(new Error('unavailable'), {status});}, async () => {}), /unavailable/);
    assert.equal(calls, [409,503].includes(status) ? 2 : 1);
  }
});

test('paper read refuses cross-snapshot success with bounded parallel owner reads', async () => {
  let active=0, maximum=0;
  await assert.rejects(policy.paperCoherentRead('/status', [{section:'wallet',path:'/wallet'},{section:'risk',path:'/risk'}], async (_,section) => {
    active++;maximum=Math.max(maximum,active);await Promise.resolve();active--;
    return {section,snapshot_id:section==='risk'?'other:2':'boot:1',generated_at_ms:1};
  }), /Mixed owner snapshots/);
  assert.equal(maximum,2);
});

test('unavailable Settings identity confines fresh times and reasons to heartbeat rows', () => {
  const profile = { readiness: { paper_owner: { mode:'PAPER', bot_name:'meridian_v5_paper', state:'FRESH', generated_at:1793357640, reason:'PAPER_STATUS_FRESH' } } };
  const {load} = frontendModules({
    '@tanstack/react-query': { useQuery: () => ({data:profile}) },
    './api': {v5Api:{}},
    './usePaperObservation': {usePaperObservation: () => ({summary:{label:'Unavailable',reason:'Identity owner read unavailable'},isError:true,error:new Error('Identity owner read unavailable')})},
    'react-markdown': {},
  }, {'v5/V5Pages.tsx':['PaperIdentity']});
  const html = renderToStaticMarkup(React.createElement(load('v5/V5Pages.tsx').PaperIdentity));
  assert.match(html, /Paper owner reads<\/span><strong>Unavailable/);
  assert.match(html, /Heartbeat as of/);
  assert.match(html, /Heartbeat reason<\/span><strong>Paper process heartbeat is current; owner read health is separate/);
  assert.doesNotMatch(html, /PAPER_STATUS_FRESH|Source as of|Owner reason/);
  const withoutHeartbeatRows = html.replace(/<div class="v5-data-value"><span>(?:Process heartbeat|Heartbeat[^<]*)<\/span>.*?<\/div>/g, '');
  assert.doesNotMatch(withoutHeartbeatRows, /\bfresh\b|as of/i);
});

test('paper routes select native read-only exports, not live fleet discovery', () => {
  assert.deepEqual(policy.paperWorkspaceReads('capital'), {presentation:'paper',paperReadUrl:'/api/v1/servers/rsibot-v5/account-balances',paperHistoryReadUrl:'/api/v1/servers/rsibot-v5/controller-performance/history',paperAccountingReadUrl:'/api/v1/servers/rsibot-v5/fleet/accounting'});
  assert.deepEqual(policy.paperWorkspaceReads('operations'), {presentation:'paper',paperReadUrl:'/api/v1/operations/workspace'});
  assert.deepEqual(policy.paperWorkspaceReads('tradepad'), {presentation:'paper'});
});

test('heartbeat cannot label missing, invalid or incoherent paper reads fresh', () => {
  assert.equal(policy.paperObservationSummary([], 'paper', Date.now()).label,'Unavailable');
  const now=1793275200000;
  const reads=['status','wallet','positions','executors','risk'].map(section=>({schema:'rsibot.v5-paper.read.v1',section,bot_id:'paper',execution_mode:'paper',simulated:true,state:'available',completeness:'complete',snapshot_id:'boot:1',generated_at_ms:now,reason:null,read_at_ms:now,observed_at_ms:now,source_at_ms:now,capabilities:[],source:{},data:['positions','executors'].includes(section)?[]:{}}));
  assert.equal(policy.paperObservationSummary(reads,'paper',now).label,'Available');
  for (const change of [{snapshot_id:'boot:2'},{state:'degraded',reason:'Owner export unavailable',data:null},{reason:{}},{completeness:'partial'}]) assert.notEqual(policy.paperObservationSummary(reads.map(read=>read.section==='risk'?{...read,...change}:read),'paper',now).label,'Available');
  assert.equal(policy.paperObservationSummary(reads,'paper',now+31000).label,'Stale');
});

test('configured paper identity separates simulated execution from advisor authority', () => {
  assert.equal(paperWorkspaceLabel({readiness:{paper_owner:{mode:'PAPER'}}}), 'PAPER · simulated wallet · live disabled · advisor reports only');
  assert.equal(paperWorkspaceLabel(undefined), null);
});

test('paper uptime cannot clear program P0s or economic support', () => {
  const readiness = paperReadiness({ready:true, state:'FRESH'});
  assert.equal(readiness.production, 'NOT_READY');
  assert.equal(readiness.live, 'DISABLED');
  assert.equal(readiness.economics, 'V5_NOT_SUPPORTED');
  assert.ok(readiness.openGates.length > 0);
  assert.equal(readiness.gates.filter(gate => gate.priority === 'P0').length, 4);
  assert.ok(readiness.gates.every(gate => gate.status === 'NOT_RUN' && gate.evidence === null));
});
