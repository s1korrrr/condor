import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { frontendModules } from './helpers/frontend-module.mjs';
import { marketPictureHealth, marketSourceLabel } from '../src/features/market-picture/health.mjs';
import { canonicalVerdictHistoryFault, marketVerdict } from '../src/features/market-picture/pulse.mjs';

const snapshot = 'a'.repeat(64);
test('non-current observations never produce a healthy footer', () => {
  for (const freshness of ['FUTURE', 'STALE', 'LAGGING', 'UNKNOWN']) {
    assert.equal(marketPictureHealth({}, null, freshness).footerTone, 'warning', freshness);
  }
  assert.equal(marketPictureHealth({}, null, 'FRESH').footerTone, 'healthy');
});
const canonicalCutoff = 21_600_000;
const canonicalSnapshot = 'a'.repeat(64);
const canonicalMembership = 'b'.repeat(64), canonicalDefinitions = 'c'.repeat(64);
const plainFrame = () => ({snapshot_id:canonicalSnapshot,stream_id:'stream',cutoff_ms:canonicalCutoff,available_at_ms:canonicalCutoff,expected:300,definition_registry_hash:canonicalDefinitions,universe:{membership_hash:canonicalMembership}});
const zeroBreadth = () => Object.fromEntries(['1','5','15','60','240','1440'].map(h=>[h,{pressure:0}]));
const canonicalPoints = (omitIndex = -1) => Array.from({length:360}, (_, i) => i)
  .filter(i => i !== omitIndex)
  .map(i => ({time:canonicalCutoff - (360-i)*60_000,snapshot_id:(i+1).toString(16).padStart(64,'0'),gapBefore:false,membership:canonicalMembership,definitionRegistryHash:canonicalDefinitions,breadth:zeroBreadth()}));
const canonicalBody = (items = canonicalPoints()) => ({schema_version:'market-picture.v1',projection:'canonical_state',snapshot_id:canonicalSnapshot,stream_id:'stream',window:'6h',resolution:'1m',items:items.map(point=>({cutoff_ms:point.time,available_at_ms:point.time,snapshot_id:point.snapshot_id,source_kind:'observed',membership_hash:point.membership,definition_registry_hash:point.definitionRegistryHash,gap_before:point.gapBefore,coverage:{valid_instruments:300,expected_instruments:300},breadth:Object.fromEntries(Object.entries(point.breadth ?? zeroBreadth()).map(([h,value])=>[h,{pressure:value.pressure===null?null:String(value.pressure)}]))})),next_cursor:null,read_at_ms:canonicalCutoff});
function sourceHarness(responses, canonicalResponse = null) {
  const calls = [];
  let historyReads = 0;
  const api = {getMarketPicture: async (...args) => {
    calls.push(args);
    if (args[1] === 'history' && ++historyReads > 1)
      return canonicalResponse ?? response(canonicalBody());
    return responses.shift();
  }};
  const stored = {pinned() {}, projectHistory: body => body.items, projectCorrelations: body => body.items, projectEvents: body => body.items};
  const modules = frontendModules({'@/lib/api': {api}, './stored.mjs': stored,
    './contract.mjs': {
      validateFrame: async frame => frame,
      projectFrame: raw => ({snapshot_id: raw.snapshot_id ?? snapshot, stream_id:raw.stream_id ?? 'stream', cutoff_ms:raw.cutoff_ms ?? canonicalCutoff, available_at_ms:raw.available_at_ms ?? canonicalCutoff, expected:raw.expected ?? 300, membershipHash:raw.universe?.membership_hash ?? canonicalMembership, raw, microstructure:null, sourceCapabilities:[]}),
      projectMicrostructureResponse: async body => {
        if (body.invalid) throw new Error('Companion digest mismatch');
        return {microstructure:body.microstructure,sourceCapabilities:body.capabilities,flow:{status:'available',reasons:[]}};
      },
    }});
  return {...modules.load('features/market-picture/source.ts'), calls};
}
const response = body => new Response(JSON.stringify(body), {headers: {'Content-Type':'application/json'}});
const previous = faults => ({frame:{snapshot_id:snapshot,stream_id:'stream',cutoff_ms:canonicalCutoff,available_at_ms:canonicalCutoff,expected:300,membershipHash:canonicalMembership,raw:{snapshot_id:snapshot,stream_id:'stream',expected:300,definition_registry_hash:canonicalDefinitions,universe:{membership_hash:canonicalMembership}}},etag:'"a"',history:[],canonicalHistory:canonicalPoints(),canonicalHistoryFault:null,events:[],correlations:[],eventCursor:null,components:{},faults});

