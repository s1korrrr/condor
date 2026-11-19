import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import * as ReactQuery from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { setImmediate } from 'node:timers/promises';
import { frontendModules, paperVisualStubs } from './helpers/frontend-module.mjs';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));
const sections = ['status','wallet','positions','fills','executors','risk','decisions','history','accounting'];
const owner = fixture('wallet');
const candleSymbols = {state:'AVAILABLE',reason:null,data:{rows:[]}};
const completeReads = () => sections.map(section => {
  const read = fixture(section);
  if (section === 'risk') read.data.control_hold = 'clock_anomaly';
  return read;
});
const stubs = {...Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}])), '@/features/quant-ops/kit/DataTable':{DataTable:() => null}};

function harness(kind, initial, money, countValidation) {
  const client = new ReactQuery.QueryClient();
  let cursor = 0, spec;
  const slots = [], requests = [];
  const query = { data:initial, isFetching:false, isPending:!initial, isError:false, error:null, refetch() {} };
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial === Date.now ? owner.read_at_ms : initial() : initial;
    return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
  };
  const {load} = frontendModules({...stubs, ...paperVisualStubs, '@/v5/usePaperClock':{usePaperClock:() => owner.read_at_ms}, react:{...React,useState,useRef:initial => useState(() => ({current:initial}))[0],useEffect() {}}, '@tanstack/react-query':{...ReactQuery,useQueryClient:() => client,useQuery:options => {
    if (options.queryKey[0] === 'v5-money') return {data:money,isError:false};
    if (options.enabled === false) return {isPending:true,isFetching:false,isError:false,refetch() {}};
    if (kind === 'bots' && options.queryKey[0] !== 'v5-paper-bots') return {data:undefined,isPending:false,isFetching:false,isError:true,refetch() {}};
    spec = options;
    const cached = client.getQueryCache().build(client, options);
    if (cached.state.data !== query.data) cached.setState({data:query.data});
    return query;
  }}}, {}, (filename, source) => {
    if (!countValidation || !filename.endsWith('/v5/policy.ts')) return source;
    const guard = 'if (!read || validatedSections.has(read)) return null;';
    assert.ok(source.includes(guard), 'instrument the full schema check after its cache guard');
    return source.replace(guard, `${guard}\n  exports.countValidation(read);`);
  });
  if (countValidation) load('v5/policy.ts').countValidation = countValidation;
  const component = kind === 'bots' ? load('pages/tabs/ActiveBotsTab.tsx').V5PaperBots : load('v5/usePaperObservation.ts').usePaperWorkspace;
  const render = () => {
    cursor = 0;
    return kind === 'bots' ? renderToStaticMarkup(component({bot:owner.bot_id,ownerState:'AVAILABLE',generatedAt:owner.generated_at_ms / 1000})) : component('capital',owner.bot_id);
  };
  const original = global.fetch;
  global.fetch = (url, options) => new Promise(resolve => {
    if (new URL(url,'https://fixture.invalid').pathname === '/api/v5/candle-store/symbols') {resolve({ok:true,json:async () => candleSymbols});return;}
    const path = new URL(url,'https://fixture.invalid').searchParams.get('path');
    const section = path.includes('/native/status') ? 'status' : path.includes('account-balances') || path.includes('fleet/summary') ? 'wallet' : path.includes('/history') ? 'history' : path.includes('/holdings') ? 'positions' : path.includes('/accounting') ? 'accounting' : sections.find(section => path.includes(section));
    requests.push({path,section,signal:options.signal,resolve});
  });
  function start() {
    render(); query.isFetching = true;
    const controller = new AbortController();
    const promise = spec.queryFn({signal:controller.signal});
    promise.catch(() => {});
    return {controller,promise};
  }
  async function deliver(request, mutate = read => read) {
    const {path, section} = request;
    const read = section === 'fills' && new URL(path,'https://fixture.invalid').searchParams.has('cursor') ? fixture('fills-offset-200') : fixture(section);
    const value = mutate(read);
    request.resolve({ok:true,json:async () => value,text:async () => JSON.stringify(value)});
    await setImmediate();
  }
  return {query,render,start,requests,deliver,remount:() => {slots.length = 0;},restore:() => {client.clear();global.fetch = original;}};
}

function clearRisk(read) {
  if (read.section !== 'risk') return read;
  read.data.control_hold = null;
  read.data.holds = [];
  read.data.native_entry_holds = [];
  for (const controller of Object.values(read.data.controllers)) {
    controller.operator.emergency = false;
    controller.operator.paused = false;
    controller.native.entry_hold = false;
  }
  return read;
}

