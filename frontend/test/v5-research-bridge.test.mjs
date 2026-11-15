import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { frontendModules } from './helpers/frontend-module.mjs';

const { readV5Research, researchOwnerFreshness } = frontendModules().load('features/research/v5-read.ts');
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

test('Research V5 adapts owner data for the existing reader without changing provenance', async () => {
  const payload = { revision: 'r1', generated_at: '2026-10-29T12:00:00Z', counts: {} };
  let requested;
  const read = readV5Research(async path => { requested = path; return new Response(JSON.stringify(payload)); });
  const result = await read('overview', 'rsibot-v5', {}, new AbortController().signal);
  assert.equal(requested, '/api/v1/research/overview?server=rsibot-v5');
  assert.deepEqual(result.data, payload);
  assert.equal(result.source.owner, 'research_os');
  assert.equal(result.source.server, 'rsibot-v5');
  assert.equal(result.source.read_only, true);
  assert.equal(result.source.generated_at, payload.generated_at);
  assert.equal(result.source.fetched_at, undefined);
});

test('owner deadline expires with the clock and is not renewed by a repeat', () => {
  const data = { generated_at: '2026-10-29T12:00:00Z', fresh_until: '2026-10-29T12:01:00Z' };
  assert.match(researchOwnerFreshness(data, Date.parse('2026-10-29T12:00:30Z')), /within owner/);
  assert.match(researchOwnerFreshness(data, Date.parse('2026-10-29T12:01:01Z')), /not current.*expired/);
  assert.match(researchOwnerFreshness({ ...data }, Date.parse('2026-10-29T12:02:00Z')), /not current.*expired/);
  assert.match(researchOwnerFreshness({ generated_at: data.generated_at }, Date.parse(data.fresh_until)), /freshness deadline not published/);
  const scan = { generated_at: data.generated_at, freshness: { state: 'CURRENT', freshness_basis: 'verified_event_scan', verification_checked_at: data.generated_at, max_verification_age_seconds: 60 } };
  assert.match(researchOwnerFreshness(scan, Date.parse('2026-10-29T12:01:01Z')), /not current.*expired/);
  assert.match(researchOwnerFreshness(scan, Date.parse('2026-10-29T11:59:59Z')), /freshness unknown.*owner clock ahead/);
  assert.match(researchOwnerFreshness({ fresh_until: data.fresh_until }, Date.parse(data.generated_at)), /freshness unknown.*not published/);
});

test('Research V5 reports upstream and malformed responses as not connected', async () => {
  const unavailable = readV5Research(async () => new Response(JSON.stringify({ detail: 'Not connected: upstream unreachable' }), { status: 503 }));
  await assert.rejects(unavailable('overview', 'rsibot-v5', {}, new AbortController().signal), /Not connected: upstream unreachable/);
  const malformed = readV5Research(async () => new Response('not json'));
  await assert.rejects(malformed('network', 'rsibot-v5', {}, new AbortController().signal), /Not connected:/);
});

test('Research statistics and limitations have labelled render bounds', () => {
  const { LabCharts, LabLimitations } = frontendModules({ './lab-network-engine': { colorFor: () => '#000' } }).load('features/research/ResearchOverview.tsx');
  const kinds = Array.from({ length: 101 }, (_, index) => ({ key: `kind-${index}`, count: 1 }));
  const html = renderToStaticMarkup(React.createElement(LabCharts, { data: { total_nodes: 101, stats: { kinds, relations: kinds } }, onFilter() {} }));
  assert.match(html, /first 100 of 101 kinds/);
  assert.match(html, /Top 10 of 101 recorded groups/);
  const limitations = renderToStaticMarkup(React.createElement(LabLimitations, { data: { limitations: Array.from({ length: 101 }, (_, index) => `limit-${index}`) } }));
  assert.match(limitations, /first 100 of 101 limitations/);
  assert.doesNotMatch(limitations, /limit-100/);
});

test('bounded network preserves coherent totals for the renderer', () => {
  const modules = frontendModules();
  const { boundedLabNetwork } = modules.load('features/research/lab-network-data.ts');
  const { layout } = modules.load('features/research/lab-network-engine.js');
  const nodes = Array.from({ length: 1001 }, (_, index) => [`n${index}`, '', '', '', '']);
  const input = { revision: 'r', nodes, edges: [[0, 1, '', ''], [0, 1000, '', '']], unresolved_edges: 3, total_nodes: 1001, total_edges: 5, stats: {} };
  const result = boundedLabNetwork(input);
  assert.equal(result.nodes.length, 1000);
  assert.equal(result.edges.length, 1);
  assert.equal(result.total_nodes, result.nodes.length);
  assert.equal(result.total_edges, result.edges.length + result.unresolved_edges);
  assert.doesNotThrow(() => layout(result));
  assert.equal(input.nodes.length, 1001);
});