test('ETag revalidation keeps a complete immutable bundle without extra reads', async () => {
  const h = sourceHarness([new Response(null,{status:304})]), prior = previous({});
  assert.equal(await h.fetchBundle('v2','24h','BTC',new AbortController().signal,prior),prior);
  assert.equal(h.calls.length,1);
});
test('304 retries when the prior frame has no qualified canonical state history', async () => {
  const prior={...previous({}),canonicalHistory:null,canonicalHistoryFault:null};
  const h=sourceHarness([new Response(null,{status:304}),...ordinaryReads()]);
  const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal,prior);
  assert.notEqual(result,prior);
  assert.equal(h.calls.filter(call=>call[1]==='history').length,2);
  assert.equal(result.canonicalHistory.length,360);
  assert.equal(result.canonicalHistoryFault,null);
});
test('an unchanged frame retries failed stored components after a transient outage', async () => {
  const h=sourceHarness([new Response(null,{status:304}), ...['history','correlations','events'].map(path=>response({items:[path],next_cursor:null}))]);
  const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal,previous({history:'temporary outage'}));
  assert.deepEqual(result.faults,{});
  assert.deepEqual(result.history,['history']);
  assert.equal(h.calls.length,5);
  assert.ok(h.calls.slice(1).every(call=>call[2].snapshot_id===snapshot));
});
test('oversized response streams and non-JSON failures remain observable', async () => {
  const h=sourceHarness([]);
  await assert.rejects(h.boundedJson(new Response('x'.repeat(2*1024*1024+1))),/large/);
  await assert.rejects(h.boundedJson(new Response('<html>',{status:502})));
});

test('FastAPI string detail on a failed stored read preserves a safe status error', async () => {
  const h=sourceHarness([]);
  const error = await h.boundedJson(new Response(JSON.stringify({detail:'Market Picture source returned an error'}),{status:502}))
    .then(() => null, failure => failure);
  assert.match(error.message,/Observation source unavailable \(502\)/);
  assert.equal(error.status,502);
  assert.doesNotMatch(error.message,/Market Picture source returned an error/);
});

test('a partial outage retains validated components only from the same immutable frame', async () => {
  const h=sourceHarness([new Response(null,{status:304}),new Response('{}',{status:503}),response({items:[]}),response({items:[],next_cursor:null})]);
  const prior={...previous({events:'temporary'}),history:[{time:123}],components:{history:{items:[{time:123}]}}};
  const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal,prior);
  assert.deepEqual(result.history,[{time:123}]);
  assert.deepEqual(result.components.history,prior.components.history);
  assert.match(result.faults.history,/unavailable/);
});

test('304 plus failed stored read keeps retained values but reports degraded page health', async () => {
  const h=sourceHarness([new Response(null,{status:304}),new Response('{}',{status:503}),response({items:[]}),response({items:[],next_cursor:null})]);
  const retainedHistory=[{time:123}], prior={...previous({history:'temporary'}),history:retainedHistory,components:{history:{items:retainedHistory}}};
  const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal,prior);
  const health=marketPictureHealth(result.faults,null,'FRESH');
  assert.equal(result.frame,prior.frame);
  assert.equal(result.history,retainedHistory);
  assert.deepEqual(health.components,['history']);
  assert.equal(health.degraded,true);
  assert.equal(health.freshness,'DEGRADED');
  assert.equal(marketSourceLabel({mode:'LIVE',freshness:health.freshness,valid:240,loading:false}),'DEGRADED');
  assert.equal(health.footerTone,'warning');
  assert.notEqual(marketSourceLabel({mode:'LIVE',freshness:health.freshness,valid:240,loading:false}),'LIVE');
  assert.match(health.notice,/Retained values remain bound to the same validated frame/);
  assert.equal(marketPictureHealth({},null,'FRESH').freshness,'FRESH');
});

