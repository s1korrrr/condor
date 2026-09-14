import test from 'node:test';
import assert from 'node:assert/strict';
import { LAB_VIEWS, readLabState, updateLabParams, clearLabServerSelection, labContext } from '../src/features/research/lab-state.ts';

test('all nine destinations and filter/page/selection deep links are represented in URL state', () => {
  assert.deepEqual(LAB_VIEWS.map(view => view.id), ['overview', 'ideas', 'graph', 'papers', 'experiments', 'queue', 'learning', 'gaps', 'archive']);
  const params = new URLSearchParams('view=experiments&q=RSI&family=ok_rsi&lane=SPOT&offset=10020&id=experiment%3Aone&network_kind=idea');
  const state = readLabState(params);
  assert.equal(state.view, 'experiments'); assert.equal(state.offset, 10020); assert.equal(state.selected, 'experiment:one');
  const filtered = updateLabParams(params, { lane: 'FUTURES' }, { resetPage: true, clearSelection: true });
  assert.equal(filtered.get('id'), null); assert.equal(filtered.get('offset'), null); assert.equal(filtered.get('q'), 'RSI');
  assert.equal(readLabState(params).selected, 'experiment:one');
});

test('server changes clear graph and archive identities without overwriting unrelated query parameters', () => {
  const next = clearLabServerSelection(new URLSearchParams('view=archive&id=node-a&archive_record=record-a&archive_path=source-a&network_focus=node-a&offset=20&q=research&other=kept'));
  assert.equal(next.get('id'), null); assert.equal(next.get('archive_record'), null); assert.equal(next.get('archive_path'), null);
  assert.equal(next.get('network_focus'), null); assert.equal(next.get('offset'), null); assert.equal(next.get('other'), 'kept');
});

test('research-loop rows expose semantic statement, rationale and supervisor objective', () => {
  assert.equal(labContext({ data: { statement: 'Retained lesson', rationale: 'Another' } }), 'Retained lesson');
  assert.equal(labContext({ data: { mandate: { objective: 'Test a bounded hypothesis' } } }), 'Test a bounded hypothesis');
  assert.equal(labContext({ data: { rationale: 'Recorded outcome rationale' } }), 'Recorded outcome rationale');
});

test('topology validates URL values, roundtrips and survives server changes', () => {
  for (const value of ['', 'invalid']) assert.equal(readLabState(new URLSearchParams({network_topology:value})).network_topology, 'dependencies');
  for (const value of ['dependencies','linked','all']) {
    const params = updateLabParams(new URLSearchParams('id=one'), {network_topology:value});
    assert.equal(readLabState(params).network_topology, value);
    assert.equal(readLabState(clearLabServerSelection(params)).network_topology, value);
  }
});