for (const signal of ['emergency','paused','entry_hold','control_hold','native_refusal']) {
  for (const seeded of [false,true,'owner-clock-rollback']) test(`real hook retains received ${signal}: ${seeded || 'first load'} and late failure`, async () => {
    const initial = seeded ? completeReads().map(read => ({...clearRisk(read),generated_at_ms:read.generated_at_ms + (seeded === 'owner-clock-rollback' ? 5000 : 0)})) : undefined;
    const h = harness('bots', initial);
    const held = /New acquisitions held/;
    const update = read => {
      clearRisk(read);
      if (read.section === 'risk') {
        const controller = Object.values(read.data.controllers)[0];
        if (signal === 'control_hold') read.data.control_hold = 'clock_anomaly';
        else if (signal === 'native_refusal') read.data.native_entry_holds = [{controller_id:Object.keys(read.data.controllers)[0],reason:'native_refusal_receipt_pending',explanation:'Native entry refused',protected_exits:'preserved'}];
        else if (signal === 'entry_hold') controller.native.entry_hold = true;
        else controller.operator[signal] = true;
      }
      return read;
    };
    try {
      assert.doesNotMatch(h.render(), held);
      const pending = h.start();
      while (h.requests.length && !/New acquisitions held/.test(h.render())) await h.deliver(h.requests.shift(), update);
      assert.match(h.render(), held, 'signal must override a clear retained snapshot');
      if (signal === 'emergency') assert.match(h.render(), /Emergency halt reported|Reported emergency halt: Yes/);
      const failed = h.requests.shift();
      assert.ok(failed);
      failed.resolve({ok:false,status:502,json:async () => ({detail:'Later section failed'})});
      await setImmediate();
      while (h.requests.length) await h.deliver(h.requests.shift(), update);
      await assert.rejects(pending.promise);
      h.query.isFetching = false; h.query.isError = true; h.query.error = new Error('Later section failed');
      assert.match(h.render(), /Later section failed/);
      assert.match(h.render(), held, 'error must not erase a received signal');
      h.remount();
      assert.match(h.render(), held, 'signal must survive navigation while its query stays cached');
      h.query.isError = false;
      const retry = h.start();
      assert.match(h.render(), held, 'empty new-attempt progress must not clear safety evidence');
      const newer = read => ({...clearRisk(read),snapshot_id:'complete-newer',generated_at_ms:read.generated_at_ms + 10000,source:{...read.source,sequence:read.source.sequence + 1}});
      while (h.requests.length) await h.deliver(h.requests.shift(), newer);
      h.query.data = await retry.promise;
      h.query.isFetching = false;
      assert.doesNotMatch(h.render(), held, 'only a complete newer snapshot may clear the signal');
    } finally {h.restore();}
  });
}