const ordinaryReads = () => [response({items:[]}),response({items:[]}),response({items:[],next_cursor:null})];
const companionFrame = () => ({...plainFrame(),snapshot_id:snapshot,microstructure_ref:{status:'available'}});
test('a referenced companion is projected and exported separately from the sealed raw frame', async () => {
  const body={microstructure:{componentId:'sealed'},capabilities:[{sourceId:'qualified'}]};
  const h=sourceHarness([response(companionFrame()),...ordinaryReads(),response(body)]);
  const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal);
  assert.equal(result.frame.microstructure.componentId,'sealed');
  assert.deepEqual(result.frame.sourceCapabilities,body.capabilities);
  assert.deepEqual(result.components.microstructure,body);
  assert.equal(result.frame.raw.microstructure,undefined);
  const companionCall=h.calls.find(call=>call[1]==='microstructure');
  assert.equal(companionCall[2].snapshot_id,snapshot);
  assert.deepEqual(result.faults,{});
});

test('a failed companion does not inherit data from a different snapshot and recovers after 304', async () => {
  const h=sourceHarness([response(companionFrame()),...ordinaryReads(),response({invalid:true})]);
  const prior={...previous({}),frame:{...plainFrame(),snapshot_id:'b'.repeat(64),raw:{...plainFrame(),snapshot_id:'b'.repeat(64)},microstructure:{componentId:'old'}}};
  const failed=await h.fetchBundle('v2','24h','BTC',new AbortController().signal,prior);
  assert.equal(failed.frame.microstructure,null);
  assert.match(failed.faults.microstructure,/digest mismatch/);
  assert.equal(failed.components.microstructure,undefined);
  const retry=sourceHarness([new Response(null,{status:304}),...ordinaryReads(),response({microstructure:{componentId:'recovered'},capabilities:[]})]);
  const recovered=await retry.fetchBundle('v2','24h','BTC',new AbortController().signal,failed);
  assert.deepEqual(recovered.faults,{});
  assert.equal(recovered.frame.microstructure.componentId,'recovered');
  assert.equal(recovered.frame.raw,failed.frame.raw);
});

test('a same-frame companion failure retains validated values with explicit degraded health', async () => {
  const frame=companionFrame();
  const body={microstructure:{componentId:'retained'},capabilities:[]};
  const prior={...previous({microstructure:'temporary'}),frame:{...plainFrame(),snapshot_id:snapshot,raw:{...frame,...plainFrame()},...body},components:{microstructure:body}};
  const h=sourceHarness([new Response(null,{status:304}),...ordinaryReads(),new Response('{}',{status:503})]);
  const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal,prior);
  assert.equal(result.frame,prior.frame);
  assert.equal(result.frame.microstructure.componentId,'retained');
  assert.equal(result.components.microstructure,body);
  assert.match(result.faults.microstructure,/unavailable/);
  assert.equal(marketPictureHealth(result.faults,null,'FRESH').freshness,'DEGRADED');
});

test('canonical verdict history is a separate complete six-hour read for every non-6h chart window', async () => {
  const chartPoints=[{time:canonicalCutoff-1_000,chartOnly:true}];
  const h=sourceHarness([response(plainFrame()),response({items:chartPoints}),response({items:[]}),response({items:[],next_cursor:null})]);
  const result=await h.fetchBundle('v2','7d','BTC',new AbortController().signal);
  const historyCalls=h.calls.filter(call=>call[1]==='history');
  assert.deepEqual(historyCalls.map(call=>call[2].window),['7d','6h']);
  assert.deepEqual(historyCalls[1][2],{snapshot_id:canonicalSnapshot,window:'6h',limit:'1500',resolution:'1m',projection:'canonical_state'});
  assert.deepEqual(result.history,chartPoints);
  assert.equal(result.canonicalHistory.length,360);
  assert.equal(result.canonicalHistoryFault,null);
  assert.deepEqual(result.faults,{});
});

