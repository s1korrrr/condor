import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPanel, render } from './v5-learning-projection.test.mjs';

const { DecisionLineagePanel } = loadPanel('v5/DecisionLineagePanel.tsx');
test('lineage preserves pinned inputs, independent owner states and unknown execution', () => {
  const ref = { owner: 'research_os', record_kind: 'lesson_revision', record_id: 'lesson-1', revision: 'v1', content_sha256: 'a'.repeat(64), available_at_ms: 100 };
  const markup = render(DecisionLineagePanel, { data: { status: 'FIXTURE_ONLY', effect: 'NONE', lineage: [{ record_id: 'job-1', kind: 'agent_job', title: 'Decision critique', state: 'DISPATCH_UNKNOWN', available_at_ms: 200, payload_sha256: 'b'.repeat(64), parent_refs: [ref], evidence_refs: [], input_refs: [ref], identities: [{ label: 'usage', value: 'UNKNOWN' }, { label: 'release_id', value: 'release-1' }] }] } });
  assert.match(markup, /DISPATCH_UNKNOWN/);
  assert.match(markup, /lesson-1/);
  assert.match(markup, /release-1/);
  assert.match(markup, /interrupted UI session never replays/);
  assert.match(markup, /Native execution: unknown/);
  assert.match(markup, /aria-label="Full decision lineage"/);
  assert.match(markup, /Synthetic fixture clock/);
  assert.match(markup, /<code class="font-mono select-text">b{64}<\/code>/);
  assert.match(markup, /<details><summary>Inspect 1 evidence references<\/summary>/);
});
test('missing lineage is not reconstructed and error remains distinct from empty', () => {
  assert.match(render(DecisionLineagePanel, {}), /No decision lineage bound/);
  assert.match(render(DecisionLineagePanel, { error: 'Owner failure' }), /role="alert"/);
  assert.match(render(DecisionLineagePanel, { data: { status: 'STALE', effect: 'NONE' } }), /Stale owner snapshot/);
});

test('revised lifecycle and structured unknown usage stay explicit, including nonzero reservations', () => {
  const jobs = ['DISPATCH_UNKNOWN', 'OUTPUT_PENDING'].map((owner_state, index) => ({ job_id: `job-${index}`, attempt_id: 'attempt-1', owner_state, state_history: ['PROPOSED', 'ADMITTED', 'DISPATCH_UNKNOWN', ...(index ? ['OUTPUT_PENDING'] : [])], usage: { state: 'UNKNOWN', calls: null, input_tokens: null, output_tokens: null, duration_ms: null, money: null }, reservation: { max_calls: 2, duration_ms: 1000 }, replay_allowed: false }));
  const markup = render(DecisionLineagePanel, { data: { status: 'FIXTURE_ONLY', effect: 'NONE', jobs } });
  assert.match(markup, /DISPATCH_UNKNOWN/);
  assert.match(markup, /OUTPUT_PENDING/);
  assert.match(markup, /UNKNOWN/);
  assert.match(markup, /2 \/ 1000 ms/);
  assert.match(markup, /Unknown \/ Unknown \/ Unknown/);
  assert.doesNotMatch(markup, /\[object Object\]/);
});
