import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';
import { marketPictureHealth, marketSourceLabel } from '../src/features/market-picture/health.mjs';

const snapshot = 'a'.repeat(64);
test('non-current observations never produce a healthy footer', () => {
  for (const freshness of ['FUTURE', 'STALE', 'LAGGING', 'UNKNOWN']) {
    assert.equal(marketPictureHealth({}, null, freshness).footerTone, 'warning', freshness);
  }
  assert.equal(marketPictureHealth({}, null, 'FRESH').footerTone, 'healthy');
});
function sourceHarness(responses) {
  const calls = [];
  const api = {getMarketPicture: async (...args) => { calls.push(args); return responses.shift(); }};
  const stored = {pinned() {}, projectHistory: body => body.items, projectCorrelations: body => body.items, projectEvents: body => body.items};
  const modules = frontendModules({'@/lib/api': {api}, './stored.mjs': stored,
    './contract.mjs': {
      validateFrame: async frame => frame,
      projectFrame: raw => ({snapshot_id: raw.snapshot_id ?? snapshot, raw, microstructure:null, sourceCapabilities:[]}),
      projectMicrostructureResponse: async body => {
        if (body.invalid) throw new Error('Companion digest mismatch');
        return {microstructure:body.microstructure,sourceCapabilities:body.capabilities,flow:{status:'available',reasons:[]}};
      },
    }});
  return {...modules.load('features/market-picture/source.ts'), calls};
}
const response = body => new Response(JSON.stringify(body), {headers: {'Content-Type':'application/json'}});
const previous = faults => ({frame:{snapshot_id:snapshot,raw:{snapshot_id:snapshot}},etag:'"a"',history:[],events:[],correlations:[],eventCursor:null,components:{},faults});

test('ETag revalidation keeps a complete immutable bundle without extra reads', async () => {
  const h = sourceHarness([new Response(null,{status:304})]), prior = previous({});
  assert.equal(await h.fetchBundle('v2','24h','BTC',new AbortController().signal,prior),prior);
  assert.equal(h.calls.length,1);
});
test('an unchanged frame retries failed stored components after a transient outage', async () => {
  const h=sourceHarness([new Response(null,{status:304}), ...['history','correlations','events'].map(path=>response({items:[path],next_cursor:null}))]);
  const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal,previous({history:'temporary outage'}));
  assert.deepEqual(result.faults,{});
  assert.deepEqual(result.history,['history']);
  assert.equal(h.calls.length,4);
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
const companionFrame = () => ({snapshot_id:snapshot,microstructure_ref:{status:'available'}});
test('a referenced companion is projected and exported separately from the sealed raw frame', async () => {
  const body={microstructure:{componentId:'sealed'},capabilities:[{sourceId:'qualified'}]};
  const h=sourceHarness([response(companionFrame()),...ordinaryReads(),response(body)]);
  const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal);
  assert.equal(result.frame.microstructure.componentId,'sealed');
  assert.deepEqual(result.frame.sourceCapabilities,body.capabilities);
  assert.deepEqual(result.components.microstructure,body);
  assert.equal(result.frame.raw.microstructure,undefined);
  assert.equal(h.calls.at(-1)[1],'microstructure');
  assert.equal(h.calls.at(-1)[2].snapshot_id,snapshot);
  assert.deepEqual(result.faults,{});
});

test('a failed companion does not inherit data from a different snapshot and recovers after 304', async () => {
  const h=sourceHarness([response(companionFrame()),...ordinaryReads(),response({invalid:true})]);
  const prior={...previous({}),frame:{snapshot_id:'b'.repeat(64),raw:{snapshot_id:'b'.repeat(64)},microstructure:{componentId:'old'}}};
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
  const prior={...previous({microstructure:'temporary'}),frame:{snapshot_id:snapshot,raw:frame,...body},components:{microstructure:body}};
  const h=sourceHarness([new Response(null,{status:304}),...ordinaryReads(),new Response('{}',{status:503})]);
  const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal,prior);
  assert.equal(result.frame,prior.frame);
  assert.equal(result.frame.microstructure.componentId,'retained');
  assert.equal(result.components.microstructure,body);
  assert.match(result.faults.microstructure,/unavailable/);
  assert.equal(marketPictureHealth(result.faults,null,'FRESH').freshness,'DEGRADED');
});
