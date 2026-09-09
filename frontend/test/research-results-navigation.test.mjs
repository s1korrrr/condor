import test from 'node:test';
import assert from 'node:assert/strict';
import { renderResearchComponent } from './helpers/research-component-render.mjs';
const comparison = {
  id: 'assessment:recorded', label: 'Evaluation one', value: -0.123456789, unit: 'USDC', metric: 'net_pnl', baseline: 'frozen-owner', comparable_group: 'spot-contract',
  validity: 'VALID', attribution: 'ISOLATED', conditions: { capital_model: 'SPOT_UNLEVERAGED', venue: 'OKX' },
  source_refs: [{ node_id: 'evidence:one', title: 'Preserved fill evidence' }, 'report:one', { url: 'https://example.org/record', label: 'Original paper' }, { label: 'Frozen source', sha256: 'a'.repeat(64), path: '/private/source.json' }],
};
test('comparison preserves values and opens assessment and source node identities from recorded evidence', () => {
  const selected = [];
  const result = renderResearchComponent('ResearchResults', { data: {}, comparisons: { items: [comparison] }, onSelect: id => selected.push(id) }, {});
  const assessment = result.buttons.find(button => button.text.includes('Evaluation one'));
  assert.ok(assessment, 'Comparison assessment must be actionable'); assessment.onClick();
  result.buttons.find(button => button.text === 'Preserved fill evidence').onClick();
  result.buttons.find(button => button.text === 'report:one').onClick();
  assert.deepEqual(selected, ['assessment:recorded', 'evidence:one', 'report:one']);
  assert.match(result.html, /-0\.123456789/); assert.match(result.html, /USDC/);
  assert.match(result.html, /href="https:\/\/example.org\/record"/);
  assert.match(result.html, /Frozen source/); assert.match(result.html, /aaaaaaaaaaaaaaaa/);
  assert.ok(!result.buttons.some(button => button.text === 'Frozen source' || button.text === '/private/source.json'));
});
test('supporting-source controls reject unsafe URLs and remain read-only when no node navigation callback is supplied', () => {
  const unsafe = { ...comparison, source_refs: [{ url: 'javascript:alert(1)', label: 'Unsafe reference' }, { url: 'file:///private/source.json', label: 'Local reference' }] };
  const result = renderResearchComponent('ResearchResults', { data: {}, comparisons: { items: [unsafe] } }, {});
  assert.equal(result.buttons.length, 0);
  assert.doesNotMatch(result.html, /href="(?:javascript:|file:)/);
  assert.match(result.html, /Unsafe reference|Local reference/);
});

test('source limitations remain visible and nonplotted comparisons are counted without replacing their evidence', () => {
  const unavailable = { ...comparison, id: 'assessment:missing-baseline', baseline: '' };
  const limitation = 'Recorded groups use different execution contracts and must not be pooled.';
  const result = renderResearchComponent('ResearchResults', { data: {}, comparisons: { items: [comparison, unavailable], limitations: [limitation] } }, {});
  assert.match(result.html, /aria-label="Source comparison limitations"/);
  assert.ok(result.html.includes(limitation));
  assert.match(result.html, /1 comparison is not plotted because admissibility fields are incomplete or incompatible/);
  const empty = renderResearchComponent('ResearchResults', { data: {}, comparisons: { items: [unavailable], limitations: [limitation] } }, {});
  assert.match(empty.html, /No admissible isolated baseline comparison is recorded/);
  assert.match(empty.html, /1 comparison is not plotted/);
  assert.doesNotMatch(empty.html, /Delta against/);
});
