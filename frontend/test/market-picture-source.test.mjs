import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const snapshot = 'a'.repeat(64);
function sourceHarness(responses) {
  const calls = [];
  const api = {getMarketPicture: async (...args) => { calls.push(args); return responses.shift(); }};
  const stored = {pinned() {}, projectHistory: body => body.items, projectCorrelations: body => body.items, projectEvents: body => body.items};
  const modules = frontendModules({'@/lib/api': {api}, './stored.mjs': stored,
    './contract.mjs': {validateFrame: async frame => frame, projectFrame: raw => ({snapshot_id: snapshot, raw})}});
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

test('a partial outage retains validated components only from the same immutable frame', async () => {
  const h=sourceHarness([new Response(null,{status:304}),new Response('{}',{status:503}),response({items:[]}),response({items:[],next_cursor:null})]);
  const prior={...previous({events:'temporary'}),history:[{time:123}],components:{history:{items:[{time:123}]}}};
  const result=await h.fetchBundle('v2','24h','BTC',new AbortController().signal,prior);
  assert.deepEqual(result.history,[{time:123}]);
  assert.deepEqual(result.components.history,prior.components.history);
  assert.match(result.faults.history,/unavailable/);
});
