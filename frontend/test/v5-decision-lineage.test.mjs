import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPanel, render } from './v5-learning-projection.test.mjs';

const { DecisionLineagePanel } = loadPanel('v5/DecisionLineagePanel.tsx');
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/v5-lfl/${name}.json`, import.meta.url), 'utf8'));

test('lineage renders only owner-recorded assertions and attempts', () => {
  const markup = render(DecisionLineagePanel, { nodes: fixture('records-nodes'), edges: fixture('records-edges'), attempts: fixture('jobs') });
  assert.match(markup, /Research lineage/);
  assert.match(markup, /Native-action lineage: not published/);
  assert.match(markup, /attempt_of.*EXPLICIT/);
  assert.match(markup, /FAILED/);
  assert.doesNotMatch(markup, /Workflow lifecycle and usage|provider costs|report.to.fill/i);
});

test('unavailable lineage does not invent a proposed-edge count or chain', () => {
  const markup = render(DecisionLineagePanel, {});
  assert.match(markup, /UNAVAILABLE/);
  assert.match(markup, /unknown proposed links not shown/);
  assert.doesNotMatch(markup, /0 proposed links not shown/);
});