test('Bots retains held complete snapshot, as-of and totals during refresh and failed refresh', () => {
  const reads = completeReads(), h = harness('bots',reads);
  try {
    const full = h.render(); h.query.isFetching = true;
    const mid = h.render();
    assert.match(mid,/New acquisitions held/);
    assert.match(mid,/Held by owner/);
    assert.match(mid,/Last coherent owner snapshot.*As of/);
    assert.match(mid,/Refreshing owner snapshot/);
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

test('Bots paints the cached Money sample while owner sections are unresolved', async () => {
  const at = owner.read_at_ms - 300_000;
  const money = {range:'7d', now_ms:owner.read_at_ms, rows:[
    {bot:'v5', at_ms:at - 300_000, unit:'USDC', equity:'123456.12', fees:'20.22'},
    {bot:'v5', at_ms:at, unit:'USDC', equity:'199093.60', initial_funding:'200000', external_flows:'0',
      realized:'114.14', unrealized:'-1020.54', fees:null},
  ]};
  const h = harness('bots', undefined, money);
  try {
    const html = h.render();
    assert.match(html, /Wallet equity[^]*?199,093\.60 USDC/);
    assert.match(html, /Money sample.*As of.*UTC/);
    assert.match(html, /Fees paid<\/dt><dd>—<\/dd>/, 'no borrowing from an older row for a missing value');
    assert.doesNotMatch(html, /123,456\.12|20\.22 USDC/);
    const pending = h.start();
    await h.deliver(h.requests.shift());
    while (h.requests.length && !h.render().includes('<h2>Holdings</h2>')) await h.deliver(h.requests.shift());
    assert.match(h.render(), /<h2>Holdings<\/h2>/, 'holdings render while other sections are pending');
    assert.match(h.render(), /199,093\.60 USDC/, 'the tiles keep the sampled source until snapshot commit');
    while (h.requests.length) await h.deliver(h.requests.shift());
    h.query.data = await pending.promise;
    h.query.isFetching = false;
    assert.doesNotMatch(h.render(), /199,093\.60 USDC|Money sample.*As of/);
  } finally {h.restore();}
});

test('Today keeps its Money value and provenance after the owner snapshot completes', async () => {
  const now = owner.read_at_ms;
  const day = Math.floor(now / 86_400_000) * 86_400_000;
  const money = {range:'7d', now_ms:now, rows:[{bot:'v5', unit:'USDC', at_ms:now, equity:'200777.25'}], daily:[{
    day, samples:2, valid:2, equity_valid:2, gaps:0, equity_first_at_ms:day, equity_last_at_ms:now,
    equity_start:'200000', equity_end:'200777.25', equity_change:'777.25',
  }]};
  const h = harness('bots', undefined, money);
  const today = () => h.render().match(/<dt>Today<\/dt>[^]*?<\/div>/)?.[0];
  try {
    const pending = h.start();
    assert.match(today(), /777\.25 USDC.*Money sample · As of .*Z ·/);
    while (h.requests.length) await h.deliver(h.requests.shift());
    h.query.data = await pending.promise;
    h.query.isFetching = false;
    assert.match(today(), /777\.25 USDC.*Money sample · As of .*Z ·/);
  } finally {h.restore();}
});

test('a newer healthy status with schema-invalid risk cannot clear a retained journal hold', async () => {
  const initial = completeReads();
  initial[0].reason = 'OWNER_JOURNAL_EXCEEDED';
  initial[0].data.journal_budget = {state:'exceeded', journal_evidence_held:true};
  const h = harness('bots', initial);
  const healthy = (read, sequence) => {
    if (read.section === 'status') {
      read.state = 'available';
      read.reason = null;
      Object.assign(read.data.operations, {state:'available', completeness:'complete', reason:null, stale_reason:null});
    }
    return {...read, snapshot_id:`review:${sequence}`, generated_at_ms:read.generated_at_ms + sequence, source:{...read.source, sequence:read.source.sequence + sequence}};
  };
  try {
    assert.match(h.render(), /Paper journal evidence held/);
    for (const [sequence, failRisk] of [[1,true], [2,false]]) {
      const pending = h.start();
      while (h.requests.length) {
        const request = h.requests.shift();
        if (failRisk && request.section === 'risk') {
          request.resolve({ok:false,status:502,json:async () => ({detail:{reason:'schema_invalid',section:'risk'}})});
          await setImmediate();
        } else await h.deliver(request, read => healthy(read, sequence));
      }
      h.query.data = await pending.promise;
      h.query.isFetching = false;
      if (failRisk) {
        assert.equal(h.query.data.find(read => read.section === 'risk').state, 'degraded');
        assert.match(h.render(), /Paper journal evidence held/);
      } else assert.doesNotMatch(h.render(), /Paper journal evidence held/);
    }
  } finally {h.restore();}
});

test('Bots attributes an executor count to its section when the rest of the load fails', async () => {
  const h = harness('bots');
  try {
    const pending = h.start();
    await h.deliver(h.requests.shift());
    const take = section => h.requests.splice(h.requests.findIndex(request => request.section === section), 1)[0];
    await h.deliver(take('wallet'));
    await h.deliver(take('executors'));
    take('risk').resolve({ok:false,status:502,json:async () => ({detail:'Risk read failed'})});
    await setImmediate();
    while (h.requests.length) {
      h.requests.shift().resolve({ok:false,status:502,json:async () => ({detail:'Read failed'})});
      await setImmediate();
    }
    await assert.rejects(pending.promise);
    h.query.isFetching = false;
    h.query.isError = true;
    h.query.error = new Error('Risk read failed');
    const html = h.render();
    assert.match(html, /Owner snapshot unavailable/);
    assert.match(html, /Open executors<\/dt><dd>8<\/dd><small[^>]*>Owner executor section · As of .*UTC/);
    assert.doesNotMatch(html, /Fresh complete owner snapshot/);
  } finally {h.restore();}
});

test('Bots validates each decoded section once and validates the assembled fills separately', async () => {
  const validations = new Map();
  const h = harness('bots', undefined, undefined, read => validations.set(read, (validations.get(read) ?? 0) + 1));
  try {
    const pending = h.start();
    let requests = 0;
    while (h.requests.length) {
      requests++;
      await h.deliver(h.requests.shift());
    }
    h.query.data = await pending.promise;
    h.render();
    assert.equal(requests, 10, 'the fixture has nine sections including two fills pages');
    assert.equal(validations.size, requests + 1, 'ten HTTP bodies and one assembled fills section');
    for (const [read, count] of validations) {
      assert.equal(count, 1, read.section);
      assert.ok(Object.isFrozen(read) && Object.isFrozen(read.data), `${read.section} is immutable after admission`);
    }
    const fills = h.query.data.find(read => read.section === 'fills');
    assert.ok(validations.has(fills));
    assert.ok(fills.data.length > 200, 'the admitted fills section contains both pages');
  } finally {h.restore();}
});

test('Bots first load reports pending risk and rails, never absent controls or numeric limits', () => {
  const h = harness('bots');
  try {
    h.query.isFetching = true;
    const html = h.render();
    assert.doesNotMatch(html,/Checking:|<li>.*Pending/);
    assert.match(html,/Risk rails<\/h2><p[^>]*>Reading owner section/);
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
    await h.deliver(h.requests.shift(), read => {
      assert.equal(read.section, 'wallet');
      read.data.assets.find(asset => asset.asset === read.data.quote_asset).available = '76543.21';
      return read;
    });
    const currentView = h.render();
    const progress = kind === 'bots' ? currentView : currentView.progress;
    if (kind === 'bots') {
      assert.match(currentView, /Available cash<\/dt><dd[^>]*>76,543\.21 USDC<\/dd>/, 'the active attempt supplied this wallet value');
      assert.doesNotMatch(currentView,/Not connected|No owner limit or latch observation|Numeric rail limits are not published/);
    } else {
      assert.match(progress,/2\/4 sections/);
      assert.equal(currentView.complete,false);
    }
    await h.deliver(oldRequest);
    const after = h.render();
    assert.equal(kind === 'bots' ? after : after.progress,progress);
    assert.equal(oldRequest.signal.aborted,true);
    while (h.requests.length) await h.deliver(h.requests.shift());
    await current.promise;
    await old.promise.catch(() => {});
  } finally {h.restore();}
});

// Live 2026-11-05 15:45Z (parent browser check): every paused controller was listed twice under "New acquisitions held".
// Expected rows come from the owner risk read: one row per controller the owner reports as held, whether the refresh
// redelivers the displayed snapshot (new objects) or delivers the next snapshot with the same holds.
const heldRows = (html, ids) => {
  const aside = html.match(/New acquisitions held[^]*?Received and retained safety evidence/)?.[0] ?? '';
  return Object.fromEntries(ids.map(id => [id, aside.split(`<h3>${id}</h3>`).length - 1]));
};
const sameContent = read => read.section === 'risk' ? {...read, data:{...read.data, control_hold:'clock_anomaly'}} : read;
const nextSnapshot = read => sameContent({...read, snapshot_id:'next:1', generated_at_ms:read.generated_at_ms + 1000, source:{...read.source, sequence:read.source.sequence + 1}});
for (const [label, mutate] of [['the displayed snapshot again', sameContent], ['the next snapshot with the same holds', nextSnapshot]]) {
  test(`a refresh delivering ${label} lists each held controller exactly once`, async () => {
    const reads = completeReads(), h = harness('bots', reads);
    try {
      const risk = reads.find(read => read.section === 'risk');
      const ids = Object.keys(risk.data.controllers);
      const held = ids.filter(id => { const row = risk.data.controllers[id]; return row.operator.paused === true || row.operator.emergency === true || row.native.latched === true || row.native.entry_hold === true; });
      assert.ok(held.length > 0, 'fixture has owner-held controllers');
      const pending = h.start();
      while (h.requests.length) await h.deliver(h.requests.shift(), mutate);
      await pending.promise.catch(() => {});
      assert.deepEqual(heldRows(h.render(), ids), Object.fromEntries(ids.map(id => [id, held.includes(id) ? 1 : 0])));
    } finally { h.restore(); }
  });
}

test('a newer snapshot that adds a hold signal keeps that evidence visible', async () => {
  // The recorded fixture holds every controller with paused + emergency. The displayed snapshot shows one controller
  // paused only; the next snapshot carries the owner's recorded emergency for it again (an added signal).
  const reads = completeReads();
  const risk = reads.find(read => read.section === 'risk');
  const id = Object.keys(risk.data.controllers)[0];
  assert.equal(risk.data.controllers[id].operator.emergency, true, 'fixture records the emergency halt');
  risk.data.controllers[id] = {...risk.data.controllers[id], operator:{...risk.data.controllers[id].operator, emergency:false}};
  const h = harness('bots', reads);
  try {
    const pending = h.start();
    while (h.requests.length) await h.deliver(h.requests.shift(), nextSnapshot);
    await pending.promise.catch(() => {});
    const aside = h.render().match(/New acquisitions held[^]*?Received and retained safety evidence/)?.[0] ?? '';
    assert.match(aside, new RegExp(`<h3>${id}</h3><span[^>]*>New entries held</span><p>Reported operator pause: Yes · Reported emergency halt: Yes`), 'the added emergency halt is shown for that controller');
  } finally { h.restore(); }
});