test('a failed canonical history read is unavailable and never falls back to chart samples', async () => {
  const chartPoints=[{time:canonicalCutoff-1_000,chartOnly:true}];
  const h=sourceHarness([response(plainFrame()),response({items:chartPoints}),response({items:[]}),response({items:[],next_cursor:null})],new Response('{}',{status:503}));
  const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal);
  assert.deepEqual(result.history,chartPoints);
  assert.equal(result.canonicalHistory,null);
  assert.match(result.canonicalHistoryFault,/unavailable/);
  assert.ok(result.faults.canonical_history);
});

test('an incomplete canonical six-hour timeline is unavailable even when chart history is present', async () => {
  const chartPoints=[{time:canonicalCutoff-1_000,chartOnly:true}];
  const h=sourceHarness([response(plainFrame()),response({items:chartPoints}),response({items:[]}),response({items:[],next_cursor:null})],response(canonicalBody(canonicalPoints(90))));
  const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal);
  assert.deepEqual(result.history,chartPoints);
  assert.equal(result.canonicalHistory,null);
  assert.match(result.canonicalHistoryFault,/coverage|gap|complete/i);
});

test('canonical history rejects future receipts, gaps and cohort or definition changes without poisoning chart data', async () => {
  const chartPoints=[{time:canonicalCutoff-1_000,chartOnly:true}];
  const mutations=[
    ['future row receipt',row=>{row.available_at_ms=canonicalCutoff+1;}],
    ['stored gap',row=>{row.gap_before=true;}],
    ['membership change',row=>{row.membership_hash='d'.repeat(64);}],
    ['definition change',row=>{row.definition_registry_hash='d'.repeat(64);}],
  ];
  for (const [label,mutate] of mutations) {
    const body=canonicalBody();
    mutate(body.items[0]);
    const h=sourceHarness([response(plainFrame()),response({items:chartPoints}),response({items:[]}),response({items:[],next_cursor:null})],response(body));
    const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal);
    assert.deepEqual(result.history,chartPoints,label);
    assert.equal(result.canonicalHistory,null,label);
    assert.ok(result.faults.canonical_history,label);
    assert.deepEqual(Object.keys(result.faults),['canonical_history'],label);
  }
});

test('the canonical projection remains independent when the chart itself is set to six hours', async () => {
  const chartPoint={time:canonicalCutoff-30_000,chartOnly:true};
  const h=sourceHarness([response(plainFrame()),response({items:[chartPoint]}),response({items:[]}),response({items:[],next_cursor:null})]);
  const result=await h.fetchBundle('v2','6h','BTC',new AbortController().signal);
  assert.equal(h.calls.filter(call=>call[1]==='history').length,2);
  assert.deepEqual(result.history,[chartPoint]);
  assert.equal(result.canonicalHistory.length,360);
  assert.notEqual(result.canonicalHistory,result.history);
  assert.equal(result.canonicalHistoryFault,null);
});

