import test from 'node:test';
import assert from 'node:assert/strict';
import legacy from './fixtures/lab-network-owner.cjs';
import * as network from '../src/features/research/lab-network-engine.js';
import { parseLabNetwork, loadConsistentLabNetwork } from '../src/features/research/lab-network-data.ts';

function data(revision = 'revision-a') {
  return { revision, node_fields: ['id', 'kind', 'title', 'family', 'lane'], edge_fields: ['source', 'target', 'relation', 'basis'],
    nodes: [['a', 'idea', 'Alpha', 'RSI', 'SPOT'], ['b', 'experiment', 'Beta', 'RSI', 'SPOT'], ['c', 'run', 'Gamma', 'RSI', 'SPOT'], ['d', 'source', 'Delta', 'Other', 'FUTURES']],
    edges: [[0, 1, 'tested_by', 'RECORDED'], [1, 2, 'has_run', 'RECORDED']], total_nodes: 4, total_edges: 3, unresolved_edges: 1,
    stats: { kinds: [{ key: 'idea', count: 1 }, { key: 'experiment', count: 1 }, { key: 'run', count: 1 }, { key: 'source', count: 1 }],
      families: [{ key: 'RSI', count: 3 }, { key: 'Other', count: 1 }], lanes: [{ key: 'SPOT', count: 3 }, { key: 'FUTURES', count: 1 }], relations: [{ key: 'tested_by', count: 1 }, { key: 'has_run', count: 2 }] } };
}
const envelope = value => ({ data: value, source: { owner: 'research_os', server: 'native', read_only: true, fetched_at: '2026-09-09T12:00:00Z' } });

test('transferred topology algorithm preserves every node, edge and isolate with owner-identical placement', () => {
  for (const input of [data(), { ...data(), nodes: [...data().nodes, ['e', 'paper', 'Paper', 'Other', 'PROXY']], total_nodes: 5 }]) {
    const actual = network.layout(input), expected = legacy.layout(input);
    assert.deepEqual(actual, expected);
    assert.equal(actual.positions.length, input.nodes.length * 2);
    assert.ok(actual.isolates > 0);
  }
  const camera = { x: 8, y: 12, scale: 3 }, point = { x: 60, y: 90 }, size = { width: 300, height: 200 };
  assert.deepEqual(network.zoomAt(camera, 1.5, point, size), legacy.zoomAt(camera, 1.5, point, size));
  assert.deepEqual(network.worldPoint(point, camera, size), legacy.worldPoint(point, camera, size));
});

test('network boundary validates identities and completeness without sampling or reordering', () => {
  const value = data();
  assert.equal(parseLabNetwork(value), value);
  for (const corrupt of [v => v.nodes.pop(), v => v.edges[0][1] = 99, v => v.nodes[1][0] = 'a', v => v.total_edges++, v => v.node_fields.reverse()]) {
    const invalid = structuredClone(value); corrupt(invalid);
    assert.throws(() => parseLabNetwork(invalid), /network/i);
  }
});

test('network and overview reconcile one changed revision and reject a moving source', async () => {
  const calls = [];
  const read = async endpoint => { calls.push(endpoint); return envelope(endpoint === 'network' ? data('revision-b') : { revision: 'revision-b' }); };
  const result = await loadConsistentLabNetwork(read, 'native', 'revision-a', new AbortController().signal);
  assert.equal(result.network.data.revision, 'revision-b');
  assert.equal(result.overview.data.revision, 'revision-b');
  assert.deepEqual(calls, ['network', 'overview']);
  await assert.rejects(loadConsistentLabNetwork(async endpoint => envelope(endpoint === 'network' ? data('revision-b') : { revision: 'revision-c' }), 'native', 'revision-a', new AbortController().signal), /revision|changed/i);
});

test('an aborted request cannot publish a late network response even if its fetcher ignores cancellation', async () => {
  const controller = new AbortController();
  const read = async () => { controller.abort(); return envelope(data()); };
  await assert.rejects(loadConsistentLabNetwork(read, 'native', 'revision-a', controller.signal), { name: 'AbortError' });
});
