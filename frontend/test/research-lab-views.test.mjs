import test from 'node:test';
import assert from 'node:assert/strict';
import { envelope, renderResearch, selectedIdeaQueries } from './helpers/research-render.mjs';

const network = { revision: 'fixture-revision', total_nodes: 2, total_edges: 1, unresolved_edges: 0,
  nodes: [['idea:a', 'idea', 'Idea A', 'RSI', 'SPOT'], ['source:b', 'source', 'Source B', 'RSI', 'SPOT']], edges: [[0, 1, 'derived_from', 'RECORDED']],
  stats: { kinds: [{ key: 'idea', count: 1 }, { key: 'source', count: 1 }], relations: [{ key: 'derived_from', count: 1 }], families: [{ key: 'RSI', count: 2 }], lanes: [{ key: 'SPOT', count: 2 }] },
};
function queries() {
  return { ...selectedIdeaQueries(), 'research-network': { data: { network: envelope(network) } }, 'research-queue-preview': { data: envelope({ items: [], total: 0 }) } };
}
test('all nine destinations are actionable and route to their dedicated source query', () => {
  const expected = { overview: 'research-network', ideas: 'research-lab-records', graph: 'research-network', papers: 'research-lab-records', experiments: 'research-lab-records', queue: 'research-lab-records', learning: 'research-lab-records', gaps: 'research-lab-records', archive: 'research-archive' };
  for (const [view, key] of Object.entries(expected)) {
    const result = renderResearch(queries(), { search: `view=${view}` });
    assert.match(result.html, /aria-label="Research Lab views"/);
    assert.equal(result.buttons.filter(button => button['aria-current'] === 'page').length >= 1, true);
    assert.ok(result.requests.some(request => request.queryKey[0] === key), `${view} must query ${key}`);
    if (view === 'ideas' || view === 'papers' || view === 'experiments') assert.equal(result.requests.find(request => request.queryKey[0] === key).queryKey[3], { ideas: 'idea', papers: 'paper', experiments: 'experiment' }[view]);
    if (view === 'queue' || view === 'learning' || view === 'gaps') assert.equal(result.requests.find(request => request.queryKey[0] === key).queryKey[2], { queue: 'queue', learning: 'learning', gaps: 'unresolved' }[view]);
  }
});
test('overview includes full composition, connections, family/lane drilldowns, queue and limitations', () => {
  const result = renderResearch(queries(), { search: 'view=overview' });
  for (const label of ['Research composition', 'Connection types', 'Research families', 'Accounting lanes', 'Next evidence checks', 'Reading this research', 'Pending events']) assert.ok(result.html.includes(label));
  const family = result.buttons.find(button => button.text === 'RSI'); family.onClick();
  const params = new URLSearchParams(result.searchUpdates.at(-1));
  assert.equal(params.get('view'), 'ideas'); assert.equal(params.get('family'), 'RSI');
  const request = result.requests.find(request => request.queryKey[0] === 'research-network');
  assert.deepEqual(request.queryKey, ['research-network', 'fixture', 'fixture-revision']);
  assert.equal(request.staleTime, Infinity); assert.equal(request.refetchInterval, undefined);
});
test('old network revision is not shown beside a new overview revision', () => {
  const values = queries(); values['research-network'].data.network.data = { ...network, revision: 'old-revision' };
  const result = renderResearch(values, { search: 'view=graph' });
  assert.doesNotMatch(result.html, /Research composition/); assert.match(result.html, /Loading research records/);
});
test('research loop exposes semantic objective and retains exact source selection', () => {
  const values = queries(); values['research-lab-records'].data = envelope({ total: 1, items: [{ id: 'decision:supervisor', kind: 'decision', title: 'Supervisor', data: { mandate: { objective: 'Qualification with unchanged baseline' } } }] });
  const result = renderResearch(values, { search: 'view=learning' });
  assert.match(result.html, /Qualification with unchanged baseline/);
});
test('gap rows keep file-only source references visible without guessing an archive or node destination', () => {
  const values = queries(); values['research-lab-records'].data = envelope({ total: 1, items: [{ id: 'gap:one', kind: 'recorded_gap', reason: 'Missing extraction', title: 'Source receipt', node_id: null, provenance: { record_id: 'source:unresolved', path: 'preserved/source.json' }, reference: 'artifact:missing', document_scope: 'receipt', document_id: 'gap:gap:one', documents: [{ ref: 'native-source', label: 'Frozen source JSON', available: true, media_type: 'application/json' }] }] });
  const result = renderResearch(values, { search: 'view=gaps' });
  assert.match(result.html, /Missing extraction|Source receipt/); assert.match(result.html, /Frozen source JSON/);
  assert.ok(!result.buttons.some(button => button.text === 'Source receipt' || button.text === 'source:unresolved'));
});