test('a retained same-cutoff history revision is excluded from replay and may keep its own identity', async () => {
  const currentPoint={time:canonicalCutoff,snapshot_id:'d'.repeat(64),gapBefore:false,membership:canonicalMembership,definitionRegistryHash:canonicalDefinitions,breadth:zeroBreadth()};
  const history=[...canonicalPoints(),currentPoint];
  const h=sourceHarness([response(plainFrame()),response({items:[]}),response({items:[]}),response({items:[],next_cursor:null})],response(canonicalBody(history)));
  const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal);
  assert.equal(result.canonicalHistory.length,361);
  assert.equal(result.canonicalHistoryFault,null);
  assert.equal(result.canonicalHistory.at(-1).snapshot_id,currentPoint.snapshot_id);
  assert.equal(canonicalVerdictHistoryFault(result.canonicalHistory,'15',canonicalCutoff),null);
  const frame={cutoff_ms:canonicalCutoff,expected:300,pressure:Object.fromEntries(['1','5','15','60','240','1440'].map(h=>[h,{value:0}])),breadth:{15:{advancing:100,declining:100,unchanged:100,valid:300}},distribution:{15:{mean:{value:null}}},summary:{}};
  const withoutCurrent=marketVerdict(frame,'15',{history:canonicalPoints(),smooth:true});
  const withCurrent=marketVerdict(frame,'15',{history:result.canonicalHistory,smooth:true});
  assert.equal(withCurrent.state,withoutCurrent.state);
  assert.equal(withCurrent.score,withoutCurrent.score);
});

test('same frame and horizon keep one verdict across dense and sparse chart windows', async () => {
  const horizons=['1','5','15','60','240','1440'];
  const point=(time,pressure)=>({time,snapshot_id:(Math.floor(time/60_000)+1).toString(16).padStart(64,'0'),gapBefore:false,membership:canonicalMembership,definitionRegistryHash:canonicalDefinitions,breadth:Object.fromEntries(horizons.map(h=>[h,{pressure}]))});
  const cutoff=canonicalCutoff;
  const dense=Array.from({length:360},(_,i)=>point(cutoff-(360-i)*60_000,i>=346?-3:0));
  const sparse=[point(cutoff-20*60_000,0),point(cutoff-12*60_000,-3),point(cutoff-5*60_000,3)];
  const frame={cutoff_ms:cutoff,expected:300,pressure:Object.fromEntries(horizons.map(h=>[h,{value:3}])),breadth:{15:{advancing:200,declining:50,unchanged:50,valid:300}},distribution:{15:{mean:{value:null}}},summary:{}};
  const originalDense=marketVerdict(frame,'15',{history:dense,smooth:true});
  const originalSparse=marketVerdict(frame,'15',{history:sparse,smooth:true});
  assert.notEqual(originalDense.state,originalSparse.state,'the selected-window inputs reproduce the original T22 state flip');
  const denseFetch=sourceHarness([response(plainFrame()),response({items:dense}),response({items:[]}),response({items:[],next_cursor:null})],response(canonicalBody(dense)));
  const sparseFetch=sourceHarness([response(plainFrame()),response({items:sparse}),response({items:[]}),response({items:[],next_cursor:null})],response(canonicalBody(dense)));
  const denseBundle=await denseFetch.fetchBundle('v2','24h','BTC',new AbortController().signal);
  const sparseBundle=await sparseFetch.fetchBundle('v2','7d','BTC',new AbortController().signal);
  const canonicalDense=marketVerdict(frame,'15',{history:denseBundle.canonicalHistory,smooth:true});
  const canonicalSparse=marketVerdict(frame,'15',{history:sparseBundle.canonicalHistory,smooth:true});
  assert.equal(canonicalDense.state,canonicalSparse.state);
  assert.equal(canonicalDense.score,canonicalSparse.score);
});

test('partial component faults are projected as degraded operator state', () => {
  // Merged from fork/main (#39): the page now derives this state through marketPictureHealth,
  // whose behaviour the tests above cover; the wiring and the DEGRADED style must stay in place.
  const page=fs.readFileSync(new URL('../src/features/market-picture/MarketPicture.tsx',import.meta.url),'utf8');
  const css=fs.readFileSync(new URL('../src/features/market-picture/market-picture.css',import.meta.url),'utf8');
  assert.match(page,/marketPictureHealth\(data\?\.faults, source\.error, state\.freshness\)/);
  assert.match(page,/degraded=\{health\.degraded\}/);
  assert.match(page,/health\.footerTone === "warning" \? "mp-warning" : "mp-up"/);
  assert.match(css,/data-freshness="DEGRADED"/);
});
