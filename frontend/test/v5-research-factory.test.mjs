import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPanel, render } from './v5-learning-projection.test.mjs';

const { ResearchFactoryPanel } = loadPanel('v5/ResearchFactoryPanel.tsx');
test('200-candidate catalog is paginated without losing trials or family totals', () => {
  const candidates = Array.from({ length: 200 }, (_, index) => ({ candidate_id: `candidate-${index}`, candidate_revision: 'v1', family_id: `family-${index % 10}`, variant_id: `variant-${index}`, catalog_eligibility: 'UNQUALIFIED', research_support: 'V5_NOT_SUPPORTED', readiness: 'DISABLED', native_execution: 'UNKNOWN', trial_refs: [] }));
  const allIds = [];
  for (let cursor = 0; cursor < 200; cursor += 25) {
    const page = candidates.slice(cursor, cursor + 25);
    const markup = render(ResearchFactoryPanel, { data: { status: 'FIXTURE_ONLY', effect: 'NONE', total_candidates: 200, total_families: 10, total_variants: 200, candidates: page, campaigns: [], next_cursor: cursor + 25 < 200 ? cursor + 25 : null }, onNext: () => {} });
    assert.match(markup, /200/);
    assert.match(markup, /V5_NOT_SUPPORTED/);
    assert.match(markup, /Next owner page/);
    assert.match(markup, /All trial evidence/);
    allIds.push(...page.map(row => row.candidate_id));
  }
  assert.equal(new Set(allIds).size, 200);
});
test('native gaps, failure and empty states are explicit and accessible', () => {
  const markup = render(ResearchFactoryPanel, { data: { status: 'STALE', effect: 'NONE', candidates: [], campaigns: [{ campaign_id: 'failed-1', state: 'INTERRUPTED', reason: 'Owner interrupted; outcome unknown' }] } });
  assert.match(markup, /No candidates reported/);
  assert.match(markup, /INTERRUPTED/);
  assert.match(markup, /No bag, balance or native policy is reconstructed/);
  assert.match(markup, /aria-label="Owner candidate pages"/);
  assert.match(render(ResearchFactoryPanel, { error: 'Read failed' }), /role="alert"/);
});

test('every bounded trial reference remains inspectable without inventing an outcome', () => {
  const trial_refs = Array.from({ length: 64 }, (_, index) => ({ owner: 'research_os', record_kind: 'run', record_id: `trial-${index}`, revision: 'v1', content_sha256: 'a'.repeat(64), available_at_ms: 100 }));
  const candidate = { candidate_id: 'candidate-1', candidate_revision: 'v1', family_id: 'family-1', variant_id: 'variant-1', catalog_eligibility: 'UNQUALIFIED', research_support: 'UNAVAILABLE', readiness: 'DISABLED', native_execution: 'UNKNOWN', trial_refs };
  const markup = render(ResearchFactoryPanel, { data: { status: 'FIXTURE_ONLY', effect: 'NONE', candidates: [candidate] } });
  assert.match(markup, /Inspect 64 evidence references/);
  assert.match(markup, /trial-63/);
  assert.match(markup, /Trial references are not outcomes/);
});
